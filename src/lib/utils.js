export const fmtSL = (n) => {
  if (n == null || n === '') return ''
  const num = Number(n)
  if (isNaN(num)) return ''
  return num.toLocaleString('en-US', { maximumFractionDigits: 3 })
}
