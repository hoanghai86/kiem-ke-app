// src/screens/DanhMuc.jsx
import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { pullDanhMuc } from '../lib/sync'

const TABS = [
  { key: 'kho',     label: 'Kho' },
  { key: 'dvt',     label: 'Đơn vị tính' },
  { key: 'vat_tu',  label: 'Vật tư' },
  { key: 'ton_kho', label: 'Tồn kho' },
]

const PAGE_SIZE = 50

const EMPTY = { kho:     { ma_kho: '', ten_kho: '', active: true },
                dvt:     { ma_dvt: '', ten_dvt: '', active: true },
                vat_tu:  { ma_vt: '', ten_vt: '', ma_dvt_chinh: '', active: true },
                ton_kho: { ma_vt: '', ten_vt: '', ma_kho: '', ma_dvt: '', so_luong_so_sach: '' } }

export default function DanhMuc({ inline = false }) {
  const navigate = useNavigate()
  const [tab, setTab]           = useState('kho')
  const [list, setList]         = useState([])
  const [loading, setLoading]   = useState(false)
  const [search, setSearch]     = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editItem, setEditItem] = useState(null)
  const [maEditable, setMaEditable] = useState(false)
  const [form, setForm]         = useState(EMPTY.kho)
  const [saving, setSaving]     = useState(false)
  const [err, setErr]           = useState('')
  const [deletingId, setDeletingId] = useState(null)
  const [dvtOptions, setDvtOptions] = useState([])
  const [importing, setImporting]     = useState(false)
  const [selectedId, setSelectedId]   = useState(null)
  const [confirmDeleteAll, setConfirmDeleteAll]           = useState(false)
  const [confirmDeleteFiltered, setConfirmDeleteFiltered] = useState(false)
  const [checkedIds, setCheckedIds]                       = useState(new Set())
  const [confirmDeleteChecked, setConfirmDeleteChecked]   = useState(false)
  const [infoMsg, setInfoMsg]                             = useState('')
  const [page, setPage]                                   = useState(1)
  const [vatTuOptions, setVatTuOptions]                   = useState([])
  const [khoList, setKhoList]                             = useState([])
  const [openVtModal, setOpenVtModal]                     = useState(false)
  const [vtModalQ, setVtModalQ]                           = useState('')
  const [openKhoModal, setOpenKhoModal]                   = useState(false)
  const [khoModalQ, setKhoModalQ]                         = useState('')
  const importRef = useRef(null)

  const toActive = v => String(v ?? '1').trim() !== '0'

  const TAB_CFG = {
    kho: {
      table: 'dm_kho', key: 'ma_kho',
      headers: ['ma_kho', 'ten_kho', 'active'],
      getRow: r => [r.ma_kho, r.ten_kho, r.active ? '1' : '0'],
      toPayload: cols => ({ ma_kho: String(cols[0]||'').trim().toUpperCase(), ten_kho: String(cols[1]||'').trim(), active: toActive(cols[2]) }),
    },
    dvt: {
      table: 'dm_dvt', key: 'ma_dvt',
      headers: ['ma_dvt', 'ten_dvt', 'active'],
      getRow: r => [r.ma_dvt, r.ten_dvt, r.active ? '1' : '0'],
      toPayload: cols => ({ ma_dvt: String(cols[0]||'').trim().toUpperCase(), ten_dvt: String(cols[1]||'').trim(), active: toActive(cols[2]) }),
    },
    vat_tu: {
      table: 'dm_vat_tu', key: 'ma_vt',
      headers: ['ma_vt', 'ten_vt', 'ma_dvt_chinh', 'active'],
      getRow: r => [r.ma_vt, r.ten_vt, r.ma_dvt_chinh || '', r.active ? '1' : '0'],
      toPayload: cols => ({ ma_vt: String(cols[0]||'').trim().toUpperCase(), ten_vt: String(cols[1]||'').trim(), ma_dvt_chinh: String(cols[2]||'').trim() || null, active: toActive(cols[3]) }),
    },
    ton_kho: {
      table: 'ton_kho', key: 'ma_vt,ma_kho',
      headers: ['ma_vt', 'ten_vt', 'ma_kho', 'ma_dvt', 'so_luong_so_sach'],
      getRow: r => [r.ma_vt, r.ten_vt || '', r.ma_kho, r.ma_dvt || '', r.so_luong_so_sach ?? 0],
      toPayload: cols => ({
        ma_vt: String(cols[0]||'').trim().toUpperCase(),
        ten_vt: String(cols[1]||'').trim(),
        ma_kho: String(cols[2]||'').trim().toUpperCase(),
        ma_dvt: String(cols[3]||'').trim() || null,
        so_luong_so_sach: parseFloat(String(cols[4]||'0').replace(',', '.')) || 0,
      }),
    },
  }

  useEffect(() => { loadList(); setSearch(''); closeForm(); setSelectedId(null); setDeletingId(null); setConfirmDeleteAll(false); setCheckedIds(new Set()); setConfirmDeleteChecked(false); setInfoMsg(''); setPage(1); setConfirmDeleteFiltered(false) }, [tab])
  useEffect(() => { if (tab === 'vat_tu' || tab === 'ton_kho') loadDvtOptions() }, [tab])
  useEffect(() => { if (tab === 'ton_kho') { loadVatTuOptions(); loadKhoList() } }, [tab])

  async function loadList() {
    setLoading(true)
    const tableMap = { kho: 'dm_kho', dvt: 'dm_dvt', vat_tu: 'dm_vat_tu', ton_kho: 'ton_kho' }
    const orderMap = { kho: 'ma_kho', dvt: 'ma_dvt', vat_tu: 'ma_vt', ton_kho: 'ma_kho' }
    let q = supabase.from(tableMap[tab]).select('*').order(orderMap[tab])
    if (tab === 'ton_kho') q = q.order('ma_vt')
    const { data } = await q
    setList(data || [])
    setLoading(false)
  }

  async function loadDvtOptions() {
    const { data } = await supabase.from('dm_dvt').select('ma_dvt, ten_dvt').eq('active', true).order('ma_dvt')
    setDvtOptions(data || [])
  }

  async function loadVatTuOptions() {
    const { data } = await supabase.from('dm_vat_tu').select('ma_vt, ten_vt, ma_dvt_chinh').order('ma_vt')
    setVatTuOptions(data || [])
  }

  async function loadKhoList() {
    const { data } = await supabase.from('dm_kho').select('ma_kho, ten_kho').order('ma_kho')
    setKhoList(data || [])
  }

  function openCreate() {
    setEditItem(null)
    setForm(EMPTY[tab])
    setErr('')
    setShowForm(true)
  }

  async function openEdit(item) {
    setEditItem(item)
    if (tab === 'kho')     setForm({ ma_kho: item.ma_kho, ten_kho: item.ten_kho, active: item.active })
    if (tab === 'dvt')     setForm({ ma_dvt: item.ma_dvt, ten_dvt: item.ten_dvt, active: item.active })
    if (tab === 'vat_tu')  setForm({ ma_vt: item.ma_vt, ten_vt: item.ten_vt, ma_dvt_chinh: item.ma_dvt_chinh || '', active: item.active })
    if (tab === 'ton_kho') setForm({ ma_vt: item.ma_vt, ten_vt: item.ten_vt || '', ma_kho: item.ma_kho, ma_dvt: item.ma_dvt || '', so_luong_so_sach: item.so_luong_so_sach ?? '' })
    setErr('')
    setMaEditable(false)
    setShowForm(true)
    const inUse = await checkInUse(tab, [item])
    setMaEditable(inUse.size === 0)
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
        ? { ...(maEditable && { ma_kho: form.ma_kho.trim().toUpperCase() }), ten_kho: form.ten_kho.trim(), active: form.active }
        : { ma_kho: form.ma_kho.trim().toUpperCase(), ten_kho: form.ten_kho.trim(), active: form.active }
    } else if (tab === 'dvt') {
      if (!form.ma_dvt.trim() || !form.ten_dvt.trim()) { setErr('Mã DVT và tên DVT là bắt buộc'); return }
      table = 'dm_dvt'
      payload = editItem
        ? { ...(maEditable && { ma_dvt: form.ma_dvt.trim().toUpperCase() }), ten_dvt: form.ten_dvt.trim(), active: form.active }
        : { ma_dvt: form.ma_dvt.trim().toUpperCase(), ten_dvt: form.ten_dvt.trim(), active: form.active }
    } else if (tab === 'ton_kho') {
      const maVtNew  = form.ma_vt.trim().toUpperCase()
      const maKhoNew = form.ma_kho.trim().toUpperCase()
      if (!maVtNew)  { setErr('Mã vật tư là bắt buộc'); return }
      if (!maKhoNew) { setErr('Mã kho là bắt buộc'); return }
      const vtFound = vatTuOptions.find(v => v.ma_vt === maVtNew)
      if (!vtFound) { setErr(`Mã vật tư "${maVtNew}" không tồn tại trong danh mục`); return }
      {
        const dupQ = supabase.from('ton_kho').select('id').eq('ma_vt', maVtNew).eq('ma_kho', maKhoNew)
        const { data: dup } = await (editItem ? dupQ.neq('id', editItem.id) : dupQ).maybeSingle()
        if (dup) {
          setErr(`${maVtNew} đã có tồn kho tại kho ${maKhoNew} — không thể trùng`)
          return
        }
      }
      table = 'ton_kho'
      payload = {
        ma_vt: maVtNew,
        ten_vt: vtFound.ten_vt,
        ma_kho: maKhoNew,
        ma_dvt: form.ma_dvt || null,
        so_luong_so_sach: parseFloat(String(form.so_luong_so_sach).replace(',', '.')) || 0,
      }
    } else {
      if (!form.ma_vt.trim() || !form.ten_vt.trim()) { setErr('Mã vật tư và tên là bắt buộc'); return }
      table = 'dm_vat_tu'
      payload = editItem
        ? { ...(maEditable && { ma_vt: form.ma_vt.trim().toUpperCase() }), ten_vt: form.ten_vt.trim(), ma_dvt_chinh: form.ma_dvt_chinh || null, active: form.active }
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

  async function checkInUse(currentTab, items) {
    if (!items.length) return new Set()
    if (currentTab === 'ton_kho') return new Set()
    if (currentTab === 'vat_tu') {
      const keys = items.map(r => r.ma_vt)
      const [r1, r2] = await Promise.all([
        supabase.from('kiem_ke_chitiet').select('ma_vt').in('ma_vt', keys),
        supabase.from('ton_kho').select('ma_vt').in('ma_vt', keys),
      ])
      const used = new Set([...(r1.data||[]).map(r=>r.ma_vt), ...(r2.data||[]).map(r=>r.ma_vt)])
      return new Set(items.filter(r => used.has(r.ma_vt)).map(r => r.id))
    }
    if (currentTab === 'dvt') {
      const keys = items.map(r => r.ma_dvt)
      const [r1, r2] = await Promise.all([
        supabase.from('dm_vat_tu').select('ma_dvt_chinh').in('ma_dvt_chinh', keys),
        supabase.from('ton_kho').select('ma_dvt').in('ma_dvt', keys),
      ])
      const used = new Set([
        ...(r1.data||[]).map(r=>r.ma_dvt_chinh).filter(Boolean),
        ...(r2.data||[]).map(r=>r.ma_dvt).filter(Boolean),
      ])
      return new Set(items.filter(r => used.has(r.ma_dvt)).map(r => r.id))
    }
    if (currentTab === 'kho') {
      const keys = items.map(r => r.ma_kho)
      const [r1, r2] = await Promise.all([
        supabase.from('kiem_ke_chitiet').select('ma_kho').in('ma_kho', keys),
        supabase.from('ton_kho').select('ma_kho').in('ma_kho', keys),
      ])
      const used = new Set([
        ...(r1.data||[]).map(r=>r.ma_kho).filter(Boolean),
        ...(r2.data||[]).map(r=>r.ma_kho).filter(Boolean),
      ])
      return new Set(items.filter(r => used.has(r.ma_kho)).map(r => r.id))
    }
    return new Set()
  }

  async function bulkDelete(items) {
    const tableMap = { kho: 'dm_kho', dvt: 'dm_dvt', vat_tu: 'dm_vat_tu', ton_kho: 'ton_kho' }
    const inUseIds = await checkInUse(tab, items)
    const safe = items.filter(r => !inUseIds.has(r.id))
    if (safe.length > 0) {
      if (tab === 'kho') {
        const keys = safe.map(r => r.ma_kho)
        await supabase.from('phien_kiem_ke').delete().in('ma_kho', keys)
      }
      const { error } = await supabase.from(tableMap[tab]).delete().in('id', safe.map(r => r.id))
      if (error) throw new Error(error.message)
      await loadList()
      await pullDanhMuc()
    }
    return { deleted: safe.length, kept: inUseIds.size }
  }

  async function handleDelete(id) {
    const tableMap = { kho: 'dm_kho', dvt: 'dm_dvt', vat_tu: 'dm_vat_tu', ton_kho: 'ton_kho' }
    const item = list.find(r => r.id === id)
    if (!item) return
    setSaving(true)
    try {
      const inUseIds = await checkInUse(tab, [item])
      if (inUseIds.has(id)) {
        const reason = tab === 'dvt'
          ? 'đang được dùng trong danh mục vật tư'
          : 'vẫn còn dữ liệu kiểm kê hoặc tồn kho'
        setErr(`Không thể xóa: mục này ${reason}. Dùng "Tạm ẩn" thay thế.`)
        setDeletingId(null)
        return
      }
      if (tab === 'kho') {
        await supabase.from('phien_kiem_ke').delete().eq('ma_kho', item.ma_kho)
      }
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
    const tableMap = { kho: 'dm_kho', dvt: 'dm_dvt', vat_tu: 'dm_vat_tu', ton_kho: 'ton_kho' }
    await supabase.from(tableMap[tab]).update({ active: !item.active }).eq('id', item.id)
    setList(prev => prev.map(r => r.id === item.id ? { ...r, active: !item.active } : r))
  }

  function handleExport() {
    const cfg = TAB_CFG[tab]
    const rows = list.map(r => cfg.getRow(r).map(v => {
      const s = String(v ?? '')
      return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g,'""')}"` : s
    }).join(','))
    const csv = '﻿' + [cfg.headers.join(','), ...rows].join('\n')
    const d = new Date()
    const dateStr = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `DanhMuc_${tab}_${dateStr}.csv`
    document.body.appendChild(a); a.click()
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(a.href) }, 1000)
  }

  async function handleDeleteFiltered(ids) {
    setSaving(true)
    try {
      const items = list.filter(r => ids.includes(r.id))
      const { deleted, kept } = await bulkDelete(items)
      setConfirmDeleteFiltered(false)
      if (kept === 0) setSearch('')
      if (kept > 0) setInfoMsg(`Đã xóa ${deleted} mục. Giữ lại ${kept} mục ${tab === 'dvt' ? 'đang được dùng trong danh mục vật tư' : 'vẫn còn dữ liệu kiểm kê hoặc tồn kho'}.`)
    } catch (e) {
      setErr(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDeleteChecked() {
    setSaving(true)
    try {
      const items = list.filter(r => checkedIds.has(r.id))
      const { deleted, kept } = await bulkDelete(items)
      setCheckedIds(new Set())
      setConfirmDeleteChecked(false)
      if (kept > 0) setInfoMsg(`Đã xóa ${deleted} mục. Giữ lại ${kept} mục ${tab === 'dvt' ? 'đang được dùng trong danh mục vật tư' : 'vẫn còn dữ liệu kiểm kê hoặc tồn kho'}.`)
    } catch (e) {
      setErr(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDeleteAll() {
    setSaving(true)
    try {
      const { deleted, kept } = await bulkDelete(list)
      setConfirmDeleteAll(false)
      if (kept > 0) setInfoMsg(`Đã xóa ${deleted} mục. Giữ lại ${kept} mục ${tab === 'dvt' ? 'đang được dùng trong danh mục vật tư' : 'vẫn còn dữ liệu kiểm kê hoặc tồn kho'}.`)
    } catch (e) {
      setErr(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleImport(e) {
    const file = e.target.files?.[0]; if (!file) return
    e.target.value = ''
    const cfg = TAB_CFG[tab]
    setImporting(true); setErr('')
    try {
      const text = (await file.text()).replace(/^﻿/, '')
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
      if (lines.length < 2) { setErr('File không có dữ liệu'); return }
      const parseCSV = line => {
        const res = []; let cur = ''; let inQ = false
        for (let i = 0; i < line.length; i++) {
          if (line[i] === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++ } else inQ = !inQ }
          else if (line[i] === ',' && !inQ) { res.push(cur); cur = '' }
          else cur += line[i]
        }
        res.push(cur); return res
      }
      const stripTrailing = cols => {
        let end = cols.length
        while (end > 0 && cols[end - 1].trim() === '') end--
        return cols.slice(0, end)
      }

      // Với vật tư: fetch DVT hợp lệ trước để dùng khi align cột
      let validDvtSet = null
      if (tab === 'vat_tu') {
        const { data: dvtRows } = await supabase.from('dm_dvt').select('ma_dvt')
        validDvtSet = new Set((dvtRows || []).map(d => d.ma_dvt))
      }

      const headerCols = parseCSV(lines[0]).length
      // Căn lại cột khi tên có dấu phẩy:
      // - Vật tư: quét từ phải sang trái, tìm cột có giá trị DVT hợp lệ → mọi thứ trước là tên
      // - Tab khác: dựa vào số cột header để rejoin
      const alignCols = cols => {
        if (validDvtSet) {
          for (let pos = cols.length - 1; pos >= 2; pos--) {
            if (validDvtSet.has(cols[pos].trim())) {
              return [cols[0], cols.slice(1, pos).join(','), ...cols.slice(pos)]
            }
          }
          return [cols[0], cols.slice(1).join(',')]
        }
        if (cols.length <= headerCols) return cols
        const trailing = headerCols - 2
        if (trailing < 1) return cols
        return [cols[0], cols.slice(1, cols.length - trailing).join(','), ...cols.slice(cols.length - trailing)]
      }

      const payloads = lines.slice(1).map(parseCSV).map(stripTrailing).map(alignCols).filter(c => c[0]?.trim()).map(c => cfg.toPayload(c))
      if (!payloads.length) { setErr('Không có dòng hợp lệ'); return }
      const keyFields = cfg.key.split(',')
      const seen = new Map(); const dups = []
      for (let i = 0; i < payloads.length; i++) {
        const k = keyFields.map(f => payloads[i][f]).join(' + ')
        const label = `"${k}" — tên: "${payloads[i].ten_vt || payloads[i].ten_kho || payloads[i].ten_dvt || ''}" (dòng ${seen.get(k) + 2} và ${i + 2})`
        if (seen.has(k)) { dups.push(label) }
        else { seen.set(k, i) }
      }
      if (dups.length) { setErr(`File có mã trùng:\n${dups.join('\n')}`); return }

      // Với vật tư: block nếu vẫn còn DVT không tồn tại sau khi align
      if (validDvtSet) {
        const invalidDvt = new Set(payloads.map(p => p.ma_dvt_chinh).filter(v => v && !validDvtSet.has(v)))
        if (invalidDvt.size) {
          setErr(`Không thể import — các đơn vị tính sau chưa có trong danh mục ĐVT, hãy import ĐVT trước:\n${[...invalidDvt].join(', ')}`)
          return
        }
      }

      const { error } = await supabase.from(cfg.table).upsert(payloads, { onConflict: cfg.key })
      if (error) throw new Error(error.message)
      await loadList(); await pullDanhMuc()
    } catch (e) { setErr('Import lỗi: ' + e.message) }
    finally { setImporting(false) }
  }

  // Lọc danh sách theo search — hỗ trợ nhiều từ khóa cách nhau bằng dấu phẩy
  const terms = search.split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
  const filtered = list.filter(r => {
    if (!terms.length) return true
    const text = tab === 'kho'     ? `${r.ma_kho} ${r.ten_kho}`
               : tab === 'dvt'     ? `${r.ma_dvt} ${r.ten_dvt}`
               : tab === 'ton_kho' ? `${r.ma_vt} ${r.ten_vt} ${r.ma_kho}`
               : `${r.ma_vt} ${r.ten_vt}`
    const lower = text.toLowerCase()
    return terms.some(t => lower.includes(t))
  })

  const totalPages    = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const pagedFiltered = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  // ── Form sub-screen ──────────────────────────────────────────────
  if (showForm) {
    const titleMap = { kho: 'kho', dvt: 'đơn vị tính', vat_tu: 'vật tư', ton_kho: 'tồn kho' }
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
                placeholder="VD: KHO01" disabled={editItem && !maEditable} />
              {editItem && !maEditable && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Mã kho đang được dùng — không thể đổi</div>}
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
                placeholder="VD: KG, CAI, HOP" disabled={editItem && !maEditable} />
              {editItem && !maEditable && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Mã DVT đang được dùng — không thể đổi</div>}
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
                placeholder="VD: VT001" disabled={editItem && !maEditable} />
              {editItem && !maEditable && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Mã vật tư đang được dùng — không thể đổi</div>}
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

          {tab === 'ton_kho' && <>
            <div className="field-group">
              <label className="field-label">Vật tư *</label>
              <div className="input-select" onClick={() => { setVtModalQ(''); setOpenVtModal(true) }}
                style={{ cursor: 'pointer', color: form.ma_vt ? 'var(--text)' : 'var(--text-muted)' }}>
                {form.ma_vt ? `${form.ma_vt} – ${form.ten_vt}` : '-- Chọn vật tư --'}
              </div>
            </div>
            <div className="field-group">
              <label className="field-label">Kho *</label>
              <div className="input-select" onClick={() => { setKhoModalQ(''); setOpenKhoModal(true) }}
                style={{ cursor: 'pointer', color: form.ma_kho ? 'var(--text)' : 'var(--text-muted)' }}>
                {form.ma_kho
                  ? `${form.ma_kho} – ${khoList.find(k => k.ma_kho === form.ma_kho)?.ten_kho || ''}`
                  : '-- Chọn kho --'}
              </div>
            </div>
            <div className="row-2col">
              <div className="field-group">
                <label className="field-label">Đơn vị tính</label>
                <select className="input-select" value={form.ma_dvt}
                  onChange={e => setF('ma_dvt', e.target.value)}>
                  <option value="">-- Chọn --</option>
                  {dvtOptions.map(d => (
                    <option key={d.ma_dvt} value={d.ma_dvt}>{d.ma_dvt}</option>
                  ))}
                </select>
              </div>
              <div className="field-group">
                <label className="field-label">SL sổ sách</label>
                <input type="number" className="input-field" value={form.so_luong_so_sach}
                  onChange={e => setF('so_luong_so_sach', e.target.value)}
                  min="0" step="any" placeholder="0" />
              </div>
            </div>
          </>}

          {tab !== 'ton_kho' && (
            <div className="field-group">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={form.active}
                  onChange={e => setF('active', e.target.checked)} />
                <span className="field-label" style={{ margin: 0 }}>Đang hoạt động</span>
              </label>
            </div>
          )}

          <div className="row-2col" style={{ marginTop: 8 }}>
            <button className="btn-secondary" onClick={closeForm} disabled={saving}>Hủy</button>
            <button className="btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Đang lưu...' : editItem ? 'Lưu thay đổi' : 'Tạo mới'}
            </button>
          </div>
        </div>

        {/* Modal chọn vật tư */}
        {openVtModal && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: '#fff', display: 'flex', flexDirection: 'column', maxWidth: 480, margin: '0 auto' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 15 }}>Vật tư</span>
                <div style={{ display: 'flex', gap: 16 }}>
                  <button onClick={() => setVtModalQ('')}
                    style={{ border: 'none', background: 'none', color: 'var(--text-muted)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Xóa</button>
                  <button onClick={() => setOpenVtModal(false)}
                    style={{ border: 'none', background: 'none', color: 'var(--green)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Hủy</button>
                </div>
              </div>
              <input type="text" className="input-field" placeholder="Tìm mã hoặc tên vật tư..."
                value={vtModalQ} onChange={e => setVtModalQ(e.target.value)}
                autoFocus style={{ margin: 0 }} />
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {vatTuOptions
                .filter(v => !vtModalQ.trim() ||
                  v.ma_vt.toLowerCase().includes(vtModalQ.toLowerCase()) ||
                  (v.ten_vt || '').toLowerCase().includes(vtModalQ.toLowerCase()))
                .map(v => (
                  <div key={v.ma_vt}
                    onClick={() => {
                      setForm(f => ({ ...f, ma_vt: v.ma_vt, ten_vt: v.ten_vt, ma_dvt: v.ma_dvt_chinh || f.ma_dvt }))
                      setOpenVtModal(false)
                    }}
                    style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid #F3F4F6', cursor: 'pointer', background: form.ma_vt === v.ma_vt ? '#F0FDF4' : '#fff' }}>
                    <span style={{ background: '#E6F4EF', color: 'var(--green)', borderRadius: 6, padding: '2px 7px', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>{v.ma_vt}</span>
                    <span style={{ fontSize: 14 }}>{v.ten_vt}</span>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Modal chọn kho */}
        {openKhoModal && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: '#fff', display: 'flex', flexDirection: 'column', maxWidth: 480, margin: '0 auto' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 15 }}>Kho</span>
                <div style={{ display: 'flex', gap: 16 }}>
                  <button onClick={() => setKhoModalQ('')}
                    style={{ border: 'none', background: 'none', color: 'var(--text-muted)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Xóa</button>
                  <button onClick={() => setOpenKhoModal(false)}
                    style={{ border: 'none', background: 'none', color: 'var(--green)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Hủy</button>
                </div>
              </div>
              <input type="text" className="input-field" placeholder="Tìm kho..."
                value={khoModalQ} onChange={e => setKhoModalQ(e.target.value)}
                autoFocus style={{ margin: 0 }} />
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {khoList
                .filter(k => !khoModalQ.trim() ||
                  k.ma_kho.toLowerCase().includes(khoModalQ.toLowerCase()) ||
                  k.ten_kho.toLowerCase().includes(khoModalQ.toLowerCase()))
                .map(k => {
                  const selected = form.ma_kho === k.ma_kho
                  return (
                    <div key={k.ma_kho}
                      onClick={() => { setF('ma_kho', k.ma_kho); setOpenKhoModal(false) }}
                      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid #F3F4F6', cursor: 'pointer', background: selected ? '#F0FDF4' : '#fff' }}>
                      <div style={{ width: 20, height: 20, borderRadius: '50%', border: `2px solid ${selected ? 'var(--green)' : '#D1D5DB'}`, background: selected ? 'var(--green)' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        {selected && <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#fff' }} />}
                      </div>
                      <div>
                        <div style={{ fontWeight: 500, fontSize: 14 }}>{k.ten_kho}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{k.ma_kho}</div>
                      </div>
                    </div>
                  )
                })}
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── Main screen ──────────────────────────────────────────────────
  const countLabel = { kho: 'kho', dvt: 'đơn vị tính', vat_tu: 'vật tư', ton_kho: 'tồn kho' }

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
        {infoMsg && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            <div style={{ background: '#fff', borderRadius: 14, padding: 24, maxWidth: 320, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}>
              <div style={{ fontSize: 36, textAlign: 'center', marginBottom: 10 }}>✅</div>
              <div style={{ fontSize: 15, fontWeight: 700, textAlign: 'center', marginBottom: 8, color: 'var(--text)' }}>Kết quả xóa</div>
              <div style={{ fontSize: 14, color: 'var(--text)', textAlign: 'center', lineHeight: 1.6, marginBottom: 20 }}>{infoMsg}</div>
              <button onClick={() => setInfoMsg('')} style={{ width: '100%', padding: '11px', borderRadius: 8, border: 'none', background: 'var(--green)', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>OK</button>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          <button className="btn-primary" onClick={openCreate} style={{ flex: 1, fontSize: 13 }}>
            + Thêm
          </button>
          <button className="btn-secondary" onClick={handleExport} disabled={!list.length} style={{ flex: 1, fontSize: 13 }}>
            ⬇ Export
          </button>
          <button className="btn-secondary" onClick={() => importRef.current?.click()} disabled={importing} style={{ flex: 1, fontSize: 13 }}>
            {importing ? '...' : '⬆ Import'}
          </button>
          <button onClick={() => setConfirmDeleteAll(v => !v)} disabled={!list.length}
            style={{ flex: 1, fontSize: 13, borderRadius: 8, border: '1px solid #FECACA', background: confirmDeleteAll ? '#EF4444' : '#FEF2F2', color: confirmDeleteAll ? '#fff' : '#DC2626', cursor: 'pointer' }}>
            🗑 Xóa danh mục
          </button>
        </div>
        <input ref={importRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={handleImport} />

        {confirmDeleteAll && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', marginBottom: 10, borderRadius: 8, background: '#FEF2F2', border: '1px solid #FECACA' }}>
            <span style={{ flex: 1, fontSize: 13, color: '#991B1B', fontWeight: 500 }}>Xóa toàn bộ {list.length} {countLabel[tab]}?</span>
            <button onClick={handleDeleteAll} disabled={saving}
              style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#EF4444', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              {saving ? '...' : 'Xóa hết'}
            </button>
            <button onClick={() => setConfirmDeleteAll(false)}
              style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border)', background: '#fff', fontSize: 13, cursor: 'pointer' }}>
              Hủy
            </button>
          </div>
        )}

        <input className="input-field" placeholder="Tìm kiếm... (nhiều mã cách nhau bằng dấu phẩy)" value={search}
          onChange={e => { setSearch(e.target.value); setConfirmDeleteFiltered(false); setPage(1) }} style={{ marginBottom: terms.length && filtered.length ? 6 : 12 }} />

        {terms.length > 0 && filtered.length > 0 && (
          confirmDeleteFiltered ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', marginBottom: 10, borderRadius: 8, background: '#FEF2F2', border: '1px solid #FECACA' }}>
              <span style={{ flex: 1, fontSize: 13, color: '#991B1B', fontWeight: 500 }}>Xóa {filtered.length} mục đang lọc?</span>
              <button onClick={() => handleDeleteFiltered(filtered.map(r => r.id))} disabled={saving}
                style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#EF4444', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                {saving ? '...' : 'Xóa'}
              </button>
              <button onClick={() => setConfirmDeleteFiltered(false)}
                style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border)', background: '#fff', fontSize: 13, cursor: 'pointer' }}>
                Hủy
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{filtered.length} kết quả</span>
              <button onClick={() => setConfirmDeleteFiltered(true)}
                style={{ border: 'none', background: 'none', color: '#DC2626', fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: 0 }}>
                Xóa {filtered.length} mục này
              </button>
            </div>
          )
        )}

        {checkedIds.size > 0 && (
          confirmDeleteChecked ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', marginBottom: 10, borderRadius: 8, background: '#FEF2F2', border: '1px solid #FECACA' }}>
              <span style={{ flex: 1, fontSize: 13, color: '#991B1B', fontWeight: 500 }}>Xóa {checkedIds.size} mục đã chọn?</span>
              <button onClick={handleDeleteChecked} disabled={saving}
                style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#EF4444', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                {saving ? '...' : 'Xóa'}
              </button>
              <button onClick={() => setConfirmDeleteChecked(false)}
                style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border)', background: '#fff', fontSize: 13, cursor: 'pointer' }}>
                Hủy
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', marginBottom: 10, borderRadius: 8, background: '#F0FDF4', border: '1px solid #D1FAE5' }}>
              <span style={{ flex: 1, fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>Đã chọn {checkedIds.size} mục</span>
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

        {loading ? (
          <div className="empty-state">Đang tải...</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">Không có dữ liệu</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border)' }}>
                <th style={{ padding: '8px 6px', textAlign: 'center', width: 36 }}>
                  <input type="checkbox"
                    checked={filtered.length > 0 && filtered.every(r => checkedIds.has(r.id))}
                    onChange={e => {
                      if (e.target.checked) setCheckedIds(new Set(filtered.map(r => r.id)))
                      else setCheckedIds(new Set())
                    }} />
                </th>
                <th style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', fontSize: 11, whiteSpace: 'nowrap' }}>Mã</th>
                <th style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', fontSize: 11 }}>Tên</th>
                {tab === 'vat_tu' && <th style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', fontSize: 11 }}>ĐVT</th>}
                {tab === 'ton_kho' && <th style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', fontSize: 11, whiteSpace: 'nowrap' }}>Mã kho</th>}
                {tab === 'ton_kho' && <th style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600, color: 'var(--text-muted)', fontSize: 11, whiteSpace: 'nowrap' }}>SL sổ sách</th>}
                {tab !== 'ton_kho' && <th style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 600, color: 'var(--text-muted)', fontSize: 11 }}>TT</th>}
              </tr>
            </thead>
            <tbody>
              {pagedFiltered.map(item => {
                const id      = item.id
                const ma      = tab === 'kho' ? item.ma_kho : tab === 'dvt' ? item.ma_dvt : item.ma_vt
                const name    = tab === 'kho' ? item.ten_kho : tab === 'dvt' ? item.ten_dvt : item.ten_vt
                const colSpan = tab === 'vat_tu' || tab === 'ton_kho' ? 5 : 4
                const isSel   = selectedId === id
                const isChk   = checkedIds.has(id)
                return (
                  <>
                    <tr key={id} onClick={() => { setSelectedId(isSel ? null : id); setDeletingId(null) }}
                      style={{ cursor: 'pointer', opacity: tab === 'ton_kho' || item.active ? 1 : 0.55, background: isSel ? '#F0FDF4' : isChk ? '#FAFFF5' : 'white', borderBottom: '1px solid #F3F4F6' }}>
                      <td style={{ padding: '10px 6px', textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                        <input type="checkbox" checked={isChk}
                          onChange={e => {
                            setCheckedIds(prev => {
                              const next = new Set(prev)
                              e.target.checked ? next.add(id) : next.delete(id)
                              return next
                            })
                          }} />
                      </td>
                      <td style={{ padding: '10px 10px', fontWeight: 700, color: '#1d9e75', whiteSpace: 'nowrap' }}>{ma}</td>
                      <td style={{ padding: '10px 10px' }}>{name}</td>
                      {tab === 'vat_tu' && <td style={{ padding: '10px 10px', color: 'var(--text-muted)' }}>{item.ma_dvt_chinh || '—'}</td>}
                      {tab === 'ton_kho' && <td style={{ padding: '10px 10px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{item.ma_kho}</td>}
                      {tab === 'ton_kho' && <td style={{ padding: '10px 10px', textAlign: 'right', fontWeight: 600 }}>{item.so_luong_so_sach ?? 0}</td>}
                      {tab !== 'ton_kho' && (
                        <td style={{ padding: '10px 10px', textAlign: 'center' }}>
                          <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 6px', borderRadius: 4, whiteSpace: 'nowrap',
                            background: item.active ? '#D1FAE5' : '#F3F4F6', color: item.active ? '#065F46' : '#6B7280' }}>
                            {item.active ? 'HĐ' : 'Ẩn'}
                          </span>
                        </td>
                      )}
                    </tr>
                    {isSel && (
                      <tr key={`${id}_sel`} style={{ background: '#F0FDF4' }}>
                        <td colSpan={colSpan} style={{ padding: '8px 10px', borderBottom: '1px solid #D1FAE5' }}>
                          {deletingId === id ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span style={{ flex: 1, fontSize: 13, color: '#991B1B' }}>Xác nhận xóa?</span>
                              <button onClick={e => { e.stopPropagation(); handleDelete(id) }} disabled={saving}
                                style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#EF4444', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                                {saving ? '...' : 'Xóa'}
                              </button>
                              <button onClick={e => { e.stopPropagation(); setDeletingId(null) }}
                                style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border)', background: '#fff', fontSize: 13, cursor: 'pointer' }}>
                                Hủy
                              </button>
                            </div>
                          ) : (
                            <div style={{ display: 'flex', gap: 16, justifyContent: 'flex-end' }}>
                              <button onClick={e => { e.stopPropagation(); openEdit(item) }}
                                style={{ border: 'none', background: 'none', fontSize: 13, fontWeight: 600, color: 'var(--text)', cursor: 'pointer', padding: '4px 0' }}>
                                Sửa
                              </button>
                              {tab !== 'ton_kho' && (
                                <button onClick={e => { e.stopPropagation(); handleToggleActive(item) }}
                                  style={{ border: 'none', background: 'none', fontSize: 13, fontWeight: 600, color: '#D97706', cursor: 'pointer', padding: '4px 0' }}>
                                  {item.active ? 'Tạm ẩn' : 'Hiện'}
                                </button>
                              )}
                              <button onClick={e => { e.stopPropagation(); setDeletingId(id) }}
                                style={{ border: 'none', background: 'none', fontSize: 13, fontWeight: 600, color: '#EF4444', cursor: 'pointer', padding: '4px 0' }}>
                                Xóa
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                )
              })}
            </tbody>
          </table>
        )}
        {filtered.length > PAGE_SIZE && (() => {
          const btn = (disabled) => ({
            border: '1px solid var(--border)', borderRadius: 6,
            padding: '5px 11px', fontSize: 14, background: '#fff',
            color: disabled ? '#CBD5E1' : 'var(--text)',
            cursor: disabled ? 'default' : 'pointer',
          })
          return (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '12px 0 80px' }}>
              <button onClick={() => setPage(1)} disabled={page === 1} style={btn(page === 1)}>«</button>
              <button onClick={() => setPage(p => p - 1)} disabled={page === 1} style={btn(page === 1)}>‹</button>
              <span style={{ fontSize: 13, fontWeight: 500, minWidth: 90, textAlign: 'center' }}>Trang {page} / {totalPages}</span>
              <button onClick={() => setPage(p => p + 1)} disabled={page === totalPages} style={btn(page === totalPages)}>›</button>
              <button onClick={() => setPage(totalPages)} disabled={page === totalPages} style={btn(page === totalPages)}>»</button>
            </div>
          )
        })()}
      </div>
    </div>
  )
}
