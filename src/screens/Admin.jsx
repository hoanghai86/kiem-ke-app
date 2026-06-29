// src/screens/Admin.jsx
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { toSearchable } from '../lib/utils'
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
  const [selectedUserId, setSelectedUserId] = useState(null)
  const [confirmDeleteFiltered, setConfirmDeleteFiltered] = useState(false)
  const [userErr, setUserErr] = useState('')
  const [userInfoMsg, setUserInfoMsg] = useState('')
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
          .update({ ma_user: ma_user.trim(), ho_ten: ho_ten.trim(), role })
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

  async function checkUsersInUse(userIds) {
    const [r1, r2] = await Promise.all([
      supabase.from('phien_kiem_ke').select('ke_toan_id').in('ke_toan_id', userIds),
      supabase.from('phien_kiem_ke').select('thu_kho_id').in('thu_kho_id', userIds),
    ])
    return new Set([
      ...(r1.data||[]).map(r=>r.ke_toan_id),
      ...(r2.data||[]).map(r=>r.thu_kho_id),
    ])
  }

  async function handleDeleteUser(id) {
    setSavingUser(true)
    try {
      const inUse = await checkUsersInUse([id])
      if (inUse.has(id)) {
        setUserErr('Không thể xóa: người dùng này đã tham gia phiên kiểm kê. Dùng "Tạm khóa" thay thế.')
        setDeletingId(null)
        return
      }
      await callGas({ action: 'delete_user', id })
      await loadUsers()
    } catch (e) {
      setUserErr(e.message)
    } finally {
      setSavingUser(false)
      setDeletingId(null)
    }
  }

  async function handleDeleteFilteredUsers(users) {
    setSavingUser(true)
    try {
      const inUse = await checkUsersInUse(users.map(u => u.id))
      const safe = users.filter(u => !inUse.has(u.id))
      for (const u of safe) {
        await callGas({ action: 'delete_user', id: u.id })
      }
      await loadUsers()
      setConfirmDeleteFiltered(false)
      if (inUse.size === 0) setUserSearch('')
      if (inUse.size > 0) setUserInfoMsg(`Đã xóa ${safe.length} người dùng. Giữ lại ${inUse.size} người đã tham gia phiên kiểm kê.`)
    } catch (e) {
      setUserErr(e.message)
    } finally {
      setSavingUser(false)
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
              placeholder="email@company.com"
              disabled={!!editUser}
              style={editUser ? { background: 'var(--bg-secondary)', color: 'var(--text-muted)' } : {}} />
            {editUser && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              Để đổi email, vui lòng cập nhật trực tiếp trong Supabase Authentication.
            </div>}
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
            {userErr && <div className="error-box" onClick={() => setUserErr('')}>{userErr} ✕</div>}
            {userInfoMsg && (
              <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
                <div style={{ background: '#fff', borderRadius: 14, padding: 24, maxWidth: 320, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}>
                  <div style={{ fontSize: 36, textAlign: 'center', marginBottom: 10 }}>✅</div>
                  <div style={{ fontSize: 15, fontWeight: 700, textAlign: 'center', marginBottom: 8, color: 'var(--text)' }}>Kết quả xóa</div>
                  <div style={{ fontSize: 14, color: 'var(--text)', textAlign: 'center', lineHeight: 1.6, marginBottom: 20 }}>{userInfoMsg}</div>
                  <button onClick={() => setUserInfoMsg('')} style={{ width: '100%', padding: '11px', borderRadius: 8, border: 'none', background: 'var(--green)', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>OK</button>
                </div>
              </div>
            )}

            <button className="btn-primary" onClick={openCreate}
              style={{ width: '100%', marginBottom: 10 }}>
              + Thêm người dùng
            </button>

            {/* Bộ lọc */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 }}>
              <input
                className="input-field"
                placeholder="Tìm theo mã, họ tên... (nhiều mã cách nhau bằng dấu phẩy)"
                value={userSearch}
                onChange={e => { setUserSearch(e.target.value); setConfirmDeleteFiltered(false) }}
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
              const terms = userSearch.split(',').map(t => toSearchable(t)).filter(Boolean)
              const filtered = danhSachUser.filter(u => {
                if (filterRole !== 'all' && u.role !== filterRole) return false
                if (filterActive !== 'all' && String(u.active) !== filterActive) return false
                if (terms.length) {
                  const text = toSearchable(`${u.ma_user} ${u.ho_ten} ${u.email || ''}`)
                  if (!terms.some(t => text.includes(t))) return false
                }
                return true
              })
              if (filtered.length === 0) return <div className="empty-state">Không tìm thấy người dùng nào</div>
              return (
                <>
                  {terms.length > 0 && (
                    confirmDeleteFiltered ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', marginBottom: 10, borderRadius: 8, background: '#FEF2F2', border: '1px solid #FECACA' }}>
                        <span style={{ flex: 1, fontSize: 13, color: '#991B1B', fontWeight: 500 }}>Xóa {filtered.length} người dùng đang lọc?</span>
                        <button onClick={() => handleDeleteFilteredUsers(filtered)} disabled={savingUser}
                          style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#EF4444', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                          {savingUser ? '...' : 'Xóa'}
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
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid var(--border)' }}>
                      <th style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', fontSize: 11 }}>Họ tên</th>
                      <th style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', fontSize: 11 }}>Vai trò</th>
                      <th style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 600, color: 'var(--text-muted)', fontSize: 11 }}>TT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(user => {
                      const rc    = ROLE_COLOR[user.role] || { bg: '#F3F4F6', color: '#374151' }
                      const isSel = selectedUserId === user.id
                      return (
                        <>
                          <tr key={user.id}
                            onClick={() => { setSelectedUserId(isSel ? null : user.id); setDeletingId(null) }}
                            style={{ cursor: 'pointer', opacity: user.active ? 1 : 0.55, background: isSel ? '#F0FDF4' : 'white', borderBottom: '1px solid #F3F4F6' }}>
                            <td style={{ padding: '10px 10px' }}>
                              <div style={{ fontWeight: 600 }}>{user.ho_ten}</div>
                              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>{user.ma_user} · {user.email || '—'}</div>
                            </td>
                            <td style={{ padding: '10px 10px', whiteSpace: 'nowrap' }}>
                              <span style={{ background: rc.bg, color: rc.color, borderRadius: 4, padding: '2px 7px', fontSize: 11, fontWeight: 700 }}>
                                {ROLE_LABEL[user.role] || user.role}
                              </span>
                            </td>
                            <td style={{ padding: '10px 10px', textAlign: 'center', whiteSpace: 'nowrap' }}>
                              <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 6px', borderRadius: 4,
                                background: user.active ? '#D1FAE5' : '#F3F4F6', color: user.active ? '#065F46' : '#6B7280' }}>
                                {user.active ? 'HĐ' : 'Khóa'}
                              </span>
                            </td>
                          </tr>
                          {isSel && (
                            <tr key={`${user.id}_sel`} style={{ background: '#F0FDF4' }}>
                              <td colSpan={3} style={{ padding: '8px 10px', borderBottom: '1px solid #D1FAE5' }}>
                                {deletingId === user.id ? (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span style={{ flex: 1, fontSize: 13, color: '#991B1B' }}>Xác nhận xóa {user.ho_ten}?</span>
                                    <button onClick={e => { e.stopPropagation(); handleDeleteUser(user.id) }} disabled={savingUser}
                                      style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#EF4444', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                                      {savingUser ? '...' : 'Xóa'}
                                    </button>
                                    <button onClick={e => { e.stopPropagation(); setDeletingId(null) }}
                                      style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border)', background: '#fff', fontSize: 13, cursor: 'pointer' }}>
                                      Hủy
                                    </button>
                                  </div>
                                ) : (
                                  <div style={{ display: 'flex', gap: 16, justifyContent: 'flex-end' }}>
                                    <button onClick={e => { e.stopPropagation(); openEdit(user) }}
                                      style={{ border: 'none', background: 'none', fontSize: 13, fontWeight: 600, color: 'var(--text)', cursor: 'pointer', padding: '4px 0' }}>
                                      Sửa
                                    </button>
                                    <button onClick={e => { e.stopPropagation(); handleToggleActive(user) }}
                                      style={{ border: 'none', background: 'none', fontSize: 13, fontWeight: 600, color: '#D97706', cursor: 'pointer', padding: '4px 0' }}>
                                      {user.active ? 'Tạm khóa' : 'Mở khóa'}
                                    </button>
                                    <button onClick={e => { e.stopPropagation(); setDeletingId(user.id) }}
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
                </>
              )
            })()}
          </>
        )}
      </div>
    </div>
  )
}
