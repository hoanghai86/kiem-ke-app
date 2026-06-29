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
async function fetchAllVatTu() {
  const PAGE = 1000
  let all = []
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('dm_vat_tu').select('*').eq('active', true)
      .range(from, from + PAGE - 1)
    if (error) return { data: null, error }
    all = all.concat(data)
    if (data.length < PAGE) break
    from += PAGE
  }
  return { data: all, error: null }
}

export async function pullDanhMuc() {
  try {
    const [kho, users, dvt, vatTu, tonKho, goiY] = await Promise.all([
      supabase.from('dm_kho').select('*').eq('active', true),
      supabase.from('dm_user').select('*').eq('active', true),
      supabase.from('dm_dvt').select('*').eq('active', true),
      fetchAllVatTu(),
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
        if (vatTu.data)  {
          // Giữ lại NSS items cục bộ trước khi xóa
          const nssLocal = await db.dm_vat_tu.filter(v => v.ngoai_so_sach === true).toArray()
          const officialCodes = new Set(vatTu.data.map(v => v.ma_vt))
          await db.dm_vat_tu.clear()
          await db.dm_vat_tu.bulkPut(vatTu.data)
          const nssToRestore = nssLocal.filter(v => !officialCodes.has(v.ma_vt))
          if (nssToRestore.length) await db.dm_vat_tu.bulkPut(nssToRestore)
        }
        if (tonKho.data) { await db.ton_kho.clear();      await db.ton_kho.bulkPut(tonKho.data) }
        if (goiY.data)   {
          const nssGoiY = await db.goi_y_vat_tu.filter(v => v.ngoai_so_sach === true).toArray()
          await db.goi_y_vat_tu.clear()
          await db.goi_y_vat_tu.bulkPut(goiY.data)
          if (nssGoiY.length) await db.goi_y_vat_tu.bulkPut(nssGoiY)
        }
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
let _pushing = false

export async function pushOfflineQueue() {
  if (_pushing) return { errors: 0 }  // đang chạy rồi, bỏ qua
  _pushing = true
  try {
    return await _doPush()
  } finally {
    _pushing = false
  }
}

async function _doPush() {
  const queue = await getPendingSyncQueue()
  if (!queue.length) return { errors: 0 }

  let errors = 0

  // Phase 1: phien upserts tuần tự (ít item, cần đảm bảo FK cha tồn tại trước)
  for (const item of queue.filter(i => i.table_name === 'phien' && i.action !== 'delete')) {
    try {
      const record = await db.phien.get(item.record_id)
      if (!record) { await removeSyncQueueItem(item.id); continue }
      const { error } = await supabase.from('phien_kiem_ke').upsert(toSupabasePhien(record))
      if (error) { console.error('[Sync] Lỗi upsert phien:', error.message); errors++ }
      else { await db.phien.update(item.record_id, { synced: true }); await removeSyncQueueItem(item.id) }
    } catch (e) { console.error('[Sync] Push phien lỗi:', e); errors++ }
  }

  // Phase 2: chitiet upserts song song (bulk của queue)
  const chitietItems = queue.filter(i => i.table_name === 'chitiet' && i.action !== 'delete')
  const chitietResults = await Promise.allSettled(chitietItems.map(async item => {
    const record = await db.chitiet.get(item.record_id)
    if (!record) { await removeSyncQueueItem(item.id); return }
    const { error } = await supabase.from('kiem_ke_chitiet').upsert(toSupabaseChiTiet(record))
    if (error) throw new Error(`chitiet ${item.record_id}: ${error.message}`)
    await db.chitiet.update(item.record_id, { synced: true })
    await removeSyncQueueItem(item.id)
  }))
  chitietResults.forEach(r => { if (r.status === 'rejected') { console.error('[Sync]', r.reason); errors++ } })

  // Phase 3: deletes song song
  const deleteItems = queue.filter(i => i.action === 'delete')
  const tableMap = { phien: 'phien_kiem_ke', chitiet: 'kiem_ke_chitiet' }
  await Promise.allSettled(deleteItems.map(async item => {
    const t = tableMap[item.table_name]
    if (!t) return
    const { error } = await supabase.from(t).delete().eq('id', item.record_id)
    if (error) { console.error('[Sync] Lỗi delete:', t, error.message); errors++ }
    else await removeSyncQueueItem(item.id)
  }))

  console.log(`[Sync] Push queue xong — lỗi: ${errors}`)
  return { errors }
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
// Realtime: nhận thay đổi tất cả danh mục
// -----------------------------------------------
let _danhMucChannel = null
export function subscribeVatTuRealtime() {
  if (_danhMucChannel) return () => {}
  _danhMucChannel = supabase
    .channel('danh_muc_changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'dm_vat_tu' }, async payload => {
      if (payload.eventType === 'DELETE') { if (payload.old?.ma_vt) await db.dm_vat_tu.delete(payload.old.ma_vt) }
      else await db.dm_vat_tu.put(payload.new)
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'dm_kho' }, async payload => {
      if (payload.eventType === 'DELETE') { if (payload.old?.ma_kho) await db.dm_kho.delete(payload.old.ma_kho) }
      else await db.dm_kho.put(payload.new)
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'dm_dvt' }, async payload => {
      if (payload.eventType === 'DELETE') { if (payload.old?.ma_dvt) await db.dm_dvt.delete(payload.old.ma_dvt) }
      else await db.dm_dvt.put(payload.new)
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'dm_user' }, async payload => {
      if (payload.eventType === 'DELETE') { if (payload.old?.id) await db.dm_user.delete(payload.old.id) }
      else await db.dm_user.put(payload.new)
    })
    .subscribe()
  return () => {
    if (_danhMucChannel) {
      supabase.removeChannel(_danhMucChannel)
      _danhMucChannel = null
    }
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
    ma_kho: r.ma_kho || null,
    ke_toan_id: r.ke_toan_id,
    thu_kho_id: r.thu_kho_id,
    ngay_kiem: r.ngay_kiem,
    trang_thai: r.trang_thai,
    xac_nhan_ke_toan: r.xac_nhan_ke_toan ?? false,
    xac_nhan_thu_kho: r.xac_nhan_thu_kho ?? false
  }
}

// Upsert 1 chitiet vừa nhập lên Supabase ngay lập tức (không drain toàn bộ queue)
export async function syncChiTietNow(record) {
  try {
    // Đảm bảo phiên cha đã có trên Supabase
    const phien = await db.phien.get(record.phien_id)
    if (phien && !phien.synced) {
      const { error: pe } = await supabase.from('phien_kiem_ke').upsert(toSupabasePhien(phien))
      if (pe) console.error('[Sync] syncChiTietNow — lỗi upsert phien:', pe.code, pe.message)
      else await db.phien.update(phien.id, { synced: true })
    }
    const payload = toSupabaseChiTiet(record)
    const { error } = await supabase.from('kiem_ke_chitiet').upsert(payload)
    if (!error) {
      await db.chitiet.update(record.id, { synced: true })
      await db.sync_queue.where('record_id').equals(record.id).delete()
      console.log('[Sync] syncChiTietNow OK — id:', record.id, 'ma_vt:', record.ma_vt)
    } else {
      console.error('[Sync] syncChiTietNow — lỗi upsert chitiet:', error.code, error.message, '\npayload:', JSON.stringify(payload))
    }
  } catch (e) {
    console.error('[Sync] syncChiTietNow lỗi:', e)
  }
}

function toSupabaseChiTiet(r) {
  return {
    id: r.id,
    phien_id: r.phien_id,
    ma_vt: r.ma_vt,
    ten_vt: r.ten_vt,
    ma_kho: r.ma_kho || null,
    ma_dvt_kiem: r.ma_dvt_kiem,
    he_so_quy_doi: r.he_so_quy_doi,
    luot_kiem: r.luot_kiem,
    so_luong_thuc_te: r.so_luong_thuc_te,
    so_luong_so_sach: r.so_luong_so_sach,
    ghi_chu: r.ghi_chu,
    hinh_anh_urls: r.hinh_anh_urls,
    da_doi_chieu: r.da_doi_chieu,
    local_id: r.local_id,
    nguoi_nhap_id: r.nguoi_nhap_id ?? null,
    ngoai_so_sach: r.ngoai_so_sach ?? false
  }
}
