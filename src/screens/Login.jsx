// src/screens/Login.jsx
import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { db } from '../lib/db'
import { pullDanhMuc } from '../lib/sync'
import { allowAuthEvents, isAuthEventsSuppressed } from '../lib/authGuard'

export default function Login({ onLogin }) {
  const [maUser, setMaUser]     = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading]   = useState(false)
  const [loadingStage, setLoadingStage] = useState('') // '' | 'login' | 'sync' — hiện rõ đang làm gì để tránh cảm giác treo máy
  const [syncProgress, setSyncProgress] = useState(0) // 0-100, % vật tư đã tải — vẽ thanh loading kiểu game
  const [error, setError]       = useState('')
  const [foundUser, setFoundUser] = useState(null)

  async function lookupUser(ma) {
    if (!ma.trim()) { setFoundUser(null); return }
    const user = await db.dm_user.get(ma.trim())
    setFoundUser(user || null)
  }

  async function handleLogin() {
    if (!maUser.trim() || !password) return
    allowAuthEvents() // user chủ động đăng nhập lại — bỏ chặn sự kiện auth đã đặt lúc đăng xuất
    setLoading(true)
    setLoadingStage('login')
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
        setLoadingStage('')
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
        setLoadingStage('')
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
      setLoadingStage('')
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
      setLoadingStage('')
      return
    }

    await db.dm_user.put(profile)
    localStorage.setItem('lastUserId', profile.id)
    if (navigator.onLine) {
      setLoadingStage('sync')
      setSyncProgress(0)
      await pullDanhMuc((loaded, total) => setSyncProgress(total ? Math.round((loaded / total) * 100) : 0))
    }

    // Nếu user đã bấm đăng xuất trong lúc hàm này còn đang chạy dở (component Login đã unmount
    // nhưng promise vẫn tiếp tục tới đây) — không set lại user bằng profile cũ nữa.
    if (isAuthEventsSuppressed()) {
      setLoading(false)
      setLoadingStage('')
      return
    }

    onLogin(profile)
    setLoading(false)
    setLoadingStage('')
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
          {loadingStage === 'sync' ? `Đang tải danh mục... ${syncProgress}%` : loading ? 'Đang đăng nhập...' : 'Đăng nhập'}
        </button>
        {loadingStage === 'sync' && (
          <div style={{ marginTop: 10 }}>
            <div style={{ width: '100%', height: 10, background: '#E5E7EB', borderRadius: 999, overflow: 'hidden' }}>
              <div style={{
                width: `${syncProgress}%`, height: '100%',
                background: 'linear-gradient(90deg, #1d9e75, #34d399)',
                borderRadius: 999, transition: 'width 0.25s ease-out'
              }} />
            </div>
            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>
              Đang tải dữ liệu vật tư, kho... để dùng được offline
            </div>
          </div>
        )}

        <div className="login-footer">
          Quên mật khẩu? Liên hệ admin
        </div>
      </div>
    </div>
  )
}
