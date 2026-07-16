// Package hub manages TikTok LIVE rooms: one gotiktoklive connection per
// streamer, shared by every WebSocket client watching that streamer.
package hub

import (
	"encoding/json"
	"fmt"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	gotiktoklive "github.com/steampoweredtaco/gotiktoklive"
	"go.mongodb.org/mongo-driver/v2/bson"

	"tiktok-live-server/internal/events"
	"tiktok-live-server/internal/store"
)

const (
	statsFlushInterval = 300 * time.Millisecond
	writeWait          = 10 * time.Second
	pongWait           = 60 * time.Second
	pingPeriod         = 45 * time.Second
	sendBuffer         = 256

	// Chống rate limit signer (Euler Stream):
	// - giữ kết nối TikTok thêm một lúc sau khi client cuối rời (reload trang
	//   không tốn lượt ký mới)
	// - khi dính 429 thì khóa mọi lần thử lại một thời gian
	lingerDuration = 5 * time.Minute
	signCooldown   = 15 * time.Minute
)

// webcast control action signalling the stream has finished
const controlActionStreamEnded = 3

type Hub struct {
	mu            sync.Mutex
	rooms         map[string]*Room
	store         *store.Store
	signKey       string
	tiktok        *gotiktoklive.TikTok
	tiktokMu      sync.Mutex
	cooldownUntil time.Time
}

func New(st *store.Store, signKey string) *Hub {
	return &Hub{rooms: map[string]*Room{}, store: st, signKey: signKey}
}

func NormalizeUsername(input string) string {
	return strings.ToLower(strings.TrimPrefix(strings.TrimSpace(input), "@"))
}

// getTikTok lazily creates the shared gotiktoklive instance.
func (h *Hub) getTikTok() (*gotiktoklive.TikTok, error) {
	h.tiktokMu.Lock()
	defer h.tiktokMu.Unlock()
	if h.tiktok != nil {
		return h.tiktok, nil
	}
	opts := []gotiktoklive.TikTokLiveOption{
		gotiktoklive.DisableSigningLimitsValidation,
	}
	if h.signKey != "" {
		opts = append(opts, gotiktoklive.SigningApiKey(h.signKey))
	}
	t, err := gotiktoklive.NewTikTok(opts...)
	if err != nil {
		return nil, err
	}
	h.tiktok = t
	return t, nil
}

// Join attaches a WebSocket client to the room for username, creating the
// room (and the TikTok connection) if needed. Returns nil when the join was
// rejected (signer cooldown) — the status is written to conn before closing.
func (h *Hub) Join(username string, conn *websocket.Conn) *Client {
	username = NormalizeUsername(username)

	h.mu.Lock()
	room, ok := h.rooms[username]
	if !ok {
		// Đang trong thời gian khóa vì 429 → từ chối tạo kết nối mới,
		// tránh đốt thêm quota của signer
		if remain := time.Until(h.cooldownUntil); remain > 0 {
			h.mu.Unlock()
			payload, _ := json.Marshal(events.Envelope{
				Type: "status",
				Data: events.Status{
					State:    "error",
					Username: username,
					Message: fmt.Sprintf(
						"Signer đang bị giới hạn (429) — thử lại sau %d phút, hoặc đặt SIGN_API_KEY (miễn phí tại eulerstream.com) rồi khởi động lại server",
						int(remain.Minutes())+1,
					),
				},
			})
			conn.SetWriteDeadline(time.Now().Add(writeWait))
			conn.WriteMessage(websocket.TextMessage, payload)
			conn.Close()
			return nil
		}
		room = newRoom(h, username)
		h.rooms[username] = room
		go room.run()
	}
	h.mu.Unlock()

	client := newClient(conn, room)
	room.addClient(client)
	return client
}

// setSignCooldown chặn mọi kết nối mới trong một khoảng thời gian sau khi
// signer trả 429 (giới hạn tính theo tài khoản/IP, không theo streamer).
func (h *Hub) setSignCooldown(d time.Duration) {
	h.mu.Lock()
	h.cooldownUntil = time.Now().Add(d)
	h.mu.Unlock()
	log.Printf("[hub] signer rate-limited — khóa kết nối mới %s", d)
}

func (h *Hub) removeRoom(username string) {
	h.mu.Lock()
	delete(h.rooms, username)
	h.mu.Unlock()
}

type RoomSummary struct {
	Username string        `json:"username"`
	Status   events.Status `json:"status"`
	Stats    events.Stats  `json:"stats"`
	Clients  int           `json:"clients"`
}

func (h *Hub) Snapshot() []RoomSummary {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := []RoomSummary{}
	for _, r := range h.rooms {
		r.mu.Lock()
		out = append(out, RoomSummary{
			Username: r.username,
			Status:   r.status,
			Stats:    r.stats,
			Clients:  len(r.clients),
		})
		r.mu.Unlock()
	}
	return out
}

// --- Room -------------------------------------------------------------------

type Room struct {
	hub      *Hub
	username string

	mu         sync.Mutex
	clients    map[*Client]struct{}
	status     events.Status
	stats      events.Stats
	statsDirty bool
	peak       int
	removed    bool

	live      *gotiktoklive.Live
	sessionID bson.ObjectID
	done      chan struct{}
	closeOnce sync.Once
	linger    *time.Timer
}

func newRoom(h *Hub, username string) *Room {
	return &Room{
		hub:      h,
		username: username,
		clients:  map[*Client]struct{}{},
		status:   events.Status{State: "connecting", Username: username},
		done:     make(chan struct{}),
	}
}

func (r *Room) addClient(c *Client) {
	r.mu.Lock()
	r.clients[c] = struct{}{}
	// Có người xem lại → hủy hẹn giờ đóng kết nối
	if r.linger != nil {
		r.linger.Stop()
		r.linger = nil
	}
	status := r.status
	stats := r.stats
	r.mu.Unlock()

	c.sendEnvelope("status", status)
	c.sendEnvelope("stats", stats)
}

func (r *Room) removeClient(c *Client) {
	r.mu.Lock()
	delete(r.clients, c)
	empty := len(r.clients) == 0
	terminal := r.status.State == "ended" || r.status.State == "error"
	r.mu.Unlock()
	if !empty {
		return
	}
	if terminal {
		r.close()
		return
	}
	// Giữ kết nối TikTok thêm một lúc — reload trang không tốn lượt ký mới
	r.mu.Lock()
	if r.linger == nil {
		r.linger = time.AfterFunc(lingerDuration, func() {
			r.mu.Lock()
			stillEmpty := len(r.clients) == 0
			r.mu.Unlock()
			if stillEmpty {
				log.Printf("[hub] @%s: hết thời gian chờ, ngắt kết nối", r.username)
				r.close()
			}
		})
	}
	r.mu.Unlock()
}

// close tears down the TikTok connection and unregisters the room.
func (r *Room) close() {
	r.closeOnce.Do(func() {
		close(r.done)
		r.mu.Lock()
		r.removed = true
		live := r.live
		r.mu.Unlock()
		if live != nil {
			live.Close()
		}
		r.hub.removeRoom(r.username)
	})
}

func (r *Room) broadcast(eventType string, data any) {
	payload, err := json.Marshal(events.Envelope{Type: eventType, Data: data})
	if err != nil {
		return
	}
	r.mu.Lock()
	for c := range r.clients {
		c.sendRaw(payload)
	}
	r.mu.Unlock()
}

func (r *Room) setStatus(s events.Status) {
	r.mu.Lock()
	r.status = s
	r.mu.Unlock()
	r.broadcast("status", s)
}

func (r *Room) run() {
	tiktok, err := r.hub.getTikTok()
	if err != nil {
		r.fail(fmt.Sprintf("Không khởi tạo được TikTok client: %v", err))
		return
	}

	log.Printf("[hub] connecting to @%s", r.username)
	live, err := tiktok.TrackUser(r.username)
	if err != nil {
		r.fail(fmt.Sprintf("Không kết nối được @%s: %v", r.username, err))
		return
	}

	r.mu.Lock()
	r.live = live
	if live.Info != nil {
		r.stats.ViewerCount = live.Info.UserCount
		r.peak = live.Info.UserCount
	}
	r.mu.Unlock()

	r.setStatus(events.Status{State: "connected", Username: r.username, RoomID: live.ID})
	r.sessionID = r.hub.store.StartSession(r.username, live.ID)
	log.Printf("[hub] connected to @%s (room %s)", r.username, live.ID)

	ticker := time.NewTicker(statsFlushInterval)
	defer ticker.Stop()
	defer r.endSession()

	for {
		select {
		case <-r.done:
			return
		case <-ticker.C:
			r.flushStats()
		case ev, ok := <-live.Events:
			if !ok {
				r.finish("ended", "")
				return
			}
			if ev.IsHistory() {
				continue
			}
			if terminal := r.handleEvent(ev); terminal {
				return
			}
		}
	}
}

// handleEvent maps one gotiktoklive event to our DTOs. Returns true when the
// stream reached a terminal state.
func (r *Room) handleEvent(ev gotiktoklive.Event) bool {
	now := time.Now().UnixMilli()
	switch e := ev.(type) {

	case gotiktoklive.ChatEvent:
		chat := events.Chat{
			ID:      uuid.NewString(),
			User:    toLiveUser(e.User),
			Comment: e.Comment,
			Ts:      now,
		}
		r.broadcast("chat", chat)
		go r.hub.store.LogChat(r.username, chat)

	case gotiktoklive.GiftEvent:
		streakable := e.Type == 1 || e.IsComboGift
		streaking := streakable && !e.RepeatEnd
		repeat := e.RepeatCount
		if repeat < 1 {
			repeat = 1
		}
		gift := events.Gift{
			ID:            fmt.Sprintf("%d:%d:%d", userID(e.User), e.ID, e.GroupID),
			User:          toLiveUser(e.User),
			GiftID:        strconv.FormatInt(e.ID, 10),
			GiftName:      giftName(e),
			DiamondCount:  e.Diamonds,
			RepeatCount:   repeat,
			Streaking:     streaking,
			TotalDiamonds: e.Diamonds * repeat,
			Ts:            now,
		}
		r.broadcast("gift", gift)
		if !streaking {
			r.mu.Lock()
			r.stats.TotalDiamonds += gift.TotalDiamonds
			r.statsDirty = true
			r.mu.Unlock()
			go r.hub.store.LogGift(r.username, gift)
		}

	case gotiktoklive.LikeEvent:
		r.mu.Lock()
		if e.TotalLikes > 0 {
			r.stats.TotalLikes = e.TotalLikes
		} else {
			r.stats.TotalLikes += e.Likes
		}
		r.statsDirty = true
		r.mu.Unlock()
		r.broadcast("like", events.Like{User: toLiveUser(e.User), Count: max(e.Likes, 1), Ts: now})

	case gotiktoklive.ViewersEvent:
		r.mu.Lock()
		r.stats.ViewerCount = e.Viewers
		if e.Viewers > r.peak {
			r.peak = e.Viewers
		}
		r.statsDirty = true
		r.mu.Unlock()

	case gotiktoklive.UserEvent:
		kind := ""
		switch e.Event {
		case gotiktoklive.USER_JOIN:
			kind = "join"
		case gotiktoklive.USER_FOLLOW:
			kind = "follow"
		case gotiktoklive.USER_SHARE:
			kind = "share"
		}
		if kind == "" {
			break
		}
		if kind == "join" {
			r.mu.Lock()
			r.stats.JoinCount++
			r.statsDirty = true
			r.mu.Unlock()
		}
		r.broadcast("activity", events.Activity{
			ID:   uuid.NewString(),
			Kind: kind,
			User: toLiveUser(e.User),
			Ts:   now,
		})

	case gotiktoklive.ControlEvent:
		if e.Action == controlActionStreamEnded {
			r.finish("ended", "")
			return true
		}

	case gotiktoklive.DisconnectEvent:
		r.finish("error", "Mất kết nối tới TikTok LIVE")
		return true
	}
	return false
}

func (r *Room) flushStats() {
	r.mu.Lock()
	if !r.statsDirty {
		r.mu.Unlock()
		return
	}
	r.statsDirty = false
	stats := r.stats
	r.mu.Unlock()
	r.broadcast("stats", stats)
}

// fail reports a connection error and unregisters the room so that a new
// WebSocket connection retries from scratch.
func (r *Room) fail(message string) {
	log.Printf("[hub] @%s: %s", r.username, message)
	// Dính rate limit của signer → khóa kết nối mới, báo lỗi dễ hiểu
	lower := strings.ToLower(message)
	if strings.Contains(lower, "429") ||
		strings.Contains(lower, "rate limit") ||
		strings.Contains(lower, "hourly limit") {
		r.hub.setSignCooldown(signCooldown)
		message = fmt.Sprintf(
			"Signer Euler Stream chạm giới hạn miễn phí theo giờ (429). Server tạm khóa kết nối mới %d phút. Đăng ký API key miễn phí tại eulerstream.com rồi đặt SIGN_API_KEY để tăng hạn mức.",
			int(signCooldown.Minutes()),
		)
	}
	r.setStatus(events.Status{State: "error", Username: r.username, Message: message})
	r.hub.removeRoom(r.username)
}

func (r *Room) finish(state, message string) {
	r.flushStats()
	r.setStatus(events.Status{State: state, Username: r.username, Message: message})
	r.hub.removeRoom(r.username)
}

func (r *Room) endSession() {
	r.mu.Lock()
	totals := r.stats
	totals.ViewerCount = r.peak
	r.mu.Unlock()
	r.hub.store.EndSession(r.sessionID, totals)
}

func toLiveUser(u *gotiktoklive.User) events.LiveUser {
	if u == nil {
		return events.LiveUser{UniqueID: "unknown", Nickname: "Ẩn danh"}
	}
	var avatar *string
	if u.ProfilePicture != nil && len(u.ProfilePicture.Urls) > 0 {
		avatar = &u.ProfilePicture.Urls[0]
	}
	nickname := u.Nickname
	if nickname == "" {
		nickname = u.Username
	}
	return events.LiveUser{
		UserID:    strconv.FormatInt(u.ID, 10),
		UniqueID:  u.Username,
		Nickname:  nickname,
		AvatarURL: avatar,
	}
}

func userID(u *gotiktoklive.User) int64 {
	if u == nil {
		return 0
	}
	return u.ID
}

func giftName(e gotiktoklive.GiftEvent) string {
	if e.Name != "" {
		return e.Name
	}
	return fmt.Sprintf("Quà #%d", e.ID)
}

// --- Client ------------------------------------------------------------------

type Client struct {
	conn *websocket.Conn
	room *Room
	send chan []byte
	once sync.Once
}

func newClient(conn *websocket.Conn, room *Room) *Client {
	return &Client{conn: conn, room: room, send: make(chan []byte, sendBuffer)}
}

func (c *Client) sendEnvelope(eventType string, data any) {
	payload, err := json.Marshal(events.Envelope{Type: eventType, Data: data})
	if err != nil {
		return
	}
	c.sendRaw(payload)
}

// sendRaw drops the message if the client's buffer is full (slow consumer).
func (c *Client) sendRaw(payload []byte) {
	select {
	case c.send <- payload:
	default:
	}
}

func (c *Client) Run() {
	go c.writePump()
	c.readPump()
}

func (c *Client) close() {
	c.once.Do(func() {
		c.room.removeClient(c)
		close(c.send)
		c.conn.Close()
	})
}

func (c *Client) readPump() {
	defer c.close()
	c.conn.SetReadLimit(4096)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(pongWait))
	})
	for {
		if _, _, err := c.conn.ReadMessage(); err != nil {
			return
		}
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()
	for {
		select {
		case msg, ok := <-c.send:
			if !ok {
				c.conn.WriteControl(websocket.CloseMessage, nil, time.Now().Add(writeWait))
				return
			}
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
