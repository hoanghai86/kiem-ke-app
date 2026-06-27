// Google Apps Script — deploy as Web App
// Nhận POST từ app → đọc Supabase → ghi vào Google Sheet

const SHEET_ID = 'YOUR_GOOGLE_SHEET_ID'
const SUPABASE_URL = 'https://jqlaokgdjxzfkqcztsfc.supabase.co'
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpxbGFva2dkanh6ZmtxY3p0c2ZjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MjI2NTEzMCwiZXhwIjoyMDk3ODQxMTMwfQ.LgTLKJ1VD1MWcnhgwRdNaWs4wrLJpXRXWMHq5Jlr6jQ'

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents)

    if (body.action === 'sync_phien') {
      syncPhienToSheet(body.phien_id)
      return ok('synced')
    }

    if (body.action === 'create_user') {
      return createAuthUser(body)
    }

    if (body.action === 'delete_user') {
      return deleteAuthUser(body.id)
    }

    if (body.action === 'reset_password') {
      return resetUserPassword(body.email, body.password)
    }

    return error('Unknown action')
  } catch (err) {
    return error(err.toString())
  }
}

function doGet(e) {
  // Health check
  return ok('GAS running')
}

// -----------------------------------------------
// Sync 1 phiên kiểm kê lên Sheet
// -----------------------------------------------
function syncPhienToSheet(phien_id) {
  const ss = SpreadsheetApp.openById(SHEET_ID)

  // Lấy data từ Supabase
  const phien = supabaseFetch(`/rest/v1/phien_kiem_ke?id=eq.${phien_id}&select=*,dm_kho(*),ke_toan:dm_user!ke_toan_id(*),thu_kho:dm_user!thu_kho_id(*)`)
  const chitiet = supabaseFetch(`/rest/v1/kiem_ke_chitiet?phien_id=eq.${phien_id}&select=*&order=created_at.asc`)

  if (!phien.length || !chitiet.length) return

  const p = phien[0]
  const sheetName = `KK_${p.ma_kho}_${p.ngay_kiem}`

  // Tạo hoặc lấy sheet tab
  let sheet = ss.getSheetByName(sheetName)
  if (!sheet) {
    sheet = ss.insertSheet(sheetName)
  } else {
    sheet.clearContents()
  }

  // Header
  const headers = [
    'Mã vật tư', 'Tên vật tư', 'ĐVT kiểm', 'Hệ số quy đổi',
    'Lượt kiểm', 'Số lượng thực tế', 'Số lượng quy đổi',
    'Số lượng sổ sách', 'Chênh lệch', 'Ghi chú', 'Thời gian nhập',
    'Kho', 'Kế toán', 'Thủ kho', 'Ngày kiểm'
  ]

  const rows = chitiet.map(r => [
    r.ma_vt,
    r.ten_vt,
    r.ma_dvt_kiem || '',
    r.he_so_quy_doi,
    r.luot_kiem,
    r.so_luong_thuc_te,
    r.so_luong_quy_doi,
    r.so_luong_so_sach || '',
    r.chenh_lech || '',
    r.ghi_chu || '',
    new Date(r.created_at).toLocaleString('vi-VN'),
    p.dm_kho?.ten_kho || p.ma_kho,
    p.ke_toan?.ho_ten || '',
    p.thu_kho?.ho_ten || '',
    p.ngay_kiem
  ])

  // Ghi vào sheet
  sheet.getRange(1, 1, 1, headers.length).setValues([headers])
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows)
  }

  // Format header
  const headerRange = sheet.getRange(1, 1, 1, headers.length)
  headerRange.setBackground('#1D9E75')
  headerRange.setFontColor('white')
  headerRange.setFontWeight('bold')
  sheet.setFrozenRows(1)

  // Highlight chênh lệch
  const chenhLechCol = 9
  for (let i = 2; i <= rows.length + 1; i++) {
    const cell = sheet.getRange(i, chenhLechCol)
    const val = parseFloat(cell.getValue())
    if (!isNaN(val) && val !== 0) {
      cell.setBackground(val < 0 ? '#FAECE7' : '#FAEEDA')
    }
  }

  sheet.autoResizeColumns(1, headers.length)

  // Ghi vào sheet tổng hợp
  updateSheetTongHop(ss, p, chitiet)
}

// -----------------------------------------------
// Sheet tổng hợp tất cả phiên
// -----------------------------------------------
function updateSheetTongHop(ss, phien, chitiet) {
  const sheetName = 'Số liệu kiểm thực tế'
  let sheet = ss.getSheetByName(sheetName)

  if (!sheet) {
    sheet = ss.insertSheet(sheetName)
    const headers = [
      'Phiên ID', 'Kho', 'Ngày kiểm', 'Kế toán', 'Thủ kho',
      'Mã vật tư', 'Tên vật tư', 'ĐVT kiểm', 'Hệ số',
      'Lượt kiểm', 'SL thực tế', 'SL quy đổi', 'SL sổ sách',
      'Chênh lệch', 'Ghi chú', 'Thời gian nhập'
    ]
    sheet.getRange(1, 1, 1, headers.length).setValues([headers])
    sheet.getRange(1, 1, 1, headers.length).setBackground('#1D9E75').setFontColor('white').setFontWeight('bold')
    sheet.setFrozenRows(1)
  }

  // Xóa các dòng cũ của phiên này (nếu sync lại)
  const lastRow = sheet.getLastRow()
  if (lastRow > 1) {
    const data = sheet.getRange(2, 1, lastRow - 1, 1).getValues()
    for (let i = data.length - 1; i >= 0; i--) {
      if (data[i][0] === phien.id) {
        sheet.deleteRow(i + 2)
      }
    }
  }

  // Append rows mới
  const newRows = chitiet.map(r => [
    phien.id,
    phien.dm_kho?.ten_kho || phien.ma_kho,
    phien.ngay_kiem,
    phien.ke_toan?.ho_ten || '',
    phien.thu_kho?.ho_ten || '',
    r.ma_vt,
    r.ten_vt,
    r.ma_dvt_kiem || '',
    r.he_so_quy_doi,
    r.luot_kiem,
    r.so_luong_thuc_te,
    r.so_luong_quy_doi,
    r.so_luong_so_sach || '',
    r.chenh_lech || '',
    r.ghi_chu || '',
    new Date(r.created_at).toLocaleString('vi-VN')
  ])

  if (newRows.length) {
    const startRow = sheet.getLastRow() + 1
    sheet.getRange(startRow, 1, newRows.length, newRows[0].length).setValues(newRows)
  }
}

// -----------------------------------------------
// Quản lý người dùng (cần service role key)
// -----------------------------------------------
function createAuthUser(data) {
  // 1. Tạo auth user
  const authRes = UrlFetchApp.fetch(SUPABASE_URL + '/auth/v1/admin/users', {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify({
      email: data.email,
      password: data.password,
      email_confirm: true
    }),
    muteHttpExceptions: true
  })

  const authUser = JSON.parse(authRes.getContentText())
  if (!authUser.id) return error('Tạo tài khoản thất bại: ' + (authUser.msg || authUser.message || JSON.stringify(authUser)))

  // 2. Insert dm_user
  const dmRes = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/dm_user', {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    payload: JSON.stringify({
      id: authUser.id,
      email: data.email,
      ma_user: data.ma_user,
      ho_ten: data.ho_ten,
      role: data.role,
      active: true
    }),
    muteHttpExceptions: true
  })

  if (dmRes.getResponseCode() >= 400) {
    // Rollback: xóa auth user vừa tạo
    UrlFetchApp.fetch(SUPABASE_URL + '/auth/v1/admin/users/' + authUser.id, {
      method: 'DELETE',
      headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY },
      muteHttpExceptions: true
    })
    return error('Tạo hồ sơ thất bại: ' + dmRes.getContentText())
  }

  return ok('Đã tạo người dùng')
}

function deleteAuthUser(userId) {
  // Xóa dm_user trước
  UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/dm_user?id=eq.' + userId, {
    method: 'DELETE',
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY },
    muteHttpExceptions: true
  })

  // Xóa auth user
  const res = UrlFetchApp.fetch(SUPABASE_URL + '/auth/v1/admin/users/' + userId, {
    method: 'DELETE',
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY },
    muteHttpExceptions: true
  })

  if (res.getResponseCode() >= 400) return error('Xóa tài khoản thất bại')
  return ok('Đã xóa người dùng')
}

function resetUserPassword(email, newPassword) {
  // Lấy toàn bộ user list rồi filter trong GAS (tránh lỗi API không filter đúng)
  const listRes = UrlFetchApp.fetch(SUPABASE_URL + '/auth/v1/admin/users?per_page=1000', {
    method: 'GET',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY
    },
    muteHttpExceptions: true
  })
  const listData = JSON.parse(listRes.getContentText())
  const users = listData.users || []
  const authUser = users.find(function(u) {
    return u.email && u.email.toLowerCase() === email.toLowerCase()
  })
  if (!authUser) return error('Không tìm thấy tài khoản auth với email: ' + email)

  const res = UrlFetchApp.fetch(SUPABASE_URL + '/auth/v1/admin/users/' + authUser.id, {
    method: 'PUT',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify({ password: newPassword }),
    muteHttpExceptions: true
  })

  if (res.getResponseCode() >= 400) return error('Đặt lại mật khẩu thất bại: ' + res.getContentText())
  return ok('Đã đặt lại mật khẩu')
}

// -----------------------------------------------
// Supabase REST helper
// -----------------------------------------------
function supabaseFetch(path) {
  const url = SUPABASE_URL + path
  const res = UrlFetchApp.fetch(url, {
    method: 'GET',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json'
    },
    muteHttpExceptions: true
  })
  return JSON.parse(res.getContentText())
}

// -----------------------------------------------
// Response helpers
// -----------------------------------------------
function ok(msg) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'ok', message: msg }))
    .setMimeType(ContentService.MimeType.JSON)
}

function error(msg) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'error', message: msg }))
    .setMimeType(ContentService.MimeType.JSON)
}
