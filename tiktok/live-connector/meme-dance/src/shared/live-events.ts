// DTO types matching the Go backend (tiktok/server) wire format.
// Every WebSocket message is an Envelope: {"type": "...", "data": {...}}

export type LiveUser = {
  userId: string;
  uniqueId: string;
  nickname: string;
  avatarUrl: string | null;
};

export type ChatEvent = {
  id: string;
  user: LiveUser;
  comment: string;
  ts: number;
};

export type GiftEvent = {
  /** Stable id per gift streak — one combo keeps one id. */
  id: string;
  user: LiveUser;
  giftId: string;
  giftName: string;
  giftImageUrl: string | null;
  diamondCount: number;
  repeatCount: number;
  /** True while a combo (giftType 1) is still in progress. */
  streaking: boolean;
  totalDiamonds: number;
  ts: number;
};

export type LikeEvent = {
  user: LiveUser;
  count: number;
  ts: number;
};

export type ActivityKind = "join" | "follow" | "share";

export type ActivityEvent = {
  id: string;
  kind: ActivityKind;
  user: LiveUser;
  ts: number;
};

export type RoomStats = {
  viewerCount: number;
  totalLikes: number;
  totalDiamonds: number;
  joinCount: number;
};

export type ConnectionStatus =
  | { state: "idle" }
  | { state: "connecting"; username: string }
  | { state: "connected"; username: string; roomId: string }
  | { state: "ended"; username: string }
  | { state: "error"; username: string; message: string };

export type LiveEnvelope =
  | { type: "status"; data: ConnectionStatus }
  | { type: "chat"; data: ChatEvent }
  | { type: "gift"; data: GiftEvent }
  | { type: "like"; data: LikeEvent }
  | { type: "activity"; data: ActivityEvent }
  | { type: "stats"; data: RoomStats };
