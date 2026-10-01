# Plan: thiết kế lại khối Git flow trong chi tiết task / story / epic

- Ngày: 2026-10-01
- Mockup (bấm thử được): https://claude.ai/artifact/L9yMHnL88HREo2DLHdzEGd — 4 màn: task có conflict, task chờ review (VLEARN-4546), task chưa bắt đầu, epic (VLEARN-4399).
- Phạm vi: chỉ UI phía trình duyệt (`public/js/git/flow.js`, `steps.js`, `epic.js`, CSS). API `/api/git/*` và `lib/git/` giữ nguyên.

## 1. Vấn đề hiện tại

1. Cùng một trạng thái hiện 3 lần: thanh mốc Code/Epic/UAT/Develop (`.gtrack`), các dòng UAT/Develop (`.gsum-lines`) và "All steps" (`flowSteps`, 7 bước). Nút bị lặp với nhãn khác nhau ("Rebase & push" / "Rebase & force-push", "Create MR → epic" / "New MR → epic", "Open MR !x" / "Open !x").
2. Thanh mốc vẽ flow thành một đường thẳng, trong khi sau epic flow tách thành 2 nhánh song song (UAT qua MR epic, Develop qua cherry-pick).
3. Mỗi repo có một card riêng xếp chồng, thường ở cùng một bước nên chiếm gấp đôi chỗ và khó so hai repo.
4. Không rõ "việc tiếp theo là gì": headline mang tính thông tin ("On the epic"), cảnh báo kỹ thuật nằm ở chỗ nổi nhất, còn việc cần làm thì rải rác. Cuối card có 5 phần `<details>` (nhánh, cảnh báo, All steps, MR lỗi, "+ Start in…").
5. Màn epic có bố cục khác hẳn màn task. Nút rebase epic chỉ là một icon đỏ. Tab "Needs pick (0)" bị disable vẫn hiện.

## 2. Design mới (tóm tắt)

Thứ tự trong khối, từ trên xuống:

1. **Header**: `GIT · <KEY>` · chip `into epic/<EPIC> ✎` (đổi epic như `editEpic` hiện tại) · nút reload.
2. **Next**: danh sách việc cần làm, gộp cả 2 repo. Mỗi việc có tag repo, tiêu đề, một dòng giải thích, **một nút chính** và tối đa 1–2 nút phụ.
   - Thứ tự: thao tác đang dừng giữa chừng (`r.conflicts`) → `warn` → `todo` → `wait`.
   - Không còn `warn`/`todo`: header đổi thành "NOTHING FOR YOU · WAITING ON N" (màu xám) và chỉ còn link MR.
   - Mọi thứ đã xong: "Done — in uat and develop".
3. **Bảng trạng thái**: hàng = giai đoạn, cột = repo.
   - Hàng: `Branch` (gộp 1 ô nếu 2 repo cùng tên nhánh), `Code`, `→ Epic`, *(dòng chia: "After the epic: two separate tracks")*, `→ UAT`, `→ Develop`.
   - Mỗi ô: chấm trạng thái + 1 dòng chính + 1 dòng phụ. 5 trạng thái: `done` ✓ xanh lá, `todo` vòng xanh dương (tới lượt bạn), `warn` ! cam (cần sửa), `wait` vòng nét đứt (chờ người khác), `na` xám (chưa tới). Có chú thích ngay dưới bảng.
   - Chỉ có 1 repo được dùng thì chỉ hiện 1 cột; repo còn lại hiện link "+ Start in Frontend" ở footer.
4. **Panel chi tiết**: bấm vào ô nào thì mở panel của ô đó ngay dưới bảng (mỗi lúc một panel, bấm lại để đóng). Panel thay cho "All steps":
   - Tiêu đề `<Repo> · into <stage>`, dòng `source → target`.
   - Các bước con có chấm trạng thái và chip (MR, conflict + tên file, comment, behind…).
   - Danh sách commit có checkbox khi cần (push, cherry-pick).
   - Nút chính + nút phụ.
   - "Other options": thao tác ít dùng hoặc nguy hiểm, nhãn đầy đủ (Undo, Cherry-pick → epic khi không có quyền merge, Rebase epic onto uat…, Force-push).
   - Mặc định mở ô có việc ưu tiên nhất (theo thứ tự của Next). Không có việc nào thì đóng.
5. **Footer** một dòng: `N branches` (bấm để mở panel danh sách nhánh = `branchList` hiện tại) · `N flow warnings` (mở panel `flowChecks`) · `Fetched X ago` · `Fetch now` · trạng thái MR (GitLab / unavailable + Retry).

Màn **epic** dùng cùng kiểu:

- **Header**: `GIT · EPIC` + tên nhánh (copy) + reload.
- **Next**: ticket còn commit chưa pick (nút `Cherry-pick N → develop`, `Choose commits`), MR epic → uat (draft / conflict / chưa tạo).
- **Bảng** hàng `→ UAT` (MR !x, số commit đang chờ, behind uat) và `→ Develop` (x / y commit + thanh tiến độ) × cột repo.
- **Bảng ticket**: hàng = ticket (gộp cả 2 repo), cột BE | FE: `✓ 8 / 8`, nút `Pick N`, hoặc `—`. Bộ lọc `Needs pick (n) | All (n)`; ẩn `Needs pick` khi n = 0 và mặc định chọn All. Bấm vào hàng thì mở ra: nhánh `-develop` đích (+ change), commit có checkbox, nút `Cherry-pick N → develop` (cho repo đang có việc; cả 2 repo có việc thì mỗi repo một khối).
- **Footer**: số ticket vào epic không qua task MR · fetch · `Rebase epic onto uat… (only if its MR conflicts)` (link đỏ, vẫn hỏi xác nhận như `rebaseEpicBtn`).

## 3. Kiến trúc code

### 3.1 Một nguồn dữ liệu cho mọi chỗ hiển thị

Thay `repoStatus` + `flowSteps` bằng một hàm thuần:

```js
// → { branch, cells: { code, epic, uat, dev }, next: [...] }
function stageModel(issue, f, r, M)
// cell = { state: 'done'|'todo'|'warn'|'wait'|'na', text, sub,
//          detail: { title, where, steps:[{state,text,chips}], commits?, primary?, secondary:[], more:[], note? } }
// next item = { repo, state, title, detail, primary, secondary, cell: 'be-epic' }
```

- Bảng, panel chi tiết và Next đều đọc từ `stageModel`, nên mỗi nút chỉ được định nghĩa ở **một** chỗ (trong `cell.detail`). Next tái dùng `primary` của cell tương ứng.
- Gom nhãn nút về một bộ: `Push`, `Force-push`, `Rebase & push`, `Create MR → epic|uat|develop`, `Open MR !x`, `Cherry-pick N → develop|epic`, `Undo`.
- `next` = `[...conflictsInProgress, ...cells có warn, ...todo, ...wait]`. Sắp xếp backend trước frontend nếu cùng hạng.

### 3.2 Map trạng thái từ dữ liệu hiện có

Map này giữ nguyên logic của `repoStatus` / `flowSteps`; chỉ đổi cách trình bày.

| Ô | Điều kiện (theo thứ tự) | state | text / sub |
|---|---|---|---|
| Code | không có `uat` và có commits | warn | "N commits, no task branch" → Start… |
| | không có `uat` | todo | "No branch" → Start… |
| | `r.current === uat.name && r.dirty` | todo | "N uncommitted" → Commit… |
| | chưa có commit | todo | "No commits yet" → Checkout (nếu chưa checkout) |
| | `!uat.remote \|\| sync.onlyA` | todo | "N to push" → Push |
| | `sync.onlyB` (lệch origin) | warn | "Diverged from origin" → Force-push |
| | còn lại | done | "N commits" / "pushed" |
| → Epic | `conflictOf(openMr, uat.conflictEpic)` | warn | "Conflict" / "MR !x · N files" → Rebase & push |
| | Code chưa xong | na | "after Push" |
| | `!inEpic && uat.behindEpic` | todo | "Epic moved on" → Rebase & push |
| | `!inEpic`, có MR mở chưa resolved | warn | "MR !x · unresolved threads" → Open MR |
| | `!inEpic`, có MR mở | wait | "MR !x · in review / waiting" → Open MR |
| | `!inEpic`, chưa có MR | todo | "No MR yet" → Create MR → epic; more: Cherry-pick → epic |
| | `onEpicWithoutMerge && !mergedToEpic` | done | "On the epic" / "no task MR" (+ note không revert được) |
| | `mergedToEpic` | done | "Merged" / sha |
| → UAT | chưa vào epic | na | "after the epic" |
| | `inUat` | done | "In uat" |
| | `conflictOf(epicMr, epic.conflictUat)` | warn | "Epic MR conflicts" → more: Rebase epic onto uat… |
| | có MR epic mở | wait | "Epic MR !x" / draft · status |
| | `epic.pending` và chưa có MR | todo | "No epic MR" → Create MR → uat |
| → Develop | chưa vào epic | na | "after the epic" (xem câu hỏi mở 1) |
| | `inDev` | done | "In develop" |
| | còn commit chưa pick (`missing`) | todo | "x / y picked" → Cherry-pick N → develop (panel có checkbox + ô tên nhánh) |
| | đã pick, chưa push | todo | "Picked · not pushed" → Push |
| | MR develop conflict | warn | "Conflict" → Rebase onto develop |
| | có MR mở | wait | "MR !x" / status |
| | chưa có MR | todo | "No MR yet" → Create MR → develop |

Các thứ đi kèm cell:

- Chip MR (`mrFacts`, `conflictChip`) nằm trong `detail.steps`.
- `undo(b)` khi `b.backups` có → `more`.
- `r.conflicts` (rebase / cherry-pick đang dừng) hiện thành item đầu của Next, với nút `conflictActions` như hiện tại.

### 3.3 File cần sửa

- `public/js/git/flow.js`:
  - Viết lại `fillFlow`; bỏ `repoCard2` và `repoStatus`.
  - Thêm `stageModel`, `nextBlock`, `stageMatrix`, `stageDetail`, `flowFooter`.
  - Giữ `gitFlowBlock`, `startPanel` (đổi sang dạng khối Next có checkbox chọn repo), `branchList` (chuyển vào panel), `mrUnavailable` (vào footer).
- `public/js/git/steps.js`: bỏ `flowSteps`, phần chi tiết chuyển vào `stageModel`. Giữ `flowChecks` (vào panel "warnings").
- `public/js/git/epic.js`:
  - Viết lại `fillEpic` / `epicCard` thành một khối chung cho mọi repo: Next + bảng + bảng ticket gộp.
  - `epicTickets` chạy cho từng repo rồi merge theo `ticket.key`.
  - `ticketRow` thành hàng 2 cột repo.
- `public/js/git/core.js`:
  - Thêm state UI `gitState.sel` (ô đang mở theo `issue.key`, chỉ trong bộ nhớ).
  - Bỏ key LS `gitAllSteps`; `epicFilter:<repo>` thành `epicFilter`.
- `public/css/git-summary.css`:
  - Thay `.gsum*`, `.gtrack`, `.eline` bằng `.gnext`, `.gmatrix`, `.gcell[data-state]`, `.gdetail`, `.gfooter`, `.eticket-grid`.
  - Container query: drawer < 460px thì mỗi hàng của bảng xếp cột repo thành 2 dòng.
- `public/css/git-flow.css`: giữ `.gchip`, `.gcode`, `.gstep-act`, `.gstep-note`, `.gconflict` (workspace / dialogs còn dùng). Xoá `.gsteps` / `.gstep*` không còn ai dùng sau khi kiểm tra bằng grep.
- `README.md`: cập nhật đoạn "Khối Git flow trong chi tiết task".

## 4. Thứ tự làm

Mỗi bước để dashboard chạy được và kiểm tra được.

1. **`stageModel`** + test nhanh trên console với flow thật (VLEARN-4546, một ticket có conflict / chưa push) để so với kết quả `repoStatus` cũ.
2. **Bảng + panel chi tiết** thay cho `.gtrack` / `.gsum-lines` / All steps. Vẫn tạm giữ card theo repo để so.
3. **Khối Next** + gộp 2 repo vào một khối. Bỏ `repoCard2`.
4. **Footer** (nhánh, warnings, fetch, MR unavailable, + Start in…). Bỏ các `<details>` cũ.
5. **Màn chưa bắt đầu** (`startPanel` mới, bảng xám bên dưới để thấy trước flow).
6. **Màn epic** theo cùng kiểu.
7. Dọn CSS / hàm không còn dùng, cập nhật README.

## 5. Các trường hợp cần kiểm

- Repo lỗi (`r.error`): ô của repo đó hiện lỗi trải trên mọi hàng, repo còn lại vẫn bình thường.
- Chỉ 1 repo có việc → 1 cột; 0 repo → màn chưa bắt đầu.
- Ticket có nhiều nhánh / nhánh cũ không hậu tố `-uat` / nhánh đã ghim (`pinBranch`) → chip ở hàng Branch + panel nhánh.
- Commit nằm ở epic khác (`elsewhere` hint hiện tại) → item `warn` trong Next: "Commits are on epic/X, not epic/Y" + nút `Use epic/X`.
- GitLab không truy cập được (tắt VPN): ô dựa vào MR hiện `—` / theo git local; footer báo "MR status unavailable · Retry" + link MR từ Jira.
- MR state về sau (`getMrs` resolve) → redraw mà vẫn giữ ô đang mở.
- Đang có rebase / cherry-pick dừng ở conflict → Next đầu tiên: Open in Cursor / Continue / Skip / Abort.
- Drawer hẹp, chế độ toàn màn hình (⤢), dark mode (dùng token `--*`, không hard-code màu như mockup).

Kiểm tra trực quan: chụp headless như đã làm (`google-chrome --headless=new --window-size=1500,2400 --virtual-time-budget=25000 --screenshot=… "http://localhost:4747/#KEY"`) cho VLEARN-4546, VLEARN-4399 và một ticket chưa có nhánh.

## 6. Câu hỏi mở (đã chốt theo đề xuất, 2026-10-01)

Trạng thái: đã triển khai. `stageModel` nằm trong `steps.js` (thay cho `flowSteps`); `flow.js` chỉ còn phần vẽ. Khi GitLab không truy cập được, ô MR hiện "MR unknown" thay vì gợi ý tạo MR mới, và những ô này không đưa vào Next.

1. Cherry-pick sang develop có được làm **trước** khi task vào epic không? Hiện tại "All steps" cho làm bất cứ lúc nào, còn card tóm tắt chỉ hiện sau khi vào epic. Đề xuất: ô Develop để `na` cho tới khi vào epic, nhưng panel của ô vẫn có nút "Cherry-pick now" ở `more`.
2. Có giữ "All steps" cũ sau một cờ (Settings) trong giai đoạn chuyển tiếp không? Đề xuất: không, vì panel chi tiết đã đủ.
3. Ô đang mở có nhớ qua lần mở lại drawer không? Đề xuất: không (luôn mở ô ưu tiên nhất).
