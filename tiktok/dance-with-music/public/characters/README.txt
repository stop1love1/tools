NHÂN VẬT "ĐẦU NẤM"
==================

Nhân vật của game là meme 蘑菇头 (mógū tóu — "đầu nấm"), tiếng Việt quen gọi là
"đầu nấm" hoặc "meme mặt nhăn tóc bát". Đặc điểm nhận dạng:

  - Tóc bát ÚP đen tuyền, vòm tóc trùm quá khổ khuôn mặt, hai vạt tóc buông
    xuống tận quai hàm
  - Mặt là ẢNH NGƯỜI THẬT grayscale (mặt nhăn nhó / cười gằn), dán lên thân
    người hoạt hình
  - Đơn sắc: đen / trắng / xám, viền đen dày, tay chân kiểu sợi mì

KHÔNG PHẢI cây nấm (nấm ruồi chấm bi). "Nấm" ở đây nói kiểu TÓC.

Bỏ ảnh vào folder này để thêm nhân vật
--------------------------------------
Mỗi file PNG/WebP = 1 nhân vật. Ảnh nền trắng cũng được — game tự tách nền.

Đặt tên `ten_0.png`, `ten_1.png`, `ten_2.png`… thì cả bộ được gom thành MỘT
nhân vật có bấy nhiêu khung hình (sprite sheet). Ảnh lẻ thì game tự sinh vòng
nhảy bằng cách uốn chính ảnh đó theo nhịp.

Game tự dọn ảnh khi nạp (chỉ với ảnh lẻ):
  - Xoá nền trắng
  - Giữ lại DUY NHẤT mảng liền khối lớn nhất → bay hết chữ in trong ảnh và
    nhân vật phụ đứng cạnh
  - Cắt sát nhân vật → chân chạm đúng mặt sàn, không lửng lơ

Bộ nhiều khung KHÔNG bị dọn (cắt sát từng khung một sẽ làm nhân vật giật khi
phát), nên sprite sheet cần được canh sẵn và không dính chữ.

Nguồn ảnh đang có
-----------------
  meme*.png, mogu-*.png   — có sẵn trong repo từ trước
  mgt-*.webp              — bộ sticker 蘑菇头 tải từ stickers.cloud
                            (https://stickers.cloud/en/pack/蘑菇头)

Đây là ảnh meme lan truyền trên mạng, không rõ tác giả gốc và không kèm giấy
phép. Dùng cho stream cá nhân thì bình thường; nếu định thương mại hoá thì nên
thay bằng bộ nhân vật tự vẽ hoặc mua bản quyền.

Bộ nhân vật vẽ bằng canvas trong src/game/skins.ts chỉ là phương án dự phòng
khi folder này có dưới 12 nhân vật — nét vẽ tay không tài nào ra được cái mặt
người thật của meme gốc.
