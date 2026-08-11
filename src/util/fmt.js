const useColor = process.stdout.isTTY && !process.env.NO_COLOR

const wrap = (code) => (text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : String(text))

export const color = {
  dim: wrap('2'),
  bold: wrap('1'),
  green: wrap('32'),
  yellow: wrap('33'),
  red: wrap('31'),
  blue: wrap('34'),
  magenta: wrap('35')
}

export function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
  return `${Math.floor(h / 24)} d`
}

export function bytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '-'
  const units = ['B', 'kB', 'MB', 'GB']
  let value = n
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value < 10 && i > 0 ? value.toFixed(1) : Math.round(value)} ${units[i]}`
}

export function timestamp(date = new Date()) {
  return date.toLocaleTimeString('de-DE', { hour12: false })
}

export function dateTime(value) {
  if (!value) return '-'
  return new Date(value).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

const visibleLength = (text) => String(text).replace(/\u001b\[\d+m/g, '').length

export function table(rows, { head = [], gap = 2 } = {}) {
  const all = head.length ? [head, ...rows] : rows
  if (!all.length) return ''
  const widths = []
  for (const row of all) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, visibleLength(cell))
    })
  }
  const line = (row) =>
    row
      .map((cell, i) => String(cell) + ' '.repeat(Math.max(0, widths[i] - visibleLength(cell))))
      .join(' '.repeat(gap))
      .trimEnd()
  const out = []
  if (head.length) out.push(color.dim(line(head)))
  for (const row of rows) out.push(line(row))
  return out.join('\n')
}
