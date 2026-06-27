// src/screens/DemLai.jsx
import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { db, toggleDoiChieu, updateChiTiet, deleteChiTiet } from '../lib/db'
import { supabase } from '../lib/supabase'
import { pushOfflineQueue } from '../lib/sync'

export default function DemLai({ currentUser }) {
  const { phienId } = useParams()
  const navigate = useNavigate()

  const isAdmin = currentUser?.role === 'admin'

  const [phienData, setPhienData] = useState(null)
  const [phienPeople, setPhienPeople] = useState(null)   // { ktId, tenKT, tkId, tenTK }
  const [adminViewId, setAdminViewId] = useState(null)
  const [allRows, setAllRows] = useState([])
  const [summaryRows, setSummaryRows] = useState([])
  const [dvtMap, setDvtMap] = useState({})
  const [danhMucDvt, setDanhMucDvt] = useState([])
  const [dvtChinhMap, setDvtChinhMap] = useState({})
  const [loading, setLoading] = useState(true)
  const [isLocked, setIsLocked] = useState(false)
  const [myId, setMyId] = useState(null)
  const [tab, setTab] = useState('chua')
  const [filterKL, setFilterKL] = useState('lech')  // 'lech' | 'khop'

  // Điều hướng 3 cấp: summary → drill-down → edit
  const [selectedVatTu, setSelectedVatTu] = useState(null)  // ma_vt string
  const [detailItem, setDetailItem] = useState(null)
  const [editMode, setEditMode] = useState(false)
  const [form, setForm] = useState({})
  const [saving, setSaving] = useState(false)

  useEffect(() => { load() }, [phienId])

  // Xây summary rows từ allRows: gộp theo mã VT, tính tổng cho cả KT lẫn TK
  function buildSummary(rows, ktId, tkId) {
    const grouped = {}
    rows.forEach(r => {
      if (!grouped[r.ma_vt]) {
        grouped[r.ma_vt] = { ma_vt: r.ma_vt, ten_vt: r.ten_vt, rowsKT: [], rowsTK: [] }
      }
      if (r.nguoi_nhap_id === ktId) grouped[r.ma_vt].rowsKT.push(r)
      else if (r.nguoi_nhap_id === tkId) grouped[r.ma_vt].rowsTK.push(r)
    })

    const summary = Object.values(grouped).map(g => {
      const slKT = g.rowsKT.reduce((s, r) => s + (r.so_luong_quy_doi ?? 0), 0)
      const slTK = g.rowsTK.reduce((s, r) => s + (r.so_luong_quy_doi ?? 0), 0)
      return {
        ...g, slKT, slTK,
        chenh: parseFloat((slKT - slTK).toFixed(6)),
        allConfirmedKT: g.rowsKT.length > 0 && g.rowsKT.every(r => r.da_doi_chieu),
        allConfirmedTK: g.rowsTK.length > 0 && g.rowsTK.every(r => r.da_doi_chieu),
      }
    })

    summary.sort((a, b) => a.ma_vt.localeCompare(b.ma_vt))
    setSummaryRows(summary)
    return summary
  }

  async function load() {
    setLoading(true)

    const p = await db.phien.get(phienId)
    setPhienData(p)
    setIsLocked(p ? !!(p.xac_nhan_ke_toan || p.xac_nhan_thu_kho) : false)

    const dvtList = await db.dm_dvt.toArray()
    const dMap = {}
    dvtList.forEach(d => { dMap[d.ma_dvt] = d.ten_dvt })
    setDvtMap(dMap)
    setDanhMucDvt(dvtList)

    const { data: { user } } = await supabase.auth.getUser()
    const uid = user?.id
    setMyId(uid)

    if (navigator.onLine) {
      const { data: vtData } = await supabase
        .from('dm_vat_tu').select('ma_vt, ma_dvt_chinh').eq('active', true)
      if (vtData?.length) {
        const cMap = {}
        vtData.forEach(v => { if (v.ma_dvt_chinh) cMap[v.ma_vt] = v.ma_dvt_chinh })
        setDvtChinhMap(cMap)
      }
      // Lấy toàn bộ dữ liệu của phiên (cả KT lẫn TK) để so sánh
      const { data } = await supabase
        .from('kiem_ke_chitiet').select('*')
        .eq('phien_id', phienId)
        .order('created_at', { ascending: false })
      if (data?.length) {
        await db.chitiet.bulkPut(data.map(r => ({ ...r, synced: true })))
      }
    } else {
      const vtList = await db.dm_vat_tu.toArray()
      const cMap = {}
      vtList.forEach(v => { if (v.ma_dvt_chinh) cMap[v.ma_vt] = v.ma_dvt_chinh })
      setDvtChinhMap(cMap)
    }

    const rows = await db.chitiet.where('phien_id').equals(phienId).toArray()
    setAllRows(rows)

    const [kt, tk] = await Promise.all([
      db.dm_user.get(p?.ke_toan_id),
      db.dm_user.get(p?.thu_kho_id),
    ])
    const people = {
      ktId: p?.ke_toan_id, tenKT: kt?.ho_ten || 'Kế toán',
      tkId: p?.thu_kho_id, tenTK: tk?.ho_ten || 'Thủ kho',
    }
    setPhienPeople(people)
    setAdminViewId(prev => prev || (isAdmin ? p?.ke_toan_id : null))
    buildSummary(rows, p?.ke_toan_id, p?.thu_kho_id)
    setLoading(false)
  }

  function getActiveUserId() {
    return isAdmin ? adminViewId : myId
  }

  function tenDvt(maDvt) { return dvtMap[maDvt] || maDvt || '' }

  function getDvtChinh(ma_vt) {
    const maChinh = dvtChinhMap[ma_vt]
    return maChinh ? tenDvt(maChinh) : ''
  }

  function fmtSL(n) {
    if (n === undefined || n === null || isNaN(n)) return '—'
    const v = parseFloat(n)
    return v % 1 === 0 ? v.toString() : parseFloat(v.toFixed(3)).toString()
  }

  function renderMeta(item) {
    const tenKiem = tenDvt(item.ma_dvt_kiem)
    const maChinh = dvtChinhMap[item.ma_vt]
    const tenChinh = maChinh ? tenDvt(maChinh) : tenKiem
    const coHeSo = item.he_so_quy_doi && item.he_so_quy_doi !== 1
    return coHeSo
      ? `${item.so_luong_thuc_te} ${tenKiem} × ${item.he_so_quy_doi} = ${item.so_luong_quy_doi} ${tenChinh}`
      : `${item.so_luong_thuc_te} ${tenKiem}`
  }

  function renderQuyDoi(item) {
    const maChinh = dvtChinhMap[item.ma_vt]
    const tenChinh = maChinh ? tenDvt(maChinh) : tenDvt(item.ma_dvt_kiem)
    return `${item.so_luong_quy_doi ?? item.so_luong_thuc_te} ${tenChinh}`
  }

  async function handleToggle(item) {
    const newVal = !item.da_doi_chieu
    const updatedRows = allRows.map(r => r.id === item.id ? { ...r, da_doi_chieu: newVal } : r)
    setAllRows(updatedRows)
    buildSummary(updatedRows, phienPeople?.ktId, phienPeople?.tkId)
    await toggleDoiChieu(item.id, newVal)
    if (navigator.onLine) pushOfflineQueue()
  }

  async function handleDeleteRecord(item) {
    const updatedRows = allRows.filter(r => r.id !== item.id)
    setAllRows(updatedRows)
    buildSummary(updatedRows, phienPeople?.ktId, phienPeople?.tkId)
    await deleteChiTiet(item.id)
    if (navigator.onLine) pushOfflineQueue()
  }

  // Xác nhận tất cả dòng của mã VT cho người đang xem (toggle theo trạng thái hiện tại)
  async function handleConfirmVatTu(g) {
    const uid = getActiveUserId()
    const userRows = uid === phienPeople?.ktId ? g.rowsKT : g.rowsTK
    if (!userRows.length) return

    const allDone = userRows.every(r => r.da_doi_chieu)
    const newVal = !allDone

    for (const r of userRows) {
      await toggleDoiChieu(r.id, newVal)
    }

    const ids = new Set(userRows.map(r => r.id))
    const updatedRows = allRows.map(r => ids.has(r.id) ? { ...r, da_doi_chieu: newVal } : r)
    setAllRows(updatedRows)
    buildSummary(updatedRows, phienPeople?.ktId, phienPeople?.tkId)
    if (navigator.onLine) pushOfflineQueue()
  }

  function openDetail(item, mode) {
    setDetailItem(item)
    setEditMode(mode === 'edit')
    setForm({
      so_luong_thuc_te: item.so_luong_thuc_te,
      ma_dvt_kiem: item.ma_dvt_kiem,
      he_so_quy_doi: item.he_so_quy_doi ?? 1,
      ghi_chu: item.ghi_chu ?? ''
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
      ghi_chu: form.ghi_chu
    })
    if (updated) {
      const updatedRows = allRows.map(r => r.id === updated.id ? updated : r)
      setAllRows(updatedRows)
      buildSummary(updatedRows, phienPeople?.ktId, phienPeople?.tkId)
    }
    if (navigator.onLine) pushOfflineQueue()
    setSaving(false)
    closeDetail()
  }

  const formQuyDoi = (() => {
    if (!detailItem) return '—'
    const sl = parseFloat(form.so_luong_thuc_te)
    const hs = parseFloat(form.he_so_quy_doi) || 1
    if (isNaN(sl)) return '—'
    const maChinh = dvtChinhMap[detailItem.ma_vt]
    const tenChinh = maChinh ? tenDvt(maChinh) : tenDvt(form.ma_dvt_kiem)
    return `${(sl * hs).toFixed(3)} ${tenChinh}`
  })()

  // ── CẤP 3: EDIT / XEM TỪNG RECORD ───────────────────────────────────
  if (detailItem) {
    return (
      <div className="screen">
        <div className="topbar">
          <div className="topbar-title">{detailItem.ma_vt} · {detailItem.ten_vt}</div>
          <div className="topbar-sub">{editMode ? 'Chỉnh sửa' : 'Chi tiết'} · Lượt {detailItem.luot_kiem}</div>
        </div>
        <div className="content">
          <div className="row-2col">
            <div className="field-group">
              <label className="field-label">Số lượng thực tế</label>
              {editMode
                ? <input type="number" className="input-field input-large"
                    value={form.so_luong_thuc_te}
                    onChange={e => setForm(f => ({ ...f, so_luong_thuc_te: e.target.value }))}
                    min="0" step="any" />
                : <div className="input-readonly input-large">{detailItem.so_luong_thuc_te}</div>}
            </div>
            <div className="field-group">
              <label className="field-label">ĐVT</label>
              {editMode
                ? <select className="input-select" value={form.ma_dvt_kiem}
                    onChange={e => setForm(f => ({ ...f, ma_dvt_kiem: e.target.value }))}>
                    <option value="">-- Chọn --</option>
                    {danhMucDvt.map(d => <option key={d.ma_dvt} value={d.ma_dvt}>{d.ten_dvt}</option>)}
                  </select>
                : <div className="input-readonly">{tenDvt(detailItem.ma_dvt_kiem)}</div>}
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
                : <div className="input-readonly">{detailItem.he_so_quy_doi ?? 1}</div>}
            </div>
            <div className="field-group">
              <label className="field-label">Quy đổi</label>
              <div className="input-readonly">{editMode ? formQuyDoi : renderQuyDoi(detailItem)}</div>
            </div>
          </div>
          <div className="field-group">
            <label className="field-label">Ghi chú</label>
            {editMode
              ? <input type="text" className="input-field"
                  value={form.ghi_chu}
                  onChange={e => setForm(f => ({ ...f, ghi_chu: e.target.value }))}
                  placeholder="Nhập ghi chú..." />
              : <div className="input-readonly">{detailItem.ghi_chu || '—'}</div>}
          </div>
          <div className="row-2col">
            <button className="btn-secondary" onClick={closeDetail} disabled={saving}>Hủy</button>
            {editMode
              ? <button className="btn-primary" onClick={handleSave} disabled={saving}>
                  {saving ? 'Đang lưu...' : 'Lưu'}
                </button>
              : <button className="btn-primary" onClick={() => setEditMode(true)}>Sửa</button>}
          </div>
        </div>
      </div>
    )
  }

  // ── CẤP 2: DRILL-DOWN TỪNG DÒNG CỦA MỘT MÃ VT ──────────────────────
  if (selectedVatTu) {
    const liveGroup = summaryRows.find(g => g.ma_vt === selectedVatTu)
    if (!liveGroup) {
      return (
        <div className="screen">
          <div className="topbar">
            <button onClick={() => setSelectedVatTu(null)}
              style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', padding: '0 10px 0 0', color: 'var(--text)' }}>
              ←
            </button>
            <div className="topbar-title">Đã xóa hết dữ liệu</div>
          </div>
          <div className="content">
            <div className="empty-state">Không còn dữ liệu</div>
          </div>
        </div>
      )
    }

    const uid = getActiveUserId()
    const isKT = uid === phienPeople?.ktId
    const myRows = isKT ? liveGroup.rowsKT : liveGroup.rowsTK
    const dvtChinh = getDvtChinh(selectedVatTu)

    const chuaCount = myRows.filter(r => !r.da_doi_chieu).length
    const daCount   = myRows.filter(r =>  r.da_doi_chieu).length
    const filteredRows = myRows.filter(r => tab === 'chua' ? !r.da_doi_chieu : r.da_doi_chieu)

    return (
      <div className="screen">
        <div className="topbar">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 2 }}>
            <button onClick={() => setSelectedVatTu(null)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                background: '#F1F5F9', border: 'none', borderRadius: 8,
                padding: '6px 12px', fontSize: 13, fontWeight: 600,
                color: '#334155', cursor: 'pointer', flexShrink: 0
              }}>
              ← Quay lại
            </button>
            <div className="topbar-title">{liveGroup.ma_vt} · {liveGroup.ten_vt}</div>
          </div>
          <div className="topbar-sub">{myRows.length} dòng kiểm kê</div>
        </div>

        <div className="content">
          {/* Banner tổng KT vs TK */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
            <div style={{ flex: 1, background: '#EFF6FF', borderRadius: 10, padding: '10px 12px', textAlign: 'center' }}>
              <div style={{ fontSize: 11, color: '#3B82F6', fontWeight: 600, marginBottom: 2 }}>
                Kế toán {liveGroup.allConfirmedKT ? '✓' : ''}
              </div>
              <div style={{ fontWeight: 700, fontSize: 20, lineHeight: 1.2 }}>{fmtSL(liveGroup.slKT)}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{dvtChinh}</div>
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, textAlign: 'center', width: 28,
              color: liveGroup.chenh !== 0 ? '#EF4444' : '#10B981' }}>
              {liveGroup.chenh !== 0 ? '≠' : '='}
            </div>
            <div style={{ flex: 1, background: '#FFF7ED', borderRadius: 10, padding: '10px 12px', textAlign: 'center' }}>
              <div style={{ fontSize: 11, color: '#F59E0B', fontWeight: 600, marginBottom: 2 }}>
                Thủ kho {liveGroup.allConfirmedTK ? '✓' : ''}
              </div>
              <div style={{ fontWeight: 700, fontSize: 20, lineHeight: 1.2 }}>{fmtSL(liveGroup.slTK)}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{dvtChinh}</div>
            </div>
          </div>

          {/* Tabs lọc dòng */}
          <div className="tab-row" style={{ marginBottom: 12 }}>
            <button className={`tab-btn ${tab === 'chua' ? 'active' : ''}`} onClick={() => setTab('chua')}>
              Chưa đối chiếu <span className="tab-count">{chuaCount}</span>
            </button>
            <button className={`tab-btn ${tab === 'da' ? 'active' : ''}`} onClick={() => setTab('da')}>
              Đã đối chiếu <span className="tab-count">{daCount}</span>
            </button>
          </div>

          {myRows.length === 0 ? (
            <div className="empty-state">Chưa có dữ liệu cho vai trò này</div>
          ) : filteredRows.length === 0 ? (
            <div className="empty-state">
              {tab === 'chua' ? 'Đã đối chiếu hết ✓' : 'Chưa có dòng nào được xác nhận'}
            </div>
          ) : (
            filteredRows.map(item => (
              <div key={item.id} className="dc-card">
                <div className="dc-top" onClick={() => handleToggle(item)} style={{ cursor: 'pointer' }}>
                  <div className={`check-circle ${item.da_doi_chieu ? 'checked' : ''}`} />
                  <div className="item-info">
                    <div className="item-name">
                      <span className="item-code">Lượt {item.luot_kiem}</span>
                    </div>
                    <div className="item-meta">
                      {renderMeta(item)}{item.ghi_chu ? ` · ${item.ghi_chu}` : ''}
                    </div>
                    {item.created_at && (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                        {new Date(item.created_at).toLocaleString('vi-VN')}
                      </div>
                    )}
                  </div>
                  <span className="badge badge-quy-doi">{renderQuyDoi(item)}</span>
                </div>
                <div className="dc-actions">
                  <button className="dc-btn dc-btn-view" onClick={() => openDetail(item, 'view')}>Xem</button>
                  {!isLocked && (
                    <button className="dc-btn dc-btn-edit" onClick={() => openDetail(item, 'edit')}>Sửa</button>
                  )}
                  {!isLocked && (
                    <button className="dc-btn dc-btn-del" onClick={() => handleDeleteRecord(item)}>Xóa</button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    )
  }

  // ── CẤP 1: SUMMARY THEO MÃ VẬT TƯ ──────────────────────────────────
  const uid = getActiveUserId()
  const isKT = uid === phienPeople?.ktId

  const tongMaVT = summaryRows.length
  const tongLech = summaryRows.filter(g => g.chenh !== 0).length
  const displayRows = summaryRows.filter(g => filterKL === 'lech' ? g.chenh !== 0 : g.chenh === 0)

  return (
    <div className="screen">
      <div className="topbar">
        <div className="topbar-title">Đếm lại</div>
        <div className="topbar-sub">{tongLech} lệch / {tongMaVT} mã</div>
      </div>

      <div className="content">
        {/* Toggle chế độ */}
        <div className="mode-toggle">
          <button className="mode-tab" onClick={() => navigate(`/kiem-ke/${phienId}?mode=1_ma`)}>
            📦 1 mã nhiều lần
          </button>
          <button className="mode-tab" onClick={() => navigate(`/kiem-ke/${phienId}?mode=nhieu_ma`)}>
            📋 Nhiều mã 1 lần
          </button>
          <button className="mode-tab active">✓ Đếm lại</button>
        </div>

        {/* Admin: chọn xem số liệu của ai */}
        {isAdmin && phienPeople && (
          <div className="mode-toggle" style={{ marginBottom: 8 }}>
            <button
              className={`mode-tab ${adminViewId === phienPeople.ktId ? 'active' : ''}`}
              onClick={() => setAdminViewId(phienPeople.ktId)}>
              KT · {phienPeople.tenKT}
            </button>
            <button
              className={`mode-tab ${adminViewId === phienPeople.tkId ? 'active' : ''}`}
              onClick={() => setAdminViewId(phienPeople.tkId)}>
              TK · {phienPeople.tenTK}
            </button>
          </div>
        )}

        {/* Bộ lọc Khớp / Lệch */}
        <div className="mode-toggle" style={{ marginBottom: 12 }}>
          <button className={`mode-tab ${filterKL === 'lech' ? 'active' : ''}`}
            onClick={() => setFilterKL('lech')}>
            Lệch số ({tongLech})
          </button>
          <button className={`mode-tab ${filterKL === 'khop' ? 'active' : ''}`}
            onClick={() => setFilterKL('khop')}>
            Khớp số ({tongMaVT - tongLech})
          </button>
        </div>

        {loading ? (
          <div className="empty-state">Đang tải...</div>
        ) : summaryRows.length === 0 ? (
          <div className="empty-state">Chưa có dữ liệu kiểm kê</div>
        ) : displayRows.length === 0 ? (
          <div className="empty-state">
            {filterKL === 'lech' ? 'Tất cả khớp ✓' : 'Không có mặt hàng nào khớp'}
          </div>
        ) : (
          displayRows.map(g => {
            const confirmed = isKT ? g.allConfirmedKT : g.allConfirmedTK
            const dvtChinh = getDvtChinh(g.ma_vt)
            const userRows = isKT ? g.rowsKT : g.rowsTK
            const hasMatch = g.chenh === 0 && g.slKT > 0 && g.slTK > 0
            const borderColor = g.chenh !== 0 ? '#EF4444' : confirmed ? '#10B981' : 'var(--border)'

            return (
              <div key={g.ma_vt} style={{
                background: 'var(--card)', borderRadius: 14, marginBottom: 10,
                border: `1.5px solid ${borderColor}`, overflow: 'hidden'
              }}>
                <div style={{ padding: '12px 14px' }}>
                  {/* Header: mã + tên + badge */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontWeight: 700, fontSize: 14 }}>{g.ma_vt}</span>
                      <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 13 }}>{g.ten_vt}</span>
                    </div>
                    <div style={{ flexShrink: 0, marginLeft: 8 }}>
                      {g.chenh !== 0 ? (
                        <span style={{ background: '#FEE2E2', color: '#DC2626', borderRadius: 6, padding: '3px 8px', fontSize: 12, fontWeight: 600 }}>
                          Lệch {fmtSL(Math.abs(g.chenh))} {dvtChinh}
                        </span>
                      ) : hasMatch ? (
                        <span style={{ background: '#D1FAE5', color: '#059669', borderRadius: 6, padding: '3px 8px', fontSize: 12, fontWeight: 600 }}>
                          Khớp ✓
                        </span>
                      ) : null}
                    </div>
                  </div>

                  {/* KT ↔ TK */}
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
                    <div style={{ flex: 1, background: '#EFF6FF', borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}>
                      <div style={{ fontSize: 11, color: '#3B82F6', fontWeight: 600, marginBottom: 2 }}>
                        Kế toán {g.allConfirmedKT ? '✓' : ''}
                      </div>
                      <div style={{ fontWeight: 700, fontSize: 20, lineHeight: 1.2 }}>{fmtSL(g.slKT)}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{dvtChinh || 'đơn vị'}</div>
                    </div>
                    <div style={{ fontSize: 22, fontWeight: 700, textAlign: 'center', width: 28,
                      color: g.chenh !== 0 ? '#EF4444' : '#10B981' }}>
                      {g.chenh !== 0 ? '≠' : '='}
                    </div>
                    <div style={{ flex: 1, background: '#FFF7ED', borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}>
                      <div style={{ fontSize: 11, color: '#F59E0B', fontWeight: 600, marginBottom: 2 }}>
                        Thủ kho {g.allConfirmedTK ? '✓' : ''}
                      </div>
                      <div style={{ fontWeight: 700, fontSize: 20, lineHeight: 1.2 }}>{fmtSL(g.slTK)}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{dvtChinh || 'đơn vị'}</div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn-detail" onClick={() => { setTab('chua'); setSelectedVatTu(g.ma_vt) }}>
                      Chi tiết ({userRows.length} dòng)
                    </button>
                    {!isLocked && (
                      <button className="btn-detail" onClick={() => handleConfirmVatTu(g)}>
                        {confirmed ? '↩ Bỏ XN' : '✓ Xác nhận'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
