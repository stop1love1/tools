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
└─ live-connector/      Các game & tool (mỗi folder 1 tool)
   ├─ demo/             Dashboard theo dõi LIVE realtime (port 3000)
   └─ meme-dance/       Game vũ trường meme đầu nấm 3D (port 3100)
```

## Chạy nhanh

```bash
# Backend
cd tiktok/server && go run .

# Sidecar data API (tùy chọn, cần cho /api/data/*)
cd tiktok/server/sidecar && py -3.13 main.py

# Game
cd tiktok/live-connector/meme-dance && npm run dev
```

## Ghi chú

- `demo` và `meme-dance` là frontend thuần, nhận dữ liệu qua WebSocket của backend Go (`ws://localhost:8080/ws?user=…`) — **cần chạy `server/` trước**.
- Tất cả dựa trên reverse-engineering TikTok — không phải API chính thức.
