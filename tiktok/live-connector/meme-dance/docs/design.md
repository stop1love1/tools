# Design — Meme Dance (2026-07-16)

## Mục tiêu

Game "vũ trường meme" cho TikTok LIVE (tham khảo các stream vũ trường đầu nấm): người xem tương tác qua comment/quà/tim, nhân vật của họ nhảy trên sàn 3D. Streamer quay màn hình game lên LIVE bằng OBS/TikTok Live Studio.

## Quyết định đã chốt (từ user)

- Render 3D thật bằng three.js (không phải 2.5D canvas).
- Nhân vật đầu nấm tự vẽ bằng code, thay được bằng PNG trong `public/characters/`.
- Đủ bộ lệnh: cơ bản (xuất hiện/nhảy/đổi nv/đi vòng) + to lên/nhỏ lại + quà → pháo hoa & bục top + like → hiệu ứng đám đông.
- Không dùng git.

## Kiến trúc

- Server bridge sao chép pattern từ `../demo` (Socket.IO + tiktok-manager), thêm sự kiện `live:like` per-event cho hiệu ứng hype. Port 3100 (demo giữ 3000).
- Game chạy hoàn toàn client-side trong canvas; server chỉ đẩy sự kiện.
- Nhân vật = THREE.Sprite billboard, texture vẽ bằng offscreen canvas (2 frame: tay xuống/tay lên, swap theo nhịp). Tên = sprite label canvas.
- Sàn disco = InstancedMesh ô màu, đổi màu theo bước; đèn quét = cone additive; pháo hoa = THREE.Points có trọng lực, tự hủy sau 1.6s.
- Bục top 3 (vàng/bạc/đồng) cuối sàn, hiện clone nhân vật + tên + số kim cương; cập nhật khi chốt quà (không tính lúc đang combo).
- Hype 0..1: like/quà/follow cộng vào, tự decay; điều khiển tốc độ nhảy + độ sáng hiệu ứng.
- Giới hạn 120 nhân vật, đầy thì loại nhân vật im lặng lâu nhất (LRU).

## Đã verify

- `tsc --noEmit` sạch; `next build` thành công.
- Server phục vụ trang + `/api/characters`; luồng socket join → connecting → error hoạt động đúng với username không tồn tại.
