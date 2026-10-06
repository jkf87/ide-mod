#!/usr/bin/env node
// ide-mod의 HWP/HWPX 뷰어 엔진. rhwp(WASM)로 문서를 읽어 JSON 한 줄을 stdout에 쓴다.
//   node rhwp-view.mjs text <파일>          → {format, pages, blocks:[{t:'p',text}|{t:'table',rows}], residues}
//   node rhwp-view.mjs page <파일> <쪽번호>  → {pages, page, svgPath, svg?, pngPath?}
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

/** SVG를 PNG로: rsvg-convert → resvg → (macOS) qlmanage → 없으면 PNG 없이 */
function toPng(svgPath, pngPath) {
  const tryRun = (cmd, args) => {
    const run = spawnSync(cmd, args, { timeout: 20_000 })
    return run.status === 0 && fs.existsSync(pngPath)
  }
  if (tryRun('rsvg-convert', ['-w', '1400', '-b', 'white', '-o', pngPath, svgPath])) return pngPath
  if (tryRun('resvg', ['-w', '1400', '--background', 'white', svgPath, pngPath])) return pngPath
  if (process.platform === 'darwin') {
    const dir = path.dirname(pngPath)
    const run = spawnSync('qlmanage', ['-t', '-s', '1400', '-o', dir, svgPath], { timeout: 20_000 })
    const made = `${svgPath}.png`.replace(path.dirname(svgPath), dir)
    if (run.status === 0 && fs.existsSync(made)) {
      fs.renameSync(made, pngPath)
      return pngPath
    }
  }
  return undefined
}

async function pageMode(file, pageArg) {
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
    const png = fs.existsSync(pngPath) ? pngPath : toPng(svgPath, pngPath)
    const size = svg.match(/width="([\d.]+)"\s+height="([\d.]+)"/)
    // PNG의 실제 크기 (qlmanage는 정사각형 썸네일을 만든다): IHDR의 너비·높이
    const ihdr = png === undefined ? undefined : fs.readFileSync(png).subarray(16, 24)
    return {
      pages,
      page,
      svgPath,
      svg: svg.length <= SVG_INLINE_MAX ? svg : undefined,
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

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)
if (isMain) {
  const [mode, file, page] = process.argv.slice(2)
  try {
    if (file === undefined || !fs.existsSync(file)) throw new Error(`파일이 없음: ${file ?? ''}`)
    if (mode === 'text') reply(await textMode(file))
    else if (mode === 'page') reply(await pageMode(file, page))
    else throw new Error('사용법: rhwp-view.mjs text|page <파일> [쪽번호]')
  } catch (error) {
    reply({ error: String(error instanceof Error ? error.message : error) })
    process.exitCode = 1
  }
}
