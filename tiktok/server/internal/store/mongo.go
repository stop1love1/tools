package store

import (
	"context"
	"log"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"tiktok-live-server/internal/events"
)

const writeTimeout = 3 * time.Second

type Store struct {
	client *mongo.Client
	db     *mongo.Database
}

type Session struct {
	ID          bson.ObjectID `bson:"_id,omitempty" json:"id"`
	Username    string        `bson:"username" json:"username"`
	RoomID      string        `bson:"roomId" json:"roomId"`
	StartedAt   time.Time     `bson:"startedAt" json:"startedAt"`
	EndedAt     *time.Time    `bson:"endedAt,omitempty" json:"endedAt,omitempty"`
	TotalLikes  int           `bson:"totalLikes" json:"totalLikes"`
	TotalCoins  int           `bson:"totalCoins" json:"totalCoins"`
	JoinCount   int           `bson:"joinCount" json:"joinCount"`
	PeakViewers int           `bson:"peakViewers" json:"peakViewers"`
}

type GiftLog struct {
	Username string          `bson:"username" json:"username"`
	User     events.LiveUser `bson:"user" json:"user"`
	GiftName string          `bson:"giftName" json:"giftName"`
	Diamonds int             `bson:"diamonds" json:"diamonds"`
	Ts       time.Time       `bson:"ts" json:"ts"`
}

type ChatLog struct {
	Username string          `bson:"username" json:"username"`
	User     events.LiveUser `bson:"user" json:"user"`
	Comment  string          `bson:"comment" json:"comment"`
	Ts       time.Time       `bson:"ts" json:"ts"`
}

func Connect(uri, dbName string) *Store {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()

	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err == nil {
		err = client.Ping(ctx, nil)
	}
	if err != nil {
		log.Printf("[store] MongoDB không kết nối được (%v) — chạy không lưu trữ", err)
		return nil
	}
	log.Printf("[store] MongoDB đã kết nối: %s/%s", uri, dbName)
	return &Store{client: client, db: client.Database(dbName)}
}

func (s *Store) ctx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), writeTimeout)
}

func (s *Store) StartSession(username, roomID string) bson.ObjectID {
	if s == nil {
		return bson.NilObjectID
	}
	ctx, cancel := s.ctx()
	defer cancel()
	doc := Session{Username: username, RoomID: roomID, StartedAt: time.Now()}
	res, err := s.db.Collection("sessions").InsertOne(ctx, doc)
	if err != nil {
		log.Printf("[store] StartSession: %v", err)
		return bson.NilObjectID
	}
	id, _ := res.InsertedID.(bson.ObjectID)
	return id
}

func (s *Store) EndSession(id bson.ObjectID, totals events.Stats) {
	if s == nil || id.IsZero() {
		return
	}
	ctx, cancel := s.ctx()
	defer cancel()
	now := time.Now()
	_, err := s.db.Collection("sessions").UpdateByID(ctx, id, bson.M{"$set": bson.M{
		"endedAt":     now,
		"totalLikes":  totals.TotalLikes,
		"totalCoins":  totals.TotalDiamonds,
		"joinCount":   totals.JoinCount,
		"peakViewers": totals.ViewerCount,
	}})
	if err != nil {
		log.Printf("[store] EndSession: %v", err)
	}
}

func (s *Store) LogGift(username string, gift events.Gift) {
	if s == nil {
		return
	}
	ctx, cancel := s.ctx()
	defer cancel()
	_, err := s.db.Collection("gifts").InsertOne(ctx, GiftLog{
		Username: username,
		User:     gift.User,
		GiftName: gift.GiftName,
		Diamonds: gift.TotalDiamonds,
		Ts:       time.UnixMilli(gift.Ts),
	})
	if err != nil {
		log.Printf("[store] LogGift: %v", err)
	}
}

func (s *Store) LogChat(username string, chat events.Chat) {
	if s == nil {
		return
	}
	ctx, cancel := s.ctx()
	defer cancel()
	_, err := s.db.Collection("chats").InsertOne(ctx, ChatLog{
		Username: username,
		User:     chat.User,
		Comment:  chat.Comment,
		Ts:       time.UnixMilli(chat.Ts),
	})
	if err != nil {
		log.Printf("[store] LogChat: %v", err)
	}
}

func (s *Store) RecentSessions(username string, limit int64) ([]Session, error) {
	if s == nil {
		return []Session{}, nil
	}
	ctx, cancel := s.ctx()
	defer cancel()
	filter := bson.M{}
	if username != "" {
		filter["username"] = username
	}
	cur, err := s.db.Collection("sessions").Find(ctx, filter,
		options.Find().SetSort(bson.M{"startedAt": -1}).SetLimit(limit))
	if err != nil {
		return nil, err
	}
	out := []Session{}
	if err := cur.All(ctx, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *Store) RecentGifts(username string, limit int64) ([]GiftLog, error) {
	if s == nil {
		return []GiftLog{}, nil
	}
	ctx, cancel := s.ctx()
	defer cancel()
	filter := bson.M{}
	if username != "" {
		filter["username"] = username
	}
	cur, err := s.db.Collection("gifts").Find(ctx, filter,
		options.Find().SetSort(bson.M{"ts": -1}).SetLimit(limit))
	if err != nil {
		return nil, err
	}
	out := []GiftLog{}
	if err := cur.All(ctx, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *Store) Connected() bool { return s != nil }
