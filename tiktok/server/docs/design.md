# Design — TikTok Backend Go (2026-07-16)

## Quyết định đã chốt (từ user)

- Backend trung tâm tại `tiktok/server`, viết bằng **Go**, làm toàn bộ BE trước khi động frontend.
- Vai trò: **bridge TikTok LIVE trung tâm** — các game (demo :3000, meme-dance :3100) sau này bỏ server Node nhúng, kết nối WebSocket vào đây.
- Stack: **stdlib net/http + gorilla/websocket**, thư viện live: `steampoweredtaco/gotiktoklive` (fork active, signing mới qua Euler Stream).
- Lưu trữ: **MongoDB** (driver chính thức v2) — sessions, gifts, chats. Không có DB vẫn chạy (Store nil-safe).
- Nhóm API dữ liệu (video meta+download, user profile+posts, comments+replies, trending/search): kiến trúc **Go gateway + Python sidecar** (FastAPI + TikTokApi) vì các thư viện data đều là Python; Go proxy tại `/api/data/*`.
- Sidecar do agent song song xây tại `server/sidecar/` (port 8500).

## Kiến trúc

```
Games ──► Go server :8080
           ├─ GET /ws?user=X      → Hub → Room (1 gotiktoklive.Live / streamer)
           ├─ GET /api/health|rooms|sessions|gifts
           └─ /api/data/*         → reverse proxy → FastAPI sidecar :8500
MongoDB ◄── store (sessions, gifts, chats)
```

- **Hub/Room/Client** (internal/hub): Room giữ 1 kết nối TikTok + set client WS; client cuối rời → `live.Close()` + xóa room. Trạng thái terminal (ended/error) → broadcast rồi xóa room khỏi map, client reconnect sẽ tạo room mới.
- **Wire format** trùng `src/shared/live-events.ts` của các game Node → migration frontend chỉ cần đổi transport socket.io → WebSocket thuần.
- Chống đếm trùng quà combo: `streaking = (type==1 || isCombo) && !repeatEnd`; chỉ cộng kim cương + log DB khi chốt.
- Stats gộp phát mỗi 300ms (ticker + dirty flag) — tránh spam khi stream đông.
- Bỏ sự kiện lịch sử (`IsHistory()`) — tương đương `processInitialData: false` bên Node.
- Sự kiện lạ/ControlEvent khác action 3 (ended): bỏ qua.

## Đã verify

- `go build ./...` sạch.
- `/api/health` → `{ok:true, mongo:true, rooms:0}` (MongoDB local có sẵn, kết nối thật).
- `/api/data/health` khi sidecar tắt → lỗi JSON có hướng dẫn, không crash.
- WS `/ws?user=<không tồn tại>` → `status connecting` → `stats` → `status error "user not found"` (đã gọi TikTok thật qua signer).

## Đã migrate frontend (2026-07-16)

- `demo` và `meme-dance` đã bỏ server Node nhúng (server.ts, src/server/, socket.io, tiktok-live-connector, tsx) — chỉ còn frontend thuần kết nối `ws://localhost:8080/ws?user=…` bằng WebSocket native, cấu hình qua `NEXT_PUBLIC_LIVE_WS_URL`.
- Verify: cả 2 app build sạch, chạy cùng Go server, WS handshake 101.

## Việc tiếp theo (chưa làm)

- Test với streamer đang live thật.
- Endpoint điều khiển thêm (nếu cần): force-disconnect room.
