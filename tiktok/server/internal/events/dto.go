// Package events defines the JSON payloads sent to game clients over WebSocket.
// Field names mirror src/shared/live-events.ts in the Node front-ends so games
// can switch transports without changing their handling code.
package events

type LiveUser struct {
	UserID    string  `json:"userId" bson:"userId"`
	UniqueID  string  `json:"uniqueId" bson:"uniqueId"`
	Nickname  string  `json:"nickname" bson:"nickname"`
	AvatarURL *string `json:"avatarUrl" bson:"avatarUrl,omitempty"`
}

type Chat struct {
	ID      string   `json:"id"`
	User    LiveUser `json:"user"`
	Comment string   `json:"comment"`
	Ts      int64    `json:"ts"`
}

type Gift struct {
	ID            string   `json:"id"`
	User          LiveUser `json:"user"`
	GiftID        string   `json:"giftId"`
	GiftName      string   `json:"giftName"`
	GiftImageURL  *string  `json:"giftImageUrl"`
	DiamondCount  int      `json:"diamondCount"`
	RepeatCount   int      `json:"repeatCount"`
	Streaking     bool     `json:"streaking"`
	TotalDiamonds int      `json:"totalDiamonds"`
	Ts            int64    `json:"ts"`
}

type Like struct {
	User  LiveUser `json:"user"`
	Count int      `json:"count"`
	Ts    int64    `json:"ts"`
}

type Activity struct {
	ID   string   `json:"id"`
	Kind string   `json:"kind"` // join | follow | share
	User LiveUser `json:"user"`
	Ts   int64    `json:"ts"`
}

type Stats struct {
	ViewerCount   int `json:"viewerCount"`
	TotalLikes    int `json:"totalLikes"`
	TotalDiamonds int `json:"totalDiamonds"`
	JoinCount     int `json:"joinCount"`
}

type Status struct {
	State    string `json:"state"` // idle|connecting|connected|ended|error
	Username string `json:"username,omitempty"`
	RoomID   string `json:"roomId,omitempty"`
	Message  string `json:"message,omitempty"`
}

// Envelope is the wire format: {"type":"chat","data":{...}}
type Envelope struct {
	Type string `json:"type"`
	Data any    `json:"data"`
}
