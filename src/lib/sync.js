// src/lib/sync.js
// Sync engine: offline queue → Supabase → Google Sheet
import { supabase } from './supabase'
import {
  db,
  getPendingSyncQueue,
  removeSyncQueueItem
} from './db'

// -----------------------------------------------
// Pull danh mục từ Supabase xuống IndexedDB
// -----------------------------------------------
export async function pullDanhMuc() {
  try {
    const [kho, users, dvt, vatTu, tonKho, goiY] = await Promise.all([
      supabase.from('dm_kho').select('*').eq('active', true),
      supabase.from('dm_user').select('*').eq('active', true),
      supabase.from('dm_dvt').select('*').eq('active', true),
      supabase.from('dm_vat_tu').select('*').eq('active', true),
      supabase.from('ton_kho').select('*'),
      supabase.from('v_goi_y_vat_tu').select('*').limit(100)
    ])

    if (kho.error) throw new Error(`dm_kho: ${kho.error.message}`)
    if (users.error) throw new Error(`dm_user: ${users.error.message}`)
    if (dvt.error) throw new Error(`dm_dvt: ${dvt.error.message}`)
    if (vatTu.error) throw new Error(`dm_vat_tu: ${vatTu.error.message}`)
    if (tonKho.error) throw new Error(`ton_kho: ${tonKho.error.message}`)

    await db.transaction('rw',
      [db.dm_kho, db.dm_user, db.dm_dvt, db.dm_vat_tu, db.ton_kho, db.goi_y_vat_tu],
      async () => {
        if (kho.data)    { await db.dm_kho.clear();       await db.dm_kho.bulkPut(kho.data) }
        if (users.data)  { await db.dm_user.clear();      await db.dm_user.bulkPut(users.data) }
        if (dvt.data)    { await db.dm_dvt.clear();       await db.dm_dvt.bulkPut(dvt.data) }
        if (vatTu.data)  { await db.dm_vat_tu.clear();    await db.dm_vat_tu.bulkPut(vatTu.data) }
        if (tonKho.data) { await db.ton_kho.clear();      await db.ton_kho.bulkPut(tonKho.data) }
        if (goiY.data)   { await db.goi_y_vat_tu.clear(); await db.goi_y_vat_tu.bulkPut(goiY.data) }
      }
    )
    console.log('[Sync] Pull danh mục OK — kho:', kho.data?.length, 'vật tư:', vatTu.data?.length)
    return { ok: true }
  } catch (err) {
    console.error('[Sync] Pull danh mục lỗi:', err)
    return { ok: false, error: err.message }
  }
}

// -----------------------------------------------
// Push offline queue lên Supabase
// -----------------------------------------------
export async function pushOfflineQueue() {
  const queue = await getPendingSyncQueue()
  if (!queue.length) return

  for (const item of queue) {
    try {
      if (item.action === 'delete') {
        const tableMap = { phien: 'phien_kiem_ke', chitiet: 'kiem_ke_chitiet' }
        const supabaseTable = tableMap[item.table_name]
        if (supabaseTable) {
          const { error } = await supabase.from(supabaseTable).delete().eq('id', item.record_id)
          if (!error) await removeSyncQueueItem(item.id)
        }
        continue
      }

      if (item.table_name === 'phien') {
        const record = await db.phien.get(item.record_id)
        if (!record) { await removeSyncQueueItem(item.id); continue }

        const { error } = await supabase
          .from('phien_kiem_ke')
          .upsert(toSupabasePhien(record))

        if (!error) {
          await db.phien.update(item.record_id, { synced: true })
          await removeSyncQueueItem(item.id)
        }
      }

      if (item.table_name === 'chitiet') {
        const record = await db.chitiet.get(item.record_id)
        if (!record) { await removeSyncQueueItem(item.id); continue }

        const { error } = await supabase
          .from('kiem_ke_chitiet')
          .upsert(toSupabaseChiTiet(record))

        if (!error) {
          await db.chitiet.update(item.record_id, { synced: true })
          await removeSyncQueueItem(item.id)
        }
      }
    } catch (err) {
      console.error('[Sync] Push lỗi item:', item.id, err)
    }
  }

  console.log('[Sync] Push queue xong')
}

// -----------------------------------------------
// Trigger export sang Google Sheet (qua GAS)
// -----------------------------------------------
export async function syncToGoogleSheet(phien_id) {
  const GAS_URL = process.env.REACT_APP_GAS_URL
  if (!GAS_URL) return

  try {
    const res = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'sync_phien', phien_id })
    })
    const data = await res.json()
    if (data.status === 'ok') {
      await supabase
        .from('phien_kiem_ke')
        .update({ synced_to_sheet: true })
        .eq('id', phien_id)
    }
  } catch (err) {
    console.error('[Sync] Sheet sync lỗi:', err)
  }
}

// -----------------------------------------------
// Listen online event → tự push queue
// -----------------------------------------------
export function startSyncListener() {
  window.addEventListener('online', async () => {
    console.log('[Sync] Online — bắt đầu sync...')
    await pushOfflineQueue()
    await pullDanhMuc()
  })
}

// -----------------------------------------------
// Map local → Supabase format
// -----------------------------------------------
function toSupabasePhien(r) {
  return {
    id: r.id,
    ma_kho: r.ma_kho,
    ke_toan_id: r.ke_toan_id,
    thu_kho_id: r.thu_kho_id,
    ngay_kiem: r.ngay_kiem,
    trang_thai: r.trang_thai,
    ke_toan_xac_nhan: r.ke_toan_xac_nhan ?? false,
    thu_kho_xac_nhan: r.thu_kho_xac_nhan ?? false
  }
}

function toSupabaseChiTiet(r) {
  return {
    id: r.id,
    phien_id: r.phien_id,
    ma_vt: r.ma_vt,
    ten_vt: r.ten_vt,
    ma_dvt_kiem: r.ma_dvt_kiem,
    he_so_quy_doi: r.he_so_quy_doi,
    luot_kiem: r.luot_kiem,
    so_luong_thuc_te: r.so_luong_thuc_te,
    so_luong_so_sach: r.so_luong_so_sach,
    ghi_chu: r.ghi_chu,
    hinh_anh_urls: r.hinh_anh_urls,
    da_doi_chieu: r.da_doi_chieu,
    local_id: r.local_id,
    nguoi_nhap_id: r.nguoi_nhap_id ?? null
  }
}
