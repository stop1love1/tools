# Dance With Music — sàn nhảy TikTok LIVE 🕺🍄

> Model 3D: DJ Booth by Fredi L, Simple Truss by Rellik 66 (Poly Pizza, CC-BY 3.0); speaker/subwoofer/LED (Kenney, CC0); spotlight/stage (iPoly3D, CC0); Light Icosahedron (Quaternius, CC0).

Game tương tác TikTok LIVE kiểu "vũ trường meme": người xem comment là nhân vật **đầu nấm** của họ xuất hiện trên sàn nhảy 3D, gõ lệnh để điều khiển, tặng quà để bắn pháo hoa và leo bục top.

Một tool trong bộ `tiktok/`. Frontend thuần **Next.js 16 + TypeScript + three.js**, nhận dữ liệu từ **backend Go** (`tiktok/server`) qua WebSocket.

## Chạy

```bash
# 1. Backend Go (bắt buộc)
cd ../../server && go run .        # port 8080

# 2. Game
npm install
npm run dev                        # http://localhost:3100
```

Nhập `@username` của tài khoản **đang phát LIVE** → **Kết nối**. Đưa cửa sổ trình duyệt này vào OBS/TikTok Live Studio để phát ngược lên LIVE.

Đổi địa chỉ backend bằng env `NEXT_PUBLIC_LIVE_WS_URL` (mặc định `ws://localhost:8080/ws`).

## Luật chơi

| Hành động | Kết quả |
|---|---|
| Comment bất kỳ / vào phòng | Rơi từ trời xuống **khán đài** (phía trước sàn) |
| Chat `1` | **Lên sàn nhảy** theo nhịp nhạc 128 BPM (30s) |
| Comment tiếp | Gia hạn nhảy (+15s/lần); hết giờ tự về khán đài |
| `nhảy` / `đổi nv` / `đi vòng` / `to lên` / `nhỏ lại` | Hành động tương ứng |
| Quà 1💎 | Nhảy 1 cái |
| Quà 2-9💎 | Đi vòng |
| Quà 10💎 | Đổi nhân vật |
| Quà 20💎+ | To lên |
| Quà 100💎+ | Camera lướt vào cận cảnh + pháo hoa |
| Quà 500💎+ | Huy hiệu vàng dưới chân (2 phút) |
| Top donate 1-2-3 | **Đứng thật trên bục cạnh bàn DJ** |
| Thả tim ❤️ | Tim bay + cả sàn quẩy nhanh, hype cao thì confetti |

Lệnh không cần dấu (`nhay`, `doi nv`, `to len`… đều nhận). Nút **🎬 Xem demo** giả lập đám đông để thử không cần live.

## Nhạc 🎵

- **Dán URL** vào ô "URL nhạc" trên HUD: link `.mp3`/video trực tiếp, hoặc **link video TikTok** (tự tách audio qua backend `/api/data/video/meta` — cần sidecar Python đang chạy).
- Hoặc thả file vào [public/music/](public/music/) → nút ▶/⏭ playlist.
- Nhạc được luồn qua proxy `/api/stream` (same-origin) để Web Audio **bắt nhịp thật**: cả sàn nhảy, đèn, loa, strobe đập đúng phách bài đang phát; màn hình LED trên bàn DJ hiện tên bài + EQ. Không có nhạc → nhịp auto 128 BPM.

## Thay nhân vật bằng ảnh meme thật

Bỏ file PNG/WebP (nền trong suốt, ~256×320) vào [public/characters/](public/characters/) — mỗi file là 1 skin, tải lại trang là game tự dùng thay bộ vẽ sẵn.

## Kiến trúc

```
Browser (game 3D) ── WebSocket ──► tiktok/server (Go :8080) ──► TikTok LIVE
```

- [src/game/](src/game/) — three.js: `game.ts` (scene, podium, hype), `player.ts` (nhân vật + animation), `skins.ts` (vẽ đầu nấm bằng canvas), `effects.ts` (sàn disco, đèn quét, pháo hoa), `commands.ts` (parse lệnh tiếng Việt).
- [src/hooks/use-live-game.ts](src/hooks/use-live-game.ts) — WebSocket → game (envelope `{type, data}`).
- [src/shared/live-events.ts](src/shared/live-events.ts) — types khớp wire format backend Go.
