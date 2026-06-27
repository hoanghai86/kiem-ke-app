// src/screens/Admin.jsx
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import DanhMuc from './DanhMuc'

const ROLE_LABEL = { ke_toan: 'Kế toán', thu_kho: 'Thủ kho', admin: 'Admin' }
const ROLE_COLOR = {
  ke_toan: { bg: '#DBEAFE', color: '#1E40AF' },
  thu_kho: { bg: '#D1FAE5', color: '#065F46' },
  admin:   { bg: '#EDE9FE', color: '#5B21B6' }
}

export default function Admin() {
  const navigate = useNavigate()
  const [tab, setTab] = useState('users')

  // User management state
  const [danhSachUser, setDanhSachUser] = useState([])
  const [loadingUser, setLoadingUser] = useState(false)
  const [showUserForm, setShowUserForm] = useState(false)
  const [editUser, setEditUser] = useState(null)
  const [userForm, setUserForm] = useState({ ma_user: '', ho_ten: '', role: 'ke_toan', email: '', password: '' })
  const [savingUser, setSavingUser] = useState(false)
  const [deletingId, setDeletingId] = useState(null)
  const [userErr, setUserErr] = useState('')
  const [userSearch, setUserSearch] = useState('')
  const [filterRole, setFilterRole] = useState('all')
  const [filterActive, setFilterActive] = useState('all')

  useEffect(() => { if (tab === 'users') loadUsers() }, [tab])

  // ── USER MANAGEMENT ──────────────────────────────────────────────
  async function loadUsers() {
    setLoadingUser(true)
    const { data } = await supabase.from('dm_user').select('*').order('created_at')
    setDanhSachUser(data || [])
    setLoadingUser(false)
  }

  function openCreate() {
    setEditUser(null)
    setUserForm({ ma_user: '', ho_ten: '', role: 'ke_toan', email: '', password: '' })
    setUserErr('')
    setShowUserForm(true)
  }

  function openEdit(user) {
    setEditUser(user)
    setUserForm({ ma_user: user.ma_user, ho_ten: user.ho_ten, role: user.role, email: user.email || '', password: '' })
    setUserErr('')
    setShowUserForm(true)
  }

  function closeForm() {
    setShowUserForm(false)
    setEditUser(null)
    setUserErr('')
  }

  async function callGas(payload) {
    const gasUrl = process.env.REACT_APP_GAS_URL
    if (!gasUrl) throw new Error('Chưa cấu hình REACT_APP_GAS_URL trong .env')
    const res = await fetch(gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    })
    const data = await res.json()
    if (data.status !== 'ok') throw new Error(data.message || data.error || 'Lỗi không xác định từ GAS')
    return data
  }

  async function handleSaveUser() {
    const { ma_user, ho_ten, role, email, password } = userForm
    if (!ma_user.trim() || !ho_ten.trim()) { setUserErr('Vui lòng điền mã user và họ tên'); return }
    if (!editUser && (!email.trim() || !password.trim())) { setUserErr('Email và mật khẩu là bắt buộc khi tạo mới'); return }
    if (!editUser && password.length < 6) { setUserErr('Mật khẩu tối thiểu 6 ký tự'); return }
    if (editUser && password.trim() && password.length < 6) { setUserErr('Mật khẩu tối thiểu 6 ký tự'); return }

    setSavingUser(true)
    setUserErr('')
    try {
      if (editUser) {
        const { error } = await supabase.from('dm_user')
          .update({ ma_user: ma_user.trim(), ho_ten: ho_ten.trim(), role, email: email.trim() })
          .eq('id', editUser.id)
        if (error) throw new Error(error.message)

        if (password.trim()) {
          const { data: { user: me } } = await supabase.auth.getUser()
          const isSelf = me?.email?.toLowerCase() === email.trim().toLowerCase()
          if (isSelf) {
            // Đổi mật khẩu của chính mình — dùng updateUser, không cần GAS
            const { error: pwdErr } = await supabase.auth.updateUser({ password })
            if (pwdErr) throw new Error('Đặt mật khẩu thất bại: ' + pwdErr.message)
          } else {
            // Đổi mật khẩu người khác — qua GAS
            await callGas({ action: 'reset_password', email: email.trim(), password })
          }
        }
      } else {
        // Tạo user qua GAS → GAS tạo auth user + insert dm_user với id khớp
        await callGas({ action: 'create_user', email: email.trim(), password, ma_user: ma_user.trim(), ho_ten: ho_ten.trim(), role })
      }
      await loadUsers()
      closeForm()
    } catch (e) {
      setUserErr(e.message)
    } finally {
      setSavingUser(false)
    }
  }

  async function handleToggleActive(user) {
    await supabase.from('dm_user').update({ active: !user.active }).eq('id', user.id)
    setDanhSachUser(prev => prev.map(u => u.id === user.id ? { ...u, active: !u.active } : u))
  }

  async function handleDeleteUser(id) {
    setSavingUser(true)
    try {
      await callGas({ action: 'delete_user', id })
      await loadUsers()
    } catch (e) {
      setUserErr(e.message)
    } finally {
      setSavingUser(false)
      setDeletingId(null)
    }
  }

  // ── RENDER ───────────────────────────────────────────────────────
  const TABS = [
    { key: 'users',    label: 'Người dùng' },
    { key: 'danh_muc', label: 'Danh mục' },
  ]

  // Sub-screen: form tạo/sửa user
  if (tab === 'users' && showUserForm) {
    return (
      <div className="screen">
        <div className="topbar">
          <div className="topbar-title">{editUser ? 'Sửa người dùng' : 'Thêm người dùng'}</div>
          <div className="topbar-sub">{editUser ? editUser.ho_ten : 'Tạo tài khoản mới'}</div>
        </div>
        <div className="content">
          {userErr && <div className="error-box">{userErr}</div>}

          <div className="row-2col">
            <div className="field-group">
              <label className="field-label">Mã user *</label>
              <input className="input-field" value={userForm.ma_user}
                onChange={e => setUserForm(f => ({ ...f, ma_user: e.target.value }))}
                placeholder="VD: KT01" />
            </div>
            <div className="field-group">
              <label className="field-label">Vai trò *</label>
              <select className="input-select" value={userForm.role}
                onChange={e => setUserForm(f => ({ ...f, role: e.target.value }))}>
                <option value="ke_toan">Kế toán</option>
                <option value="thu_kho">Thủ kho</option>
                <option value="admin">Admin</option>
              </select>
            </div>
          </div>

          <div className="field-group">
            <label className="field-label">Họ tên *</label>
            <input className="input-field" value={userForm.ho_ten}
              onChange={e => setUserForm(f => ({ ...f, ho_ten: e.target.value }))}
              placeholder="Nguyễn Văn A" />
          </div>

          <div className="field-group">
            <label className="field-label">Email {!editUser && '*'}</label>
            <input className="input-field" type="email" value={userForm.email}
              onChange={e => setUserForm(f => ({ ...f, email: e.target.value }))}
              placeholder="email@company.com" />
          </div>

          <div className="field-group">
            <label className="field-label">
              {editUser ? 'Mật khẩu mới (để trống nếu không đổi)' : 'Mật khẩu * (tối thiểu 6 ký tự)'}
            </label>
            <input className="input-field" type="password" value={userForm.password}
              onChange={e => setUserForm(f => ({ ...f, password: e.target.value }))}
              placeholder={editUser ? 'Để trống nếu không đổi' : '••••••'} />
          </div>

          <div className="row-2col" style={{ marginTop: 8 }}>
            <button className="btn-secondary" onClick={closeForm} disabled={savingUser}>Hủy</button>
            <button className="btn-primary" onClick={handleSaveUser} disabled={savingUser}>
              {savingUser ? 'Đang lưu...' : editUser ? 'Lưu thay đổi' : 'Tạo người dùng'}
            </button>
          </div>

        </div>
      </div>
    )
  }

  return (
    <div className="screen">
      <div className="topbar">
        <div className="topbar-title">Admin</div>
        <div className="topbar-sub">Quản trị</div>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', overflowX: 'auto' }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            flex: 1, padding: '10px 4px', border: 'none', background: 'none',
            fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap',
            color: tab === t.key ? 'var(--green)' : 'var(--text-muted)',
            borderBottom: tab === t.key ? '2px solid var(--green)' : '2px solid transparent',
            cursor: 'pointer', minWidth: 72
          }}>{t.label}</button>
        ))}
      </div>

      <div className="content">
        {/* Tab Danh mục */}
        {tab === 'danh_muc' && <DanhMuc inline />}

        {/* Tab Người dùng */}
        {tab === 'users' && (
          <>
            {userErr && <div className="error-box">{userErr}</div>}

            <button className="btn-primary" onClick={openCreate}
              style={{ width: '100%', marginBottom: 10 }}>
              + Thêm người dùng
            </button>

            {/* Bộ lọc */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
              <input
                className="input-field"
                placeholder="Tìm theo mã, họ tên, email..."
                value={userSearch}
                onChange={e => setUserSearch(e.target.value)}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <select className="input-select" style={{ flex: 1 }}
                  value={filterRole} onChange={e => setFilterRole(e.target.value)}>
                  <option value="all">Tất cả vai trò</option>
                  <option value="ke_toan">Kế toán</option>
                  <option value="thu_kho">Thủ kho</option>
                  <option value="admin">Admin</option>
                </select>
                <select className="input-select" style={{ flex: 1 }}
                  value={filterActive} onChange={e => setFilterActive(e.target.value)}>
                  <option value="all">Tất cả trạng thái</option>
                  <option value="true">Hoạt động</option>
                  <option value="false">Tạm khóa</option>
                </select>
              </div>
            </div>

            {loadingUser ? (
              <div className="empty-state">Đang tải...</div>
            ) : (() => {
              const kw = userSearch.trim().toLowerCase()
              const filtered = danhSachUser.filter(u => {
                if (filterRole !== 'all' && u.role !== filterRole) return false
                if (filterActive !== 'all' && String(u.active) !== filterActive) return false
                if (kw && !`${u.ma_user} ${u.ho_ten} ${u.email || ''}`.toLowerCase().includes(kw)) return false
                return true
              })
              if (filtered.length === 0) return <div className="empty-state">Không tìm thấy người dùng nào</div>
              return filtered.map(user => {
                const rc = ROLE_COLOR[user.role] || { bg: '#F3F4F6', color: '#374151' }
                return (
                  <div key={user.id} className="phien-card" style={{ opacity: user.active ? 1 : 0.6 }}>
                    <div className="phien-card-top">
                      <div className="phien-card-info">
                        <div className="phien-card-kho">{user.ho_ten}</div>
                        <div className="phien-card-meta">
                          {user.ma_user} · {user.email || '—'}
                        </div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                        <span style={{ background: rc.bg, color: rc.color, borderRadius: 4, padding: '2px 8px', fontSize: 11, fontWeight: 700 }}>
                          {ROLE_LABEL[user.role] || user.role}
                        </span>
                        <span style={{ fontSize: 11, color: user.active ? 'var(--green)' : 'var(--text-muted)' }}>
                          {user.active ? '● Hoạt động' : '○ Tạm khóa'}
                        </span>
                      </div>
                    </div>

                    {/* Delete confirmation inline */}
                    {deletingId === user.id && (
                      <div style={{ padding: '8px 14px', borderTop: '1px solid var(--border)', background: '#FEF2F2', display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ flex: 1, fontSize: 13, color: '#991B1B' }}>Xác nhận xóa {user.ho_ten}?</span>
                        <button className="btn-primary" style={{ background: '#EF4444', border: 'none', height: 30, fontSize: 12, padding: '0 12px' }}
                          onClick={() => handleDeleteUser(user.id)} disabled={savingUser}>
                          {savingUser ? '...' : 'Xóa'}
                        </button>
                        <button className="btn-secondary" style={{ height: 30, fontSize: 12, padding: '0 12px' }}
                          onClick={() => setDeletingId(null)}>Hủy</button>
                      </div>
                    )}

                    {/* Actions */}
                    <div className="phien-card-actions-full">
                      {[
                        { label: 'Sửa', onClick: () => openEdit(user), color: 'var(--text)' },
                        { label: user.active ? 'Tạm khóa' : 'Mở khóa', onClick: () => handleToggleActive(user), color: 'var(--orange-dark)' },
                        { label: deletingId === user.id ? 'Đóng' : 'Xóa', onClick: () => setDeletingId(deletingId === user.id ? null : user.id), color: '#EF4444' }
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
              })
            })()}
          </>
        )}
      </div>
    </div>
  )
}
