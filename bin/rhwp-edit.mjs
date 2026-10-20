#!/usr/bin/env node
// HWP·HWPX 편집 창: rhwp 편집기(@rhwp/editor, MIT)를 이 컴퓨터 안의 작은 서버로 띄워 브라우저 앱 창에 연다.
//   node bin/rhwp-edit.mjs <파일.hwp|hwpx>        창을 열고 {"url", "pid"}를 찍은 뒤 끝난다 (서버는 뒤에 남는다)
//
// 편집기는 브라우저 안에서 돈다 (rhwp-studio를 edwardkim.github.io/rhwp에서 받아 iframe으로 띄운다).
// 문서 바이트는 이 컴퓨터의 서버 ↔ 브라우저 사이에서만 오가고, 저장하면 원래 파일에 다시 쓴다.
//   - 쓰기 전에 지금 디스크에 있는 파일을 ~/.cache/ide-mod/hwp-backup/에 남긴다
//   - .hwp는 다시 읽어 쪽 수가 맞는지 확인한 뒤에만 덮어쓴다 (안 맞으면 같은 이름의 .hwpx로 따로 저장)
//   - 주소에 무작위 토큰을 넣어 다른 웹페이지가 저장 요청을 보내지 못하게 한다
//   - 창이 닫히고 30초 동안 소식이 없으면 서버가 스스로 끝난다
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SDK = path.join(HERE, '..', 'vendor', 'rhwp-editor')
const CACHE = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ide-mod')
const BACKUP = path.join(CACHE, 'hwp-backup')
const QUIET_MS = 30_000
const FIRST_PING_MS = 10 * 60_000
const MAX_BYTES = 200 * 1024 * 1024

const fail = message => {
  process.stdout.write(JSON.stringify({ error: message }) + '\n')
  process.exit(1)
}

const [mode, ...rest] = process.argv.slice(2)
if (mode === '--serve') serve(rest[0], rest[1] === '--no-open')
else launch(mode, rest.includes('--no-open'))

// ── 실행기: 서버를 떼어 띄우고, 주소를 받으면 창을 열고 끝난다 ──
function launch(file, noOpen) {
  if (!file) fail('파일 경로가 필요해요: node bin/rhwp-edit.mjs <파일.hwp|hwpx>')
  const target = path.resolve(file)
  if (!/\.hwpx?$/i.test(target)) fail('HWP·HWPX 파일만 열 수 있어요')
  if (!fs.existsSync(target)) fail(`파일이 없어요: ${target}`)
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve', target], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  let buffered = ''
  const timer = setTimeout(() => fail('편집 서버가 10초 안에 뜨지 않았어요'), 10_000)
  child.stdout.on('data', chunk => {
    buffered += chunk
    const line = buffered.split('\n')[0]
    if (!buffered.includes('\n')) return
    clearTimeout(timer)
    child.stdout.destroy()
    child.unref()
    const { url, error } = JSON.parse(line)
    if (error) fail(error)
    const opened = noOpen ? 'none' : openWindow(url)
    process.stdout.write(JSON.stringify({ url, pid: child.pid, opened }) + '\n')
    process.exit(0)
  })
  child.on('exit', code => fail(`편집 서버가 바로 끝났어요 (exit ${code})`))
}

/** 주소 표시줄 없는 앱 창으로 연다: Chrome → Edge → Brave, 없으면 기본 브라우저 */
function openWindow(url) {
  const run = (cmd, args) => {
    try {
      const p = spawn(cmd, args, { detached: true, stdio: 'ignore' })
      p.unref()
      return true
    } catch {
      return false
    }
  }
  if (process.platform === 'darwin') {
    for (const app of ['Google Chrome', 'Microsoft Edge', 'Brave Browser']) {
      if (fs.existsSync(`/Applications/${app}.app`)) {
        run('open', ['-na', app, '--args', `--app=${url}`])
        return app
      }
    }
    run('open', [url])
    return 'default'
  }
  if (process.platform === 'win32') {
    run('cmd', ['/c', 'start', '', url])
    return 'default'
  }
  for (const bin of ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge']) {
    const found = (process.env.PATH || '').split(':').some(dir => fs.existsSync(path.join(dir, bin)))
    if (found && run(bin, [`--app=${url}`])) return bin
  }
  run('xdg-open', [url])
  return 'default'
}

// ── 서버 ──
function serve(target, _noOpen) {
  const token = crypto.randomBytes(16).toString('hex')
  const base = `/${token}/`
  const name = path.basename(target)
  const isHwp = /\.hwp$/i.test(target)
  let lastPing = 0
  const startedAt = Date.now()

  const send = (res, status, type, body) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    res.end(body)
  }
  const json = (res, status, value) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(value))
  const readBody = req =>
    new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', c => {
        size += c.length
        if (size > MAX_BYTES) reject(new Error('too large'))
        else chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })

  /** 지금 디스크의 파일을 남긴 뒤 임시 파일 → 이름 바꾸기로 덮어쓴다 */
  const writeSafely = (file, bytes) => {
    let backup
    if (fs.existsSync(file)) {
      fs.mkdirSync(BACKUP, { recursive: true })
      const d = new Date()
      const two = n => String(n).padStart(2, '0')
      const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
      backup = path.join(BACKUP, `${stamp}-${path.basename(file)}`)
      fs.copyFileSync(file, backup)
    }
    const tmp = `${file}.ide-mod-${process.pid}.tmp`
    fs.writeFileSync(tmp, bytes)
    fs.renameSync(tmp, file)
    return backup
  }

  const server = http.createServer(async (req, res) => {
    try {
      // 이 컴퓨터 안의 다른 페이지가 토큰을 모르면 아무것도 못 한다
      if (!req.url?.startsWith(base)) return send(res, 404, 'text/plain', 'not found')
      const route = req.url.slice(base.length).split('?')[0]
      if (req.method === 'GET' && route === '') return send(res, 200, 'text/html; charset=utf-8', page(name, isHwp))
      if (req.method === 'GET' && /^sdk\/[\w-]+\.js$/.test(route)) {
        const file = path.join(SDK, route.slice(4))
        return send(res, 200, 'text/javascript; charset=utf-8', fs.readFileSync(file))
      }
      if (req.method === 'GET' && route === 'file') return send(res, 200, 'application/octet-stream', fs.readFileSync(target))
      if (req.method === 'POST' && route === 'ping') {
        lastPing = Date.now()
        return json(res, 200, { ok: true })
      }
      if (req.method === 'POST' && route === 'bye') {
        lastPing = Date.now() - QUIET_MS + 3_000 // 새로고침이면 곧 다시 핑이 온다
        return json(res, 200, { ok: true })
      }
      if (req.method === 'POST' && (route === 'save' || route === 'save-hwpx')) {
        const bytes = await readBody(req)
        if (bytes.length < 16) return json(res, 400, { error: '빈 문서는 저장하지 않아요' })
        const out = route === 'save' ? target : target.replace(/\.hwpx?$/i, '.hwpx')
        if (route === 'save-hwpx' && out !== target && fs.existsSync(out) && req.headers['x-overwrite'] !== 'yes') {
          return json(res, 409, { error: `${path.basename(out)}가 이미 있어요`, exists: true })
        }
        const backup = writeSafely(out, bytes)
        return json(res, 200, { ok: true, path: out, bytes: bytes.length, backup })
      }
      return send(res, 404, 'text/plain', 'not found')
    } catch (error) {
      return json(res, 500, { error: String(error?.message ?? error) })
    }
  })

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${port}${base}` }) + '\n')
  })
  server.on('error', error => {
    process.stdout.write(JSON.stringify({ error: String(error.message) }) + '\n')
    process.exit(1)
  })
  setInterval(() => {
    const quietFor = Date.now() - (lastPing || startedAt)
    if ((lastPing === 0 && quietFor > FIRST_PING_MS) || (lastPing !== 0 && quietFor > QUIET_MS)) process.exit(0)
  }, 2_000)
}

function page(name, isHwp) {
  const title = name.replace(/[<>&"]/g, '')
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · 한글 편집</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f6f4; --fg: #222; --dim: #777; --line: #ddd; --ok: #2f7d4f; --warn: #b7791f; --err: #c0392b; --btn: #fff; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1f1f1f; --fg: #e6e6e6; --dim: #999; --line: #333; --ok: #6fcf97; --warn: #f2c94c; --err: #ff7b72; --btn: #2a2a2a; } }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif; }
  #bar { height: 36px; box-sizing: border-box; display: flex; align-items: center; gap: 10px; padding: 0 12px; border-bottom: 1px solid var(--line); }
  #name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 40vw; }
  #state { color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #state.ok { color: var(--ok); } #state.warn { color: var(--warn); } #state.err { color: var(--err); }
  .grow { flex: 1; }
  button { font: inherit; padding: 4px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--btn); color: var(--fg); cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  #editor { height: calc(100% - 36px); }
</style>
</head>
<body>
<div id="bar">
  <span id="name">${title}</span>
  <span id="state">편집기를 여는 중…</span>
  <span class="grow"></span>
  ${isHwp ? '<button id="save-hwpx" disabled>HWPX로 따로 저장</button>' : ''}
  <button id="save" disabled title="원래 파일에 저장 (이 막대를 누른 뒤 ⌘S/Ctrl+S도 돼요)">저장</button>
</div>
<div id="editor"></div>
<script type="module">
import { createEditor } from './sdk/index.js'

const isHwp = ${isHwp ? 'true' : 'false'}
const name = ${JSON.stringify(name)}
const state = document.getElementById('state')
const saveButton = document.getElementById('save')
const saveHwpxButton = document.getElementById('save-hwpx')
const say = (text, kind = '') => { state.textContent = text; state.className = kind }
const ping = () => fetch('ping', { method: 'POST' }).catch(() => say('편집 서버와 연결이 끊겼어요. 저장이 안 될 수 있어요.', 'err'))
ping()
setInterval(ping, 5000)
addEventListener('pagehide', () => navigator.sendBeacon('bye'))

let editor
try {
  editor = await createEditor('#editor')
  const bytes = await (await fetch('file')).arrayBuffer()
  const loaded = await editor.loadFile(bytes, name)
  const pages = loaded?.pageCount ?? (await editor.pageCount().catch(() => undefined))
  say(pages ? pages + '쪽 · 고치고 저장을 누르면 원래 파일에 써요' : '열었어요')
  saveButton.disabled = false
  if (saveHwpxButton) saveHwpxButton.disabled = false
} catch (error) {
  say('편집기를 열지 못했어요: ' + (error?.message ?? error) + ' (인터넷 연결이 필요해요)', 'err')
}

async function post(route, bytes, overwrite = false) {
  const res = await fetch(route, { method: 'POST', body: bytes, headers: overwrite ? { 'x-overwrite': 'yes' } : {} })
  return { status: res.status, ...(await res.json()) }
}

async function save(asHwpx) {
  if (!editor) return
  saveButton.disabled = true
  if (saveHwpxButton) saveHwpxButton.disabled = true
  try {
    say('저장하는 중…')
    let bytes
    let route = 'save'
    if (asHwpx) {
      bytes = await editor.exportHwpx()
      route = 'save-hwpx'
    } else if (isHwp) {
      // HWP는 쓴 것을 다시 읽어 쪽 수가 그대로인지 본 뒤에만 덮어쓴다
      const check = await editor.exportHwpVerify()
      if (!check.recovered || check.pageCountBefore !== check.pageCountAfter) {
        say('HWP로 다시 쓰면 문서가 달라질 수 있어 덮어쓰지 않았어요 (' + check.pageCountBefore + '→' + check.pageCountAfter + '쪽). HWPX로 따로 저장하세요.', 'warn')
        return
      }
      bytes = await editor.exportHwp()
    } else {
      bytes = await editor.exportHwpx()
    }
    let result = await post(route, bytes)
    if (result.status === 409 && result.exists) {
      if (!confirm(result.error + '. 덮어쓸까요? (지금 파일은 백업해 둬요)')) { say('저장을 취소했어요'); return }
      result = await post(route, bytes, true)
    }
    if (result.error) throw new Error(result.error)
    await editor.notifySaved(result.path.split('/').pop()).catch(() => undefined)
    const at = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    say(at + ' 저장 · ' + result.path.split('/').pop() + ' (' + Math.round(result.bytes / 1024) + 'KB)' + (result.backup ? ' · 이전 판은 백업' : ''), 'ok')
  } catch (error) {
    say('저장하지 못했어요: ' + (error?.message ?? error), 'err')
  } finally {
    saveButton.disabled = false
    if (saveHwpxButton) saveHwpxButton.disabled = false
  }
}

saveButton.addEventListener('click', () => save(false))
saveHwpxButton?.addEventListener('click', () => save(true))
addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(false) }
})
</script>
</body>
</html>`
}
