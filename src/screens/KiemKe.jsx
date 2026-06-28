// src/screens/KiemKe.jsx
import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { db, saveChiTietLocal, getSoSach, deleteChiTiet, updateChiTiet } from '../lib/db'
import { supabase } from '../lib/supabase'
import { pushOfflineQueue, syncChiTietNow } from '../lib/sync'
import { fmtSL } from '../lib/utils'
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
  const [autoOpenVt, setAutoOpenVt]   = useState(false)
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
  const [xemFilter, setXemFilter] = useState({ kho: [], vatTu: [], soLuong: '', dvt: [] })
  const [showListFilter, setShowListFilter] = useState(false)
  const [openKhoFilter, setOpenKhoFilter] = useState(false)
  const [khoFilterQ, setKhoFilterQ] = useState('')
  const [khoFilterSel, setKhoFilterSel] = useState([])
  const [openDvtFilter, setOpenDvtFilter] = useState(false)
  const [dvtFilterQ, setDvtFilterQ] = useState('')
  const [dvtFilterSel, setDvtFilterSel] = useState([])
  const [openVtModal, setOpenVtModal] = useState(false)
  const [vtModalQ, setVtModalQ] = useState('')
  const [vtModalSel, setVtModalSel] = useState([])
  const [editItem, setEditItem] = useState(null)
  const [editForm, setEditForm] = useState({})
  const [editSaving, setEditSaving] = useState(false)
  const [checkedIds, setCheckedIds] = useState(new Set())
  const [confirmDeleteChecked, setConfirmDeleteChecked] = useState(false)

  // Kho fullscreen modal
  const [openKhoModal, setOpenKhoModal] = useState(false)
  const [khoQuery, setKhoQuery] = useState('')
  const khoSearchRef = useRef(null)

  // DVT fullscreen modal
  const [openDvtModal, setOpenDvtModal] = useState(false)
  const [dvtQuery, setDvtQuery] = useState('')
  const dvtSearchRef = useRef(null)

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
      if (!p) { navigate('/'); return }
      const authorized = currentUser.role === 'admin'
        || p.ke_toan_id === currentUser.id
        || p.thu_kho_id === currentUser.id
      if (!authorized) { navigate('/'); return }
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

      // Pull chitiet từ Supabase (hỗ trợ tab mới / ẩn danh / thiết bị khác)
      if (navigator.onLine) {
        const { data: remoteRows } = await supabase
          .from('kiem_ke_chitiet')
          .select('*')
          .eq('phien_id', phienId)
        if (remoteRows) {
          const localRows = await db.chitiet.where('phien_id').equals(phienId).toArray()
          const localUnsyncedIds = new Set(localRows.filter(r => !r.synced).map(r => r.id))
          if (remoteRows.length) {
            const remoteIds = new Set(remoteRows.map(r => r.id))
            const toStore = remoteRows
              .filter(r => !localUnsyncedIds.has(r.id))
              .map(r => ({ ...r, synced: true }))
            if (toStore.length) await db.chitiet.bulkPut(toStore)
            // Xóa local row đã synced nhưng bị xóa trên server
            const toDelete = localRows
              .filter(r => r.synced && !remoteIds.has(r.id))
              .map(r => r.id)
            if (toDelete.length) await db.chitiet.bulkDelete(toDelete)
          } else {
            // Server trả về 0 dòng — xóa hết local synced
            const toDelete = localRows.filter(r => r.synced).map(r => r.id)
            if (toDelete.length) await db.chitiet.bulkDelete(toDelete)
          }
        }
      }

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
      .filter(r => r.nguoi_nhap_id === currentUser.id)
      .sortBy('created_at')
    setDanhSach(rows.reverse())
  }

  // Chọn mã vật tư
  async function handleChonVatTuCoDinh(vt) {
    setVatTuCoDinh(vt)
    if (vt) {
      if (vt.ngoai_so_sach) {
        setSoSach(0)
        if (vt.ma_dvt_kiem) setDvt(vt.ma_dvt_kiem)
      } else {
        const ss = maKhoHienTai ? await getSoSach(vt.ma_vt, maKhoHienTai) : null
        setSoSach(ss)
        if (dvtChinhMap[vt.ma_vt]) setDvt(dvtChinhMap[vt.ma_vt])
      }
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

    const record = await saveChiTietLocal({
      id: crypto.randomUUID(),
      phien_id: phienId,
      ma_vt: vatTuCoDinh.ma_vt,
      ten_vt: vatTuCoDinh.ten_vt,
      ma_kho: maKhoHienTai,
      ma_dvt_kiem: dvt,
      he_so_quy_doi: parseFloat(heSo) || 1,
      luot_kiem: luotKiem,
      so_luong_thuc_te: parseFloat(soLuong.replace(/,/g, '')),
      so_luong_so_sach: soSach,
      ghi_chu: ghiChu,
      hinh_anh_urls: [],
      da_doi_chieu: false,
      nguoi_nhap_id: currentUser.id,
      ngoai_so_sach: vatTuCoDinh.ngoai_so_sach ?? false
    })

    if (navigator.onLine) pushOfflineQueue()  // có lock, không chạy đồng thời dù bấm liên tục
    await loadDanhSach()

    setSoLuong('')
    setGhiChu('')
    setSaving(false)
    setTimeout(() => soLuongRef.current?.focus(), 50)
  }

  function handleHuy() {
    setVatTuCoDinh(null)
    setSoLuong('')
    setHeSo(1)
    setGhiChu('')
    setSoSach(null)
    setDvt('')
  }

  async function handleSelectKho(newKho) {
    setMaKhoHienTai(newKho)
    setOpenKhoModal(false)
    setKhoQuery('')
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
  }

  async function handleDeleteItem(id) {
    if (!window.confirm('Xóa dòng này?')) return
    if (navigator.onLine) {
      await supabase.from('kiem_ke_chitiet').delete().eq('id', id)
      await db.chitiet.delete(id)
    } else {
      await deleteChiTiet(id)
    }
    await loadDanhSach()
  }


  async function handleDeleteChecked() {
    const ids = [...checkedIds]
    if (navigator.onLine) {
      await supabase.from('kiem_ke_chitiet').delete().in('id', ids)
      for (const id of ids) await db.chitiet.delete(id)
    } else {
      for (const id of ids) await deleteChiTiet(id)
    }
    await loadDanhSach()
    setCheckedIds(new Set())
    setConfirmDeleteChecked(false)
  }

  async function handleUpdateItem() {
    if (!editItem) return
    setEditSaving(true)
    await updateChiTiet(editItem.id, {
      so_luong_thuc_te: parseFloat(editForm.so_luong_thuc_te),
      ma_dvt_kiem: editForm.ma_dvt_kiem,
      he_so_quy_doi: parseFloat(editForm.he_so_quy_doi) || 1,
      ghi_chu: editForm.ghi_chu,
      ma_kho: editForm.ma_kho || null
    })
    if (navigator.onLine) pushOfflineQueue()
    await loadDanhSach()
    setEditSaving(false)
    setEditItem(null)
  }

  const vtHienTai = vatTuCoDinh
  const dvtChinh = vtHienTai ? (dvtChinhMap[vtHienTai.ma_vt] || '') : ''
  const soQuyDoi = soLuong ? (parseFloat(soLuong.replace(/,/g, '')) * (parseFloat(heSo) || 1)).toFixed(3) : null
  const chenhLech = soQuyDoi && soSach !== null ? (parseFloat(soQuyDoi) - soSach).toFixed(3) : null
  const khoMap = Object.fromEntries(danhMucKho.map(k => [k.ma_kho, k.ten_kho]))
  const dvtNameMap = Object.fromEntries(danhMucDvt.map(d => [d.ma_dvt, d.ten_dvt]))

  function renderItemRow(item, actions = null) {
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
            <span className="item-code">{item.ma_vt}</span>
            <span style={{ color: 'var(--text-muted)', margin: '0 3px' }}>·</span>
            <span style={{ fontWeight: 600, color: '#1a56db' }}>{item.ten_vt}</span>
          </div>
          <div style={{ flexShrink: 0, fontWeight: 700, fontSize: 15, color: '#DB2777' }}>
            {fmtSL(soQD)} <span style={{ fontSize: 11, fontWeight: 700 }}>{tenDvtChinh}</span>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 2, gap: 8 }}>
          <div className="item-meta">
            {showConv ? (
              <>
                <span style={{ color: '#7C3AED', fontWeight: 700 }}>{fmtSL(item.so_luong_thuc_te)}</span><span style={{ color: '#7C3AED', fontWeight: 600 }}> {tenDvtKiem}</span>
                <span style={{ color: 'var(--text-muted)' }}> × {fmtSL(heSo)} = </span>
                <span style={{ color: '#DB2777', fontWeight: 600 }}>{fmtSL(soQD)} {tenDvtChinh}</span>
              </>
            ) : (
              <>
                <span style={{ color: '#7C3AED', fontWeight: 700 }}>{fmtSL(item.so_luong_thuc_te)}</span>
                <span style={{ color: '#7C3AED', fontWeight: 600 }}> {tenDvtKiem}</span>
              </>
            )}
          </div>
          <span className="lot-tag">Lượt {item.luot_kiem}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 }}>
          <div className="item-meta">
            {tenKho ? `${tenKho} · ` : ''}{gio}
            {item.ghi_chu ? ` · ${item.ghi_chu}` : ''}
            {!item.synced ? ' · ⏳' : ''}
          </div>
          {actions}
        </div>
      </div>
    )
  }

  // Lọc danh sách theo chế độ 1 mã
  const danhSachHienThi = danhSach.slice(0, 20)

  if (xemDanhSach) {
    const hasFilter = !!(xemFilter.kho.length || xemFilter.vatTu.length || xemFilter.soLuong || xemFilter.dvt.length)
    const danhSachLoc = danhSach
      .filter(r => !xemFilter.kho.length || xemFilter.kho.includes(r.ma_kho))
      .filter(r => !xemFilter.vatTu.length || xemFilter.vatTu.includes(r.ma_vt))
      .filter(r => !xemFilter.soLuong || String(r.so_luong_thuc_te) === xemFilter.soLuong)
      .filter(r => !xemFilter.dvt.length || xemFilter.dvt.includes(r.ma_dvt_kiem))

    const khoInDanhSach = [...new Map(danhSach.map(r => [r.ma_kho, danhMucKho.find(k => k.ma_kho === r.ma_kho) || { ma_kho: r.ma_kho, ten_kho: r.ma_kho }])).values()]
      .sort((a, b) => (a.ten_kho || '').localeCompare(b.ten_kho || ''))
    const khoFilterResults = khoFilterQ.trim()
      ? khoInDanhSach.filter(k => k.ten_kho.toLowerCase().includes(khoFilterQ.toLowerCase()) || k.ma_kho.toLowerCase().includes(khoFilterQ.toLowerCase()))
      : khoInDanhSach

    const dvtInDanhSach = [...new Map(danhSach.filter(r => r.ma_dvt_kiem).map(r => [r.ma_dvt_kiem, { ma_dvt: r.ma_dvt_kiem, ten_dvt: danhMucDvt.find(d => d.ma_dvt === r.ma_dvt_kiem)?.ten_dvt || r.ma_dvt_kiem }])).values()]
      .sort((a, b) => (a.ten_dvt || '').localeCompare(b.ten_dvt || ''))
    const dvtFilterResults = dvtFilterQ.trim()
      ? dvtInDanhSach.filter(d => d.ten_dvt.toLowerCase().includes(dvtFilterQ.toLowerCase()) || d.ma_dvt.toLowerCase().includes(dvtFilterQ.toLowerCase()))
      : dvtInDanhSach

    const vtInDanhSach = [...new Map(danhSach.map(r => [r.ma_vt, { ma_vt: r.ma_vt, ten_vt: r.ten_vt }])).values()]
      .sort((a, b) => a.ma_vt.localeCompare(b.ma_vt))
    const vtModalResults = vtModalQ.trim()
      ? vtInDanhSach.filter(v => v.ma_vt.toLowerCase().includes(vtModalQ.toLowerCase()) || v.ten_vt.toLowerCase().includes(vtModalQ.toLowerCase()))
      : vtInDanhSach

    return (
      <div className="screen" style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
        <div className="topbar">
          <div className="topbar-title">Danh sách đã nhập</div>
          <div className="topbar-sub">{danhSachLoc.length}/{danhSach.length} dòng · Lượt {luotKiem}</div>
        </div>

        {/* Toolbar */}
        <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', background: '#fff', display: 'flex', gap: 8 }}>
          <button className="btn-secondary" onClick={() => { setXemDanhSach(false); setCheckedIds(new Set()); setConfirmDeleteChecked(false) }}
            style={{ flex: 1, color: 'var(--green-dark)', borderColor: 'var(--green)', fontWeight: 600, height: 36 }}>
            ← Quay lại
          </button>
          <button className="btn-filter-toggle" onClick={() => setShowListFilter(v => !v)}
            style={{ height: 36 }}>
            Lọc {hasFilter ? '●' : ''}{showListFilter ? ' ▲' : ' ▼'}
          </button>
        </div>

        {/* Filter panel */}
        {showListFilter && (
          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', background: '#F9FAFB', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <div className="field-label">Kho</div>
                <div className="input-select" onClick={() => { setKhoFilterQ(''); setKhoFilterSel(xemFilter.kho); setOpenKhoFilter(true) }}
                  style={{ cursor: 'pointer', color: xemFilter.kho.length ? 'var(--text)' : 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {xemFilter.kho.length === 0
                    ? 'Tất cả kho'
                    : xemFilter.kho.length === 1
                      ? (khoInDanhSach.find(k => k.ma_kho === xemFilter.kho[0])?.ten_kho || xemFilter.kho[0])
                      : `${khoInDanhSach.find(k => k.ma_kho === xemFilter.kho[0])?.ten_kho || xemFilter.kho[0]} +${xemFilter.kho.length - 1}`}
                </div>
              </div>
              <div style={{ flex: 1 }}>
                <div className="field-label">ĐVT phụ</div>
                <div className="input-select" onClick={() => { setDvtFilterQ(''); setDvtFilterSel(xemFilter.dvt); setOpenDvtFilter(true) }}
                  style={{ cursor: 'pointer', color: xemFilter.dvt.length ? 'var(--text)' : 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {xemFilter.dvt.length === 0
                    ? 'Tất cả ĐVT'
                    : xemFilter.dvt.length === 1
                      ? (dvtInDanhSach.find(d => d.ma_dvt === xemFilter.dvt[0])?.ten_dvt || xemFilter.dvt[0])
                      : `${dvtInDanhSach.find(d => d.ma_dvt === xemFilter.dvt[0])?.ten_dvt || xemFilter.dvt[0]} +${xemFilter.dvt.length - 1}`}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 2 }}>
                <div className="field-label">Mã / tên vật tư</div>
                <div className="input-select" onClick={() => { setVtModalQ(''); setVtModalSel(xemFilter.vatTu); setOpenVtModal(true) }}
                  style={{ cursor: 'pointer', color: xemFilter.vatTu.length ? 'var(--text)' : 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {xemFilter.vatTu.length === 0
                    ? 'Tất cả vật tư'
                    : xemFilter.vatTu.length === 1
                      ? (vtInDanhSach.find(v => v.ma_vt === xemFilter.vatTu[0])?.ten_vt || xemFilter.vatTu[0])
                      : `${vtInDanhSach.find(v => v.ma_vt === xemFilter.vatTu[0])?.ten_vt || xemFilter.vatTu[0]} +${xemFilter.vatTu.length - 1}`}
                </div>
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
                onClick={() => setXemFilter({ kho: [], vatTu: [], soLuong: '', dvt: [] })}>
                Xóa lọc
              </button>
            )}
          </div>
        )}

        {/* Selection bar */}
        {checkedIds.size > 0 && (
          confirmDeleteChecked ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', background: '#FEF2F2', borderBottom: '1px solid #FECACA' }}>
              <span style={{ flex: 1, fontSize: 13, color: '#991B1B', fontWeight: 500 }}>Xóa {checkedIds.size} dòng đã chọn?</span>
              <button onClick={handleDeleteChecked}
                style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#EF4444', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                Xóa
              </button>
              <button onClick={() => setConfirmDeleteChecked(false)}
                style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border)', background: '#fff', fontSize: 13, cursor: 'pointer' }}>
                Hủy
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', background: '#F0FDF4', borderBottom: '1px solid #D1FAE5' }}>
              <span style={{ flex: 1, fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>Đã chọn {checkedIds.size} dòng</span>
              <button onClick={() => setCheckedIds(new Set())}
                style={{ border: 'none', background: 'none', color: 'var(--text-muted)', fontSize: 13, cursor: 'pointer', padding: 0 }}>
                Bỏ chọn
              </button>
              <button onClick={() => setConfirmDeleteChecked(true)}
                style={{ border: 'none', background: 'none', color: '#DC2626', fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: 0 }}>
                Xóa đã chọn ({checkedIds.size})
              </button>
            </div>
          )
        )}

        {/* Danh sách */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px' }}>
          {danhSachLoc.length === 0 && (
            <div className="empty-state">{hasFilter ? 'Không có kết quả phù hợp' : 'Chưa có dòng nào được nhập'}</div>
          )}
          {danhSachLoc.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', padding: '8px 0', borderBottom: '2px solid var(--border)' }}>
              <input type="checkbox"
                checked={danhSachLoc.every(r => checkedIds.has(r.id))}
                onChange={e => {
                  if (e.target.checked) setCheckedIds(new Set(danhSachLoc.map(r => r.id)))
                  else setCheckedIds(new Set())
                }}
                style={{ marginRight: 10 }} />
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Chọn tất cả ({danhSachLoc.length})</span>
            </div>
          )}
          {danhSachLoc.map(item => (
            <div key={item.id} style={{ display: 'flex', alignItems: 'flex-start', borderBottom: '1px solid var(--border)', background: checkedIds.has(item.id) ? '#F0FDF4' : 'transparent' }}>
              <div style={{ paddingTop: 13, paddingRight: 8, flexShrink: 0 }}>
                <input type="checkbox" checked={checkedIds.has(item.id)}
                  onChange={e => setCheckedIds(prev => {
                    const next = new Set(prev)
                    e.target.checked ? next.add(item.id) : next.delete(item.id)
                    return next
                  })} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                {renderItemRow(item, (
                  <div style={{ display: 'flex', gap: 2 }}>
                    <button
                      onClick={() => { setEditItem(item); setEditForm({ so_luong_thuc_te: item.so_luong_thuc_te, ma_dvt_kiem: item.ma_dvt_kiem, he_so_quy_doi: item.he_so_quy_doi ?? 1, ghi_chu: item.ghi_chu ?? '', ma_kho: item.ma_kho ?? '' }) }}
                      style={{ border: 'none', background: 'none', fontSize: 15, cursor: 'pointer', padding: '2px 5px', color: '#1a56db', lineHeight: 1 }}
                      title="Sửa">✏️</button>
                    <button
                      onClick={() => handleDeleteItem(item.id)}
                      style={{ border: 'none', background: 'none', fontSize: 15, cursor: 'pointer', padding: '2px 5px', color: '#DC2626', lineHeight: 1 }}
                      title="Xóa">🗑️</button>
                  </div>
                ))}
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
              <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                <div className="field-group" style={{ flex: 1, marginBottom: 0 }}>
                  <label className="field-label">Kho</label>
                  <select className="input-select" value={editForm.ma_kho}
                    onChange={e => setEditForm(f => ({ ...f, ma_kho: e.target.value }))}>
                    <option value="">-- Chọn kho --</option>
                    {danhMucKho.map(k => <option key={k.ma_kho} value={k.ma_kho}>{k.ten_kho}</option>)}
                  </select>
                </div>
                <div className="field-group" style={{ flex: 1, marginBottom: 0 }}>
                  <label className="field-label">Ghi chú</label>
                  <input type="text" className="input-field" value={editForm.ghi_chu}
                    onChange={e => setEditForm(f => ({ ...f, ghi_chu: e.target.value }))} placeholder="Ghi chú..." />
                </div>
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

      {openKhoFilter && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: '#fff', display: 'flex', flexDirection: 'column', maxWidth: 480, margin: '0 auto' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <span style={{ fontWeight: 600, fontSize: 15 }}>Kho</span>
              <div style={{ display: 'flex', gap: 16 }}>
                <button onClick={() => setKhoFilterSel([])}
                  style={{ border: 'none', background: 'none', color: 'var(--text-muted)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Xóa chọn</button>
                <button onClick={() => { setXemFilter(f => ({ ...f, kho: khoFilterSel })); setOpenKhoFilter(false) }}
                  style={{ border: 'none', background: 'none', color: 'var(--green)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Xong</button>
              </div>
            </div>
            <input type="text" className="input-field" placeholder="Tìm kho..."
              value={khoFilterQ} onChange={e => setKhoFilterQ(e.target.value)}
              style={{ margin: 0 }} autoFocus />
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {khoFilterResults.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>Không tìm thấy</div>
            ) : khoFilterResults.map(k => {
              const checked = khoFilterSel.includes(k.ma_kho)
              return (
                <div key={k.ma_kho}
                  onClick={() => setKhoFilterSel(prev => checked ? prev.filter(x => x !== k.ma_kho) : [...prev, k.ma_kho])}
                  style={{ padding: '14px 16px', borderBottom: '1px solid #F3F4F6', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 20, height: 20, borderRadius: 4, border: `2px solid ${checked ? 'var(--green)' : '#CBD5E1'}`, background: checked ? 'var(--green)' : '#fff', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {checked && <span style={{ color: '#fff', fontSize: 13, lineHeight: 1 }}>✓</span>}
                  </div>
                  <span style={{ background: '#E6F4EF', color: 'var(--green)', borderRadius: 6, padding: '2px 7px', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>{k.ma_kho}</span>
                  <span style={{ fontSize: 14 }}>{k.ten_kho}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {openDvtFilter && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: '#fff', display: 'flex', flexDirection: 'column', maxWidth: 480, margin: '0 auto' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <span style={{ fontWeight: 600, fontSize: 15 }}>ĐVT phụ</span>
              <div style={{ display: 'flex', gap: 16 }}>
                <button onClick={() => setDvtFilterSel([])}
                  style={{ border: 'none', background: 'none', color: 'var(--text-muted)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Xóa chọn</button>
                <button onClick={() => { setXemFilter(f => ({ ...f, dvt: dvtFilterSel })); setOpenDvtFilter(false) }}
                  style={{ border: 'none', background: 'none', color: 'var(--green)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Xong</button>
              </div>
            </div>
            <input type="text" className="input-field" placeholder="Tìm đơn vị tính..."
              value={dvtFilterQ} onChange={e => setDvtFilterQ(e.target.value)}
              style={{ margin: 0 }} autoFocus />
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {dvtFilterResults.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>Không tìm thấy</div>
            ) : dvtFilterResults.map(d => {
              const checked = dvtFilterSel.includes(d.ma_dvt)
              return (
                <div key={d.ma_dvt}
                  onClick={() => setDvtFilterSel(prev => checked ? prev.filter(x => x !== d.ma_dvt) : [...prev, d.ma_dvt])}
                  style={{ padding: '14px 16px', borderBottom: '1px solid #F3F4F6', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 20, height: 20, borderRadius: 4, border: `2px solid ${checked ? 'var(--green)' : '#CBD5E1'}`, background: checked ? 'var(--green)' : '#fff', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {checked && <span style={{ color: '#fff', fontSize: 13, lineHeight: 1 }}>✓</span>}
                  </div>
                  <span style={{ fontSize: 14 }}>{d.ten_dvt}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {openVtModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: '#fff', display: 'flex', flexDirection: 'column', maxWidth: 480, margin: '0 auto' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <span style={{ fontWeight: 600, fontSize: 15 }}>Vật tư</span>
              <div style={{ display: 'flex', gap: 16 }}>
                <button onClick={() => setVtModalSel([])}
                  style={{ border: 'none', background: 'none', color: 'var(--text-muted)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Xóa chọn</button>
                <button onClick={() => { setXemFilter(f => ({ ...f, vatTu: vtModalSel })); setOpenVtModal(false) }}
                  style={{ border: 'none', background: 'none', color: 'var(--green)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Xong</button>
              </div>
            </div>
            <input type="text" className="input-field"
              placeholder="Tìm mã hoặc tên vật tư"
              value={vtModalQ} onChange={e => setVtModalQ(e.target.value)}
              style={{ margin: 0 }} autoFocus />
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {vtModalResults.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>Không tìm thấy</div>
            ) : vtModalResults.map(v => {
              const checked = vtModalSel.includes(v.ma_vt)
              return (
                <div key={v.ma_vt}
                  onClick={() => setVtModalSel(prev => checked ? prev.filter(x => x !== v.ma_vt) : [...prev, v.ma_vt])}
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
        <button className="btn-secondary" onClick={() => navigate('/')}
          style={{ flex: 1, height: 40 }}>
          Hủy
        </button>
        <button className="btn-secondary" onClick={handleHuy} disabled={saving}
          style={{ flex: 1, height: 40 }}>
          Xóa
        </button>
        <button className="btn-primary" onClick={handleLuu}
          style={{ flex: 2, height: 40 }}
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
          <div onClick={() => { setOpenKhoModal(true); setTimeout(() => khoSearchRef.current?.focus(), 100) }}
            style={{
              flex: 1, padding: '0 12px', border: '1.5px solid var(--border)',
              borderRadius: 10, fontSize: 15, background: '#fff',
              color: maKhoHienTai ? 'var(--text)' : 'var(--text-muted)',
              cursor: 'pointer', height: 40, display: 'flex', alignItems: 'center'
            }}>
            {maKhoHienTai ? khoMap[maKhoHienTai] || maKhoHienTai : 'Chọn kho...'}
          </div>
          <button onClick={() => navigate(`/dem-lai/${phienId}`)}
            style={{ flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--green)', fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap', padding: 0 }}>
            ✓ Đếm lại
          </button>
        </div>

        {/* Fullscreen modal chọn kho */}
        {openKhoModal && (
          <div style={{
            position: 'fixed', inset: 0, zIndex: 300,
            background: '#fff', display: 'flex', flexDirection: 'column',
            maxWidth: 480, margin: '0 auto'
          }}>
            <div style={{
              padding: '10px 12px', display: 'flex', gap: 8, alignItems: 'center',
              borderBottom: '1px solid var(--border)', background: '#fff', flexShrink: 0
            }}>
              <input
                ref={khoSearchRef}
                type="text"
                className="input-field"
                placeholder="Tìm kho..."
                value={khoQuery}
                onChange={e => setKhoQuery(e.target.value)}
                style={{ flex: 1, margin: 0 }}
              />
              <button onClick={() => { setKhoQuery(''); khoSearchRef.current?.focus() }} style={{
                padding: '8px 12px', border: 'none', background: 'none',
                color: 'var(--text-muted)', fontSize: 15, cursor: 'pointer', flexShrink: 0
              }}>Xóa</button>
              <button onClick={() => { setOpenKhoModal(false); setKhoQuery('') }} style={{
                padding: '8px 12px', border: 'none', background: 'none',
                color: 'var(--text-muted)', fontSize: 15, cursor: 'pointer', flexShrink: 0
              }}>Hủy</button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {danhMucKho
                .filter(k => !khoQuery.trim() || k.ten_kho.toLowerCase().includes(khoQuery.toLowerCase()) || k.ma_kho.toLowerCase().includes(khoQuery.toLowerCase()))
                .map(k => (
                  <div key={k.ma_kho} onClick={() => handleSelectKho(k.ma_kho)} style={{
                    padding: '14px 16px', borderBottom: '1px solid #F3F4F6',
                    cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10,
                    background: k.ma_kho === maKhoHienTai ? '#F0FDF4' : '#fff'
                  }}>
                    <span style={{
                      background: '#E6F4EF', color: 'var(--green)', borderRadius: 6,
                      padding: '2px 7px', fontSize: 12, fontWeight: 700, flexShrink: 0
                    }}>{k.ma_kho}</span>
                    <span style={{ fontSize: 15, fontWeight: k.ma_kho === maKhoHienTai ? 600 : 400 }}>{k.ten_kho}</span>
                    {k.ma_kho === maKhoHienTai && <span style={{ marginLeft: 'auto', color: 'var(--green)', fontSize: 18 }}>✓</span>}
                  </div>
                ))
              }
            </div>
          </div>
        )}

        {/* Chọn mã vật tư */}
        {vatTuCoDinh ? (
          <div className="autofill-chip">
            <div style={{ flex: 1 }}>
              <div className="chip-name">{vatTuCoDinh.ma_vt} · {vatTuCoDinh.ten_vt}</div>
              <div className="chip-meta">Đang đếm mã này</div>
            </div>
            <button className="chip-change" onClick={() => { setAutoOpenVt(true); handleChonVatTuCoDinh(null) }}>
              Đổi mã
            </button>
          </div>
        ) : (
          <ChonVatTu value={null} autoOpen={autoOpenVt}
            onSelect={vt => { setAutoOpenVt(false); handleChonVatTuCoDinh(vt) }} />
        )}

        {/* Hàng 1: Số lượng + ĐVT + Hệ số */}
        <div style={{ display: 'flex', gap: 8 }}>
          <div className="field-group" style={{ flex: 1 }}>
            <label className="field-label">Số lượng thực tế</label>
            <input
              ref={soLuongRef}
              type="text" inputMode="decimal" className="input-field input-large"
              value={soLuong}
              onChange={e => setSoLuong(e.target.value.replace(/[^\d.]/g, ''))}
              onBlur={() => {
                const n = parseFloat(soLuong)
                if (!isNaN(n)) setSoLuong(fmtSL(n))
              }}
              onFocus={() => setSoLuong(soLuong.replace(/,/g, ''))}
              placeholder="0"
            />
          </div>
          <div className="field-group" style={{ flex: 1 }}>
            <label className="field-label">ĐVT</label>
            <div onClick={() => { setOpenDvtModal(true); setTimeout(() => dvtSearchRef.current?.focus(), 100) }}
              style={{
                padding: '10px 12px', border: '1.5px solid var(--border)',
                borderRadius: 10, fontSize: 15, background: '#fff',
                color: dvt ? 'var(--text)' : 'var(--text-muted)',
                cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center'
              }}>
              {dvt ? (danhMucDvt.find(d => d.ma_dvt === dvt)?.ten_dvt || dvt) : 'Chọn...'}
            </div>
          </div>

          {openDvtModal && (
            <div style={{
              position: 'fixed', inset: 0, zIndex: 300,
              background: '#fff', display: 'flex', flexDirection: 'column',
              maxWidth: 480, margin: '0 auto'
            }}>
              <div style={{
                padding: '10px 12px', display: 'flex', gap: 8, alignItems: 'center',
                borderBottom: '1px solid var(--border)', background: '#fff', flexShrink: 0
              }}>
                <input
                  ref={dvtSearchRef}
                  type="text"
                  className="input-field"
                  placeholder="Tìm đơn vị tính..."
                  value={dvtQuery}
                  onChange={e => setDvtQuery(e.target.value)}
                  style={{ flex: 1, margin: 0 }}
                />
                <button onClick={() => { setDvtQuery(''); dvtSearchRef.current?.focus() }} style={{
                  padding: '8px 12px', border: 'none', background: 'none',
                  color: 'var(--text-muted)', fontSize: 15, cursor: 'pointer', flexShrink: 0
                }}>Xóa</button>
                <button onClick={() => { setOpenDvtModal(false); setDvtQuery('') }} style={{
                  padding: '8px 12px', border: 'none', background: 'none',
                  color: 'var(--text-muted)', fontSize: 15, cursor: 'pointer', flexShrink: 0
                }}>Hủy</button>
              </div>
              <div style={{ flex: 1, overflowY: 'auto' }}>
                {danhMucDvt
                  .filter(d => !dvtQuery.trim() || d.ten_dvt.toLowerCase().includes(dvtQuery.toLowerCase()) || d.ma_dvt.toLowerCase().includes(dvtQuery.toLowerCase()))
                  .map(d => (
                    <div key={d.ma_dvt} onClick={() => { setDvt(d.ma_dvt); setOpenDvtModal(false); setDvtQuery('') }} style={{
                      padding: '14px 16px', borderBottom: '1px solid #F3F4F6',
                      cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10,
                      background: d.ma_dvt === dvt ? '#F0FDF4' : '#fff'
                    }}>
                      <span style={{
                        background: '#E6F4EF', color: 'var(--green)', borderRadius: 6,
                        padding: '2px 7px', fontSize: 12, fontWeight: 700, flexShrink: 0
                      }}>{d.ma_dvt}</span>
                      <span style={{ fontSize: 15, fontWeight: d.ma_dvt === dvt ? 600 : 400 }}>{d.ten_dvt}</span>
                      {d.ma_dvt === dvt && <span style={{ marginLeft: 'auto', color: 'var(--green)', fontSize: 18 }}>✓</span>}
                    </div>
                  ))
                }
              </div>
            </div>
          )}
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
              {soQuyDoi ? `${fmtSL(soQuyDoi)} ${dvtChinh}` : '—'}
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
              {chenhLech !== null ? (parseFloat(chenhLech) > 0 ? '+' : '') + fmtSL(chenhLech) : '—'}
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
