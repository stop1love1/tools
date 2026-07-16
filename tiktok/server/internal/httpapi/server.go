// Package httpapi exposes the WebSocket endpoint, the REST API and the
// reverse proxy to the Python data sidecar.
package httpapi

import (
	"encoding/json"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"

	"github.com/gorilla/websocket"

	"tiktok-live-server/internal/hub"
	"tiktok-live-server/internal/store"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 4096,
	// Local tool: front-ends run on other localhost ports (3000, 3100…)
	CheckOrigin: func(r *http.Request) bool { return true },
}

type Server struct {
	hub     *hub.Hub
	store   *store.Store
	sidecar *httputil.ReverseProxy
}

func New(h *hub.Hub, st *store.Store, sidecarURL string) *Server {
	target, err := url.Parse(sidecarURL)
	var proxy *httputil.ReverseProxy
	if err == nil {
		proxy = httputil.NewSingleHostReverseProxy(target)
		proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
			writeJSON(w, http.StatusBadGateway, map[string]string{
				"error": "Sidecar không phản hồi — hãy chạy sidecar Python (xem sidecar/README.md)",
			})
		}
	}
	return &Server{hub: h, store: st, sidecar: proxy}
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws", s.handleWS)
	mux.HandleFunc("GET /api/health", s.handleHealth)
	mux.HandleFunc("GET /api/rooms", s.handleRooms)
	mux.HandleFunc("GET /api/sessions", s.handleSessions)
	mux.HandleFunc("GET /api/gifts", s.handleGifts)
	mux.Handle("/api/data/", http.StripPrefix("/api/data", s.dataProxy()))
	return withCORS(mux)
}

// --- WebSocket ---------------------------------------------------------------

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	username := hub.NormalizeUsername(r.URL.Query().Get("user"))
	if username == "" {
		http.Error(w, `missing "user" query parameter`, http.StatusBadRequest)
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[ws] upgrade: %v", err)
		return
	}
	client := s.hub.Join(username, conn)
	if client == nil {
		return // bị từ chối do signer cooldown, status đã gửi trước khi đóng
	}
	client.Run()
}

// --- REST ---------------------------------------------------------------------

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":    true,
		"mongo": s.store.Connected(),
		"rooms": len(s.hub.Snapshot()),
	})
}

func (s *Server) handleRooms(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.hub.Snapshot())
}

func (s *Server) handleSessions(w http.ResponseWriter, r *http.Request) {
	sessions, err := s.store.RecentSessions(
		hub.NormalizeUsername(r.URL.Query().Get("username")),
		limitParam(r, 20),
	)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, sessions)
}

func (s *Server) handleGifts(w http.ResponseWriter, r *http.Request) {
	gifts, err := s.store.RecentGifts(
		hub.NormalizeUsername(r.URL.Query().Get("username")),
		limitParam(r, 50),
	)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, gifts)
}

// --- Sidecar proxy --------------------------------------------------------------

func (s *Server) dataProxy() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.sidecar == nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "sidecar chưa được cấu hình"})
			return
		}
		s.sidecar.ServeHTTP(w, r)
	})
}

// --- Helpers ---------------------------------------------------------------------

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func limitParam(r *http.Request, fallback int64) int64 {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return fallback
	}
	n, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || n < 1 || n > 500 {
		return fallback
	}
	return n
}
