// src/components/ChonVatTu.jsx
import { useState, useEffect, useRef } from 'react'
import { db, getGoiYVatTu } from '../lib/db'
import { Html5Qrcode } from 'html5-qrcode'
import { toSearchable } from '../lib/utils'

function genMaVtNSS() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

export default function ChonVatTu({ onSelect, value, autoOpen = false }) {
  const [open, setOpen]         = useState(autoOpen)
  const [query, setQuery]       = useState('')
  const [goiY, setGoiY]         = useState([])
  const [ketQua, setKetQua]     = useState([])
  const [scanning, setScanning] = useState(false)
  const [showNSSForm, setShowNSSForm] = useState(false)
  const [tenVtNSS, setTenVtNSS] = useState('')
  const [maDvtNSS, setMaDvtNSS] = useState('')
  const [dsDvt, setDsDvt]       = useState([])
  const searchRef  = useRef(null)
  const tenVtRef   = useRef(null)
  const qrRef      = useRef(null)
  const html5QrRef = useRef(null)

  useEffect(() => {
    getGoiYVatTu(20).then(setGoiY)
    db.dm_dvt.toArray().then(rows => {
      setDsDvt(rows)
      if (rows.length) setMaDvtNSS(rows[0].ma_dvt)
    })
  }, [])

  useEffect(() => {
    if (!open) { setQuery(''); setShowNSSForm(false); return }
    getGoiYVatTu(20).then(setGoiY)
    setTimeout(() => searchRef.current?.focus(), 100)
  }, [open])

  useEffect(() => {
    if (!query.trim()) { setKetQua([]); return }
    const q = toSearchable(query)
    db.dm_vat_tu
      .filter(v => toSearchable(v.ten_vt).includes(q) || toSearchable(v.ma_vt).includes(q))
      .limit(30)
      .toArray()
      .then(setKetQua)
  }, [query])

  async function handleSelect(item) {
    const full = await db.dm_vat_tu.get(item.ma_vt)
    onSelect({
      ma_vt: item.ma_vt,
      ten_vt: item.ten_vt,
      ngoai_so_sach: full?.ngoai_so_sach ?? false,
      ma_dvt_kiem: full?.ma_dvt_kiem
    })
    setOpen(false)
  }

  function openNSSForm() {
    setShowNSSForm(true)
    setTenVtNSS('')
    setTimeout(() => tenVtRef.current?.focus(), 100)
  }

  async function confirmNSS() {
    if (!tenVtNSS.trim()) return
    const ma_vt = genMaVtNSS()
    const ten_vt = tenVtNSS.trim()
    await db.dm_vat_tu.put({ ma_vt, ten_vt, ngoai_so_sach: true, ma_dvt_kiem: maDvtNSS, active: true })
    onSelect({ ma_vt, ten_vt, ma_dvt_kiem: maDvtNSS, ngoai_so_sach: true })
    setShowNSSForm(false)
    setOpen(false)
  }

  async function startScan() {
    setOpen(false)
    setScanning(true)
    const qr = new Html5Qrcode('qr-reader')
    html5QrRef.current = qr
    try {
      await qr.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        async (decodedText) => {
          const vt = await db.dm_vat_tu.get(decodedText)
          if (vt) onSelect({ ma_vt: vt.ma_vt, ten_vt: vt.ten_vt })
          else alert(`Không tìm thấy mã: ${decodedText}`)
          stopScan()
        }
      )
    } catch (err) {
      console.error('QR lỗi:', err)
      setScanning(false)
    }
  }

  async function stopScan() {
    if (html5QrRef.current) {
      await html5QrRef.current.stop()
      html5QrRef.current = null
    }
    setScanning(false)
  }

  const showGoiY = !query.trim()
  const list = showGoiY ? goiY : ketQua

  return (
    <div className="field-group">
      <label className="field-label">Mã / Tên vật tư</label>

      {/* Trigger field */}
      <div className="input-with-icon">
        <div
          onClick={() => !value && setOpen(true)}
          style={{
            flex: 1, padding: '10px 12px', border: '1.5px solid var(--border)',
            borderRadius: 10, fontSize: 15, background: '#fff',
            color: value ? 'var(--text)' : 'var(--text-muted)',
            cursor: value ? 'default' : 'pointer', minHeight: 44,
            display: 'flex', alignItems: 'center'
          }}>
          {value ? <><b style={{ marginRight: 6 }}>{value.ma_vt}</b>{value.ten_vt}</> : 'Gõ tên hoặc mã vật tư...'}
        </div>
        {value ? (
          <button className="icon-btn" onClick={() => onSelect(null)} title="Xóa">✕</button>
        ) : (
          <button className="icon-btn" onClick={startScan} title="Quét QR">
            <span style={{ fontSize: 18 }}>📷</span>
          </button>
        )}
      </div>

      {/* QR scanner */}
      {scanning && (
        <div className="qr-modal">
          <div className="qr-modal-inner">
            <div id="qr-reader" ref={qrRef} style={{ width: '100%' }} />
            <button className="btn-secondary" onClick={stopScan} style={{ marginTop: 12 }}>Hủy quét</button>
          </div>
        </div>
      )}

      {/* Fullscreen search modal */}
      {open && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 300,
          background: '#fff', display: 'flex', flexDirection: 'column',
          maxWidth: 480, margin: '0 auto'
        }}>
          {/* Search bar */}
          <div style={{
            padding: '10px 12px', display: 'flex', gap: 8, alignItems: 'center',
            borderBottom: '1px solid var(--border)', background: '#fff', flexShrink: 0
          }}>
            <input
              ref={searchRef}
              type="text"
              className="input-field"
              placeholder="Gõ tên hoặc mã vật tư..."
              value={query}
              onChange={e => { setQuery(e.target.value); setShowNSSForm(false) }}
              style={{ flex: 1, margin: 0 }}
            />
            <button onClick={() => { setQuery(''); searchRef.current?.focus() }} style={{
              padding: '8px 12px', border: 'none', background: 'none',
              color: 'var(--text-muted)', fontSize: 15, cursor: 'pointer', flexShrink: 0
            }}>Xóa</button>
            <button onClick={() => { setOpen(false); if (autoOpen) onSelect(null) }} style={{
              padding: '8px 12px', border: 'none', background: 'none',
              color: 'var(--text-muted)', fontSize: 15, cursor: 'pointer', flexShrink: 0
            }}>Hủy</button>
          </div>

          {/* Ngoài sổ sách — luôn hiện cố định */}
          {!showNSSForm ? (
            <div onClick={openNSSForm} style={{
              padding: '12px 16px', borderBottom: '1px solid var(--border)',
              background: '#F0FDF4', color: 'var(--green)', fontWeight: 600,
              fontSize: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
              flexShrink: 0
            }}>
              <span style={{ fontSize: 18 }}>＋</span> Thêm ngoài sổ sách
            </div>
          ) : (
            <div style={{ padding: 14, borderBottom: '1px solid var(--border)', background: '#F0FDF4', flexShrink: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--green)', marginBottom: 8 }}>
                Mặt hàng ngoài sổ sách
              </div>
              <input
                ref={tenVtRef}
                type="text"
                className="input-field"
                placeholder="Tên vật tư *"
                value={tenVtNSS}
                onChange={e => setTenVtNSS(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && confirmNSS()}
                style={{ marginBottom: 8 }}
              />
              <select className="input-select" value={maDvtNSS}
                onChange={e => setMaDvtNSS(e.target.value)} style={{ marginBottom: 10 }}>
                {dsDvt.map(d => <option key={d.ma_dvt} value={d.ma_dvt}>{d.ten_dvt}</option>)}
              </select>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-primary" onClick={confirmNSS}
                  disabled={!tenVtNSS.trim()} style={{ flex: 1 }}>Xác nhận</button>
                <button className="btn-secondary" onClick={() => setShowNSSForm(false)}
                  style={{ flex: 1 }}>Hủy</button>
              </div>
            </div>
          )}

          {/* Danh sách kết quả — cuộn độc lập */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {showGoiY && list.length > 0 && (
              <div style={{ padding: '6px 16px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, background: '#F9FAFB', letterSpacing: 0.5 }}>
                GẦN ĐÂY
              </div>
            )}
            {list.length === 0 && query.trim() && (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
                Không tìm thấy vật tư
              </div>
            )}
            {list.map(item => {
              const isSelected = value?.ma_vt === item.ma_vt
              return (
                <div key={item.ma_vt} onClick={() => handleSelect(item)} style={{
                  padding: '14px 16px', borderBottom: '1px solid #F3F4F6',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10,
                  background: isSelected ? '#F0FDF4' : '#fff'
                }}>
                  <span style={{
                    background: '#E6F4EF', color: 'var(--green)', borderRadius: 6,
                    padding: '2px 7px', fontSize: 12, fontWeight: 700, flexShrink: 0
                  }}>{item.ma_vt}</span>
                  <span style={{ fontSize: 15, fontWeight: isSelected ? 600 : 400 }}>{item.ten_vt}</span>
                  {isSelected && <span style={{ marginLeft: 'auto', color: 'var(--green)', fontSize: 18 }}>✓</span>}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
