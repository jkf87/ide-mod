#!/usr/bin/env node
// ide-mod의 PDF 뷰어 엔진. pdf.js로 쪽의 글자·선 좌표를 꺼내 HWP와 같은 글자 격자로 그리고,
// 쪽 그림은 poppler의 pdftoppm으로 만든다. JSON 한 줄을 stdout에 쓴다.
//   node pdf-view.mjs text <파일>              → {format:'pdf', pages, residues}
//   node pdf-view.mjs grid <파일> <쪽> <칸>     → {pages, page, cols, width, rows}
//   node pdf-view.mjs page <파일> <쪽>          → {pages, page, pngPath?, pngWidth?, pngHeight?, svg?}

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import url from 'node:url'

import { isWide, layoutGrid } from './grid.mjs'

const here = path.dirname(url.fileURLToPath(import.meta.url))
const vendor = path.join(here, '..', 'vendor', 'pdfjs')
const SVG_INLINE_MAX = 131_072

// pdf.js는 불러올 때 브라우저의 그리기 클래스를 찾는다. 글자·경로만 쓰므로 빈 껍데기로 채운다
class StubMatrix {
  constructor() {
    Object.assign(this, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
  }
  multiplySelf() { return this }
  preMultiplySelf() { return this }
  translate() { return this }
  scale() { return this }
  invertSelf() { return this }
}
for (const [name, value] of [['DOMMatrix', StubMatrix], ['ImageData', class {}], ['Path2D', class {}]]) {
  if (globalThis[name] === undefined) globalThis[name] = value
}

async function loadPdfjs() {
  // 불러오는 동안 나오는 경고는 stdout(JSON)에 섞이지 않게 stderr로 돌린다
  const log = console.log
  console.log = (...args) => console.error(...args)
  try {
    return await import(url.pathToFileURL(path.join(vendor, 'pdf.mjs')).href)
  } finally {
    console.log = log
  }
}

async function openDocument(file) {
  const pdfjs = await loadPdfjs()
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(file)),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
    cMapUrl: `${path.join(vendor, 'cmaps')}/`,
    cMapPacked: true,
  }).promise
  return { pdfjs, doc }
}

/** 점 하나를 변환 행렬로 옮긴다 (pdf.js 5의 Util.applyTransform은 제자리에서 바꾸고 값을 돌려주지 않는다) */
const apply = ([x, y], m) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

const pageIndex = (arg, pages) => Math.min(Math.max(0, Number.parseInt(arg ?? '0', 10) || 0), Math.max(0, pages - 1))

/** pdf.js 쪽 하나에서 글자(기준선 좌표)와 가로·세로선을 꺼낸다. 좌표는 위에서 아래로 y가 커진다 */
async function pageShapes(pdfjs, page) {
  const { Util, OPS } = pdfjs
  const viewport = page.getViewport({ scale: 1 })
  const ops = await page.getOperatorList()
  const content = await page.getTextContent()

  const glyphs = []
  for (const item of content.items) {
    if (typeof item.str !== 'string' || item.str === '') continue
    const tx = Util.transform(viewport.transform, item.transform)
    const size = Math.hypot(tx[2], tx[3]) || item.height || 10
    let fontName = ''
    try {
      fontName = page.commonObjs.has(item.fontName) ? String(page.commonObjs.get(item.fontName)?.name ?? '') : ''
    } catch {
      fontName = ''
    }
    const bold = /bold|black|heavy|-b$|extrab|semib/i.test(fontName)
    const chars = [...item.str]
    const weight = ch => (ch.trim() === '' ? 0.33 : isWide(ch.codePointAt(0) ?? 0) ? 1 : 0.55)
    const total = chars.reduce((n, ch) => n + weight(ch), 0) || 1
    const width = Math.abs(item.width) * Math.hypot(viewport.transform[0], viewport.transform[1])
    let used = 0
    for (const ch of chars) {
      if (ch.trim() !== '') glyphs.push({ ch, x: tx[4] + (width * used) / total, y: tx[5], size, bold, color: undefined })
      used += weight(ch)
    }
  }

  // 경로: 획(stroke)의 수직·수평 선분, 그리고 아주 얇게 칠한 사각형(표 테두리로 많이 쓰인다)을 선으로 본다
  const hLines = []
  const vLines = []
  const strokes = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke])
  const fills = new Set([OPS.fill, OPS.eoFill])
  const addSegment = (p, q) => {
    if (Math.abs(p[1] - q[1]) < 0.8 && Math.abs(p[0] - q[0]) > 2) hLines.push({ y: (p[1] + q[1]) / 2, x1: Math.min(p[0], q[0]), x2: Math.max(p[0], q[0]) })
    else if (Math.abs(p[0] - q[0]) < 0.8 && Math.abs(p[1] - q[1]) > 2) vLines.push({ x: (p[0] + q[0]) / 2, y1: Math.min(p[1], q[1]), y2: Math.max(p[1], q[1]) })
  }
  let ctm = viewport.transform
  const stack = []
  for (let i = 0; i < ops.fnArray.length; i += 1) {
    const fn = ops.fnArray[i]
    const args = ops.argsArray[i]
    if (fn === OPS.save) stack.push(ctm)
    else if (fn === OPS.restore) ctm = stack.pop() ?? viewport.transform
    else if (fn === OPS.transform) ctm = Util.transform(ctm, args)
    else if (fn === OPS.constructPath) {
      const [paint, [data] = [], minMax] = args
      if (!strokes.has(paint) && !fills.has(paint)) continue
      if (data === undefined || data === null) continue
      // 경로 자료: 0 moveTo(x,y), 1 lineTo(x,y), 2 curveTo(6), 3 quadraticCurveTo(4), 4 closePath
      const points = []
      const polylines = []
      let start
      for (let k = 0; k < data.length; ) {
        const op = data[k]
        if (op === 0 || op === 1) {
          const p = apply([data[k + 1], data[k + 2]], ctm)
          if (op === 0) {
            if (points.length > 1) polylines.push([...points])
            points.length = 0
            start = p
          }
          points.push(p)
          k += 3
        } else if (op === 2) k += 7
        else if (op === 3) k += 5
        else {
          if (start !== undefined) points.push(start)
          k += 1
        }
      }
      if (points.length > 1) polylines.push([...points])
      if (strokes.has(paint)) {
        for (const line of polylines) for (let k = 1; k < line.length; k += 1) addSegment(line[k - 1], line[k])
      } else if (minMax) {
        // 칠한 도형은 얇은 막대일 때만 선으로 본다 (칸 바탕색은 버린다)
        const a = apply([minMax[0], minMax[1]], ctm)
        const b = apply([minMax[2], minMax[3]], ctm)
        const [x1, x2] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])]
        const [y1, y2] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])]
        if (y2 - y1 <= 1.5 && x2 - x1 > 2) hLines.push({ y: (y1 + y2) / 2, x1, x2 })
        else if (x2 - x1 <= 1.5 && y2 - y1 > 2) vLines.push({ x: (x1 + x2) / 2, y1, y2 })
      }
    }
  }
  return { glyphs, hLines, vLines, viewport }
}

async function textMode(file) {
  const { doc } = await openDocument(file)
  try {
    return { format: 'pdf', pages: doc.numPages, residues: [] }
  } finally {
    await doc.destroy()
  }
}

async function gridMode(file, pageArg, colsArg) {
  const { pdfjs, doc } = await openDocument(file)
  try {
    const index = pageIndex(pageArg, doc.numPages)
    const page = await doc.getPage(index + 1)
    const shapes = await pageShapes(pdfjs, page)
    const cols = Math.min(400, Math.max(20, Number.parseInt(colsArg ?? '80', 10) || 80))
    return { pages: doc.numPages, page: index, cols, ...layoutGrid(shapes, cols) }
  } finally {
    await doc.destroy()
  }
}

const has = cmd => spawnSync('which', [cmd]).status === 0

async function pageMode(file, pageArg) {
  const { doc } = await openDocument(file)
  let pages
  let index
  let width
  let height
  try {
    pages = doc.numPages
    index = pageIndex(pageArg, pages)
    const vp = (await doc.getPage(index + 1)).getViewport({ scale: 1 })
    width = vp.width
    height = vp.height
  } finally {
    await doc.destroy()
  }
  const stat = fs.statSync(file)
  const key = crypto.createHash('sha1').update(`${path.resolve(file)}|${stat.mtimeMs}|${stat.size}`).digest('hex').slice(0, 16)
  const dir = path.join(os.tmpdir(), 'ide-mod-pdf', key)
  fs.mkdirSync(dir, { recursive: true })
  if (!has('pdftoppm')) return { pages, page: index, error: '쪽 그림을 만들려면 poppler의 pdftoppm이 필요해요 (brew install poppler). 문서 보기는 그대로 쓸 수 있어요' }
  const n = String(index + 1)
  const base = path.join(dir, `page-${index}`)
  const pngPath = `${base}.png`
  if (!fs.existsSync(pngPath)) {
    const dpi = String(Math.round(Math.min(300, Math.max(60, (1400 / width) * 72))))
    spawnSync('pdftoppm', ['-png', '-r', dpi, '-f', n, '-l', n, '-singlefile', file, base], { timeout: 30_000 })
  }
  // 데스크톱 앱용: 작은 JPEG를 SVG 안에 넣어 Svg 요소 한도(131072자) 안으로
  let svg
  for (const scale of [1000, 800, 600]) {
    const jpgBase = path.join(dir, `page-${index}-${scale}`)
    if (!fs.existsSync(`${jpgBase}.jpg`)) spawnSync('pdftoppm', ['-jpeg', '-jpegopt', 'quality=70', '-scale-to', String(scale), '-f', n, '-l', n, '-singlefile', file, jpgBase], { timeout: 30_000 })
    if (!fs.existsSync(`${jpgBase}.jpg`)) break
    const b64 = fs.readFileSync(`${jpgBase}.jpg`).toString('base64')
    const doc = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image href="data:image/jpeg;base64,${b64}" width="${width}" height="${height}"/></svg>`
    if (doc.length <= SVG_INLINE_MAX) {
      svg = doc
      break
    }
  }
  const ihdr = fs.existsSync(pngPath) ? fs.readFileSync(pngPath).subarray(16, 24) : undefined
  return {
    pages,
    page: index,
    pngPath: ihdr === undefined ? undefined : pngPath,
    pngWidth: ihdr?.readUInt32BE(0),
    pngHeight: ihdr?.readUInt32BE(4),
    svg,
  }
}

const realOf = file => {
  try {
    return fs.realpathSync(file)
  } catch {
    return path.resolve(file)
  }
}
const isMain = process.argv[1] !== undefined && realOf(process.argv[1]) === realOf(url.fileURLToPath(import.meta.url))
if (isMain) {
  const [mode, file, page, cols] = process.argv.slice(2)
  try {
    if (file === undefined || !fs.existsSync(file)) throw new Error(`파일이 없음: ${file ?? ''}`)
    let result
    if (mode === 'text') result = await textMode(file)
    else if (mode === 'grid') result = await gridMode(file, page, cols)
    else if (mode === 'page') result = await pageMode(file, page)
    else throw new Error('사용법: pdf-view.mjs text|grid|page <파일> [쪽] [칸]')
    process.stdout.write(JSON.stringify(result))
  } catch (error) {
    if (process.env.IDE_MOD_DEBUG) console.error(error)
    process.stdout.write(JSON.stringify({ error: String(error instanceof Error ? error.message : error) }))
    process.exitCode = 1
  }
}
