# App Kiểm Kê Hàng Hóa

## Tech Stack
- **Frontend**: React PWA (Vercel)
- **Database**: Supabase (PostgreSQL + Realtime + Auth)  (Pass: 2MBxALRUT6G0WuND)
- **Offline**: IndexedDB via Dexie.js
- **Export**: Google Apps Script → Google Sheets
- **QR Scan**: html5-qrcode

---

## Cấu trúc project

```
kiem-ke-app/
├── src/
│   ├── lib/
│   │   ├── supabase.js     ← Supabase client
│   │   ├── db.js           ← IndexedDB (Dexie) — offline storage
│   │   └── sync.js         ← Sync engine: offline → Supabase → Sheet
│   ├── screens/
│   │   ├── Login.jsx
│   │   ├── BatDauPhien.jsx ← Màn hình tạo phiên kiểm kê
│   │   ├── KiemKe.jsx      ← Form nhập kiểm kê (2 chế độ)
│   │   ├── DemLai.jsx      ← Đối chiếu đếm lại / đếm nhầm
│   │   └── Admin.jsx       ← Dashboard admin
│   ├── components/
│   │   └── ChonVatTu.jsx   ← QR scan + gợi ý + search
│   ├── App.jsx
│   └── App.css
├── gas/
│   └── Code.gs             ← Google Apps Script → ghi vào Sheet
├── supabase/
│   └── schema.sql          ← Toàn bộ schema DB
└── package.json
```

---

## Setup từng bước

### 1. Supabase

1. Tạo project tại https://supabase.com
2. Vào **SQL Editor** → chạy file `supabase/schema.sql`
3. Vào **Database → Replication** → enable realtime cho:
   - `kiem_ke_chitiet`
   - `phien_kiem_ke`
4. Lấy `Project URL` và `anon public key` từ **Settings → API**

### 2. Google Apps Script

1. Mở Google Sheet của bạn
2. **Extensions → Apps Script** → paste nội dung `gas/Code.gs`
3. Điền `SHEET_ID`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
4. **Deploy → New deployment → Web App**
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Copy URL deployment

### 3. Environment variables

Tạo file `.env` ở root:

```
REACT_APP_SUPABASE_URL=https://xxxx.supabase.co
REACT_APP_SUPABASE_ANON_KEY=eyJhbGc...
REACT_APP_GAS_URL=https://script.google.com/macros/s/xxx/exec
```

### 4. Chạy local

```bash
npm install
npm start
```

### 5. Deploy lên Vercel

```bash
npm run build
# Push lên GitHub → import vào Vercel
# Thêm environment variables trong Vercel dashboard
```

---

## Nhập dữ liệu ban đầu vào Supabase

Chạy SQL sau trong Supabase SQL Editor:

```sql
-- Kho
insert into dm_kho (ma_kho, ten_kho) values
  ('KHO_A', 'Kho Thành phẩm A'),
  ('KHO_B', 'Kho Nguyên liệu B');

-- ĐVT
insert into dm_dvt (ma_dvt, ten_dvt) values
  ('KG', 'Kg'), ('THUNG', 'Thùng'), ('GOI', 'Gói'), ('CAI', 'Cái');

-- User (tạo trong Supabase Auth trước, lấy UUID)
insert into dm_user (id, ma_user, ho_ten, role, email) values
  ('uuid-1', 'KT01', 'Nguyễn Thị Lan', 'ke_toan', 'lan@company.com'),
  ('uuid-2', 'TK01', 'Trần Văn Minh', 'thu_kho', 'minh@company.com'),
  ('uuid-3', 'AD01', 'Admin', 'admin', 'admin@company.com');
```

---

## Flow hoạt động

```
1. Kế toán mở app → chọn Kho + Thủ kho + Ngày → Bắt đầu phiên
2. Nhập từng dòng kiểm kê (QR / gợi ý / search)
   - Offline → lưu IndexedDB → badge "chờ sync"
   - Online → tự push lên Supabase
3. Thủ kho thấy dữ liệu realtime (Supabase Realtime)
4. Đếm lại: tick từng dòng để đối chiếu
5. Hoàn tất → Export lên Google Sheet (gọi GAS)
```

---

## QR Code cho vật tư

Mỗi QR code chỉ chứa **mã vật tư** (ví dụ: `VT012`).

Tạo QR bằng bất kỳ tool nào (Google Chart API, qrcode.js...) với value = mã vật tư.
