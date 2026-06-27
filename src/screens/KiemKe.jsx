// src/screens/KiemKe.jsx
import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { db, saveChiTietLocal, getSoSach, deleteChiTiet, updateChiTiet } from '../lib/db'
import { supabase } from '../lib/supabase'
import { pushOfflineQueue } from '../lib/sync'
import ChonVatTu from '../components/ChonVatTu'

export default function KiemKe({ currentUser }) {
  const { phienId } = useParams()
  const navigate = useNavigate()
  const [phien, setPhien] = useState(null)
  const [danhMucKho, setDanhMucKho] = useState([])
  const [maKhoHienTai, setMaKhoHienTai] = useState('')
  const [tenDoiTac, setTenDoiTac] = useState('')
  const [danhSach, setDanhSach] = useState([])

  // Form state
  const [vatTuCoDinh, setVatTuCoDinh] = useState(null) // { ma_vt, ten_vt }
  const [dvt, setDvt] = useState('')
  const [heSo, setHeSo] = useState(1)
  const [soLuong, setSoLuong] = useState('')
  const [luotKiem, setLuotKiem] = useState(1)
  const [ghiChu, setGhiChu] = useState('')
  const [soSach, setSoSach] = useState(null)
  const [saving, setSaving] = useState(false)
  const [xemDanhSach, setXemDanhSach] = useState(false)
  const [danhMucDvt, setDanhMucDvt] = useState([])
  const [dvtChinhMap, setDvtChinhMap] = useState({}) // ma_vt → ma_dvt_chinh
  const loadedRef = useRef(false) // guard: chỉ persist sau khi load() xong
  const soLuongRef = useRef(null)
  const phienRef   = useRef(null) // tránh closure stale khi đọc ke_toan_id

  // Danh sách đã nhập — filter + CRUD
  const [xemFilter, setXemFilter] = useState({ kho: '', vatTu: '', soLuong: '', dvt: '' })
  const [showListFilter, setShowListFilter] = useState(false)
  const [editItem, setEditItem] = useState(null)
  const [editForm, setEditForm] = useState({})
  const [editSaving, setEditSaving] = useState(false)

  // Persist kho + vatTu sang sessionStorage để nhớ khi quay lại
  useEffect(() => {
    if (!loadedRef.current) return
    if (maKhoHienTai) sessionStorage.setItem(`kiem_ke_kho_${phienId}`, maKhoHienTai)
  }, [maKhoHienTai, phienId])

  useEffect(() => {
    if (!loadedRef.current) return
    if (vatTuCoDinh) sessionStorage.setItem(`kiem_ke_vt_${phienId}`, JSON.stringify(vatTuCoDinh))
    else sessionStorage.removeItem(`kiem_ke_vt_${phienId}`)
  }, [vatTuCoDinh, phienId])

  // Load phiên + danh mục
  useEffect(() => {
    async function load() {
      const p = await db.phien.get(phienId)
      if (!p) return
      phienRef.current = p
      setPhien(p)

      const [khos, doiTac, dvtList] = await Promise.all([
        db.dm_kho.toArray(),
        db.dm_user.get(currentUser.role === 'ke_toan' ? p.thu_kho_id : p.ke_toan_id),
        db.dm_dvt.toArray()
      ])
      setDanhMucKho(khos)
      setTenDoiTac(doiTac?.ho_ten || '')
      setDanhMucDvt(dvtList)

      // Fetch dm_vat_tu để lấy ma_dvt_chinh — ưu tiên Supabase nếu online
      let localDvtMap = {}
      if (navigator.onLine) {
        const { data } = await supabase.from('dm_vat_tu').select('ma_vt, ma_dvt_chinh').eq('active', true)
        if (data?.length) {
          data.forEach(v => { if (v.ma_dvt_chinh) localDvtMap[v.ma_vt] = v.ma_dvt_chinh })
        }
      } else {
        const vtList = await db.dm_vat_tu.toArray()
        vtList.forEach(v => { if (v.ma_dvt_chinh) localDvtMap[v.ma_vt] = v.ma_dvt_chinh })
      }
      setDvtChinhMap(localDvtMap)

      await loadDanhSach()

      // Lấy lượt kiểm gần nhất
      const lastLuot = await db.chitiet
        .where('phien_id').equals(phienId)
        .last()
      if (lastLuot) setLuotKiem(lastLuot.luot_kiem)

      // Restore kho + vật tư đã chọn lần trước
      const savedKho = sessionStorage.getItem(`kiem_ke_kho_${phienId}`)
      if (savedKho && khos.some(k => k.ma_kho === savedKho)) {
        setMaKhoHienTai(savedKho)
        if (navigator.onLine) {
          const { data: tk } = await supabase.from('ton_kho').select('*').eq('ma_kho', savedKho)
          if (tk?.length) await db.ton_kho.bulkPut(tk)
        }

        const savedVt = sessionStorage.getItem(`kiem_ke_vt_${phienId}`)
        if (savedVt) {
          try {
            const vt = JSON.parse(savedVt)
            setVatTuCoDinh(vt)
            const ss = await getSoSach(vt.ma_vt, savedKho)
            setSoSach(ss)
            if (localDvtMap[vt.ma_vt]) setDvt(localDvtMap[vt.ma_vt])
          } catch {}
        }
      }

      loadedRef.current = true
    }
    load()
  }, [phienId])

  // Realtime: lắng nghe thay đổi từ người kia
  useEffect(() => {
    const channel = supabase
      .channel(`phien-${phienId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'kiem_ke_chitiet',
        filter: `phien_id=eq.${phienId}`
      }, async (payload) => {
        // Sync record mới từ người kia vào local
        await db.chitiet.put({ ...payload.new, synced: true })
        await loadDanhSach()
      })
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [phienId])

  async function loadDanhSach() {
    const rows = await db.chitiet
      .where('phien_id').equals(phienId)
      .filter(r => {
        if (currentUser.role === 'admin') {
          const keToanId = phienRef.current?.ke_toan_id
          return r.nguoi_nhap_id === currentUser.id || r.nguoi_nhap_id === keToanId
        }
        return r.nguoi_nhap_id === currentUser.id
      })
      .sortBy('created_at')
    setDanhSach(rows.reverse())
  }

  // Chọn mã vật tư
  async function handleChonVatTuCoDinh(vt) {
    setVatTuCoDinh(vt)
    if (vt) {
      const ss = maKhoHienTai ? await getSoSach(vt.ma_vt, maKhoHienTai) : null
      setSoSach(ss)
      if (dvtChinhMap[vt.ma_vt]) setDvt(dvtChinhMap[vt.ma_vt])
      setHeSo(1)
      setTimeout(() => soLuongRef.current?.focus(), 100)
    } else {
      setDvt('')
      setHeSo(1)
    }
    setSoLuong('')
    setGhiChu('')
  }

  async function handleLuu() {
    if (!vatTuCoDinh || !soLuong || !maKhoHienTai) return
    setSaving(true)

    await saveChiTietLocal({
      id: crypto.randomUUID(),
      phien_id: phienId,
      ma_vt: vatTuCoDinh.ma_vt,
      ten_vt: vatTuCoDinh.ten_vt,
      ma_kho: maKhoHienTai,
      ma_dvt_kiem: dvt,
      he_so_quy_doi: parseFloat(heSo) || 1,
      luot_kiem: luotKiem,
      so_luong_thuc_te: parseFloat(soLuong),
      so_luong_so_sach: soSach,
      ghi_chu: ghiChu,
      hinh_anh_urls: [],
      da_doi_chieu: false,
      nguoi_nhap_id: currentUser.id
    })

    if (navigator.onLine) pushOfflineQueue()
    await loadDanhSach()

    setSoLuong('')
    setGhiChu('')
    setSaving(false)
    setTimeout(() => soLuongRef.current?.focus(), 100)
  }

  function handleHuy() {
    setSoLuong('')
    setGhiChu('')
  }

  async function handleDeleteItem(id) {
    if (!window.confirm('Xóa dòng này?')) return
    await deleteChiTiet(id)
    if (navigator.onLine) pushOfflineQueue()
    await loadDanhSach()
  }

  async function handleDeleteAll() {
    if (!window.confirm(`Xóa tất cả ${danhSach.length} dòng đã nhập?`)) return
    for (const item of danhSach) await deleteChiTiet(item.id)
    if (navigator.onLine) pushOfflineQueue()
    await loadDanhSach()
  }

  async function handleUpdateItem() {
    if (!editItem) return
    setEditSaving(true)
    await updateChiTiet(editItem.id, {
      so_luong_thuc_te: parseFloat(editForm.so_luong_thuc_te),
      ma_dvt_kiem: editForm.ma_dvt_kiem,
      he_so_quy_doi: parseFloat(editForm.he_so_quy_doi) || 1,
      ghi_chu: editForm.ghi_chu
    })
    if (navigator.onLine) pushOfflineQueue()
    await loadDanhSach()
    setEditSaving(false)
    setEditItem(null)
  }

  const vtHienTai = vatTuCoDinh
  const dvtChinh = vtHienTai ? (dvtChinhMap[vtHienTai.ma_vt] || '') : ''
  const soQuyDoi = soLuong ? (parseFloat(soLuong) * (parseFloat(heSo) || 1)).toFixed(3) : null
  const chenhLech = soQuyDoi && soSach !== null ? (parseFloat(soQuyDoi) - soSach).toFixed(3) : null
  const khoMap = Object.fromEntries(danhMucKho.map(k => [k.ma_kho, k.ten_kho]))
  const dvtNameMap = Object.fromEntries(danhMucDvt.map(d => [d.ma_dvt, d.ten_dvt]))

  function renderItemRow(item) {
    const tenDvtKiem = dvtNameMap[item.ma_dvt_kiem] || item.ma_dvt_kiem || ''
    const maDvtChinh = dvtChinhMap[item.ma_vt]
    const tenDvtChinh = maDvtChinh ? (dvtNameMap[maDvtChinh] || maDvtChinh) : tenDvtKiem
    const soQD = item.so_luong_quy_doi ?? (parseFloat(item.so_luong_thuc_te) * (item.he_so_quy_doi || 1))
    const heSo = item.he_so_quy_doi || 1
    const tenKho = item.ma_kho ? (khoMap[item.ma_kho] || item.ma_kho) : ''
    const gio = new Date(item.created_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
    const showConv = heSo !== 1 || (maDvtChinh && maDvtChinh !== item.ma_dvt_kiem)
    return (
      <div key={item.id} className="item-row">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
          <div className="item-name" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <span className="item-code">{item.ma_vt}</span> · {item.ten_vt}
          </div>
          <div style={{ fontWeight: 600, fontSize: 13, flexShrink: 0 }}>
            {soQD} {tenDvtChinh}
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 2, gap: 8 }}>
          <div className="item-meta">
            {showConv
              ? `${item.so_luong_thuc_te} ${tenDvtKiem} × ${heSo} = ${soQD} ${tenDvtChinh}`
              : `${item.so_luong_thuc_te} ${tenDvtKiem}`}
          </div>
          <span className="lot-tag">Lượt {item.luot_kiem}</span>
        </div>
        <div className="item-meta" style={{ marginTop: 2 }}>
          {tenKho ? `Kho ${tenKho} · ` : ''}{gio}
          {item.ghi_chu ? ` · ${item.ghi_chu}` : ''}
          {!item.synced ? ' · ⏳' : ''}
        </div>
      </div>
    )
  }

  // Lọc danh sách theo chế độ 1 mã
  const danhSachHienThi = danhSach.slice(0, 20)

  if (xemDanhSach) {
    const hasFilter = !!(xemFilter.kho || xemFilter.vatTu || xemFilter.soLuong || xemFilter.dvt)
    const danhSachLoc = danhSach
      .filter(r => !xemFilter.kho || r.ma_kho === xemFilter.kho)
      .filter(r => !xemFilter.vatTu || r.ma_vt.toLowerCase().includes(xemFilter.vatTu.toLowerCase()) || r.ten_vt.toLowerCase().includes(xemFilter.vatTu.toLowerCase()))
      .filter(r => !xemFilter.soLuong || String(r.so_luong_thuc_te) === xemFilter.soLuong)
      .filter(r => !xemFilter.dvt || r.ma_dvt_kiem === xemFilter.dvt)

    return (
      <div className="screen" style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
        <div className="topbar">
          <div className="topbar-title">Danh sách đã nhập</div>
          <div className="topbar-sub">{danhSachLoc.length}/{danhSach.length} dòng · Lượt {luotKiem}</div>
        </div>

        {/* Toolbar */}
        <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', background: '#fff', display: 'flex', gap: 8 }}>
          <button className="btn-secondary" onClick={() => setXemDanhSach(false)}
            style={{ flex: 1, color: 'var(--green-dark)', borderColor: 'var(--green)', fontWeight: 600, height: 36 }}>
            ← Quay lại
          </button>
          <button className="btn-filter-toggle" onClick={() => setShowListFilter(v => !v)}
            style={{ height: 36 }}>
            Lọc {hasFilter ? '●' : ''}{showListFilter ? ' ▲' : ' ▼'}
          </button>
          {danhSach.length > 0 && (
            <button onClick={handleDeleteAll}
              style={{ height: 36, padding: '0 12px', borderRadius: 8, border: '1px solid #FCA5A5', background: '#FEF2F2', color: '#DC2626', fontWeight: 600, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}>
              Xóa tất cả
            </button>
          )}
        </div>

        {/* Filter panel */}
        {showListFilter && (
          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', background: '#F9FAFB', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <div className="field-label">Kho</div>
                <select className="input-select" value={xemFilter.kho}
                  onChange={e => setXemFilter(f => ({ ...f, kho: e.target.value }))}>
                  <option value="">Tất cả</option>
                  {danhMucKho.map(k => <option key={k.ma_kho} value={k.ma_kho}>{k.ten_kho}</option>)}
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <div className="field-label">ĐVT phụ</div>
                <select className="input-select" value={xemFilter.dvt}
                  onChange={e => setXemFilter(f => ({ ...f, dvt: e.target.value }))}>
                  <option value="">Tất cả</option>
                  {danhMucDvt.map(d => <option key={d.ma_dvt} value={d.ma_dvt}>{d.ten_dvt}</option>)}
                </select>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 2 }}>
                <div className="field-label">Mã / tên vật tư</div>
                <input className="input-field" value={xemFilter.vatTu}
                  onChange={e => setXemFilter(f => ({ ...f, vatTu: e.target.value }))}
                  placeholder="Tìm mã hoặc tên..." />
              </div>
              <div style={{ flex: 1 }}>
                <div className="field-label">Số lượng</div>
                <input className="input-field" type="number" value={xemFilter.soLuong}
                  onChange={e => setXemFilter(f => ({ ...f, soLuong: e.target.value }))}
                  placeholder="VD: 5" min="0" />
              </div>
            </div>
            {hasFilter && (
              <button className="btn-clear-filter"
                onClick={() => setXemFilter({ kho: '', vatTu: '', soLuong: '', dvt: '' })}>
                Xóa lọc
              </button>
            )}
          </div>
        )}

        {/* Danh sách */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px' }}>
          {danhSachLoc.length === 0 && (
            <div className="empty-state">{hasFilter ? 'Không có kết quả phù hợp' : 'Chưa có dòng nào được nhập'}</div>
          )}
          {danhSachLoc.map(item => (
            <div key={item.id} style={{ borderBottom: '1px solid var(--border)' }}>
              {renderItemRow(item)}
              <div style={{ display: 'flex', gap: 0, marginTop: -4, marginBottom: 8 }}>
                <button onClick={() => { setEditItem(item); setEditForm({ so_luong_thuc_te: item.so_luong_thuc_te, ma_dvt_kiem: item.ma_dvt_kiem, he_so_quy_doi: item.he_so_quy_doi ?? 1, ghi_chu: item.ghi_chu ?? '' }) }}
                  style={{ flex: 1, padding: '6px', fontSize: 13, border: '1px solid var(--border)', borderRight: 'none', borderRadius: '6px 0 0 6px', background: '#fff', color: '#1a56db', cursor: 'pointer', fontWeight: 500 }}>
                  Sửa
                </button>
                <button onClick={() => handleDeleteItem(item.id)}
                  style={{ flex: 1, padding: '6px', fontSize: 13, border: '1px solid #FCA5A5', borderRadius: '0 6px 6px 0', background: '#FEF2F2', color: '#DC2626', cursor: 'pointer', fontWeight: 500 }}>
                  Xóa
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Edit modal */}
        {editItem && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 100, display: 'flex', alignItems: 'flex-end' }}>
            <div style={{ background: '#fff', width: '100%', maxWidth: 480, margin: '0 auto', borderRadius: '16px 16px 0 0', padding: '20px 16px 32px' }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 14 }}>
                Sửa · {editItem.ma_vt} · {editItem.ten_vt}
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <div className="field-group" style={{ flex: 1, marginBottom: 0 }}>
                  <label className="field-label">Số lượng</label>
                  <input type="number" className="input-field input-large" value={editForm.so_luong_thuc_te}
                    onChange={e => setEditForm(f => ({ ...f, so_luong_thuc_te: e.target.value }))} min="0" step="any" />
                </div>
                <div className="field-group" style={{ flex: 1, marginBottom: 0 }}>
                  <label className="field-label">ĐVT</label>
                  <select className="input-select" value={editForm.ma_dvt_kiem}
                    onChange={e => setEditForm(f => ({ ...f, ma_dvt_kiem: e.target.value }))}>
                    {danhMucDvt.map(d => <option key={d.ma_dvt} value={d.ma_dvt}>{d.ten_dvt}</option>)}
                  </select>
                </div>
                <div className="field-group" style={{ flex: 1, marginBottom: 0 }}>
                  <label className="field-label">Hệ số</label>
                  <input type="number" className="input-field" value={editForm.he_so_quy_doi}
                    onChange={e => setEditForm(f => ({ ...f, he_so_quy_doi: e.target.value }))} min="0" step="any" />
                </div>
              </div>
              <div className="field-group" style={{ marginBottom: 14 }}>
                <label className="field-label">Ghi chú</label>
                <input type="text" className="input-field" value={editForm.ghi_chu}
                  onChange={e => setEditForm(f => ({ ...f, ghi_chu: e.target.value }))} placeholder="Ghi chú..." />
              </div>
              <div className="row-2col">
                <button className="btn-secondary" onClick={() => setEditItem(null)} disabled={editSaving}>Hủy</button>
                <button className="btn-primary" onClick={handleUpdateItem} disabled={editSaving}>
                  {editSaving ? 'Đang lưu...' : 'Lưu'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="screen">
      {/* Topbar */}
      <div className="topbar">
        <div className="topbar-title">{maKhoHienTai ? (khoMap[maKhoHienTai] || maKhoHienTai) : 'Kiểm kê'}</div>
        <div className="topbar-sub">
          {currentUser.ho_ten} + {tenDoiTac} · Lượt {luotKiem}
        </div>
      </div>

      {/* Lưu / Hủy — sticky ngay dưới topbar (topbar cao ~72px) */}
      <div style={{
        position: 'sticky', top: 72, zIndex: 9,
        background: '#fff', borderBottom: '1px solid var(--border)',
        padding: '8px 16px', display: 'flex', gap: 8
      }}>
        <button className="btn-secondary" onClick={handleHuy} disabled={saving}
          style={{ flex: 1, height: 40 }}>
          Hủy
        </button>
        <button className="btn-primary" onClick={handleLuu}
          style={{ flex: 1, height: 40 }}
          disabled={!vtHienTai || !soLuong || !maKhoHienTai || saving || phien?.xac_nhan_ke_toan || phien?.xac_nhan_thu_kho}>
          {saving ? 'Đang lưu...' : '+ Lưu & đếm tiếp'}
        </button>
      </div>

      <div className="content">
        {/* Banner khóa khi có xác nhận */}
        {(phien?.xac_nhan_ke_toan || phien?.xac_nhan_thu_kho) && (
          <div style={{
            background: '#FEF3C7', color: '#92400E', borderRadius: 8,
            padding: '8px 12px', marginBottom: 12, fontSize: 13, fontWeight: 500
          }}>
            🔒 Đã có xác nhận — không thể nhập thêm
          </div>
        )}

        {/* Kho đang kiểm + Đếm lại — cùng hàng */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
          <label className="field-label" style={{ flexShrink: 0, marginBottom: 0 }}>Kho đang kiểm</label>
          <select className="input-select" style={{ flex: 1 }} value={maKhoHienTai}
            onChange={async e => {
              const newKho = e.target.value
              setMaKhoHienTai(newKho)
              if (newKho && navigator.onLine) {
                const { data } = await supabase.from('ton_kho').select('*').eq('ma_kho', newKho)
                if (data?.length) await db.ton_kho.bulkPut(data)
              }
              if (vatTuCoDinh && newKho) {
                const ss = await getSoSach(vatTuCoDinh.ma_vt, newKho)
                setSoSach(ss)
              } else {
                setSoSach(null)
              }
            }}>
            <option value="">-- Chọn kho --</option>
            {danhMucKho.map(k => <option key={k.ma_kho} value={k.ma_kho}>{k.ten_kho}</option>)}
          </select>
          <button className="mode-tab active" onClick={() => navigate(`/dem-lai/${phienId}`)}
            style={{ flexShrink: 0, fontWeight: 700, height: 40, alignSelf: 'center' }}>
            ✓ Đếm lại
          </button>
        </div>

        {/* Chọn mã vật tư */}
        {vatTuCoDinh ? (
          <div className="autofill-chip">
            <div style={{ flex: 1 }}>
              <div className="chip-name">{vatTuCoDinh.ma_vt} · {vatTuCoDinh.ten_vt}</div>
              <div className="chip-meta">Đang đếm mã này</div>
            </div>
            <button className="chip-change" onClick={() => handleChonVatTuCoDinh(null)}>
              Đổi mã
            </button>
          </div>
        ) : (
          <ChonVatTu value={null} onSelect={handleChonVatTuCoDinh} />
        )}

        {/* Hàng 1: Số lượng + ĐVT + Hệ số */}
        <div style={{ display: 'flex', gap: 8 }}>
          <div className="field-group" style={{ flex: 1 }}>
            <label className="field-label">Số lượng thực tế</label>
            <input
              ref={soLuongRef}
              type="number" className="input-field input-large"
              value={soLuong} onChange={e => setSoLuong(e.target.value)}
              placeholder="0" min="0" step="any"
            />
          </div>
          <div className="field-group" style={{ flex: 1 }}>
            <label className="field-label">ĐVT</label>
            <select className="input-select" value={dvt} onChange={e => setDvt(e.target.value)}>
              <option value="">-- Chọn --</option>
              {danhMucDvt.map(d => (
                <option key={d.ma_dvt} value={d.ma_dvt}>{d.ten_dvt}</option>
              ))}
            </select>
          </div>
          <div className="field-group" style={{ flex: 1 }}>
            <label className="field-label">Hệ số</label>
            <input type="number" className="input-field" value={heSo}
              onChange={e => setHeSo(e.target.value)} min="0" step="any" />
          </div>
        </div>

        {/* Hàng 2: Quy đổi + Lượt kiểm + Chênh lệch */}
        <div style={{ display: 'flex', gap: 8 }}>
          <div className="field-group" style={{ flex: 1 }}>
            <label className="field-label">Quy đổi</label>
            <div className="input-readonly">
              {soQuyDoi ? `${soQuyDoi} ${dvtChinh}` : '—'}
            </div>
          </div>
          <div className="field-group" style={{ flex: 1 }}>
            <label className="field-label">Lượt kiểm</label>
            <input type="number" className="input-field" value={luotKiem}
              onChange={e => setLuotKiem(parseInt(e.target.value))} min="1" />
          </div>
          <div className="field-group" style={{ flex: 1 }}>
            <label className="field-label">Chênh lệch</label>
            <div className={`input-readonly ${!chenhLech ? '' : parseFloat(chenhLech) < 0 ? 'text-danger' : parseFloat(chenhLech) > 0 ? 'text-warn' : 'text-ok'}`}>
              {chenhLech !== null ? (parseFloat(chenhLech) > 0 ? '+' : '') + chenhLech : '—'}
            </div>
          </div>
        </div>

        {/* Ghi chú */}
        <div className="field-group">
          <label className="field-label">Ghi chú</label>
          <textarea className="input-field" value={ghiChu}
            onChange={e => setGhiChu(e.target.value)} placeholder="Nhập ghi chú..."
            rows={2} style={{ resize: 'vertical', lineHeight: 1.5 }} />
        </div>

        {/* Danh sách đã nhập */}
        {danhSachHienThi.length > 0 && (
          <>
            <div className="divider" />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <div className="section-title" style={{ marginBottom: 0 }}>
                Đã nhập lượt {luotKiem}
              </div>
              <button onClick={() => setXemDanhSach(true)} style={{
                fontSize: 12, fontWeight: 600, padding: '4px 12px', borderRadius: 20,
                border: '1.5px solid var(--green)', background: 'var(--green-light)',
                color: 'var(--green-dark)', cursor: 'pointer'
              }}>{danhSach.length} dòng ↗</button>
            </div>
            {danhSachHienThi.map(item => renderItemRow(item))}
          </>
        )}

      </div>
    </div>
  )
}
