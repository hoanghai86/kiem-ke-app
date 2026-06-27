// src/screens/TongHop.jsx
import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { db, updatePhienLocal } from '../lib/db'
import { supabase } from '../lib/supabase'
import { pushOfflineQueue } from '../lib/sync'

const EPS = 0.001

export default function TongHop({ currentUser }) {
  const { phienId } = useParams()
  const [phien, setPhien]           = useState(null)
  const [groups, setGroups]         = useState([])
  const [loading, setLoading]       = useState(true)
  const [dvtMap, setDvtMap]         = useState({})
  const [tenKeToan, setTenKeToan]   = useState('Kế toán')
  const [tenThuKho, setTenThuKho]   = useState('Thủ kho')
  const [detailGroup, setDetailGroup] = useState(null)
  const [saving, setSaving]         = useState(false)
  const [tab, setTab]               = useState('chenh')
  const [adminIdSet, setAdminIdSet] = useState(new Set())

  useEffect(() => { load() }, [phienId])

  async function load() {
    setLoading(true)

    // DVT map
    const dvtList = await db.dm_dvt.toArray()
    const dMap = {}
    dvtList.forEach(d => { dMap[d.ma_dvt] = d.ten_dvt })
    setDvtMap(dMap)

    // Phiên
    let phienData = await db.phien.get(phienId)
    if (!phienData && navigator.onLine) {
      const { data } = await supabase.from('phien_kiem_ke').select('*').eq('id', phienId).single()
      if (data) { await db.phien.put({ ...data, synced: true }); phienData = data }
    }
    if (navigator.onLine && phienData) {
      const { data } = await supabase
        .from('phien_kiem_ke').select('ke_toan_xac_nhan, thu_kho_xac_nhan').eq('id', phienId).single()
      if (data) { phienData = { ...phienData, ...data }; await db.phien.update(phienId, data) }
    }
    setPhien(phienData)

    // Tên người dùng
    if (phienData) {
      const [kt, tk] = await Promise.all([
        db.dm_user.get(phienData.ke_toan_id),
        db.dm_user.get(phienData.thu_kho_id)
      ])
      setTenKeToan(kt?.ho_ten || 'Kế toán')
      setTenThuKho(tk?.ho_ten || 'Thủ kho')
    }

    // dvt_chinh map
    const vtListRaw = navigator.onLine
      ? ((await supabase.from('dm_vat_tu').select('ma_vt, ma_dvt_chinh').eq('active', true)).data || [])
      : await db.dm_vat_tu.toArray()
    const cMap = {}
    vtListRaw.forEach(v => { if (v.ma_dvt_chinh) cMap[v.ma_vt] = v.ma_dvt_chinh })

    // Chi tiết kiểm kê
    let rows = await db.chitiet.where('phien_id').equals(phienId).toArray()
    if (navigator.onLine) {
      const { data } = await supabase.from('kiem_ke_chitiet').select('*').eq('phien_id', phienId)
      if (data?.length) {
        await db.chitiet.bulkPut(data.map(r => ({ ...r, synced: true })))
        rows = data
      }
    }

    const adminUsers = await db.dm_user.where('role').equals('admin').toArray()
    const localAdminSet = new Set(adminUsers.map(u => u.id))
    setAdminIdSet(localAdminSet)

    const ma_kho      = phienData?.ma_kho
    const ke_toan_id  = phienData?.ke_toan_id
    const thu_kho_id  = phienData?.thu_kho_id

    // Nhóm theo vật tư
    const byVt = {}
    rows.forEach(r => {
      if (!byVt[r.ma_vt]) byVt[r.ma_vt] = { ma_vt: r.ma_vt, ten_vt: r.ten_vt, rows: [] }
      byVt[r.ma_vt].rows.push(r)
    })

    const result = []
    for (const ma_vt of Object.keys(byVt)) {
      const group     = byVt[ma_vt]
      const maDvtC    = cMap[ma_vt]
      const tenDvtC   = maDvtC ? (dMap[maDvtC] || maDvtC) : ''

      const ktRows = group.rows.filter(r => r.nguoi_nhap_id === ke_toan_id || localAdminSet.has(r.nguoi_nhap_id))
      const tkRows = group.rows.filter(r => r.nguoi_nhap_id === thu_kho_id)

      const ktTong = ktRows.reduce((s, r) => s + (r.so_luong_quy_doi ?? r.so_luong_thuc_te ?? 0), 0)
      const tkTong = tkRows.reduce((s, r) => s + (r.so_luong_quy_doi ?? r.so_luong_thuc_te ?? 0), 0)

      const ktCoData = ktRows.length > 0
      const tkCoData = tkRows.length > 0
      const khopNhau = ktCoData && tkCoData && Math.abs(ktTong - tkTong) < EPS

      // so_luong_so_sach đã được lưu trong từng dòng chitiet khi nhập ở KiemKe
      // → dùng trực tiếp, không cần fetch ton_kho (có thể chưa được sync vào IndexedDB)
      const soSachRow = group.rows.find(r => r.so_luong_so_sach != null)
      const soSach    = soSachRow?.so_luong_so_sach ?? null

      // Chênh lệch KT so với sổ sách (dùng ktTong làm đại diện khi khớp, hoặc hiển thị cả 2 khi chưa khớp)
      const chenhSS = soSach !== null ? ktTong - soSach : null

      // Chỉ bỏ qua khi: KT=TK VÀ khớp luôn với sổ sách (hoặc không có SS để so)
      const hasIssue = !khopNhau || (chenhSS !== null && Math.abs(chenhSS) >= EPS)
      if (!hasIssue) continue

      result.push({
        ma_vt, ten_vt: group.rows[0].ten_vt,
        dvt_chinh: tenDvtC,
        kt_tong: ktTong, tk_tong: tkTong, so_sach: soSach,
        khop_nhau: khopNhau, chenh_ss: chenhSS,
        kt_co_data: ktCoData, tk_co_data: tkCoData,
        rows: group.rows.sort((a, b) => {
          const aKT = a.nguoi_nhap_id === ke_toan_id || localAdminSet.has(a.nguoi_nhap_id)
          const bKT = b.nguoi_nhap_id === ke_toan_id || localAdminSet.has(b.nguoi_nhap_id)
          if (aKT && !bKT) return -1
          if (!aKT && bKT) return 1
          return a.luot_kiem - b.luot_kiem
        })
      })
    }

    // Sắp xếp: chưa khớp KT-TK trước, rồi theo |chênh SS|
    result.sort((a, b) => {
      if (!a.khop_nhau && b.khop_nhau) return -1
      if (a.khop_nhau && !b.khop_nhau) return 1
      return Math.abs(b.chenh_ss || 0) - Math.abs(a.chenh_ss || 0)
    })
    setGroups(result)
    setLoading(false)
  }

  async function handleConfirm(field) {
    if (!phien || saving) return
    const bothConfirmed = phien.ke_toan_xac_nhan && phien.thu_kho_xac_nhan
    if (bothConfirmed && currentUser?.role !== 'admin') return
    setSaving(true)
    const newVal = !phien[field]
    setPhien(prev => ({ ...prev, [field]: newVal }))
    await updatePhienLocal(phienId, { [field]: newVal })
    if (navigator.onLine) pushOfflineQueue()
    setSaving(false)
  }

  function fmt(n) {
    if (n === null || n === undefined || isNaN(n)) return '—'
    return Math.abs(n).toFixed(3).replace(/\.?0+$/, '')
  }
  function fmtS(n) {
    if (n === null || n === undefined || isNaN(n)) return '—'
    const abs = Math.abs(n).toFixed(3).replace(/\.?0+$/, '')
    return (n > 0 ? '+' : n < 0 ? '−' : '') + abs
  }

  const isAdmin = currentUser?.role === 'admin'
  const isKeToan = currentUser?.id === phien?.ke_toan_id
  const isThuKho = currentUser?.id === phien?.thu_kho_id
  const bothConfirmed = !!(phien?.ke_toan_xac_nhan && phien?.thu_kho_xac_nhan)

  const gChenh  = groups.filter(g => !g.khop_nhau)
  const gSS     = groups.filter(g => g.chenh_ss !== null && Math.abs(g.chenh_ss) >= EPS)
  const tabList = tab === 'chenh' ? gChenh : tab === 'ss' ? gSS : groups

  // ── CHI TIẾT ────────────────────────────────────────────────────────
  if (detailGroup) {
    const { ma_vt, ten_vt, dvt_chinh, kt_tong, tk_tong, so_sach, khop_nhau, chenh_ss, rows } = detailGroup
    return (
      <div className="screen">
        <div className="topbar">
          <div className="topbar-title">{ma_vt} · {ten_vt}</div>
          <div className="topbar-sub">Chi tiết từng lượt kiểm</div>
        </div>
        <div className="content">

          {/* 3 chip tóm tắt */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            {[
              { label: tenKeToan, val: kt_tong },
              { label: tenThuKho, val: tk_tong },
              { label: 'Sổ sách',  val: so_sach }
            ].map(({ label, val }) => (
              <div key={label} style={{ flex: 1, background: 'var(--gray-bg)', borderRadius: 8, padding: '10px 10px' }}>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
                <div style={{ fontSize: 15, fontWeight: 700, marginTop: 3 }}>{val !== null ? fmt(val) : '—'}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{dvt_chinh}</div>
              </div>
            ))}
          </div>

          {/* Cảnh báo */}
          {!khop_nhau && (
            <div style={{ background: '#FEE2E2', color: '#991B1B', borderRadius: 8, padding: '8px 12px', marginBottom: 10, fontSize: 13, fontWeight: 500 }}>
              {tenKeToan} và {tenThuKho} chênh nhau {fmtS(kt_tong - tk_tong)} {dvt_chinh}
            </div>
          )}
          {khop_nhau && chenh_ss !== null && Math.abs(chenh_ss) >= EPS && (
            <div style={{
              background: chenh_ss > 0 ? '#FEF3C7' : '#FEE2E2',
              color: chenh_ss > 0 ? '#92400E' : '#991B1B',
              borderRadius: 8, padding: '8px 12px', marginBottom: 10, fontSize: 13, fontWeight: 500
            }}>
              {chenh_ss > 0 ? 'Thừa' : 'Thiếu'} {fmtS(chenh_ss)} {dvt_chinh} so với sổ sách
            </div>
          )}

          {/* Bảng chi tiết */}
          <div style={{ overflowX: 'auto', borderRadius: 8, border: '1px solid var(--border)' }}>
            <table className="detail-table">
              <thead>
                <tr>
                  <th>Người KK</th>
                  <th>Lượt</th>
                  <th>SL thực tế</th>
                  <th>ĐVT</th>
                  <th>Quy đổi</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const isKT = r.nguoi_nhap_id === phien?.ke_toan_id || adminIdSet.has(r.nguoi_nhap_id)
                  const isTK = r.nguoi_nhap_id === phien?.thu_kho_id && !adminIdSet.has(r.nguoi_nhap_id)
                  const lbl  = isKT ? 'KT' : isTK ? 'TK' : '?'
                  return (
                    <tr key={r.id}>
                      <td>
                        <span style={{
                          background: isKT ? '#DBEAFE' : isTK ? '#D1FAE5' : '#F3F4F6',
                          color: isKT ? '#1E40AF' : isTK ? '#065F46' : '#6B7280',
                          borderRadius: 4, padding: '2px 7px', fontSize: 11, fontWeight: 700
                        }}>{lbl}</span>
                      </td>
                      <td>{r.luot_kiem}</td>
                      <td>{fmt(r.so_luong_thuc_te)}</td>
                      <td>{dvtMap[r.ma_dvt_kiem] || r.ma_dvt_kiem}</td>
                      <td>{fmt(r.so_luong_quy_doi ?? r.so_luong_thuc_te)} {dvt_chinh}</td>
                    </tr>
                  )
                })}
                <tr className="detail-total">
                  <td colSpan={4} style={{ fontWeight: 600 }}>KT tổng / TK tổng</td>
                  <td style={{ fontWeight: 700 }}>
                    {fmt(kt_tong)} / {fmt(tk_tong)} {dvt_chinh}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 16 }}>
            <button className="btn-secondary" onClick={() => setDetailGroup(null)}>← Quay lại</button>
          </div>
        </div>
      </div>
    )
  }

  // ── DANH SÁCH ───────────────────────────────────────────────────────
  return (
    <div className="screen">
      <div className="topbar">
        <div className="topbar-title">Thừa / Thiếu</div>
        <div className="topbar-sub">{tenKeToan} (KT) · {tenThuKho} (TK)</div>
      </div>

      <div className="content">
        <div className="tab-row" style={{ marginBottom: 12 }}>
          <button className={`tab-btn ${tab === 'chenh' ? 'active' : ''}`} onClick={() => setTab('chenh')}>
            KT ≠ TK <span className="tab-count">{gChenh.length}</span>
          </button>
          <button className={`tab-btn ${tab === 'ss' ? 'active' : ''}`} onClick={() => setTab('ss')}>
            Thừa/Thiếu SS <span className="tab-count">{gSS.length}</span>
          </button>
          <button className={`tab-btn ${tab === 'all' ? 'active' : ''}`} onClick={() => setTab('all')}>
            Tất cả <span className="tab-count">{groups.length}</span>
          </button>
        </div>

        {loading ? (
          <div className="empty-state">Đang tải...</div>
        ) : tabList.length === 0 ? (
          <div className="empty-state">
            {tab === 'chenh'  ? `${tenKeToan} và ${tenThuKho} đã khớp số ✓` :
             tab === 'ss'     ? 'Không có hàng thừa thiếu so với sổ sách ✓' :
                                'Tất cả đều khớp ✓'}
          </div>
        ) : (
          tabList.map(g => (
            <div key={g.ma_vt} className="dc-card" onClick={() => setDetailGroup(g)} style={{ cursor: 'pointer' }}>
              <div className="dc-top">
                <div className="item-info">
                  <div className="item-name">
                    <span className="item-code">{g.ma_vt} · </span>{g.ten_vt}
                  </div>
                  <div className="item-meta">
                    KT: {fmt(g.kt_tong)} · TK: {fmt(g.tk_tong)}
                    {g.so_sach !== null ? ` · SS: ${fmt(g.so_sach)}` : ''} {g.dvt_chinh}
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end', flexShrink: 0 }}>
                  {!g.khop_nhau && (
                    <span className="badge badge-thieu">KT≠TK</span>
                  )}
                  {g.khop_nhau && g.chenh_ss !== null && Math.abs(g.chenh_ss) >= EPS && (
                    <span className={`badge ${g.chenh_ss > 0 ? 'badge-them' : 'badge-thieu'}`}>
                      {fmtS(g.chenh_ss)} {g.dvt_chinh}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))
        )}

        {/* Xác nhận hoàn thành phiên */}
        {phien && !loading && (
          <div className="confirm-section">
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)' }}>
              Xác nhận hoàn thành phiên
            </div>
            <div className="confirm-row">
              <button
                className={`confirm-chip ${phien.ke_toan_xac_nhan ? 'confirmed' : ''}`}
                onClick={() => (isKeToan || isAdmin) ? handleConfirm('ke_toan_xac_nhan') : null}
                disabled={saving || (bothConfirmed && !isAdmin)}
                style={{ cursor: (isKeToan || isAdmin) && !(bothConfirmed && !isAdmin) ? 'pointer' : 'default' }}
              >
                {phien.ke_toan_xac_nhan ? '✓ ' : '○ '}{tenKeToan}
              </button>
              <button
                className={`confirm-chip ${phien.thu_kho_xac_nhan ? 'confirmed' : ''}`}
                onClick={() => (isThuKho || isAdmin) ? handleConfirm('thu_kho_xac_nhan') : null}
                disabled={saving || (bothConfirmed && !isAdmin)}
                style={{ cursor: (isThuKho || isAdmin) && !(bothConfirmed && !isAdmin) ? 'pointer' : 'default' }}
              >
                {phien.thu_kho_xac_nhan ? '✓ ' : '○ '}{tenThuKho}
              </button>
            </div>
            {bothConfirmed && <div className="confirm-done">Phiên đã hoàn thành ✓</div>}
            {bothConfirmed && isAdmin && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', marginTop: 4 }}>
                Admin: nhấn vào để hủy xác nhận
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
