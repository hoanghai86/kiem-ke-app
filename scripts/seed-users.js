// scripts/seed-users.js
// Chạy: node scripts/seed-users.js
// Tạo hàng loạt auth user + profile dm_user trong Supabase

const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL = 'https://jqlaokgdjxzfkqcztsfc.supabase.co'
const SERVICE_ROLE_KEY = 'THAY_BANG_SERVICE_ROLE_KEY_CUA_BAN' // Dashboard → Settings → API

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
})

const USERS = [
  { ma_user: 'KT001', ho_ten: 'Nguyễn Thị Lan',   role: 'ke_toan', email: 'lan.nguyen@company.com',   password: 'Kieuke@2024' },
  { ma_user: 'KT002', ho_ten: 'Trần Minh Châu',   role: 'ke_toan', email: 'chau.tran@company.com',    password: 'Kieuke@2024' },
  { ma_user: 'KT003', ho_ten: 'Lê Thị Hương',     role: 'ke_toan', email: 'huong.le@company.com',     password: 'Kieuke@2024' },
  { ma_user: 'KT004', ho_ten: 'Phạm Thị Thu',     role: 'ke_toan', email: 'thu.pham@company.com',     password: 'Kieuke@2024' },
  { ma_user: 'TK001', ho_ten: 'Nguyễn Văn Hùng',  role: 'thu_kho', email: 'hung.nguyen@company.com',  password: 'Kieuke@2024' },
  { ma_user: 'TK002', ho_ten: 'Trần Văn Mạnh',    role: 'thu_kho', email: 'manh.tran@company.com',    password: 'Kieuke@2024' },
  { ma_user: 'TK003', ho_ten: 'Lê Văn Đức',       role: 'thu_kho', email: 'duc.le@company.com',       password: 'Kieuke@2024' },
  { ma_user: 'TK004', ho_ten: 'Võ Thị Mai',       role: 'thu_kho', email: 'mai.vo@company.com',       password: 'Kieuke@2024' },
  { ma_user: 'TK005', ho_ten: 'Đặng Văn Tùng',    role: 'thu_kho', email: 'tung.dang@company.com',    password: 'Kieuke@2024' },
  { ma_user: 'AD001', ho_ten: 'Nguyễn Văn Admin', role: 'admin',   email: 'admin@company.com',        password: 'Kieuke@2024' },
]

async function seed() {
  console.log('Bắt đầu tạo users...\n')

  for (const u of USERS) {
    // 1. Tạo auth user
    const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
      email: u.email,
      password: u.password,
      email_confirm: true
    })

    if (authErr) {
      console.error(`❌ ${u.ma_user} (${u.email}) — auth lỗi: ${authErr.message}`)
      continue
    }

    const uid = authData.user.id

    // 2. Upsert profile vào dm_user với đúng UUID từ auth
    const { error: profileErr } = await supabase.from('dm_user').upsert({
      id: uid,
      ma_user: u.ma_user,
      ho_ten: u.ho_ten,
      role: u.role,
      email: u.email,
      active: true
    })

    if (profileErr) {
      console.error(`❌ ${u.ma_user} — dm_user lỗi: ${profileErr.message}`)
    } else {
      console.log(`✓ ${u.ma_user} | ${u.ho_ten} | ${u.role} | ${u.email}`)
    }
  }

  console.log('\nXong! Mật khẩu mặc định: Kieuke@2024')
}

seed()
