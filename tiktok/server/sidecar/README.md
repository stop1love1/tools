# TikTok Data Sidecar

Service FastAPI nhỏ đứng sau Go gateway (gateway proxy `/api/data/*` về đây), dùng thư viện [TikTokApi](https://github.com/davidteather/TikTok-Api) (v7) để lấy dữ liệu TikTok.

## Yêu cầu

- Python 3.11 trở lên
- Trình duyệt Chromium do Playwright quản lý (bước cài bên dưới)

## Cài đặt

```bash
pip install -r requirements.txt
python -m playwright install chromium
```

Bước `playwright install chromium` là **bắt buộc** — TikTokApi v7 điều khiển trình duyệt Chromium thật để tạo session, nếu thiếu sẽ báo lỗi khi gọi endpoint dữ liệu.

> Lưu ý trên máy Windows có nhiều bản Python: dùng đúng bản Python đã cài thư viện, ví dụ `py -3.13 -m pip install -r requirements.txt` và `py -3.13 -m playwright install chromium`.

## Biến môi trường

Sao chép `.env.example` thành `.env` rồi điền giá trị:

| Biến | Bắt buộc | Ý nghĩa |
| --- | --- | --- |
| `MS_TOKEN` | Không | Giá trị cookie `msToken` trên tiktok.com. Mở tiktok.com đã đăng nhập → DevTools → Application → Cookies → copy giá trị `msToken`. Không có vẫn chạy được nhưng dễ bị TikTok chặn hơn. |
| `SIDECAR_PORT` | Không | Cổng lắng nghe, mặc định `8500`. Service chỉ bind `127.0.0.1`. |

## Chạy

```bash
# Cách 1
python main.py

# Cách 2
uvicorn main:app --host 127.0.0.1 --port 8500
```

Kiểm tra: `curl http://127.0.0.1:8500/health` → `{"ok":true,"msToken":false}` (`msToken` là `true` nếu đã đặt `MS_TOKEN`).

## Endpoint

Tất cả trả JSON. Khi TikTok chặn/lỗi upstream, trả **HTTP 502** dạng:

```json
{"error": "EmptyResponseException: ...", "hint": "TikTok chặn bot — thử đặt MS_TOKEN hoặc dùng proxy"}
```

### `GET /health`

```bash
curl "http://127.0.0.1:8500/health"
# {"ok":true,"msToken":false}
```

### `GET /video/meta?url=<url video>`

Metadata một video: `id`, `description`, `author{id,uniqueId,nickname,avatar}`, `stats{views,likes,comments,shares}`, `music{title,author}`, `video{duration,cover,downloadUrl,playUrl}`. Hỗ trợ cả short link `vm.tiktok.com` (tự follow redirect).

```bash
curl "http://127.0.0.1:8500/video/meta?url=https://www.tiktok.com/@tiktok/video/7231338487075638570"
```

### `GET /user/profile?username=<uniqueId>`

Hồ sơ người dùng: `id`, `uniqueId`, `nickname`, `avatar`, `signature`, `verified`, `stats{followers,following,hearts,videos}`.

```bash
curl "http://127.0.0.1:8500/user/profile?username=tiktok"
```

### `GET /user/posts?username=<uniqueId>&count=10`

Danh sách video mới của user (mỗi phần tử cùng cấu trúc với `/video/meta`).

```bash
curl "http://127.0.0.1:8500/user/posts?username=tiktok&count=5"
```

### `GET /comments?url=<url video>&count=20`

Danh sách bình luận: `{id, text, user{uniqueId,nickname,avatar}, likes, replyCount}`.

```bash
curl "http://127.0.0.1:8500/comments?url=https://www.tiktok.com/@tiktok/video/7231338487075638570&count=20"
```

### `GET /comments/replies?url=<url video>&comment_id=<id>&count=20`

Trả lời của một bình luận, cùng cấu trúc với `/comments`.

```bash
curl "http://127.0.0.1:8500/comments/replies?url=https://www.tiktok.com/@tiktok/video/7231338487075638570&comment_id=7231345000000000000&count=20"
```

### `GET /trending?count=10`

Video đang thịnh hành (cùng cấu trúc với `/video/meta`).

```bash
curl "http://127.0.0.1:8500/trending?count=10"
```

### `GET /search?q=<từ khóa>&count=10`

Tìm video theo từ khóa. Nếu bản TikTokApi đang cài không hỗ trợ search video, trả **HTTP 501** `{"error":"search not supported","hint":"..."}`.

```bash
curl "http://127.0.0.1:8500/search?q=hanoi&count=10"
```

## Ghi chú chống bot

- TikTok chặn bot khá gắt. Nếu gặp lỗi 502 với `EmptyResponseException`, thử:
  1. Đặt `MS_TOKEN` (cookie `msToken` từ phiên đăng nhập thật trên tiktok.com — token này hết hạn theo thời gian, cần thay mới định kỳ).
  2. Dùng **proxy** (dân cư/residential càng tốt) — TikTokApi hỗ trợ tham số proxy khi tạo session.
  3. Giảm tần suất gọi; service đã dùng chung 1 session và tự tạo lại session khi lỗi.
- Lần gọi dữ liệu đầu tiên sẽ chậm (vài giây) vì phải khởi động Chromium và tạo session.
- Chỉ bind `127.0.0.1` — không expose trực tiếp ra ngoài, mọi truy cập đi qua Go gateway.
