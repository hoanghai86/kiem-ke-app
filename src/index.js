// src/index.js
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

const root = ReactDOM.createRoot(document.getElementById('root'))
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

// Đăng ký service worker thật sự nằm ở public/index.html (script inline, chạy trước khi
// bundle này tải xong) — nó cũng xử lý luôn việc dọn SW cũ khi không phải bản production.

