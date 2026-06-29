// src/screens/Login.jsx
import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { db } from '../lib/db'
import { pullDanhMuc } from '../lib/sync'

export default function Login({ onLogin }) {
  const [maUser, setMaUser]     = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState('')
  const [foundUser, setFoundUser] = useState(null)

  async function lookupUser(ma) {
    if (!ma.trim()) { setFoundUser(null); return }
    const user = await db.dm_user.get(ma.trim())
    setFoundUser(user || null)
  }

  async function handleLogin() {
    if (!maUser.trim() || !password) return
    setLoading(true)
    setError('')

    // Bước 1: tìm email ứng với ma_user
    let email = null

    if (navigator.onLine) {
      const { data, error: rpcErr } = await supabase.rpc('get_email_by_ma_user', {
        p_ma_user: maUser.trim()
      })
      if (rpcErr || !data) {
        setError('Mã user không tồn tại hoặc tài khoản đã bị khóa')
        setLoading(false)
        return
      }
      email = data
    } else {
      // Offline: tra IndexedDB (chỉ hoạt động sau khi đã đăng nhập ít nhất 1 lần)
      const users = await db.dm_user.toArray()
      const found = users.find(u => u.ma_user === maUser.trim() && u.active)
      if (!found?.email) {
        setError('Không tìm thấy mã user. Cần kết nối mạng để đăng nhập lần đầu.')
        setLoading(false)
        return
      }
      email = found.email
    }

    // Bước 2: đăng nhập bằng email + mật khẩu
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email,
      password
    })

    if (authError) {
      setError('Mật khẩu không đúng')
      setLoading(false)
      return
    }

    // Bước 3: lấy profile từ dm_user
    const { data: profile } = await supabase
      .from('dm_user')
      .select('*')
      .eq('id', authData.user.id)
      .single()

    if (!profile) {
      setError('Tài khoản chưa được cấu hình. Liên hệ admin.')
      setLoading(false)
      return
    }

    await db.dm_user.put(profile)
    localStorage.setItem('lastUserId', profile.id)
    if (navigator.onLine) await pullDanhMuc()

    onLogin(profile)
    setLoading(false)
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-logo">
          <div className="login-logo-icon">📦</div>
          <div className="login-logo-title">Kiểm Kê</div>
          <div className="login-logo-sub">Hàng hóa</div>
        </div>

        {error && <div className="error-box">{error}</div>}

        <div className="field-group">
          <label className="field-label">Mã user</label>
          <input
            type="text"
            className="input-field"
            placeholder="VD: KT01"
            value={maUser}
            onChange={e => { const v = e.target.value.toUpperCase(); setMaUser(v); lookupUser(v) }}
            onKeyDown={e => e.key === 'Enter' && handleLogin()}
            autoComplete="username"
            autoCapitalize="characters"
          />
          {foundUser && (
            <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, color: '#1d9e75', fontWeight: 600 }}>✓ {foundUser.ho_ten}</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{foundUser.role === 'ke_toan' ? 'Kế toán' : foundUser.role === 'thu_kho' ? 'Thủ kho' : 'Admin'}</span>
            </div>
          )}
        </div>

        <div className="field-group">
          <label className="field-label">Mật khẩu</label>
          <input
            type="password"
            className="input-field"
            placeholder="••••••••"
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleLogin()}
            autoComplete="current-password"
          />
        </div>

        <button
          className="btn-primary"
          onClick={handleLogin}
          disabled={loading || !maUser.trim() || !password}
        >
          {loading ? 'Đang đăng nhập...' : 'Đăng nhập'}
        </button>

        <div className="login-footer">
          Quên mật khẩu? Liên hệ admin
        </div>
      </div>
    </div>
  )
}
