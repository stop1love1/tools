# TikTok Backend — Go server 🚀

Backend trung tâm cho toàn bộ tools/games TikTok trong `d:\projects\tools\tiktok`:

1. **Live bridge** — kết nối TikTok LIVE (thư viện Go [gotiktoklive](https://github.com/steampoweredtaco/gotiktoklive)), phát sự kiện chat/quà/tim/vào phòng qua WebSocket cho các game (demo, meme-dance…).
2. **Data API** — proxy sang sidecar Python (FastAPI) cung cấp API video/user/comment/trending (dựa trên TikTokApi).
3. **MongoDB** — lưu phiên live, log quà tặng, log chat.

## Chạy

```bash
cd tiktok/server
go run .                    # http://localhost:8080
```

Sidecar Python (API dữ liệu) chạy riêng: `cd sidecar && py -3.13 main.py` — chi tiết xem [sidecar/README.md](sidecar/README.md). (Máy này dùng `py -3.13`; bản `python` 3.14 mặc định đang lỗi.)

Cấu hình qua biến môi trường (xem [.env.example](.env.example)): `PORT`, `MONGODB_URI`, `MONGODB_DB`, `SIGN_API_KEY`, `SIDECAR_URL`. Không có MongoDB vẫn chạy bình thường (chỉ tắt lưu trữ).

## WebSocket — live bridge

```
ws://localhost:8080/ws?user=<username>
```

Mỗi message là JSON `{"type": "...", "data": {...}}`, cùng format với `src/shared/live-events.ts` của các game Node:

| type | data |
|---|---|
| `status` | `{state: connecting\|connected\|ended\|error, username, roomId?, message?}` |
| `chat` | `{id, user{userId,uniqueId,nickname,avatarUrl}, comment, ts}` |
| `gift` | `{id, user, giftId, giftName, giftImageUrl, diamondCount, repeatCount, streaking, totalDiamonds, ts}` — kim cương chỉ chốt khi `streaking=false` |
| `like` | `{user, count, ts}` |
| `activity` | `{id, kind: join\|follow\|share, user, ts}` |
| `stats` | `{viewerCount, totalLikes, totalDiamonds, joinCount}` (gộp, phát tối đa ~3 lần/giây) |

Một streamer = một kết nối TikTok dùng chung cho mọi client; client cuối ngắt thì server tự ngắt kết nối TikTok.

## REST API

| Endpoint | Mô tả |
|---|---|
| `GET /api/health` | `{ok, mongo, rooms}` |
| `GET /api/rooms` | Các phòng đang theo dõi + stats |
| `GET /api/sessions?username=&limit=` | Lịch sử phiên live (Mongo) |
| `GET /api/gifts?username=&limit=` | Log quà tặng gần nhất (Mongo) |
| `GET /api/data/*` | Proxy sang sidecar Python — video meta/download, user profile/posts, comments, trending, search |

## Cấu trúc code

- [main.go](main.go) — khởi động, wiring.
- [internal/hub/hub.go](internal/hub/hub.go) — Hub/Room/Client: vòng đời kết nối TikTok, broadcast, ref-count.
- [internal/events/dto.go](internal/events/dto.go) — DTO wire format (khớp TS).
- [internal/store/mongo.go](internal/store/mongo.go) — sessions/gifts/chats (nil-safe khi không có DB).
- [internal/httpapi/server.go](internal/httpapi/server.go) — routes, CORS, reverse proxy sidecar.
- [sidecar/](sidecar/) — FastAPI Python (API dữ liệu).

## Lưu ý

- gotiktoklive ký URL WebSocket qua Euler Stream — dùng nhiều nên đặt `SIGN_API_KEY`.
- Reverse-engineering: TikTok đổi API là có thể hỏng, không phải API chính thức.
