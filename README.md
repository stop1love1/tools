# Jira dashboard

Dashboard local: task Jira của bạn, trang Confluence được link, đổi trạng thái, thông báo. Không cần `npm install` (Node ≥ 18).

## Chạy

```bash
./dev.sh        # chọn j
# hoặc
cd tools/jira-dashboard && npm start      # → http://localhost:4747
```

## Đăng nhập & token

Mọi thứ đi qua Atlassian MCP server (`mcp.atlassian.com`) — token của nó không dùng được với Jira REST API.

- **Mặc định**: dùng token Claude Code đã lưu khi kết nối Atlassian MCP (`~/.claude/.credentials.json`), chỉ đọc. Hết hạn sau ~8 giờ; tool **không** refresh token này vì refresh token bị xoay vòng — refresh hộ sẽ làm Claude Code bị đăng xuất.
- **Tự refresh** (khuyên dùng): bấm **Bật tự refresh** trên header → đăng nhập Atlassian một lần. Dashboard tự đăng ký OAuth client riêng, lưu token vào `.oauth.json` (chmod 600, đã gitignore) và tự refresh, độc lập với Claude Code. Xoá `.oauth.json` để quay về token của Claude Code.

Cấu hình tuỳ chọn: xem `.env.example`.

## Có gì

- **Cần xử lý gấp** ở đầu trang: quá hạn, hạn ≤ 3 ngày, ưu tiên High trở lên, nhãn hotfix/urgent. Danh sách cũng xếp theo độ gấp.
- **Thanh tiến trình**: hoàn thành / đang làm / chưa làm trên tổng (task huỷ không tính).
- **Danh sách** nhóm theo parent — bấm dòng parent để thu gọn/mở rộng. Đổi trạng thái bằng nút trạng thái (theo workflow Jira).
- **Chi tiết task** ngay trong dashboard (bấm key/dòng): mô tả, bình luận, task con, tài liệu Confluence (cả kế thừa từ parent), MR GitLab. Link dạng `http://localhost:4747/#VLEARN-123`; nút ⤢ để mở toàn màn hình.
- **Copy cho AI**: nút copy trên từng task, trong trang chi tiết (kèm mô tả, bình luận, MR, task con) và cho cả danh sách — Markdown có link Jira/Confluence để AI (vd. Claude với Atlassian MCP) đọc tiếp.
- **Thông báo** (chuông): thay đổi và bình luận của người khác trên task bạn làm, tạo hoặc theo dõi trong 7 ngày; đánh dấu khi được @mention. Jira không mở API cho chuông thông báo gốc nên đây là bản dựng lại từ changelog/bình luận.
- **Tài liệu**: mọi trang Confluence được link + file đính kèm Jira.
- Phím tắt: `/` tìm kiếm, `R` tải lại, `Esc` đóng. Tự tải lại mỗi 5 phút.

## Bảo mật

- Server chỉ nghe `127.0.0.1`; token không bao giờ gửi xuống trình duyệt.
- Request ghi cần header `X-Dashboard` và server kiểm tra `Host` (chặn CSRF / DNS rebinding). Đăng nhập OAuth dùng PKCE + `state`.
- Mô tả/bình luận từ Jira hiển thị trong iframe sandbox (không chạy script).
