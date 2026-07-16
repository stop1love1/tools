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

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <h3 className="text-[11px] font-bold uppercase tracking-[0.18em] text-white/50">
        {title}
      </h3>
      {children}
    </section>
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

  const connected = game && now - lastSeen < 3000;
  const watching =
    game?.status.state === "connecting" || game?.status.state === "connected";

  const statusLine = (() => {
    if (!connected) return "⚠ Chưa thấy trang game — hãy mở http://localhost:3100 trong tab khác";
    const s = game!.status;
    switch (s.state) {
      case "idle":
        return "Chưa kết nối TikTok";
      case "connecting":
        return `Đang kết nối @${s.username}…`;
      case "connected":
        return `🔴 Đang LIVE cùng @${s.username}`;
      case "ended":
        return `LIVE của @${s.username} đã kết thúc`;
      case "error":
        return `Lỗi: ${s.message}`;
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

  return (
    <main className="min-h-dvh bg-[#07080d] p-6 text-white">
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-lg font-bold uppercase tracking-[0.25em]">
            🎛 Admin — Live cùng TikTok
          </h1>
          <p
            className={`text-sm font-medium ${
              !connected
                ? "text-amber-300"
                : game?.status.state === "connected"
                  ? "text-emerald-400"
                  : game?.status.state === "error"
                    ? "text-rose-400"
                    : "text-white/60"
            }`}
          >
            {statusLine}
          </p>
        </header>

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

                  className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-40 ${
                    watching
                      ? "border border-white/15 text-white/70 hover:border-rose-400/60 hover:text-rose-300"
                      : "bg-rose-500 text-white hover:bg-rose-400"
                  }`}
                >
                  {watching ? "Ngắt kết nối" : "Kết nối"}
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
              {game && (
                <p className="font-mono text-xs text-white/60">
                  👀 {game.stats.viewerCount.toLocaleString("vi-VN")} · ❤️{" "}
                  {game.stats.totalLikes.toLocaleString("vi-VN")} · 💎{" "}
                  {game.stats.totalDiamonds.toLocaleString("vi-VN")}
                </p>
              )}
            </form>
          </Card>

          <Card title="Nhạc (playlist)">
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
              <input
                value={musicUrl}
                onChange={(e) => setMusicUrl(e.target.value)}
                placeholder="URL: mp3 / video / YouTube / TikTok"
                spellCheck={false}
                className={inputClass}
              />
              <div className="flex items-center gap-2">
                <button
                  type="submit"

                  className="rounded-lg border border-cyan-300/40 px-3 py-2 text-sm font-semibold text-cyan-300 hover:border-cyan-300/80 disabled:opacity-40"
                >
                  ➕ Thêm
                </button>
                <button
                  type="button"

                  onClick={() => {
                    if (musicUrl.trim()) {
                      send({ t: "pl-add", url: musicUrl, play: true });
                      setMusicUrl("");
                    }
                  }}
                  className="rounded-lg border border-cyan-300/40 px-3 py-2 text-sm font-semibold text-cyan-300 hover:border-cyan-300/80 disabled:opacity-40"
                >
                  ▶ Phát ngay
                </button>
                <button
                  type="button"

                  onClick={() => send({ t: "music-toggle" })}
                  className="rounded-lg border border-white/15 px-3 py-2 text-sm text-white/85 hover:text-white disabled:opacity-40"
                >
                  {game?.musicPaused || !game?.nowPlaying ? "▶" : "⏸"}
                </button>
              </div>
              {game?.nowPlaying && (
                <p className="truncate text-xs text-cyan-300">
                  ♪ {game.musicPaused ? "(tạm dừng) " : ""}
                  {game.nowPlaying}
                </p>
              )}
              {game?.musicError && (
                <p className="text-xs text-rose-400">{game.musicError}</p>
              )}
              {game && (game.playlist?.length ?? 0) > 0 && (
                <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
                  {(game.playlist ?? []).map((item, i) => (
                    <li key={`${item.title}-${i}`} className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => send({ t: "pl-play", index: i })}
                        className={`min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-xs hover:bg-white/10 ${
                          i === game.playingIndex
                            ? "text-cyan-300"
                            : "text-white/75"
                        }`}
                      >
                        {i === game.playingIndex ? "♪ " : `${i + 1}. `}
                        {item.title}
                        {item.kind === "file" ? " 📁" : ""}
                      </button>
                      <button
                        type="button"
                        onClick={() => send({ t: "pl-remove", index: i })}
                        className="px-1 text-xs text-white/40 hover:text-rose-400"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </form>
          </Card>

          <Card title="Hiển thị trên màn hình game">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-white/85">
              <input
                type="checkbox"
                checked={game?.legend ?? false}

                onChange={(e) =>
                  send({
                    t: "display",
                    legend: e.target.checked,
                    stats: game?.statsShown ?? false,
                  })
                }
                className="accent-rose-500"
              />
              Bảng lệnh cho người xem
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-white/85">
              <input
                type="checkbox"
                checked={game?.statsShown ?? false}

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
          </Card>

          <Card title="Xem trước bảng lệnh">
            <ul className="flex flex-col gap-1">
              {buildLegend(rules).map((item) => (
                <li key={item.label} className="text-xs text-white/75">
                  {item.emoji} {item.label}
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <Card title="Luật chơi">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-2">
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
                    className={`${inputClass} w-24! text-center`}
                  />
                </label>
              )}
              <label className="flex cursor-pointer items-center gap-2 text-sm text-white/85">
                <input
                  type="checkbox"
                  checked={rules.stayOnFloor}
                  onChange={(e) =>
                    updateRules({ stayOnFloor: e.target.checked })
                  }
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
                  Độ nhạy beat (1.1 nhạy — 2.0 chỉ beat mạnh)
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
            </div>
            <div className="flex flex-col gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-white/40">
                Quà → hành động (tự soạn, mốc cao nhất đạt được sẽ chạy)
              </p>
              <div className="flex flex-col gap-2">
                {rules.giftActions.map((rule, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
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
                      className={`${inputClass} min-w-44 flex-1`}
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
                      className={`${inputClass} min-w-40 flex-1`}
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
              </div>
              <label className="text-xs text-white/70">
                Bảng lệnh tùy chỉnh (mỗi dòng 1 mục, để trống = tự sinh theo luật)
                <textarea
                  value={rules.legendOverride}
                  onChange={(e) =>
                    updateRules({ legendOverride: e.target.value })
                  }
                  rows={5}
                  placeholder={"💬 Bình luận để vào khán đài\n🕺 Chat 1 để lên sàn\n🎁 Tặng quà để lên bục DJ"}
                  className={`${inputClass} min-h-24 resize-y font-mono text-xs`}
                />
              </label>
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
          </div>
        </Card>

        <p className="text-xs text-white/40">
          Trang game (đưa vào OBS): http:
          khiển, không hiện trên stream. Nhạc phát ra từ tab game.
        </p>
      </div>
    </main>
  );
}
