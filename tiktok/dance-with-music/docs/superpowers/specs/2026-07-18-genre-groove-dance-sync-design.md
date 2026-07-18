# Cải thiện đồng bộ nhịp & chất nhảy theo thể loại

Ngày: 2026-07-18

## Mục tiêu

Vũ công khớp nhịp hơn và "cảm" đúng chất từng thể loại nhạc — không chỉ khác
biên độ mà khác cả *timing* và *hình dạng động tác*. Không đụng thuật toán dò
beat (đang tốt); chỉ cải thiện cách vũ công diễn giải tín hiệu nhạc đã có.

## Trục xương sống: `GENRE_GROOVE`

Mở rộng `GENRE_FEEL` (`{amp, bob}`) thành bảng chất nhịp đầy đủ, đặt ở `rig.ts`,
export cho `player.ts` dùng chung (giữ phụ thuộc một chiều player → rig):

```
GENRE_GROOVE[genre] = {
  amp,       // biên độ động tác
  bob,       // độ nhún/gật phách
  swing,     // 0 = dính grid (edm); + = lay-back trễ phách (hiphop)
  timeFeel,  // "straight" | "half" (ballad nhún mỗi 2 phách)
  peak,      // vị trí đỉnh đường cong nhún 0..1; 0.5 = sin đối xứng (như cũ),
             // <0.5 = attack sắc/lò xo (edm), >0.5 = mềm muộn (ballad)
}
```

Giá trị dự kiến (tinh chỉnh sau khi xem app):

| genre  | amp | bob | swing | timeFeel | peak |
|--------|-----|-----|-------|----------|------|
| ballad | 0.5 | 0.4 | 0.0   | half     | 0.5  |
| pop    | 0.75| 0.8 | 0.03  | straight | 0.5  |
| hiphop | 0.85| 1.1 | 0.07  | straight | 0.40 |
| rock   | 1.0 | 1.0 | 0.025 | straight | 0.45 |
| edm    | 1.0 | 1.2 | 0.0   | straight | 0.35 |

## Bốn cải thiện

1. **Swing / half-time** — biến đổi `pulse` trước khi tính đường nhún.
   `gpulse = wrap(pulse - swing)` cho lay-back; `timeFeel:"half"` trải một cung
   nhún qua 2 phách để ballad thong thả, không giật từng phách.

2. **`grooveCurve(phase, peak)`** — thay `Math.sin(hopPhase*π)`. Cung tam giác
   làm mượt bằng sin, lệch đỉnh theo `peak`. `peak=0.5` rút gọn ĐÚNG BẰNG hành
   vi hiện tại (an toàn); `peak<0.5` cho attack sắc kiểu lò xo (edm), `>0.5` mềm.

3. **Bật theo tiếng thật** — thêm `MusicVibe.kick` (= `music.level`) và
   `MusicVibe.snare` (= `mid*0.4 + high*0.6`). Cộng một cú "pop" vào độ nảy đầu
   phách, cường độ lấy từ tiếng thật theo backbeat: phách 1&3 dùng kick, 2&4
   dùng snare. Cộng thêm (không nhân vào cung nhún) để tránh xẹp giữa nhịp.

4. **`beatConfidence`** — thêm `MusicVibe.beatConfidence`. Nhịp chắc → cú pop
   sắc + biên độ đầy; nhịp không chắc → dịu lại tránh nhún trên phách sai. Áp cả
   trong `player` (amp + pop) và `rig` (`poseFor` sửa `beatHit`).

## Phạm vi thay đổi

- `rig.ts`: `GENRE_GROOVE` (thay `GENRE_FEEL`); `RigDrive.beatConfidence`;
  `beatHit` sắc theo confidence; nhận `pulse` đã dịch swing.
- `player.ts`: import `GENRE_GROOVE`; mở rộng `MusicVibe`; swing/half-time;
  `grooveCurve`; cú pop theo kick/snare; dùng confidence trong amp.
- `game.ts`: nạp `kick`/`snare`/`beatConfidence` vào `this.vibe`.

## Kiểm chứng

Build sạch + chạy app thật, xem vũ công nhảy trên vài thể loại nhạc (ballad,
hiphop, edm, rock) để xác nhận khác chất nhịp rõ và khớp phách.
