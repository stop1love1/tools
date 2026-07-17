"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
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
import { openBus, type BusMessage, type GameState } from "@/lib/admin-bus";

const inputClass =
  "w-full rounded-lg border border-white/10 bg-black/50 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-cyan-300/60 disabled:opacity-50";

const GAME_URL = "http://localhost:3100";

function Card({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.18em] text-white/50">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function GiftIcon({ name, size = "h-5 w-5" }: { name?: string; size?: string }) {
  const gift = TIKTOK_GIFTS.find((g) => g.name === name);
  if (!gift) return <span className={`${size} text-center`}>💎</span>;
  return gift.image ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={gift.image} alt={gift.name} className={`${size} shrink-0 object-contain`} />
  ) : (
    <span className={`${size} text-center`}>{gift.emoji}</span>
  );
}

export default function AdminPage() {
  const busRef = useRef<ReturnType<typeof openBus> | null>(null);
  const [game, setGame] = useState<GameState | null>(null);
  const [lastSeen, setLastSeen] = useState(0);
  const [username, setUsername] = useState("");
  const [musicUrl, setMusicUrl] = useState("");
  const [rules, setRules] = useState<GameRules>(DEFAULT_RULES);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setRules(loadRules());
    setUsername(localStorage.getItem("md:admin-user") ?? "");
    const bus = openBus((msg: BusMessage) => {
      // Preview (hoặc tab khác) đổi luật chơi → cập nhật form admin ngay
      if (msg.t === "rules") {
        setRules(msg.rules);
        saveRules(msg.rules);
        return;
      }
      if (msg.t !== "state") return;
      setGame(msg);
      setLastSeen(Date.now());
    });
    busRef.current = bus;
    bus.send({ t: "hello" });
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(tick);
      bus.close();
    };
  }, []);

  const send = (msg: Parameters<NonNullable<typeof busRef.current>["send"]>[0]) =>
    busRef.current?.send(msg);

  const connected = game !== null && now - lastSeen < 3000;
  const watching =
    game?.status.state === "connecting" || game?.status.state === "connected";

  const status: { text: string; tone: string; dot: string } = (() => {
    if (!connected)
      return {
        text: "Chưa thấy trang game",
        tone: "text-amber-300",
        dot: "bg-amber-400",
      };
    const s = game!.status;
    switch (s.state) {
      case "idle":
        return {
          text: "Sẵn sàng — chưa kết nối TikTok",
          tone: "text-white/70",
          dot: "bg-white/40",
        };
      case "connecting":
        return {
          text: `Đang kết nối @${s.username}…`,
          tone: "text-amber-300",
          dot: "bg-amber-400 animate-pulse",
        };
      case "connected":
        return {
          text: `Đang LIVE cùng @${s.username}`,
          tone: "text-emerald-400",
          dot: "bg-emerald-400 animate-pulse",
        };
      case "ended":
        return {
          text: `LIVE của @${s.username} đã kết thúc`,
          tone: "text-white/60",
          dot: "bg-white/40",
        };
      case "error":
        return {
          text: `Lỗi: ${s.message}`,
          tone: "text-rose-400",
          dot: "bg-rose-500",
        };
    }
  })();

  const updateRules = (patch: Partial<GameRules>) => {
    const next = { ...rules, ...patch };
    setRules(next);
    saveRules(next);
    send({ t: "rules", rules: next });
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

  const handleConnect = (e: FormEvent) => {
    e.preventDefault();
    if (watching) send({ t: "leave" });
    else if (username.trim()) send({ t: "join", username });
  };

  const playlist = game?.playlist ?? [];
  const playNext = () => {
    if (!playlist.length) return;
    send({ t: "pl-play", index: ((game?.playingIndex ?? -1) + 1) % playlist.length });
  };

  return (
    <main className="min-h-dvh bg-[#07080d] p-4 text-white md:p-6">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <header className="sticky top-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-[#07080d]/90 px-4 py-3 backdrop-blur md:-mx-6 md:px-6">
          <div className="flex items-center gap-3">
            <h1 className="text-base font-bold uppercase tracking-[0.22em]">
              🎛 Admin
            </h1>
            <span
              className={`flex items-center gap-2 rounded-full border border-white/10 bg-black/40 px-3 py-1 text-xs font-medium ${status.tone}`}
            >
              <span className={`h-2 w-2 rounded-full ${status.dot}`} />
              {status.text}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {game && (
              <span className="hidden font-mono text-xs text-white/60 sm:block">
                👀 {game.stats.viewerCount.toLocaleString("vi-VN")} · ❤️{" "}
                {game.stats.totalLikes.toLocaleString("vi-VN")} · 💎{" "}
                {game.stats.totalDiamonds.toLocaleString("vi-VN")}
              </span>
            )}
            <a
              href={GAME_URL}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold text-white/80 hover:border-cyan-300/60 hover:text-cyan-300"
            >
              🖥 Trang game
            </a>
            <a
              href={`${GAME_URL}/preview`}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold text-white/80 hover:border-amber-300/60 hover:text-amber-300"
            >
              🧪 Preview
            </a>
          </div>
        </header>

        {!connected && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-300/30 bg-amber-300/10 px-4 py-3 text-sm text-amber-200">
            ⚠ Chưa thấy trang game — mọi nút điều khiển sẽ chưa có tác dụng.
            <a
              href={GAME_URL}
              target="_blank"
              rel="noreferrer"
              className="font-semibold underline underline-offset-2 hover:text-amber-100"
            >
              Mở {GAME_URL}
            </a>
            trong tab khác rồi quay lại đây.
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Kết nối TikTok LIVE">
            <form onSubmit={handleConnect} className="flex flex-col gap-2">
              <input
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  localStorage.setItem("md:admin-user", e.target.value);
                }}
                placeholder="@username đang LIVE"
                disabled={watching}
                spellCheck={false}
                className={inputClass}
              />
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={!connected || (!watching && !username.trim())}
                  className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-40 ${
                    watching
                      ? "border border-white/15 text-white/70 hover:border-rose-400/60 hover:text-rose-300"
                      : "bg-rose-500 text-white hover:bg-rose-400"
                  }`}
                >
                  {watching ? "⏏ Ngắt kết nối" : "🔴 Kết nối"}
                </button>
                <button
                  type="button"
                  disabled={!connected || watching}
                  onClick={() => send({ t: "demo", on: !game?.demoRunning })}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm font-semibold disabled:opacity-40 ${
                    game?.demoRunning
                      ? "border-amber-300/60 text-amber-300"
                      : "border-cyan-300/40 text-cyan-300 hover:border-cyan-300/80"
                  }`}
                >
                  {game?.demoRunning ? "⏹ Dừng demo" : "🎬 Xem demo"}
                </button>
              </div>
            </form>
          </Card>

          <Card
            title="Hiển thị trên màn hình game"
            action={
              <span className="text-[10px] text-white/40">
                đồng bộ trực tiếp với trang game
              </span>
            }
          >
            <label className="flex cursor-pointer items-center gap-2 text-sm text-white/85">
              <input
                type="checkbox"
                checked={game?.legend ?? false}
                disabled={!connected}
                onChange={(e) =>
                  send({
                    t: "display",
                    legend: e.target.checked,
                    stats: game?.statsShown ?? false,
                  })
                }
                className="accent-rose-500"
              />
              Bảng quà donate cho người xem
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-white/85">
              <input
                type="checkbox"
                checked={game?.statsShown ?? false}
                disabled={!connected}
                onChange={(e) =>
                  send({
                    t: "display",
                    legend: game?.legend ?? false,
                    stats: e.target.checked,
                  })
                }
                className="accent-rose-500"
              />
              Số liệu 👀❤️💎
            </label>
            <div className="mt-1 flex flex-col gap-1 rounded-lg border border-white/5 bg-black/30 p-2">
              {buildLegend(rules).map((item) => (
                <span
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
                </span>
              ))}
            </div>
          </Card>
        </div>

        <Card
          title="Nhạc (playlist)"
          action={
            game?.nowPlaying ? (
              <span className="max-w-[50%] truncate text-xs text-cyan-300">
                ♪ {game.musicPaused ? "(tạm dừng) " : ""}
                {game.nowPlaying}
              </span>
            ) : null
          }
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (musicUrl.trim()) {
                send({ t: "pl-add", url: musicUrl, play: false });
                setMusicUrl("");
              }
            }}
            className="flex flex-col gap-2"
          >
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={musicUrl}
                onChange={(e) => setMusicUrl(e.target.value)}
                placeholder="URL: mp3 / video / YouTube / TikTok — hoặc tên bài hát"
                spellCheck={false}
                disabled={!connected}
                className={`${inputClass} min-w-52 flex-1`}
              />
              <button
                type="submit"
                disabled={!connected || !musicUrl.trim()}
                className="rounded-lg border border-cyan-300/40 px-3 py-2 text-sm font-semibold text-cyan-300 hover:border-cyan-300/80 disabled:opacity-40"
              >
                ➕ Thêm
              </button>
              <button
                type="button"
                disabled={!connected || !musicUrl.trim()}
                onClick={() => {
                  send({ t: "pl-add", url: musicUrl, play: true });
                  setMusicUrl("");
                }}
                className="rounded-lg border border-cyan-300/40 px-3 py-2 text-sm font-semibold text-cyan-300 hover:border-cyan-300/80 disabled:opacity-40"
              >
                ▶ Phát ngay
              </button>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={!connected || !game?.nowPlaying}
                  onClick={() => send({ t: "music-toggle" })}
                  className="rounded-lg border border-white/15 px-3 py-2 text-sm text-white/85 hover:text-white disabled:opacity-40"
                  title="Phát / tạm dừng"
                >
                  {game?.musicPaused || !game?.nowPlaying ? "▶" : "⏸"}
                </button>
                <button
                  type="button"
                  disabled={!connected || playlist.length === 0}
                  onClick={playNext}
                  className="rounded-lg border border-white/15 px-3 py-2 text-sm text-white/85 hover:text-white disabled:opacity-40"
                  title="Bài kế tiếp"
                >
                  ⏭
                </button>
              </div>
            </div>
            {game?.musicError && (
              <p className="text-xs text-rose-400">{game.musicError}</p>
            )}
            {playlist.length > 0 ? (
              <ul className="grid max-h-56 gap-1 overflow-y-auto md:grid-cols-2">
                {playlist.map((item, i) => (
                  <li key={`${item.title}-${i}`} className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => send({ t: "pl-play", index: i })}
                      className={`flex min-w-0 flex-1 items-center gap-1.5 rounded px-2 py-1 text-left text-xs hover:bg-white/10 ${
                        i === game?.playingIndex
                          ? "bg-cyan-300/10 text-cyan-300"
                          : "text-white/75"
                      }`}
                    >
                      {item.thumb ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={item.thumb}
                          alt=""
                          className="h-6 w-10 shrink-0 rounded object-cover"
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                          }}
                        />
                      ) : (
                        <span className="flex h-6 w-10 shrink-0 items-center justify-center rounded bg-white/5 text-white/40">
                          {item.kind === "file" ? "📁" : "♪"}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate">
                        {i === game?.playingIndex ? "♪ " : `${i + 1}. `}
                        {item.title}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => send({ t: "pl-remove", index: i })}
                      className="px-1 text-xs text-white/40 hover:text-rose-400"
                      title="Xóa khỏi playlist"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-white/40">
                Playlist trống — thêm URL hoặc thả file nhạc vào thư mục{" "}
                <code className="rounded bg-white/10 px-1">public/music</code>.
              </p>
            )}
          </form>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Luật sàn nhảy">
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs text-white/70">
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
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
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
                  Chat lệnh mới được lên sàn
                </label>
                {rules.requireStartCommand && (
                  <label className="flex items-center gap-2 text-sm text-white/85">
                    Lệnh
                    <input
                      value={rules.startCommand}
                      onChange={(e) =>
                        updateRules({ startCommand: e.target.value || "1" })
                      }
                      className={`${inputClass} w-20! text-center`}
                    />
                  </label>
                )}
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-white/85">
                <input
                  type="checkbox"
                  checked={rules.stayOnFloor}
                  onChange={(e) => updateRules({ stayOnFloor: e.target.checked })}
                  className="accent-rose-500"
                />
                Đã lên sàn thì ở lại luôn (đến khi rời live)
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
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
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
                  Độ nhạy beat (1.1–2.0)
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
              <button
                type="button"
                onClick={() => {
                  setRules(DEFAULT_RULES);
                  saveRules(DEFAULT_RULES);
                  send({ t: "rules", rules: DEFAULT_RULES });
                }}
                className="self-start rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/70 hover:text-white"
              >
                ↺ Khôi phục mặc định
              </button>
            </div>
          </Card>

          <Card
            title="Quà → hành động"
            action={
              <span className="text-[10px] text-white/40">
                mốc cao nhất đạt được sẽ chạy
              </span>
            }
          >
            <div className="flex flex-col gap-2">
              {rules.giftActions.map((rule, i) => (
                <div
                  key={i}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-white/5 bg-black/25 p-2"
                >
                  <GiftIcon name={rule.gift} />
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
                    className={`${inputClass} min-w-36 flex-1`}
                  >
                    <option value="__custom">✏️ Tùy chỉnh mốc 💎…</option>
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
                      className={`${inputClass} w-24!`}
                      title="Mốc 💎"
                    />
                  )}
                  <span className="text-xs text-white/50">→</span>
                  <select
                    value={rule.action}
                    onChange={(e) =>
                      updateGiftAction(i, {
                        action: e.target.value as GiftAction,
                      })
                    }
                    className={`${inputClass} min-w-36 flex-1`}
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
                    title="Xóa dòng"
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
              <label className="text-xs text-white/70">
                Bảng lệnh tùy chỉnh (mỗi dòng 1 mục, để trống = tự sinh theo luật)
                <textarea
                  value={rules.legendOverride}
                  onChange={(e) =>
                    updateRules({ legendOverride: e.target.value })
                  }
                  rows={4}
                  placeholder={"🌹 Rose — nhảy 1 cái\n🎧 Sunglasses — order nhạc"}
                  className={`${inputClass} min-h-20 resize-y font-mono text-xs`}
                />
              </label>
            </div>
          </Card>
        </div>
      </div>
    </main>
  );
}
