// public/service-worker.js
const CACHE_NAME = 'kiem-ke-v2'

// Chỉ pre-cache các file có tên cố định — JS/CSS/chunk có hash sẽ được cache động khi fetch
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.ico',
  '/logo192.png',
  '/logo512.png'
]

// Install — cache shell tối thiểu
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
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

// Fetch — cache first cho static, network first cho API
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)

  // API calls (Supabase, GAS) → network only
  if (url.hostname.includes('supabase.co') || url.hostname.includes('script.google.com')) {
    event.respondWith(
      fetch(event.request).catch(() => new Response(
        JSON.stringify({ error: 'offline' }),
        { headers: { 'Content-Type': 'application/json' } }
      ))
    )
    return
  }

  // Static assets → cache first
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
