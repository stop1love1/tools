"use client";

import type { ConnectionStatus, RoomStats } from "@/shared/live-events";
import type { GameRules } from "@/game/rules";

export type AdminCommand =
  | { t: "hello" }
  | { t: "join"; username: string }
  | { t: "leave" }
  | { t: "demo"; on: boolean }
  | { t: "rules"; rules: GameRules }
  | { t: "display"; legend: boolean; stats: boolean }
  | { t: "pl-add"; url: string; play: boolean }
  | { t: "pl-remove"; index: number }
  | { t: "pl-play"; index: number }
  | { t: "music-toggle" };

export type GameState = {
  t: "state";
  status: ConnectionStatus;
  stats: RoomStats;
  nowPlaying: string | null;
  musicPaused: boolean;
  demoRunning: boolean;
  rules: GameRules;
  legend: boolean;
  statsShown: boolean;
  playlist: { title: string; kind: "file" | "url"; thumb?: string }[];
  playingIndex: number;
  musicError: string | null;
};

export type BusMessage = AdminCommand | GameState;

const CHANNEL = "meme-dance-admin";

export function openBus(onMessage: (msg: BusMessage) => void): {
  send: (msg: BusMessage) => void;
  close: () => void;
} {
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (e) => onMessage(e.data as BusMessage);
  return {
    send: (msg) => channel.postMessage(msg),
    close: () => channel.close(),
  };
}
