// src/components/ChonVatTu.jsx
import { useState, useEffect, useRef } from 'react'
import { db, getGoiYVatTu } from '../lib/db'
import { Html5Qrcode } from 'html5-qrcode'

export default function ChonVatTu({ onSelect, value }) {
  const [query, setQuery] = useState('')
  const [goiY, setGoiY] = useState([])        // gần đây nhất
  const [ketQua, setKetQua] = useState([])     // search results
  const [showDropdown, setShowDropdown] = useState(false)
  const [scanning, setScanning] = useState(false)
  const qrRef = useRef(null)
  const html5QrRef = useRef(null)

  useEffect(() => {
    getGoiYVatTu(20).then(setGoiY)
  }, [])

  // Search theo tên hoặc mã
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

  // QR scan
  async function startScan() {
    setScanning(true)
    const qr = new Html5Qrcode('qr-reader')
    html5QrRef.current = qr
    try {
      await qr.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        async (decodedText) => {
          // decodedText = mã vật tư (VT012)
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

  return (
    <div className="field-group" style={{ position: 'relative' }}>
      <label className="field-label">Mã / Tên vật tư</label>

      {/* Input + QR button */}
      <div className="input-with-icon">
        <input
          type="text"
          className="input-field"
          placeholder="Gõ tên hoặc mã vật tư..."
          value={value?.ten_vt || query}
          onChange={e => { setQuery(e.target.value); setShowDropdown(true) }}
          onFocus={() => setShowDropdown(true)}
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

      {/* QR scanner modal */}
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

      {/* Dropdown gợi ý */}
      {showGoiY && goiY.length > 0 && (
        <div className="dropdown">
          <div className="dropdown-section-title">Kiểm gần đây</div>
          {goiY.map(item => (
            <div key={item.ma_vt} className="dropdown-item" onMouseDown={() => handleSelect(item)}>
              <span className="item-ma">{item.ma_vt}</span>
              <span className="item-ten">{item.ten_vt}</span>
            </div>
          ))}
        </div>
      )}

      {/* Dropdown search */}
      {showKetQua && ketQua.length > 0 && (
        <div className="dropdown">
          {ketQua.map(item => (
            <div key={item.ma_vt} className="dropdown-item" onMouseDown={() => handleSelect(item)}>
              <span className="item-ma">{item.ma_vt}</span>
              <span className="item-ten">{item.ten_vt}</span>
            </div>
          ))}
        </div>
      )}

      {showKetQua && ketQua.length === 0 && (
        <div className="dropdown">
          <div className="dropdown-empty">Không tìm thấy vật tư</div>
        </div>
      )}
    </div>
  )
}
