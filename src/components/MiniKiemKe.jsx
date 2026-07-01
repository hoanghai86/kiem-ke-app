import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { db, saveChiTietLocal, getSoSach } from '../lib/db'
import { pushOfflineQueue } from '../lib/sync'
import { fmtSL, toSearchable } from '../lib/utils'

export default function MiniKiemKe({
  vt,           // { ma_vt, ten_vt }
  initKho,      // ma_kho pre-filled
  soSachInit,   // so_luong_so_sach từ dòng đang chọn
  phienId,
  currentUser,
  khoList,
  danhMucDvt,
  dvtChinhMap,  // ma_vt → ma_dvt_chinh
  dvtMap,       // ma_dvt → ten_dvt
  onHuy,
  onSaved,
  onDoiPhien,   // nếu có nhiều phiên → cho phép đổi phiên
  phienInfo,    // chuỗi hiển thị phiên đang chọn
}) {
  const navigate = useNavigate()
  const soLuongRef = useRef(null)
  const khoSearchRef = useRef(null)
  const dvtSearchRef = useRef(null)

  const initDvt = dvtChinhMap[vt.ma_vt] || ''

  const [maKho, setMaKho]         = useState(initKho || '')
  const [soLuong, setSoLuong]     = useState('')
  const [dvt, setDvt]             = useState(initDvt)
  const [heSo, setHeSo]           = useState('1')
  const [luotKiem, setLuotKiem]   = useState(1)
  const [ghiChu, setGhiChu]       = useState('')
  const [soSach, setSoSach]       = useState(soSachInit ?? null)
  const [tongKiem, setTongKiem]   = useState(null)
  const [saving, setSaving]       = useState(false)
  const [openKhoModal, setOpenKhoModal] = useState(false)
  const [khoQuery, setKhoQuery]   = useState('')
  const [openDvtModal, setOpenDvtModal] = useState(false)
  const [dvtQuery, setDvtQuery]   = useState('')

  const [keyboardOffset, setKeyboardOffset] = useState(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () => setKeyboardOffset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop))
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update) }
  }, [])

  useEffect(() => {
    db.chitiet.where('phien_id').equals(phienId).last()
      .then(r => { if (r) setLuotKiem(r.luot_kiem) })
    loadTongKiem(maKho)
    setTimeout(() => soLuongRef.current?.focus(), 200)
  }, [])

  async function loadTongKiem(kho) {
    if (!kho) { setTongKiem(null); return }
    const rows = await db.chitiet
      .where('phien_id').equals(phienId)
      .filter(r => r.ma_vt === vt.ma_vt && r.ma_kho === kho)
      .toArray()
    const total = rows.reduce((s, r) => s + (r.so_luong_quy_doi ?? (parseFloat(r.so_luong_thuc_te) * (r.he_so_quy_doi || 1))), 0)
    setTongKiem(total)
  }

  async function handleSelectKho(newKho) {
    setMaKho(newKho)
    setOpenKhoModal(false)
    setKhoQuery('')
    const ss = await getSoSach(vt.ma_vt, newKho)
    setSoSach(ss)
    loadTongKiem(newKho)
  }

  function handleXoa() {
    setSoLuong('')
    setHeSo('1')
    setGhiChu('')
    setDvt(initDvt)
    setTimeout(() => soLuongRef.current?.focus(), 50)
  }

  async function handleLuu() {
    if (!soLuong || !maKho) return
    setSaving(true)
    await saveChiTietLocal({
      id: crypto.randomUUID(),
      phien_id: phienId,
      ma_vt: vt.ma_vt,
      ten_vt: vt.ten_vt,
      ma_kho: maKho,
      ma_dvt_kiem: dvt,
      he_so_quy_doi: parseFloat(heSo) || 1,
      luot_kiem: luotKiem,
      so_luong_thuc_te: parseFloat(soLuong.replace(/,/g, '')),
      so_luong_so_sach: soSach,
      ghi_chu: ghiChu,
      hinh_anh_urls: [],
      da_doi_chieu: false,
      nguoi_nhap_id: currentUser.id,
      ngoai_so_sach: false,
    })
    if (navigator.onLine) pushOfflineQueue()
    onSaved?.()
    setSoLuong('')
    setGhiChu('')
    setHeSo('1')
    setSaving(false)
    await loadTongKiem(maKho)
    setTimeout(() => soLuongRef.current?.focus(), 50)
  }

  const khoMap    = Object.fromEntries(khoList.map(k => [k.ma_kho, k.ten_kho]))
  const dvtChinh  = dvtChinhMap[vt.ma_vt] || ''
  const dvtTenChinh = dvtMap[dvtChinh] || dvtChinh
  const soQuyDoi  = soLuong ? parseFloat(soLuong.replace(/,/g, '')) * (parseFloat(heSo) || 1) : null
  const lech      = tongKiem !== null && soSach !== null ? tongKiem - soSach : null

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: '#fff', display: 'flex', flexDirection: 'column', maxWidth: 480, margin: '0 auto' }}>
      <div className="topbar">
        <div className="topbar-title">{vt.ma_vt} · {vt.ten_vt}</div>
        <div onClick={onDoiPhien || undefined} style={{ marginTop: 2, cursor: onDoiPhien ? 'pointer' : 'default', display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.9)', fontWeight: 600, textDecoration: onDoiPhien ? 'underline' : 'none', textUnderlineOffset: 3 }}>
            {phienInfo?.label || 'Nhập kiểm kê'}
          </span>
          {phienInfo && (phienInfo.kt || phienInfo.tk) && (
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>
              {[phienInfo.kt && `KT: ${phienInfo.kt}`, phienInfo.tk && `TK: ${phienInfo.tk}`].filter(Boolean).join(' · ')}
            </span>
          )}
          {onDoiPhien && <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.55)' }}>▾</span>}
        </div>
      </div>

      <div className="content" style={{ paddingBottom: 100 }}>
        {/* Kho + Đếm lại */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
          <div onClick={() => { setOpenKhoModal(true); setTimeout(() => khoSearchRef.current?.focus(), 100) }}
            style={{ flex: 1, padding: '0 12px', border: '1.5px solid var(--border)', borderRadius: 10, fontSize: 15, background: '#fff', color: maKho ? 'var(--text)' : 'var(--text-muted)', cursor: 'pointer', height: 40, display: 'flex', alignItems: 'center' }}>
            {maKho ? khoMap[maKho] || maKho : 'Chọn kho...'}
          </div>
          <button onClick={() => navigate(`/dem-lai/${phienId}`)}
            style={{ flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--green)', fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap', padding: 0 }}>
            ✓ Đếm lại
          </button>
        </div>

        {/* SL + ĐVT + Hệ số */}
        <div style={{ display: 'flex', gap: 8 }}>
          <div className="field-group" style={{ flex: 1 }}>
            <label className="field-label">Số lượng thực tế</label>
            <input ref={soLuongRef} type="text" inputMode="decimal" className="input-field input-large"
              value={soLuong} onChange={e => setSoLuong(e.target.value.replace(/[^\d.]/g, ''))}
              onBlur={() => { const n = parseFloat(soLuong); if (!isNaN(n)) setSoLuong(fmtSL(n)) }}
              onFocus={() => setSoLuong(soLuong.replace(/,/g, ''))}
              placeholder="0" />
          </div>
          <div className="field-group" style={{ flex: 1 }}>
            <label className="field-label">ĐVT</label>
            <div onClick={() => { setOpenDvtModal(true); setTimeout(() => dvtSearchRef.current?.focus(), 100) }}
              style={{ padding: '10px 12px', border: '1.5px solid var(--border)', borderRadius: 10, fontSize: 15, background: '#fff', color: dvt ? 'var(--text)' : 'var(--text-muted)', cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center' }}>
              {dvt ? (danhMucDvt.find(d => d.ma_dvt === dvt)?.ten_dvt || dvt) : 'Chọn...'}
            </div>
          </div>
          <div className="field-group" style={{ flex: 1 }}>
            <label className="field-label">Hệ số</label>
            <input type="text" inputMode="decimal" className="input-field" value={heSo}
              onChange={e => setHeSo(e.target.value.replace(/[^\d.]/g, ''))}
              onFocus={e => e.target.select()} />
          </div>
        </div>

        {/* Quy đổi + Lượt + SS/Kiểm/Lệch */}
        <div style={{ display: 'flex', gap: 8 }}>
          <div className="field-group" style={{ flex: 1 }}>
            <label className="field-label">Quy đổi</label>
            <div className="input-readonly">
              {soQuyDoi !== null ? `${fmtSL(soQuyDoi)} ${dvtTenChinh}` : '—'}
            </div>
          </div>
          <div className="field-group" style={{ flex: 1 }}>
            <label className="field-label">Lượt</label>
            <input type="text" inputMode="numeric" className="input-field" value={luotKiem}
              onChange={e => setLuotKiem(parseInt(e.target.value.replace(/\D/g, '')) || 1)}
              onFocus={e => e.target.select()} />
          </div>
          <div className="field-group" style={{ flex: 1 }}>
            <label className="field-label">Theo kho</label>
            {maKho ? (
              <div style={{ display: 'flex', alignItems: 'stretch', gap: 6 }}>
                <div style={{ flex: 1, fontSize: 11, color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3, padding: '4px 0' }}>
                  <span>SS: <b style={{ color: 'var(--text)' }}>{soSach !== null ? fmtSL(soSach) : '—'}</b></span>
                  <span>Kiểm: <b style={{ color: '#2563EB' }}>{tongKiem !== null ? fmtSL(tongKiem) : '—'}</b></span>
                  <span>Lệch: <b style={{ color: lech === null ? 'var(--text)' : lech < 0 ? '#EF4444' : lech > 0 ? '#D97706' : '#1d9e75' }}>
                    {lech !== null ? (lech > 0 ? '+' : '') + fmtSL(lech) : '—'}
                  </b></span>
                </div>
                {soSach !== null && (
                  <button onClick={() => {
                    const sl = soSach / (parseFloat(heSo) || 1)
                    setSoLuong(fmtSL(sl))
                    setTimeout(() => soLuongRef.current?.focus(), 50)
                  }} style={{
                    border: '1px solid var(--green)', borderRadius: 6,
                    background: 'var(--green-light)', color: 'var(--green)',
                    fontSize: 13, padding: '0 10px', cursor: 'pointer',
                    fontWeight: 700, flexShrink: 0, alignSelf: 'stretch'
                  }}>Điền</button>
                )}
              </div>
            ) : <div style={{ height: 40, display: 'flex', alignItems: 'center', color: 'var(--text-muted)', fontSize: 12 }}>—</div>}
          </div>
        </div>

        {/* Ghi chú */}
        <div className="field-group">
          <label className="field-label">Ghi chú</label>
          <textarea className="input-field" value={ghiChu}
            onChange={e => setGhiChu(e.target.value)} placeholder="Nhập ghi chú..."
            rows={2} style={{ resize: 'vertical', lineHeight: 1.5 }} />
        </div>
      </div>

      {/* Footer */}
      <div style={{
        position: 'fixed',
        bottom: keyboardOffset > 0 ? keyboardOffset : 0,
        left: 'max(0px, calc((100vw - 480px) / 2))',
        right: 'max(0px, calc((100vw - 480px) / 2))',
        zIndex: 210, display: 'flex', gap: 8,
        padding: '8px 16px', borderTop: '1px solid var(--border)', background: '#fff',
        transition: 'bottom 0.15s ease-out'
      }}>
        <button className="btn-secondary" onClick={onHuy} style={{ flex: 1, height: 40 }}>Hủy</button>
        <button className="btn-secondary" onClick={handleXoa} disabled={saving} style={{ flex: 1, height: 40 }}>Xóa</button>
        <button className="btn-primary" onClick={handleLuu} style={{ flex: 2, height: 40 }}
          disabled={!soLuong || !maKho || saving}>
          {saving ? 'Đang lưu...' : '+ Lưu & đếm tiếp'}
        </button>
      </div>

      {/* Kho modal */}
      {openKhoModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: '#fff', display: 'flex', flexDirection: 'column', maxWidth: 480, margin: '0 auto' }}>
          <div style={{ padding: '10px 12px', display: 'flex', gap: 8, alignItems: 'center', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <input ref={khoSearchRef} type="text" className="input-field" placeholder="Tìm kho..."
              value={khoQuery} onChange={e => setKhoQuery(e.target.value)} style={{ flex: 1, margin: 0 }} />
            <button onClick={() => { setKhoQuery(''); khoSearchRef.current?.focus() }}
              style={{ padding: '8px 12px', border: 'none', background: 'none', color: 'var(--text-muted)', fontSize: 15, cursor: 'pointer' }}>Xóa</button>
            <button onClick={() => { setOpenKhoModal(false); setKhoQuery('') }}
              style={{ padding: '8px 12px', border: 'none', background: 'none', color: 'var(--text-muted)', fontSize: 15, cursor: 'pointer' }}>Hủy</button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {khoList.filter(k => !khoQuery.trim() ||
              toSearchable(k.ten_kho).includes(toSearchable(khoQuery)) ||
              toSearchable(k.ma_kho).includes(toSearchable(khoQuery))
            ).map(k => (
              <div key={k.ma_kho} onClick={() => handleSelectKho(k.ma_kho)}
                style={{ padding: '14px 16px', borderBottom: '1px solid #F3F4F6', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, background: k.ma_kho === maKho ? '#F0FDF4' : '#fff' }}>
                <span style={{ background: '#E6F4EF', color: 'var(--green)', borderRadius: 6, padding: '2px 7px', fontSize: 12, fontWeight: 700 }}>{k.ma_kho}</span>
                <span style={{ fontSize: 15, fontWeight: k.ma_kho === maKho ? 600 : 400 }}>{k.ten_kho}</span>
                {k.ma_kho === maKho && <span style={{ marginLeft: 'auto', color: 'var(--green)', fontSize: 18 }}>✓</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* DVT modal */}
      {openDvtModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: '#fff', display: 'flex', flexDirection: 'column', maxWidth: 480, margin: '0 auto' }}>
          <div style={{ padding: '10px 12px', display: 'flex', gap: 8, alignItems: 'center', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <input ref={dvtSearchRef} type="text" className="input-field" placeholder="Tìm đơn vị tính..."
              value={dvtQuery} onChange={e => setDvtQuery(e.target.value)} style={{ flex: 1, margin: 0 }} />
            <button onClick={() => { setDvtQuery(''); dvtSearchRef.current?.focus() }}
              style={{ padding: '8px 12px', border: 'none', background: 'none', color: 'var(--text-muted)', fontSize: 15, cursor: 'pointer' }}>Xóa</button>
            <button onClick={() => { setOpenDvtModal(false); setDvtQuery('') }}
              style={{ padding: '8px 12px', border: 'none', background: 'none', color: 'var(--text-muted)', fontSize: 15, cursor: 'pointer' }}>Hủy</button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {danhMucDvt.filter(d => !dvtQuery.trim() ||
              toSearchable(d.ten_dvt).includes(toSearchable(dvtQuery)) ||
              toSearchable(d.ma_dvt).includes(toSearchable(dvtQuery))
            ).map(d => (
              <div key={d.ma_dvt} onClick={() => { setDvt(d.ma_dvt); setOpenDvtModal(false); setDvtQuery('') }}
                style={{ padding: '14px 16px', borderBottom: '1px solid #F3F4F6', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, background: d.ma_dvt === dvt ? '#F0FDF4' : '#fff' }}>
                <span style={{ background: '#E6F4EF', color: 'var(--green)', borderRadius: 6, padding: '2px 7px', fontSize: 12, fontWeight: 700 }}>{d.ma_dvt}</span>
                <span style={{ fontSize: 15, fontWeight: d.ma_dvt === dvt ? 600 : 400 }}>{d.ten_dvt}</span>
                {d.ma_dvt === dvt && <span style={{ marginLeft: 'auto', color: 'var(--green)', fontSize: 18 }}>✓</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
