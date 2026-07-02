// src/lib/authGuard.js
// Chặn các sự kiện auth "trễ" (VD TOKEN_REFRESHED đã treo từ trước lúc đăng xuất, chỉ resolve
// sau đó — càng rõ khi mạng chậm) xử lý SAU khi user đã chủ động đăng xuất. Khác với hẹn giờ cố
// định (có thể vẫn không đủ nếu mạng quá chậm), cờ này chặn vô thời hạn cho tới khi user chủ
// động đăng nhập lại qua form — lúc đó mới chắc chắn không còn sự kiện trễ nào từ phiên cũ.
let suppressed = false

export function suppressAuthEvents() {
  suppressed = true
}

export function allowAuthEvents() {
  suppressed = false
}

export function isAuthEventsSuppressed() {
  return suppressed
}
