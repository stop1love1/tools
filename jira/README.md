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

## Cấu hình

Bấm nút ⚙ (Settings) trên header. Trang này sửa `config.json` (đã gitignore): Jira (site, JQL mặc định, bộ lọc lưu sẵn, field story point / sprint, auto refresh…), editor, git flow (thư mục repo, danh sách repo, project key, tên nhánh uat / develop / main, loại nhánh, số ngày tra commit / MR, checklist MR) và server. Đa số áp dụng ngay; mục có nhãn *needs restart* cần chạy lại `npm start`. `.env` vẫn dùng được làm giá trị mặc định (xem `.env.example`).

## MCP cho Claude Code / Cursor

Cùng server, cùng port: `http://localhost:4747/mcp` (streamable HTTP). Không phải chạy thêm gì.

```bash
claude mcp add --transport http --scope user jira-dashboard http://localhost:4747/mcp
```

Cursor (`~/.cursor/mcp.json`): `{ "mcpServers": { "jira-dashboard": { "url": "http://localhost:4747/mcp" } } }`

- Tool đọc: `list_issues`, `get_issue` (mô tả, comment, Confluence, MR), `list_transitions`, `get_notifications`, `git_overview`, `git_flow`, `git_epic`, `git_branches`, `get_git_job`.
- Tool ghi (tắt mặc định, bật ở Settings → MCP → *Allow write tools*): `transition_issue`, `run_git_action` (các bước git flow giống nút trên dashboard).
- Chỉ nhận request từ máy này (`127.0.0.1`, kiểm tra `Host` và `Origin`). Tắt hẳn: Settings → MCP → *Serve MCP at /mcp*.

## Start with Claude

Nút Claude ở cột cuối mỗi dòng (và nút **Claude** trong chi tiết task) mở dialog chọn: **Implement & open MR** hoặc **Plan only**, repo, MR cần mở (task → epic, epic → uat, develop), draft MR, tự đổi status Jira, ghi chú. Bấm **Start**: như trước — copy nội dung vào clipboard và mở tab Claude Code trong Cursor — nhưng nội dung giờ là hướng dẫn đầy đủ theo các lựa chọn (đọc ticket + Confluence + git flow qua MCP `jira-dashboard`, quy tắc branch / commit / MR của team) kèm bản chụp ticket.

- Bật Settings → MCP → *Allow write tools* để Claude dùng các bước git của dashboard (có backup) và `create_merge_request` (MR theo mẫu, trả về link). Khi tắt, Claude tự làm bằng git / glab theo cùng quy tắc.
- Hướng dẫn thêm cho mọi prompt: Settings → Start with Claude.

## Cấu trúc code

- `server.js`: khởi động + router HTTP.
- `lib/`: `config` (schema + lưu `config.json`), `auth` (OAuth / token Claude Code), `mcp` (client Atlassian MCP), `issues`, `confluence`, `notifications`, `users`, `editor`, `mcp-server` (endpoint `/mcp`), `prompt` (prompt của Start with Claude), `util`.
- `lib/git/`: `settings` (tên nhánh, regex từ config), `exec` (plumbing git), `read` (flow / epic / workspace), `mrs` (GitLab qua glab), `merge-requests` (tạo MR theo mẫu), `jobs`, `actions` (các bước), `index` (route `/api/git/*`).
- `public/js/`: script thường (không bundler), nạp theo thứ tự trong `index.html`; `core.js` trước, `app.js` cuối. `public/js/git/`: UI git flow. `public/css/`: style theo từng phần.

## Có gì

- **Cần xử lý gấp** ở đầu trang: quá hạn, hạn ≤ 3 ngày, ưu tiên High trở lên, nhãn hotfix/urgent. Danh sách cũng xếp theo độ gấp.
- **Thanh tiến trình**: hoàn thành / đang làm / chưa làm trên tổng (task huỷ không tính).
- **Danh sách** nhóm theo parent — bấm dòng parent để thu gọn/mở rộng. Đổi trạng thái bằng nút trạng thái (theo workflow Jira).
- **Chi tiết task** ngay trong dashboard (bấm key/dòng): mô tả, bình luận, task con, tài liệu Confluence (cả kế thừa từ parent), MR GitLab. Link dạng `http://localhost:4747/#VLEARN-123`; nút ⤢ để mở toàn màn hình.
- **Copy cho AI**: nút copy trên từng task, trong trang chi tiết (kèm mô tả, bình luận, MR, task con) và cho cả danh sách — Markdown có link Jira/Confluence để AI (vd. Claude với Atlassian MCP) đọc tiếp.
- **Thông báo** (chuông): thay đổi và bình luận của người khác trên task bạn làm, tạo hoặc theo dõi trong 7 ngày; đánh dấu khi được @mention. Jira không mở API cho chuông thông báo gốc nên đây là bản dựng lại từ changelog/bình luận.
- **Tài liệu**: mọi trang Confluence được link + file đính kèm Jira.
- Phím tắt: `/` tìm kiếm, `R` tải lại, `1`–`9` đổi bộ lọc, `Esc` đóng. Tự tải lại theo chu kỳ trong Settings (mặc định 5 phút).

## Git flow (các repo trong Settings, mặc định lms backend + frontend)

Quản lý nhánh / commit / cherry-pick theo đúng flow trong `lms/.cursor/rules/git-workflow.mdc`, ngay trong dashboard:

- **Khối "Git flow" trong chi tiết task**: từng bước epic → nhánh task `-uat` → commit / rebase lên epic / push → MR task → epic → MR epic → uat (chỉ 1) → cherry-pick sang `-develop` → MR → develop, riêng cho Backend và Frontend. Mỗi bước hiện trạng thái và nút cho việc tiếp theo. Epic lấy theo Epic cha trên Jira (bấm chip `epic/…` để đổi); nếu commit của ticket nằm ở epic khác, dashboard gợi ý.
- **Tab Git** (icon nhánh trên header): trạng thái 2 repo + commit/push/fetch, ticket đang có nhánh, dọn nhánh local (`backup/*`, đã mất trên origin, đã vào uat, tên sai chuẩn), log các job gần đây.
- **MR**: mở trang "New merge request" của GitLab đã điền sẵn source/target/title/description theo mẫu — không cần `glab` hay API token.
- **An toàn**:
  - Thao tác trên nhánh không được checkout thì chạy trong worktree tạm `~/Documents/lms-worktrees/dash-<repo>` → không đụng code đang làm dở. Xong job worktree tạm tự nhả nhánh.
  - Trước khi rebase / cherry-pick / reset / xoá nhánh, tip được lưu vào `refs/dash-backup/<nhánh>/<thời gian>` (thay cho việc tự tạo `backup/*`). Nút **Undo** đưa nhánh về bản backup gần nhất; nhánh đã xoá khôi phục bằng `git branch <tên> refs/dash-backup/<tên>/<thời gian>`.
  - Conflict được giữ nguyên để sửa trong Cursor, rồi **Continue / Skip / Abort** từ dashboard. Continue từ chối nếu file còn conflict marker.
  - Force-push luôn dùng `--force-with-lease`; không bao giờ push thẳng vào `uat` / `develop` / `release/*`. Mỗi lúc chỉ chạy 1 job git.
- Commit chạy đủ hook của repo (lint-staged, typecheck, gitleaks…); `VSF_APP_TOKEN` được đọc từ `lms/dev.sh` nếu server không được chạy từ `dev.sh`.

## Bảo mật

- Server chỉ nghe `127.0.0.1`; token không bao giờ gửi xuống trình duyệt.
- Request ghi cần header `X-Dashboard` và server kiểm tra `Host` (chặn CSRF / DNS rebinding). Đăng nhập OAuth dùng PKCE + `state`.
- Mô tả/bình luận từ Jira hiển thị trong iframe sandbox (không chạy script).
