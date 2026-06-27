// src/App.jsx
import { useEffect, useRef, useState, useCallback } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { supabase } from './lib/supabase'
import { db } from './lib/db'
import { pullDanhMuc, pushOfflineQueue } from './lib/sync'
import BatDauPhien from './screens/BatDauPhien'
import KiemKe from './screens/KiemKe'
import DemLai from './screens/DemLai'
import TongHop from './screens/TongHop'
import Admin from './screens/Admin'
import DanhMuc from './screens/DanhMuc'
import Account from './screens/Account'
import BaoCao from './screens/BaoCao'
import Login from './screens/Login'
import './App.css'
import './extra.css'

async function resolveProfile(userId) {
  const local = await db.dm_user.get(userId)
  if (local) return local

  if (!navigator.onLine) return null

  const { data } = await supabase.from('dm_user').select('*').eq('id', userId).single()
  if (data) await db.dm_user.put(data)
  return data || null
}

export default function App() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Lấy session hiện tại
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (session) {
        const profile = await resolveProfile(session.user.id)
        setUser(profile)
        if (navigator.onLine) pullDanhMuc()
      }
      setLoading(false)
    })

    // Listen auth change
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (session) {
        const profile = await resolveProfile(session.user.id)
        setUser(profile)
        if (navigator.onLine) {
          await pullDanhMuc()
          await pushOfflineQueue()
        }
      } else {
        setUser(null)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  if (loading) return <div className="loading-screen">Đang tải...</div>

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={!user ? <Login onLogin={setUser} /> : <Navigate to="/" />} />
        <Route path="/" element={user ? <BatDauPhien currentUser={user} /> : <Navigate to="/login" />} />
        <Route path="/kiem-ke/:phienId" element={user ? <KiemKe currentUser={user} /> : <Navigate to="/login" />} />
        <Route path="/dem-lai/:phienId" element={user ? <DemLai currentUser={user} /> : <Navigate to="/login" />} />
        <Route path="/tong-hop/:phienId" element={user ? <TongHop currentUser={user} /> : <Navigate to="/login" />} />
        <Route path="/admin" element={user?.role === 'admin' ? <Admin /> : <Navigate to="/" />} />
        <Route path="/danh-muc" element={user?.role === 'admin' ? <DanhMuc /> : <Navigate to="/" />} />
        <Route path="/account" element={user ? <Account currentUser={user} onUpdate={setUser} /> : <Navigate to="/login" />} />
        <Route path="/bao-cao" element={user ? <BaoCao /> : <Navigate to="/login" />} />
      </Routes>

      {/* Sync FAB + Bottom nav — chỉ show khi đã login */}
      {user && <SyncButton />}
      {user && <BottomNav role={user.role} currentUser={user} onLogout={() => supabase.auth.signOut()} />}
    </BrowserRouter>
  )
}

function SyncButton() {
  const [online, setOnline] = useState(navigator.onLine)
  const [pending, setPending] = useState(0)
  const [syncing, setSyncing] = useState(false)
  const isSyncing = useRef(false)

  async function refreshCount() {
    setPending(await db.sync_queue.count())
  }

  async function doSync() {
    if (isSyncing.current || !navigator.onLine) return
    isSyncing.current = true
    setSyncing(true)
    try {
      await pushOfflineQueue()
      await pullDanhMuc()
      await refreshCount()
    } finally {
      isSyncing.current = false
      setSyncing(false)
    }
  }

  useEffect(() => {
    refreshCount()
    const onOnline = () => { setOnline(true); doSync() }
    const onOffline = () => { setOnline(false); refreshCount() }
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    const timer = setInterval(refreshCount, 3000)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      clearInterval(timer)
    }
  }, [])

  let cls, icon, tip
  if (!online) {
    cls = 'sync-fab offline'; icon = '✕'; tip = 'Không có mạng'
  } else if (syncing) {
    cls = 'sync-fab syncing'; icon = '↻'; tip = 'Đang sync...'
  } else if (pending > 0) {
    cls = 'sync-fab pending'; icon = '↻'; tip = `${pending} mục chờ sync — nhấn để sync`
  } else {
    cls = 'sync-fab ok'; icon = '✓'; tip = 'Đã đồng bộ'
  }

  return (
    <button className={cls} onClick={doSync} title={tip} disabled={!online || syncing}>
      <span className={syncing ? 'spin' : ''}>{icon}</span>
      {pending > 0 && !syncing && (
        <span className="sync-badge">{pending > 99 ? '99+' : pending}</span>
      )}
    </button>
  )
}

function BottomNav({ role, currentUser, onLogout }) {
  const navigate = useNavigate()
  const location = useLocation()
  const path = location.pathname
  const [showMenu, setShowMenu] = useState(false)
  const menuRef = useRef(null)

  useEffect(() => {
    if (!showMenu) return
    function handleClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setShowMenu(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showMenu])

  // Extract phienId từ URL hiện tại
  const phienIdMatch = path.match(/\/(kiem-ke|dem-lai|tong-hop)\/(.+)/)
  const currentPhienId = phienIdMatch?.[2] || null

  return (
    <div className="bottom-nav">
      <button
        className={`nav-item ${path === '/' || path.includes('kiem-ke') || path.includes('dem-lai') ? 'active' : ''}`}
        onClick={() => navigate('/', { state: { refresh: Date.now() } })}
      >
        <span className="nav-icon">🏠</span>
        <span>Phiên KK</span>
      </button>
      <button
        className={`nav-item ${path === '/bao-cao' ? 'active' : ''}`}
        onClick={() => navigate('/bao-cao')}
      >
        <span className="nav-icon">📊</span>
        <span>Báo cáo</span>
      </button>
      {role === 'admin' && (
        <button className={`nav-item ${path === '/admin' ? 'active' : ''}`}
          onClick={() => navigate('/admin')}>
          <span className="nav-icon">📊</span>
          <span>Admin</span>
        </button>
      )}
      <div ref={menuRef} style={{ position: 'relative' }}>
        {showMenu && (
          <div style={{
            position: 'absolute', bottom: 'calc(100% + 8px)', right: 0,
            background: '#fff', borderRadius: 10,
            boxShadow: '0 4px 24px rgba(0,0,0,0.15)',
            minWidth: 190, overflow: 'hidden', zIndex: 200
          }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{currentUser?.ho_ten}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{currentUser?.ma_user} · {currentUser?.role === 'admin' ? 'Admin' : currentUser?.role === 'ke_toan' ? 'Kế toán' : 'Thủ kho'}</div>
            </div>
            {[
              { icon: '👤', label: 'Tài khoản của tôi', onClick: () => { navigate('/account'); setShowMenu(false) } },
              { icon: '⏻', label: 'Đăng xuất', onClick: () => { onLogout(); setShowMenu(false) }, color: '#EF4444' }
            ].map(item => (
              <button key={item.label} onClick={item.onClick} style={{
                width: '100%', padding: '12px 16px', border: 'none', background: 'none',
                textAlign: 'left', fontSize: 14, cursor: 'pointer', display: 'flex',
                alignItems: 'center', gap: 10, color: item.color || 'var(--text)'
              }}>
                <span>{item.icon}</span>{item.label}
              </button>
            ))}
          </div>
        )}
        <button className={`nav-item ${path === '/account' ? 'active' : ''}`} onClick={() => setShowMenu(v => !v)}>
          <span className="nav-icon">👤</span>
          <span>Tài khoản</span>
        </button>
      </div>
    </div>
  )
}
