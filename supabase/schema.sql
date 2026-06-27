-- =============================================
-- SCHEMA: App Kiểm Kê Hàng Hóa
-- Database: Supabase (PostgreSQL)
-- =============================================

-- 1. DANH MỤC KHO
create table dm_kho (
  id uuid primary key default gen_random_uuid(),
  ma_kho text not null unique,
  ten_kho text not null,
  active boolean default true,
  created_at timestamptz default now()
);

-- 2. DANH MỤC USER
create table dm_user (
  id uuid primary key default gen_random_uuid(),
  ma_user text not null unique,
  ho_ten text not null,
  role text not null check (role in ('ke_toan', 'thu_kho', 'admin')),
  email text unique,
  active boolean default true,
  created_at timestamptz default now()
);

-- 3. DANH MỤC ĐƠN VỊ TÍNH
create table dm_dvt (
  id uuid primary key default gen_random_uuid(),
  ma_dvt text not null unique,
  ten_dvt text not null,
  active boolean default true
);

-- 4. DANH MỤC VẬT TƯ
create table dm_vat_tu (
  id uuid primary key default gen_random_uuid(),
  ma_vt text not null unique,
  ten_vt text not null,
  ma_dvt_chinh text references dm_dvt(ma_dvt),
  active boolean default true,
  created_at timestamptz default now()
);

-- 5. TỒN KHO (sổ sách)
create table ton_kho (
  id uuid primary key default gen_random_uuid(),
  ma_vt text not null references dm_vat_tu(ma_vt),
  ten_vt text not null,
  ma_kho text not null references dm_kho(ma_kho),
  ma_dvt text references dm_dvt(ma_dvt),
  so_luong_so_sach numeric(15,3) default 0,
  updated_at timestamptz default now(),
  unique(ma_vt, ma_kho)
);

-- 6. PHIÊN KIỂM KÊ
-- ma_kho nullable: một phiên có thể kiểm nhiều kho (kho được ghi ở từng dòng chitiet)
create table phien_kiem_ke (
  id uuid primary key default gen_random_uuid(),
  ma_kho text references dm_kho(ma_kho),            -- nullable, chỉ dùng cho dữ liệu cũ
  ke_toan_id uuid not null references dm_user(id),
  thu_kho_id uuid not null references dm_user(id),
  ngay_kiem date not null default current_date,
  trang_thai text default 'dang_kiem' check (trang_thai in ('dang_kiem', 'hoan_thanh')),
  synced_to_sheet boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 7. CHI TIẾT KIỂM KÊ
create table kiem_ke_chitiet (
  id uuid primary key default gen_random_uuid(),
  phien_id uuid not null references phien_kiem_ke(id) on delete cascade,
  ma_vt text not null references dm_vat_tu(ma_vt),
  ten_vt text not null,
  ma_kho text references dm_kho(ma_kho),  -- kho được kiểm tại dòng này
  ma_dvt_kiem text,                        -- dvt người kiểm chọn
  he_so_quy_doi numeric(10,4) default 1,   -- hệ số quy đổi sang dvt chính
  luot_kiem integer not null default 1,
  so_luong_thuc_te numeric(15,3) not null,
  so_luong_quy_doi numeric(15,3),          -- thực tế × hệ số
  so_luong_so_sach numeric(15,3),          -- auto-lookup từ ton_kho
  chenh_lech numeric(15,3),                -- quy đổi - sổ sách
  ghi_chu text,
  hinh_anh_urls text[],                    -- array link Google Drive
  da_doi_chieu boolean default false,      -- đã check trong màn đếm lại
  nguoi_nhap_id uuid references dm_user(id), -- người nhập dòng này
  local_id text,                           -- id tạm offline (uuid client)
  synced boolean default false,            -- đã sync lên Sheet chưa
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 8. SYNC LOG (audit trail)
create table sync_log (
  id uuid primary key default gen_random_uuid(),
  phien_id uuid references phien_kiem_ke(id),
  chitiet_id uuid references kiem_ke_chitiet(id),
  action text,                             -- 'insert', 'update', 'sheet_sync'
  status text,                             -- 'success', 'error'
  error_msg text,
  synced_at timestamptz default now()
);

-- =============================================
-- INDEXES
-- =============================================
create index idx_kiem_ke_phien on kiem_ke_chitiet(phien_id);
create index idx_kiem_ke_mavt on kiem_ke_chitiet(ma_vt);
create index idx_kiem_ke_created on kiem_ke_chitiet(created_at desc);
create index idx_ton_kho_mavt_makho on ton_kho(ma_vt, ma_kho);

-- =============================================
-- VIEW: Gợi ý vật tư (sort theo kiểm gần nhất, unique)
-- =============================================
create or replace view v_goi_y_vat_tu as
select distinct on (k.ma_vt)
  k.ma_vt,
  v.ten_vt,
  v.ma_dvt_chinh,
  k.created_at as lan_kiem_gan_nhat
from kiem_ke_chitiet k
join dm_vat_tu v on v.ma_vt = k.ma_vt
order by k.ma_vt, k.created_at desc;

-- =============================================
-- FUNCTION: Tự tính quy đổi & chênh lệch
-- =============================================
create or replace function calc_kiem_ke()
returns trigger as $$
begin
  new.so_luong_quy_doi := new.so_luong_thuc_te * new.he_so_quy_doi;
  new.chenh_lech := new.so_luong_quy_doi - coalesce(new.so_luong_so_sach, 0);
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

create trigger trg_calc_kiem_ke
before insert or update on kiem_ke_chitiet
for each row execute function calc_kiem_ke();

-- =============================================
-- RLS (Row Level Security)
-- =============================================
alter table phien_kiem_ke enable row level security;
alter table kiem_ke_chitiet enable row level security;

-- Admin thấy tất cả
create policy "admin_all" on phien_kiem_ke
  for all using (
    exists (select 1 from dm_user where id = auth.uid() and role = 'admin')
  );

create policy "admin_all_chitiet" on kiem_ke_chitiet
  for all using (
    exists (select 1 from dm_user where id = auth.uid() and role = 'admin')
  );

-- Kế toán/thủ kho chỉ thấy phiên của mình
create policy "user_own_phien" on phien_kiem_ke
  for all using (
    ke_toan_id = auth.uid() or thu_kho_id = auth.uid()
  );

create policy "user_own_chitiet" on kiem_ke_chitiet
  for all using (
    exists (
      select 1 from phien_kiem_ke p
      where p.id = phien_id
      and (p.ke_toan_id = auth.uid() or p.thu_kho_id = auth.uid())
    )
  );

-- =============================================
-- REALTIME: Enable cho các bảng cần sync 2 người
-- =============================================
-- Chạy trong Supabase Dashboard > Database > Replication
-- alter publication supabase_realtime add table kiem_ke_chitiet;
-- alter publication supabase_realtime add table phien_kiem_ke;

-- =============================================
-- MIGRATION: Xác nhận hoàn thành 2 phía
-- Chạy trong Supabase SQL Editor
-- =============================================
alter table phien_kiem_ke
  add column if not exists xac_nhan_ke_toan boolean default false,
  add column if not exists xac_nhan_thu_kho boolean default false;

-- =============================================
-- MIGRATION: Kho chuyển từ phiên xuống chitiet
-- Chạy trong Supabase SQL Editor
-- =============================================
alter table phien_kiem_ke
  alter column ma_kho drop not null;

alter table kiem_ke_chitiet
  add column if not exists ma_kho text references dm_kho(ma_kho);
