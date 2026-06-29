import { useState, useEffect, useRef } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import { db, saveChiTietLocal } from '../lib/db'
import { pushOfflineQueue } from '../lib/sync'
import { fmtSL } from '../lib/utils'

// Cột Excel được chấp nhận (tên cột không phân biệt hoa thường, khoảng trắng)
const normalize = s => String(s || '').toLowerCase().replace(/\s+/g, '').replace(/_/g, '')

const COL_MAP = {
  mavt:           'ma_vt',
  mãvt:           'ma_vt',
  mavatu:         'ma_vt',
  mãvatu:         'ma_vt',
  tenvt:          'ten_vt',
  tênvt:          'ten_vt',
  tenvatu:        'ten_vt',
  tênvatu:        'ten_vt',
  makho:          'ma_kho',
  mãkho:          'ma_kho',
  slthucte:       'so_luong_thuc_te',
  slthực:         'so_luong_thuc_te',
  soluongthucte:  'so_luong_thuc_te',
  sốlượngthựctế:  'so_luong_thuc_te',
  slkiemke:       'so_luong_thuc_te',
  slkiểmkê:       'so_luong_thuc_te',
  soluongkiemke:  'so_luong_thuc_te',
  sốlượngkiểmkê:  'so_luong_thuc_te',
  dvtphu:         'ma_dvt_kiem',
  đvtphụ:         'ma_dvt_kiem',
  dvt:            'ma_dvt_kiem',
  đvt:            'ma_dvt_kiem',
  madvtkiem:      'ma_dvt_kiem',
  heso:           'he_so_quy_doi',
  hệsố:           'he_so_quy_doi',
  hesoquydoi:     'he_so_quy_doi',
  hệsốquyđổi:    'he_so_quy_doi',
  luot:           'luot_kiem',
  lượt:           'luot_kiem',
  luotkiem:       'luot_kiem',
  lượtkiểm:       'luot_kiem',
  slsosach:       'so_luong_so_sach',
  slsổsách:       'so_luong_so_sach',
  soluongsosach:  'so_luong_so_sach',
  sốlượngsổsách:  'so_luong_so_sach',
  ghichu:         'ghi_chu',
  ghichú:         'ghi_chu',
}

function parseExcel(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = evt => {
      try {
        const wb = XLSX.read(evt.target.result, { type: 'array' })
        const ws = wb.Sheets[wb.SheetNames[0]]
        const raw = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false })
        if (!raw.length) { reject(new Error('File không có dữ liệu')); return }

        // Map header → field
        const firstRow = raw[0]
        const keyMap = {}
        Object.keys(firstRow).forEach(k => {
          const field = COL_MAP[normalize(k)]
          if (field) keyMap[k] = field
        })
        if (!keyMap[Object.keys(firstRow).find(k => COL_MAP[normalize(k)] === 'ma_vt')]) {
          reject(new Error('Không tìm thấy cột Mã VT trong file')); return
        }

        const rows = raw.map(r => {
          const obj = {}
          Object.entries(keyMap).forEach(([col, field]) => { obj[field] = r[col] })
          return obj
        }).filter(r => r.ma_vt && String(r.ma_vt).trim())

        resolve(rows)
      } catch (e) { reject(e) }
    }
    reader.onerror = () => reject(new Error('Không đọc được file'))
    reader.readAsArrayBuffer(file)
  })
}

export default function Import({ currentUser }) {
  const [phienList, setPhienList]   = useState([])
  const [phienId, setPhienId]       = useState('')
  const [khoList, setKhoList]       = useState([])
  const [userMap, setUserMap]       = useState({})
  const [rows, setRows]             = useState(null)   // parsed Excel rows
  const [fileErr, setFileErr]       = useState(null)
  const [importing, setImporting]   = useState(false)
  const [result, setResult]         = useState(null)   // { ok, count, errors }
  const fileRef = useRef(null)

  useEffect(() => {
    const load = async () => {
      if (navigator.onLine) {
        const [{ data: khos }, { data: phiens }, { data: users }] = await Promise.all([
          supabase.from('dm_kho').select('ma_kho,ten_kho').eq('active', true).order('ma_kho'),
          supabase.from('phien_kiem_ke').select('id,ma_kho,ke_toan_id,thu_kho_id,ngay_kiem,trang_thai').order('ngay_kiem', { ascending: false }).limit(200),
          supabase.from('dm_user').select('id,ho_ten'),
        ])
        setKhoList(khos || [])
        setPhienList(phiens || [])
        const uMap = {}; (users || []).forEach(u => { uMap[u.id] = u.ho_ten })
        setUserMap(uMap)
      } else {
        const [khos, phiens, users] = await Promise.all([
          db.dm_kho.toArray(),
          db.phien.toArray(),
          db.dm_user.toArray(),
        ])
        setKhoList(khos)
        setPhienList(phiens.sort((a, b) => (b.ngay_kiem || '').localeCompare(a.ngay_kiem || '')))
        const uMap = {}; users.forEach(u => { uMap[u.id] = u.ho_ten })
        setUserMap(uMap)
      }
    }
    load()
  }, [])

  async function handleFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setRows(null); setFileErr(null); setResult(null)
    try {
      const parsed = await parseExcel(file)
      if (!parsed.length) { setFileErr('File không có dữ liệu hợp lệ'); return }
      setRows(parsed)
    } catch (err) {
      setFileErr(err.message)
    }
  }

  async function handleImport() {
    if (!rows || !phienId) return
    setImporting(true); setResult(null)

    const phien = phienList.find(p => p.id === phienId)
    const defaultKho = phien?.ma_kho || ''

    // Lấy tên VT từ IndexedDB để điền vào nếu ten_vt trống
    const vtArr = await db.dm_vat_tu.toArray()
    const vtMap = {}; vtArr.forEach(v => { vtMap[v.ma_vt] = v.ten_vt || v.ma_vt })

    // Lấy ton_kho để điền so_luong_so_sach
    const tonArr = await db.ton_kho.toArray()
    const tonMap = {}; tonArr.forEach(t => { tonMap[`${t.ma_vt}__${t.ma_kho}`] = t.so_luong_so_sach ?? null })

    let count = 0, errors = []

    for (const r of rows) {
      const maVt = String(r.ma_vt || '').trim()
      if (!maVt) continue
      const maKho = String(r.ma_kho || '').trim() || defaultKho
      if (!maKho) { errors.push(`${maVt}: thiếu mã kho`); continue }
      const slTT = parseFloat(String(r.so_luong_thuc_te || '').replace(/,/g, ''))
      if (isNaN(slTT)) { errors.push(`${maVt}: SL thực tế không hợp lệ`); continue }
      const heSo = parseFloat(String(r.he_so_quy_doi || '').replace(/,/g, '')) || 1
      const luot = parseInt(String(r.luot_kiem || '').replace(/\D/g, '')) || 1
      const ssRaw = String(r.so_luong_so_sach || '').trim()
      const soSach = ssRaw !== '' ? parseFloat(ssRaw.replace(/,/g, '')) : (tonMap[`${maVt}__${maKho}`] ?? null)
      const dvt = String(r.ma_dvt_kiem || '').trim() || null

      try {
        await saveChiTietLocal({
          id: crypto.randomUUID(),
          phien_id: phienId,
          ma_vt: maVt,
          ten_vt: String(r.ten_vt || '').trim() || vtMap[maVt] || maVt,
          ma_kho: maKho,
          ma_dvt_kiem: dvt,
          he_so_quy_doi: heSo,
          luot_kiem: luot,
          so_luong_thuc_te: slTT,
          so_luong_so_sach: soSach,
          ghi_chu: String(r.ghi_chu || '').trim() || null,
          hinh_anh_urls: [],
          da_doi_chieu: false,
          nguoi_nhap_id: currentUser.id,
          ngoai_so_sach: false,
        })
        count++
      } catch (e) {
        errors.push(`${maVt}: ${e.message}`)
      }
    }

    if (navigator.onLine) pushOfflineQueue()

    setResult({ ok: errors.length === 0, count, errors })
    setRows(null)
    if (fileRef.current) fileRef.current.value = ''
    setImporting(false)
  }

  function downloadTemplate() {
    const headers = [['Mã VT', 'Tên VT', 'Mã kho', 'SL thực tế', 'ĐVT phụ', 'Hệ số', 'Lượt', 'Ghi chú']]
    const example = [['VT001', 'Gạo 25kg', 'KHO01', 100, 'bao', 25, 1, '']]
    const ws = XLSX.utils.aoa_to_sheet([...headers, ...example])
    ws['!cols'] = [14, 24, 10, 12, 10, 8, 6, 20].map(w => ({ wch: w }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Import')
    XLSX.writeFile(wb, 'Template_Import_KiemKe.xlsx')
  }

  const phienSel = phienList.find(p => p.id === phienId)

  const btnStyle = (active) => ({
    width: '100%', padding: '11px 0', borderRadius: 8, border: 'none',
    background: active ? '#1D9E75' : '#E5E7EB',
    color: active ? '#fff' : '#9CA3AF',
    fontWeight: 600, fontSize: 14, cursor: active ? 'pointer' : 'default',
    marginTop: 12,
  })

  return (
    <div className="screen" style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <div className="topbar">
        <div className="topbar-title">Import</div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 16, paddingBottom: 80, display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Hướng dẫn định dạng */}
        <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 10, padding: 14, fontSize: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>Định dạng file Excel (.xlsx / .xls)</div>
          <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>Hàng đầu là tiêu đề cột, các hàng tiếp theo là dữ liệu. Cột bắt buộc:</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px' }}>
            {['Mã VT ✱', 'SL thực tế ✱'].map(c => (
              <span key={c} style={{ background: '#fff', border: '1px solid #BBF7D0', borderRadius: 4, padding: '2px 6px', fontSize: 11, fontWeight: 600 }}>{c}</span>
            ))}
          </div>
          <div style={{ color: 'var(--text-muted)', margin: '6px 0 4px' }}>Cột tuỳ chọn:</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px' }}>
            {['Tên VT', 'Mã kho', 'ĐVT phụ', 'Hệ số', 'Lượt', 'Ghi chú'].map(c => (
              <span key={c} style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 6px', fontSize: 11, color: 'var(--text-muted)' }}>{c}</span>
            ))}
          </div>
          <div style={{ marginTop: 6, color: '#6B7280', fontSize: 11 }}>
            Nếu cột Mã kho trống → dùng kho mặc định của phiên. SL sổ sách trống → tự lấy từ danh mục tồn kho.
          </div>
          <button onClick={downloadTemplate} style={{
            marginTop: 10, width: '100%', padding: '8px 0', borderRadius: 7,
            border: '1px solid #6EE7B7', background: '#fff',
            color: '#059669', fontWeight: 600, fontSize: 12, cursor: 'pointer',
          }}>
            ⬇ Tải file template (.xlsx)
          </button>
        </div>

        {/* Chọn phiên */}
        <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>1. Chọn phiên kiểm kê</div>
          <select className="input-field" style={{ marginBottom: 0 }}
            value={phienId} onChange={e => { setPhienId(e.target.value); setResult(null) }}>
            <option value="">— Chọn phiên —</option>
            {phienList.map(p => {
              const kho = khoList.find(k => k.ma_kho === p.ma_kho)?.ten_kho || p.ma_kho || ''
              const kt = userMap[p.ke_toan_id] || ''
              const tk = userMap[p.thu_kho_id] || ''
              const names = [kt, tk].filter(Boolean).join('/')
              return (
                <option key={p.id} value={p.id}>
                  {(p.ngay_kiem || '').slice(0, 10)} · {kho}{names ? ` · ${names}` : ''}
                </option>
              )
            })}
          </select>
          {phienSel && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>
              Kho mặc định: <b style={{ color: 'var(--text)' }}>{khoList.find(k => k.ma_kho === phienSel.ma_kho)?.ten_kho || phienSel.ma_kho}</b>
            </div>
          )}
        </div>

        {/* Chọn file */}
        <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>2. Chọn file Excel</div>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv"
            onChange={handleFile} style={{ display: 'none' }} id="import-xlsx-input" />
          <label htmlFor="import-xlsx-input" style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            padding: '12px 0', borderRadius: 8, cursor: 'pointer',
            border: '1.5px dashed var(--border)', background: '#FAFAFA',
            color: 'var(--text-muted)', fontSize: 13, fontWeight: 500,
          }}>
            📂 Chọn file Excel...
          </label>

          {fileErr && (
            <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, background: '#FEF2F2', color: '#DC2626', fontSize: 13 }}>
              {fileErr}
            </div>
          )}

          {rows && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontWeight: 600, fontSize: 13, color: '#16A34A', marginBottom: 8 }}>
                Tìm thấy {rows.length} dòng — xem trước 5 dòng đầu:
              </div>
              <div style={{ overflowX: 'auto', borderRadius: 8, border: '1px solid var(--border)' }}>
                <table style={{ borderCollapse: 'collapse', fontSize: 11, width: '100%', whiteSpace: 'nowrap' }}>
                  <thead>
                    <tr style={{ background: '#F3F4F6' }}>
                      {['Mã VT', 'Mã kho', 'SL TT', 'ĐVT', 'Hệ số', 'Ghi chú'].map(h => (
                        <th key={h} style={{ padding: '5px 8px', fontWeight: 600, textAlign: 'left', borderBottom: '1px solid var(--border)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 5).map((r, i) => (
                      <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#F9FAFB' }}>
                        <td style={{ padding: '4px 8px', fontWeight: 600, color: '#1D9E75' }}>{r.ma_vt}</td>
                        <td style={{ padding: '4px 8px', color: 'var(--text-muted)' }}>{r.ma_kho || '—'}</td>
                        <td style={{ padding: '4px 8px' }}>{r.so_luong_thuc_te != null ? fmtSL(parseFloat(String(r.so_luong_thuc_te).replace(/,/g,''))) : '—'}</td>
                        <td style={{ padding: '4px 8px', color: 'var(--text-muted)' }}>{r.ma_dvt_kiem || '—'}</td>
                        <td style={{ padding: '4px 8px', color: 'var(--text-muted)' }}>{r.he_so_quy_doi || '1'}</td>
                        <td style={{ padding: '4px 8px', color: 'var(--text-muted)', maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.ghi_chu || ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length > 5 && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, textAlign: 'right' }}>
                  ...và {rows.length - 5} dòng nữa
                </div>
              )}
            </div>
          )}
        </div>

        {/* Kết quả */}
        {result && (
          <div style={{
            padding: '12px 14px', borderRadius: 10,
            background: result.ok ? '#F0FDF4' : '#FFFBEB',
            border: `1px solid ${result.ok ? '#BBF7D0' : '#FDE68A'}`,
          }}>
            <div style={{ fontWeight: 600, fontSize: 13, color: result.ok ? '#16A34A' : '#D97706', marginBottom: result.errors.length ? 6 : 0 }}>
              Đã import {result.count} bản ghi{result.errors.length ? `, ${result.errors.length} lỗi` : ' thành công'}
              {navigator.onLine ? ' — đang đồng bộ lên server...' : ' (offline — sẽ sync khi có mạng)'}
            </div>
            {result.errors.slice(0, 5).map((e, i) => (
              <div key={i} style={{ fontSize: 12, color: '#B45309', marginTop: 2 }}>• {e}</div>
            ))}
            {result.errors.length > 5 && (
              <div style={{ fontSize: 12, color: '#B45309' }}>...và {result.errors.length - 5} lỗi nữa</div>
            )}
          </div>
        )}

        {/* Nút import */}
        <button
          disabled={!rows || !phienId || importing}
          onClick={handleImport}
          style={btnStyle(!!rows && !!phienId && !importing)}
        >
          {importing ? 'Đang import...' : rows && phienId ? `✓ Import ${rows.length} bản ghi vào phiên đã chọn` : !phienId ? 'Chưa chọn phiên' : 'Chưa chọn file'}
        </button>

      </div>
    </div>
  )
}
