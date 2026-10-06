#!/usr/bin/env node
// ide-mod의 HWP/HWPX 뷰어 엔진. rhwp(WASM)로 문서를 읽어 JSON 한 줄을 stdout에 쓴다.
//   node rhwp-view.mjs text <파일>          → {format, pages, blocks:[{t:'p',text}|{t:'table',rows}], residues}
//   node rhwp-view.mjs page <파일> <쪽번호>  → {pages, page, svgPath, svg?, pngPath?}
//   node rhwp-view.mjs grid <파일> <쪽번호> <칸> → {pages, page, cols, width, rows:[[{t,b?,c?,l?,r?}]]} 글자 격자로 그린 쪽
// mod는 Node가 없는 환경에서 돌기 때문에 이 스크립트를 $.process.run으로 부른다.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import url from 'node:url'
import zlib from 'node:zlib'

const here = path.dirname(url.fileURLToPath(import.meta.url))
const vendor = path.join(here, '..', 'vendor', 'rhwp')
// 데스크톱 앱의 Svg 요소가 받는 source 최대 길이
const SVG_INLINE_MAX = 131_072

const reply = value => {
  process.stdout.write(JSON.stringify(value))
}

// rhwp가 글자 폭을 물을 때 쓰는 추정치 (한글·한자는 글자 크기만큼, 나머지는 절반 남짓)
globalThis.measureTextWidth = (font, text) => {
  const match = String(font ?? '').match(/([0-9.]+)px/)
  const size = match ? Number.parseFloat(match[1]) : 12
  let width = 0
  for (const ch of String(text ?? '')) {
    const cp = ch.codePointAt(0) ?? 0
    width += cp >= 0x1100 && cp <= 0xffdc ? size : size * 0.55
  }
  return width
}

async function openDocument(file) {
  const rhwp = await import(url.pathToFileURL(path.join(vendor, 'rhwp.js')).href)
  await rhwp.default({ module_or_path: fs.readFileSync(path.join(vendor, 'rhwp_bg.wasm')) })
  return new rhwp.HwpDocument(new Uint8Array(fs.readFileSync(file)))
}

/** zip(HWPX)에서 이름이 맞는 항목들을 꺼낸다 */
function unzipEntries(buffer, wanted) {
  let eocd = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('zip 끝 레코드를 찾지 못함')
  const count = buffer.readUInt16LE(eocd + 10)
  let at = buffer.readUInt32LE(eocd + 16)
  const out = new Map()
  for (let n = 0; n < count; n += 1) {
    const method = buffer.readUInt16LE(at + 10)
    const size = buffer.readUInt32LE(at + 20)
    const nameLength = buffer.readUInt16LE(at + 28)
    const extraLength = buffer.readUInt16LE(at + 30)
    const commentLength = buffer.readUInt16LE(at + 32)
    const local = buffer.readUInt32LE(at + 42)
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength)
    at += 46 + nameLength + extraLength + commentLength
    if (!wanted(name)) continue
    const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28)
    const raw = buffer.subarray(dataStart, dataStart + size)
    out.set(name, (method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8'))
  }
  return out
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decode = text =>
  text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, code) =>
    code[0] === '#'
      ? String.fromCodePoint(code[1].toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10))
      : ENTITIES[code] ?? whole,
  )

/** OWPML 본문 XML을 문단·표 블록으로 바꾼다 (표 안의 표는 셀 글자로 펼친다) */
export function sectionBlocks(xml) {
  const blocks = []
  const tables = [] // 열린 표 스택: {rows, row, cell}
  let para = null
  let inText = false
  const tag = /<(\/?)([\w:]+)([^>]*?)(\/?)>|([^<]+)/g
  for (let m = tag.exec(xml); m !== null; m = tag.exec(xml)) {
    const [, closing, name, , selfClosing, text] = m
    if (text !== undefined) {
      if (inText && para !== null) para.push(decode(text))
      continue
    }
    const local = name.replace(/^\w+:/, '')
    if (local === 't') {
      inText = !closing && !selfClosing
      continue
    }
    if (para !== null && !closing && (local === 'tab')) para.push(' ')
    if (para !== null && !closing && (local === 'lineBreak')) para.push('\n')
    if (local === 'p') {
      if (!closing && !selfClosing) para = []
      else if (closing && para !== null) {
        const line = para.join('').replace(/\t/g, ' ').replace(/ {2,}/g, ' ').replace(/ +\n/g, '\n').trim()
        const table = tables[tables.length - 1]
        if (table?.cell != null) {
          if (line !== '') table.cell.push(line)
        } else if (line !== '') {
          blocks.push({ t: 'p', text: line })
        }
        para = null
      }
      continue
    }
    if (local === 'tbl') {
      if (!closing && !selfClosing) {
        // 문단 안에서 표가 시작되면 지금까지의 글자를 먼저 내보낸다
        if (para !== null && tables.length === 0) {
          const before = para.join('').trim()
          if (before !== '') blocks.push({ t: 'p', text: before })
          para = []
        }
        tables.push({ rows: [], row: null, cell: null, saved: para })
        para = null
      } else if (closing) {
        const done = tables.pop()
        para = done?.saved ?? null
        const parent = tables[tables.length - 1]
        if (parent?.cell != null) parent.cell.push(done.rows.map(r => r.join(' / ')).join(' / '))
        else if (done !== undefined && done.rows.length > 0) blocks.push({ t: 'table', rows: done.rows })
      }
      continue
    }
    const table = tables[tables.length - 1]
    if (table === undefined) continue
    if (local === 'tr') {
      if (!closing) {
        table.row = []
        table.rows.push(table.row)
      } else table.row = null
    } else if (local === 'tc') {
      if (!closing) table.cell = []
      else if (table.row !== null) {
        table.row.push((table.cell ?? []).join(' ').replace(/\s+/g, ' ').trim())
        table.cell = null
      }
    }
  }
  return blocks
}

const residuesOf = blocks => {
  const found = new Set()
  const scan = text => {
    for (const m of text.matchAll(/\{\{[^{}\n]{1,60}\}\}/g)) found.add(m[0])
  }
  for (const block of blocks) {
    if (block.t === 'p') scan(block.text)
    else for (const row of block.rows) for (const cell of row) scan(cell)
  }
  return [...found]
}

function textMode(file) {
  return openDocument(file).then(doc => {
    try {
      const format = doc.getSourceFormat()
      const pages = doc.pageCount()
      const entries = unzipEntries(Buffer.from(doc.exportHwpx()), name => /^Contents\/section\d+\.xml$/.test(name))
      const names = [...entries.keys()].sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
      const blocks = names.flatMap(name => sectionBlocks(entries.get(name) ?? ''))
      return { format, pages, blocks, residues: residuesOf(blocks) }
    } finally {
      doc.free()
    }
  })
}

// ── 쪽을 터미널 글자 격자로 (그래픽이 없는 터미널에서 HWP 모양 그대로 보기) ──
const isWide = cp =>
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
const textColor = fill => {
  const m = /^#([0-9a-f]{6})$/i.exec(fill ?? '')
  if (!m) return undefined
  const [r, g, b] = [0, 2, 4].map(i => Number.parseInt(m[1].slice(i, i + 2), 16))
  return Math.max(r, g, b) - Math.min(r, g, b) > 60 ? `#${m[1]}` : undefined
}

/** rhwp가 그린 쪽 SVG를 cols칸짜리 글자 격자로: 글자는 제자리에, 선은 상자 문자로 */
export function pageGrid(svg, cols) {
  const body = svg.replace(/<defs>[\s\S]*?<\/defs>/g, '').replace(/<clipPath[\s\S]*?<\/clipPath>/g, '')
  const attrs = raw => Object.fromEntries([...raw.matchAll(/([\w:-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]))
  const glyphs = []
  const hLines = []
  const vLines = []
  const dots = []
  for (const m of body.matchAll(/<circle\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1])
    if (Number(a.r) > 0 && Number(a.r) < 4) dots.push({ x: Number(a.cx) - Number(a.r), cy: Number(a.cy) })
  }
  for (const m of body.matchAll(/<(text|line|rect)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g)) {
    const [, tag, raw, inner] = m
    const a = attrs(raw)
    if (tag === 'text') {
      const text = decode((inner ?? '').replace(/<[^>]+>/g, ''))
      const size = Number(a['font-size'] ?? 12)
      let x = Number(a.x)
      for (const ch of text) {
        if (ch.trim() !== '') {
          glyphs.push({ ch, x, y: Number(a.y), size, bold: a['font-weight'] === 'bold' || Number(a['font-weight']) >= 600, color: textColor(a.fill) })
        }
        x += isWide(ch.codePointAt(0) ?? 0) ? size : size * 0.55
      }
    } else if (tag === 'line') {
      if (a.stroke === 'none') continue
      const [x1, y1, x2, y2] = [a.x1, a.y1, a.x2, a.y2].map(Number)
      if (Math.abs(y1 - y2) < 1) hLines.push({ y: (y1 + y2) / 2, x1: Math.min(x1, x2), x2: Math.max(x1, x2) })
      else if (Math.abs(x1 - x2) < 1) vLines.push({ x: (x1 + x2) / 2, y1: Math.min(y1, y2), y2: Math.max(y1, y2) })
    } else if (a.stroke !== undefined && a.stroke !== 'none' && Number(a['stroke-width'] ?? 1) > 0) {
      const [x, y, w, h] = [a.x, a.y, a.width, a.height].map(Number)
      hLines.push({ y, x1: x, x2: x + w }, { y: y + h, x1: x, x2: x + w })
      vLines.push({ x, y1: y, y2: y + h }, { x: x + w, y1: y, y2: y + h })
    }
  }
  if (glyphs.length === 0 && hLines.length === 0) return { width: 0, rows: [] }
  // rhwp는 가운뎃점(·)을 작은 원으로 그린다: 글줄 높이에 있는 작은 원은 '·' 글자로 되돌린다
  const sizeNear = cy => glyphs.reduce((best, g) => (Math.abs(g.y - g.size * 0.35 - cy) < Math.abs(best.y - best.size * 0.35 - cy) ? g : best), glyphs[0])
  for (const d of dots) {
    if (glyphs.length === 0) break
    const near = sizeNear(d.cy)
    if (Math.abs(near.y - near.size * 0.35 - d.cy) <= near.size * 0.6) glyphs.push({ ch: '·', x: d.x, y: near.y, size: near.size, bold: false, color: undefined })
  }

  // 세로: 글줄(가운데 높이)과 가로선을 높이 순서대로 줄 세워 한 줄에 하나씩 둔다
  const levels = []
  for (const g of glyphs) levels.push({ y: g.y - g.size * 0.35, isText: true, tol: Math.max(3, g.size * 0.4) })
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

async function gridMode(file, pageArg, colsArg) {
  const page = await pageMode(file, pageArg, { png: false })
  const svg = fs.readFileSync(page.svgPath, 'utf8')
  const cols = Math.min(400, Math.max(20, Number.parseInt(colsArg ?? '80', 10) || 80))
  return { pages: page.pages, page: page.page, cols, ...pageGrid(svg, cols) }
}

/**
 * 데스크톱 앱의 Svg 요소(최대 131072자)에 들어가도록 줄인다. rhwp는 글자마다 긴 글꼴 목록을 붙이므로
 * 글꼴은 스타일 한 줄로 모으고(명조·고딕 두 갈래), 좌표는 소수 한 자리로 줄인다.
 */
export function slimSvg(svg) {
  const families = new Map()
  let slim = svg.replace(/ font-family="([^"]*)"/g, (_, family) => {
    if (!families.has(family)) families.set(family, `f${families.size}`)
    return ` class="${families.get(family)}"`
  })
  slim = slim.replace(/(\d+\.\d)\d+/g, '$1')
  const rules = [...families].map(([family, name]) => `.${name}{font-family:${family.replace(/&apos;/g, "'")}}`).join('')
  return slim.replace(/(<svg\b[^>]*>)/, `$1<style>${rules}</style>`)
}

/** SVG를 PNG로: rsvg-convert → resvg → (macOS) qlmanage → 없으면 PNG 없이 */
function toPng(svgPath, pngPath) {
  const tryRun = (cmd, args) => {
    const run = spawnSync(cmd, args, { timeout: 20_000 })
    return run.status === 0 && fs.existsSync(pngPath)
  }
  if (tryRun('rsvg-convert', ['-w', '1400', '-b', 'white', '-o', pngPath, svgPath])) return pngPath
  if (tryRun('resvg', ['-w', '1400', '--background', 'white', svgPath, pngPath])) return pngPath
  if (process.platform === 'darwin') {
    // qlmanage는 정사각형 썸네일을 만들면서 세로로 긴 쪽의 아래를 잘라낸다. 그래서 쪽을 정사각형
    // 흰 바탕 가운데에 놓고 변환한 뒤, sips로 쪽의 가로세로 비율만큼 가운데를 다시 잘라낸다
    const svg = fs.readFileSync(svgPath, 'utf8')
    const size = svg.match(/<svg\b[^>]*?\swidth="([\d.]+)"[^>]*?\sheight="([\d.]+)"/)
    const width = size ? Number(size[1]) : 0
    const height = size ? Number(size[2]) : 0
    const side = Math.max(width, height)
    const squarePath = svgPath.replace(/\.svg$/, '.square.svg')
    if (side > 0) {
      const inner = svg.replace(/^<\?xml[^>]*>\s*/, '').replace(/^<svg\b/, `<svg x="${(side - width) / 2}" y="${(side - height) / 2}"`)
      fs.writeFileSync(
        squarePath,
        `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" viewBox="0 0 ${side} ${side}"><rect width="${side}" height="${side}" fill="white"/>${inner}</svg>`,
      )
    }
    const source = side > 0 ? squarePath : svgPath
    const dir = path.dirname(pngPath)
    const run = spawnSync('qlmanage', ['-t', '-s', '1400', '-o', dir, source], { timeout: 20_000 })
    const made = path.join(dir, `${path.basename(source)}.png`)
    if (run.status === 0 && fs.existsSync(made)) {
      fs.renameSync(made, pngPath)
      if (side > 0) {
        fs.rmSync(squarePath, { force: true })
        const keepH = Math.round((1400 * height) / side)
        const keepW = Math.round((1400 * width) / side)
        spawnSync('sips', ['--cropToHeightWidth', String(keepH), String(keepW), pngPath], { timeout: 20_000 })
      }
      return pngPath
    }
  }
  return undefined
}

async function pageMode(file, pageArg, options = { png: true }) {
  const stat = fs.statSync(file)
  const key = crypto.createHash('sha1').update(`${path.resolve(file)}|${stat.mtimeMs}|${stat.size}`).digest('hex').slice(0, 16)
  const dir = path.join(os.tmpdir(), 'ide-mod-rhwp', key)
  fs.mkdirSync(dir, { recursive: true })
  const doc = await openDocument(file)
  try {
    const pages = doc.pageCount()
    const page = Math.min(Math.max(0, Number.parseInt(pageArg ?? '0', 10) || 0), Math.max(0, pages - 1))
    const svgPath = path.join(dir, `page-${page}.svg`)
    const pngPath = path.join(dir, `page-${page}.png`)
    if (!fs.existsSync(svgPath)) fs.writeFileSync(svgPath, doc.renderPageSvg(page))
    const svg = fs.readFileSync(svgPath, 'utf8')
    const slim = slimSvg(svg)
    const png = fs.existsSync(pngPath) ? pngPath : options.png ? toPng(svgPath, pngPath) : undefined
    const size = svg.match(/width="([\d.]+)"\s+height="([\d.]+)"/)
    // PNG의 실제 크기 (qlmanage는 정사각형 썸네일을 만든다): IHDR의 너비·높이
    const ihdr = png === undefined ? undefined : fs.readFileSync(png).subarray(16, 24)
    return {
      pages,
      page,
      svgPath,
      svg: slim.length <= SVG_INLINE_MAX ? slim : undefined,
      pngPath: png,
      width: size ? Number(size[1]) : undefined,
      height: size ? Number(size[2]) : undefined,
      pngWidth: ihdr?.readUInt32BE(0),
      pngHeight: ihdr?.readUInt32BE(4),
    }
  } finally {
    doc.free()
  }
}

// Node는 실행 파일의 심볼릭 링크를 풀어 import.meta.url에 실제 경로를 넣는다. argv[1]은 링크 경로
// 그대로일 수 있어서(개발 중 mod 폴더 링크, 플러그인 캐시) 둘 다 실제 경로로 풀어 비교한다
const realOf = file => {
  try {
    return fs.realpathSync(file)
  } catch {
    return path.resolve(file)
  }
}
const isMain = process.argv[1] !== undefined && realOf(process.argv[1]) === realOf(url.fileURLToPath(import.meta.url))
if (isMain) {
  const [mode, file, page] = process.argv.slice(2)
  try {
    if (file === undefined || !fs.existsSync(file)) throw new Error(`파일이 없음: ${file ?? ''}`)
    if (mode === 'text') reply(await textMode(file))
    else if (mode === 'page') reply(await pageMode(file, page))
    else if (mode === 'grid') reply(await gridMode(file, page, process.argv[5]))
    else throw new Error('사용법: rhwp-view.mjs text|page <파일> [쪽번호]')
  } catch (error) {
    reply({ error: String(error instanceof Error ? error.message : error) })
    process.exitCode = 1
  }
}
