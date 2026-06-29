export const toSearchable = (str) =>
  (str || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd')

export const fmtSL = (n) => {
  if (n == null || n === '') return ''
  const num = Number(n)
  if (isNaN(num)) return ''
  return num.toLocaleString('en-US', { maximumFractionDigits: 3 })
}
