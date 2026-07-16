"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ConnectionStatus,
  LiveEnvelope,
  RoomStats,
} from "@/shared/live-events";
import type { MemeDanceGame } from "@/game/game";

// Go backend (tiktok/server) — override with NEXT_PUBLIC_LIVE_WS_URL
const WS_BASE = process.env.NEXT_PUBLIC_LIVE_WS_URL ?? "ws://localhost:8080/ws";

const EMPTY_STATS: RoomStats = {
  viewerCount: 0,
  totalLikes: 0,
  totalDiamonds: 0,
  joinCount: 0,
};

/**
 * Bridges the Go backend WebSocket into the three.js game instance.
 * The game ref may be set after mount — events before that are dropped.
 */
export function useLiveGame(gameRef: React.RefObject<MemeDanceGame | null>) {
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>({ state: "idle" });
  const [stats, setStats] = useState<RoomStats>(EMPTY_STATS);

  const disconnect = useCallback(() => {
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.close();
    }
  }, []);

  useEffect(() => disconnect, [disconnect]);

  const join = useCallback(
    (rawUsername: string) => {
      const username = rawUsername.trim().replace(/^@/, "").toLowerCase();
      if (!username) return;

      disconnect();
      gameRef.current?.reset();
      setStats(EMPTY_STATS);
      setStatus({ state: "connecting", username });

      const ws = new WebSocket(`${WS_BASE}?user=${encodeURIComponent(username)}`);
      wsRef.current = ws;

      ws.onmessage = (message) => {
        let envelope: LiveEnvelope;
        try {
          envelope = JSON.parse(message.data);
        } catch {
          return;
        }
        switch (envelope.type) {
          case "status":
            setStatus(envelope.data);
            break;
          case "stats":
            setStats(envelope.data);
            break;
          case "chat":
            gameRef.current?.handleChat(envelope.data);
            break;
          case "gift":
            gameRef.current?.handleGift(envelope.data);
            break;
          case "like":
            gameRef.current?.handleLike(envelope.data);
            break;
          case "activity":
            gameRef.current?.handleActivity(envelope.data);
            break;
          default:
            break;
        }
      };

      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        setStatus((prev) =>
          prev.state === "connecting" || prev.state === "connected"
            ? {
                state: "error",
                username,
                message:
                  "Mất kết nối backend — kiểm tra Go server (tiktok/server) đang chạy ở cổng 8080",
              }
            : prev,
        );
      };
    },
    [disconnect, gameRef],
  );

  const leave = useCallback(() => {
    disconnect();
    setStatus({ state: "idle" });
  }, [disconnect]);

  return { status, stats, join, leave };
}
