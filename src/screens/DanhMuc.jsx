// src/screens/DanhMuc.jsx
import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { pullDanhMuc } from '../lib/sync'
import * as XLSX from 'xlsx'

const TABS = [
  { key: 'kho',    label: 'Kho' },
  { key: 'dvt',    label: 'Đơn vị tính' },
  { key: 'vat_tu', label: 'Vật tư' },
]

const EMPTY = { kho: { ma_kho: '', ten_kho: '', active: true },
                dvt: { ma_dvt: '', ten_dvt: '', active: true },
                vat_tu: { ma_vt: '', ten_vt: '', ma_dvt_chinh: '', active: true } }

export default function DanhMuc({ inline = false }) {
  const navigate = useNavigate()
  const [tab, setTab]           = useState('kho')
  const [list, setList]         = useState([])
  const [loading, setLoading]   = useState(false)
  const [search, setSearch]     = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editItem, setEditItem] = useState(null)
  const [form, setForm]         = useState(EMPTY.kho)
  const [saving, setSaving]     = useState(false)
  const [err, setErr]           = useState('')
  const [deletingId, setDeletingId] = useState(null)
  const [dvtOptions, setDvtOptions] = useState([])
  const [importing, setImporting]   = useState(false)
  const importRef = useRef(null)

  const toActive = v => String(v ?? '1').trim() !== '0'

  const TAB_CFG = {
    kho: {
      table: 'dm_kho', key: 'ma_kho',
      headers: ['ma_kho', 'ten_kho', 'active'],
      getRow: r => [r.ma_kho, r.ten_kho, r.active ? 1 : 0],
      toPayload: cols => ({ ma_kho: String(cols[0]||'').trim().toUpperCase(), ten_kho: String(cols[1]||'').trim(), active: toActive(cols[2]) }),
    },
    dvt: {
      table: 'dm_dvt', key: 'ma_dvt',
      headers: ['ma_dvt', 'ten_dvt', 'active'],
      getRow: r => [r.ma_dvt, r.ten_dvt, r.active ? 1 : 0],
      toPayload: cols => ({ ma_dvt: String(cols[0]||'').trim().toUpperCase(), ten_dvt: String(cols[1]||'').trim(), active: toActive(cols[2]) }),
    },
    vat_tu: {
      table: 'dm_vat_tu', key: 'ma_vt',
      headers: ['ma_vt', 'ten_vt', 'ma_dvt_chinh', 'active'],
      getRow: r => [r.ma_vt, r.ten_vt, r.ma_dvt_chinh || '', r.active ? 1 : 0],
      toPayload: cols => ({ ma_vt: String(cols[0]||'').trim().toUpperCase(), ten_vt: String(cols[1]||'').trim(), ma_dvt_chinh: String(cols[2]||'').trim() || null, active: toActive(cols[3]) }),
    },
  }

  useEffect(() => { loadList(); setSearch(''); closeForm() }, [tab])
  useEffect(() => { if (tab === 'vat_tu') loadDvtOptions() }, [tab])

  async function loadList() {
    setLoading(true)
    const tableMap = { kho: 'dm_kho', dvt: 'dm_dvt', vat_tu: 'dm_vat_tu' }
    const orderMap = { kho: 'ma_kho', dvt: 'ma_dvt', vat_tu: 'ma_vt' }
    const { data } = await supabase.from(tableMap[tab]).select('*').order(orderMap[tab])
    setList(data || [])
    setLoading(false)
  }

  async function loadDvtOptions() {
    const { data } = await supabase.from('dm_dvt').select('ma_dvt, ten_dvt').eq('active', true).order('ma_dvt')
    setDvtOptions(data || [])
  }

  function openCreate() {
    setEditItem(null)
    setForm(EMPTY[tab])
    setErr('')
    setShowForm(true)
  }

  function openEdit(item) {
    setEditItem(item)
    if (tab === 'kho')    setForm({ ma_kho: item.ma_kho, ten_kho: item.ten_kho, active: item.active })
    if (tab === 'dvt')    setForm({ ma_dvt: item.ma_dvt, ten_dvt: item.ten_dvt, active: item.active })
    if (tab === 'vat_tu') setForm({ ma_vt: item.ma_vt, ten_vt: item.ten_vt, ma_dvt_chinh: item.ma_dvt_chinh || '', active: item.active })
    setErr('')
    setShowForm(true)
  }

  function closeForm() {
    setShowForm(false)
    setEditItem(null)
    setErr('')
  }

  function setF(key, val) { setForm(f => ({ ...f, [key]: val })) }

  async function handleSave() {
    setErr('')
    let payload = {}
    let table = ''

    if (tab === 'kho') {
      if (!form.ma_kho.trim() || !form.ten_kho.trim()) { setErr('Mã kho và tên kho là bắt buộc'); return }
      table = 'dm_kho'
      payload = editItem
        ? { ten_kho: form.ten_kho.trim(), active: form.active }
        : { ma_kho: form.ma_kho.trim().toUpperCase(), ten_kho: form.ten_kho.trim(), active: form.active }
    } else if (tab === 'dvt') {
      if (!form.ma_dvt.trim() || !form.ten_dvt.trim()) { setErr('Mã DVT và tên DVT là bắt buộc'); return }
      table = 'dm_dvt'
      payload = editItem
        ? { ten_dvt: form.ten_dvt.trim(), active: form.active }
        : { ma_dvt: form.ma_dvt.trim().toUpperCase(), ten_dvt: form.ten_dvt.trim(), active: form.active }
    } else {
      if (!form.ma_vt.trim() || !form.ten_vt.trim()) { setErr('Mã vật tư và tên là bắt buộc'); return }
      table = 'dm_vat_tu'
      payload = editItem
        ? { ten_vt: form.ten_vt.trim(), ma_dvt_chinh: form.ma_dvt_chinh || null, active: form.active }
        : { ma_vt: form.ma_vt.trim().toUpperCase(), ten_vt: form.ten_vt.trim(), ma_dvt_chinh: form.ma_dvt_chinh || null, active: form.active }
    }

    setSaving(true)
    try {
      const q = editItem
        ? supabase.from(table).update(payload).eq('id', editItem.id)
        : supabase.from(table).insert(payload)
      const { error } = await q
      if (error) throw new Error(error.message)
      await loadList()
      await pullDanhMuc()
      closeForm()
    } catch (e) {
      setErr(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id) {
    const tableMap = { kho: 'dm_kho', dvt: 'dm_dvt', vat_tu: 'dm_vat_tu' }
    setSaving(true)
    try {
      const { error } = await supabase.from(tableMap[tab]).delete().eq('id', id)
      if (error) throw new Error(error.message)
      await loadList()
      await pullDanhMuc()
    } catch (e) {
      setErr(e.message)
    } finally {
      setSaving(false)
      setDeletingId(null)
    }
  }

  async function handleToggleActive(item) {
    const tableMap = { kho: 'dm_kho', dvt: 'dm_dvt', vat_tu: 'dm_vat_tu' }
    await supabase.from(tableMap[tab]).update({ active: !item.active }).eq('id', item.id)
    setList(prev => prev.map(r => r.id === item.id ? { ...r, active: !item.active } : r))
  }

  function handleExport() {
    const cfg = TAB_CFG[tab]
    const ws = XLSX.utils.aoa_to_sheet([cfg.headers, ...list.map(r => cfg.getRow(r))])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, tab)
    const d = new Date()
    const dateStr = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`
    XLSX.writeFile(wb, `DanhMuc_${tab}_${dateStr}.xlsx`)
  }

  async function handleImport(e) {
    const file = e.target.files?.[0]; if (!file) return
    e.target.value = ''
    const cfg = TAB_CFG[tab]
    setImporting(true); setErr('')
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf)
      const ws = wb.Sheets[wb.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1 })
      const payloads = rows.slice(1)
        .filter(r => r[0])
        .map(r => cfg.toPayload(r))
      if (!payloads.length) { setErr('Không có dòng hợp lệ'); return }
      const { error } = await supabase.from(cfg.table).upsert(payloads, { onConflict: cfg.key })
      if (error) throw new Error(error.message)
      await loadList(); await pullDanhMuc()
    } catch (e) { setErr('Import lỗi: ' + e.message) }
    finally { setImporting(false) }
  }

  // Lọc danh sách theo search
  const kw = search.trim().toLowerCase()
  const filtered = list.filter(r => {
    if (!kw) return true
    if (tab === 'kho')    return `${r.ma_kho} ${r.ten_kho}`.toLowerCase().includes(kw)
    if (tab === 'dvt')    return `${r.ma_dvt} ${r.ten_dvt}`.toLowerCase().includes(kw)
    if (tab === 'vat_tu') return `${r.ma_vt} ${r.ten_vt}`.toLowerCase().includes(kw)
    return true
  })

  // ── Form sub-screen ──────────────────────────────────────────────
  if (showForm) {
    const titleMap = { kho: 'kho', dvt: 'đơn vị tính', vat_tu: 'vật tư' }
    return (
      <div className={inline ? undefined : 'screen'}>
        {!inline && (
          <div className="topbar">
            <div className="topbar-title">{editItem ? 'Sửa' : 'Thêm'} {titleMap[tab]}</div>
            <div className="topbar-sub">{editItem ? 'Chỉnh sửa thông tin' : 'Tạo mới'}</div>
          </div>
        )}
        {inline && (
          <div style={{ fontWeight: 600, fontSize: 15, padding: '12px 0 8px' }}>
            {editItem ? 'Sửa' : 'Thêm'} {titleMap[tab]}
          </div>
        )}
        <div className="content">
          {err && <div className="error-box">{err}</div>}

          {tab === 'kho' && <>
            <div className="field-group">
              <label className="field-label">Mã kho *</label>
              <input className="input-field" value={form.ma_kho}
                onChange={e => setF('ma_kho', e.target.value)}
                placeholder="VD: KHO01" disabled={!!editItem} />
              {editItem && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Không thể đổi mã kho sau khi tạo</div>}
            </div>
            <div className="field-group">
              <label className="field-label">Tên kho *</label>
              <input className="input-field" value={form.ten_kho}
                onChange={e => setF('ten_kho', e.target.value)}
                placeholder="VD: Kho Nguyên Liệu A" />
            </div>
          </>}

          {tab === 'dvt' && <>
            <div className="field-group">
              <label className="field-label">Mã ĐVT *</label>
              <input className="input-field" value={form.ma_dvt}
                onChange={e => setF('ma_dvt', e.target.value)}
                placeholder="VD: KG, CAI, HOP" disabled={!!editItem} />
              {editItem && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Không thể đổi mã DVT sau khi tạo</div>}
            </div>
            <div className="field-group">
              <label className="field-label">Tên đơn vị tính *</label>
              <input className="input-field" value={form.ten_dvt}
                onChange={e => setF('ten_dvt', e.target.value)}
                placeholder="VD: Kilogram, Cái, Hộp" />
            </div>
          </>}

          {tab === 'vat_tu' && <>
            <div className="field-group">
              <label className="field-label">Mã vật tư *</label>
              <input className="input-field" value={form.ma_vt}
                onChange={e => setF('ma_vt', e.target.value)}
                placeholder="VD: VT001" disabled={!!editItem} />
              {editItem && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Không thể đổi mã vật tư sau khi tạo</div>}
            </div>
            <div className="field-group">
              <label className="field-label">Tên vật tư *</label>
              <input className="input-field" value={form.ten_vt}
                onChange={e => setF('ten_vt', e.target.value)}
                placeholder="Tên vật tư" />
            </div>
            <div className="field-group">
              <label className="field-label">Đơn vị tính chính</label>
              <select className="input-select" value={form.ma_dvt_chinh}
                onChange={e => setF('ma_dvt_chinh', e.target.value)}>
                <option value="">-- Chọn DVT --</option>
                {dvtOptions.map(d => (
                  <option key={d.ma_dvt} value={d.ma_dvt}>{d.ma_dvt}</option>
                ))}
              </select>
            </div>
          </>}

          <div className="field-group">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={form.active}
                onChange={e => setF('active', e.target.checked)} />
              <span className="field-label" style={{ margin: 0 }}>Đang hoạt động</span>
            </label>
          </div>

          <div className="row-2col" style={{ marginTop: 8 }}>
            <button className="btn-secondary" onClick={closeForm} disabled={saving}>Hủy</button>
            <button className="btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Đang lưu...' : editItem ? 'Lưu thay đổi' : 'Tạo mới'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Main screen ──────────────────────────────────────────────────
  const countLabel = { kho: 'kho', dvt: 'đơn vị tính', vat_tu: 'vật tư' }

  return (
    <div className={inline ? undefined : 'screen'}>
      {!inline && (
        <div className="topbar">
          <div className="topbar-title">Quản lý danh mục</div>
        </div>
      )}

      {/* Tab bar */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)' }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            flex: 1, padding: '10px 4px', border: 'none', background: 'none',
            fontSize: 13, fontWeight: 500,
            color: tab === t.key ? 'var(--green)' : 'var(--text-muted)',
            borderBottom: tab === t.key ? '2px solid var(--green)' : '2px solid transparent',
            cursor: 'pointer'
          }}>{t.label}</button>
        ))}
      </div>

      <div className="content">
        {err && <div className="error-box" onClick={() => setErr('')}>{err} ✕</div>}

        <button className="btn-primary" onClick={openCreate} style={{ width: '100%', marginBottom: 8 }}>
          + Thêm {countLabel[tab]}
        </button>
        <div className="row-2col" style={{ marginBottom: 10 }}>
          <button className="btn-secondary" onClick={handleExport} disabled={!list.length}>
            ⬇ Export CSV
          </button>
          <button className="btn-secondary" onClick={() => importRef.current?.click()} disabled={importing}>
            {importing ? 'Đang import...' : '⬆ Import CSV'}
          </button>
        </div>
        <input ref={importRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={handleImport} />

        <input className="input-field" placeholder="Tìm kiếm..." value={search}
          onChange={e => setSearch(e.target.value)} style={{ marginBottom: 12 }} />

        {loading ? (
          <div className="empty-state">Đang tải...</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">Không có dữ liệu</div>
        ) : filtered.map(item => {
          const id = item.id
          const ma   = tab === 'kho' ? item.ma_kho : tab === 'dvt' ? item.ma_dvt : item.ma_vt
          const name = tab === 'kho' ? item.ten_kho : tab === 'dvt' ? item.ten_dvt : item.ten_vt
          const sub  = tab === 'vat_tu' && item.ma_dvt_chinh ? `DVT: ${item.ma_dvt_chinh}` : null

          return (
            <div key={id} className="phien-card" style={{ opacity: item.active ? 1 : 0.55 }}>
              <div className="phien-card-top">
                <div className="phien-card-info">
                  <div className="phien-card-kho">{name}</div>
                  <div className="phien-card-meta">
                    {ma}{sub ? ` · ${sub}` : ''}
                  </div>
                </div>
                <span style={{
                  fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
                  background: item.active ? '#D1FAE5' : '#F3F4F6',
                  color: item.active ? '#065F46' : '#6B7280'
                }}>
                  {item.active ? 'Hoạt động' : 'Tạm ẩn'}
                </span>
              </div>

              {deletingId === id && (
                <div style={{ padding: '8px 14px', borderTop: '1px solid var(--border)', background: '#FEF2F2', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ flex: 1, fontSize: 13, color: '#991B1B' }}>Xác nhận xóa {name}?</span>
                  <button className="btn-primary" style={{ background: '#EF4444', border: 'none', height: 30, fontSize: 12, padding: '0 12px' }}
                    onClick={() => handleDelete(id)} disabled={saving}>
                    {saving ? '...' : 'Xóa'}
                  </button>
                  <button className="btn-secondary" style={{ height: 30, fontSize: 12, padding: '0 12px' }}
                    onClick={() => setDeletingId(null)}>Hủy</button>
                </div>
              )}

              <div className="phien-card-actions-full">
                {[
                  { label: 'Sửa',    onClick: () => openEdit(item),              color: 'var(--text)' },
                  { label: item.active ? 'Tạm ẩn' : 'Hiện', onClick: () => handleToggleActive(item), color: 'var(--orange-dark)' },
                  { label: deletingId === id ? 'Đóng' : 'Xóa',
                    onClick: () => setDeletingId(deletingId === id ? null : id),  color: '#EF4444' }
                ].map(({ label, onClick, color }) => (
                  <button key={label} onClick={onClick} style={{
                    flex: 1, padding: '9px 4px', border: 'none', background: 'none',
                    fontSize: 12, fontWeight: 500, color, cursor: 'pointer',
                    borderRight: '1px solid var(--border)'
                  }}>{label}</button>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
