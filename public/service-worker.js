// public/service-worker.js
const CACHE_NAME = 'kiem-ke-v5'

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
]

// Install — pre-cache shell, bỏ qua file lỗi 404
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.all(
        STATIC_ASSETS.map(url =>
          cache.add(url).catch(err => console.warn('[SW] Bỏ qua:', url, err))
        )
      )
    )
  )
  self.skipWaiting()
})

// Activate — xóa cache cũ
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)

  // API calls (Supabase, GAS) → network only, trả 503 khi offline để client xử lý đúng
  if (url.hostname.includes('supabase.co') || url.hostname.includes('script.google.com')) {
    event.respondWith(
      fetch(event.request).catch(() => new Response(
        JSON.stringify({ error: 'offline' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      ))
    )
    return
  }

  // HTML / navigation → network first: lấy bản mới khi online, fallback cache khi offline
  // Đảm bảo khi deploy code mới user luôn nhận được index.html mới nhất
  if (event.request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone()
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone))
        }
        return response
      }).catch(() =>
        caches.match(event.request).then(cached => cached || caches.match('/index.html'))
      )
    )
    return
  }

  // Static assets (JS, CSS, images) → cache first: hash-based filenames, an toàn cache lâu dài
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached
      return fetch(event.request).then(response => {
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone()
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone))
        }
        return response
      }).catch(() => caches.match('/index.html'))
    })
  )
})

// Background Sync — push offline queue khi có mạng
self.addEventListener('sync', event => {
  if (event.tag === 'sync-kiem-ke') {
    event.waitUntil(
      self.clients.matchAll().then(clients => {
        clients.forEach(client => client.postMessage({ type: 'SYNC_REQUESTED' }))
      })
    )
  }
})

// Push notification (tùy chọn mở rộng sau)
self.addEventListener('push', event => {
  const data = event.data?.json() || {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'Kiểm kê', {
      body: data.body || '',
      icon: '/logo192.png'
    })
  )
})
