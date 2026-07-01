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

### MiniKiemKe.jsx — chưa tích hợp
- File `src/components/MiniKiemKe.jsx` đã commit nhưng chưa được import/dùng ở đâu
- Cần hỏi người dùng muốn dùng component này ở màn hình nào trước khi tích hợp
