// src/screens/KiemKe.jsx
import { useState, useEffect } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { db, saveChiTietLocal, getSoSach } from '../lib/db'
import { supabase } from '../lib/supabase'
import { pushOfflineQueue } from '../lib/sync'
import ChonVatTu from '../components/ChonVatTu'

const CHE_DO = { MOT_MA: '1_ma', NHIEU_MA: 'nhieu_ma' }

export default function KiemKe({ currentUser }) {
  const { phienId } = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [phien, setPhien] = useState(null)
  const [tenKho, setTenKho] = useState('')
  const [tenDoiTac, setTenDoiTac] = useState('')
  const [cheDoc, setCheDoc] = useState(
    searchParams.get('mode') === '1_ma' ? CHE_DO.MOT_MA : CHE_DO.NHIEU_MA
  )
  const [danhSach, setDanhSach] = useState([])   // các dòng đã nhập

  // Form state
  const [vatTu, setVatTu] = useState(null)       // { ma_vt, ten_vt }
  const [vatTuCoDinh, setVatTuCoDinh] = useState(null) // chế độ 1 mã
  const [dvt, setDvt] = useState('')
  const [heSo, setHeSo] = useState(1)
  const [soLuong, setSoLuong] = useState('')
  const [luotKiem, setLuotKiem] = useState(1)
  const [ghiChu, setGhiChu] = useState('')
  const [soSach, setSoSach] = useState(null)
  const [saving, setSaving] = useState(false)
  const [danhMucDvt, setDanhMucDvt] = useState([])
  const [dvtChinhMap, setDvtChinhMap] = useState({}) // ma_vt → ma_dvt_chinh

  // Load phiên + danh mục
  useEffect(() => {
    async function load() {
      const p = await db.phien.get(phienId)
      if (!p) return
      setPhien(p)

      const [kho, doiTac, dvtList] = await Promise.all([
        db.dm_kho.get(p.ma_kho),
        db.dm_user.get(currentUser.role === 'ke_toan' ? p.thu_kho_id : p.ke_toan_id),
        db.dm_dvt.toArray()
      ])
      setTenKho(kho?.ten_kho || p.ma_kho)
      setTenDoiTac(doiTac?.ho_ten || '')
      setDanhMucDvt(dvtList)

      // Fetch dm_vat_tu để lấy ma_dvt_chinh — ưu tiên Supabase nếu online
      if (navigator.onLine) {
        const { data } = await supabase.from('dm_vat_tu').select('ma_vt, ma_dvt_chinh').eq('active', true)
        if (data?.length) {
          const map = {}
          data.forEach(v => { if (v.ma_dvt_chinh) map[v.ma_vt] = v.ma_dvt_chinh })
          setDvtChinhMap(map)
        }
      } else {
        const vtList = await db.dm_vat_tu.toArray()
        const map = {}
        vtList.forEach(v => { if (v.ma_dvt_chinh) map[v.ma_vt] = v.ma_dvt_chinh })
        setDvtChinhMap(map)
      }

      await loadDanhSach()

      // Lấy lượt kiểm gần nhất
      const lastLuot = await db.chitiet
        .where('phien_id').equals(phienId)
        .last()
      if (lastLuot) setLuotKiem(lastLuot.luot_kiem)
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
      .sortBy('created_at')
    setDanhSach(rows.reverse())
  }

  // Khi chọn vật tư → lookup sổ sách + tự điền DVT chính, reset hệ số + số lượng
  async function handleChonVatTu(vt) {
    if (!vt) { setVatTu(null); setSoSach(null); setDvt(''); setHeSo(1); setSoLuong(''); return }
    setVatTu(vt)
    const ss = await getSoSach(vt.ma_vt, phien?.ma_kho)
    setSoSach(ss)
    if (dvtChinhMap[vt.ma_vt]) setDvt(dvtChinhMap[vt.ma_vt])
    setHeSo(1)
    setSoLuong('')
  }

  // Chọn mã cố định (chế độ 1 mã nhiều lần)
  async function handleChonVatTuCoDinh(vt) {
    setVatTuCoDinh(vt)
    setVatTu(vt)
    if (vt) {
      const ss = await getSoSach(vt.ma_vt, phien?.ma_kho)
      setSoSach(ss)
      if (dvtChinhMap[vt.ma_vt]) setDvt(dvtChinhMap[vt.ma_vt])
      setHeSo(1)
    } else {
      setDvt('')
      setHeSo(1)
    }
    setSoLuong('')
    setGhiChu('')
  }

  async function handleLuu() {
    const vtHienTai = cheDoc === CHE_DO.MOT_MA ? vatTuCoDinh : vatTu
    if (!vtHienTai || !soLuong) return
    setSaving(true)

    await saveChiTietLocal({
      id: crypto.randomUUID(),
      phien_id: phienId,
      ma_vt: vtHienTai.ma_vt,
      ten_vt: vtHienTai.ten_vt,
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

    // Reset form
    setSoLuong('')
    setGhiChu('')
    if (cheDoc === CHE_DO.NHIEU_MA) {
      setVatTu(null)
      setSoSach(null)
    }
    setSaving(false)
  }

  function handleHuy() {
    setSoLuong('')
    setGhiChu('')
    if (cheDoc === CHE_DO.NHIEU_MA) {
      setVatTu(null)
      setSoSach(null)
      setDvt('')
      setHeSo(1)
    }
  }

  const vtHienTai = cheDoc === CHE_DO.MOT_MA ? vatTuCoDinh : vatTu
  const dvtChinh = vtHienTai ? (dvtChinhMap[vtHienTai.ma_vt] || '') : ''
  const soQuyDoi = soLuong ? (parseFloat(soLuong) * (parseFloat(heSo) || 1)).toFixed(3) : null
  const chenhLech = soQuyDoi && soSach !== null ? (parseFloat(soQuyDoi) - soSach).toFixed(3) : null

  // Lọc danh sách theo chế độ 1 mã
  const danhSachHienThi = cheDoc === CHE_DO.MOT_MA && vatTuCoDinh
    ? danhSach.filter(d => d.ma_vt === vatTuCoDinh.ma_vt)
    : danhSach.slice(0, 20)

  return (
    <div className="screen">
      {/* Topbar */}
      <div className="topbar">
        <div className="topbar-title">{tenKho}</div>
        <div className="topbar-sub">
          {currentUser.ho_ten} + {tenDoiTac} · Lượt {luotKiem}
        </div>
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

        {/* Toggle chế độ */}
        <div className="mode-toggle">
          <button
            className={`mode-tab ${cheDoc === CHE_DO.MOT_MA ? 'active' : ''}`}
            onClick={() => { setCheDoc(CHE_DO.MOT_MA); setVatTu(null); setSoSach(null); setDvt('') }}
          >
            📦 1 mã nhiều lần
          </button>
          <button
            className={`mode-tab ${cheDoc === CHE_DO.NHIEU_MA ? 'active' : ''}`}
            onClick={() => { setCheDoc(CHE_DO.NHIEU_MA); setVatTuCoDinh(null); setVatTu(null); setSoSach(null); setDvt('') }}
          >
            📋 Nhiều mã 1 lần
          </button>
          <button
            className="mode-tab"
            onClick={() => navigate(`/dem-lai/${phienId}`)}
          >
            ✓ Đếm lại
          </button>
        </div>

        {/* Chế độ 1 mã nhiều lần: chip mã cố định */}
        {cheDoc === CHE_DO.MOT_MA && (
          vatTuCoDinh ? (
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
          )
        )}

        {/* Chế độ nhiều mã: chọn mỗi dòng */}
        {cheDoc === CHE_DO.NHIEU_MA && (
          <ChonVatTu value={vatTu} onSelect={handleChonVatTu} />
        )}

        {/* Hàng 1: Số lượng + ĐVT */}
        <div className="row-2col">
          <div className="field-group">
            <label className="field-label">Số lượng thực tế</label>
            <input
              type="number" className="input-field input-large"
              value={soLuong} onChange={e => setSoLuong(e.target.value)}
              placeholder="0" min="0" step="any" autoFocus
            />
          </div>
          <div className="field-group">
            <label className="field-label">ĐVT</label>
            <select className="input-select" value={dvt} onChange={e => setDvt(e.target.value)}>
              <option value="">-- Chọn --</option>
              {danhMucDvt.map(d => (
                <option key={d.ma_dvt} value={d.ma_dvt}>{d.ten_dvt}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Hàng 2: Hệ số + Quy đổi */}
        <div className="row-2col">
          <div className="field-group">
            <label className="field-label">Hệ số</label>
            <input type="number" className="input-field" value={heSo}
              onChange={e => setHeSo(e.target.value)} min="0" step="any" />
          </div>
          <div className="field-group">
            <label className="field-label">Quy đổi</label>
            <div className="input-readonly">
              {soQuyDoi ? `${soQuyDoi} ${dvtChinh}` : '—'}
            </div>
          </div>
        </div>

        {/* Hàng 3: Lượt kiểm + Chênh lệch */}
        <div className="row-2col">
          <div className="field-group">
            <label className="field-label">Lượt kiểm</label>
            <input type="number" className="input-field" value={luotKiem}
              onChange={e => setLuotKiem(parseInt(e.target.value))} min="1" />
          </div>
          <div className="field-group">
            <label className="field-label">Chênh lệch</label>
            <div className={`input-readonly ${!chenhLech ? '' : parseFloat(chenhLech) < 0 ? 'text-danger' : parseFloat(chenhLech) > 0 ? 'text-warn' : 'text-ok'}`}>
              {chenhLech !== null ? (parseFloat(chenhLech) > 0 ? '+' : '') + chenhLech : '—'}
            </div>
          </div>
        </div>

        {/* Ghi chú */}
        <div className="field-group">
          <label className="field-label">Ghi chú</label>
          <input type="text" className="input-field" value={ghiChu}
            onChange={e => setGhiChu(e.target.value)} placeholder="Nhập ghi chú..." />
        </div>

        <div className="row-2col">
          <button className="btn-secondary" onClick={handleHuy} disabled={saving}>
            Hủy
          </button>
          <button className="btn-primary" onClick={handleLuu}
            disabled={!vtHienTai || !soLuong || saving || phien?.xac_nhan_ke_toan || phien?.xac_nhan_thu_kho}>
            {saving ? 'Đang lưu...' : cheDoc === CHE_DO.MOT_MA
              ? '+ Lưu & đếm tiếp'
              : '+ Lưu & tiếp theo'}
          </button>
        </div>

        {/* Danh sách đã nhập */}
        {danhSachHienThi.length > 0 && (
          <>
            <div className="divider" />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <div className="section-title" style={{ marginBottom: 0 }}>
                {cheDoc === CHE_DO.MOT_MA && vatTuCoDinh
                  ? `Đã đếm ${vatTuCoDinh.ma_vt} — lượt ${luotKiem}`
                  : `Đã nhập lượt ${luotKiem}`}
              </div>
              <span className="lot-tag">{danhSach.length} dòng</span>
            </div>
            {danhSachHienThi.map(item => (
              <div key={item.id} className="item-row">
                <div className="item-info">
                  <div className="item-name">
                    {cheDoc === CHE_DO.NHIEU_MA && <span className="item-code">{item.ma_vt} · </span>}
                    {item.so_luong_thuc_te} {item.ma_dvt_kiem}
                    {cheDoc === CHE_DO.NHIEU_MA && ` · ${item.ten_vt}`}
                  </div>
                  <div className="item-meta">
                    {new Date(item.created_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
                    {item.ghi_chu ? ` · ${item.ghi_chu}` : ''}
                    {!item.synced && ' · ⏳'}
                  </div>
                </div>
                <span className="lot-tag">Lượt {item.luot_kiem}</span>
              </div>
            ))}
          </>
        )}

      </div>
    </div>
  )
}
