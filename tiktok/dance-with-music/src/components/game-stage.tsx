"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { MemeDanceGame } from "@/game/game";
import {
  buildLegend,
  DEFAULT_RULES,
  loadRules,
  saveRules,
  GIFT_ACTION_META,
  TIKTOK_GIFTS,
  type CameraMode,
  type GameRules,
  type GiftAction,
  type GiftActionRule,
  type ZoneMode,
} from "@/game/rules";
import { useLiveGame } from "@/hooks/use-live-game";
import { openBus, type AdminCommand } from "@/lib/admin-bus";
import type { ConnectionStatus } from "@/shared/live-events";

function statusText(status: ConnectionStatus): {
  text: string;
  tone: "muted" | "ok" | "warn" | "err";
} {
  switch (status.state) {
    case "idle":
      return { text: "Chưa kết nối", tone: "muted" };
    case "connecting":
      return { text: `Đang kết nối @${status.username}…`, tone: "warn" };
    case "connected":
      return { text: `Đang LIVE cùng @${status.username}`, tone: "ok" };
    case "ended":
      return { text: `LIVE của @${status.username} đã kết thúc`, tone: "warn" };
    case "error":
      return { text: status.message, tone: "err" };
  }
}

const TONE_CLASS = {
  muted: "text-white/40",
  ok: "text-emerald-400",
  warn: "text-amber-300",
  err: "text-rose-400",
} as const;

const inputClass =
  "w-full rounded-lg border border-white/10 bg-black/50 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-cyan-300/60 disabled:opacity-50";

// Trạng thái khôi phục nhạc sau reload — biến module vì GameStage chỉ mount
// một lần mỗi trang và React Compiler không cho gán ref dùng chéo giữa effect
let resumeAtSeconds = 0;
let playItemLatest: (index: number) => void = () => {};
let addOrderedLatest: (nickname: string, query: string) => void = () => {};

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11px] font-bold uppercase tracking-[0.18em] text-white/50">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function GameStage({ preview = false }: { preview?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<MemeDanceGame | null>(null);
  const { status, stats, join, leave } = useLiveGame(gameRef);
  const [username, setUsername] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showLegend, setShowLegend] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [demoRunning, setDemoRunning] = useState(false);
  const [rules, setRules] = useState<GameRules>(DEFAULT_RULES);

  type PlaylistItem = {
    input: string;
    title: string;
    kind: "file" | "url";
    /** Nickname người order — bài do khán giả yêu cầu qua quà tặng. */
    orderedBy?: string;
  };
  const [playlist, setPlaylist] = useState<PlaylistItem[]>([]);
  const playlistRef = useRef<PlaylistItem[]>([]);
  playlistRef.current = playlist;
  const [playingIndex, setPlayingIndex] = useState(-1);
  const playingIndexRef = useRef(-1);
  const [nowPlaying, setNowPlaying] = useState<string | null>(null);
  const [musicPaused, setMusicPaused] = useState(false);
  const [musicUrl, setMusicUrl] = useState("");
  const [musicError, setMusicError] = useState<string | null>(null);

  const watching =
    status.state === "connecting" || status.state === "connected";
  const s = statusText(status);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const game = new MemeDanceGame(canvas);
    game.rules = loadRules();
    gameRef.current = game;

    const skinsReady = fetch("/api/characters")
      .then((r) => r.json())
      .then((data: { urls: string[] }) => game.useCustomSkins(data.urls))
      .catch(() => {});
    if (preview) skinsReady.finally(() => game.startShowcase());

    const observer = new ResizeObserver(() => game.resize());
    if (canvas.parentElement) observer.observe(canvas.parentElement);

    return () => {
      observer.disconnect();
      game.dispose();
      gameRef.current = null;
    };
  }, []);

  useEffect(() => {
    setShowLegend(localStorage.getItem("md:legend") === "1");
    setShowStats(localStorage.getItem("md:stats") === "1");
    const loaded = loadRules();
    setRules(loaded);
    if (gameRef.current) gameRef.current.rules = loaded;
    const loadPlaylist = async () => {
      let files: PlaylistItem[] = [];
      try {
        const r = await fetch("/api/music");
        const data = (await r.json()) as {
          tracks: { url: string; title: string }[];
        };
        files = data.tracks.map((t) => ({
          input: t.url,
          title: t.title,
          kind: "file" as const,
        }));
      } catch {
        // API lỗi vẫn phải hiện các URL đã lưu
      }
      let saved: PlaylistItem[] = [];
      try {
        saved = (JSON.parse(localStorage.getItem("md:playlist") ?? "[]") as
          PlaylistItem[]).filter((i) => i.kind === "url");
      } catch {
      }
      const list = [...files, ...saved];
      setPlaylist(list);
      playlistRef.current = list;
      // Tự phát lại bài đang nghe dở trước khi reload (đúng vị trí đang nghe)
      try {
        const m = JSON.parse(
          localStorage.getItem("md:music") ?? "null",
        ) as { input: string; time: number; paused?: boolean } | null;
        if (m?.input && !m.paused) {
          const idx = list.findIndex((i) => i.input === m.input);
          if (idx >= 0) {
            resumeAtSeconds = m.time || 0;
            playItemLatest(idx);
          }
        }
      } catch {
      }
    };
    loadPlaylist();
  }, []);

  const persistPlaylist = (list: PlaylistItem[]) => {
    // Bài order của khán giả là tạm thời — không lưu vào playlist cố định
    localStorage.setItem(
      "md:playlist",
      JSON.stringify(list.filter((i) => i.kind === "url" && !i.orderedBy)),
    );
  };

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== "md:rules") return;
      const loaded = loadRules();
      setRules(loaded);
      if (gameRef.current) gameRef.current.rules = loaded;
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (e.key === "s" || e.key === "S") setShowSettings((v) => !v);
      if (e.key === "Escape") setShowSettings(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleLegend = (value: boolean) => {
    setShowLegend(value);
    localStorage.setItem("md:legend", value ? "1" : "0");
  };

  const toggleStats = (value: boolean) => {
    setShowStats(value);
    localStorage.setItem("md:stats", value ? "1" : "0");
  };

  const updateRules = (patch: Partial<GameRules>) => {
    const next = { ...rules, ...patch };
    setRules(next);
    saveRules(next);
    if (gameRef.current) gameRef.current.rules = next;
  };

  const updateGiftAction = (index: number, patch: Partial<GiftActionRule>) => {
    updateRules({
      giftActions: rules.giftActions.map((r, i) =>
        i === index ? { ...r, ...patch } : r,
      ),
    });
  };
  const addGiftAction = () =>
    updateRules({
      giftActions: [...rules.giftActions, { min: 1, action: "jump" }],
    });
  const removeGiftAction = (index: number) =>
    updateRules({
      giftActions: rules.giftActions.filter((_, i) => i !== index),
    });

  const syncUrl = (user: string | null) => {
    const url = user
      ? `${window.location.pathname}?user=${encodeURIComponent(user)}`
      : window.location.pathname;
    window.history.replaceState(null, "", url);
  };

  useEffect(() => {
    if (preview) return;
    const user = new URLSearchParams(window.location.search).get("user");
    if (user) {
      setUsername(user);
      join(user);
    }
  }, [join, preview]);

  const handleConnect = (event: FormEvent) => {
    event.preventDefault();
    if (watching) {
      leave();
      syncUrl(null);
      return;
    }
    if (username.trim()) {
      gameRef.current?.stopDemo();
      setDemoRunning(false);
      join(username);
      syncUrl(username.trim().replace(/^@/, "").toLowerCase());
    }
  };

  const testUser = useRef({
    userId: "preview-tester",
    uniqueId: "preview_tester",
    nickname: "Tester 🧪",
    avatarUrl: null,
  });

  const fireTestGift = (rule: GiftActionRule) => {
    gameRef.current?.handleGift({
      id: `pv-g-${Date.now()}`,
      user: testUser.current,
      giftId: rule.gift ?? "custom",
      giftName: rule.gift?.split(" (")[0] ?? `Quà ${rule.min}💎`,
      giftImageUrl: null,
      diamondCount: rule.min,
      repeatCount: 1,
      streaking: false,
      totalDiamonds: rule.min,
      ts: Date.now(),
    });
  };

  const fireTestChat = (text: string) => {
    gameRef.current?.handleChat({
      id: `pv-c-${Date.now()}`,
      user: testUser.current,
      comment: text,
      ts: Date.now(),
    });
  };

  const fireTestLike = () => {
    gameRef.current?.handleLike({
      user: testUser.current,
      count: 10,
      ts: Date.now(),
    });
  };

  const toggleDemo = () => {
    const game = gameRef.current;
    if (!game) return;
    if (demoRunning) {
      game.reset();
      setDemoRunning(false);
    } else {
      game.startDemo();
      setDemoRunning(true);
    }
  };

  const pendingPlayRef = useRef<number | null>(null);
  const [needsGesture, setNeedsGesture] = useState(false);

  // Lưu định kỳ bài + vị trí đang nghe để reload trang không mất nhạc
  useEffect(() => {
    const timer = setInterval(() => {
      const game = gameRef.current;
      const idx = playingIndexRef.current;
      if (!game || idx < 0) return;
      const item = playlistRef.current[idx];
      if (!item) return;
      localStorage.setItem(
        "md:music",
        JSON.stringify({
          input: item.input,
          time: game.music.progress?.time ?? 0,
          paused: !game.music.playing,
        }),
      );
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const onPointer = () => {
      if (pendingPlayRef.current === null) return;
      const index = pendingPlayRef.current;
      pendingPlayRef.current = null;
      setNeedsGesture(false);
      playItemLatest(index);
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, []);

  const resolveMedia = async (
    input: string,
  ): Promise<{ media: string; title: string }> => {
    const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
    let media = input;
    let title =
      decodeURIComponent(input.split("/").pop() ?? "")
        .split("?")[0]
        .replace(/\.[a-z0-9]+$/i, "") || "Nhạc từ URL";
    const isDirectMedia = /\.(mp3|ogg|m4a|wav|mp4|webm)(\?|$)/i.test(input);
    if (/tiktok\.com/i.test(input)) {
      const r = await fetch(
        `${apiBase}/api/data/video/meta?url=${encodeURIComponent(input)}`,
      );
      const meta = await r.json();
      media = meta?.video?.playUrl || meta?.video?.downloadUrl;
      if (!r.ok || !media) {
        throw new Error(meta?.error ?? "không lấy được audio từ video");
      }
      title = meta?.music?.title || meta?.author?.nickname || "TikTok audio";
    } else if (!isDirectMedia) {
      // Không phải link → coi là tên bài, tìm trên YouTube qua yt-dlp
      const target = /^[a-z][a-z0-9+.-]*:/i.test(input)
        ? input
        : `ytsearch1:${input}`;
      const r = await fetch(
        `${apiBase}/api/data/audio/resolve?url=${encodeURIComponent(target)}`,
      );
      const resolved = await r.json();
      if (!r.ok || !resolved?.audioUrl) {
        throw new Error(resolved?.error ?? "không lấy được audio từ link");
      }
      media = resolved.audioUrl;
      title = resolved.title || title;
    }
    return { media: `/api/stream?url=${encodeURIComponent(media)}`, title };
  };

  const playItem = async (index: number) => {
    const game = gameRef.current;
    const item = playlistRef.current[index];
    if (!game || !item) return;
    playingIndexRef.current = index;
    setPlayingIndex(index);
    setMusicPaused(false);
    setMusicError(null);
    game.music.onEndedCb = () => {
      const list = playlistRef.current;
      if (list.length) playItemLatest((playingIndexRef.current + 1) % list.length);
    };
    try {
      if (item.kind === "file") {
        setNowPlaying(item.title);
        await game.playMusic(item.input, item.title, item.orderedBy ?? null);
      } else {
        setNowPlaying("Đang phân tích link…");
        const { media, title } = await resolveMedia(item.input);
        setNowPlaying(title);
        setPlaylist((prev) =>
          prev.map((p, i) => (i === index ? { ...p, title } : p)),
        );
        await game.playMusic(media, title, item.orderedBy ?? null);
      }
      if (resumeAtSeconds > 0) {
        game.music.seekTo(resumeAtSeconds);
        resumeAtSeconds = 0;
      }
    } catch (err) {
      setNowPlaying(null);
      const message = err instanceof Error ? err.message : "";
      if (
        (err instanceof DOMException && err.name === "NotAllowedError") ||
        /user didn't interact|not allowed/i.test(message)
      ) {
        pendingPlayRef.current = index;
        setNeedsGesture(true);
        setMusicError(
          "Trình duyệt chặn tự phát — bấm 1 lần vào màn hình game để bật nhạc",
        );
        return;
      }
      setMusicError(message || "Không phát được URL này");
    }
  };
  // Bài do khán giả order: chèn ngay sau bài đang phát để lên sóng kế tiếp
  const addOrderedSong = (nickname: string, query: string) => {
    const list = [...playlistRef.current];
    const at =
      playingIndexRef.current >= 0 ? playingIndexRef.current + 1 : list.length;
    list.splice(at, 0, {
      input: query,
      title: `🎧 ${query}`,
      kind: "url",
      orderedBy: nickname,
    });
    setPlaylist(list);
    playlistRef.current = list;
    // Không phát ngay — bài hiện tại chạy xong sẽ tự chuyển sang bài order
  };

  useEffect(() => {
    playItemLatest = playItem;
    addOrderedLatest = addOrderedSong;
  });

  // Lưu ngay trước khi trang đóng/reload để không mất vị trí đang nghe
  useEffect(() => {
    const save = () => {
      const game = gameRef.current;
      const idx = playingIndexRef.current;
      if (!game || idx < 0) return;
      const item = playlistRef.current[idx];
      if (!item) return;
      localStorage.setItem(
        "md:music",
        JSON.stringify({
          input: item.input,
          time: game.music.progress?.time ?? 0,
          paused: !game.music.playing,
        }),
      );
    };
    window.addEventListener("pagehide", save);
    return () => window.removeEventListener("pagehide", save);
  }, []);

  const addToPlaylist = (raw: string, playNow: boolean) => {
    const input = raw.trim();
    if (!input) return;
    const title =
      decodeURIComponent(input.split("/").pop() ?? "")
        .split("?")[0]
        .replace(/\.[a-z0-9]+$/i, "") || input.slice(0, 40);
    const next = [
      ...playlistRef.current,
      { input, title, kind: "url" as const },
    ];
    setPlaylist(next);
    playlistRef.current = next;
    persistPlaylist(next);
    if (playNow) playItem(next.length - 1);
  };

  const removeFromPlaylist = (index: number) => {
    const next = playlistRef.current.filter((_, i) => i !== index);
    setPlaylist(next);
    playlistRef.current = next;
    persistPlaylist(next);
    if (index < playingIndexRef.current) {
      playingIndexRef.current -= 1;
      setPlayingIndex(playingIndexRef.current);
    } else if (index === playingIndexRef.current) {
      playingIndexRef.current = -1;
      setPlayingIndex(-1);
    }
  };

  const toggleMusic = () => {
    const game = gameRef.current;
    if (!game) return;
    if (nowPlaying === null) {
      if (playlistRef.current.length) playItem(0);
      return;
    }
    game.music.toggle();
    setMusicPaused((p) => !p);
  };

  const screenControlRef = useRef<(a: "prev" | "toggle" | "next") => void>(
    () => {},
  );
  screenControlRef.current = (action) => {
    const game = gameRef.current;
    if (!game) return;
    if (action === "toggle") {
      toggleMusic();
    } else if (action === "prev") {
      if (nowPlaying !== null) {
        game.music.restart();
        setMusicPaused(false);
      }
    } else if (action === "next") {
      const list = playlistRef.current;
      if (list.length) {
        playItem((playingIndexRef.current + 1 + list.length) % list.length);
      }
    }
  };

  useEffect(() => {
    const game = gameRef.current;
    if (!game) return;
    game.onScreenControl = (a) => screenControlRef.current(a);
    game.onSongRequest = (nickname, query) => addOrderedLatest(nickname, query);
  }, []);

  const stateRef = useRef<Record<string, unknown>>({});
  stateRef.current = {
    status,
    stats,
    nowPlaying,
    musicPaused,
    demoRunning,
    rules,
    legend: showLegend,
    statsShown: showStats,
    playlist: playlist.map((p) => ({ title: p.title, kind: p.kind })),
    playingIndex,
    musicError,
  };

  const commandRef = useRef<(cmd: AdminCommand) => void>(() => {});
  commandRef.current = (cmd) => {
    const game = gameRef.current;
    switch (cmd.t) {
      case "join":
        if (cmd.username.trim()) {
          game?.stopDemo();
          setDemoRunning(false);
          setUsername(cmd.username);
          join(cmd.username);
          syncUrl(cmd.username.trim().replace(/^@/, "").toLowerCase());
        }
        break;
      case "leave":
        leave();
        syncUrl(null);
        break;
      case "demo":
        if (!game) break;
        if (cmd.on) {
          game.startDemo();
          setDemoRunning(true);
        } else {
          game.reset();
          setDemoRunning(false);
        }
        break;
      case "rules":
        setRules(cmd.rules);
        saveRules(cmd.rules);
        if (game) game.rules = cmd.rules;
        break;
      case "display":
        toggleLegend(cmd.legend);
        toggleStats(cmd.stats);
        break;
      case "pl-add":
        addToPlaylist(cmd.url, cmd.play);
        break;
      case "pl-remove":
        removeFromPlaylist(cmd.index);
        break;
      case "pl-play":
        playItem(cmd.index);
        break;
      case "music-toggle":
        toggleMusic();
        break;
      default:
        break;
    }
  };

  useEffect(() => {
    const bus = openBus((msg) => {
      if (msg.t === "state") return;
      commandRef.current(msg);
      setTimeout(() => {
        bus.send({ t: "state", ...stateRef.current } as never);
      }, 60);
    });
    const timer = setInterval(() => {
      bus.send({ t: "state", ...stateRef.current } as never);
    }, 800);
    return () => {
      clearInterval(timer);
      bus.close();
    };
  }, []);

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-[#05060a]">
      <div className="absolute inset-0">
        <canvas ref={canvasRef} className="block h-full w-full" />
      </div>

      {needsGesture && (
        <button
          type="button"
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-cyan-300/60 bg-black/80 px-6 py-3 text-sm font-semibold text-cyan-300 backdrop-blur animate-pulse"
        >
          🔊 Bấm vào màn hình để bật nhạc
        </button>
      )}

      {preview && (
        <div className="absolute left-3 top-3 rounded-full border border-amber-300/40 bg-black/60 px-4 py-1.5 text-xs font-semibold text-amber-300 backdrop-blur">
          🧪 PREVIEW — nhấn S mở Settings; phát nhạc để nhân vật nhảy theo beat
        </div>
      )}

      {preview && (
        <aside className="absolute bottom-3 left-3 flex max-w-[70vw] flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => fireTestChat(rules.startCommand)}
            className="rounded-full border border-cyan-300/40 bg-black/60 px-3 py-1 text-[11px] font-semibold text-cyan-300 backdrop-blur hover:border-cyan-300/80"
          >
            💬 “{rules.startCommand}” lên sàn
          </button>
          <button
            type="button"
            onClick={() => fireTestChat("hello anh em 👋")}
            className="rounded-full border border-white/15 bg-black/60 px-3 py-1 text-[11px] font-semibold text-white/80 backdrop-blur hover:text-white"
          >
            💬 comment
          </button>
          <button
            type="button"
            onClick={() => fireTestChat("nhảy")}
            className="rounded-full border border-white/15 bg-black/60 px-3 py-1 text-[11px] font-semibold text-white/80 backdrop-blur hover:text-white"
          >
            💬 nhảy
          </button>
          <button
            type="button"
            onClick={fireTestLike}
            className="rounded-full border border-rose-400/40 bg-black/60 px-3 py-1 text-[11px] font-semibold text-rose-300 backdrop-blur hover:border-rose-400/80"
          >
            ❤️ ×10
          </button>
          {rules.giftActions.map((rule, i) => (
            <button
              key={`${rule.min}-${i}`}
              type="button"
              onClick={() => fireTestGift(rule)}
              className="rounded-full border border-amber-300/40 bg-black/60 px-3 py-1 text-[11px] font-semibold text-amber-300 backdrop-blur hover:border-amber-300/80"
              title={GIFT_ACTION_META[rule.action].label}
            >
              {GIFT_ACTION_META[rule.action].emoji}{" "}
              {rule.gift ? rule.gift.split(" (")[0] : `${rule.min}💎`}
            </button>
          ))}
        </aside>
      )}

      {showStats && (
        <div className="absolute left-3 top-3 flex flex-col gap-1 font-mono text-[13px] text-white/80">
          <span>👀 {stats.viewerCount.toLocaleString("vi-VN")}</span>
          <span>❤️ {stats.totalLikes.toLocaleString("vi-VN")}</span>
          <span>💎 {stats.totalDiamonds.toLocaleString("vi-VN")}</span>
        </div>
      )}

      {showLegend && (
        <aside className="absolute bottom-3 right-3 flex flex-col items-end gap-1">
          {buildLegend(rules).map((item) => (
            <span
              key={item.label}
              className="flex items-center gap-1.5 rounded-full bg-black/60 py-0.5 pl-1 pr-2.5 text-[10px] font-bold uppercase tracking-wide text-white backdrop-blur"
            >
              {item.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={item.image}
                  alt=""
                  className="h-5 w-5 shrink-0 object-contain"
                />
              ) : (
                <span className="text-sm leading-none">{item.emoji}</span>
              )}
              {item.label}
            </span>
          ))}
        </aside>
      )}

      {showSettings && (
        <div className="absolute right-3 top-14 flex max-h-[calc(100dvh-5rem)] w-80 flex-col gap-5 overflow-y-auto rounded-xl border border-white/10 bg-black/80 p-4 backdrop-blur-md">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-[0.2em] text-white">
              Cài đặt
            </h2>
            <button
              type="button"
              onClick={() => setShowSettings(false)}
              className="text-white/50 hover:text-white"
            >
              ✕
            </button>
          </div>

          <Section title="Kết nối TikTok LIVE">
            <form onSubmit={handleConnect} className="flex flex-col gap-2">
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="@username đang LIVE"
                disabled={watching}
                spellCheck={false}
                autoComplete="off"
                className={inputClass}
              />
              <div className="flex gap-2">
                <button
                  type="submit"
                  className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                    watching
                      ? "border border-white/15 text-white/70 hover:border-rose-400/60 hover:text-rose-300"
                      : "bg-rose-500 text-white hover:bg-rose-400"
                  }`}
                >
                  {watching ? "Ngắt kết nối" : "Kết nối"}
                </button>
                {!watching && (
                  <button
                    type="button"
                    onClick={toggleDemo}
                    className={`flex-1 rounded-lg border px-3 py-2 text-sm font-semibold ${
                      demoRunning
                        ? "border-amber-300/60 text-amber-300"
                        : "border-cyan-300/40 text-cyan-300 hover:border-cyan-300/80"
                    }`}
                  >
                    {demoRunning ? "⏹ Dừng demo" : "🎬 Xem demo"}
                  </button>
                )}
              </div>
              <p className={`text-xs ${TONE_CLASS[s.tone]}`}>{s.text}</p>
            </form>
          </Section>

          <Section title="Nhạc (playlist)">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                addToPlaylist(musicUrl, playlist.length === 0);
                setMusicUrl("");
              }}
              className="flex flex-col gap-2"
            >
              <input
                value={musicUrl}
                onChange={(e) => setMusicUrl(e.target.value)}
                placeholder="URL: mp3 / video / YouTube / TikTok"
                spellCheck={false}
                autoComplete="off"
                className={inputClass}
              />
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  className="rounded-lg border border-cyan-300/40 px-3 py-2 text-sm font-semibold text-cyan-300 hover:border-cyan-300/80"
                >
                  ➕ Thêm
                </button>
                <button
                  type="button"
                  onClick={() => {
                    addToPlaylist(musicUrl, true);
                    setMusicUrl("");
                  }}
                  className="rounded-lg border border-cyan-300/40 px-3 py-2 text-sm font-semibold text-cyan-300 hover:border-cyan-300/80"
                >
                  ▶ Phát ngay
                </button>
                <button
                  type="button"
                  onClick={toggleMusic}
                  className="rounded-lg border border-white/15 px-3 py-2 text-sm text-white/85 hover:text-white"
                >
                  {musicPaused || nowPlaying === null ? "▶" : "⏸"}
                </button>
              </div>
              {nowPlaying && (
                <p className="truncate text-xs text-cyan-300">♪ {nowPlaying}</p>
              )}
              {musicError && (
                <p className="text-xs text-rose-400">{musicError}</p>
              )}
              {playlist.length > 0 && (
                <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
                  {playlist.map((item, i) => (
                    <li key={`${item.input}-${i}`} className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => playItem(i)}
                        className={`min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-xs hover:bg-white/10 ${
                          i === playingIndex ? "text-cyan-300" : "text-white/75"
                        }`}
                      >
                        {i === playingIndex ? "♪ " : `${i + 1}. `}
                        {item.title}
                        {item.kind === "file" ? " 📁" : ""}
                      </button>
                      <button
                        type="button"
                        onClick={() => removeFromPlaylist(i)}
                        className="px-1 text-xs text-white/40 hover:text-rose-400"
                        title="Xóa khỏi playlist"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </form>
          </Section>

          <Section title="Hiển thị">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-white/85">
              <input
                type="checkbox"
                checked={showLegend}
                onChange={(e) => toggleLegend(e.target.checked)}
                className="accent-rose-500"
              />
              Hiện bảng lệnh trên màn hình
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-white/85">
              <input
                type="checkbox"
                checked={showStats}
                onChange={(e) => toggleStats(e.target.checked)}
                className="accent-rose-500"
              />
              Hiện số liệu 👀❤️💎 trên màn hình
            </label>
          </Section>

          <Section title="Luật chơi (admin)">
            <label className="text-xs text-white/70">
              Camera
              <select
                value={rules.cameraMode}
                onChange={(e) =>
                  updateRules({ cameraMode: e.target.value as CameraMode })
                }
                className={inputClass}
              >
                <option value="sway">Đứng yên, lắc nhẹ</option>
                <option value="orbit">Xoay vòng quanh sàn</option>
              </select>
            </label>
            <label className="text-xs text-white/70">
              Bố trí khu vực
              <select
                value={rules.zoneMode}
                onChange={(e) =>
                  updateRules({ zoneMode: e.target.value as ZoneMode })
                }
                className={inputClass}
              >
                <option value="auto">Tự do — chat lệnh để lên sàn</option>
                <option value="all-floor">Tất cả lên sàn nhảy</option>
                <option value="all-audience">Tất cả ở khán đài</option>
              </select>
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-white/85">
              <input
                type="checkbox"
                checked={rules.requireStartCommand}
                disabled={rules.zoneMode !== "auto"}
                onChange={(e) =>
                  updateRules({ requireStartCommand: e.target.checked })
                }
                className="accent-rose-500"
              />
              Phải chat lệnh mới được lên sàn
            </label>
            {rules.requireStartCommand && (
              <label className="flex items-center gap-2 text-sm text-white/85">
                Lệnh lên sàn
                <input
                  value={rules.startCommand}
                  onChange={(e) =>
                    updateRules({ startCommand: e.target.value || "1" })
                  }
                  className={`${inputClass} w-20! text-center`}
                />
              </label>
            )}
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-white/70">
                Nhảy ban đầu (giây)
                <input
                  type="number"
                  min={5}
                  value={rules.danceStartSec}
                  onChange={(e) =>
                    updateRules({
                      danceStartSec: Math.max(5, +e.target.value || 30),
                    })
                  }
                  className={inputClass}
                />
              </label>
              <label className="text-xs text-white/70">
                Gia hạn / comment (giây)
                <input
                  type="number"
                  min={0}
                  value={rules.danceExtendSec}
                  onChange={(e) =>
                    updateRules({
                      danceExtendSec: Math.max(0, +e.target.value || 0),
                    })
                  }
                  className={inputClass}
                />
              </label>
              <label className="text-xs text-white/70">
                Trần tích lũy (giây)
                <input
                  type="number"
                  min={10}
                  value={rules.danceMaxSec}
                  onChange={(e) =>
                    updateRules({
                      danceMaxSec: Math.max(10, +e.target.value || 90),
                    })
                  }
                  className={inputClass}
                />
              </label>
              <label className="text-xs text-white/70">
                Lượt order DJ / bài
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={rules.djOrderPerSong}
                  onChange={(e) =>
                    updateRules({
                      djOrderPerSong: Math.min(
                        10,
                        Math.max(0, parseInt(e.target.value, 10) || 0),
                      ),
                    })
                  }
                  className={inputClass}
                />
              </label>
              <label className="text-xs text-white/70">
                Độ nhạy beat
                <input
                  type="number"
                  min={1.1}
                  max={2}
                  step={0.05}
                  value={rules.beatSensitivity}
                  onChange={(e) =>
                    updateRules({
                      beatSensitivity: Math.min(
                        2,
                        Math.max(1.1, parseFloat(e.target.value) || 1.35),
                      ),
                    })
                  }
                  className={inputClass}
                />
              </label>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-white/85">
              <input
                type="checkbox"
                checked={rules.stayOnFloor}
                onChange={(e) => updateRules({ stayOnFloor: e.target.checked })}
                className="accent-rose-500"
              />
              Đã lên sàn thì ở lại luôn
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-white/85">
              <input
                type="checkbox"
                checked={rules.commandsEnabled}
                onChange={(e) =>
                  updateRules({ commandsEnabled: e.target.checked })
                }
                className="accent-rose-500"
              />
              Cho phép lệnh chat (nhảy, đổi nv…)
            </label>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-white/40">
              Quà → hành động (tự soạn)
            </p>
            <div className="flex flex-col gap-2">
              {rules.giftActions.map((rule, i) => (
                <div key={i} className="flex flex-wrap items-center gap-1.5">
                  <select
                    value={rule.gift ?? "__custom"}
                    onChange={(e) => {
                      const gift = TIKTOK_GIFTS.find(
                        (g) => g.name === e.target.value,
                      );
                      updateGiftAction(
                        i,
                        gift
                          ? { gift: gift.name, min: gift.diamonds }
                          : { gift: undefined },
                      );
                    }}
                    className={`${inputClass} min-w-0 flex-1`}
                  >
                    <option value="__custom">✏️ Tùy chỉnh 💎…</option>
                    {TIKTOK_GIFTS.map((g) => (
                      <option key={g.name} value={g.name}>
                        {g.emoji} {g.name} — {g.diamonds}💎
                      </option>
                    ))}
                  </select>
                  {!rule.gift && (
                    <input
                      type="number"
                      min={1}
                      value={rule.min}
                      onChange={(e) =>
                        updateGiftAction(i, {
                          min: Math.max(1, parseInt(e.target.value, 10) || 1),
                        })
                      }
                      className={`${inputClass} w-20!`}
                    />
                  )}
                  <select
                    value={rule.action}
                    onChange={(e) =>
                      updateGiftAction(i, {
                        action: e.target.value as GiftAction,
                      })
                    }
                    className={`${inputClass} min-w-0 flex-1`}
                  >
                    {Object.entries(GIFT_ACTION_META).map(([key, meta]) => (
                      <option key={key} value={key}>
                        {meta.emoji} {meta.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => removeGiftAction(i)}
                    className="px-1 text-sm text-white/40 hover:text-rose-400"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={addGiftAction}
                className="self-start rounded-lg border border-cyan-300/40 px-3 py-1.5 text-xs font-semibold text-cyan-300 hover:border-cyan-300/80"
              >
                ➕ Thêm dòng
              </button>
            </div>
            <button
              type="button"
              onClick={() => {
                setRules(DEFAULT_RULES);
                saveRules(DEFAULT_RULES);
                if (gameRef.current) gameRef.current.rules = DEFAULT_RULES;
              }}
              className="self-start rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/70 hover:text-white"
            >
              ↺ Khôi phục mặc định
            </button>
          </Section>

          <Section title="Xem trước bảng lệnh (chỉ hiện quà donate)">
            <ul className="flex flex-col gap-1">
              {buildLegend(rules).map((item) => (
                <li
                  key={item.label}
                  className="flex items-center gap-1.5 text-xs text-white/75"
                >
                  {item.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.image}
                      alt=""
                      className="h-4 w-4 shrink-0 object-contain"
                    />
                  ) : (
                    <span>{item.emoji}</span>
                  )}
                  {item.label}
                </li>
              ))}
            </ul>
          </Section>
        </div>
      )}
    </main>
  );
}
