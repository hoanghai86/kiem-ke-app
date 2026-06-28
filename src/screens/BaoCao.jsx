import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { db, updateChiTiet, deleteChiTiet, getSoSach } from '../lib/db'
import { pushOfflineQueue } from '../lib/sync'
import ChonVatTu from '../components/ChonVatTu'

const TABS = [
  { key: 'kiem_ke',       label: 'Kiểm kê' },
  { key: 'thua_thieu',    label: 'Thừa/Thiếu SS' },
  { key: 'so_sanh',       label: 'So sánh KT/TK' },
  { key: 'ton_kho',       label: 'Tồn kho SS' },
  { key: 'ngoai_so_sach', label: 'Ngoài SS' },
]

function buildCSVBlob(rows, cols, filename) {
  const header = cols.map(c => c.label).join(',')
  const body = rows.map((r, i) =>
    cols.map(c => {
      const v = String(c.get(r, i) ?? '')
      return v.includes(',') || v.includes('"') || v.includes('\n')
        ? `"${v.replace(/"/g, '""')}"` : v
    }).join(',')
  ).join('\n')
  const blob = new Blob(['﻿' + header + '\n' + body], { type: 'text/csv;charset=utf-8' })
  return { blob, file: new File([blob], filename, { type: 'text/csv' }) }
}

function exportCSV(rows, cols, filename) {
  const { blob } = buildCSVBlob(rows, cols, filename)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click()
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url) }, 1000)
}

async function shareCSV(rows, cols, filename) {
  const { file } = buildCSVBlob(rows, cols, filename)
  if (!navigator.share) { alert('Trình duyệt không hỗ trợ chia sẻ file'); return }
  try {
    await navigator.share({ files: [file], title: filename })
  } catch (err) {
    if (err.name !== 'AbortError') alert('Không chia sẻ được: ' + err.message)
  }
}

const getToday = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

const INIT_FILTERS = () => ({
  tuNgay: getToday(), denNgay: getToday(),
  loaiDuLieu: 'ke_toan',
  kho: [], phien: [], keToan: [], thuKho: [], vatTu: [],
})

export default function BaoCao({ currentUser }) {
  const [tab, setTab]             = useState('kiem_ke')
  const [f, setF]                 = useState(INIT_FILTERS)
  const [khoList, setKhoList]     = useState([])
  const [phienList, setPhienList] = useState([])
  const [userMap, setUserMap]     = useState({})
  const [dvtMap, setDvtMap]       = useState({})
  const [danhMucDvt, setDanhMucDvt] = useState([])
  const [vtDvtChinhMap, setVtDvtChinhMap] = useState({})
  const [vtNameMap, setVtNameMap]   = useState({})
  const [tonKhoRows, setTonKhoRows] = useState([])
  const [loadingTonKho, setLoadingTonKho] = useState(false)
  const [data, setData]           = useState([])
  const [loading, setLoading]     = useState(false)
  const [showFilters, setShowFilters] = useState(false)

  // Sub-screen edit state
  const [detailItem, setDetailItem] = useState(null)
  const [editMode, setEditMode]     = useState(false)
  const [form, setForm]             = useState({})
  const [saving, setSaving]         = useState(false)

  // Ngoài sổ sách
  const [nssItems, setNssItems]         = useState([])
  const [loadingNSS, setLoadingNSS]     = useState(false)
  const [reconcileItem, setReconcileItem] = useState(null)
  const [toastMsg, setToastMsg]         = useState(null)

  // Filter fullscreen modal
  const [filterModal, setFilterModal] = useState(null) // null | 'phien' | 'kho' | 'keToan' | 'thuKho'
  const [filterModalQ, setFilterModalQ] = useState('')
  const [filterModalSel, setFilterModalSel] = useState([])
  const filterModalRef = useRef(null)

  // Vật tư filter fullscreen modal
  const [openVatTuModal, setOpenVatTuModal] = useState(false)
  const [vatTuModalQ, setVatTuModalQ]       = useState('')
  const [vatTuModalSel, setVatTuModalSel]   = useState([])
  const [vatTuResults, setVatTuResults]     = useState([])
  const vatTuAllRef   = useRef([])
  const vatTuModalRef = useRef(null)

  const upd = (key, val) => setF(prev => ({ ...prev, [key]: val }))

  const colKiemKe = [
    { label: 'Stt',        get: (r, i) => i + 1 },
    { label: 'Mã VT',      get: r => r.ma_vt },
    { label: 'Tên VT',     get: r => r.ten_vt },
    { label: 'SL thực tế', get: r => r.so_luong_thuc_te },
    { label: 'ĐVT phụ',    get: r => r.ma_dvt_kiem || '' },
    { label: '× Hệ số',    get: r => r.he_so_quy_doi ?? 1 },
    { label: 'SL quy đổi', get: r => r.so_luong_quy_doi ?? '' },
    { label: 'ĐVT chính',  get: r => dvtMap[vtDvtChinhMap[r.ma_vt]] || vtDvtChinhMap[r.ma_vt] || '' },
    { label: 'Ghi chú',    get: r => r.ghi_chu || '' },
    { label: 'Kho',        get: r => r.dm_kho?.ten_kho || r.ma_kho || r.phien_kiem_ke?.dm_kho?.ten_kho || r.phien_kiem_ke?.ma_kho || '' },
    { label: 'Tên TK',     get: r => r._nguoi_nhap || '' },
    { label: 'Phiên',      get: r => r.phien_id ? '#' + r.phien_id.slice(-4).toUpperCase() : '' },
    { label: 'Thời gian',  get: r => r.created_at ? new Date(r.created_at).toLocaleString('vi-VN') : '' },
  ]

  const colTonKho = [
    { label: 'Stt',        get: (r, i) => i + 1 },
    { label: 'Mã VT',      get: r => r.ma_vt },
    { label: 'Tên VT',     get: r => vtNameMap[r.ma_vt] || '' },
    { label: 'ĐVT chính',  get: r => dvtMap[vtDvtChinhMap[r.ma_vt]] || vtDvtChinhMap[r.ma_vt] || '' },
    { label: 'SL sổ sách', get: r => r.so_luong_so_sach ?? '' },
    { label: 'Kho',        get: r => khoList.find(k => k.ma_kho === r.ma_kho)?.ten_kho || r.ma_kho || '' },
  ]

  const colThuaThieu = [
    { label: 'Stt',              get: (r, i) => i + 1 },
    { label: 'Mã VT',            get: r => r.ma_vt },
    { label: 'Tên vật tư',       get: r => r.ten_vt },
    { label: 'ĐVT chính',        get: r => dvtMap[vtDvtChinhMap[r.ma_vt]] || vtDvtChinhMap[r.ma_vt] || '' },
    { label: 'SL quy đổi',       get: r => r.so_luong_quy_doi ?? '' },
    { label: 'SL sổ sách',       get: r => r.so_luong_so_sach ?? '' },
    { label: 'Lệch KT-SS/TK-SS', get: r => r.chenh_lech ?? '' },
    { label: 'Ghi chú',          get: r => r.ghi_chu || '' },
  ]

  useEffect(() => {
    supabase.from('dm_kho').select('ma_kho,ten_kho').eq('active', true).order('ma_kho')
      .then(({ data }) => setKhoList(data || []))
    supabase.from('dm_user').select('id,ma_user,ho_ten,role').order('ho_ten')
      .then(({ data }) => {
        const map = {}
        ;(data || []).forEach(u => { map[u.id] = u })
        setUserMap(map)
      })
    supabase.from('dm_dvt').select('ma_dvt,ten_dvt')
      .then(({ data }) => {
        const map = {}
        ;(data || []).forEach(d => { map[d.ma_dvt] = d.ten_dvt })
        setDvtMap(map)
        setDanhMucDvt(data || [])
      })
    supabase.from('dm_vat_tu').select('ma_vt,ten_vt,ma_dvt_chinh').eq('active', true)
      .then(({ data }) => {
        const mapDvt = {}, mapName = {}
        ;(data || []).forEach(v => {
          if (v.ma_dvt_chinh) mapDvt[v.ma_vt] = v.ma_dvt_chinh
          mapName[v.ma_vt] = v.ten_vt || ''
        })
        setVtDvtChinhMap(mapDvt)
        setVtNameMap(mapName)
      })
  }, [])

  useEffect(() => {
    upd('phien', [])
    supabase.from('phien_kiem_ke')
      .select('id,ma_kho,ke_toan_id,thu_kho_id,ngay_kiem')
      .gte('ngay_kiem', f.tuNgay).lte('ngay_kiem', f.denNgay)
      .order('ngay_kiem', { ascending: false })
      .then(({ data }) => setPhienList(data || []))
  }, [f.tuNgay, f.denNgay])

  const loadData = useCallback(async () => {
    setLoading(true)
    setData([])
    try {
      let q = supabase
        .from('kiem_ke_chitiet')
        .select('id,phien_id,ma_vt,ten_vt,ma_kho,dm_kho(ten_kho),ma_dvt_kiem,he_so_quy_doi,so_luong_thuc_te,so_luong_quy_doi,so_luong_so_sach,chenh_lech,ghi_chu,created_at,nguoi_nhap_id,phien_kiem_ke!inner(id,ma_kho,ngay_kiem,ke_toan_id,thu_kho_id,xac_nhan_ke_toan,xac_nhan_thu_kho,dm_kho(ten_kho))')
        .order('created_at', { ascending: false })

      // Xây phien_id filter: kết hợp phiên chọn trực tiếp + filter kế toán/thủ kho
      if (f.keToan.length > 0 || f.thuKho.length > 0) {
        let match = phienList
        if (f.keToan.length > 0) match = match.filter(p => f.keToan.includes(p.ke_toan_id))
        if (f.thuKho.length > 0) match = match.filter(p => f.thuKho.includes(p.thu_kho_id))
        const matchIds = match.map(p => p.id)
        const finalIds = f.phien.length > 0 ? matchIds.filter(id => f.phien.includes(id)) : matchIds
        if (finalIds.length === 0) { setData([]); setLoading(false); return }
        q = q.in('phien_id', finalIds)
      } else if (f.phien.length > 0) {
        q = q.in('phien_id', f.phien)
      } else {
        q = q.gte('phien_kiem_ke.ngay_kiem', f.tuNgay).lte('phien_kiem_ke.ngay_kiem', f.denNgay)
      }
      if (f.kho.length > 0) q = q.in('ma_kho', f.kho)

      if (tab === 'thua_thieu') q = q.not('chenh_lech', 'is', null).neq('chenh_lech', 0)

      const { data: rows } = await q
      setData((rows || []).map(r => ({
        ...r,
        _ke_toan:    userMap[r.phien_kiem_ke?.ke_toan_id]?.ho_ten || '',
        _thu_kho:    userMap[r.phien_kiem_ke?.thu_kho_id]?.ho_ten || '',
        _nguoi_nhap: userMap[r.nguoi_nhap_id]?.ho_ten || '',
      })))
    } finally {
      setLoading(false)
    }
  }, [tab, f.tuNgay, f.denNgay, f.kho, f.phien, f.keToan, f.thuKho, userMap, phienList])

  useEffect(() => { loadData() }, [loadData])

  const loadTonKho = useCallback(async () => {
    setLoadingTonKho(true)
    try {
      let q = supabase.from('ton_kho').select('ma_vt,ma_kho,so_luong_so_sach').order('ma_kho').order('ma_vt')
      if (f.kho.length > 0) q = q.in('ma_kho', f.kho)
      const { data: rows } = await q
      setTonKhoRows(rows || [])
    } finally {
      setLoadingTonKho(false)
    }
  }, [f.kho])

  useEffect(() => { if (tab === 'ton_kho') loadTonKho() }, [tab, loadTonKho])

  const loadNSS = useCallback(async () => {
    setLoadingNSS(true)
    try {
      let rows = await db.chitiet.filter(r => {
        if (!r.ngoai_so_sach) return false
        if (f.phien.length > 0 && !f.phien.includes(r.phien_id)) return false
        if (f.kho.length > 0 && !f.kho.includes(r.ma_kho)) return false
        if (f.vatTu.length > 0 && !f.vatTu.includes(r.ma_vt)) return false
        if (r.created_at) {
          const d = r.created_at.slice(0, 10)
          if (d < f.tuNgay || d > f.denNgay) return false
        }
        return true
      }).toArray()
      if (currentUser.role !== 'admin') {
        const myPhien = await db.phien.filter(p =>
          p.ke_toan_id === currentUser.id || p.thu_kho_id === currentUser.id
        ).toArray()
        const myPhienIds = new Set(myPhien.map(p => p.id))
        rows = rows.filter(r => myPhienIds.has(r.phien_id))
      }
      const phienIds = [...new Set(rows.map(r => r.phien_id))]
      const phienMap = {}
      for (const pid of phienIds) {
        const p = await db.phien.get(pid)
        if (p) phienMap[pid] = p
      }
      setNssItems(rows.map(r => ({ ...r, _phien: phienMap[r.phien_id] })))
    } finally {
      setLoadingNSS(false)
    }
  }, [currentUser, f])

  useEffect(() => { if (tab === 'ngoai_so_sach') loadNSS() }, [tab, loadNSS])

  useEffect(() => {
    if (!openVatTuModal) { vatTuAllRef.current = []; return }
    db.dm_vat_tu.orderBy('ten_vt').toArray().then(rows => {
      vatTuAllRef.current = rows
      setVatTuResults(rows)
    })
  }, [openVatTuModal])

  useEffect(() => {
    if (!openVatTuModal) return
    const q = vatTuModalQ.trim().toLowerCase()
    const all = vatTuAllRef.current
    setVatTuResults(q
      ? all.filter(v => (v.ten_vt || '').toLowerCase().includes(q) || (v.ma_vt || '').toLowerCase().includes(q))
      : all
    )
  }, [vatTuModalQ, openVatTuModal])

  async function doReconcile(item, vtDung) {
    const soSachMoi = item._phien?.ma_kho
      ? await getSoSach(vtDung.ma_vt, item._phien.ma_kho)
      : null
    await updateChiTiet(item.id, {
      ma_vt: vtDung.ma_vt,
      ten_vt: vtDung.ten_vt,
      so_luong_so_sach: soSachMoi ?? 0,
      ngoai_so_sach: false
    })
    await db.dm_vat_tu.delete(item.ma_vt)
    await db.goi_y_vat_tu.delete(item.ma_vt)
    if (navigator.onLine) pushOfflineQueue()
    setReconcileItem(null)
    loadNSS()
    setToastMsg(`Đã cập nhật mã vật tư: ${vtDung.ma_vt} · ${vtDung.ten_vt}`)
    setTimeout(() => setToastMsg(null), 3000)
  }

  const khoMap = Object.fromEntries(khoList.map(k => [k.ma_kho, k.ten_kho]))

  // loaiDuLieu filter — client-side
  const afterRole = data.filter(r => {
    const p = r.phien_kiem_ke
    if (!p) return false
    const role = userMap[r.nguoi_nhap_id]?.role
    return f.loaiDuLieu === 'ke_toan'
      ? (role === 'ke_toan' || role === 'admin')
      : role === 'thu_kho'
  })

  const displayData = f.vatTu.length > 0
    ? afterRole.filter(r => f.vatTu.includes(r.ma_vt))
    : afterRole

  const displayTonKho = f.vatTu.length > 0
    ? tonKhoRows.filter(r => f.vatTu.includes(r.ma_vt))
    : tonKhoRows

  // So sánh KT vs TK
  const soSanhRows = (() => {
    if (tab !== 'so_sanh') return []
    const map = {}
    data.forEach(r => {
      const p = r.phien_kiem_ke
      if (!p) return
      const key = `${r.phien_id}_${r.ma_vt}`
      if (!map[key]) {
        map[key] = {
          ma_vt: r.ma_vt, ten_vt: r.ten_vt, ma_dvt: r.ma_dvt_kiem,
          kho: r.dm_kho?.ten_kho || r.ma_kho || p.dm_kho?.ten_kho || p.ma_kho,
          phien: '#' + (r.phien_id?.slice(-4).toUpperCase() || ''),
          sl_kt: null, sl_tk: null,
        }
      }
      const sl = parseFloat(r.so_luong_quy_doi) || 0
      const role = userMap[r.nguoi_nhap_id]?.role
      if (role === 'ke_toan' || role === 'admin') map[key].sl_kt = (map[key].sl_kt ?? 0) + sl
      if (role === 'thu_kho') map[key].sl_tk = (map[key].sl_tk ?? 0) + sl
    })
    return Object.values(map)
      .filter(r => {
        if (r.sl_kt === null || r.sl_tk === null) return true
        return Math.abs((r.sl_kt ?? 0) - (r.sl_tk ?? 0)) > 0.0001
      })
      .sort((a, b) => a.ma_vt.localeCompare(b.ma_vt))
  })()

  // ── Sub-screen: Xem / Sửa / Xóa ──────────────────────────────────
  function openDetail(row) {
    setDetailItem(row)
    setEditMode(false)
    setForm({
      so_luong_thuc_te: row.so_luong_thuc_te,
      ma_dvt_kiem: row.ma_dvt_kiem || '',
      he_so_quy_doi: row.he_so_quy_doi ?? 1,
      ghi_chu: row.ghi_chu || '',
    })
  }

  function closeDetail() {
    setDetailItem(null)
    setEditMode(false)
  }

  async function handleSave() {
    if (!detailItem) return
    setSaving(true)
    const updated = await updateChiTiet(detailItem.id, {
      so_luong_thuc_te: parseFloat(form.so_luong_thuc_te),
      ma_dvt_kiem: form.ma_dvt_kiem,
      he_so_quy_doi: parseFloat(form.he_so_quy_doi) || 1,
      ghi_chu: form.ghi_chu,
    })
    if (navigator.onLine) pushOfflineQueue()
    // Cập nhật lại dòng trong state mà không cần re-fetch
    if (updated) {
      setData(prev => prev.map(r => r.id === detailItem.id
        ? { ...r, ...updated, _nguoi_nhap: r._nguoi_nhap }
        : r
      ))
    }
    setSaving(false)
    closeDetail()
  }

  async function handleDelete() {
    if (!detailItem) return
    setSaving(true)
    await deleteChiTiet(detailItem.id)
    if (navigator.onLine) pushOfflineQueue()
    setData(prev => prev.filter(r => r.id !== detailItem.id))
    setSaving(false)
    closeDetail()
  }

  const formQuyDoi = (() => {
    if (!detailItem) return '—'
    const sl = parseFloat(form.so_luong_thuc_te)
    const hs = parseFloat(form.he_so_quy_doi) || 1
    if (isNaN(sl)) return '—'
    const maChinh = vtDvtChinhMap[detailItem.ma_vt]
    const tenChinh = maChinh ? (dvtMap[maChinh] || maChinh) : (dvtMap[form.ma_dvt_kiem] || form.ma_dvt_kiem)
    return `${(sl * hs).toFixed(3)} ${tenChinh}`
  })()

  // ── Sub-screen render ────────────────────────────────────────────
  if (detailItem) {
    const p = detailItem.phien_kiem_ke
    const isLocked = p?.xac_nhan_ke_toan || p?.xac_nhan_thu_kho
    const canEdit = !isLocked && (currentUser.role === 'admin' || detailItem.nguoi_nhap_id === currentUser.id)
    return (
      <div className="screen" style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
        <div className="topbar">
          <div className="topbar-title">{detailItem.ma_vt} · {detailItem.ten_vt}</div>
          <div className="topbar-sub">
            {editMode ? 'Chỉnh sửa' : 'Chi tiết'} · {detailItem.dm_kho?.ten_kho || detailItem.ma_kho || p?.dm_kho?.ten_kho || p?.ma_kho || ''}
          </div>
        </div>
        <div className="content" style={{ overflowY: 'auto', flex: 1 }}>
          {isLocked && (
            <div style={{ background: '#FEF3C7', color: '#92400E', borderRadius: 8, padding: '8px 12px', marginBottom: 12, fontSize: 13 }}>
              🔒 Phiên đã có xác nhận — không thể sửa/xóa
            </div>
          )}

          <div className="row-2col">
            <div className="field-group">
              <label className="field-label">Số lượng thực tế</label>
              {editMode
                ? <input type="number" className="input-field input-large"
                    value={form.so_luong_thuc_te}
                    onChange={e => setForm(f => ({ ...f, so_luong_thuc_te: e.target.value }))}
                    min="0" step="any" />
                : <div className="input-readonly input-large">{detailItem.so_luong_thuc_te}</div>
              }
            </div>
            <div className="field-group">
              <label className="field-label">ĐVT</label>
              {editMode
                ? <select className="input-select" value={form.ma_dvt_kiem}
                    onChange={e => setForm(f => ({ ...f, ma_dvt_kiem: e.target.value }))}>
                    <option value="">-- Chọn --</option>
                    {danhMucDvt.map(d => <option key={d.ma_dvt} value={d.ma_dvt}>{d.ten_dvt}</option>)}
                  </select>
                : <div className="input-readonly">{dvtMap[detailItem.ma_dvt_kiem] || detailItem.ma_dvt_kiem || '—'}</div>
              }
            </div>
          </div>

          <div className="row-2col">
            <div className="field-group">
              <label className="field-label">Hệ số</label>
              {editMode
                ? <input type="number" className="input-field"
                    value={form.he_so_quy_doi}
                    onChange={e => setForm(f => ({ ...f, he_so_quy_doi: e.target.value }))}
                    min="0" step="any" />
                : <div className="input-readonly">{detailItem.he_so_quy_doi ?? 1}</div>
              }
            </div>
            <div className="field-group">
              <label className="field-label">Quy đổi</label>
              <div className="input-readonly">
                {editMode ? formQuyDoi : (() => {
                  const maChinh = vtDvtChinhMap[detailItem.ma_vt]
                  const tenChinh = maChinh ? (dvtMap[maChinh] || maChinh) : ''
                  return `${detailItem.so_luong_quy_doi ?? detailItem.so_luong_thuc_te} ${tenChinh}`
                })()}
              </div>
            </div>
          </div>

          <div className="field-group">
            <label className="field-label">Ghi chú</label>
            {editMode
              ? <input type="text" className="input-field"
                  value={form.ghi_chu}
                  onChange={e => setForm(f => ({ ...f, ghi_chu: e.target.value }))}
                  placeholder="Nhập ghi chú..." />
              : <div className="input-readonly">{detailItem.ghi_chu || '—'}</div>
            }
          </div>

          <div style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {[
              ['Kho',        detailItem.dm_kho?.ten_kho || detailItem.ma_kho || p?.dm_kho?.ten_kho || p?.ma_kho || '—'],
              ['Người nhập', detailItem._nguoi_nhap || '—'],
              ['Phiên',      detailItem.phien_id ? '#' + detailItem.phien_id.slice(-4).toUpperCase() : '—'],
              ['Thời gian',  detailItem.created_at ? new Date(detailItem.created_at).toLocaleString('vi-VN') : '—'],
              ['SL sổ sách', detailItem.so_luong_so_sach ?? '—'],
              ['Chênh lệch', detailItem.chenh_lech ?? '—'],
            ].map(([label, val]) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}>
                <span style={{ color: 'var(--text-muted)' }}>{label}</span>
                <span style={{ fontWeight: 500 }}>{val}</span>
              </div>
            ))}
          </div>

          <div className={editMode || canEdit ? 'row-2col' : ''} style={{ marginTop: 16 }}>
            <button className="btn-secondary" onClick={closeDetail} disabled={saving}
              style={!editMode && !canEdit ? { width: '100%' } : {}}>
              {editMode ? 'Hủy' : 'Đóng'}
            </button>
            {editMode ? (
              <button className="btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Đang lưu...' : 'Lưu'}
              </button>
            ) : canEdit ? (
              <button className="btn-primary" onClick={() => setEditMode(true)}>
                Sửa
              </button>
            ) : null}
          </div>

          {!editMode && canEdit && (
            <button onClick={handleDelete} disabled={saving} style={{
              marginTop: 8, width: '100%',
              padding: '10px', borderRadius: 8, border: '1.5px solid #FCA5A5',
              background: '#FEF2F2', color: '#DC2626',
              fontSize: 14, fontWeight: 500, cursor: 'pointer'
            }}>
              {saving ? 'Đang xóa...' : 'Xóa dòng này'}
            </button>
          )}
        </div>
      </div>
    )
  }

  // ── List / report render ─────────────────────────────────────────
  const cols     = tab === 'kiem_ke' ? colKiemKe : colThuaThieu
  const filename = `${tab === 'kiem_ke' ? 'KiemKe' : tab === 'thua_thieu' ? 'ThuaThieu' : 'SoSanh'}_${f.tuNgay}_${f.denNgay}.csv`
  const keToanList   = Object.values(userMap).filter(u => u.role === 'ke_toan')
  const thuKhoList   = Object.values(userMap).filter(u => u.role === 'thu_kho')

  const fldLabel = (type) => {
    const arr = f[type]
    if (!arr.length) return type === 'phien' ? 'Tất cả phiên' : type === 'kho' ? 'Tất cả kho' : 'Tất cả'
    const first = arr[0]
    const rest = arr.length - 1
    let firstName = ''
    if (type === 'phien') {
      const p = phienList.find(x => x.id === first)
      firstName = p ? `${p.ngay_kiem} #${p.id.slice(-4).toUpperCase()}` : first
    } else if (type === 'kho') {
      firstName = khoMap[first] || first
    } else {
      firstName = userMap[first]?.ho_ten || first
    }
    return rest > 0 ? `${firstName} +${rest}` : firstName
  }

  const fldColor = (type) => f[type].length > 0 ? 'var(--text)' : 'var(--text-muted)'

  const vatTuLabel = () => {
    if (!f.vatTu.length) return 'Tất cả vật tư'
    const first = vtNameMap[f.vatTu[0]] || f.vatTu[0]
    return f.vatTu.length > 1 ? `${first} +${f.vatTu.length - 1}` : first
  }

  const todayStr = getToday()
  const activeFilterCount = tab === 'ton_kho'
    ? [f.kho.length > 0, f.vatTu.length > 0].filter(Boolean).length
    : [
        f.tuNgay !== todayStr || f.denNgay !== todayStr,
        f.kho.length > 0, f.phien.length > 0, f.keToan.length > 0, f.thuKho.length > 0, f.vatTu.length > 0
      ].filter(Boolean).length

  const fmtDate   = d => d ? d.slice(8) + '/' + d.slice(5, 7) : ''
  const dateLabel = f.tuNgay === f.denNgay ? fmtDate(f.tuNgay) : `${fmtDate(f.tuNgay)}–${fmtDate(f.denNgay)}`
  const rowCount  = tab === 'so_sanh' ? soSanhRows.length : tab === 'ton_kho' ? displayTonKho.length : tab === 'ngoai_so_sach' ? nssItems.length : displayData.length

  return (
    <div className="screen" style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <div className="topbar">
        <div className="topbar-title">Báo cáo</div>
        <div className="topbar-sub">{rowCount} dòng</div>
      </div>

      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ flex: 1, fontSize: 13, color: 'var(--text-muted)' }}>
          {tab === 'ton_kho'
            ? (f.kho.length > 0 ? `Kho: ${fldLabel('kho')}` : 'Tất cả kho')
            : activeFilterCount > 0 ? `Ngày: ${dateLabel}` : `Hôm nay: ${dateLabel}`}
        </span>
        {activeFilterCount > 0 && (
          <button onClick={() => setF(INIT_FILTERS)} style={{
            border: 'none', background: 'none', color: 'var(--green)',
            fontSize: 13, cursor: 'pointer', padding: 0, whiteSpace: 'nowrap'
          }}>Xóa lọc</button>
        )}
        <button onClick={() => setShowFilters(v => !v)} style={{
          padding: '0 16px', height: 38, borderRadius: 8, border: '1px solid var(--border)',
          background: activeFilterCount > 0 ? 'var(--green)' : '#fff',
          color: activeFilterCount > 0 ? '#fff' : 'var(--text)',
          fontWeight: 500, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap'
        }}>
          Lọc{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''} {showFilters ? '▲' : '▼'}
        </button>
      </div>

      {showFilters && (
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8, background: '#F9FAFB' }}>
          {tab !== 'ton_kho' && (
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Từ ngày</div>
                <input type="date" className="input-field" value={f.tuNgay}
                  onChange={e => upd('tuNgay', e.target.value)} style={{ width: '100%' }} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Đến ngày</div>
                <input type="date" className="input-field" value={f.denNgay}
                  onChange={e => upd('denNgay', e.target.value)} style={{ width: '100%' }} />
              </div>
            </div>
          )}

          {/* Hàng 2: Loại DL + Phiên + Kho (non-ton_kho) hoặc Kho + Vật tư (ton_kho) */}
          {tab !== 'ton_kho' ? (
            <div style={{ display: 'flex', gap: 8 }}>
              {tab !== 'so_sanh' && tab !== 'ngoai_so_sach' && (
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Loại dữ liệu</div>
                  <select className="input-select" value={f.loaiDuLieu}
                    onChange={e => upd('loaiDuLieu', e.target.value)} style={{ width: '100%' }}>
                    <option value="ke_toan">Số liệu kế toán</option>
                    <option value="thu_kho">Số liệu thủ kho</option>
                  </select>
                </div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Phiên kiểm kê</div>
                <div className="input-select" onClick={() => { setFilterModal('phien'); setFilterModalSel(f.phien); setFilterModalQ(''); setTimeout(() => filterModalRef.current?.focus(), 100) }}
                  style={{ cursor: 'pointer', color: fldColor('phien'), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {fldLabel('phien')}
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Kho</div>
                <div className="input-select" onClick={() => { setFilterModal('kho'); setFilterModalSel(f.kho); setFilterModalQ(''); setTimeout(() => filterModalRef.current?.focus(), 100) }}
                  style={{ cursor: 'pointer', color: fldColor('kho'), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {fldLabel('kho')}
                </div>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Kho</div>
                <div className="input-select" onClick={() => { setFilterModal('kho'); setFilterModalSel(f.kho); setFilterModalQ(''); setTimeout(() => filterModalRef.current?.focus(), 100) }}
                  style={{ cursor: 'pointer', color: fldColor('kho') }}>
                  {fldLabel('kho')}
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Vật tư</div>
                <div className="input-select" onClick={() => { setVatTuModalQ(''); setVatTuModalSel(f.vatTu); setOpenVatTuModal(true) }}
                  style={{ cursor: 'pointer', color: f.vatTu.length ? 'var(--text)' : 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {vatTuLabel()}
                </div>
              </div>
            </div>
          )}

          {/* Hàng 3: Kế toán + Thủ kho + Vật tư */}
          {tab !== 'ton_kho' && (
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Kế toán</div>
                <div className="input-select" onClick={() => { setFilterModal('keToan'); setFilterModalSel(f.keToan); setFilterModalQ(''); setTimeout(() => filterModalRef.current?.focus(), 100) }}
                  style={{ cursor: 'pointer', color: fldColor('keToan'), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {fldLabel('keToan')}
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Thủ kho</div>
                <div className="input-select" onClick={() => { setFilterModal('thuKho'); setFilterModalSel(f.thuKho); setFilterModalQ(''); setTimeout(() => filterModalRef.current?.focus(), 100) }}
                  style={{ cursor: 'pointer', color: fldColor('thuKho'), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {fldLabel('thuKho')}
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Vật tư</div>
                <div className="input-select" onClick={() => { setVatTuModalQ(''); setVatTuModalSel(f.vatTu); setOpenVatTuModal(true) }}
                  style={{ cursor: 'pointer', color: f.vatTu.length ? 'var(--text)' : 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {vatTuLabel()}
                </div>
              </div>
            </div>
          )}

        </div>
      )}

      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0, overflowX: 'auto' }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            flexShrink: 0, padding: '10px 12px', border: 'none', background: 'none',
            fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap',
            color: tab === t.key ? 'var(--green)' : 'var(--text-muted)',
            borderBottom: tab === t.key ? '2px solid var(--green)' : '2px solid transparent',
            cursor: 'pointer'
          }}>{t.label}</button>
        ))}
      </div>

      {tab !== 'so_sanh' && tab !== 'ngoai_so_sach' && (
        <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          {tab === 'ton_kho' ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-secondary"
                onClick={() => exportCSV(displayTonKho, colTonKho, `TonKhoSoSach_${f.kho.length > 0 ? f.kho.join('-') : 'TatCaKho'}.csv`)}
                disabled={!displayTonKho.length}
                style={{ flex: 1, fontSize: 13 }}>
                ⬇ Xuất CSV ({displayTonKho.length})
              </button>
              <button className="btn-secondary"
                onClick={() => shareCSV(displayTonKho, colTonKho, `TonKhoSoSach_${f.kho.length > 0 ? f.kho.join('-') : 'TatCaKho'}.csv`)}
                disabled={!displayTonKho.length}
                style={{ flex: 1, fontSize: 13 }}>
                ⬆ Chia sẻ
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-secondary"
                onClick={() => exportCSV(displayData, cols, filename)}
                disabled={!displayData.length}
                style={{ flex: 1, fontSize: 13 }}>
                ⬇ Xuất CSV ({displayData.length})
              </button>
              <button className="btn-secondary"
                onClick={() => shareCSV(displayData, cols, filename)}
                disabled={!displayData.length}
                style={{ flex: 1, fontSize: 13 }}>
                ⬆ Chia sẻ
              </button>
            </div>
          )}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {tab === 'ngoai_so_sach' ? (
          <>
            {reconcileItem && (
              <ChonVatTu autoOpen value={null} onSelect={vt => {
                if (vt) doReconcile(reconcileItem, vt)
                else setReconcileItem(null)
              }} />
            )}
            {loadingNSS ? (
              <div className="empty-state">Đang tải...</div>
            ) : nssItems.length === 0 ? (
              <div className="empty-state">Không có mặt hàng ngoài sổ sách</div>
            ) : nssItems.map(item => {
              const maKho = item.ma_kho || item._phien?.ma_kho || ''
              const tenKho = khoList.find(k => k.ma_kho === maKho)?.ten_kho || maKho
              const gio = item.created_at ? new Date(item.created_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : ''
              return (
                <div key={item.id} className="item-row" style={{ cursor: 'default', padding: '10px 16px', overflow: 'hidden' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                    <div className="item-name" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <span className="item-code">{item.ma_vt}</span> · {item.ten_vt}
                    </div>
                    <div style={{ fontWeight: 600, fontSize: 13, flexShrink: 0 }}>
                      {item.so_luong_thuc_te} {item.ma_dvt_kiem || ''}
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 }}>
                    <div className="item-meta">{item.ma_dvt_kiem || ''}</div>
                    <span className="lot-tag" style={{ background: '#FEF3C7', color: '#D97706' }}>Ngoài SS</span>
                  </div>
                  <div className="item-meta" style={{ marginTop: 2 }}>
                    {tenKho ? `${tenKho} · ` : ''}{gio}
                  </div>
                  <button className="btn-primary"
                    onClick={() => setReconcileItem(item)}
                    style={{ fontSize: 13, width: '100%', marginTop: 8 }}>
                    Chọn mã đúng
                  </button>
                </div>
              )
            })}
          </>
        ) : tab === 'ton_kho' ? (
          loadingTonKho ? (
            <div className="empty-state">Đang tải...</div>
          ) : displayTonKho.length === 0 ? (
            <div className="empty-state">
              {tonKhoRows.length === 0 ? 'Không có dữ liệu tồn kho' : 'Không tìm thấy vật tư khớp'}
            </div>
          ) : (
            <table style={{ borderCollapse: 'collapse', fontSize: 12, whiteSpace: 'nowrap', width: '100%' }}>
              <thead>
                <tr>
                  {colTonKho.map(c => (
                    <th key={c.label} style={{
                      padding: '8px 12px', background: '#1D9E75', color: '#fff',
                      fontWeight: 600, textAlign: c.label === 'SL sổ sách' ? 'right' : 'left',
                      position: 'sticky', top: 0, zIndex: 1
                    }}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayTonKho.map((row, i) => (
                  <tr key={`${row.ma_vt}_${row.ma_kho}`} style={{ background: i % 2 === 0 ? '#fff' : '#F9FAFB' }}>
                    {colTonKho.map(c => {
                      const val = c.get(row, i)
                      return (
                        <td key={c.label} style={{
                          padding: '7px 12px', borderBottom: '1px solid #F3F4F6',
                          textAlign: c.label === 'SL sổ sách' ? 'right' : 'left',
                          fontWeight: c.label === 'SL sổ sách' ? 600 : 400,
                        }}>
                          {val}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : loading ? (
          <div className="empty-state">Đang tải...</div>

        ) : tab === 'so_sanh' ? (
          soSanhRows.length === 0 ? (
            <div className="empty-state">
              {data.length === 0
                ? 'Dùng bộ lọc để chọn ngày, kho, kế toán, thủ kho cần so sánh'
                : 'Không có lệch giữa KT và TK ✓'}
            </div>
          ) : (
            <table style={{ borderCollapse: 'collapse', fontSize: 12, whiteSpace: 'nowrap', width: '100%' }}>
              <thead>
                <tr>
                  {['Mã VT', 'Tên vật tư', 'DVT', 'Kho', 'Phiên', 'SL Kế toán', 'SL Thủ kho', 'Lệch KT-TK'].map(h => (
                    <th key={h} style={{
                      padding: '8px 12px', background: '#1D9E75', color: '#fff', fontWeight: 600,
                      textAlign: ['SL Kế toán','SL Thủ kho','Lệch KT-TK'].includes(h) ? 'right' : 'left',
                      position: 'sticky', top: 0, zIndex: 1
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {soSanhRows.map((r, i) => {
                  const lech = (r.sl_kt ?? 0) - (r.sl_tk ?? 0)
                  const missing = r.sl_kt === null || r.sl_tk === null
                  return (
                    <tr key={i} style={{ background: missing ? '#FFFBEB' : '#FEF2F2' }}>
                      <td style={{ padding: '7px 12px', borderBottom: '1px solid #F3F4F6', fontWeight: 600 }}>{r.ma_vt}</td>
                      <td style={{ padding: '7px 12px', borderBottom: '1px solid #F3F4F6' }}>{r.ten_vt}</td>
                      <td style={{ padding: '7px 12px', borderBottom: '1px solid #F3F4F6', color: 'var(--text-muted)' }}>{r.ma_dvt}</td>
                      <td style={{ padding: '7px 12px', borderBottom: '1px solid #F3F4F6' }}>{r.kho}</td>
                      <td style={{ padding: '7px 12px', borderBottom: '1px solid #F3F4F6', color: 'var(--text-muted)' }}>{r.phien}</td>
                      <td style={{ padding: '7px 12px', borderBottom: '1px solid #F3F4F6', textAlign: 'right' }}>
                        {r.sl_kt !== null ? r.sl_kt : <span style={{ color: '#F59E0B' }}>—</span>}
                      </td>
                      <td style={{ padding: '7px 12px', borderBottom: '1px solid #F3F4F6', textAlign: 'right' }}>
                        {r.sl_tk !== null ? r.sl_tk : <span style={{ color: '#F59E0B' }}>—</span>}
                      </td>
                      <td style={{ padding: '7px 12px', borderBottom: '1px solid #F3F4F6', textAlign: 'right', fontWeight: 700, color: missing ? '#D97706' : '#DC2626' }}>
                        {missing ? '?' : lech > 0 ? `+${lech}` : lech}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )

        ) : displayData.length === 0 ? (
          <div className="empty-state">
            {data.length === 0
              ? 'Dùng bộ lọc để chọn ngày, kho, kế toán, thủ kho cần xem'
              : tab === 'thua_thieu' ? 'Không có hàng thừa/thiếu ✓' : 'Không tìm thấy vật tư khớp'}
          </div>
        ) : (
          <table style={{ borderCollapse: 'collapse', fontSize: 12, whiteSpace: 'nowrap', width: '100%' }}>
            <thead>
              <tr>
                {cols.map(c => (
                  <th key={c.label} style={{
                    padding: '8px 12px', background: '#1D9E75', color: '#fff',
                    fontWeight: 600, textAlign: 'left', position: 'sticky', top: 0, zIndex: 1
                  }}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayData.map((row, i) => {
                const cl     = parseFloat(row.chenh_lech)
                const rowBg  = tab === 'thua_thieu'
                  ? (cl < 0 ? '#FEF2F2' : '#F0FDF4')
                  : (i % 2 === 0 ? '#fff' : '#F9FAFB')
                const clickable = tab === 'kiem_ke'
                return (
                  <tr key={i} style={{ background: rowBg, cursor: clickable ? 'pointer' : 'default' }}
                    onClick={() => clickable && openDetail(row)}>
                    {cols.map(c => {
                      const val    = c.get(row, i)
                      const isLech = c.label === 'Lệch KT-SS/TK-SS'
                      const num    = parseFloat(val)
                      return (
                        <td key={c.label} style={{
                          padding: '7px 12px', borderBottom: '1px solid #F3F4F6',
                          textAlign: typeof val === 'number' ? 'right' : 'left',
                          color: isLech && !isNaN(num) ? (num < 0 ? '#DC2626' : num > 0 ? '#16A34A' : 'inherit') : 'inherit',
                          fontWeight: isLech && !isNaN(num) && num !== 0 ? 600 : 400,
                        }}>
                          {isLech && !isNaN(num) && num > 0 ? '+' : ''}{val}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {openVatTuModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: '#fff', display: 'flex', flexDirection: 'column', maxWidth: 480, margin: '0 auto' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <span style={{ fontWeight: 600, fontSize: 15 }}>Vật tư</span>
              <div style={{ display: 'flex', gap: 16 }}>
                <button onClick={() => setVatTuModalSel([])}
                  style={{ border: 'none', background: 'none', color: 'var(--text-muted)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Xóa chọn</button>
                <button onClick={() => { upd('vatTu', vatTuModalSel); setOpenVatTuModal(false) }}
                  style={{ border: 'none', background: 'none', color: 'var(--green)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Xong</button>
              </div>
            </div>
            <input ref={vatTuModalRef} type="text" className="input-field"
              placeholder="Tìm mã hoặc tên vật tư"
              value={vatTuModalQ} onChange={e => setVatTuModalQ(e.target.value)}
              style={{ margin: 0 }} autoFocus />
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {vatTuResults.length === 0 && vatTuModalQ.trim() ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>Không tìm thấy vật tư</div>
            ) : vatTuResults.map(v => {
              const checked = vatTuModalSel.includes(v.ma_vt)
              return (
                <div key={v.ma_vt} onClick={() => setVatTuModalSel(prev => checked ? prev.filter(x => x !== v.ma_vt) : [...prev, v.ma_vt])}
                  style={{ padding: '14px 16px', borderBottom: '1px solid #F3F4F6', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{
                    width: 20, height: 20, borderRadius: 4, border: `2px solid ${checked ? 'var(--green)' : '#CBD5E1'}`,
                    background: checked ? 'var(--green)' : '#fff', flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center'
                  }}>
                    {checked && <span style={{ color: '#fff', fontSize: 13, lineHeight: 1 }}>✓</span>}
                  </div>
                  <span style={{ background: '#E6F4EF', color: 'var(--green)', borderRadius: 6, padding: '2px 7px', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>{v.ma_vt}</span>
                  <span style={{ fontSize: 14 }}>{v.ten_vt}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {filterModal && (() => {
        const TITLES = { phien: 'Phiên kiểm kê', kho: 'Kho', keToan: 'Kế toán', thuKho: 'Thủ kho' }
        let items = []
        if (filterModal === 'phien') {
          items = phienList.map(p => {
            const kt = userMap[p.ke_toan_id]?.ma_user || '?'
            const tk = userMap[p.thu_kho_id]?.ma_user || '?'
            return { id: p.id, code: p.id.slice(-4).toUpperCase(), label: `${p.ngay_kiem}${p.ma_kho ? ` · ${khoMap[p.ma_kho] || p.ma_kho}` : ''} · ${kt}/${tk}` }
          })
        } else if (filterModal === 'kho') {
          items = khoList.map(k => ({ id: k.ma_kho, code: k.ma_kho, label: k.ten_kho }))
        } else if (filterModal === 'keToan') {
          items = keToanList.map(u => ({ id: u.id, label: u.ho_ten }))
        } else if (filterModal === 'thuKho') {
          items = thuKhoList.map(u => ({ id: u.id, label: u.ho_ten }))
        }
        const q = filterModalQ.toLowerCase()
        const filtered = q ? items.filter(i => i.label.toLowerCase().includes(q) || (i.code || '').toLowerCase().includes(q)) : items
        const toggle = (id) => setFilterModalSel(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
        return (
          <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: '#fff', display: 'flex', flexDirection: 'column', maxWidth: 480, margin: '0 auto' }}>
            {/* Header */}
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <span style={{ fontWeight: 600, fontSize: 15 }}>{TITLES[filterModal]}</span>
                <div style={{ display: 'flex', gap: 16 }}>
                  <button onClick={() => setFilterModalSel([])} style={{ border: 'none', background: 'none', color: 'var(--text-muted)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Xóa chọn</button>
                  <button onClick={() => { upd(filterModal, filterModalSel); setFilterModal(null); setFilterModalQ('') }} style={{ border: 'none', background: 'none', color: 'var(--green)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Xong</button>
                </div>
              </div>
              <input ref={filterModalRef} type="text" className="input-field"
                placeholder="Search"
                value={filterModalQ} onChange={e => setFilterModalQ(e.target.value)}
                style={{ margin: 0 }} />
            </div>
            {/* List */}
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {filtered.map(item => {
                const checked = filterModalSel.includes(item.id)
                return (
                  <div key={item.id} onClick={() => toggle(item.id)}
                    style={{ padding: '14px 16px', borderBottom: '1px solid #F3F4F6', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{
                      width: 20, height: 20, borderRadius: 4, border: `2px solid ${checked ? 'var(--green)' : '#CBD5E1'}`,
                      background: checked ? 'var(--green)' : '#fff', flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center'
                    }}>
                      {checked && <span style={{ color: '#fff', fontSize: 13, lineHeight: 1 }}>✓</span>}
                    </div>
                    {item.code && <span style={{ background: '#E6F4EF', color: 'var(--green)', borderRadius: 6, padding: '2px 7px', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>{item.code}</span>}
                    <span style={{ fontSize: 14 }}>{item.label}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })()}

      {toastMsg && (
        <div style={{
          position: 'fixed', bottom: 80, left: '50%', transform: 'translateX(-50%)',
          background: '#1D9E75', color: '#fff', padding: '12px 20px',
          borderRadius: 10, fontSize: 14, fontWeight: 500,
          boxShadow: '0 4px 12px rgba(0,0,0,0.2)', zIndex: 999,
          maxWidth: 'calc(100% - 32px)', textAlign: 'center'
        }}>
          ✓ {toastMsg}
        </div>
      )}
    </div>
  )
}
