// src/lib/db.js
// IndexedDB via Dexie — lưu offline, sync lên Supabase khi có mạng
import Dexie from 'dexie'

export const db = new Dexie('KiemKeDB')

db.version(1).stores({
  dm_kho:    'ma_kho, ten_kho',
  dm_user:   'id, ma_user, role',
  dm_dvt:    'ma_dvt, ten_dvt',
  dm_vat_tu: 'ma_vt, ten_vt',
  ton_kho:   '[ma_vt+ma_kho], ma_kho',
  phien:     'id, ma_kho, ngay_kiem, synced',
  chitiet:   'id, phien_id, ma_vt, synced, created_at',
  goi_y_vat_tu: 'ma_vt, lan_kiem_gan_nhat',
  sync_queue: '++id, table_name, record_id, action, created_at'
})

// v2: thêm ma_kho index vào chitiet (kho giờ ghi ở từng dòng, không ở phiên)
db.version(2).stores({
  chitiet: 'id, phien_id, ma_vt, ma_kho, synced, created_at'
})

// -----------------------------------------------
// Helpers danh mục
// -----------------------------------------------
export async function getDanhMucVatTu() {
  return db.dm_vat_tu.filter(v => v.active !== false).toArray()
}

export async function getTonKhoByKho(ma_kho) {
  return db.ton_kho.where('ma_kho').equals(ma_kho).toArray()
}

export async function getSoSach(ma_vt, ma_kho) {
  const row = await db.ton_kho.get([ma_vt, ma_kho])
  return row?.so_luong_so_sach ?? null
}

// -----------------------------------------------
// Gợi ý vật tư (sort theo kiểm gần nhất, unique)
// -----------------------------------------------
export async function getGoiYVatTu(limit = 20) {
  const rows = await db.goi_y_vat_tu
    .orderBy('lan_kiem_gan_nhat')
    .reverse()
    .limit(limit)
    .toArray()
  return rows
}

export async function updateGoiYVatTu(ma_vt, ten_vt) {
  await db.goi_y_vat_tu.put({
    ma_vt,
    ten_vt,
    lan_kiem_gan_nhat: new Date().toISOString()
  })
}

// -----------------------------------------------
// Phiên kiểm kê
// -----------------------------------------------
export async function createPhienLocal(phien) {
  await db.phien.put({ ...phien, synced: false })
  await addToSyncQueue('phien', phien.id, 'insert')
}

export async function getPhienActive() {
  const all = await db.phien.filter(p => p.trang_thai === 'dang_kiem').toArray()
  return all[all.length - 1] || null
}

export async function updatePhienLocal(id, changes) {
  await db.phien.update(id, { ...changes, synced: false })
  await addToSyncQueue('phien', id, 'update')
}

export async function deletePhienLocal(id) {
  await db.chitiet.where('phien_id').equals(id).delete()
  await db.phien.delete(id)
  await addToSyncQueue('phien', id, 'delete')
}

// -----------------------------------------------
// Chi tiết kiểm kê
// -----------------------------------------------
export async function saveChiTietLocal(chitiet) {
  const id = chitiet.id || crypto.randomUUID()
  const so_luong_quy_doi = chitiet.so_luong_thuc_te * (chitiet.he_so_quy_doi || 1)
  const chenh_lech = so_luong_quy_doi - (chitiet.so_luong_so_sach || 0)

  const record = {
    ...chitiet,
    id,
    so_luong_quy_doi,
    chenh_lech,
    synced: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }

  await db.chitiet.put(record)
  await updateGoiYVatTu(chitiet.ma_vt, chitiet.ten_vt)
  await addToSyncQueue('chitiet', id, 'insert')
  return record
}

export async function getChiTietByPhien(phien_id) {
  const rows = await db.chitiet
    .where('phien_id').equals(phien_id)
    .sortBy('created_at')
  return rows.reverse()
}

export async function toggleDoiChieu(id, value) {
  await db.chitiet.update(id, { da_doi_chieu: value, synced: false })
  await addToSyncQueue('chitiet', id, 'update')
}

export async function updateChiTiet(id, changes) {
  const existing = await db.chitiet.get(id)
  if (!existing) return
  const soLuong = parseFloat(changes.so_luong_thuc_te ?? existing.so_luong_thuc_te)
  const heSo = parseFloat(changes.he_so_quy_doi ?? existing.he_so_quy_doi) || 1
  const soLuongQuyDoi = soLuong * heSo
  const chenhLech = soLuongQuyDoi - (existing.so_luong_so_sach || 0)
  const updated = {
    ...existing, ...changes,
    so_luong_quy_doi: soLuongQuyDoi,
    chenh_lech: chenhLech,
    synced: false,
    updated_at: new Date().toISOString()
  }
  await db.chitiet.put(updated)
  await addToSyncQueue('chitiet', id, 'update')
  return updated
}

export async function deleteChiTiet(id) {
  await db.chitiet.delete(id)
  await addToSyncQueue('chitiet', id, 'delete')
}

// -----------------------------------------------
// Sync queue
// -----------------------------------------------
async function addToSyncQueue(table_name, record_id, action) {
  await db.sync_queue.add({
    table_name,
    record_id,
    action,
    created_at: new Date().toISOString()
  })
}

export async function getPendingSyncQueue() {
  return db.sync_queue.toArray()
}

export async function removeSyncQueueItem(id) {
  await db.sync_queue.delete(id)
}

export async function clearSyncQueue() {
  await db.sync_queue.clear()
}
