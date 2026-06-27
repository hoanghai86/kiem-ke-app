// src/screens/Account.jsx
import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { db } from '../lib/db'

const ROLE_LABEL = { ke_toan: 'Kế toán', thu_kho: 'Thủ kho', admin: 'Admin' }

export default function Account({ currentUser, onUpdate }) {
  const [ho_ten, setHoTen] = useState(currentUser?.ho_ten || '')
  const [password, setPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg]     = useState(null) // { type: 'ok'|'err', text }

  async function handleSave() {
    if (!ho_ten.trim()) { setMsg({ type: 'err', text: 'Họ tên không được để trống' }); return }
    if (password && password.length < 6) { setMsg({ type: 'err', text: 'Mật khẩu tối thiểu 6 ký tự' }); return }
    setSaving(true)
    setMsg(null)
    try {
      // Cập nhật họ tên trong dm_user
      const { error } = await supabase
        .from('dm_user')
        .update({ ho_ten: ho_ten.trim() })
        .eq('id', currentUser.id)
      if (error) throw new Error(error.message)

      // Cập nhật IndexedDB
      await db.dm_user.update(currentUser.id, { ho_ten: ho_ten.trim() })

      // Đổi mật khẩu nếu có nhập
      if (password.trim()) {
        const { error: pwdErr } = await supabase.auth.updateUser({ password })
        if (pwdErr) throw new Error('Đổi mật khẩu thất bại: ' + pwdErr.message)
      }

      onUpdate({ ...currentUser, ho_ten: ho_ten.trim() })
      setPassword('')
      setMsg({ type: 'ok', text: 'Đã lưu thay đổi' })
    } catch (e) {
      setMsg({ type: 'err', text: e.message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="screen">
      <div className="topbar">
        <div className="topbar-title">Tài khoản của tôi</div>
        <div className="topbar-sub">{currentUser?.ma_user}</div>
      </div>

      <div className="content">
        {/* Avatar / info header */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '24px 0 20px', gap: 8 }}>
          <div style={{
            width: 72, height: 72, borderRadius: '50%',
            background: 'var(--green)', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 28, fontWeight: 700
          }}>
            {(currentUser?.ho_ten || '?')[0].toUpperCase()}
          </div>
          <div style={{ fontWeight: 700, fontSize: 17 }}>{currentUser?.ho_ten}</div>
          <span style={{
            background: '#D1FAE5', color: '#065F46',
            borderRadius: 4, padding: '2px 10px', fontSize: 12, fontWeight: 600
          }}>
            {ROLE_LABEL[currentUser?.role] || currentUser?.role}
          </span>
        </div>

        {/* Thông tin chỉ đọc */}
        <div style={{ background: 'var(--surface)', borderRadius: 10, marginBottom: 16, overflow: 'hidden' }}>
          {[
            { label: 'Mã user',  value: currentUser?.ma_user },
            { label: 'Email',    value: currentUser?.email },
            { label: 'Vai trò', value: ROLE_LABEL[currentUser?.role] }
          ].map(({ label, value }) => (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{label}</span>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{value}</span>
            </div>
          ))}
        </div>

        {/* Form sửa */}
        {msg && (
          <div style={{
            padding: '10px 14px', borderRadius: 8, marginBottom: 14, fontSize: 13,
            background: msg.type === 'ok' ? '#D1FAE5' : '#FEE2E2',
            color: msg.type === 'ok' ? '#065F46' : '#991B1B'
          }}>{msg.text}</div>
        )}

        <div className="field-group">
          <label className="field-label">Họ tên</label>
          <input className="input-field" value={ho_ten}
            onChange={e => setHoTen(e.target.value)}
            placeholder="Họ và tên" />
        </div>

        <div className="field-group">
          <label className="field-label">Mật khẩu mới (để trống nếu không đổi)</label>
          <input className="input-field" type="password" value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Tối thiểu 6 ký tự" />
        </div>

        <button className="btn-primary" onClick={handleSave} disabled={saving}
          style={{ width: '100%', marginTop: 8 }}>
          {saving ? 'Đang lưu...' : 'Lưu thay đổi'}
        </button>
      </div>
    </div>
  )
}
