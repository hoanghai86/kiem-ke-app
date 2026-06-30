// src/lib/vatTuSearch.js
// Chỉ mục tìm kiếm vật tư trong RAM — build 1 lần từ IndexedDB (dm_vat_tu),
// sau đó tìm kiếm gần như tức thời thay vì quét tuần tự 40k+ dòng mỗi lần gõ.
//
// Cách tìm: dùng index từ-theo-tiền-tố để LỌC NHANH ra một tập ứng viên (luôn là tập cha
// của kết quả đúng), rồi xác nhận lại bằng khớp NGUYÊN CỤM (chuỗi con liên tục, giữ nguyên
// khoảng trắng/thứ tự người dùng gõ) — giống cách ERP tìm và tô màu từ khóa, không xáo trộn
// thứ tự từ hay khớp rời rạc.
import { db } from './db'
import { toSearchable } from './utils'

let tokenIndex = null   // Map<token, Set<ma_vt>>
let rowsByMaVt = null   // Map<ma_vt, { row, searchTen, searchMa }> — cache sẵn để khỏi normalize lại mỗi lần tìm
let buildPromise = null

// Tên/mã vật tư hay nối số liệu bằng "_", "-", "()", "," ... (vd "ĐL_70g", "150g-170g") —
// tách từ theo MỌI ký tự không phải chữ/số, không chỉ khoảng trắng, để "70g" tìm ra được cả
// những tên dùng dấu nối thay vì khoảng trắng.
const SPLIT_RE = /[^a-z0-9]+/

async function buildIndex() {
  const rows = await db.dm_vat_tu.toArray()
  const idx = new Map()
  const byId = new Map()
  for (const v of rows) {
    const searchTen = toSearchable(v.ten_vt)
    const searchMa = toSearchable(v.ma_vt)
    byId.set(v.ma_vt, { row: v, searchTen, searchMa })
    const tokens = new Set(searchTen.split(SPLIT_RE).filter(Boolean))
    searchMa.split(SPLIT_RE).filter(Boolean).forEach(t => tokens.add(t))
    for (const tok of tokens) {
      let set = idx.get(tok)
      if (!set) { set = new Set(); idx.set(tok, set) }
      set.add(v.ma_vt)
    }
  }
  tokenIndex = idx
  rowsByMaVt = byId
}

export function ensureVatTuIndex() {
  if (!buildPromise) buildPromise = buildIndex()
  return buildPromise
}

// Gọi sau khi dm_vat_tu thay đổi (đồng bộ, thêm/xóa vật tư ngoài sổ sách...).
// Build lại ngầm ngay (không chặn caller) để lần tìm kiếm tiếp theo đã sẵn sàng.
export function invalidateVatTuIndex() {
  buildPromise = null
  ensureVatTuIndex()
}

const byName = (a, b) => (a.searchTen < b.searchTen ? -1 : a.searchTen > b.searchTen ? 1 : 0)
const byMa   = (a, b) => (a.row.ma_vt < b.row.ma_vt ? -1 : a.row.ma_vt > b.row.ma_vt ? 1 : 0)

// Danh sách mặc định (không gõ gì) — sắp theo mã, dùng cho màn hình lọc/duyệt. Sắp theo mã
// TRƯỚC khi cắt theo `limit` — nếu sắp theo tên rồi mới cắt, mã nhỏ (vd "0000000001") có tên
// rơi ngoài top-N-theo-tên sẽ bị cắt mất, không bao giờ xuất hiện được trong danh sách duyệt.
// `limit` không truyền = lấy hết (cẩn thận: dùng cho tìm kiếm có query, không phải duyệt toàn bộ catalog).
export async function listVatTu(limit) {
  await ensureVatTuIndex()
  const all = [...rowsByMaVt.values()].sort(byMa)
  return (limit ? all.slice(0, limit) : all).map(e => e.row)
}

// Trả về kết quả khớp NGUYÊN CỤM đã gõ (chuỗi con liên tục trong mã hoặc tên), sắp theo vị trí
// khớp càng sớm càng ưu tiên — giống ERP. Không truyền `limit` = lấy hết, không cắt bớt.
export async function searchVatTu(query, limit) {
  await ensureVatTuIndex()
  const fullQ = toSearchable(query).trim()
  if (!fullQ) return []
  const words = fullQ.split(SPLIT_RE).filter(Boolean)
  if (words.length === 0) return []

  // Lọc nhanh qua index: ứng viên phải có ít nhất 1 token bắt đầu bằng mỗi từ trong query.
  // Đây luôn là tập CHA của kết quả khớp nguyên cụm thật (an toàn để thu hẹp trước).
  let matchedIds = null
  for (const w of words) {
    const forWord = new Set()
    for (const [tok, ids] of tokenIndex) {
      if (tok.startsWith(w)) for (const id of ids) forWord.add(id)
    }
    matchedIds = matchedIds ? new Set([...matchedIds].filter(id => forWord.has(id))) : forWord
    if (matchedIds.size === 0) break
  }
  if (!matchedIds || matchedIds.size === 0) return []

  // Xác nhận lại bằng khớp nguyên cụm thật (giữ nguyên khoảng trắng/thứ tự đã gõ)
  const matches = []
  for (const id of matchedIds) {
    const entry = rowsByMaVt.get(id)
    if (!entry) continue
    const maIdx = entry.searchMa.indexOf(fullQ)
    const tenIdx = maIdx === -1 ? entry.searchTen.indexOf(fullQ) : -1
    if (maIdx === -1 && tenIdx === -1) continue
    matches.push({ entry, pos: maIdx !== -1 ? maIdx : tenIdx, inMa: maIdx !== -1 })
  }
  if (matches.length === 0) return []

  // Ưu tiên khớp ở mã trước khớp ở tên, vị trí khớp càng sớm càng ưu tiên; hoà thì khớp-ở-mã
  // sắp theo mã tăng dần, khớp-ở-tên sắp theo tên.
  matches.sort((a, b) => {
    if (a.inMa !== b.inMa) return a.inMa ? -1 : 1
    if (a.pos !== b.pos) return a.pos - b.pos
    if (a.inMa) return a.entry.searchMa < b.entry.searchMa ? -1 : a.entry.searchMa > b.entry.searchMa ? 1 : 0
    return byName(a.entry, b.entry)
  })

  const sliced = limit ? matches.slice(0, limit) : matches
  return sliced.map(m => m.entry.row)
}

// Tách text gốc thành 3 phần quanh đoạn khớp với query, để render tô màu từ khóa (giống ERP).
// Dựa trên việc toSearchable() giữ nguyên độ dài/vị trí ký tự so với text gốc (chỉ hạ chữ hoa +
// bỏ dấu), nên vị trí khớp trên chuỗi đã chuẩn hoá ánh xạ thẳng sang chuỗi gốc.
export function splitHighlight(text, query) {
  const q = toSearchable(query).trim()
  if (!text || !q) return { before: text || '', match: '', after: '' }
  const idx = toSearchable(text).indexOf(q)
  if (idx === -1) return { before: text, match: '', after: '' }
  return {
    before: text.slice(0, idx),
    match: text.slice(idx, idx + q.length),
    after: text.slice(idx + q.length),
  }
}
