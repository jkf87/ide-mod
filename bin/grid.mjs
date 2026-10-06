// 쪽 하나를 터미널 글자 격자로 다시 그린다. HWP(rhwp SVG)와 PDF(pdf.js) 뷰어가 함께 쓴다.
// 입력은 쪽 좌표(위에서 아래로 y가 커짐)의 글자·가로선·세로선 목록이다.
//   glyphs: [{ ch, x, y(글자 기준선), size, bold, color }]
//   hLines: [{ y, x1, x2 }], vLines: [{ x, y1, y2 }]
export const isWide = cp =>
  (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff)
const BOX = { 12: '─', 3: '│', 10: '┌', 6: '┐', 9: '└', 5: '┘', 11: '├', 7: '┤', 14: '┬', 13: '┴', 15: '┼', 4: '─', 8: '─', 1: '│', 2: '│' }
const UP = 1
const DOWN = 2
const LEFT = 4
const RIGHT = 8
const median = values => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
/** 회색조가 아닌 글자색만 살린다 (검정·흰색·회색은 터미널 기본색) */
export const textColor = fill => {
  const m = /^#([0-9a-f]{6})$/i.exec(fill ?? '')
  if (!m) return undefined
  const [r, g, b] = [0, 2, 4].map(i => Number.parseInt(m[1].slice(i, i + 2), 16))
  return Math.max(r, g, b) - Math.min(r, g, b) > 60 ? `#${m[1]}` : undefined
}

/** 글자·선 목록을 cols칸짜리 격자로: 글줄마다 한 행, 표 테두리는 상자 문자로 */
// 그림자·외곽선 효과는 같은 글자를 거의 같은 자리에 한 번 더 그린다: 한 번만 남긴다 ("주주요요" → "주요")
export function dedupeGlyphs(glyphs) {
  const kept = []
  const seen = new Map()
  for (const g of glyphs) {
    const near = seen.get(g.ch)?.some(o => Math.abs(o.x - g.x) < g.size * 0.35 && Math.abs(o.y - g.y) < g.size * 0.35)
    if (near) continue
    kept.push(g)
    if (!seen.has(g.ch)) seen.set(g.ch, [])
    seen.get(g.ch).push(g)
  }
  return kept
}

export function layoutGrid({ glyphs: drawn, hLines, vLines }, cols) {
  const glyphs = dedupeGlyphs(drawn)
  if (glyphs.length === 0 && hLines.length === 0) return { width: 0, rows: [] }
  // 세로: 글줄(가운데 높이)과 가로선을 높이 순서대로 줄 세워 한 줄에 하나씩 둔다
  const levels = []
  for (const g of glyphs) levels.push({ y: g.y - g.size * 0.35, isText: true, tol: Math.max(3, g.size * 0.6) })
  for (const l of hLines) levels.push({ y: l.y, isText: false, tol: 1.5 })
  levels.sort((a, b) => a.y - b.y)
  const bands = []
  for (const level of levels) {
    const last = bands[bands.length - 1]
    if (last !== undefined && last.isText === level.isText && level.y - last.y0 <= level.tol) {
      last.ys.push(level.y)
    } else bands.push({ y0: level.y, ys: [level.y], isText: level.isText })
  }
  for (const band of bands) band.y = band.ys.reduce((s, v) => s + v, 0) / band.ys.length
  const textBands = bands.filter(b => b.isText)
  const pitch = median(textBands.slice(1).map((b, i) => b.y - textBands[i].y)) || 20
  let row = 0
  bands.forEach((band, i) => {
    // 문단 사이처럼 크게 벌어진 곳에는 빈 줄 하나를 둔다
    if (i > 0 && band.isText && bands[i - 1].isText && band.y - bands[i - 1].y > pitch * 1.9) row += 1
    band.row = row
    row += 1
  })
  const rowCount = row
  const bandOf = (y, isText) => {
    let best
    for (const band of bands) {
      if (band.isText !== isText) continue
      if (best === undefined || Math.abs(band.y - y) < Math.abs(best.y - y)) best = band
    }
    return best
  }

  // 가로: 한글 한 글자 폭을 두 칸에 맞추되, 쪽이 칸보다 넓으면 줄인다
  const xs = [...glyphs.map(g => g.x), ...glyphs.map(g => g.x + g.size), ...hLines.flatMap(l => [l.x1, l.x2]), ...vLines.map(l => l.x)]
  const x0 = Math.min(...xs)
  const span = Math.max(...xs) - x0
  const advances = []
  const byLine = new Map()
  for (const g of glyphs) {
    const key = bandOf(g.y - g.size * 0.35, true)
    if (!byLine.has(key)) byLine.set(key, [])
    byLine.get(key).push(g)
  }
  for (const line of byLine.values()) {
    line.sort((a, b) => a.x - b.x)
    for (let i = 1; i < line.length; i += 1) {
      const d = line[i].x - line[i - 1].x
      if (isWide(line[i - 1].ch.codePointAt(0) ?? 0) && d > 0 && d < line[i - 1].size * 1.6) advances.push(d)
    }
  }
  const hangul = median(advances) || 16
  // 주어진 폭을 다 쓴다 (한글이 원문보다 좁아져 칸 안에 더 잘 들어간다). 아주 넓으면 너무 벌어지지 않게 막는다
  const pt = Math.max(span / Math.max(1, cols - 1), hangul * 0.3)
  const used = Math.min(cols, Math.ceil(span / pt) + 1)
  const offset = Math.max(0, Math.floor((cols - used) / 2))
  const colOf = x => offset + Math.round((x - x0) / pt)

  const mask = Array.from({ length: rowCount }, () => new Uint8Array(cols))
  const cells = Array.from({ length: rowCount }, () => Array.from({ length: cols }, () => undefined))
  const setMask = (r, c, bits) => {
    if (r >= 0 && r < rowCount && c >= 0 && c < cols) mask[r][c] |= bits
  }
  for (const l of hLines) {
    const r = bandOf(l.y, false)?.row
    if (r === undefined) continue
    const c1 = colOf(l.x1)
    const c2 = colOf(l.x2)
    for (let c = c1; c <= c2; c += 1) setMask(r, c, (c > c1 ? LEFT : 0) | (c < c2 ? RIGHT : 0) | (c1 === c2 ? LEFT | RIGHT : 0))
  }
  for (const l of vLines) {
    const inside = bands.filter(b => b.y >= l.y1 - 1.5 && b.y <= l.y2 + 1.5)
    if (inside.length === 0) continue
    const r1 = inside[0].row
    const r2 = inside[inside.length - 1].row
    const c = colOf(l.x)
    for (let r = r1; r <= r2; r += 1) setMask(r, c, (r > r1 ? UP : 0) | (r < r2 ? DOWN : 0) | (r1 === r2 ? UP | DOWN : 0))
  }
  /** 원문 좌표에서 글자를 둘러싼 세로선 두 개: 그 사이가 글자가 속한 칸이다 */
  const cellOf = (x, yc) => {
    let left
    let right
    for (const l of vLines) {
      if (yc < l.y1 - 1.5 || yc > l.y2 + 1.5) continue
      if (l.x <= x + 0.5 && (left === undefined || l.x > left)) left = l.x
      if (l.x > x + 0.5 && (right === undefined || l.x < right)) right = l.x
    }
    return { key: `${left ?? ''}|${right ?? ''}`, lo: left === undefined ? 0 : colOf(left) + 1, hi: right === undefined ? cols - 1 : colOf(right) - 1 }
  }
  /** 칸 끝에서 잘린 글은 마지막 글자 자리에 …를 둔다 */
  const clip = (r, hi) => {
    let at = hi
    while (at >= 0 && cells[r][at] === undefined) at -= 1
    if (at < 0) return
    if (cells[r][at].ch === '') at -= 1
    const cell = cells[r][at]
    if (cell === undefined || cell.ch === '…') return
    const wasWide = cells[r][at + 1]?.ch === ''
    cells[r][at] = { ch: '…', bold: cell.bold, color: cell.color }
    if (wasWide) cells[r][at + 1] = { ch: ' ', bold: false, color: undefined }
  }

  // 글자는 자기 칸 안에서 원문의 띄어쓰기만 살려 붙여 흘리고, 크게 벌어진 곳(가운데 정렬·탭)만
  // 원래 자리로 옮긴다. 칸 오른쪽 끝을 넘는 글자는 버리고 …로 표시한다
  const ratio = hangul / (median(glyphs.filter(g => isWide(g.ch.codePointAt(0) ?? 0)).map(g => g.size)) || 16)
  const advanceOf = g => (isWide(g.ch.codePointAt(0) ?? 0) ? g.size * ratio : g.size * ratio * 0.55)
  for (const line of byLine.values()) {
    line.sort((a, b) => a.x - b.x)
    const yc = line[0].y - line[0].size * 0.35
    const r = bandOf(yc, true).row
    let cursor = -1
    let prev
    let prevKey
    const clipped = new Set()
    for (const g of line) {
      const w = isWide(g.ch.codePointAt(0) ?? 0) ? 2 : 1
      const home = cellOf(g.x, yc)
      if (clipped.has(home.key)) continue
      const target = Math.max(colOf(g.x), home.lo)
      let c
      if (prev === undefined || prevKey !== home.key) c = target
      else {
        const gap = g.x - (prev.x + advanceOf(prev))
        // 가운뎃점은 앞뒤를 붙이고, 양쪽 정렬로 늘어난 띄어쓰기는 한 칸으로 줄인다
        const isDot = g.ch === '·' || prev.ch === '·'
        const hasSpace = gap > prev.size * (isDot ? 0.6 : 0.18)
        // 원문에서 글자 서너 개 넘게 벌어진 곳(탭·정렬)만 원래 자리로 옮긴다
        c = gap > prev.size * 1.5 ? Math.max(target, cursor + 1) : cursor + (hasSpace ? 1 : 0)
      }
      c = Math.max(c, home.lo)
      while (c <= home.hi && cells[r][c] !== undefined) c += 1
      prev = g
      prevKey = home.key
      if (c + w - 1 > home.hi || c + w > cols) {
        clip(r, home.hi)
        clipped.add(home.key)
        continue
      }
      cells[r][c] = { ch: g.ch, bold: g.bold, color: g.color }
      if (w === 2) cells[r][c + 1] = { ch: '', bold: g.bold, color: g.color }
      cursor = c + w
    }
  }

  const rows = []
  for (let r = 0; r < rowCount; r += 1) {
    const flat = []
    for (let c = 0; c < cols; c += 1) {
      const cell = cells[r][c]
      if (cell !== undefined) flat.push({ ch: cell.ch, b: cell.bold, c: cell.color })
      else if (mask[r][c] !== 0) flat.push({ ch: BOX[mask[r][c]] ?? '┼', l: true })
      else flat.push({ ch: ' ' })
    }
    // 치환 안 된 {{키}}는 빨갛게
    const plain = flat.map(f => f.ch || '\u0000').join('')
    for (const m of plain.matchAll(/\{\{[^{}\n]{1,60}\}\}/g)) for (let i = m.index; i < m.index + m[0].length; i += 1) flat[i].r = true
    const segments = []
    for (const f of flat) {
      if (f.ch === '') continue
      const style = { b: f.b ? 1 : undefined, c: f.r ? undefined : f.c, l: f.l ? 1 : undefined, r: f.r ? 1 : undefined }
      const last = segments[segments.length - 1]
      if (last !== undefined && last.b === style.b && last.c === style.c && last.l === style.l && last.r === style.r) last.t += f.ch
      else segments.push({ t: f.ch, ...style })
    }
    const lastSeg = segments[segments.length - 1]
    if (lastSeg !== undefined && !lastSeg.b && !lastSeg.c && !lastSeg.l && !lastSeg.r) lastSeg.t = lastSeg.t.replace(/ +$/, '')
    rows.push(segments.filter(s => s.t !== ''))
  }
  return { width: used, rows }
}
