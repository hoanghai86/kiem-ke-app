import { useState, useEffect, useCallback, useRef } from 'react'
import * as XLSX from 'xlsx'
import { toSearchable } from '../lib/utils'
import { supabase } from '../lib/supabase'
import { db, updateChiTiet, deleteChiTiet, getSoSach } from '../lib/db'
import { pushOfflineQueue } from '../lib/sync'
import { fmtSL } from '../lib/utils'
import ChonVatTu from '../components/ChonVatTu'
import Highlight from '../components/Highlight'
import MiniKiemKe from '../components/MiniKiemKe'
import { searchVatTu, listVatTu, invalidateVatTuIndex } from '../lib/vatTuSearch'

const TABS = [
  { key: 'kiem_ke',       label: 'Kiểm kê' },
  { key: 'thua_thieu',    label: 'Thừa/Thiếu SS' },
  { key: 'so_sanh',       label: 'So sánh KT/TK' },
  { key: 'ton_kho',       label: 'Tồn kho SS' },
  { key: 'ngoai_so_sach', label: 'Ngoài SS' },
]

function buildExcelWorkbook(rows, cols) {
  const header = cols.map(c => c.label)
  const data = rows.map((r, i) => cols.map(c => (c.excel ? c.excel(r, i) : c.get(r, i)) ?? ''))
  const ws = XLSX.utils.aoa_to_sheet([header, ...data])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
  return wb
}

function exportExcel(rows, cols, filename) {
  const wb = buildExcelWorkbook(rows, cols)
  XLSX.writeFile(wb, filename)
}

async function shareExcel(rows, cols, filename) {
  const wb = buildExcelWorkbook(rows, cols)
  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
  const file = new File([wbout], filename, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  if (!navigator.share) { alert('Trình duyệt không hỗ trợ chia sẻ file'); return }
  try {
    await navigator.share({ files: [file], title: filename })
  } catch (err) {
    if (err.name !== 'AbortError') alert('Không chia sẻ được: ' + err.message)
  }
}

const PAGE_SIZE = 50
const VAT_TU_BROWSE_LIMIT = 50 // chỉ áp dụng khi chưa gõ tìm (duyệt mặc định); có từ khóa thì hiện hết
const MIN_VAT_TU_QUERY_LEN = 3 // gõ dưới 3 ký tự thì khớp quá rộng (hàng nghìn dòng) — chưa tìm

const getToday = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

// Mặc định "Loại dữ liệu" theo role đăng nhập — thủ kho thấy số của mình trước, kế toán/admin
// thấy số kế toán trước.
const getInitFilters = (role) => ({
  tuNgay: getToday(), denNgay: getToday(),
  loaiDuLieu: role === 'thu_kho' ? 'thu_kho' : 'ke_toan',
  kho: [], phien: [], keToan: [], thuKho: [], vatTu: [],
})

export default function BaoCao({ currentUser }) {
  const [tab, setTab]             = useState('kiem_ke')
  const [f, setF]                 = useState(() => getInitFilters(currentUser.role))
  // Bản nháp bộ lọc — chỉnh trong panel "Lọc" không kích hoạt tải dữ liệu ngay (tránh chớp nháy
  // liên tục từng điều kiện một); chỉ áp dụng vào `f` (driver tải dữ liệu) khi bấm "Tìm kiếm".
  const [draft, setDraft]         = useState(() => getInitFilters(currentUser.role))
  const [khoList, setKhoList]     = useState([])
  const [phienList, setPhienList] = useState([])
  const [userMap, setUserMap]     = useState({})
  const [dvtMap, setDvtMap]       = useState({})
  const [danhMucDvt, setDanhMucDvt] = useState([])
  const [vtDvtChinhMap, setVtDvtChinhMap] = useState({})
  const [vtNameMap, setVtNameMap]   = useState({})
  const [tonKhoRows, setTonKhoRows] = useState([])
  const [loadingTonKho, setLoadingTonKho] = useState(false)
  const [data, setData]           = useState([])
  const [loading, setLoading]     = useState(false)
  const [showFilters, setShowFilters] = useState(false)

  // Sub-screen edit state
  const [detailItem, setDetailItem] = useState(null)
  const [editMode, setEditMode]     = useState(false)
  const [kiemKeSelected, setKiemKeSelected] = useState(null) // accordion row trong tab kiemke
  const [confirmXoaKiemKe, setConfirmXoaKiemKe] = useState(false)
  const [keyboardOffset, setKeyboardOffset] = useState(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () => setKeyboardOffset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop))
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update) }
  }, [])
  const [form, setForm]             = useState({})
  const [saving, setSaving]         = useState(false)

  // Thừa/Thiếu SS — click dòng → inline actions → MiniKiemKe
  const [thuaThieuDetail, setThuaThieuDetail] = useState(null)
  const [showMiniKiemKe, setShowMiniKiemKe]   = useState(false)
  const [miniKiemKePhienId, setMiniKiemKePhienId] = useState(null)
  const [showPhienPicker, setShowPhienPicker]     = useState(false)
  const [phienPickerCandidates, setPhienPickerCandidates] = useState([])
  const [rememberedPhienId, setRememberedPhienId] = useState(null) // nhớ phiên đã chọn trong session
  const [confirmXoaHet, setConfirmXoaHet]     = useState(false)
  const [xoaHetSaving, setXoaHetSaving]       = useState(false)
  const [showChiTietSS, setShowChiTietSS]     = useState(false)
  const [chiTietPage, setChiTietPage]         = useState(1)
  const [warningMsg, setWarningMsg]           = useState(null)
  const [xoaHetPhienId, setXoaHetPhienId]         = useState(null)
  const [showXoaHetPicker, setShowXoaHetPicker]   = useState(false)
  const [xoaHetPickerCandidates, setXoaHetPickerCandidates] = useState([])

  // Ngoài sổ sách
  const [nssItems, setNssItems]         = useState([])
  const [loadingNSS, setLoadingNSS]     = useState(false)
  const [reconcileItem, setReconcileItem] = useState(null)
  const [toastMsg, setToastMsg]         = useState(null)

  // Filter fullscreen modal
  const [filterModal, setFilterModal] = useState(null) // null | 'phien' | 'kho' | 'keToan' | 'thuKho'
  const [filterModalQ, setFilterModalQ] = useState('')
  const [filterModalSel, setFilterModalSel] = useState([])
  const filterModalRef = useRef(null)

  // Edit kho fullscreen modal
  const [openEditKhoModal, setOpenEditKhoModal] = useState(false)
  const [editKhoQ, setEditKhoQ] = useState('')
  const [page, setPage] = useState(1)

  // Edit ĐVT fullscreen modal — đồng bộ kiểu chọn với màn hình nhập SL kiểm kê
  const [openEditDvtModal, setOpenEditDvtModal] = useState(false)
  const [editDvtQ, setEditDvtQ] = useState('')

  // Edit phiên fullscreen modal — chỉ cho chọn trong các phiên user thuộc về
  const [openEditPhienModal, setOpenEditPhienModal] = useState(false)
  const [editPhienQ, setEditPhienQ] = useState('')

  // Vật tư filter fullscreen modal
  const [openVatTuModal, setOpenVatTuModal] = useState(false)
  const [vatTuModalQ, setVatTuModalQ]       = useState('')
  const [vatTuModalSel, setVatTuModalSel]   = useState([])
  const [vatTuResults, setVatTuResults]     = useState([])
  const [vatTuSearching, setVatTuSearching] = useState(false)
  const vatTuModalRef = useRef(null)
  const loadIdRef     = useRef(0)

  const updDraft = (key, val) => setDraft(prev => ({ ...prev, [key]: val }))

  const colKiemKe = [
    { label: 'Stt',        get: (r, i) => i + 1 },
    { label: 'Mã VT',      get: r => r.ma_vt },
    { label: 'Tên VT',     get: r => r.ten_vt },
    { label: 'SL thực tế', get: r => fmtSL(r.so_luong_thuc_te), excel: r => r.so_luong_thuc_te ?? '' },
    { label: 'ĐVT phụ',    get: r => r.ma_dvt_kiem || '' },
    { label: '× Hệ số',    get: r => fmtSL(r.he_so_quy_doi ?? 1), excel: r => r.he_so_quy_doi ?? 1 },
    { label: 'SL quy đổi', get: r => r.so_luong_quy_doi != null ? fmtSL(r.so_luong_quy_doi) : '', excel: r => r.so_luong_quy_doi ?? '' },
    { label: 'ĐVT chính',  get: r => dvtMap[vtDvtChinhMap[r.ma_vt]] || vtDvtChinhMap[r.ma_vt] || '' },
    { label: 'Ghi chú',    get: r => r.ghi_chu || '' },
    { label: 'Kho',        get: r => r.dm_kho?.ten_kho || r.ma_kho || r.phien_kiem_ke?.dm_kho?.ten_kho || r.phien_kiem_ke?.ma_kho || '' },
    { label: 'Tên TK',     get: r => r._nguoi_nhap || '' },
    { label: 'Phiên',      get: r => r.phien_id ? '#' + r.phien_id.slice(-4).toUpperCase() : '' },
    { label: 'Thời gian',  get: r => r.created_at ? new Date(r.created_at).toLocaleString('vi-VN') : '' },
  ]

  const colTonKho = [
    { label: 'Stt',        get: (r, i) => i + 1 },
    { label: 'Mã VT',      get: r => r.ma_vt },
    { label: 'Tên VT',     get: r => vtNameMap[r.ma_vt] || '' },
    { label: 'ĐVT chính',  get: r => dvtMap[vtDvtChinhMap[r.ma_vt]] || vtDvtChinhMap[r.ma_vt] || '' },
    { label: 'SL sổ sách', get: r => r.so_luong_so_sach != null ? fmtSL(r.so_luong_so_sach) : '', excel: r => r.so_luong_so_sach ?? '' },
    { label: 'Kho',        get: r => khoList.find(k => k.ma_kho === r.ma_kho)?.ten_kho || r.ma_kho || '' },
  ]

  const colThuaThieu = [
    { label: 'Stt',              get: (r, i) => i + 1 },
    { label: 'Mã VT',            get: r => r.ma_vt },
    { label: 'Tên vật tư',       get: r => r.ten_vt },
    { label: 'ĐVT chính',        get: r => dvtMap[vtDvtChinhMap[r.ma_vt]] || vtDvtChinhMap[r.ma_vt] || '' },
    { label: 'SL quy đổi',       get: r => r.so_luong_quy_doi != null ? fmtSL(r.so_luong_quy_doi) : '', excel: r => r.so_luong_quy_doi ?? '' },
    { label: 'SL sổ sách',       get: r => r.so_luong_so_sach != null ? fmtSL(r.so_luong_so_sach) : '', excel: r => r.so_luong_so_sach ?? '' },
    { label: 'Lệch KT-SS/TK-SS', get: r => r.chenh_lech != null ? fmtSL(r.chenh_lech) : '', excel: r => r.chenh_lech ?? '' },
    { label: 'Kho',              get: r => khoList.find(k => k.ma_kho === r.ma_kho)?.ten_kho || r.ma_kho || '' },
    { label: 'Phiên',            get: r => [...(r.phienIds || [])].map(id => '#' + id.slice(-4).toUpperCase()).join(', ') },
  ]

  useEffect(() => {
    // vtNameMap luôn lấy từ IndexedDB (đã sync đầy đủ qua fetchAllVatTu có phân trang)
    db.dm_vat_tu.toArray().then(vts => {
      const mapDvt = {}, mapName = {}
      vts.forEach(v => {
        if (v.ma_dvt_chinh) mapDvt[v.ma_vt] = v.ma_dvt_chinh
        mapName[v.ma_vt] = v.ten_vt || ''
      })
      setVtDvtChinhMap(mapDvt)
      setVtNameMap(mapName)
    })

    if (navigator.onLine) {
      supabase.from('dm_kho').select('ma_kho,ten_kho').eq('active', true).order('ma_kho')
        .then(({ data }) => setKhoList(data || []))
      supabase.from('dm_user').select('id,ma_user,ho_ten,role').order('ho_ten')
        .then(({ data }) => {
          const map = {}
          ;(data || []).forEach(u => { map[u.id] = u })
          setUserMap(map)
        })
      supabase.from('dm_dvt').select('ma_dvt,ten_dvt')
        .then(({ data }) => {
          const map = {}
          ;(data || []).forEach(d => { map[d.ma_dvt] = d.ten_dvt })
          setDvtMap(map)
          setDanhMucDvt(data || [])
        })
    } else {
      Promise.all([
        db.dm_kho.toArray(),
        db.dm_user.toArray(),
        db.dm_dvt.toArray(),
      ]).then(([khos, users, dvts]) => {
        setKhoList(khos)
        const uMap = {}
        users.forEach(u => { uMap[u.id] = u })
        setUserMap(uMap)
        const dMap = {}
        dvts.forEach(d => { dMap[d.ma_dvt] = d.ten_dvt })
        setDvtMap(dMap)
        setDanhMucDvt(dvts)
      })
    }
  }, [])

  // Danh sách phiên cho picker "Phiên kiểm kê" — KHÔNG lọc theo Từ/Đến ngày. Mã phiên kiểu
  // #9C10/#95E2 không ai nhớ nổi để gõ tìm, nên picker luôn hiện sẵn để chọn. Ngày tháng vẫn
  // là điều kiện lọc kết quả độc lập — chọn phiên ngoài khoảng ngày thì tìm kiếm ra rỗng,
  // không cần "đồng bộ" 2 điều kiện với nhau.
  useEffect(() => {
    if (navigator.onLine) {
      supabase.from('phien_kiem_ke')
        .select('id,ma_kho,ke_toan_id,thu_kho_id,ngay_kiem')
        .order('ngay_kiem', { ascending: false })
        .limit(200)
        .then(({ data }) => setPhienList(data || []))
    } else {
      db.phien.orderBy('ngay_kiem').reverse().toArray().then(rows => setPhienList(rows))
    }
  }, [])

  const loadData = useCallback(async () => {
    const id = ++loadIdRef.current
    setLoading(true)
    setData([])
    try {
      if (!navigator.onLine) {
        const localKhoMap = Object.fromEntries(khoList.map(k => [k.ma_kho, k.ten_kho]))
        const phienById = {}
        phienList.forEach(p => { phienById[p.id] = p })

        // Ngày tháng, phiên, kế toán, thủ kho đều là điều kiện AND độc lập — chọn phiên ngoài
        // khoảng ngày (hoặc kế toán/thủ kho không khớp phiên đã chọn) thì ra rỗng, không có
        // chuyện điều kiện này tự "đồng bộ" lại điều kiện kia.
        let rows = await db.chitiet.filter(r => {
          const phien = phienById[r.phien_id]
          if (!phien) return false
          const d = (phien.ngay_kiem || '').slice(0, 10)
          if (d < f.tuNgay || d > f.denNgay) return false
          if (f.phien.length > 0 && !f.phien.includes(r.phien_id)) return false
          if (f.keToan.length > 0 && !f.keToan.includes(phien.ke_toan_id)) return false
          if (f.thuKho.length > 0 && !f.thuKho.includes(phien.thu_kho_id)) return false
          if (f.kho.length > 0 && !f.kho.includes(r.ma_kho)) return false
          return true
        }).toArray()
        rows.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))

        if (id !== loadIdRef.current) return
        setData(rows.map(r => {
          const phien = phienById[r.phien_id] || {}
          return {
            ...r,
            dm_kho: { ten_kho: localKhoMap[r.ma_kho] || r.ma_kho || '' },
            phien_kiem_ke: {
              ...phien,
              dm_kho: { ten_kho: localKhoMap[phien.ma_kho] || phien.ma_kho || '' }
            },
            _ke_toan:    userMap[phien.ke_toan_id]?.ho_ten || '',
            _thu_kho:    userMap[phien.thu_kho_id]?.ho_ten || '',
            _nguoi_nhap: userMap[r.nguoi_nhap_id]?.ho_ten || '',
          }
        }))
        return
      }

      // Ngày tháng, phiên, kế toán, thủ kho đều là điều kiện AND độc lập trên query — chọn
      // phiên ngoài khoảng ngày (hoặc kế toán/thủ kho không khớp phiên đã chọn) thì ra rỗng,
      // không cần dò qua phienList ở client để "đồng bộ" các điều kiện với nhau.
      let q = supabase
        .from('kiem_ke_chitiet')
        .select('id,phien_id,ma_vt,ten_vt,ma_kho,dm_kho(ten_kho),ma_dvt_kiem,he_so_quy_doi,so_luong_thuc_te,so_luong_quy_doi,so_luong_so_sach,chenh_lech,ghi_chu,created_at,nguoi_nhap_id,phien_kiem_ke!inner(id,ma_kho,ngay_kiem,ke_toan_id,thu_kho_id,xac_nhan_ke_toan,xac_nhan_thu_kho,dm_kho(ten_kho))')
        .order('created_at', { ascending: false })
        .gte('phien_kiem_ke.ngay_kiem', f.tuNgay)
        .lte('phien_kiem_ke.ngay_kiem', f.denNgay)

      if (f.phien.length > 0) q = q.in('phien_id', f.phien)
      if (f.keToan.length > 0) q = q.in('phien_kiem_ke.ke_toan_id', f.keToan)
      if (f.thuKho.length > 0) q = q.in('phien_kiem_ke.thu_kho_id', f.thuKho)
      if (f.kho.length > 0) q = q.in('ma_kho', f.kho)

      const { data: rows } = await q
      if (id !== loadIdRef.current) return
      setData((rows || []).map(r => ({
        ...r,
        _ke_toan:    userMap[r.phien_kiem_ke?.ke_toan_id]?.ho_ten || '',
        _thu_kho:    userMap[r.phien_kiem_ke?.thu_kho_id]?.ho_ten || '',
        _nguoi_nhap: userMap[r.nguoi_nhap_id]?.ho_ten || '',
      })))
    } finally {
      if (id === loadIdRef.current) setLoading(false)
    }
  }, [tab, f.tuNgay, f.denNgay, f.kho, f.phien, f.keToan, f.thuKho, userMap, phienList, khoList])

  useEffect(() => { loadData() }, [loadData])

  const loadTonKho = useCallback(async () => {
    setLoadingTonKho(true)
    try {
      if (!navigator.onLine) {
        let rows = await db.ton_kho.toArray()
        if (f.kho.length > 0) rows = rows.filter(r => f.kho.includes(r.ma_kho))
        setTonKhoRows(rows)
        return
      }
      let q = supabase.from('ton_kho').select('ma_vt,ma_kho,so_luong_so_sach').order('ma_kho').order('ma_vt')
      if (f.kho.length > 0) q = q.in('ma_kho', f.kho)
      const { data: rows } = await q
      setTonKhoRows(rows || [])
    } finally {
      setLoadingTonKho(false)
    }
  }, [f.kho])

  useEffect(() => { if (tab === 'ton_kho' || tab === 'thua_thieu') loadTonKho() }, [tab, loadTonKho])

  const loadNSS = useCallback(async () => {
    setLoadingNSS(true)
    try {
      let rows = await db.chitiet.filter(r => {
        if (!r.ngoai_so_sach) return false
        if (f.phien.length > 0 && !f.phien.includes(r.phien_id)) return false
        if (f.kho.length > 0 && !f.kho.includes(r.ma_kho)) return false
        if (f.vatTu.length > 0 && !f.vatTu.includes(r.ma_vt)) return false
        if (r.created_at) {
          const d = r.created_at.slice(0, 10)
          if (d < f.tuNgay || d > f.denNgay) return false
        }
        return true
      }).toArray()
      if (currentUser.role !== 'admin') {
        const myPhien = await db.phien.filter(p =>
          p.ke_toan_id === currentUser.id || p.thu_kho_id === currentUser.id
        ).toArray()
        const myPhienIds = new Set(myPhien.map(p => p.id))
        rows = rows.filter(r => myPhienIds.has(r.phien_id))
      }
      const phienIds = [...new Set(rows.map(r => r.phien_id))]
      const phienMap = {}
      for (const pid of phienIds) {
        const p = await db.phien.get(pid)
        if (p) phienMap[pid] = p
      }
      // Group by ma_vt — chỉ hiện 1 đại diện mỗi mã, _allIds chứa toàn bộ để reconcile hết
      const grouped = new Map()
      for (const r of rows) {
        if (!grouped.has(r.ma_vt)) grouped.set(r.ma_vt, { ...r, _phien: phienMap[r.phien_id], _allIds: [] })
        grouped.get(r.ma_vt)._allIds.push(r.id)
      }
      setNssItems([...grouped.values()])
    } finally {
      setLoadingNSS(false)
    }
  }, [currentUser, f])

  useEffect(() => { if (tab === 'ngoai_so_sach') loadNSS() }, [tab, loadNSS])
  useEffect(() => { setPage(1) }, [tab, f])

  useEffect(() => {
    if (!openVatTuModal) { setVatTuResults([]); setVatTuSearching(false); return }
    const q = vatTuModalQ.trim()
    // Từ khóa ngắn hơn 3 ký tự khớp quá rộng (hàng nghìn dòng, vd gõ "x") — không tìm, chỉ nhắc
    // gõ thêm, giống ERP. Tránh luôn việc dựng lại danh sách khổng lồ trong lúc gõ/backspace dở.
    if (q.length > 0 && q.length < MIN_VAT_TU_QUERY_LEN) {
      setVatTuResults([]); setVatTuSearching(false)
      return
    }
    let cancelled = false
    // Chỉ hiện "Đang tìm..." nếu chờ hơi lâu (debounce timer chưa bắn) — tránh việc bản thân
    // việc bật/tắt "Đang tìm..." cũng làm React tháo/dựng lại danh sách cũ ngay trên mỗi ký tự gõ.
    const searchingTimer = setTimeout(() => { if (!cancelled) setVatTuSearching(true) }, 120)
    // Debounce 1s — gõ/xóa (backspace) liên tục không tìm/render lại liên tục, chỉ chạy khi
    // người dùng đã ngừng gõ được 1 giây.
    const timer = setTimeout(() => {
      const fetchFn = q ? searchVatTu(vatTuModalQ) : listVatTu(VAT_TU_BROWSE_LIMIT)
      fetchFn.then(rows => { if (!cancelled) { setVatTuResults(rows); setVatTuSearching(false) } })
    }, 1000)
    return () => { cancelled = true; clearTimeout(timer); clearTimeout(searchingTimer) }
  }, [vatTuModalQ, openVatTuModal])

  async function doReconcile(item, vtDung) {
    const soSachMoi = item._phien?.ma_kho
      ? await getSoSach(vtDung.ma_vt, item._phien.ma_kho)
      : null
    const ids = item._allIds?.length ? item._allIds : [item.id]
    for (const id of ids) {
      await updateChiTiet(id, {
        ma_vt: vtDung.ma_vt,
        ten_vt: vtDung.ten_vt,
        so_luong_so_sach: soSachMoi ?? 0,
        ngoai_so_sach: false
      })
    }
    await db.dm_vat_tu.delete(item.ma_vt)
    invalidateVatTuIndex()
    await db.goi_y_vat_tu.delete(item.ma_vt)
    if (navigator.onLine) pushOfflineQueue()
    setReconcileItem(null)
    loadNSS()
    setToastMsg(`Đã cập nhật ${ids.length > 1 ? ids.length + ' dòng · ' : ''}${vtDung.ma_vt} · ${vtDung.ten_vt}`)
    setTimeout(() => setToastMsg(null), 3000)
  }

  const khoMap = Object.fromEntries(khoList.map(k => [k.ma_kho, k.ten_kho]))

  // loaiDuLieu filter — client-side
  const afterRole = data.filter(r => {
    const p = r.phien_kiem_ke
    if (!p) return false
    const role = userMap[r.nguoi_nhap_id]?.role
    if (!role) return true  // không xác định được → không lọc
    return f.loaiDuLieu === 'ke_toan'
      ? (role === 'ke_toan' || role === 'admin')
      : role === 'thu_kho'
  })

  const displayData = f.vatTu.length > 0
    ? afterRole.filter(r => f.vatTu.includes(r.ma_vt))
    : afterRole

  // Tab Thừa/Thiếu SS: FULL OUTER JOIN giữa ton_kho (sổ sách) và kiem_ke_chitiet (đã kiểm).
  // • Trong SS, chưa kiểm  → SS=X, Kiểm=0, Lệch=-X  (Thiếu)
  // • Đã kiểm, không có SS → SS=0, Kiểm=Y, Lệch=+Y  (Thừa — vd: hàng có trong DM nhưng ngoài tồn kho kho này)
  // • Có cả hai            → so sánh bình thường
  const displayDataFinal = tab !== 'thua_thieu' ? displayData : (() => {
    // Build counted map từ kiem_ke_chitiet (đã qua filter ngày/kho/phiên)
    const countedMap = new Map()
    for (const r of displayData) {
      const key = `${r.ma_vt}__${r.ma_kho ?? ''}`
      if (!countedMap.has(key)) countedMap.set(key, { ten_vt: r.ten_vt, so_luong_quy_doi: 0, phienIds: new Set() })
      const g = countedMap.get(key)
      g.so_luong_quy_doi += r.so_luong_quy_doi ?? 0
      if (r.phien_id) g.phienIds.add(r.phien_id)
    }

    // Build ton_kho map (đã filter kho ở loadTonKho, thêm filter vatTu nếu có)
    const baseTonKho = f.vatTu.length > 0
      ? tonKhoRows.filter(r => f.vatTu.includes(r.ma_vt))
      : tonKhoRows
    const tonKhoMap = new Map(baseTonKho.map(tk => [`${tk.ma_vt}__${tk.ma_kho ?? ''}`, tk]))

    // FULL OUTER JOIN: union tất cả key từ cả hai nguồn, áp thêm filter vatTu cho counted
    const allKeys = new Set([
      ...tonKhoMap.keys(),
      ...(f.vatTu.length > 0
        ? [...countedMap.keys()].filter(k => f.vatTu.includes(k.split('__')[0]))
        : countedMap.keys()),
    ])

    return [...allKeys].map(key => {
      const ma_vt  = key.split('__')[0]
      const ma_kho = key.split('__')[1] || null
      const tk      = tonKhoMap.get(key)
      const counted = countedMap.get(key)
      const sl_qd   = counted?.so_luong_quy_doi ?? 0
      const ss      = tk?.so_luong_so_sach ?? 0
      return {
        ma_vt,
        ten_vt:           vtNameMap[ma_vt] || counted?.ten_vt || ma_vt,
        ma_kho,
        so_luong_quy_doi: sl_qd,
        so_luong_so_sach: tk?.so_luong_so_sach ?? null,
        chenh_lech:       sl_qd - ss,
        phienIds:         counted?.phienIds ?? new Set(),
      }
    })
  })()

  const displayTonKho = f.vatTu.length > 0
    ? tonKhoRows.filter(r => f.vatTu.includes(r.ma_vt))
    : tonKhoRows

  // So sánh KT vs TK — nhóm theo phiên (1 kế toán có thể đối chiếu nhiều thủ kho/phiên khác
  // nhau cùng lúc, gộp chung theo mã VT sẽ lẫn lộn giữa các phiên) — mỗi dòng ứng với 1 phiên.
  const soSanhRows = (() => {
    if (tab !== 'so_sanh') return []
    const map = {}
    data.forEach(r => {
      const p = r.phien_kiem_ke
      if (!p) return
      if (f.vatTu.length > 0 && !f.vatTu.includes(r.ma_vt)) return
      const ma_kho = r.ma_kho || p.ma_kho || null
      const key = `${r.phien_id}_${r.ma_vt}_${ma_kho}`
      if (!map[key]) {
        map[key] = {
          ma_vt: r.ma_vt, ten_vt: r.ten_vt, ma_dvt: r.ma_dvt_kiem,
          ma_kho,
          kho: r.dm_kho?.ten_kho || r.ma_kho || p.dm_kho?.ten_kho || p.ma_kho,
          phien_id: r.phien_id,
          ke_toan_id: p.ke_toan_id, thu_kho_id: p.thu_kho_id,
          sl_kt: null, sl_tk: null,
          so_luong_so_sach: tonKhoRows.find(t => t.ma_vt === r.ma_vt && (t.ma_kho ?? '') === (ma_kho ?? ''))?.so_luong_so_sach ?? null,
          phienIds: new Set([r.phien_id]),
          _tab: 'so_sanh',
          _key: `${r.ma_vt}__${ma_kho}__${r.phien_id}`,
        }
      }
      const sl = parseFloat(r.so_luong_quy_doi) || 0
      const role = userMap[r.nguoi_nhap_id]?.role
      if (role === 'ke_toan' || role === 'admin') map[key].sl_kt = (map[key].sl_kt ?? 0) + sl
      if (role === 'thu_kho') map[key].sl_tk = (map[key].sl_tk ?? 0) + sl
    })
    return Object.values(map)
      .sort((a, b) => {
        const pa = phienList.find(x => x.id === a.phien_id)
        const pb = phienList.find(x => x.id === b.phien_id)
        const da = pa?.ngay_kiem || '', db = pb?.ngay_kiem || ''
        if (da !== db) return db.localeCompare(da)
        if (a.phien_id !== b.phien_id) return (a.phien_id || '').localeCompare(b.phien_id || '')
        return a.ma_vt.localeCompare(b.ma_vt)
      })
  })()

  // ── Sub-screen: Xem / Sửa / Xóa ──────────────────────────────────
  function openDetail(row, edit = false) {
    setDetailItem(row)
    setEditMode(edit)
    setForm({
      ma_vt: row.ma_vt || '',
      ten_vt: row.ten_vt || '',
      so_luong_thuc_te: row.so_luong_thuc_te,
      ma_dvt_kiem: row.ma_dvt_kiem || '',
      he_so_quy_doi: row.he_so_quy_doi ?? 1,
      ghi_chu: row.ghi_chu || '',
      ma_kho: row.ma_kho || '',
      phien_id: row.phien_id || '',
    })
  }

  async function handleDeleteKiemKe() {
    if (!kiemKeSelected) return
    // Chỉ được xóa dòng do chính mình nhập — dù cùng phiên, không được đụng vào dòng của
    // người khác (VD kế toán xóa dòng của thủ kho hoặc ngược lại).
    if (currentUser.role !== 'admin' && kiemKeSelected.nguoi_nhap_id !== currentUser.id) {
      setConfirmXoaKiemKe(false)
      setWarningMsg('Bạn chỉ có thể xóa dòng do chính mình nhập.')
      return
    }
    setSaving(true)
    await deleteChiTiet(kiemKeSelected.id)
    if (navigator.onLine) pushOfflineQueue()
    setData(prev => prev.filter(r => r.id !== kiemKeSelected.id))
    setSaving(false)
    setConfirmXoaKiemKe(false)
    setKiemKeSelected(null)
  }

  function closeDetail() {
    setDetailItem(null)
    setEditMode(false)
  }

  async function handleSave() {
    if (!detailItem) return
    // Đổi phiên chỉ được chọn trong các phiên user thuộc về (xem picker), nhưng chặn thêm lần
    // nữa ở đây phòng khi state bị can thiệp — tránh Supabase RLS chặn update (403) khi lưu.
    if (form.phien_id && form.phien_id !== detailItem.phien_id) {
      const p = phienList.find(p => p.id === form.phien_id)
      const owned = p && (p.ke_toan_id === currentUser.id || p.thu_kho_id === currentUser.id)
      if (!owned) {
        setWarningMsg('Bạn không phải kế toán/thủ kho của phiên vừa chọn nên không thể chuyển sang phiên đó.')
        return
      }
    }
    setSaving(true)
    const maVtChanged = form.ma_vt && form.ma_vt !== detailItem.ma_vt
    const updated = await updateChiTiet(detailItem.id, {
      ma_vt: form.ma_vt || detailItem.ma_vt,
      ten_vt: form.ten_vt || detailItem.ten_vt,
      so_luong_thuc_te: parseFloat(form.so_luong_thuc_te),
      ma_dvt_kiem: form.ma_dvt_kiem,
      he_so_quy_doi: parseFloat(form.he_so_quy_doi) || 1,
      ghi_chu: form.ghi_chu,
      ma_kho: form.ma_kho || null,
      phien_id: form.phien_id || detailItem.phien_id,
      ...(maVtChanged ? { so_luong_so_sach: await getSoSach(form.ma_vt, form.ma_kho || detailItem.ma_kho) } : {}),
    })
    if (navigator.onLine) pushOfflineQueue()
    // Cập nhật lại dòng trong state mà không cần re-fetch
    if (updated) {
      setData(prev => prev.map(r => r.id === detailItem.id
        ? { ...r, ...updated, _nguoi_nhap: r._nguoi_nhap }
        : r
      ))
    }
    setSaving(false)
    closeDetail()
  }

  async function handleDelete() {
    if (!detailItem) return
    setSaving(true)
    await deleteChiTiet(detailItem.id)
    if (navigator.onLine) pushOfflineQueue()
    setData(prev => prev.filter(r => r.id !== detailItem.id))
    setSaving(false)
    closeDetail()
  }

  const formQuyDoi = (() => {
    if (!detailItem) return '—'
    const sl = parseFloat(form.so_luong_thuc_te)
    const hs = parseFloat(form.he_so_quy_doi) || 1
    if (isNaN(sl)) return '—'
    const maChinh = vtDvtChinhMap[detailItem.ma_vt]
    const tenChinh = maChinh ? (dvtMap[maChinh] || maChinh) : (dvtMap[form.ma_dvt_kiem] || form.ma_dvt_kiem)
    return `${fmtSL(sl * hs)} ${tenChinh}`
  })()

  function openMiniKiemKe(phienIds) {
    const ids = [...(phienIds || [])]
    const ownPhienIds = phienList
      .filter(p => p.ke_toan_id === currentUser.id || p.thu_kho_id === currentUser.id)
      .map(p => p.id)

    // Mặt hàng đã có phiên cụ thể (ids không rỗng) → CHỈ được thao tác nếu thuộc 1 trong
    // các phiên đó. Không fallback sang phiên khác của user — Supabase RLS sẽ chặn insert
    // (403) nếu cố ghi vào phiên không thuộc mình, nên phải chặn ngay từ đầu, báo rõ lý do.
    if (ids.length > 0) {
      const mine = ids.filter(id => ownPhienIds.includes(id))
      if (mine.length === 0) {
        setWarningMsg('Bạn không phải kế toán/thủ kho của phiên chứa mặt hàng này nên không thể kiểm kê nhanh tại đây. Vui lòng vào đúng phiên của bạn.')
        return
      }
      if (mine.length === 1) {
        setMiniKiemKePhienId(mine[0])
        setShowMiniKiemKe(true)
      } else if (rememberedPhienId && mine.includes(rememberedPhienId)) {
        setMiniKiemKePhienId(rememberedPhienId)
        setShowMiniKiemKe(true)
      } else {
        setPhienPickerCandidates(mine)
        setShowPhienPicker(true)
      }
      return
    }

    // Mặt hàng chưa được kiểm (ids rỗng) → cho chọn trong các phiên của chính user
    if (ownPhienIds.length === 0) {
      setWarningMsg('Chưa có phiên kiểm kê nào. Vui lòng tạo phiên trước.')
    } else if (ownPhienIds.length === 1) {
      setMiniKiemKePhienId(ownPhienIds[0])
      setShowMiniKiemKe(true)
    } else if (rememberedPhienId && ownPhienIds.includes(rememberedPhienId)) {
      setMiniKiemKePhienId(rememberedPhienId)
      setShowMiniKiemKe(true)
    } else {
      setPhienPickerCandidates(ownPhienIds)
      setShowPhienPicker(true)
    }
  }

  // Bấm "Xóa hết nhập lại" trên 1 dòng — nếu mặt hàng nằm ở nhiều phiên (thuộc user) thì hỏi
  // chọn đúng phiên trước khi xóa; chỉ 1 phiên thì xóa thẳng, không cần hỏi.
  function startXoaHet(row) {
    const ids = [...(row.phienIds || [])]
    const ownIds = ids.filter(id => {
      const p = phienList.find(p => p.id === id)
      return p && (p.ke_toan_id === currentUser.id || p.thu_kho_id === currentUser.id)
    })
    if (ownIds.length === 0) {
      setWarningMsg('Bạn không phải kế toán/thủ kho của phiên chứa mặt hàng này nên không thể xóa tại đây.')
    } else if (ownIds.length === 1) {
      setXoaHetPhienId(ownIds[0])
      setConfirmXoaHet(true)
    } else {
      setXoaHetPickerCandidates(ownIds)
      setShowXoaHetPicker(true)
    }
  }

  async function handleXoaHet() {
    if (!thuaThieuDetail || !xoaHetPhienId) return
    const { ma_vt, ma_kho } = thuaThieuDetail

    setXoaHetSaving(true)
    // Chỉ xóa dòng do CHÍNH user hiện tại nhập — cùng phiên nhưng khác người nhập (VD kế toán
    // với thủ kho) thì không được đụng vào số liệu của nhau, dù cả hai đều thuộc phiên này.
    const rows = await db.chitiet
      .where('phien_id').equals(xoaHetPhienId)
      .filter(r => r.ma_vt === ma_vt && r.ma_kho === ma_kho && r.nguoi_nhap_id === currentUser.id)
      .toArray()
    if (navigator.onLine) {
      await supabase.from('kiem_ke_chitiet')
        .delete()
        .eq('ma_vt', ma_vt)
        .eq('ma_kho', ma_kho)
        .eq('phien_id', xoaHetPhienId)
        .eq('nguoi_nhap_id', currentUser.id)
      for (const r of rows) await db.chitiet.delete(r.id)
    } else {
      for (const r of rows) await deleteChiTiet(r.id)
    }
    setXoaHetSaving(false)
    setConfirmXoaHet(false)
    openMiniKiemKe(new Set([xoaHetPhienId]))
    setXoaHetPhienId(null)
    loadData()
  }

  // ── Sub-screen render ────────────────────────────────────────────
  if (detailItem) {
    const p = detailItem.phien_kiem_ke
    const isLocked = p?.xac_nhan_ke_toan || p?.xac_nhan_thu_kho
    const canEdit = !isLocked && (currentUser.role === 'admin' || detailItem.nguoi_nhap_id === currentUser.id)
    const phienInfoFor = id => {
      const ph = phienList.find(x => x.id === id)
      const ma = '#' + id.slice(-4).toUpperCase()
      if (!ph) return { label: ma, kt: '', tk: '' }
      return {
        label: `${ph.ngay_kiem.split('-').reverse().join('/')} · ${ma}`,
        kt: userMap[ph.ke_toan_id]?.ho_ten || '',
        tk: userMap[ph.thu_kho_id]?.ho_ten || '',
      }
    }
    return (
      <div className="screen">
        <div className="topbar">
          <div className="topbar-title">
            {editMode ? (form.ma_vt ? `${form.ma_vt} · ${form.ten_vt}` : '-- Chọn vật tư --') : `${detailItem.ma_vt} · ${detailItem.ten_vt}`}
          </div>
          <div className="topbar-sub">
            {editMode ? 'Chỉnh sửa' : 'Chi tiết'} · {detailItem.dm_kho?.ten_kho || detailItem.ma_kho || p?.dm_kho?.ten_kho || p?.ma_kho || ''}
          </div>
        </div>
        <div className="content" style={{ paddingBottom: 120 }}>
          {isLocked && (
            <div style={{ background: '#FEF3C7', color: '#92400E', borderRadius: 8, padding: '8px 12px', marginBottom: 12, fontSize: 13 }}>
              🔒 Phiên đã có xác nhận — không thể sửa/xóa
            </div>
          )}

          {editMode && (
            <ChonVatTu
              value={form.ma_vt ? { ma_vt: form.ma_vt, ten_vt: form.ten_vt } : null}
              onSelect={item => setForm(f => item
                ? { ...f, ma_vt: item.ma_vt, ten_vt: item.ten_vt, ma_dvt_kiem: item.ma_dvt_kiem || f.ma_dvt_kiem }
                : { ...f, ma_vt: '', ten_vt: '' }
              )}
            />
          )}

          <div className="row-2col">
            <div className="field-group">
              <label className="field-label">Số lượng thực tế</label>
              {editMode
                ? <input type="number" className="input-field input-large"
                    value={form.so_luong_thuc_te}
                    onChange={e => setForm(f => ({ ...f, so_luong_thuc_te: e.target.value }))}
                    min="0" step="any" />
                : <div className="input-readonly input-large">{fmtSL(detailItem.so_luong_thuc_te)}</div>
              }
            </div>
            <div className="field-group">
              <label className="field-label">ĐVT</label>
              {editMode
                ? <div className="input-select" onClick={() => { setEditDvtQ(''); setOpenEditDvtModal(true) }}
                    style={{ cursor: 'pointer', color: form.ma_dvt_kiem ? 'var(--text)' : 'var(--text-muted)' }}>
                    {form.ma_dvt_kiem ? (dvtMap[form.ma_dvt_kiem] || form.ma_dvt_kiem) : '-- Chọn --'}
                  </div>
                : <div className="input-readonly">{dvtMap[detailItem.ma_dvt_kiem] || detailItem.ma_dvt_kiem || '—'}</div>
              }
            </div>
          </div>

          <div className="row-2col">
            <div className="field-group">
              <label className="field-label">Hệ số</label>
              {editMode
                ? <input type="number" className="input-field"
                    value={form.he_so_quy_doi}
                    onChange={e => setForm(f => ({ ...f, he_so_quy_doi: e.target.value }))}
                    min="0" step="any" />
                : <div className="input-readonly">{fmtSL(detailItem.he_so_quy_doi ?? 1)}</div>
              }
            </div>
            <div className="field-group">
              <label className="field-label">Quy đổi</label>
              <div className="input-readonly">
                {editMode ? formQuyDoi : (() => {
                  const maChinh = vtDvtChinhMap[detailItem.ma_vt]
                  const tenChinh = maChinh ? (dvtMap[maChinh] || maChinh) : ''
                  return `${fmtSL(detailItem.so_luong_quy_doi ?? detailItem.so_luong_thuc_te)} ${tenChinh}`
                })()}
              </div>
            </div>
          </div>

          <div className="row-2col">
            <div className="field-group" style={{ minWidth: 0 }}>
              <label className="field-label">Phiên</label>
              {(() => {
                const id = editMode ? form.phien_id : detailItem.phien_id
                const info = id ? phienInfoFor(id) : null
                return (
                  <div onClick={editMode ? () => { setEditPhienQ(''); setOpenEditPhienModal(true) } : undefined}
                    style={{
                      height: 40, padding: '0 12px', border: '1.5px solid var(--border)', borderRadius: 10,
                      cursor: editMode ? 'pointer' : 'default',
                      display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden'
                    }}>
                    <span style={{
                      flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      fontSize: 14, fontWeight: 500, color: info ? 'var(--text)' : 'var(--text-muted)'
                    }}>
                      {info
                        ? [info.label, info.kt && `KT: ${info.kt}`, info.tk && `TK: ${info.tk}`].filter(Boolean).join(' · ')
                        : '-- Chọn phiên --'}
                    </span>
                    {editMode && <span style={{ fontSize: 13, color: 'var(--text-muted)', flexShrink: 0 }}>▾</span>}
                  </div>
                )
              })()}
            </div>
            <div className="field-group">
              <label className="field-label">Kho</label>
              {editMode
                ? <div className="input-select" onClick={() => { setEditKhoQ(''); setOpenEditKhoModal(true) }}
                    style={{ cursor: 'pointer', color: form.ma_kho ? 'var(--text)' : 'var(--text-muted)' }}>
                    {form.ma_kho ? (khoList.find(k => k.ma_kho === form.ma_kho)?.ten_kho || form.ma_kho) : '-- Chọn kho --'}
                  </div>
                : <div className="input-readonly">{detailItem.dm_kho?.ten_kho || detailItem.ma_kho || p?.dm_kho?.ten_kho || p?.ma_kho || '—'}</div>
              }
            </div>
          </div>

          <div className="field-group">
            <label className="field-label">Ghi chú</label>
            {editMode
              ? <textarea className="input-field" value={form.ghi_chu}
                  onChange={e => setForm(f => ({ ...f, ghi_chu: e.target.value }))}
                  placeholder="Nhập ghi chú..." rows={2} style={{ resize: 'vertical', lineHeight: 1.5 }} />
              : <div className="input-readonly">{detailItem.ghi_chu || '—'}</div>
            }
          </div>

          <div style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {[
              ['Người nhập', detailItem._nguoi_nhap || '—'],
              ['Thời gian',  detailItem.created_at ? new Date(detailItem.created_at).toLocaleString('vi-VN') : '—'],
              ['SL sổ sách', detailItem.so_luong_so_sach != null ? fmtSL(detailItem.so_luong_so_sach) : '—'],
              ['Chênh lệch', detailItem.chenh_lech != null ? fmtSL(detailItem.chenh_lech) : '—'],
            ].map(([label, val]) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}>
                <span style={{ color: 'var(--text-muted)' }}>{label}</span>
                <span style={{ fontWeight: 500 }}>{val}</span>
              </div>
            ))}
          </div>

        </div>

        {/* Footer fixed — Visual Viewport API đẩy lên trên bàn phím */}
        <div style={{
          position: 'fixed', bottom: keyboardOffset > 0 ? keyboardOffset : 56, zIndex: 55,
          left: 'max(0px, calc((100vw - 480px) / 2))',
          right: 'max(0px, calc((100vw - 480px) / 2))',
          padding: '10px 16px',
          borderTop: '1px solid var(--border)', background: '#fff',
          transition: 'bottom 0.15s ease-out'
        }}>
          {!editMode && canEdit && (
            <button onClick={handleDelete} disabled={saving} style={{
              marginBottom: 8, width: '100%',
              padding: '10px', borderRadius: 8, border: '1.5px solid #FCA5A5',
              background: '#FEF2F2', color: '#DC2626',
              fontSize: 14, fontWeight: 500, cursor: 'pointer'
            }}>
              {saving ? 'Đang xóa...' : 'Xóa dòng này'}
            </button>
          )}
          <div className={editMode || canEdit ? 'row-2col' : ''}>
            <button className="btn-secondary" onClick={closeDetail} disabled={saving}
              style={!editMode && !canEdit ? { width: '100%' } : {}}>
              {editMode ? 'Hủy' : 'Đóng'}
            </button>
            {editMode ? (
              <button className="btn-primary" onClick={handleSave} disabled={saving || !form.ma_vt}>
                {saving ? 'Đang lưu...' : 'Lưu'}
              </button>
            ) : canEdit ? (
              <button className="btn-primary" onClick={() => setEditMode(true)}>
                Sửa
              </button>
            ) : null}
          </div>
        </div>

        {openEditKhoModal && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: '#fff', display: 'flex', flexDirection: 'column', maxWidth: 480, margin: '0 auto' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                <button onClick={() => { setOpenEditKhoModal(false); setEditKhoQ('') }}
                  style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', padding: 0, color: 'var(--text)' }}>✕</button>
                <span style={{ fontWeight: 600, fontSize: 15 }}>Chọn kho</span>
              </div>
              <input type="text" className="input-field" placeholder="Tìm kho..."
                value={editKhoQ} onChange={e => setEditKhoQ(e.target.value)} autoFocus />
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {khoList
                .filter(k => !editKhoQ.trim() ||
                  toSearchable(k.ten_kho).includes(toSearchable(editKhoQ)) ||
                  toSearchable(k.ma_kho).includes(toSearchable(editKhoQ)))
                .map(k => {
                  const selected = form.ma_kho === k.ma_kho
                  return (
                    <div key={k.ma_kho}
                      onClick={() => { setForm(f => ({ ...f, ma_kho: k.ma_kho })); setOpenEditKhoModal(false); setEditKhoQ('') }}
                      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--border)', cursor: 'pointer', background: selected ? '#F0FDF4' : '#fff' }}>
                      <div style={{ width: 20, height: 20, borderRadius: '50%', border: `2px solid ${selected ? 'var(--green)' : '#D1D5DB'}`, background: selected ? 'var(--green)' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        {selected && <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#fff' }} />}
                      </div>
                      <div>
                        <div style={{ fontWeight: 500, fontSize: 14 }}>{k.ten_kho}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{k.ma_kho}</div>
                      </div>
                    </div>
                  )
                })}
            </div>
          </div>
        )}

        {openEditDvtModal && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: '#fff', display: 'flex', flexDirection: 'column', maxWidth: 480, margin: '0 auto' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                <button onClick={() => { setOpenEditDvtModal(false); setEditDvtQ('') }}
                  style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', padding: 0, color: 'var(--text)' }}>✕</button>
                <span style={{ fontWeight: 600, fontSize: 15 }}>Chọn đơn vị tính</span>
              </div>
              <input type="text" className="input-field" placeholder="Tìm đơn vị tính..."
                value={editDvtQ} onChange={e => setEditDvtQ(e.target.value)} autoFocus />
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {danhMucDvt
                .filter(d => !editDvtQ.trim() ||
                  toSearchable(d.ten_dvt).includes(toSearchable(editDvtQ)) ||
                  toSearchable(d.ma_dvt).includes(toSearchable(editDvtQ)))
                .map(d => {
                  const selected = form.ma_dvt_kiem === d.ma_dvt
                  return (
                    <div key={d.ma_dvt}
                      onClick={() => { setForm(f => ({ ...f, ma_dvt_kiem: d.ma_dvt })); setOpenEditDvtModal(false); setEditDvtQ('') }}
                      style={{ padding: '14px 16px', borderBottom: '1px solid #F3F4F6', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, background: selected ? '#F0FDF4' : '#fff' }}>
                      <span style={{ background: '#E6F4EF', color: 'var(--green)', borderRadius: 6, padding: '2px 7px', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>{d.ma_dvt}</span>
                      <span style={{ fontSize: 15, fontWeight: selected ? 600 : 400 }}>{d.ten_dvt}</span>
                      {selected && <span style={{ marginLeft: 'auto', color: 'var(--green)', fontSize: 18 }}>✓</span>}
                    </div>
                  )
                })}
            </div>
          </div>
        )}

        {openEditPhienModal && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: '#fff', display: 'flex', flexDirection: 'column', maxWidth: 480, margin: '0 auto' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                <button onClick={() => { setOpenEditPhienModal(false); setEditPhienQ('') }}
                  style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', padding: 0, color: 'var(--text)' }}>✕</button>
                <span style={{ fontWeight: 600, fontSize: 15 }}>Chọn phiên</span>
              </div>
              <input type="text" className="input-field" placeholder="Tìm phiên..."
                value={editPhienQ} onChange={e => setEditPhienQ(e.target.value)} autoFocus />
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {phienList
                .filter(ph => ph.ke_toan_id === currentUser.id || ph.thu_kho_id === currentUser.id)
                .filter(ph => !editPhienQ.trim() ||
                  toSearchable(khoMap[ph.ma_kho] || ph.ma_kho || '').includes(toSearchable(editPhienQ)) ||
                  toSearchable(ph.ngay_kiem).includes(toSearchable(editPhienQ)) ||
                  toSearchable(ph.id).includes(toSearchable(editPhienQ)))
                .map(ph => {
                  const selected = form.phien_id === ph.id
                  const kt = userMap[ph.ke_toan_id]?.ho_ten || '?'
                  const tk = userMap[ph.thu_kho_id]?.ho_ten || '?'
                  return (
                    <div key={ph.id}
                      onClick={() => { setForm(f => ({ ...f, phien_id: ph.id })); setOpenEditPhienModal(false); setEditPhienQ('') }}
                      style={{ padding: '14px 16px', borderBottom: '1px solid #F3F4F6', cursor: 'pointer', background: selected ? '#F0FDF4' : '#fff' }}>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{ph.ngay_kiem.split('-').reverse().join('/')} · #{ph.id.slice(-4).toUpperCase()}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                        {khoMap[ph.ma_kho] || ph.ma_kho || ''} · KT: {kt} · TK: {tk}
                      </div>
                      {selected && <span style={{ color: 'var(--green)', fontSize: 12, fontWeight: 700 }}>✓ Đang chọn</span>}
                    </div>
                  )
                })}
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── List / report render ─────────────────────────────────────────
  const cols     = tab === 'kiem_ke' ? colKiemKe : colThuaThieu
  const filename = `${tab === 'kiem_ke' ? 'KiemKe' : tab === 'thua_thieu' ? 'ThuaThieu' : 'SoSanh'}_${f.tuNgay}_${f.denNgay}.xlsx`
  const keToanList   = Object.values(userMap).filter(u => u.role === 'ke_toan')
  const thuKhoList   = Object.values(userMap).filter(u => u.role === 'thu_kho')

  const fldLabel = (type, src = f) => {
    const arr = src[type]
    if (!arr.length) return type === 'phien' ? 'Tất cả phiên' : type === 'kho' ? 'Tất cả kho' : 'Tất cả'
    const first = arr[0]
    const rest = arr.length - 1
    let firstName = ''
    if (type === 'phien') {
      const p = phienList.find(x => x.id === first)
      firstName = p ? `${p.ngay_kiem} #${p.id.slice(-4).toUpperCase()}` : first
    } else if (type === 'kho') {
      firstName = khoMap[first] || first
    } else {
      firstName = userMap[first]?.ho_ten || first
    }
    return rest > 0 ? `${firstName} +${rest}` : firstName
  }

  const fldColor = (type, src = f) => src[type].length > 0 ? 'var(--text)' : 'var(--text-muted)'

  const vatTuLabel = (src = f) => {
    if (!src.vatTu.length) return 'Tất cả vật tư'
    const first = vtNameMap[src.vatTu[0]] || src.vatTu[0]
    return src.vatTu.length > 1 ? `${first} +${src.vatTu.length - 1}` : first
  }

  const todayStr = getToday()
  const activeFilterCount = tab === 'ton_kho'
    ? [f.kho.length > 0, f.vatTu.length > 0].filter(Boolean).length
    : [
        f.tuNgay !== todayStr || f.denNgay !== todayStr,
        f.kho.length > 0, f.phien.length > 0, f.keToan.length > 0, f.thuKho.length > 0, f.vatTu.length > 0
      ].filter(Boolean).length

  const fmtDate   = d => d ? d.slice(8) + '/' + d.slice(5, 7) : ''
  const dateLabel = f.tuNgay === f.denNgay ? fmtDate(f.tuNgay) : `${fmtDate(f.tuNgay)}–${fmtDate(f.denNgay)}`
  const rowCount  = tab === 'so_sanh' ? soSanhRows.length : tab === 'ton_kho' ? displayTonKho.length : tab === 'ngoai_so_sach' ? nssItems.length : displayDataFinal.length

  const isRefreshing = tab === 'ton_kho' ? loadingTonKho : tab === 'ngoai_so_sach' ? loadingNSS : loading
  function refreshReport() {
    if (tab === 'ton_kho') loadTonKho()
    else if (tab === 'ngoai_so_sach') loadNSS()
    else loadData()
  }

  // Modal chọn vật tư: ghim các mã đang được chọn lên đầu (kể cả khi nằm ngoài danh sách
  // đang hiện) để không mất dấu lựa chọn cũ khi mở lại modal. Phần còn lại giữ nguyên thứ tự
  // đã trả về (listVatTu sắp theo mã, searchVatTu sắp theo độ liên quan).
  const byMa = (a, b) => (a.ma_vt < b.ma_vt ? -1 : a.ma_vt > b.ma_vt ? 1 : 0)
  const vatTuDisplayList = (() => {
    const selectedSet = new Set(vatTuModalSel)
    const selectedRows = vatTuModalSel.map(ma_vt => ({ ma_vt, ten_vt: vtNameMap[ma_vt] || '' })).sort(byMa)
    const rest = vatTuResults.filter(v => !selectedSet.has(v.ma_vt))
    return [...selectedRows, ...rest]
  })()

  const totalPages = Math.max(1, Math.ceil(rowCount / PAGE_SIZE))
  const pageStart  = (page - 1) * PAGE_SIZE
  const pageDisplayDataFinal = displayDataFinal.slice(pageStart, page * PAGE_SIZE)
  const pageSoSanhRows       = soSanhRows.slice(pageStart, page * PAGE_SIZE)
  const pageDisplayTonKho    = displayTonKho.slice(pageStart, page * PAGE_SIZE)
  const pageNssItems         = nssItems.slice(pageStart, page * PAGE_SIZE)

  return (
    <div className="screen" style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <div className="topbar">
        <div className="topbar-title">Báo cáo</div>
        <div className="topbar-sub">{rowCount} dòng</div>
      </div>

      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 16, alignItems: 'center' }}>
        <span style={{ fontSize: 13, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
          {tab === 'ton_kho'
            ? (f.kho.length > 0 ? `Kho: ${fldLabel('kho')}` : 'Tất cả kho')
            : activeFilterCount > 0 ? `Ngày: ${dateLabel}` : `Hôm nay: ${dateLabel}`}
        </span>
        {tab !== 'ngoai_so_sach' && (() => {
          const linkStyle = { border: 'none', background: 'none', fontSize: 13, cursor: 'pointer', padding: 0, whiteSpace: 'nowrap', color: 'var(--green)', fontWeight: 600 }
          if (tab === 'ton_kho') return <>
            <button style={linkStyle} disabled={!displayTonKho.length} onClick={() => exportExcel(displayTonKho, colTonKho, `TonKhoSoSach_${f.kho.length > 0 ? f.kho.join('-') : 'TatCaKho'}.xlsx`)}>⬇ Excel</button>
            <button style={linkStyle} disabled={!displayTonKho.length} onClick={() => shareExcel(displayTonKho, colTonKho, `TonKhoSoSach_${f.kho.length > 0 ? f.kho.join('-') : 'TatCaKho'}.xlsx`)}>⬆ Chia sẻ</button>
          </>
          if (tab === 'so_sanh') {
            const colSS = [
              { label: 'Mã VT', get: r => r.ma_vt },
              { label: 'Tên vật tư', get: r => r.ten_vt },
              { label: 'ĐVT', get: r => dvtMap[r.ma_dvt] || r.ma_dvt || '' },
              { label: 'Kho', get: r => r.kho || '' },
              { label: 'Phiên', get: r => [...(r.phienIds || [])].map(id => '#' + id.slice(-4).toUpperCase()).join(', ') },
              { label: 'SL Kế toán', get: r => r.sl_kt ?? '' },
              { label: 'SL Thủ kho', get: r => r.sl_tk ?? '' },
              { label: 'Lệch KT-TK', get: r => r.sl_kt !== null && r.sl_tk !== null ? (r.sl_kt - r.sl_tk) : '' },
            ]
            return <>
              <button style={linkStyle} disabled={!soSanhRows.length} onClick={() => exportExcel(soSanhRows, colSS, 'SoSanhKTTK.xlsx')}>⬇ Excel</button>
              <button style={linkStyle} disabled={!soSanhRows.length} onClick={() => shareExcel(soSanhRows, colSS, 'SoSanhKTTK.xlsx')}>⬆ Chia sẻ</button>
            </>
          }
          return <>
            <button style={linkStyle} disabled={!displayDataFinal.length} onClick={() => exportExcel(displayDataFinal, cols, filename)}>⬇ Excel</button>
            <button style={linkStyle} disabled={!displayDataFinal.length} onClick={() => shareExcel(displayDataFinal, cols, filename)}>⬆ Chia sẻ</button>
          </>
        })()}
        <span style={{ flex: 1 }} />
        {activeFilterCount > 0 && (
          <button onClick={() => { setF(getInitFilters(currentUser.role)); setDraft(getInitFilters(currentUser.role)) }} style={{
            border: 'none', background: 'none', color: 'var(--text-muted)',
            fontSize: 13, cursor: 'pointer', padding: 0, whiteSpace: 'nowrap'
          }}>Xóa lọc</button>
        )}
        <button onClick={() => setShowFilters(v => {
          const next = !v
          if (next) setDraft(f)
          return next
        })} style={{
          padding: '0 16px', height: 38, borderRadius: 8, border: '1px solid var(--border)',
          background: activeFilterCount > 0 ? 'var(--green)' : '#fff',
          color: activeFilterCount > 0 ? '#fff' : 'var(--text)',
          fontWeight: 500, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap'
        }}>
          Lọc{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''} {showFilters ? '▲' : '▼'}
        </button>
      </div>

      {showFilters && (
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8, background: '#F9FAFB' }}>
          {tab !== 'ton_kho' && (
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Từ ngày</div>
                <input type="date" className="input-field" value={draft.tuNgay}
                  onChange={e => updDraft('tuNgay', e.target.value)} style={{ width: '100%' }} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Đến ngày</div>
                <input type="date" className="input-field" value={draft.denNgay}
                  onChange={e => updDraft('denNgay', e.target.value)} style={{ width: '100%' }} />
              </div>
            </div>
          )}

          {/* Hàng 2: Loại DL + Phiên + Kho (non-ton_kho) hoặc Kho + Vật tư (ton_kho) */}
          {tab !== 'ton_kho' ? (
            <div style={{ display: 'flex', gap: 8 }}>
              {tab !== 'so_sanh' && tab !== 'ngoai_so_sach' && (
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Loại dữ liệu</div>
                  <select className="input-select" value={draft.loaiDuLieu}
                    onChange={e => updDraft('loaiDuLieu', e.target.value)} style={{ width: '100%' }}>
                    <option value="ke_toan">Số liệu kế toán</option>
                    <option value="thu_kho">Số liệu thủ kho</option>
                  </select>
                </div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Phiên kiểm kê</div>
                <div className="input-select" onClick={() => { setFilterModal('phien'); setFilterModalSel(draft.phien); setFilterModalQ(''); setTimeout(() => filterModalRef.current?.focus(), 100) }}
                  style={{ cursor: 'pointer', color: fldColor('phien', draft), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {fldLabel('phien', draft)}
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Kho</div>
                <div className="input-select" onClick={() => { setFilterModal('kho'); setFilterModalSel(draft.kho); setFilterModalQ(''); setTimeout(() => filterModalRef.current?.focus(), 100) }}
                  style={{ cursor: 'pointer', color: fldColor('kho', draft), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {fldLabel('kho', draft)}
                </div>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Kho</div>
                <div className="input-select" onClick={() => { setFilterModal('kho'); setFilterModalSel(draft.kho); setFilterModalQ(''); setTimeout(() => filterModalRef.current?.focus(), 100) }}
                  style={{ cursor: 'pointer', color: fldColor('kho', draft) }}>
                  {fldLabel('kho', draft)}
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Vật tư</div>
                <div className="input-select" onClick={() => { setVatTuModalQ(''); setVatTuModalSel(draft.vatTu); setOpenVatTuModal(true) }}
                  style={{ cursor: 'pointer', color: draft.vatTu.length ? 'var(--text)' : 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {vatTuLabel(draft)}
                </div>
              </div>
            </div>
          )}

          {/* Hàng 3: Kế toán + Thủ kho + Vật tư */}
          {tab !== 'ton_kho' && (
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Kế toán</div>
                <div className="input-select" onClick={() => { setFilterModal('keToan'); setFilterModalSel(draft.keToan); setFilterModalQ(''); setTimeout(() => filterModalRef.current?.focus(), 100) }}
                  style={{ cursor: 'pointer', color: fldColor('keToan', draft), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {fldLabel('keToan', draft)}
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Thủ kho</div>
                <div className="input-select" onClick={() => { setFilterModal('thuKho'); setFilterModalSel(draft.thuKho); setFilterModalQ(''); setTimeout(() => filterModalRef.current?.focus(), 100) }}
                  style={{ cursor: 'pointer', color: fldColor('thuKho', draft), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {fldLabel('thuKho', draft)}
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Vật tư</div>
                <div className="input-select" onClick={() => { setVatTuModalQ(''); setVatTuModalSel(draft.vatTu); setOpenVatTuModal(true) }}
                  style={{ cursor: 'pointer', color: draft.vatTu.length ? 'var(--text)' : 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {vatTuLabel(draft)}
                </div>
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button onClick={() => setDraft(getInitFilters(currentUser.role))} style={{
              flex: 1, padding: '10px 0', borderRadius: 8, border: '1px solid var(--border)',
              background: '#fff', color: 'var(--text)', fontWeight: 600, fontSize: 13, cursor: 'pointer'
            }}>Thiết lập lại</button>
            <button onClick={() => { setF(draft); setShowFilters(false) }} style={{
              flex: 1, padding: '10px 0', borderRadius: 8, border: 'none',
              background: 'var(--green)', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer'
            }}>Tìm kiếm</button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0, overflowX: 'auto' }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            flexShrink: 0, padding: '10px 12px', border: 'none', background: 'none',
            fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap',
            color: tab === t.key ? 'var(--green)' : 'var(--text-muted)',
            borderBottom: tab === t.key ? '2px solid var(--green)' : '2px solid transparent',
            cursor: 'pointer'
          }}>{t.label}</button>
        ))}
      </div>
      <div style={{ height: 6, background: '#F3F4F6', flexShrink: 0 }} />

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', paddingBottom: 112 }}>
        {tab === 'ngoai_so_sach' ? (
          <>
            {reconcileItem && (
              <ChonVatTu autoOpen value={null} onSelect={vt => {
                if (vt) doReconcile(reconcileItem, vt)
                else setReconcileItem(null)
              }} />
            )}
            {loadingNSS ? (
              <div className="empty-state">Đang tải...</div>
            ) : nssItems.length === 0 ? (
              <div className="empty-state">Không có mặt hàng ngoài sổ sách</div>
            ) : pageNssItems.map(item => {
              const maKho = item.ma_kho || item._phien?.ma_kho || ''
              const tenKho = khoList.find(k => k.ma_kho === maKho)?.ten_kho || maKho
              return (
                <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 16px', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <span className="item-code">{item.ma_vt}</span> · {item.ten_vt}
                    </div>
                    <div className="item-meta" style={{ marginTop: 1 }}>
                      {[tenKho, item._allIds?.length > 1 ? `${item._allIds.length} dòng` : null].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <button onClick={() => setReconcileItem(item)}
                    style={{ flexShrink: 0, padding: '5px 10px', borderRadius: 6, border: '1.5px solid var(--green)', background: 'var(--green-light)', color: 'var(--green-dark)', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    Chọn mã
                  </button>
                </div>
              )
            })}
          </>
        ) : tab === 'ton_kho' ? (
          loadingTonKho ? (
            <div className="empty-state">Đang tải...</div>
          ) : displayTonKho.length === 0 ? (
            <div className="empty-state">
              {tonKhoRows.length === 0 ? 'Không có dữ liệu tồn kho' : 'Không tìm thấy vật tư khớp'}
            </div>
          ) : (
            <table style={{ borderCollapse: 'collapse', width: '100%', tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: 32 }} />
                <col />
                <col style={{ width: 72 }} />
                <col style={{ width: 80 }} />
              </colgroup>
              <thead>
                <tr>
                  {[{ l: 'STT' }, { l: 'Mã / Tên VT' }, { l: 'ĐVT' }, { l: 'SL SS', right: true }].map(c => (
                    <th key={c.l} style={{
                      padding: '8px 6px', background: '#1D9E75', color: '#fff',
                      fontWeight: 600, fontSize: 12,
                      textAlign: c.right ? 'right' : 'left',
                      position: 'sticky', top: 0, zIndex: 1
                    }}>{c.l}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageDisplayTonKho.map((row, i) => {
                  const tenKho = khoList.find(k => k.ma_kho === row.ma_kho)?.ten_kho || row.ma_kho || ''
                  const dvt = dvtMap[vtDvtChinhMap[row.ma_vt]] || vtDvtChinhMap[row.ma_vt] || ''
                  const bg = (pageStart + i) % 2 === 0 ? '#fff' : '#F9FAFB'
                  const tdStyle = { padding: '7px 6px', borderBottom: '1px solid #F3F4F6', background: bg, verticalAlign: 'middle' }
                  return (
                    <tr key={`${row.ma_vt}_${row.ma_kho}`}>
                      <td style={{ ...tdStyle, fontSize: 11, color: 'var(--text-muted)' }}>{pageStart + i + 1}</td>
                      <td style={{ ...tdStyle, overflow: 'hidden' }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#1d9e75', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.ma_vt}</div>
                        <div style={{ fontSize: 11, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{vtNameMap[row.ma_vt] || ''}</div>
                        {tenKho && <div style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tenKho}</div>}
                      </td>
                      <td style={{ ...tdStyle, fontSize: 11, color: 'var(--text-muted)' }}>{dvt}</td>
                      <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600, fontSize: 13 }}>
                        {row.so_luong_so_sach != null ? fmtSL(row.so_luong_so_sach) : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )
        ) : (loading || (tab === 'thua_thieu' && loadingTonKho)) ? (
          <div className="empty-state">Đang tải...</div>

        ) : tab === 'so_sanh' ? (
          soSanhRows.length === 0 ? (
            <div className="empty-state">
              Dùng bộ lọc để chọn ngày, kho, kế toán, thủ kho cần so sánh
            </div>
          ) : (
            <table style={{ borderCollapse: 'collapse', width: '100%', tableLayout: 'fixed' }}>
              <colgroup>
                <col />
                <col style={{ width: 46 }} />
                <col style={{ width: 58 }} />
                <col style={{ width: 58 }} />
                <col style={{ width: 62 }} />
              </colgroup>
              <thead>
                <tr>
                  {[
                    { l: 'Mã / Tên VT', right: false },
                    { l: 'ĐVT',   right: false },
                    { l: 'KT',    right: true },
                    { l: 'TK',    right: true },
                    { l: 'Lệch',  right: true },
                  ].map(c => (
                    <th key={c.l} style={{
                      padding: '8px 6px', background: '#1D9E75', color: '#fff',
                      fontWeight: 600, fontSize: 12,
                      textAlign: c.right ? 'right' : 'left',
                      position: 'sticky', top: 0, zIndex: 1
                    }}>{c.l}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageSoSanhRows.map((r, i) => {
                  const lech = (r.sl_kt ?? 0) - (r.sl_tk ?? 0)
                  const missing = r.sl_kt === null || r.sl_tk === null
                  const khop = !missing && lech === 0
                  const trangThai = khop ? 'Khớp' : 'Không khớp'
                  const trangThaiColor = khop ? '#16A34A' : '#DC2626'
                  const bg = khop ? '#F0FDF4' : '#FEF2F2'
                  const tdStyle = { padding: '7px 6px', borderBottom: '1px solid #F3F4F6', background: bg, verticalAlign: 'middle' }
                  const isSelected = thuaThieuDetail?._tab === 'so_sanh' && thuaThieuDetail._key === r._key
                  const maPhien = '#' + (r.phien_id ? r.phien_id.slice(-4).toUpperCase() : '?')
                  const kt = userMap[r.ke_toan_id]?.ho_ten || '?'
                  const tk = userMap[r.thu_kho_id]?.ho_ten || '?'
                  return <>
                    <tr key={i} style={{ cursor: 'pointer' }}
                      onClick={() => setThuaThieuDetail(isSelected ? null : r)}>
                      <td style={{ ...tdStyle, overflow: 'hidden' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span style={{ fontSize: 12, fontWeight: 600, color: '#1d9e75', whiteSpace: 'nowrap' }}>{r.ma_vt}</span>
                          {trangThai && <span style={{ fontSize: 10, fontWeight: 700, color: trangThaiColor, flexShrink: 0 }}>· {trangThai}</span>}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.ten_vt}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[r.kho, maPhien].filter(Boolean).join(' · ')}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>KT: {kt} · TK: {tk}</div>
                      </td>
                      <td style={{ ...tdStyle, fontSize: 11, color: 'var(--text-muted)' }}>
                        {dvtMap[r.ma_dvt] || r.ma_dvt || ''}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', fontSize: 12 }}>
                        {r.sl_kt !== null ? fmtSL(r.sl_kt) : <span style={{ color: '#F59E0B' }}>—</span>}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', fontSize: 12 }}>
                        {r.sl_tk !== null ? fmtSL(r.sl_tk) : <span style={{ color: '#F59E0B' }}>—</span>}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700, fontSize: 13, color: trangThaiColor }}>
                        {missing ? '?' : lech === 0 ? '—' : (lech > 0 ? '+' : '') + fmtSL(lech)}
                      </td>
                    </tr>
                    {isSelected && (
                      <tr key={`a-${i}`}>
                        <td colSpan={5} style={{ padding: '4px 8px 8px', background: '#F9FAFB', borderBottom: '2px solid var(--border)' }}>
                          <div style={{ display: 'flex', gap: 16 }}>
                            <span onClick={e => { e.stopPropagation(); openMiniKiemKe(r.phienIds) }}
                              style={{ fontSize: 12, fontWeight: 600, color: '#2563EB', cursor: 'pointer', padding: '2px 0' }}>
                              + Kiểm kê
                            </span>
                            <span onClick={e => { e.stopPropagation(); setChiTietPage(1); setShowChiTietSS(true) }}
                              style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', cursor: 'pointer', padding: '2px 0' }}>
                              Chi tiết
                            </span>
                            <span onClick={e => { e.stopPropagation(); startXoaHet(r) }}
                              style={{ fontSize: 12, fontWeight: 600, color: '#DC2626', cursor: 'pointer', padding: '2px 0' }}>
                              Xóa hết nhập lại
                            </span>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                })}
              </tbody>
            </table>
          )

        ) : displayDataFinal.length === 0 ? (
          <div className="empty-state">
            {tab === 'thua_thieu'
              ? 'Chưa có mặt hàng nào trong sổ sách (tồn kho)'
              : data.length === 0
                ? 'Dùng bộ lọc để chọn ngày, kho, kế toán, thủ kho cần xem'
                : 'Không tìm thấy vật tư khớp'}
          </div>
        ) : tab === 'thua_thieu' ? (
          <table style={{ borderCollapse: 'collapse', width: '100%', tableLayout: 'fixed' }}>
            <colgroup>
              <col />
              <col style={{ width: 56 }} />
              <col style={{ width: 58 }} />
              <col style={{ width: 58 }} />
              <col style={{ width: 58 }} />
            </colgroup>
            <thead>
              <tr>
                {[
                  { l: 'Mã / Tên VT', right: false },
                  { l: 'ĐVT chính',   right: false },
                  { l: 'SL QĐ',       right: true },
                  { l: 'SL SS',       right: true },
                  { l: 'Lệch',        right: true },
                ].map(c => (
                  <th key={c.l} style={{
                    padding: '8px 4px', background: '#1D9E75', color: '#fff',
                    fontWeight: 600, fontSize: 11,
                    textAlign: c.right ? 'right' : 'left',
                    position: 'sticky', top: 0, zIndex: 1
                  }}>{c.l}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageDisplayDataFinal.map((row, i) => {
                const cl = parseFloat(row.chenh_lech)
                const bg = isNaN(cl) ? '#fff' : cl < 0 ? '#FEF2F2' : cl > 0 ? '#FFFBEB' : '#F0FDF4'
                const tdStyle = { padding: '7px 4px', borderBottom: '1px solid #F3F4F6', background: bg, verticalAlign: 'middle' }
                const dvtChinh = dvtMap[vtDvtChinhMap[row.ma_vt]] || vtDvtChinhMap[row.ma_vt] || ''
                const tenKho = khoMap[row.ma_kho] || row.ma_kho || ''
                const phienIds = [...(row.phienIds || [])]
                const maPhien = phienIds.length === 1
                  ? '#' + phienIds[0].slice(-4).toUpperCase()
                  : phienIds.length > 1 ? `${phienIds.length} phiên` : ''
                const clColor = isNaN(cl) ? 'inherit' : cl < 0 ? '#DC2626' : cl > 0 ? '#D97706' : '#16A34A'
                const trangThai = isNaN(cl) ? '' : cl < 0 ? 'Thiếu' : cl > 0 ? 'Thừa' : 'Khớp'
                const trangThaiColor = isNaN(cl) ? '' : cl < 0 ? '#DC2626' : cl > 0 ? '#D97706' : '#16A34A'
                return (() => {
                    const rowKey = `${row.ma_vt}__${row.ma_kho}`
                    const isSelected = thuaThieuDetail && `${thuaThieuDetail.ma_vt}__${thuaThieuDetail.ma_kho}` === rowKey
                    return <>
                      <tr key={`r-${i}`} style={{ cursor: 'pointer' }}
                        onClick={() => setThuaThieuDetail(isSelected ? null : row)}>
                        <td style={{ ...tdStyle }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <span style={{ fontSize: 12, fontWeight: 600, color: '#1d9e75', whiteSpace: 'nowrap' }}>{row.ma_vt}</span>
                            {trangThai && <span style={{ fontSize: 10, fontWeight: 700, color: trangThaiColor, flexShrink: 0 }}>· {trangThai}</span>}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text)', lineHeight: 1.3 }}>{row.ten_vt}</div>
                          {(tenKho || maPhien) && (
                            <div style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {[tenKho, maPhien].filter(Boolean).join(' · ')}
                            </div>
                          )}
                        </td>
                        <td style={{ ...tdStyle, fontSize: 11, color: 'var(--text-muted)' }}>{dvtChinh}</td>
                        <td style={{ ...tdStyle, textAlign: 'right', fontSize: 12 }}>
                          {row.so_luong_quy_doi != null ? fmtSL(row.so_luong_quy_doi) : '—'}
                        </td>
                        <td style={{ ...tdStyle, textAlign: 'right', fontSize: 12 }}>
                          {row.so_luong_so_sach != null ? fmtSL(row.so_luong_so_sach) : '—'}
                        </td>
                        <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700, fontSize: 13, color: clColor }}>
                          {isNaN(cl) || cl === 0 ? '—' : (cl > 0 ? '+' : '') + fmtSL(cl)}
                        </td>
                      </tr>
                      {isSelected && (
                        <tr key={`a-${i}`}>
                          <td colSpan={5} style={{ padding: '4px 8px 8px', background: '#F9FAFB', borderBottom: '2px solid var(--border)' }}>
                            <div style={{ display: 'flex', gap: 16 }}>
                              <span onClick={e => { e.stopPropagation(); openMiniKiemKe(row.phienIds) }}
                                style={{ fontSize: 12, fontWeight: 600, color: '#2563EB', cursor: 'pointer', padding: '2px 0' }}>
                                + Kiểm kê
                              </span>
                              <span onClick={e => { e.stopPropagation(); setChiTietPage(1); setShowChiTietSS(true) }}
                                style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', cursor: 'pointer', padding: '2px 0' }}>
                                Chi tiết
                              </span>
                              <span onClick={e => { e.stopPropagation(); startXoaHet(row) }}
                                style={{ fontSize: 12, fontWeight: 600, color: '#DC2626', cursor: 'pointer', padding: '2px 0' }}>
                                Xóa hết nhập lại
                              </span>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  })()
              })}
            </tbody>
          </table>
        ) : (
          <table style={{ borderCollapse: 'collapse', width: '100%', tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '40%' }} />
              <col style={{ width: '15%' }} />
              <col style={{ width: '6%' }} />
              <col style={{ width: '6%' }} />
              <col style={{ width: '15%' }} />
              <col style={{ width: '6%' }} />
            </colgroup>
            <thead>
              <tr>
                {[
                  { l: 'Mã / Tên VT', center: false },
                  { l: 'SL thực tế',  center: true  },
                  { l: 'ĐVT phụ',     center: true  },
                  { l: '×HS',         center: true  },
                  { l: 'SL quy đổi',  center: true  },
                  { l: 'ĐVT chính',   center: true  },
                ].map(c => (
                  <th key={c.l} style={{
                    padding: '6px 4px', background: '#1D9E75', color: '#fff',
                    fontWeight: 600, fontSize: 10, lineHeight: 1.3,
                    textAlign: c.center ? 'center' : 'left',
                    verticalAlign: 'middle',
                    position: 'sticky', top: 0, zIndex: 1
                  }}>{c.l}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageDisplayDataFinal.map((row, i) => {
                const rowBg      = (pageStart + i) % 2 === 0 ? '#fff' : '#F9FAFB'
                const isSelected = kiemKeSelected?.id === row.id
                const dvtPhu     = row.ma_dvt_kiem || ''
                const dvtChinh   = dvtMap[vtDvtChinhMap[row.ma_vt]] || vtDvtChinhMap[row.ma_vt] || ''
                const hs         = row.he_so_quy_doi ?? 1
                const tenKho     = row.dm_kho?.ten_kho || row.ma_kho || row.phien_kiem_ke?.dm_kho?.ten_kho || row.phien_kiem_ke?.ma_kho || ''
                const maPhien    = row.phien_id ? '#' + row.phien_id.slice(-4).toUpperCase() : ''
                const thoiGian   = row.created_at ? (() => {
                  const d = new Date(row.created_at)
                  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
                })() : ''
                const metaSub = [maPhien, row._nguoi_nhap, thoiGian].filter(Boolean).join(' · ')
                const bg = isSelected ? '#EFF6FF' : rowBg
                const td = { background: bg, verticalAlign: 'middle', padding: '8px 4px', borderBottom: isSelected ? 'none' : '1px solid #F3F4F6' }
                return <>
                  <tr key={`r-${i}`} style={{ cursor: 'pointer' }} onClick={() => setKiemKeSelected(isSelected ? null : row)}>
                    <td style={{ ...td, padding: '8px 4px 8px 10px' }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: '#1d9e75', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.ma_vt}</div>
                      <div style={{ fontSize: 11, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.ten_vt}</div>
                      {tenKho && <div style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>{tenKho}</div>}
                      {metaSub && <div style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{metaSub}</div>}
                    </td>
                    <td style={{ ...td, textAlign: 'center', fontSize: 15, fontWeight: 700 }}>
                      {fmtSL(row.so_luong_thuc_te)}
                    </td>
                    <td style={{ ...td, textAlign: 'center', fontSize: 10, color: 'var(--text-muted)' }}>
                      {dvtPhu}
                    </td>
                    <td style={{ ...td, textAlign: 'center', fontSize: 10, color: 'var(--text-muted)' }}>
                      ×{fmtSL(hs)}
                    </td>
                    <td style={{ ...td, textAlign: 'center', fontSize: 15, fontWeight: 700, color: '#1d9e75' }}>
                      {row.so_luong_quy_doi != null ? fmtSL(row.so_luong_quy_doi) : '—'}
                    </td>
                    <td style={{ ...td, textAlign: 'center', fontSize: 10, color: 'var(--text-muted)' }}>
                      {dvtChinh}
                    </td>
                  </tr>
                  {isSelected && (
                    <tr key={`a-${i}`}>
                      <td style={{ padding: '4px 10px 9px', background: '#EFF6FF', borderBottom: '2px solid #BFDBFE' }}>
                        <div style={{ display: 'flex', gap: 16 }}>
                          <span onClick={e => { e.stopPropagation(); openDetail(row, false) }}
                            style={{ fontSize: 12, fontWeight: 600, color: '#2563EB', cursor: 'pointer' }}>Xem</span>
                          <span onClick={e => {
                            e.stopPropagation()
                            if (currentUser.role !== 'admin' && row.nguoi_nhap_id !== currentUser.id) setWarningMsg('Bạn chỉ có thể sửa dòng do chính mình nhập.')
                            else openDetail(row, true)
                          }} style={{ fontSize: 12, fontWeight: 600, color: '#D97706', cursor: 'pointer' }}>Sửa</span>
                          <span onClick={e => { e.stopPropagation(); setConfirmXoaKiemKe(true) }}
                            style={{ fontSize: 12, fontWeight: 600, color: '#DC2626', cursor: 'pointer' }}>Xóa</span>
                        </div>
                      </td>
                      <td style={{ background: '#EFF6FF', borderBottom: '2px solid #BFDBFE' }} />
                      <td style={{ background: '#EFF6FF', borderBottom: '2px solid #BFDBFE' }} />
                      <td style={{ background: '#EFF6FF', borderBottom: '2px solid #BFDBFE' }} />
                      <td style={{ background: '#EFF6FF', borderBottom: '2px solid #BFDBFE' }} />
                      <td style={{ background: '#EFF6FF', borderBottom: '2px solid #BFDBFE' }} />
                    </tr>
                  )}
                </>
              })}
            </tbody>
          </table>
        )}
      </div>

      {(() => {
        const btnStyle = (disabled) => ({
          border: '1px solid var(--border)', borderRadius: 6,
          padding: '5px 11px', fontSize: 14, background: '#fff',
          color: disabled ? '#CBD5E1' : 'var(--text)',
          cursor: disabled ? 'default' : 'pointer',
        })
        return (
          <div style={{
            position: 'fixed', bottom: 56, zIndex: 51,
            left: '50%', transform: 'translateX(-50%)',
            width: '100%', maxWidth: 480,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: 8, padding: '8px 16px',
            borderTop: '1px solid var(--border)', background: '#fff',
          }}>
            <button onClick={() => setPage(1)} disabled={page === 1} style={btnStyle(page === 1)}>«</button>
            <button onClick={() => setPage(p => p - 1)} disabled={page === 1} style={btnStyle(page === 1)}>‹</button>
            <span style={{ fontSize: 13, fontWeight: 500, minWidth: 90, textAlign: 'center' }}>
              Trang {page} / {totalPages}
            </span>
            <button onClick={() => setPage(p => p + 1)} disabled={page === totalPages} style={btnStyle(page === totalPages)}>›</button>
            <button onClick={() => setPage(totalPages)} disabled={page === totalPages} style={btnStyle(page === totalPages)}>»</button>
            <span style={{ color: 'var(--border)' }}>|</span>
            <button onClick={refreshReport} disabled={isRefreshing} style={{
              border: 'none', background: 'none', padding: 0,
              fontSize: 13, fontWeight: 600, color: 'var(--green)',
              cursor: isRefreshing ? 'default' : 'pointer', opacity: isRefreshing ? 0.6 : 1, whiteSpace: 'nowrap'
            }}>
              Làm tươi
            </button>
          </div>
        )
      })()}

      {openVatTuModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: '#fff', display: 'flex', flexDirection: 'column', maxWidth: 480, margin: '0 auto' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <span style={{ fontWeight: 600, fontSize: 15 }}>Vật tư</span>
              <div style={{ display: 'flex', gap: 16 }}>
                <button onClick={() => setVatTuModalSel([])}
                  style={{ border: 'none', background: 'none', color: 'var(--text-muted)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Xóa chọn</button>
                <button onClick={() => { updDraft('vatTu', vatTuModalSel); setOpenVatTuModal(false) }}
                  style={{ border: 'none', background: 'none', color: 'var(--green)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Xong</button>
              </div>
            </div>
            <input ref={vatTuModalRef} type="text" className="input-field"
              placeholder="Tìm mã hoặc tên vật tư"
              value={vatTuModalQ} onChange={e => setVatTuModalQ(e.target.value)}
              style={{ margin: 0 }} autoFocus />
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {vatTuModalQ.trim().length > 0 && vatTuModalQ.trim().length < MIN_VAT_TU_QUERY_LEN ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>Gõ ít nhất {MIN_VAT_TU_QUERY_LEN} ký tự để tìm</div>
            ) : vatTuSearching ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>Đang tìm...</div>
            ) : vatTuResults.length === 0 && vatTuModalQ.trim() ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>Không tìm thấy vật tư</div>
            ) : vatTuDisplayList.map(v => {
              const checked = vatTuModalSel.includes(v.ma_vt)
              return (
                <div key={v.ma_vt} onClick={() => setVatTuModalSel(prev => checked ? prev.filter(x => x !== v.ma_vt) : [...prev, v.ma_vt])}
                  style={{ padding: '14px 16px', borderBottom: '1px solid #F3F4F6', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{
                    width: 20, height: 20, borderRadius: 4, border: `2px solid ${checked ? 'var(--green)' : '#CBD5E1'}`,
                    background: checked ? 'var(--green)' : '#fff', flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center'
                  }}>
                    {checked && <span style={{ color: '#fff', fontSize: 13, lineHeight: 1 }}>✓</span>}
                  </div>
                  <span style={{ background: '#E6F4EF', color: 'var(--green)', borderRadius: 6, padding: '2px 7px', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
                    <Highlight text={v.ma_vt} query={vatTuModalQ} />
                  </span>
                  <span style={{ fontSize: 14 }}><Highlight text={v.ten_vt} query={vatTuModalQ} /></span>
                </div>
              )
            })}
            {!vatTuModalQ.trim() && vatTuResults.length === VAT_TU_BROWSE_LIMIT && (
              <div style={{ padding: '12px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
                Đang hiện {VAT_TU_BROWSE_LIMIT} mục đầu — gõ để tìm vật tư cụ thể
              </div>
            )}
          </div>
        </div>
      )}

      {filterModal && (() => {
        const TITLES = { phien: 'Phiên kiểm kê', kho: 'Kho', keToan: 'Kế toán', thuKho: 'Thủ kho' }
        let items = []
        if (filterModal === 'phien') {
          items = phienList.map(p => {
            const kt = userMap[p.ke_toan_id]?.ma_user || '?'
            const tk = userMap[p.thu_kho_id]?.ma_user || '?'
            return { id: p.id, code: p.id.slice(-4).toUpperCase(), label: `${p.ngay_kiem}${p.ma_kho ? ` · ${khoMap[p.ma_kho] || p.ma_kho}` : ''} · ${kt}/${tk}` }
          })
        } else if (filterModal === 'kho') {
          items = khoList.map(k => ({ id: k.ma_kho, code: k.ma_kho, label: k.ten_kho }))
        } else if (filterModal === 'keToan') {
          items = keToanList.map(u => ({ id: u.id, label: u.ho_ten }))
        } else if (filterModal === 'thuKho') {
          items = thuKhoList.map(u => ({ id: u.id, label: u.ho_ten }))
        }
        const q = toSearchable(filterModalQ)
        const filtered = q ? items.filter(i => toSearchable(i.label).includes(q) || toSearchable(i.code).includes(q)) : items
        const toggle = (id) => setFilterModalSel(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
        return (
          <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: '#fff', display: 'flex', flexDirection: 'column', maxWidth: 480, margin: '0 auto' }}>
            {/* Header */}
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <span style={{ fontWeight: 600, fontSize: 15 }}>{TITLES[filterModal]}</span>
                <div style={{ display: 'flex', gap: 16 }}>
                  <button onClick={() => setFilterModalSel([])} style={{ border: 'none', background: 'none', color: 'var(--text-muted)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Xóa chọn</button>
                  <button onClick={() => { updDraft(filterModal, filterModalSel); setFilterModal(null); setFilterModalQ('') }} style={{ border: 'none', background: 'none', color: 'var(--green)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Xong</button>
                </div>
              </div>
              <input ref={filterModalRef} type="text" className="input-field"
                placeholder="Search"
                value={filterModalQ} onChange={e => setFilterModalQ(e.target.value)}
                style={{ margin: 0 }} />
            </div>
            {/* List */}
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {filtered.map(item => {
                const checked = filterModalSel.includes(item.id)
                return (
                  <div key={item.id} onClick={() => toggle(item.id)}
                    style={{ padding: '14px 16px', borderBottom: '1px solid #F3F4F6', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{
                      width: 20, height: 20, borderRadius: 4, border: `2px solid ${checked ? 'var(--green)' : '#CBD5E1'}`,
                      background: checked ? 'var(--green)' : '#fff', flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center'
                    }}>
                      {checked && <span style={{ color: '#fff', fontSize: 13, lineHeight: 1 }}>✓</span>}
                    </div>
                    {item.code && <span style={{ background: '#E6F4EF', color: 'var(--green)', borderRadius: 6, padding: '2px 7px', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>{item.code}</span>}
                    <span style={{ fontSize: 14 }}>{item.label}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })()}

      {/* ── Confirm xóa dòng kiểm kê ── */}
      {confirmXoaKiemKe && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: '100%', maxWidth: 360 }}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 10 }}>Xóa dòng kiểm kê?</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20, lineHeight: 1.6 }}>
              {kiemKeSelected?.ma_vt} · {kiemKeSelected?.ten_vt}
            </div>
            <div className="row-2col">
              <button className="btn-secondary" onClick={() => setConfirmXoaKiemKe(false)} disabled={saving}>Hủy</button>
              <button className="btn-primary" onClick={handleDeleteKiemKe} disabled={saving}
                style={{ background: '#DC2626', borderColor: '#DC2626' }}>
                {saving ? 'Đang xóa...' : 'Xóa'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Cảnh báo (thay alert) ── */}
      {warningMsg && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: '100%', maxWidth: 360 }}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 10 }}>Không thể thao tác</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20, lineHeight: 1.6 }}>
              {warningMsg}
            </div>
            <button className="btn-primary" style={{ width: '100%' }} onClick={() => setWarningMsg(null)}>Đã hiểu</button>
          </div>
        </div>
      )}

      {/* ── Chọn phiên trước khi xóa hết (mặt hàng nằm ở nhiều phiên) ── */}
      {showXoaHetPicker && thuaThieuDetail && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: '#fff', display: 'flex', flexDirection: 'column', maxWidth: 480, margin: '0 auto' }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 2 }}>Xóa hết — chọn phiên</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{thuaThieuDetail.ma_vt} · {thuaThieuDetail.ten_vt}</div>
            <div style={{ fontSize: 11, color: '#6B7280', marginTop: 4 }}>Mặt hàng này nằm ở nhiều phiên của bạn — chọn đúng phiên cần xóa.</div>
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {xoaHetPickerCandidates.map(id => {
              const p = phienList.find(p => p.id === id)
              if (!p) return null
              const kt = userMap[p.ke_toan_id]?.ho_ten || '?'
              const tk = userMap[p.thu_kho_id]?.ho_ten || '?'
              return (
                <div key={id} onClick={() => { setXoaHetPhienId(id); setShowXoaHetPicker(false); setConfirmXoaHet(true) }}
                  style={{ padding: '14px 16px', borderBottom: '1px solid #F3F4F6', cursor: 'pointer' }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{p.ngay_kiem} · #{id.slice(-4).toUpperCase()}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                    {khoMap[p.ma_kho] || p.ma_kho} · KT: {kt} · TK: {tk}
                  </div>
                </div>
              )
            })}
          </div>
          <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)' }}>
            <button className="btn-secondary" style={{ width: '100%' }} onClick={() => setShowXoaHetPicker(false)}>Hủy</button>
          </div>
        </div>
      )}

      {/* ── Confirm xóa hết ── */}
      {confirmXoaHet && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: '100%', maxWidth: 360 }}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 10 }}>Xóa hết nhập lại?</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20, lineHeight: 1.6 }}>
              Xóa hết số lượng bạn đã nhập cho mặt hàng này{xoaHetPhienId ? ` ở phiên #${xoaHetPhienId.slice(-4).toUpperCase()}` : ''} và nhập lại số đúng cuối cùng? (Không ảnh hưởng số liệu của người khác trong cùng phiên)
            </div>
            <div className="row-2col">
              <button className="btn-secondary" onClick={() => { setConfirmXoaHet(false); setXoaHetPhienId(null) }} disabled={xoaHetSaving}>Hủy</button>
              <button className="btn-primary" onClick={handleXoaHet} disabled={xoaHetSaving}
                style={{ background: '#DC2626', borderColor: '#DC2626' }}>
                {xoaHetSaving ? 'Đang xóa...' : 'Xác nhận'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Chi tiết Thừa/Thiếu SS ── */}
      {showChiTietSS && thuaThieuDetail && (() => {
        const chiTietRows = displayData
          .filter(r => r.ma_vt === thuaThieuDetail.ma_vt && (r.ma_kho ?? '') === (thuaThieuDetail.ma_kho ?? '')
            && (!thuaThieuDetail.phienIds || thuaThieuDetail.phienIds.size === 0 || thuaThieuDetail.phienIds.has(r.phien_id)))
          .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        const tongQuyDoi = chiTietRows.reduce((s, r) => s + (r.so_luong_quy_doi ?? 0), 0)
        const dvtChinh = dvtMap[vtDvtChinhMap[thuaThieuDetail.ma_vt]] || vtDvtChinhMap[thuaThieuDetail.ma_vt] || ''
        const ctTotalPages = Math.max(1, Math.ceil(chiTietRows.length / PAGE_SIZE))
        const ctPageStart  = (chiTietPage - 1) * PAGE_SIZE
        const ctPageRows   = chiTietRows.slice(ctPageStart, ctPageStart + PAGE_SIZE)
        const ctBtnStyle = (disabled) => ({
          border: '1px solid var(--border)', borderRadius: 6,
          padding: '4px 9px', fontSize: 13, background: '#fff',
          color: disabled ? '#CBD5E1' : 'var(--text)',
          cursor: disabled ? 'default' : 'pointer',
        })
        return (
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 56, zIndex: 300, background: '#fff', display: 'flex', flexDirection: 'column', maxWidth: 480, margin: '0 auto' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12 }}>
              <button onClick={() => setShowChiTietSS(false)}
                style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', padding: 0, color: 'var(--text)' }}>✕</button>
              <span style={{ fontWeight: 600, fontSize: 15, flex: 1 }}>Chi tiết vật tư</span>
              {(() => {
                const linkStyle = { border: 'none', background: 'none', fontSize: 13, cursor: 'pointer', padding: 0, whiteSpace: 'nowrap', color: 'var(--green)', fontWeight: 600 }
                const ctFilename = `ChiTiet_${thuaThieuDetail.ma_vt}.xlsx`
                return <>
                  <button style={linkStyle} disabled={!chiTietRows.length} onClick={() => exportExcel(chiTietRows, colKiemKe, ctFilename)}>⬇ Excel</button>
                  <button style={linkStyle} disabled={!chiTietRows.length} onClick={() => shareExcel(chiTietRows, colKiemKe, ctFilename)}>⬆ Chia sẻ</button>
                </>
              })()}
            </div>
            <div style={{
              padding: '8px 10px', flexShrink: 0, background: '#F0FDF4',
              borderBottom: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between'
            }}>
              <span style={{ fontSize: 12, fontWeight: 700 }}>Tổng cộng ({chiTietRows.length} dòng)</span>
              <span style={{ fontSize: 15, fontWeight: 700, color: '#1d9e75' }}>{fmtSL(tongQuyDoi)} {dvtChinh}</span>
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', tableLayout: 'fixed' }}>
                <colgroup>
                  <col style={{ width: '40%' }} />
                  <col style={{ width: '15%' }} />
                  <col style={{ width: '6%' }} />
                  <col style={{ width: '6%' }} />
                  <col style={{ width: '15%' }} />
                  <col style={{ width: '6%' }} />
                </colgroup>
                <thead>
                  <tr>
                    {[
                      { l: 'Mã / Tên VT', center: false },
                      { l: 'SL thực tế',  center: true  },
                      { l: 'ĐVT phụ',     center: true  },
                      { l: '×HS',         center: true  },
                      { l: 'SL quy đổi',  center: true  },
                      { l: 'ĐVT chính',   center: true  },
                    ].map(c => (
                      <th key={c.l} style={{
                        padding: '6px 4px', background: '#1D9E75', color: '#fff',
                        fontWeight: 600, fontSize: 10, lineHeight: 1.3,
                        textAlign: c.center ? 'center' : 'left',
                        verticalAlign: 'middle',
                        position: 'sticky', top: 0, zIndex: 1
                      }}>{c.l}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ctPageRows.length === 0 ? (
                    <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Không có dòng kiểm kê nào</td></tr>
                  ) : ctPageRows.map((r, i) => {
                    const rowBg  = (ctPageStart + i) % 2 === 0 ? '#fff' : '#F9FAFB'
                    const dvtPhu = r.ma_dvt_kiem || ''
                    const hs     = r.he_so_quy_doi ?? 1
                    const tenKho   = khoMap[thuaThieuDetail.ma_kho] || thuaThieuDetail.ma_kho || ''
                    const maPhien  = r.phien_id ? '#' + r.phien_id.slice(-4).toUpperCase() : ''
                    const thoiGian = r.created_at ? (() => {
                      const d = new Date(r.created_at)
                      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
                    })() : ''
                    const metaSub = [maPhien, r._nguoi_nhap, thoiGian].filter(Boolean).join(' · ')
                    const isSelectedCt = kiemKeSelected?.id === r.id
                    const bg = isSelectedCt ? '#EFF6FF' : rowBg
                    const td = { background: bg, verticalAlign: 'middle', padding: '8px 4px', borderBottom: isSelectedCt ? 'none' : '1px solid #F3F4F6' }
                    return <>
                      <tr key={r.id || i} style={{ cursor: 'pointer' }} onClick={() => setKiemKeSelected(isSelectedCt ? null : r)}>
                        <td style={{ ...td, padding: '8px 4px 8px 10px' }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: '#1d9e75', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.ma_vt}</div>
                          <div style={{ fontSize: 11, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.ten_vt}</div>
                          {tenKho && <div style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>{tenKho}</div>}
                          {metaSub && <div style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{metaSub}</div>}
                        </td>
                        <td style={{ ...td, textAlign: 'center', fontSize: 15, fontWeight: 700 }}>
                          {fmtSL(r.so_luong_thuc_te)}
                        </td>
                        <td style={{ ...td, textAlign: 'center', fontSize: 10, color: 'var(--text-muted)' }}>
                          {dvtPhu}
                        </td>
                        <td style={{ ...td, textAlign: 'center', fontSize: 10, color: 'var(--text-muted)' }}>
                          ×{fmtSL(hs)}
                        </td>
                        <td style={{ ...td, textAlign: 'center', fontSize: 15, fontWeight: 700, color: '#1d9e75' }}>
                          {r.so_luong_quy_doi != null ? fmtSL(r.so_luong_quy_doi) : '—'}
                        </td>
                        <td style={{ ...td, textAlign: 'center', fontSize: 10, color: 'var(--text-muted)' }}>
                          {dvtChinh}
                        </td>
                      </tr>
                      {isSelectedCt && (
                        <tr key={`a-${r.id || i}`}>
                          <td colSpan={6} style={{ padding: '4px 10px 9px', background: '#EFF6FF', borderBottom: '2px solid #BFDBFE' }}>
                            <div style={{ display: 'flex', gap: 16 }}>
                              <span onClick={e => {
                                e.stopPropagation()
                                if (currentUser.role !== 'admin' && r.nguoi_nhap_id !== currentUser.id) setWarningMsg('Bạn chỉ có thể sửa dòng do chính mình nhập.')
                                else openDetail(r, true)
                              }} style={{ fontSize: 12, fontWeight: 600, color: '#D97706', cursor: 'pointer' }}>Sửa</span>
                              <span onClick={e => { e.stopPropagation(); setConfirmXoaKiemKe(true) }}
                                style={{ fontSize: 12, fontWeight: 600, color: '#DC2626', cursor: 'pointer' }}>Xóa</span>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  })}
                </tbody>
              </table>
            </div>
            <div style={{
              flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: 8, padding: '8px 16px', borderTop: '1px solid var(--border)', background: '#fff',
            }}>
              <button onClick={() => setChiTietPage(1)} disabled={chiTietPage === 1} style={ctBtnStyle(chiTietPage === 1)}>«</button>
              <button onClick={() => setChiTietPage(p => p - 1)} disabled={chiTietPage === 1} style={ctBtnStyle(chiTietPage === 1)}>‹</button>
              <span style={{ fontSize: 13, fontWeight: 500, minWidth: 90, textAlign: 'center' }}>
                Trang {chiTietPage} / {ctTotalPages}
              </span>
              <button onClick={() => setChiTietPage(p => p + 1)} disabled={chiTietPage === ctTotalPages} style={ctBtnStyle(chiTietPage === ctTotalPages)}>›</button>
              <button onClick={() => setChiTietPage(ctTotalPages)} disabled={chiTietPage === ctTotalPages} style={ctBtnStyle(chiTietPage === ctTotalPages)}>»</button>
            </div>
          </div>
        )
      })()}

      {/* ── Phiên picker (nhiều phiên cùng user) ── */}
      {showPhienPicker && thuaThieuDetail && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: '#fff', display: 'flex', flexDirection: 'column', maxWidth: 480, margin: '0 auto' }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 2 }}>Chọn phiên kiểm kê</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{thuaThieuDetail.ma_vt} · {thuaThieuDetail.ten_vt}</div>
            <div style={{ fontSize: 11, color: '#6B7280', marginTop: 4 }}>Chọn 1 lần, app sẽ nhớ cho các lần bấm sau.</div>
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {phienPickerCandidates.map(id => {
              const p = phienList.find(p => p.id === id)
              if (!p) return null
              const isMine = p.ke_toan_id === currentUser.id || p.thu_kho_id === currentUser.id
              const kt = userMap[p.ke_toan_id]?.ho_ten || '?'
              const tk = userMap[p.thu_kho_id]?.ho_ten || '?'
              return (
                <div key={id} onClick={() => { setMiniKiemKePhienId(id); setRememberedPhienId(id); setShowPhienPicker(false); setShowMiniKiemKe(true) }}
                  style={{ padding: '14px 16px', borderBottom: '1px solid #F3F4F6', cursor: 'pointer', background: isMine ? '#F0FDF4' : '#fff' }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>
                    {p.ngay_kiem} · #{id.slice(-4).toUpperCase()}
                    {isMine && <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--green)', fontWeight: 700 }}>● Phiên của bạn</span>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                    {khoMap[p.ma_kho] || p.ma_kho} · KT: {kt} · TK: {tk}
                  </div>
                </div>
              )
            })}
          </div>
          <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)' }}>
            <button className="btn-secondary" style={{ width: '100%' }}
              onClick={() => { setShowPhienPicker(false); if (miniKiemKePhienId) setShowMiniKiemKe(true) }}>
              Hủy
            </button>
          </div>
        </div>
      )}

      {/* ── MiniKiemKe ── */}
      {showMiniKiemKe && thuaThieuDetail && miniKiemKePhienId && (
        <MiniKiemKe
          vt={{ ma_vt: thuaThieuDetail.ma_vt, ten_vt: thuaThieuDetail.ten_vt }}
          initKho={thuaThieuDetail.ma_kho}
          soSachInit={thuaThieuDetail.so_luong_so_sach}
          phienId={miniKiemKePhienId}
          phienInfo={(() => {
            const p = phienList.find(x => x.id === miniKiemKePhienId)
            if (!p) return null
            return {
              label: `${p.ngay_kiem.split('-').reverse().join('/')} · #${miniKiemKePhienId.slice(-4).toUpperCase()}`,
              kt: userMap[p.ke_toan_id]?.ho_ten || '',
              tk: userMap[p.thu_kho_id]?.ho_ten || '',
            }
          })()}
          currentUser={currentUser}
          khoList={khoList}
          danhMucDvt={danhMucDvt}
          dvtChinhMap={vtDvtChinhMap}
          dvtMap={dvtMap}
          onHuy={() => { setShowMiniKiemKe(false); setMiniKiemKePhienId(null); setThuaThieuDetail(null) }}
          onSaved={loadData}
          onDoiPhien={(() => {
            // "Đổi phiên" luôn khả dụng nếu user thuộc >1 phiên — không chỉ giới hạn trong các
            // candidates ban đầu của riêng mặt hàng đang nhập (auto-chọn 1 vẫn cho đổi sang phiên khác).
            const ownIds = phienList
              .filter(p => p.ke_toan_id === currentUser.id || p.thu_kho_id === currentUser.id)
              .map(p => p.id)
            return ownIds.length > 1
              ? () => { setPhienPickerCandidates(ownIds); setShowMiniKiemKe(false); setShowPhienPicker(true) }
              : undefined
          })()}
        />
      )}

      {toastMsg && (
        <div style={{
          position: 'fixed', bottom: 80, left: '50%', transform: 'translateX(-50%)',
          background: '#1D9E75', color: '#fff', padding: '12px 20px',
          borderRadius: 10, fontSize: 14, fontWeight: 500,
          boxShadow: '0 4px 12px rgba(0,0,0,0.2)', zIndex: 999,
          maxWidth: 'calc(100% - 32px)', textAlign: 'center'
        }}>
          ✓ {toastMsg}
        </div>
      )}
    </div>
  )
}
