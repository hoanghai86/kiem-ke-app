# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install        # install dependencies
npm start          # dev server (localhost:3000)
npm run build      # production build
npm test           # run tests (Jest via react-scripts)
```

## Environment variables

Create `.env` at root:

```
REACT_APP_SUPABASE_URL=https://xxxx.supabase.co
REACT_APP_SUPABASE_ANON_KEY=eyJhbGc...
REACT_APP_GAS_URL=https://script.google.com/macros/s/xxx/exec
```

## Architecture

This is a React PWA (Create React App) for warehouse inventory counting. It supports two users working simultaneously — a kế toán (accountant) and thủ kho (storekeeper) — and works fully offline.

### Data layers

- **Supabase** (`src/lib/supabase.js`) — PostgreSQL + Auth + Realtime. Source of truth.
- **IndexedDB via Dexie** (`src/lib/db.js`) — local offline store. Every write goes here first. Tables mirror Supabase but are named differently: `phien` (local) ↔ `phien_kiem_ke` (Supabase), `chitiet` (local) ↔ `kiem_ke_chitiet` (Supabase).
- **sync_queue** — a Dexie table that queues offline writes. `pushOfflineQueue()` in `src/lib/sync.js` drains it to Supabase when online. The `window.online` event also triggers a drain + `pullDanhMuc()`.

### Sync engine (`src/lib/sync.js`)

Three functions cover all sync scenarios:
- `pullDanhMuc()` — bulk-replaces all reference tables (kho, user, dvt, vat_tu, ton_kho, goi_y) from Supabase into IndexedDB.
- `pushOfflineQueue()` — iterates `sync_queue`, upserts each record to Supabase, marks `synced: true` on success.
- `syncToGoogleSheet(phien_id)` — POSTs to the GAS Web App URL, which reads from Supabase and writes a formatted tab + appends to the aggregate "Số liệu kiểm thực tế" sheet.

### Screen routing (`src/App.jsx`)

```
/login          → Login.jsx
/               → BatDauPhien.jsx  (create session — file not in repo, implied by imports)
/kiem-ke/:id    → KiemKe.jsx       (data entry — two modes)
/dem-lai/:id    → DemLai.jsx       (cross-check / recount)
/admin          → Admin.jsx        (admin only, role check)
```

### KiemKe two modes

`KiemKe.jsx` has two entry modes toggled by `CHE_DO`:
- `MOT_MA` — one item selected, repeated quantity entries (e.g. count same item across many locations).
- `NHIEU_MA` — one item per entry, quantity entered once.

Both modes call `saveChiTietLocal()` which computes `so_luong_quy_doi` and `chenh_lech` locally, writes to IndexedDB, then adds to `sync_queue`. The screen also subscribes to a Supabase Realtime channel for `kiem_ke_chitiet` inserts to show the other user's entries live.

### ChonVatTu component (`src/components/ChonVatTu.jsx`)

Reusable material selector with three input methods:
1. Text search against `dm_vat_tu` in IndexedDB (by `ma_vt` or `ten_vt`).
2. Recently-used dropdown from `goi_y_vat_tu` (sorted by `lan_kiem_gan_nhat`).
3. QR scan via `html5-qrcode` — decoded text must be a `ma_vt` that exists in IndexedDB.

### Google Apps Script (`gas/Code.gs`)

Deployed as a GAS Web App. Receives `POST { action: 'sync_phien', phien_id }`, fetches data from Supabase using the service role key, and writes to a Google Sheet. Fill in `SHEET_ID`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` at the top of the file before deploying.

### Database schema (`supabase/schema.sql`)

Key computed fields are handled by a Postgres trigger (`trg_calc_kiem_ke`) — `so_luong_quy_doi` and `chenh_lech` are recalculated on every insert/update to `kiem_ke_chitiet`. The app also computes these locally in `saveChiTietLocal()` so they display correctly while offline. RLS policies restrict non-admin users to phiên where they are `ke_toan_id` or `thu_kho_id`. Realtime must be enabled for `kiem_ke_chitiet` and `phien_kiem_ke` in the Supabase dashboard.

### User roles

Three roles enforced in both RLS and UI: `ke_toan`, `thu_kho`, `admin`. Admin-only route `/admin` is guarded in `App.jsx`. Users are created in Supabase Auth and then inserted into `dm_user` with the matching UUID.

## Language
Always respond in Vietnamese.

## Handover — 2026-07-01

### DanhMuc.jsx — hoàn thành
- Accordion 4 tab (Kho / DVT / Vật tư / Tồn kho): đổi nút thành **Xem / Sửa / Xóa** (bỏ "Tạm ẩn")
- Chế độ **Xem**: hiển thị read-only label/value, ẩn toàn bộ input và checkbox "Đang hoạt động"
- Chế độ **Sửa**: giữ nguyên form, có checkbox "Đang hoạt động"

### BaoCao.jsx — tab Kiểm kê — hoàn thành
Bảng kết quả 6 cột (`tableLayout: fixed`, `width: 100%`):

| Cột | Header | colgroup width | Style data |
|-----|--------|---------------|-----------|
| 1 | Mã / Tên VT | 40% | 4 dòng: mã (12px bold #1d9e75) → tên (11px) → kho (10px muted) → meta (10px muted) |
| 2 | SL thực tế | 15% | 15px bold, center |
| 3 | ĐVT phụ | 6% | 10px muted, center |
| 4 | ×HS | 6% | 10px muted, center |
| 5 | SL quy đổi | 15% | 15px bold #1d9e75, center |
| 6 | ĐVT chính | 6% | 10px muted, center |

- Header: wrap tự nhiên (không `whiteSpace: nowrap`), canh giữa các cột số
- Mỗi mục **1 hàng duy nhất** — không dùng 2-row-per-item, không dùng `colSpan`
- Click hàng → accordion inline Xem / Sửa / Xóa
- `metaSub` = `[maPhien, row._nguoi_nhap, thoiGian].join(' · ')` (kho tách dòng riêng)
- **Không dùng** `maxWidth: 0` trên td (ẩn hết nội dung trong Chrome)

### MiniKiemKe.jsx — đã tích hợp
- Dùng trong `src/screens/BaoCao.jsx` tab **Thừa/Thiếu SS**
- Click vào 1 dòng thiếu → hiện form nhập kiểm kê nhanh cho vật tư đó
- File trước đây untracked, đã commit trong session này

## ⚠️ Nguyên tắc bắt buộc — Offline-first

App được dùng **ở nơi không có mạng internet** (kho hàng thực địa). Mọi thao tác lúc kiểm kê (tìm vật tư, nhập số liệu) PHẢI chạy 100% từ IndexedDB cục bộ (`vatTuSearch.js`, `ChonVatTu.jsx`, `KiemKe.jsx`, `MiniKiemKe.jsx`) — không được đổi sang tìm kiếm real-time qua Supabase kiểu Google search. `pullDanhMuc()` phải luôn tải **toàn bộ** danh mục (không phân trang/giới hạn) trước khi cho vào app dùng — chấp nhận loading lâu, không đánh đổi bằng dữ liệu thiếu.

**Ngoại lệ duy nhất:** màn Admin → Danh mục (`DanhMuc.jsx`) — dùng cho admin ngồi văn phòng có mạng, không cần offline, ĐƯỢC PHÉP tìm kiếm phía server (xem lý do ở mục Handover bên dưới).

## Handover — 2026-07-02

Phiên làm việc dài, sửa nhiều bug thật (đã verify bằng Playwright, không đoán mò) ở `BaoCao.jsx`, `DanhMuc.jsx`, `lib/sync.js`, `App.jsx`, `Login.jsx`, `MiniKiemKe.jsx`, thêm mới `lib/authGuard.js`.

### 1. BaoCao.jsx — tab Thừa/Thiếu SS & So sánh KT/TK
- **Modal "Chi tiết vật tư"** mới: click 1 dòng → "Chi tiết" → modal full-screen layout 6 cột giống tab Kiểm kê, có phân trang (50 dòng/trang, luôn hiện thanh phân trang), Excel export, CRUD (Sửa/Xóa) từng dòng chi tiết — **có kiểm tra quyền**: chỉ được sửa/xóa dòng do chính mình (`nguoi_nhap_id`) nhập, kể cả khi mở từ trong modal này (bug cũ: ai cũng xóa được dòng của người khác, kể cả khác phiên).
- **Tab So sánh KT/TK**: nhóm lại theo **phiên + mã VT + kho** (1 dòng = 1 phiên, không gộp qua nhiều phiên nữa — vì 1 kế toán có thể đối chiếu nhiều thủ kho/phiên cùng lúc). Thêm cột ĐVT, hiện đủ 2 trạng thái **Khớp/Không khớp** (trước đây ẩn dòng khớp). Dòng gồm: mã/tên VT · trạng thái, kho · #mã phiên, KT/TK tên người.
- **"Xóa hết nhập lại"**: nếu mặt hàng có ở ≥2 phiên (thuộc user) → hỏi chọn phiên trước khi xóa; chỉ 1 phiên → xóa thẳng. Chỉ xóa dòng do **chính người bấm nút** nhập (không đụng số liệu người khác dù cùng phiên).
- **`openMiniKiemKe()`**: nếu mặt hàng đã có phiên cụ thể mà user không thuộc phiên đó → **chặn hẳn**, không fallback sang phiên khác (bug cũ gây lỗi Supabase RLS 403, dữ liệu kẹt vĩnh viễn trong `sync_queue`).
- **Filter "Loại dữ liệu"**: mặc định theo role đăng nhập (`getInitFilters(role)`) — thủ kho mặc định "Số liệu thủ kho", kế toán/admin mặc định "Số liệu kế toán".
- Nhiều modal full-screen dùng `zIndex: 300`+ để che đúng 2 nút Profile/Sync (App.jsx, `zIndex: 210`) — cẩn thận khi thêm modal mới trong `BaoCao.jsx`/`MiniKiemKe.jsx`, tránh lặp lại bug modal bị đè.

### 2. DanhMuc.jsx — tab Vật tư/Tồn kho (danh mục lớn, 40k+ dòng) không tải nổi
- **Nguyên nhân gốc**: `loadList()` tải HẾT 40k+ dòng mỗi lần mở tab, cộng với `loadVatTuOptions()` (picker chọn vật tư) tải không giới hạn, cộng với `pullDanhMuc()` chạy song song — 3 vòng lặp fetch cùng lúc → quá tải mạng, sai cả số đếm hiển thị (race condition).
- **Đã sửa**: `vat_tu`/`ton_kho` đổi sang tải **theo trang + tìm kiếm phía server** (debounce 1s). `kho`/`dvt` (nhỏ) giữ nguyên tải hết. Export/Xóa-theo-bộ-lọc/Xóa-đã-chọn viết lại để lấy đủ dữ liệu từ server khi cần (không dựa vào `list` chỉ có 1 trang).
- Tìm kiếm phía server dùng Postgres `ilike` — **không bỏ dấu tiếng Việt tự động** như tìm kiếm cũ (khác với `ChonVatTu`/`vatTuSearch.js` bên màn kiểm kê, vẫn bỏ dấu bình thường).

### 3. lib/sync.js — `pullDanhMuc()` chạy chồng, dữ liệu rác
- **Chạy chồng**: 4+ nơi độc lập gọi `pullDanhMuc()` gần như cùng lúc (App.jsx lúc khởi động + lúc auth đổi, Login.jsx, SyncButton) → `clear()`/`bulkPut()` giẫm nhau → dữ liệu sai/thiếu trong IndexedDB. Đã thêm khóa `_pulling` chống chạy chồng — gọi chồng dùng chung 1 promise.
- **Đăng xuất giữa lúc đồng bộ dở dang**: phiên bị hủy, vòng lặp phân trang tưởng nhầm hết dữ liệu, ghi dữ liệu thiếu vào cache. Đã thêm kiểm tra `supabase.auth.getSession()` trước khi commit ghi IndexedDB — không còn session thì hủy, không ghi.
- **`fetchAllVatTu()`**: đổi từ tải tuần tự (43 trang × ~0.5s ≈ 21s) sang tải theo lô 8 trang song song (đếm tổng trước, rồi `Promise.all()` từng lô) — nhanh hơn nhiều lần, vẫn tải đủ 100% dữ liệu.
- `pullDanhMuc(onProgress)` giờ nhận callback `(loaded, total)` để UI vẽ progress bar thật (dùng ở Login.jsx).

### 4. App.jsx + Login.jsx + lib/authGuard.js (mới) — đăng xuất tự đăng nhập lại
- **Bug 1 (đã sửa)**: sự kiện auth "trễ" xử lý sau khi đăng xuất → đăng nhập nhầm lại. Fix bằng cờ chặn vô thời hạn (`authGuard.js`: `suppressAuthEvents()`/`allowAuthEvents()`/`isAuthEventsSuppressed()`) thay vì hẹn giờ cố định (hẹn giờ không đủ khi mạng chậm).
- **Bug 2 (nguyên nhân thật, đã sửa)**: `Login.jsx`'s `handleLogin()` là async chạy dài; nếu route đổi sang "/" (do `App.jsx`'s `onAuthStateChange` xong nhanh hơn) thì `Login` unmount nhưng `handleLogin()` **vẫn chạy tiếp ngầm** — nếu user đăng xuất giữa lúc đó, hàm vẫn chạy tới `onLogin(profile)` cuối cùng, set lại user cũ. Đã thêm check `isAuthEventsSuppressed()` ngay trước `onLogin(profile)`.
- **Bug 3 (đã sửa)**: `App.jsx`'s `onAuthStateChange` set `user` (cấp quyền vào app) **trước khi** chờ `pullDanhMuc()` xong — khiến màn loading ở Login.jsx vô nghĩa vì route đã đổi trước khi Login.jsx kịp tự chờ. Đã dời `setUser(profile)` xuống sau khi đồng bộ xong (chỉ áp dụng cho `onAuthStateChange`, KHÔNG áp dụng cho check session lúc khởi động app — trường hợp đó không cần chặn, dùng cache cũ được).
- **Login.jsx**: thêm progress bar thật (%) trong lúc đồng bộ, dựa trên callback `onProgress` của `pullDanhMuc()`.

### Lưu ý khi test/debug các bug loại này
- **Luôn tự test bằng Playwright trước khi báo kết quả** — đọc code suy luận không đủ, đặc biệt bug race condition/async (xem thêm memory `feedback_auto_test_before_reporting`).
- Test lặp lại đăng nhập nhiều lần trong thời gian ngắn **dễ khiến Supabase rate-limit** (auth + REST) — nếu thấy request treo lâu bất thường không kèm lỗi rõ ràng, nghi ngờ rate limit trước, nghỉ vài phút rồi test lại thay vì kết luận vội.
