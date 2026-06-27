import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { db, updateChiTiet, deleteChiTiet } from '../lib/db'
import { pushOfflineQueue } from '../lib/sync'

const TABS = [
  { key: 'kiem_ke',    label: 'Kiểm kê' },
  { key: 'thua_thieu', label: 'Thừa/Thiếu SS' },
  { key: 'so_sanh',   label: 'So sánh KT/TK' },
  { key: 'ton_kho',   label: 'Tồn kho SS' },
]

async function downloadCSV(rows, cols, filename) {
  const header = cols.map(c => c.label).join(',')
  const body = rows.map((r, i) =>
    cols.map(c => {
      const v = String(c.get(r, i) ?? '')
      return v.includes(',') || v.includes('"') || v.includes('\n')
        ? `"${v.replace(/"/g, '""')}"` : v
    }).join(',')
  ).join('\n')
  const blob = new Blob(['﻿' + header + '\n' + body], { type: 'text/csv;charset=utf-8' })

  // Mobile: dùng Web Share API để share trực tiếp qua Zalo, Drive...
  const file = new File([blob], filename, { type: 'text/csv' })
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename })
      return
    } catch (err) {
      if (err.name === 'AbortError') return // user bấm huỷ
    }
  }

  // Desktop fallback: download bình thường
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click()
  document.body.removeChild(a); URL.revokeObjectURL(url)
}

const getToday = () => new Date().toISOString().slice(0, 10)

const INIT_FILTERS = () => ({
  tuNgay: getToday(), denNgay: getToday(),
  loaiDuLieu: 'ke_toan',
  kho: 'all', phien: 'all', keToan: 'all', thuKho: 'all', vatTu: '',
})

export default function BaoCao() {
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
    upd('phien', 'all')
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

      if (f.phien !== 'all') {
        q = q.eq('phien_kiem_ke.id', f.phien)
      } else {
        q = q.gte('phien_kiem_ke.ngay_kiem', f.tuNgay).lte('phien_kiem_ke.ngay_kiem', f.denNgay)
        if (f.kho !== 'all')    q = q.eq('ma_kho', f.kho)
        if (f.keToan !== 'all') q = q.eq('phien_kiem_ke.ke_toan_id', f.keToan)
        if (f.thuKho !== 'all') q = q.eq('phien_kiem_ke.thu_kho_id', f.thuKho)
      }

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
  }, [tab, f.tuNgay, f.denNgay, f.kho, f.phien, f.keToan, f.thuKho, userMap])

  useEffect(() => { loadData() }, [loadData])

  const loadTonKho = useCallback(async () => {
    setLoadingTonKho(true)
    try {
      let q = supabase.from('ton_kho').select('ma_vt,ma_kho,so_luong_so_sach').order('ma_kho').order('ma_vt')
      if (f.kho !== 'all') q = q.eq('ma_kho', f.kho)
      const { data: rows } = await q
      setTonKhoRows(rows || [])
    } finally {
      setLoadingTonKho(false)
    }
  }, [f.kho])

  useEffect(() => { if (tab === 'ton_kho') loadTonKho() }, [tab, loadTonKho])

  const khoMap = Object.fromEntries(khoList.map(k => [k.ma_kho, k.ten_kho]))

  // loaiDuLieu filter — client-side
  const afterRole = data.filter(r => {
    const p = r.phien_kiem_ke
    if (!p) return false
    return f.loaiDuLieu === 'ke_toan'
      ? r.nguoi_nhap_id === p.ke_toan_id
      : r.nguoi_nhap_id === p.thu_kho_id
  })

  const kw = f.vatTu.trim().toLowerCase()
  const displayData = kw
    ? afterRole.filter(r => r.ma_vt?.toLowerCase().includes(kw) || r.ten_vt?.toLowerCase().includes(kw))
    : afterRole

  const kwTonKho = f.vatTu.trim().toLowerCase()
  const displayTonKho = kwTonKho
    ? tonKhoRows.filter(r => r.ma_vt.toLowerCase().includes(kwTonKho) || (vtNameMap[r.ma_vt] || '').toLowerCase().includes(kwTonKho))
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
      if (r.nguoi_nhap_id === p.ke_toan_id) map[key].sl_kt = (map[key].sl_kt ?? 0) + sl
      if (r.nguoi_nhap_id === p.thu_kho_id) map[key].sl_tk = (map[key].sl_tk ?? 0) + sl
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

          <div className="row-2col" style={{ marginTop: 16 }}>
            <button className="btn-secondary" onClick={closeDetail} disabled={saving}>
              {editMode ? 'Hủy' : 'Đóng'}
            </button>
            {editMode ? (
              <button className="btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Đang lưu...' : 'Lưu'}
              </button>
            ) : !isLocked ? (
              <button className="btn-primary" onClick={() => setEditMode(true)}>
                Sửa
              </button>
            ) : null}
          </div>

          {!editMode && !isLocked && (
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
  const phienLocked  = f.phien !== 'all'
  const keToanList   = Object.values(userMap).filter(u => u.role === 'ke_toan')
  const thuKhoList   = Object.values(userMap).filter(u => u.role === 'thu_kho')

  const todayStr = getToday()
  const activeFilterCount = tab === 'ton_kho'
    ? [f.kho !== 'all', f.vatTu.trim()].filter(Boolean).length
    : [
        f.tuNgay !== todayStr || f.denNgay !== todayStr,
        f.kho !== 'all', f.phien !== 'all', f.keToan !== 'all', f.thuKho !== 'all', f.vatTu.trim()
      ].filter(Boolean).length

  const fmtDate   = d => d ? d.slice(8) + '/' + d.slice(5, 7) : ''
  const dateLabel = f.tuNgay === f.denNgay ? fmtDate(f.tuNgay) : `${fmtDate(f.tuNgay)}–${fmtDate(f.denNgay)}`
  const rowCount  = tab === 'so_sanh' ? soSanhRows.length : tab === 'ton_kho' ? displayTonKho.length : displayData.length

  return (
    <div className="screen" style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <div className="topbar">
        <div className="topbar-title">Báo cáo</div>
        <div className="topbar-sub">{rowCount} dòng</div>
      </div>

      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ flex: 1, fontSize: 13, color: 'var(--text-muted)' }}>
          {tab === 'ton_kho'
            ? (f.kho !== 'all' ? `Kho: ${khoMap[f.kho] || f.kho}` : 'Tất cả kho')
            : activeFilterCount > 0 ? `Ngày: ${dateLabel}` : `Hôm nay: ${dateLabel}`}
        </span>
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

          {tab !== 'so_sanh' && tab !== 'ton_kho' && (
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Loại dữ liệu</div>
              <select className="input-select" value={f.loaiDuLieu}
                onChange={e => upd('loaiDuLieu', e.target.value)} style={{ width: '100%' }}>
                <option value="ke_toan">Số liệu kế toán</option>
                <option value="thu_kho">Số liệu thủ kho</option>
              </select>
            </div>
          )}

          {tab !== 'ton_kho' && (
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Phiên kiểm kê</div>
              <select className="input-select" value={f.phien} onChange={e => upd('phien', e.target.value)} style={{ width: '100%' }}>
                <option value="all">Tất cả phiên</option>
                {phienList.map(p => {
                  const kt = userMap[p.ke_toan_id]?.ma_user || '?'
                  const tk = userMap[p.thu_kho_id]?.ma_user || '?'
                  const ma = p.id?.slice(-4).toUpperCase()
                  return <option key={p.id} value={p.id}>{p.ngay_kiem}{p.ma_kho ? ` · ${p.ma_kho}` : ''} · {kt}/{tk} #{ma}</option>
                })}
              </select>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Kho</div>
              <select className="input-select" value={f.kho} onChange={e => upd('kho', e.target.value)}
                disabled={tab !== 'ton_kho' && phienLocked}
                style={{ width: '100%', opacity: (tab !== 'ton_kho' && phienLocked) ? 0.45 : 1 }}>
                <option value="all">Tất cả kho</option>
                {khoList.map(k => <option key={k.ma_kho} value={k.ma_kho}>{k.ten_kho}</option>)}
              </select>
            </div>
            {tab !== 'ton_kho' && (
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Kế toán</div>
                <select className="input-select" value={f.keToan} onChange={e => upd('keToan', e.target.value)}
                  disabled={phienLocked} style={{ width: '100%', opacity: phienLocked ? 0.45 : 1 }}>
                  <option value="all">Tất cả</option>
                  {keToanList.map(u => <option key={u.id} value={u.id}>{u.ho_ten}</option>)}
                </select>
              </div>
            )}
          </div>

          {tab !== 'ton_kho' && (
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Thủ kho</div>
                <select className="input-select" value={f.thuKho} onChange={e => upd('thuKho', e.target.value)}
                  disabled={phienLocked} style={{ width: '100%', opacity: phienLocked ? 0.45 : 1 }}>
                  <option value="all">Tất cả</option>
                  {thuKhoList.map(u => <option key={u.id} value={u.id}>{u.ho_ten}</option>)}
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Vật tư</div>
                <input className="input-field" value={f.vatTu}
                  onChange={e => upd('vatTu', e.target.value)}
                  placeholder="Mã hoặc tên VT" style={{ width: '100%' }} />
              </div>
            </div>
          )}

          {tab === 'ton_kho' && (
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Vật tư</div>
              <input className="input-field" value={f.vatTu}
                onChange={e => upd('vatTu', e.target.value)}
                placeholder="Mã hoặc tên VT" style={{ width: '100%' }} />
            </div>
          )}

          <button onClick={() => { setF(INIT_FILTERS); setShowFilters(false) }} style={{
            alignSelf: 'flex-end', padding: '4px 14px', fontSize: 12,
            border: '1px solid var(--border)', borderRadius: 6,
            background: '#fff', color: 'var(--text-muted)', cursor: 'pointer'
          }}>Xóa bộ lọc</button>
        </div>
      )}

      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            flex: 1, padding: '10px 4px', border: 'none', background: 'none',
            fontSize: 12, fontWeight: 500,
            color: tab === t.key ? 'var(--green)' : 'var(--text-muted)',
            borderBottom: tab === t.key ? '2px solid var(--green)' : '2px solid transparent',
            cursor: 'pointer'
          }}>{t.label}</button>
        ))}
      </div>

      {tab !== 'so_sanh' && (
        <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          {tab === 'ton_kho' ? (
            <button className="btn-secondary"
              onClick={() => downloadCSV(displayTonKho, colTonKho, `TonKhoSoSach_${f.kho !== 'all' ? f.kho : 'TatCaKho'}.csv`)}
              disabled={!displayTonKho.length}
              style={{ width: '100%', fontSize: 13 }}>
              ⬆ Xuất / Chia sẻ CSV ({displayTonKho.length} dòng)
            </button>
          ) : (
            <button className="btn-secondary"
              onClick={() => downloadCSV(displayData, cols, filename)}
              disabled={!displayData.length}
              style={{ width: '100%', fontSize: 13 }}>
              ⬆ Xuất / Chia sẻ CSV ({displayData.length} dòng)
            </button>
          )}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {tab === 'ton_kho' ? (
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
    </div>
  )
}
