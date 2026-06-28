// src/screens/BatDauPhien.jsx
import { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { db, createPhienLocal, updatePhienLocal, deletePhienLocal } from '../lib/db'
import { supabase } from '../lib/supabase'

const toLocalDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
const TODAY = toLocalDate()

export default function BatDauPhien({ currentUser }) {
  const navigate = useNavigate()
  const location = useLocation()

  const [toast, setToast] = useState(null)

  function showToast(msg) {
    setToast(msg)
    setTimeout(() => setToast(null), 2800)
  }

  // Mode: 'list' | 'create' | 'edit'
  const [mode, setMode] = useState('list')
  const [editPhien, setEditPhien] = useState(null)
  const [editHasData, setEditHasData] = useState(false)
  const [form, setForm] = useState({ keToanId: '', thuKhoId: '', ngayKiem: TODAY, trangThai: 'dang_kiem' })
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  // List
  const [phienList, setPhienList] = useState([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)

  // Filters
  const [showFilters, setShowFilters] = useState(false)
  const [filters, setFilters] = useState({ keToanId: '', thuKhoId: '', tuNgay: '', denNgay: '', trangThai: '' })

  // Danh mục
  const [danhMucKho, setDanhMucKho] = useState([])
  const [danhMucKeToan, setDanhMucKeToan] = useState([])
  const [danhMucThuKho, setDanhMucThuKho] = useState([])
  const [userMap, setUserMap] = useState({})
  const [khoMap, setKhoMap] = useState({})
  const [loadingDM, setLoadingDM] = useState(true)

  // Fetch từ Supabase, xóa record stale trong IndexedDB, cập nhật state
  async function syncServer() {
    if (!navigator.onLine) return
    setSyncing(true)
    try {
      const [khoRes, userRes] = await Promise.all([
        supabase.from('dm_kho').select('*').eq('active', true).order('ten_kho'),
        supabase.from('dm_user').select('*').eq('active', true)
      ])
      if (khoRes.data) { await db.dm_kho.clear();  await db.dm_kho.bulkPut(khoRes.data) }
      if (userRes.data) { await db.dm_user.clear(); await db.dm_user.bulkPut(userRes.data) }

      const [khos, users] = await Promise.all([
        db.dm_kho.toArray(),
        db.dm_user.toArray()
      ])
      setDanhMucKho(khos)
      setDanhMucKeToan(users.filter(u => u.role === 'ke_toan'))
      setDanhMucThuKho(users.filter(u => u.role === 'thu_kho'))
      const kMap = {}, uMap = {}
      khos.forEach(k => { kMap[k.ma_kho] = k.ten_kho })
      users.forEach(u => { uMap[u.id] = u.ho_ten })
      setKhoMap(kMap)
      setUserMap(uMap)

      let query = supabase
        .from('phien_kiem_ke')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100)
      if (currentUser.role !== 'admin') {
        query = query.or(`ke_toan_id.eq.${currentUser.id},thu_kho_id.eq.${currentUser.id}`)
      }
      const { data } = await query
      if (data) {
        const freshIds = new Set(data.map(r => r.id))
        const localIds = await db.phien.toCollection().primaryKeys()
        const stale = localIds.filter(id => !freshIds.has(id))
        if (stale.length) await db.phien.bulkDelete(stale)
        if (data.length) await db.phien.bulkPut(data.map(r => ({ ...r, synced: true })))
        const rows = await db.phien.toArray()
        rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        setPhienList(rows)
      }
    } finally {
      setSyncing(false)
    }
  }

  // Đọc từ IndexedDB — không gọi network
  async function loadLocal() {
    setLoading(true)
    setLoadingDM(true)

    const [khos, users] = await Promise.all([
      db.dm_kho.toArray(),
      db.dm_user.toArray()
    ])
    setDanhMucKho(khos)
    setDanhMucKeToan(users.filter(u => u.role === 'ke_toan'))
    setDanhMucThuKho(users.filter(u => u.role === 'thu_kho'))
    const kMap = {}, uMap = {}
    khos.forEach(k => { kMap[k.ma_kho] = k.ten_kho })
    users.forEach(u => { uMap[u.id] = u.ho_ten })
    setKhoMap(kMap)
    setUserMap(uMap)
    setLoadingDM(false)

    let rows = await db.phien.toArray()
    if (currentUser.role !== 'admin') {
      rows = rows.filter(r => r.ke_toan_id === currentUser.id || r.thu_kho_id === currentUser.id)
    }
    rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    setPhienList(rows)
    setLoading(false)

    // Lần đầu mở app mà chưa có dữ liệu local thì sync luôn
    if (rows.length === 0) syncServer()
  }

  // Mount: chỉ đọc local
  useEffect(() => { loadLocal() }, [])

  // Khi tab "Phiên KK" được click (location.state.refresh thay đổi): sync server
  useEffect(() => {
    if (location.state?.refresh !== undefined) syncServer()
  }, [location.state?.refresh])

  // ── CREATE ──────────────────────────────────────────────────────────
  function openCreate() {
    setForm({
      keToanId: currentUser.role === 'ke_toan' ? currentUser.id : '',
      thuKhoId: currentUser.role === 'thu_kho' ? currentUser.id : '',
      ngayKiem: TODAY,
      trangThai: 'dang_kiem'
    })
    setFormError('')
    setMode('create')
  }

  async function handleCreate() {
    if (!form.keToanId || !form.thuKhoId) {
      setFormError('Vui lòng chọn kế toán và thủ kho.')
      return
    }
    setSaving(true)
    const phien = {
      id: crypto.randomUUID(),
      ke_toan_id: form.keToanId,
      thu_kho_id: form.thuKhoId,
      ngay_kiem: form.ngayKiem,
      trang_thai: form.trangThai,
      created_at: new Date().toISOString()
    }

    if (navigator.onLine) {
      const { error } = await supabase.from('phien_kiem_ke').insert({
        id: phien.id,
        ma_kho: null,
        ke_toan_id: phien.ke_toan_id,
        thu_kho_id: phien.thu_kho_id,
        ngay_kiem: phien.ngay_kiem,
        trang_thai: phien.trang_thai,
        xac_nhan_ke_toan: false,
        xac_nhan_thu_kho: false
      })
      if (error) {
        setFormError(`Lỗi lưu phiên: ${error.message}`)
        setSaving(false)
        return
      }
      await db.phien.put({ ...phien, synced: true })
    } else {
      await createPhienLocal(phien)
    }

    setPhienList(prev => [{ ...phien, synced: navigator.onLine }, ...prev])
    setSaving(false)
    setMode('list')
  }

  // ── EDIT ─────────────────────────────────────────────────────────────
  async function openEdit(phien) {
    setEditPhien(phien)
    setForm({
      keToanId: phien.ke_toan_id,
      thuKhoId: phien.thu_kho_id,
      ngayKiem: phien.ngay_kiem?.slice(0, 10) || TODAY,
      trangThai: phien.trang_thai
    })
    setFormError('')
    let count = await db.chitiet.where('phien_id').equals(phien.id).count()
    if (count === 0 && navigator.onLine) {
      const { count: sc } = await supabase
        .from('kiem_ke_chitiet')
        .select('id', { count: 'exact', head: true })
        .eq('phien_id', phien.id)
      count = sc ?? 0
    }
    setEditHasData(count > 0)
    setMode('edit')
  }

  async function handleUpdate() {
    if (!form.keToanId || !form.thuKhoId) {
      setFormError('Vui lòng chọn kế toán và thủ kho.')
      return
    }
    setSaving(true)
    const changes = {
      ke_toan_id: form.keToanId,
      thu_kho_id: form.thuKhoId,
      ngay_kiem: form.ngayKiem,
      trang_thai: form.trangThai,
      // Reset xác nhận khi admin mở lại phiên
      ...(form.trangThai === 'dang_kiem' && { xac_nhan_ke_toan: false, xac_nhan_thu_kho: false })
    }

    if (navigator.onLine) {
      const { error } = await supabase.from('phien_kiem_ke').update(changes).eq('id', editPhien.id)
      if (error) {
        setFormError(`Lỗi cập nhật phiên: ${error.message}`)
        setSaving(false)
        return
      }
      await db.phien.update(editPhien.id, { ...changes, synced: true })
    } else {
      await updatePhienLocal(editPhien.id, changes)
    }

    setPhienList(prev => prev.map(p =>
      p.id === editPhien.id ? { ...p, ...changes } : p
    ))
    setSaving(false)
    setMode('list')
  }

  // ── DELETE ───────────────────────────────────────────────────────────
  async function handleDelete(phien) {
    let soChiTiet = await db.chitiet.where('phien_id').equals(phien.id).count()
    if (soChiTiet === 0 && navigator.onLine) {
      const { count } = await supabase
        .from('kiem_ke_chitiet')
        .select('id', { count: 'exact', head: true })
        .eq('phien_id', phien.id)
      soChiTiet = count ?? 0
    }
    if (soChiTiet > 0) {
      showToast(`Không thể xóa — phiên này đã có ${soChiTiet} dòng số liệu`)
      return
    }
    if (!window.confirm('Xóa phiên kiểm kê này?')) return
    setPhienList(prev => prev.filter(p => p.id !== phien.id))
    if (navigator.onLine) {
      await supabase.from('kiem_ke_chitiet').delete().eq('phien_id', phien.id)
      await supabase.from('phien_kiem_ke').delete().eq('id', phien.id)
      await db.chitiet.where('phien_id').equals(phien.id).delete()
      await db.phien.delete(phien.id)
    } else {
      await deletePhienLocal(phien.id)
    }
  }

  // ── XÁC NHẬN HOÀN THÀNH ──────────────────────────────────────────────
  async function handleXacNhan(p) {
    if (!navigator.onLine) { showToast('Cần có mạng để xác nhận'); return }
    const isKeToan = currentUser.id === p.ke_toan_id
    const myField  = isKeToan ? 'xac_nhan_ke_toan' : 'xac_nhan_thu_kho'
    const myVal    = isKeToan ? (p.xac_nhan_ke_toan || false) : (p.xac_nhan_thu_kho || false)
    const newVal   = !myVal

    const updates = { [myField]: newVal }
    if (newVal) {
      const otherOk = isKeToan ? (p.xac_nhan_thu_kho || false) : (p.xac_nhan_ke_toan || false)
      if (otherOk) updates.trang_thai = 'hoan_thanh'
    }

    const { data } = await supabase
      .from('phien_kiem_ke').update(updates).eq('id', p.id).select().single()

    if (data) {
      setPhienList(prev => prev.map(item => item.id === p.id ? { ...item, ...data } : item))
      await db.phien.update(p.id, {
        xac_nhan_ke_toan: data.xac_nhan_ke_toan,
        xac_nhan_thu_kho: data.xac_nhan_thu_kho,
        trang_thai: data.trang_thai
      })
    }
  }

  // ── FILTER ───────────────────────────────────────────────────────────
  const filtered = phienList.filter(p => {
    if (filters.keToanId && p.ke_toan_id !== filters.keToanId) return false
    if (filters.thuKhoId && p.thu_kho_id !== filters.thuKhoId) return false
    if (filters.trangThai && p.trang_thai !== filters.trangThai) return false
    if (filters.tuNgay && p.ngay_kiem < filters.tuNgay) return false
    if (filters.denNgay && p.ngay_kiem > filters.denNgay) return false
    return true
  })

  const activeFilterCount = Object.values(filters).filter(v => v !== '').length
  const hasFilters = activeFilterCount > 0

  function clearFilters() {
    setFilters({ keToanId: '', thuKhoId: '', tuNgay: '', denNgay: '', trangThai: '' })
  }

  // ── SUB-SCREEN: Tạo / Sửa ──────────────────────────────────────────
  if (mode === 'create' || mode === 'edit') {
    const isEdit = mode === 'edit'
    return (
      <div className="screen">
        <div className="topbar" style={{ minHeight: 72 }}>
          <div className="topbar-title">{isEdit ? 'Sửa phiên kiểm kê' : 'Tạo phiên mới'}</div>
        </div>

        <div className="content">
          {formError && <div className="error-box">{formError}</div>}

          <div className="field-group">
            <label className="field-label">Kế toán</label>
            {currentUser.role === 'ke_toan' || (isEdit && editHasData) ? (
              <div className="input-readonly">
                {danhMucKeToan.find(u => u.id === form.keToanId)?.ho_ten || currentUser.ho_ten}
                {isEdit && editHasData && <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 6 }}>· đã có số liệu</span>}
              </div>
            ) : (
              <select className="input-select" value={form.keToanId}
                onChange={e => setForm(f => ({ ...f, keToanId: e.target.value }))}
                disabled={loadingDM}>
                <option value="">-- Chọn kế toán --</option>
                {danhMucKeToan.map(u => <option key={u.id} value={u.id}>{u.ho_ten}</option>)}
              </select>
            )}
          </div>

          <div className="field-group">
            <label className="field-label">Thủ kho</label>
            {currentUser.role === 'thu_kho' || (isEdit && editHasData) ? (
              <div className="input-readonly">
                {danhMucThuKho.find(u => u.id === form.thuKhoId)?.ho_ten || currentUser.ho_ten}
                {isEdit && editHasData && <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 6 }}>· đã có số liệu</span>}
              </div>
            ) : (
              <select className="input-select" value={form.thuKhoId}
                onChange={e => setForm(f => ({ ...f, thuKhoId: e.target.value }))}
                disabled={loadingDM}>
                <option value="">-- Chọn thủ kho --</option>
                {danhMucThuKho.map(u => <option key={u.id} value={u.id}>{u.ho_ten}</option>)}
              </select>
            )}
          </div>

          <div className="row-2col">
            <div className="field-group">
              <label className="field-label">Ngày kiểm</label>
              <input type="date" className="input-field" value={form.ngayKiem}
                onChange={e => setForm(f => ({ ...f, ngayKiem: e.target.value }))} />
            </div>
            {isEdit && currentUser.role === 'admin' && (
              <div className="field-group">
                <label className="field-label">Tình trạng</label>
                <select className="input-select" value={form.trangThai}
                  onChange={e => setForm(f => ({ ...f, trangThai: e.target.value }))}>
                  <option value="dang_kiem">Đang kiểm</option>
                  <option value="hoan_thanh">Hoàn thành</option>
                </select>
              </div>
            )}
          </div>

          <div className="row-2col">
            <button className="btn-secondary" onClick={() => setMode('list')} disabled={saving}>
              Hủy
            </button>
            <button className="btn-primary"
              onClick={isEdit ? handleUpdate : handleCreate}
              disabled={saving || loadingDM}>
              {saving ? 'Đang lưu...' : 'Lưu'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── LIST SCREEN ────────────────────────────────────────────────────
  return (
    <div className="screen">
      <div className="topbar">
        <div className="topbar-title">Phiên kiểm kê</div>
        <div className="topbar-sub">{filtered.length} phiên</div>
      </div>

      <div className="content">
        {/* Filter toggle + Tạo mới cùng hàng */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <button className="btn-sm-outline" onClick={openCreate}>+ Tạo phiên</button>
          <span style={{ flex: 1, fontSize: 13, color: 'var(--text-muted)' }}>{filtered.length} phiên</span>
          {hasFilters && (
            <button onClick={clearFilters} style={{
              border: 'none', background: 'none', color: 'var(--green)',
              fontSize: 13, cursor: 'pointer', padding: 0, whiteSpace: 'nowrap'
            }}>Xóa lọc</button>
          )}
          <button onClick={() => setShowFilters(v => !v)} style={{
            padding: '0 16px', height: 38, borderRadius: 8, border: '1px solid var(--border)',
            background: hasFilters ? 'var(--green)' : '#fff',
            color: hasFilters ? '#fff' : 'var(--text)',
            fontWeight: 500, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap'
          }}>
            Lọc{hasFilters ? ` (${activeFilterCount})` : ''} {showFilters ? '▲' : '▼'}
          </button>
        </div>

        {/* Filter panel */}
        {showFilters && (
          <div className="filter-panel">
            <div className="row-2col">
              <div className="field-group">
                <label className="field-label">Tình trạng</label>
                <select className="input-select" value={filters.trangThai}
                  onChange={e => setFilters(f => ({ ...f, trangThai: e.target.value }))}>
                  <option value="">Tất cả</option>
                  <option value="dang_kiem">Đang kiểm</option>
                  <option value="hoan_thanh">Hoàn thành</option>
                </select>
              </div>
            </div>
            <div className="row-2col">
              <div className="field-group">
                <label className="field-label">Kế toán</label>
                <select className="input-select" value={filters.keToanId}
                  onChange={e => setFilters(f => ({ ...f, keToanId: e.target.value }))}>
                  <option value="">Tất cả</option>
                  {danhMucKeToan.map(u => <option key={u.id} value={u.id}>{u.ho_ten}</option>)}
                </select>
              </div>
              <div className="field-group">
                <label className="field-label">Thủ kho</label>
                <select className="input-select" value={filters.thuKhoId}
                  onChange={e => setFilters(f => ({ ...f, thuKhoId: e.target.value }))}>
                  <option value="">Tất cả</option>
                  {danhMucThuKho.map(u => <option key={u.id} value={u.id}>{u.ho_ten}</option>)}
                </select>
              </div>
            </div>
            <div className="row-2col">
              <div className="field-group">
                <label className="field-label">Từ ngày</label>
                <input type="date" className="input-field" value={filters.tuNgay}
                  onChange={e => setFilters(f => ({ ...f, tuNgay: e.target.value }))} />
              </div>
              <div className="field-group">
                <label className="field-label">Đến ngày</label>
                <input type="date" className="input-field" value={filters.denNgay}
                  onChange={e => setFilters(f => ({ ...f, denNgay: e.target.value }))} />
              </div>
            </div>
          </div>
        )}

        {/* Danh sách phiên */}
        {loading ? (
          <div className="empty-state">Đang tải...</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            {hasFilters ? 'Không có phiên nào khớp bộ lọc' : 'Chưa có phiên kiểm kê nào'}
          </div>
        ) : (
          filtered.map(p => {
            const tenKho   = p.ma_kho ? (khoMap[p.ma_kho] || p.ma_kho) : null
            const tenKT    = userMap[p.ke_toan_id] || '—'
            const tenTK    = userMap[p.thu_kho_id] || '—'
            const ngay     = new Date(p.ngay_kiem || p.created_at)
              .toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })
            const gio      = new Date(p.created_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
            const maPhien  = p.id?.slice(-4).toUpperCase()
            const dangKiem = p.trang_thai !== 'hoan_thanh'
            const isLocked = p.xac_nhan_ke_toan || p.xac_nhan_thu_kho
            return (
              <div key={p.id} className="phien-card">
                <div className="phien-card-top"
                  onClick={() => {
                    if (!dangKiem) { showToast('Phiên đã hoàn thành. Admin cần đổi lại trạng thái mới kiểm kê được.'); return }
                    if (isLocked)  { showToast('Đã có xác nhận — không thể nhập thêm. Bỏ xác nhận để tiếp tục.'); return }
                    navigate(`/kiem-ke/${p.id}`)
                  }}
                  style={{ cursor: (dangKiem && !isLocked) ? 'pointer' : 'not-allowed' }}>
                  <div className="phien-card-info">
                    <div className="phien-card-kho">Mã phiên: #{maPhien}</div>
                    <div className="phien-card-meta">{ngay} {gio} · {tenKT} & {tenTK}</div>
                    {tenKho && <div className="phien-card-meta" style={{ marginTop: 2 }}>{tenKho}</div>}
                  </div>
                  <span className={`badge ${dangKiem ? 'badge-warn' : 'badge-ok'}`}>
                    {dangKiem ? 'Đang kiểm' : 'Hoàn thành'}
                  </span>
                </div>

                {/* Xác nhận hoàn thành — hiện cho người tham gia và admin */}
                {(currentUser.id === p.ke_toan_id || currentUser.id === p.thu_kho_id || currentUser.role === 'admin') && (
                  <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', background: '#F9FAFB' }}>
                    {p.trang_thai === 'hoan_thanh' ? (
                      <div className="confirm-done">✓ Phiên đã hoàn thành</div>
                    ) : (
                      <div style={{ display: 'flex', gap: 8 }}>
                        {[
                          { label: 'Kế toán', userId: p.ke_toan_id, confirmed: p.xac_nhan_ke_toan },
                          { label: 'Thủ kho', userId: p.thu_kho_id, confirmed: p.xac_nhan_thu_kho }
                        ].map(({ label, userId, confirmed }) => {
                          const isMe = currentUser.id === userId
                          return (
                            <button key={label} onClick={() => isMe && handleXacNhan(p)} style={{
                              flex: 1, padding: '10px 8px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                              border: `1.5px solid ${confirmed ? 'var(--green)' : isMe ? 'var(--green)' : 'var(--border)'}`,
                              background: confirmed ? '#e1f5ee' : isMe ? 'var(--green-light)' : 'white',
                              color: confirmed ? 'var(--green-dark)' : isMe ? 'var(--green-dark)' : 'var(--text-muted)',
                              cursor: isMe ? 'pointer' : 'default',
                              opacity: !isMe && !confirmed ? 0.45 : 1,
                            }}>
                              <span style={{ fontSize: 11, fontWeight: 400, opacity: 0.8 }}>{label}</span>
                              <span>
                                {confirmed
                                  ? (isMe ? '✕ Bấm để bỏ xác nhận' : '✓ Đã xác nhận')
                                  : (isMe ? '✓ Bấm để xác nhận hoàn thành' : '○ Chưa xác nhận')}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* Nút hành động */}
                <div className="phien-card-actions-full">
                  {dangKiem && !isLocked && (
                    <button className="dc-btn dc-btn-kk"
                      onClick={() => navigate(`/kiem-ke/${p.id}`)}>
                      Kiểm kê
                    </button>
                  )}
                  <button className="dc-btn dc-btn-view"
                    onClick={() => navigate(`/dem-lai/${p.id}`)}>
                    Đối chiếu
                  </button>
                  {(!isLocked || currentUser.role === 'admin') && (
                    <button className="dc-btn dc-btn-edit" onClick={() => openEdit(p)}>
                      Sửa
                    </button>
                  )}
                  {!isLocked && (
                    <button className="dc-btn dc-btn-del" onClick={() => handleDelete(p)}>
                      Xóa
                    </button>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>

      {toast && (
        <div style={{
          position: 'fixed', bottom: 80, left: '50%', transform: 'translateX(-50%)',
          background: '#1a1a1a', color: '#fff',
          padding: '10px 18px', borderRadius: 10,
          fontSize: 13, zIndex: 1000,
          maxWidth: 320, textAlign: 'center',
          boxShadow: '0 4px 16px rgba(0,0,0,0.25)'
        }}>
          {toast}
        </div>
      )}
    </div>
  )
}
