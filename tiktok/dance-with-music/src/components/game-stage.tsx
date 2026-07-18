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
  type BannerStyle,
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
  "w-full rounded-lg border border-white/10 bg-white/[0.05] px-3 py-2 text-sm text-white outline-none transition-colors placeholder:text-white/30 hover:border-white/25 focus:border-cyan-300/70 focus:bg-black/40 disabled:opacity-50";

// Trạng thái khôi phục nhạc sau reload — biến module vì GameStage chỉ mount
// một lần mỗi trang và React Compiler không cho gán ref dùng chéo giữa effect
let resumeAtSeconds = 0;
let playItemLatest: (index: number) => void = () => {};
let addOrderedLatest: (nickname: string, query: string) => void = () => {};

// Suy thumbnail YouTube ngay từ URL/ID để hiện ảnh mà không cần chờ resolve
function youtubeThumb(input: string): string | undefined {
  const m =
    input.match(
      /(?:youtube\.com\/(?:watch\?[^#\s]*v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/i,
    ) ?? input.trim().match(/^([\w-]{11})$/);
  return m ? `https://i.ytimg.com/vi/${m[1]}/mqdefault.jpg` : undefined;
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5 rounded-xl border border-white/10 bg-white/5 p-3.5">
      <h3 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-white/60">
        {icon && (
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-white/10 text-sm leading-none">
            {icon}
          </span>
        )}
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
    /** Ảnh thumbnail của bài (YouTube/TikTok) — suy từ URL hoặc do resolver trả về. */
    thumb?: string;
    /** Nickname người order — bài do khán giả yêu cầu qua quà tặng. */
    orderedBy?: string;
    /** Link audio đã phân giải (cache trong phiên) — bấm phát là chạy ngay. */
    media?: string;
  };
  const [showChatTest, setShowChatTest] = useState(false);
  const [chatTest, setChatTest] = useState("");
  const [settingsTab, setSettingsTab] = useState<
    "connect" | "music" | "rules" | "display"
  >("connect");
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
          PlaylistItem[])
          .filter((i) => i.kind === "url")
          .map((i) => ({ ...i, thumb: i.thumb ?? youtubeThumb(i.input) }));
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
    // Bài order của khán giả là tạm thời — không lưu vào playlist cố định.
    // Bỏ link media đã phân giải vì nó hết hạn sau vài giờ.
    localStorage.setItem(
      "md:playlist",
      JSON.stringify(
        list
          .filter((i) => i.kind === "url" && !i.orderedBy)
          .map(({ media: _media, ...rest }) => rest),
      ),
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
    // Đồng bộ sang trang admin + các tab khác (preview đổi → admin thấy ngay)
    broadcast({ t: "rules", rules: next });
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

  // Phát lệnh lên bus để các tab game khác (và trang admin) đồng bộ theo.
  // BroadcastChannel không dội về tab gửi, tab nhận chỉ thực thi không phát
  // tiếp — nên không tạo vòng lặp.
  const busSendRef = useRef<(cmd: AdminCommand) => void>(() => {});
  const broadcast = (cmd: AdminCommand) => busSendRef.current(cmd);

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
      broadcast({ t: "leave" });
      return;
    }
    if (username.trim()) {
      gameRef.current?.stopDemo();
      setDemoRunning(false);
      join(username);
      syncUrl(username.trim().replace(/^@/, "").toLowerCase());
      broadcast({ t: "join", username });
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
    const trimmed = text.trim();
    if (!trimmed) return;
    gameRef.current?.handleChat({
      id: `pv-c-${Date.now()}`,
      user: testUser.current,
      comment: trimmed,
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
  ): Promise<{ media: string; title: string; thumb?: string }> => {
    // Gọi same-origin — Next.js proxy /api/data/* sang Go gateway (tự dò port),
    // tránh CORS và không phụ thuộc gateway nằm ở port nào
    const apiBase = "";
    let media = input;
    let thumb: string | undefined;
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
      thumb = meta?.video?.cover || undefined;
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
      thumb = resolved.thumbnail || undefined;
    }
    return { media: `/api/stream?url=${encodeURIComponent(media)}`, title, thumb };
  };

  /** Cập nhật một bài trong playlist (cả state lẫn ref, đồng bộ ngay). */
  const patchItem = (index: number, patch: Partial<PlaylistItem>) => {
    const list = playlistRef.current.map((p, i) =>
      i === index ? { ...p, ...patch } : p,
    );
    playlistRef.current = list;
    setPlaylist(list);
  };

  /** Phân giải link nếu chưa có cache — trả về link audio phát được ngay. */
  const ensureResolved = async (
    index: number,
  ): Promise<{ media: string; title: string }> => {
    const item = playlistRef.current[index];
    if (item.kind === "file") return { media: item.input, title: item.title };
    if (item.media) return { media: item.media, title: item.title };
    const { media, title, thumb } = await resolveMedia(item.input);
    patchItem(index, { media, title, thumb: thumb ?? item.thumb });
    return { media, title };
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
      const cached = item.kind === "url" && !!item.media;
      if (!cached && item.kind === "url") {
        setNowPlaying("Đang phân tích link…");
      }
      const { media, title } = await ensureResolved(index);
      setNowPlaying(title);
      try {
        await game.playMusic(media, title, item.orderedBy ?? null);
      } catch (err) {
        // Link cache hết hạn → phân giải lại một lần rồi phát lại
        const blocked = err instanceof DOMException && err.name === "NotAllowedError";
        if (!cached || blocked) throw err;
        patchItem(index, { media: undefined });
        setNowPlaying("Đang phân tích link…");
        const fresh = await ensureResolved(index);
        setNowPlaying(fresh.title);
        await game.playMusic(fresh.media, fresh.title, item.orderedBy ?? null);
      }
      if (resumeAtSeconds > 0) {
        game.music.seekTo(resumeAtSeconds);
        resumeAtSeconds = 0;
      }
      // Nạp sẵn link bài kế tiếp — bấm next/hết bài là chạy tức thì
      const nextIdx = (index + 1) % playlistRef.current.length;
      if (nextIdx !== index) {
        const next = playlistRef.current[nextIdx];
        if (next?.kind === "url" && !next.media) {
          ensureResolved(nextIdx).catch(() => {});
        }
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
      thumb: youtubeThumb(query),
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
      { input, title, kind: "url" as const, thumb: youtubeThumb(input) },
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
      broadcast({ t: "music-toggle" });
    } else if (action === "prev") {
      if (nowPlaying !== null) {
        game.music.restart();
        setMusicPaused(false);
      }
    } else if (action === "next") {
      const list = playlistRef.current;
      if (list.length) {
        const idx = (playingIndexRef.current + 1 + list.length) % list.length;
        playItem(idx);
        broadcast({ t: "pl-play", index: idx });
      }
    }
  };

  useEffect(() => {
    const game = gameRef.current;
    if (!game) return;
    game.onScreenControl = (a) => screenControlRef.current(a);
    game.onSongRequest = (nickname, query) => addOrderedLatest(nickname, query);
  }, []);

  // Đồng bộ 2 màn hình FOH trong game: trái "đang phát", phải "playlist"
  useEffect(() => {
    const game = gameRef.current;
    if (!game) return;
    game.setPlaylistScreen(
      playlist.map((p) => ({ title: p.title, thumb: p.thumb })),
      playingIndex,
    );
    const cur = playingIndex >= 0 ? playlist[playingIndex] : undefined;
    game.setNowPlayingScreen(nowPlaying ?? cur?.title ?? "", cur?.thumb);
  }, [playlist, playingIndex, nowPlaying]);

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
    playlist: playlist.map((p) => ({
      title: p.title,
      kind: p.kind,
      thumb: p.thumb,
    })),
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
    busSendRef.current = (cmd) => bus.send(cmd);
    const timer = setInterval(() => {
      bus.send({ t: "state", ...stateRef.current } as never);
    }, 800);
    return () => {
      clearInterval(timer);
      bus.close();
    };
  }, []);

  return (
    <main className="relative h-dvh w-full touch-manipulation overflow-hidden bg-[#05060a]">
      <div className="absolute inset-0">
        <canvas ref={canvasRef} className="block h-full w-full" />
      </div>

      {/* Nút mở cài đặt — cho mobile (không có phím S). CHỈ ở trang preview;
          trang chủ là overlay đưa lên stream nên không được lộ nút */}
      {preview && !showSettings && (
        <button
          type="button"
          onClick={() => setShowSettings(true)}
          title="Cài đặt (S)"
          aria-label="Mở cài đặt"
          className="absolute right-3 top-[max(0.75rem,env(safe-area-inset-top))] z-20 flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-black/55 text-lg text-white/80 backdrop-blur transition-colors hover:border-white/35 hover:text-white active:scale-95"
        >
          ⚙️
        </button>
      )}

      {needsGesture && (
        <button
          type="button"
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-cyan-300/60 bg-black/80 px-6 py-3 text-sm font-semibold text-cyan-300 backdrop-blur animate-pulse"
        >
          🔊 Bấm vào màn hình để bật nhạc
        </button>
      )}


      {preview && showChatTest && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            fireTestChat(chatTest);
            setChatTest("");
          }}
          className="absolute bottom-[calc(4.5rem+env(safe-area-inset-bottom))] left-3 z-20 flex w-96 max-w-[calc(100vw-1.5rem)] gap-2"
        >
          <input
            value={chatTest}
            onChange={(e) => setChatTest(e.target.value)}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            placeholder={`Comment thử — "${rules.startCommand}" lên sàn, "nhảy", "đổi nv"…`}
            className="min-w-0 flex-1 rounded-full border border-cyan-300/40 bg-black/75 px-4 py-2.5 text-sm text-white outline-none backdrop-blur placeholder:text-white/35 focus:border-cyan-300/80"
          />
          <button
            type="submit"
            className="shrink-0 rounded-full border border-cyan-300/40 bg-black/75 px-4 py-2.5 text-sm font-semibold text-cyan-300 backdrop-blur transition-colors hover:border-cyan-300/80 hover:bg-cyan-300/10 active:scale-95"
          >
            Gửi
          </button>
        </form>
      )}

      {preview && (
        <aside className="absolute bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-3 flex max-w-[80vw] flex-wrap items-end gap-2 max-sm:right-3 max-sm:max-w-none max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:pb-1 max-sm:[scrollbar-width:none]">
          {/* Nút mở ô nhập comment thử — test lệnh lên sàn / tương tác chat */}
          <button
            type="button"
            onClick={() => setShowChatTest((v) => !v)}
            title="Nhập comment thử"
            className={`relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full border bg-black/60 text-xl backdrop-blur transition-transform active:scale-90 ${
              showChatTest
                ? "border-cyan-300/90 text-cyan-300"
                : "border-cyan-300/40 hover:border-cyan-300/80"
            }`}
          >
            💬
          </button>
          {/* Dàn icon quà theo đúng cấu hình settings — bấm để test donate */}
          {rules.giftActions.map((rule, i) => {
            const gift = TIKTOK_GIFTS.find((g) => g.name === rule.gift);
            const meta = GIFT_ACTION_META[rule.action];
            return (
              <button
                key={`${rule.min}-${i}`}
                type="button"
                onClick={() => fireTestGift(rule)}
                title={`${rule.gift ?? `${rule.min}💎`} → ${meta.label}`}
                className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-amber-300/40 bg-black/60 backdrop-blur transition-transform hover:border-amber-300/80 active:scale-90"
              >
                {gift?.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={gift.image}
                    alt={gift.name}
                    className="h-8 w-8 object-contain"
                  />
                ) : (
                  <span className="text-2xl leading-none">
                    {gift?.emoji ?? meta.emoji}
                  </span>
                )}
                <span className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/85 px-1.5 text-[9px] font-bold text-amber-300">
                  {rule.min}💎
                </span>
              </button>
            );
          })}
        </aside>
      )}

      {showStats && (
        <div className="absolute left-3 top-3 flex flex-col gap-1 font-mono text-[16px] font-semibold text-white/90 [text-shadow:0_1px_3px_rgba(0,0,0,0.95)] portrait:left-4 portrait:top-4 portrait:gap-1.5 portrait:text-[22px]">
          <span>👀 {stats.viewerCount.toLocaleString("vi-VN")}</span>
          <span>❤️ {stats.totalLikes.toLocaleString("vi-VN")}</span>
          <span>💎 {stats.totalDiamonds.toLocaleString("vi-VN")}</span>
        </div>
      )}

      {showLegend && (
        <aside className="absolute bottom-3 right-3 flex flex-col items-end gap-1 max-sm:bottom-[calc(3.5rem+env(safe-area-inset-bottom))]">
          {buildLegend(rules).map((item) => (
            <span
              key={item.label}
              className="flex items-center gap-1.5 rounded-full bg-black/60 py-1 pl-1.5 pr-3 text-[12px] font-bold uppercase tracking-wide text-white backdrop-blur portrait:gap-2 portrait:py-1.5 portrait:pl-2 portrait:pr-3.5 portrait:text-[15px]"
            >
              {item.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={item.image}
                  alt=""
                  className="h-6 w-6 shrink-0 object-contain portrait:h-8 portrait:w-8"
                />
              ) : (
                <span className="text-base leading-none portrait:text-xl">
                  {item.emoji}
                </span>
              )}
              {item.label}
            </span>
          ))}
        </aside>
      )}

      {showSettings && (
        <div className="absolute bottom-3 right-3 top-3 flex w-[26rem] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0b0d17]/90 shadow-[0_24px_80px_rgba(0,0,0,0.65)] backdrop-blur-xl max-sm:inset-x-0 max-sm:bottom-0 max-sm:top-[10dvh] max-sm:w-auto max-sm:max-w-none max-sm:rounded-b-none max-sm:border-x-0 max-sm:border-b-0">
          {/* Thanh kéo kiểu bottom-sheet cho mobile */}
          <div className="hidden justify-center pt-2 max-sm:flex">
            <span className="h-1 w-10 rounded-full bg-white/20" />
          </div>
          <div className="relative flex items-center justify-between px-5 py-4 max-sm:py-3">
            <div className="flex flex-col">
              <h2 className="text-sm font-bold uppercase tracking-[0.22em] text-white">
                Cài đặt
              </h2>
              <p className="text-[11px] text-white/40">
                Điều khiển sân khấu, nhạc và luật chơi
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowSettings(false)}
              title="Đóng (Esc)"
              className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 text-white/50 transition-colors hover:border-white/30 hover:text-white active:scale-95"
            >
              ✕
            </button>
            <span className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-[#25f4ee]/70 to-[#fe2c55]/70" />
          </div>

          <div className="flex gap-1 px-3 pt-1">
            {(
              [
                ["connect", "📡", "Kết nối"],
                ["music", "🎵", "Nhạc"],
                ["rules", "🎛️", "Luật chơi"],
                ["display", "🖥️", "Hiển thị"],
              ] as const
            ).map(([key, icon, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setSettingsTab(key)}
                className={`flex flex-1 flex-col items-center gap-0.5 rounded-lg border px-1 py-1.5 text-[10px] font-semibold transition-colors ${
                  settingsTab === key
                    ? "border-cyan-300/60 bg-cyan-300/10 text-cyan-300"
                    : "border-white/10 text-white/50 hover:border-white/25 hover:text-white/80"
                }`}
              >
                <span className="text-base leading-none">{icon}</span>
                {label}
              </button>
            ))}
          </div>

          <div className="nice-scroll flex flex-1 flex-col gap-3 overflow-y-auto p-3 max-sm:pb-[max(1rem,env(safe-area-inset-bottom))]">

          {settingsTab === "connect" && (
          <Section title="Kết nối TikTok LIVE" icon="📡">
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
                  className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition-all ${
                    watching
                      ? "border border-white/15 text-white/70 hover:border-rose-400/60 hover:text-rose-300"
                      : "bg-gradient-to-r from-[#fe2c55] to-[#ff5f7a] text-white shadow-[0_4px_20px_rgba(254,44,85,0.35)] hover:shadow-[0_4px_28px_rgba(254,44,85,0.55)]"
                  }`}
                >
                  {watching ? "Ngắt kết nối" : "Kết nối"}
                </button>
                {!watching && (
                  <button
                    type="button"
                    onClick={() => {
                      const turningOn = !demoRunning;
                      toggleDemo();
                      broadcast({ t: "demo", on: turningOn });
                    }}
                    className={`flex-1 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${
                      demoRunning
                        ? "border-amber-300/60 bg-amber-300/10 text-amber-300"
                        : "border-cyan-300/40 text-cyan-300 hover:border-cyan-300/80 hover:bg-cyan-300/10"
                    }`}
                  >
                    {demoRunning ? "⏹ Dừng demo" : "🎬 Xem demo"}
                  </button>
                )}
              </div>
              <p className={`text-xs ${TONE_CLASS[s.tone]}`}>{s.text}</p>
            </form>
          </Section>
          )}

          {settingsTab === "music" && (
          <Section title="Nhạc (playlist)" icon="🎵">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const url = musicUrl.trim();
                if (!url) return;
                const playNow = playlist.length === 0;
                addToPlaylist(url, playNow);
                broadcast({ t: "pl-add", url, play: playNow });
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
                  className="flex-1 rounded-lg border border-cyan-300/40 px-3 py-2 text-sm font-semibold text-cyan-300 transition-colors hover:border-cyan-300/80 hover:bg-cyan-300/10"
                >
                  ➕ Thêm
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const url = musicUrl.trim();
                    if (!url) return;
                    addToPlaylist(url, true);
                    broadcast({ t: "pl-add", url, play: true });
                    setMusicUrl("");
                  }}
                  className="flex-1 rounded-lg border border-cyan-300/40 px-3 py-2 text-sm font-semibold text-cyan-300 transition-colors hover:border-cyan-300/80 hover:bg-cyan-300/10"
                >
                  ▶ Phát ngay
                </button>
                <button
                  type="button"
                  onClick={() => {
                    toggleMusic();
                    broadcast({ t: "music-toggle" });
                  }}
                  title={musicPaused || nowPlaying === null ? "Phát" : "Tạm dừng"}
                  className="w-11 rounded-lg border border-white/15 px-3 py-2 text-sm text-white/85 transition-colors hover:border-white/35 hover:text-white"
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
                <ul className="nice-scroll flex max-h-52 flex-col gap-1 overflow-y-auto pr-0.5">
                  {playlist.map((item, i) => (
                    <li key={`${item.input}-${i}`} className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          playItem(i);
                          broadcast({ t: "pl-play", index: i });
                        }}
                        className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                          i === playingIndex
                            ? "bg-cyan-300/10 text-cyan-300"
                            : "text-white/75 hover:bg-white/[0.07] hover:text-white"
                        }`}
                      >
                        {item.thumb ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={item.thumb}
                            alt=""
                            className="h-7 w-12 shrink-0 rounded-md object-cover"
                            onError={(e) => {
                              e.currentTarget.style.display = "none";
                            }}
                          />
                        ) : (
                          <span className="flex h-7 w-12 shrink-0 items-center justify-center rounded-md bg-white/5 text-white/40">
                            {item.kind === "file" ? "📁" : "♪"}
                          </span>
                        )}
                        <span className="min-w-0 flex-1 truncate">
                          {i === playingIndex ? "♪ " : `${i + 1}. `}
                          {item.title}
                        </span>
                        {item.orderedBy && (
                          <span className="shrink-0 rounded-full bg-amber-300/15 px-1.5 py-0.5 text-[10px] text-amber-300">
                            order
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          removeFromPlaylist(i);
                          broadcast({ t: "pl-remove", index: i });
                        }}
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs text-white/40 transition-colors hover:bg-rose-400/10 hover:text-rose-400"
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
          )}

          {settingsTab === "display" && (
          <>
          <Section title="Bảng tên sân khấu" icon="🪧">
            <label className="flex flex-col gap-1 text-xs font-medium text-white/60">
              Dòng chữ trên khung sân khấu (để trống = ẩn)
              <input
                value={rules.stageBannerText}
                onChange={(e) => updateRules({ stageBannerText: e.target.value })}
                placeholder="stop1love1 - Đỗ Long"
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-white/60">
              Phông nghệ thuật
              <select
                value={rules.stageBannerStyle}
                onChange={(e) =>
                  updateRules({ stageBannerStyle: e.target.value as BannerStyle })
                }
                className={inputClass}
              >
                <option value="script">Chữ viết tay (vàng ấm)</option>
                <option value="neon">Neon (xanh–trắng–hồng)</option>
                <option value="gold">Vàng kim khắc nổi</option>
                <option value="outline">Viền rỗng neon</option>
              </select>
            </label>
          </Section>
          <Section title="Hiển thị" icon="🖥️">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-white/85">
              <input
                type="checkbox"
                checked={showLegend}
                onChange={(e) => {
                  toggleLegend(e.target.checked);
                  broadcast({
                    t: "display",
                    legend: e.target.checked,
                    stats: showStats,
                  });
                }}
                className="h-4 w-4 accent-[#fe2c55]"
              />
              Hiện bảng lệnh trên màn hình
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-white/85">
              <input
                type="checkbox"
                checked={showStats}
                onChange={(e) => {
                  toggleStats(e.target.checked);
                  broadcast({
                    t: "display",
                    legend: showLegend,
                    stats: e.target.checked,
                  });
                }}
                className="h-4 w-4 accent-[#fe2c55]"
              />
              Hiện số liệu 👀❤️💎 trên màn hình
            </label>
          </Section>
          </>
          )}

          {settingsTab === "rules" && (
          <>
          <Section title="Luật chơi (admin)" icon="🎛️">
            <label className="flex flex-col gap-1 text-xs font-medium text-white/60">
              Camera
              <select
                value={rules.cameraMode}
                onChange={(e) =>
                  updateRules({ cameraMode: e.target.value as CameraMode })
                }
                className={inputClass}
              >
                <option value="sway">Điện ảnh</option>
                <option value="overview">Toàn cảnh</option>
                <option value="manual">Thủ công</option>
              </select>
            </label>
            {rules.cameraMode === "manual" && (
              <div className="flex items-start gap-2 rounded-lg border border-cyan-300/25 bg-cyan-300/5 px-3 py-2 text-[11px] leading-relaxed text-white/60">
                <span className="text-sm leading-none">🖱️</span>
                <span>
                  <b className="text-cyan-300/90">Kéo chuột</b> để xoay mọi hướng ·{" "}
                  <b className="text-cyan-300/90">lăn chuột</b> để phóng/thu ·{" "}
                  <b className="text-cyan-300/90">nháy đúp</b> để về khung mặc định
                </span>
              </div>
            )}
            <label className="flex flex-col gap-1 text-xs font-medium text-white/60">
              Bố trí khu vực
              <select
                value={rules.zoneMode}
                onChange={(e) =>
                  updateRules({ zoneMode: e.target.value as ZoneMode })
                }
                className={inputClass}
              >
                <option value="auto">Chat lệnh để lên sàn</option>
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
                className="h-4 w-4 accent-[#fe2c55]"
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
              <label className="flex flex-col gap-1 text-xs font-medium text-white/60">
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
              <label className="flex flex-col gap-1 text-xs font-medium text-white/60">
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
              <label className="flex flex-col gap-1 text-xs font-medium text-white/60">
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
              <label className="flex flex-col gap-1 text-xs font-medium text-white/60">
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
              <label className="flex flex-col gap-1 text-xs font-medium text-white/60">
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
                className="h-4 w-4 accent-[#fe2c55]"
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
                className="h-4 w-4 accent-[#fe2c55]"
              />
              Cho phép lệnh chat (nhảy, đổi nv…)
            </label>
            <p className="mt-1 border-t border-white/[0.07] pt-3 text-[11px] font-semibold uppercase tracking-wider text-white/40">
              🎁 Quà → hành động (tự soạn)
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
                    className="flex h-6 w-6 items-center justify-center rounded-full text-sm text-white/40 transition-colors hover:bg-rose-400/10 hover:text-rose-400"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={addGiftAction}
                className="self-start rounded-lg border border-cyan-300/40 px-3 py-1.5 text-xs font-semibold text-cyan-300 transition-colors hover:border-cyan-300/80 hover:bg-cyan-300/10"
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
                broadcast({ t: "rules", rules: DEFAULT_RULES });
              }}
              className="self-start rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/70 transition-colors hover:border-white/35 hover:text-white"
            >
              ↺ Khôi phục mặc định
            </button>
          </Section>

          <Section title="Bảng lệnh sẽ hiện trên màn hình" icon="🎁">
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
          </>
          )}
          </div>
        </div>
      )}
    </main>
  );
}
