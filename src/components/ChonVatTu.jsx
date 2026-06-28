// src/components/ChonVatTu.jsx
import { useState, useEffect, useRef } from 'react'
import { db, getGoiYVatTu } from '../lib/db'
import { Html5Qrcode } from 'html5-qrcode'

function genMaVtNSS() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

export default function ChonVatTu({ onSelect, value }) {
  const [query, setQuery] = useState('')
  const [goiY, setGoiY] = useState([])
  const [ketQua, setKetQua] = useState([])
  const [showDropdown, setShowDropdown] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [showNSSForm, setShowNSSForm] = useState(false)
  const [tenVtNSS, setTenVtNSS] = useState('')
  const [maDvtNSS, setMaDvtNSS] = useState('')
  const [dsDvt, setDsDvt] = useState([])
  const qrRef = useRef(null)
  const html5QrRef = useRef(null)
  const tenVtRef = useRef(null)

  useEffect(() => {
    getGoiYVatTu(20).then(setGoiY)
    db.dm_dvt.toArray().then(setDsDvt)
  }, [])

  useEffect(() => {
    if (!query.trim()) { setKetQua([]); return }
    const q = query.toLowerCase()
    db.dm_vat_tu
      .filter(v => v.ten_vt.toLowerCase().includes(q) || v.ma_vt.toLowerCase().includes(q))
      .limit(15)
      .toArray()
      .then(setKetQua)
  }, [query])

  function handleSelect(item) {
    onSelect({ ma_vt: item.ma_vt, ten_vt: item.ten_vt })
    setQuery('')
    setShowDropdown(false)
    setKetQua([])
  }

  function openNSSForm() {
    setShowDropdown(false)
    setShowNSSForm(true)
    setTenVtNSS('')
    setMaDvtNSS(dsDvt[0]?.ma_dvt || '')
    setTimeout(() => tenVtRef.current?.focus(), 100)
  }

  function confirmNSS() {
    if (!tenVtNSS.trim()) return
    onSelect({
      ma_vt: genMaVtNSS(),
      ten_vt: tenVtNSS.trim(),
      ma_dvt_kiem: maDvtNSS,
      ngoai_so_sach: true
    })
    setShowNSSForm(false)
    setTenVtNSS('')
  }

  async function startScan() {
    setScanning(true)
    const qr = new Html5Qrcode('qr-reader')
    html5QrRef.current = qr
    try {
      await qr.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        async (decodedText) => {
          const vt = await db.dm_vat_tu.get(decodedText)
          if (vt) {
            handleSelect(vt)
          } else {
            alert(`Không tìm thấy mã: ${decodedText}`)
          }
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

  const showGoiY = !query.trim() && showDropdown
  const showKetQua = query.trim() && showDropdown

  const nssOption = (
    <div onMouseDown={e => { e.preventDefault(); openNSSForm() }} style={{
      padding: '8px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
      borderBottom: '1px solid var(--border)', background: '#F0FDF4',
      color: 'var(--green)', fontWeight: 600, fontSize: 13
    }}>
      <span style={{ fontSize: 16 }}>＋</span> Thêm ngoài sổ sách
    </div>
  )

  return (
    <div className="field-group" style={{ position: 'relative' }}>
      <label className="field-label">Mã / Tên vật tư</label>

      <div className="input-with-icon">
        <input
          type="text"
          className="input-field"
          placeholder="Gõ tên hoặc mã vật tư..."
          value={value?.ten_vt || query}
          onChange={e => { setQuery(e.target.value); setShowDropdown(true); setShowNSSForm(false) }}
          onFocus={() => { setShowDropdown(true); setShowNSSForm(false) }}
          onBlur={() => setTimeout(() => setShowDropdown(false), 200)}
          readOnly={!!value}
        />
        {value ? (
          <button className="icon-btn" onClick={() => onSelect(null)} title="Xóa">✕</button>
        ) : (
          <button className="icon-btn" onClick={startScan} title="Quét QR">
            <span style={{ fontSize: 18 }}>📷</span>
          </button>
        )}
      </div>

      {scanning && (
        <div className="qr-modal">
          <div className="qr-modal-inner">
            <div id="qr-reader" ref={qrRef} style={{ width: '100%' }} />
            <button className="btn-secondary" onClick={stopScan} style={{ marginTop: 12 }}>
              Hủy quét
            </button>
          </div>
        </div>
      )}

      {showGoiY && goiY.length > 0 && (
        <div className="dropdown">
          {nssOption}
          <div className="dropdown-section-title">Kiểm gần đây</div>
          {goiY.map(item => (
            <div key={item.ma_vt} className="dropdown-item" onMouseDown={() => handleSelect(item)}>
              <span className="item-ma">{item.ma_vt}</span>
              <span className="item-ten">{item.ten_vt}</span>
            </div>
          ))}
        </div>
      )}

      {showKetQua && (
        <div className="dropdown">
          {nssOption}
          {ketQua.map(item => (
            <div key={item.ma_vt} className="dropdown-item" onMouseDown={() => handleSelect(item)}>
              <span className="item-ma">{item.ma_vt}</span>
              <span className="item-ten">{item.ten_vt}</span>
            </div>
          ))}
        </div>
      )}

      {!showGoiY && !showKetQua && !showDropdown && showNSSForm && (
        <div style={{
          border: '1px solid var(--border)', borderRadius: 10,
          padding: 12, marginTop: 6, background: '#F0FDF4'
        }}>
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
            onChange={e => setMaDvtNSS(e.target.value)}
            style={{ marginBottom: 10 }}>
            {dsDvt.map(d => <option key={d.ma_dvt} value={d.ma_dvt}>{d.ten_dvt}</option>)}
          </select>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-primary" onClick={confirmNSS}
              disabled={!tenVtNSS.trim()} style={{ flex: 1 }}>
              Xác nhận
            </button>
            <button className="btn-secondary" onClick={() => setShowNSSForm(false)}
              style={{ flex: 1 }}>
              Hủy
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
