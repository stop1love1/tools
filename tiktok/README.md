# TikTok Tools 🧰

Bộ công cụ TikTok LIVE: backend trung tâm + các game/tool tương tác.

## Cấu trúc

```
tiktok/
├─ server/              Backend Go (port 8080)
│  │                    • Live bridge: WebSocket sự kiện chat/quà/tim
│  │                    • REST: sessions/gifts (MongoDB)
│  │                    • /api/data/* → proxy sidecar Python
│  └─ sidecar/          FastAPI Python (port 8500)
│                       • API video / user / comment / trending
└─ dance-with-music/    Game vũ trường meme đầu nấm 3D (port 3100)
```

## Chạy nhanh

```bash
# Dev (hot-reload): backend Go + sidecar Python + chọn frontend (Windows/macOS/Linux)
cd tiktok
node dev.mjs                       # hỏi chọn FE
node dev.mjs dance-with-music      # chỉ định FE luôn
node dev.mjs --no-server           # chỉ chạy FE

# Production: build (go build + next build) rồi chạy tất cả
node start.mjs dance-with-music
node start.mjs --skip-build        # chạy lại bản đã build, khỏi build lại
```

Hoặc chạy tay từng phần:

```bash
# Backend
cd tiktok/server && go run .

# Sidecar data API (tùy chọn, cần cho /api/data/*)
cd tiktok/server/sidecar && py -3.13 main.py

# Game
cd tiktok/dance-with-music && npm run dev
```

## Ghi chú

- `dance-with-music` là frontend thuần, nhận dữ liệu qua WebSocket của backend Go (`ws://localhost:8080/ws?user=…`) — **cần chạy `server/` trước**.
- Tất cả dựa trên reverse-engineering TikTok — không phải API chính thức.
