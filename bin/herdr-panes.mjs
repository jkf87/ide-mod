#!/usr/bin/env node
// 허더 패인 목록(list)과 닫기(close). ide-mod 플러그인 CLI.
// 의존성 없음: node 내장 모듈만 쓴다. 순수 함수는 export 해서 따로 시험할 수 있다.
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TAIL_BYTES = 262144 // Claude 대화 기록은 끝 256KB만 읽는다
const CMD_TIMEOUT_MS = 5000
const PANE_READ_LINES = 40
const ASK_MAX = 80

/** 답변에서 첫 뜻 있는 문장 */
export function answerGist(text, max = 60) {
  const body = String(text ?? '').replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '\n')
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (line === '' || /^#{1,6}(\s|$)/.test(line) || /^\|/.test(line) || /^([-*_=]\s*){3,}$/.test(line)) continue
    const plain = line
      .replace(/^(?:>\s*)+/, '')
      .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/^\[[ xX]\]\s+/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
      .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (plain.startsWith('⏱') || !/[\p{L}\p{N}]/u.test(plain)) continue
    const sentence = /^.*?[.!?。](?=\s|$)/.exec(plain)?.[0] ?? plain
    return [...sentence].slice(0, max).join('')
  }
  return ''
}
export const personText = text => String(text ?? '')
  .replace(/<(system-reminder|local-command-caveat|local-command-stdout|local-command-stderr|command-message|command-name|command-args)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
  .trim()
export const isMachine = text => text === '' || /^\s*(<(task-notification|teammate-message|peer-message|cross-session-message)\b|\[SYSTEM NOTIFICATION|Caveat:|This session is being continued from a previous conversation)/i.test(text)

/** 화면에서 읽은 줄 중 일과 상관없는 껍데기: 에이전트 TUI 상태줄·단축키 안내·권한 모드·셸 프롬프트 */
export const isChromeLine = line => /(\bfor (agents|shortcuts)\b|^Worked for \d|Auto-update failed|bypass permissions|New activity|Earlier messages|esc to interrupt|\? for shortcuts)/i.test(line)
  || /^\s*[❯⏵›>]/.test(line)
  || /^[\w.-]+@[\w.-]+ .*[%$#]\s*$/.test(line)
  || /^(GPT|gpt|o\d|Claude|claude|Opus|Sonnet|Haiku|gemini|Gemini)[\w.-]*( \w+)? · /.test(line)

/** 패인 이름: label → terminal_title_stripped → cwd 마지막 폴더 이름 (빈 글은 건너뜀) */
export function nameOf(pane) {
  for (const v of [pane?.label, pane?.terminal_title_stripped]) {
    const s = String(v ?? '').trim()
    if (s !== '') return s
  }
  const parts = String(pane?.cwd ?? '').split(/[\\/]+/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : ''
}

/** Claude 대화 기록 폴더 이름: 영숫자가 아닌 글자는 모두 '-' */
export function encodeCwd(cwd) {
  return String(cwd ?? '').replace(/[^A-Za-z0-9]/g, '-')
}

const clip = (s, n = ASK_MAX) => [...String(s ?? '').trim()].slice(0, n).join('')

/** 기록 한 줄이 사람 프롬프트면 그 첫 줄, 아니면 null */
function humanPromptOf(rec) {
  if (rec.isMeta === true) return null
  const c = rec.message?.content
  let raw
  if (typeof c === 'string') raw = c
  else if (Array.isArray(c)) {
    const parts = c.filter(x => x?.type === 'text' && typeof x.text === 'string').map(x => x.text)
    if (parts.length === 0) return null // tool_result만 있는 줄은 사람 말이 아니다
    raw = parts.join('\n')
  } else return null
  const txt = personText(raw)
  if (isMachine(txt)) return null
  const first = txt.split('\n').map(s => s.trim()).find(s => s !== '')
  return first === undefined ? null : clip(first)
}

/** assistant 줄의 답 한 문장 (text 조각이 없으면 null) */
function assistantGistOf(rec) {
  const c = rec.message?.content
  if (!Array.isArray(c)) return null
  const parts = c.filter(x => x?.type === 'text' && typeof x.text === 'string').map(x => x.text)
  if (parts.length === 0) return null
  return answerGist(parts.join('\n'))
}

/** 기록 끝부분 텍스트 → 마지막 사람 요청(lastAsk), 마지막 답(lastAnswer). 실패한 줄은 건너뜀 */
export function parseTranscriptTail(text) {
  let lastAsk = null
  let lastAnswer = null
  const lines = String(text ?? '').split('\n')
  for (let i = lines.length - 1; i >= 0 && (lastAsk === null || lastAnswer === null); i--) {
    const raw = lines[i].trim()
    if (raw === '') continue
    let rec
    try { rec = JSON.parse(raw) } catch { continue }
    if (rec === null || typeof rec !== 'object') continue
    if (lastAsk === null && rec.type === 'user') lastAsk = humanPromptOf(rec)
    if (lastAnswer === null && rec.type === 'assistant') lastAnswer = assistantGistOf(rec)
  }
  return { lastAsk: lastAsk ?? '', lastAnswer: lastAnswer ?? '' }
}

const herdrBin = () => process.env.HERDR_BIN_PATH || 'herdr'
const firstLine = s => String(s ?? '').split('\n').map(x => x.trim()).find(x => x !== '') ?? ''
const say = s => process.stdout.write(s)

/** 허더 CLI 한 번 실행. 5초 타임아웃, 셸 없이 인자 배열로 */
function runHerdr(args) {
  const r = spawnSync(herdrBin(), args, {
    encoding: 'utf8',
    timeout: CMD_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const out = r.stdout ?? ''
  if (r.error) {
    if (r.error.code === 'ENOENT') return { ok: false, out, err: '허더 실행 파일을 못 찾았어요 (HERDR_BIN_PATH 확인)' }
    if (r.error.code === 'ETIMEDOUT') return { ok: false, out, err: '5초 안에 답이 없었어요' }
    return { ok: false, out, err: r.error.message }
  }
  if (r.status !== 0) {
    return { ok: false, out, err: firstLine(r.stderr) || (r.signal ? `신호 ${r.signal}` : `종료 코드 ${r.status}`) }
  }
  return { ok: true, out, err: '' }
}

/** 허더 패인 목록. 실패하면 throw */
function fetchPanes() {
  const r = runHerdr(['pane', 'list'])
  if (!r.ok) throw new Error(`허더 패인 목록을 못 받았어요: ${r.err}`)
  let json
  try { json = JSON.parse(r.out) } catch { throw new Error('허더 패인 목록 응답을 읽지 못했어요') }
  const panes = json?.result?.panes
  return Array.isArray(panes) ? panes : []
}

/** 탭 ID → 탭 이름 (번호 붙여서). 실패하면 빈 표 */
let tabNamesCache = null
function fetchTabNames() {
  if (tabNamesCache !== null) return tabNamesCache
  tabNamesCache = {}
  const r = runHerdr(['tab', 'list'])
  if (!r.ok) return tabNamesCache
  try {
    for (const t of JSON.parse(r.out)?.result?.tabs ?? []) {
      const label = String(t.label ?? '').trim()
      tabNamesCache[t.tab_id] = [t.number !== undefined ? `${t.number}` : '', label].filter(Boolean).join(' ')
    }
  } catch { /* 이름 없이 */ }
  return tabNamesCache
}

/** 화면 줄 다듬기: 테두리(│╭─ 등)를 걷고, 글자·숫자가 없는 줄(구분선·빈 입력창)은 버린다 */
export const screenLine = line => {
  const t = String(line ?? '').replace(/[\u2500-\u257f\u2580-\u259f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return /[\p{L}\p{N}]/u.test(t) ? t : ''
}

/** 그 밖의 패인: 화면 글자의 마지막 뜻 있는 줄 2개 (앞줄=요청, 끝줄=답) */
function readPaneTail(id) {
  const r = runHerdr(['pane', 'read', id, '--source', 'recent', '--lines', String(PANE_READ_LINES)])
  if (!r.ok) return { lastAsk: '', lastAnswer: '' }
  const last = r.out.split('\n').map(screenLine).filter(l => l !== '' && !isChromeLine(l)).slice(-2).map(l => clip(l))
  if (last.length === 2) return { lastAsk: last[0], lastAnswer: last[1] }
  return { lastAsk: '', lastAnswer: last[0] ?? '' }
}

// Claude 대화 기록 파일 찾기: <CLAUDE_CONFIG_DIR|~/.claude>/projects/<cwd 인코딩>/<id>.jsonl, 없으면 projects 아래 모든 폴더에서 <id>.jsonl 찾기

function findTranscript(cwd, sid) {
  if (!/^[\w-]+$/.test(sid)) return null // 세션 ID는 파일 이름으로 안전한 글자만 (UUID)
  const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')
  const direct = join(projects, encodeCwd(cwd), `${sid}.jsonl`)
  if (existsSync(direct)) return direct
  let dirs
  try { dirs = readdirSync(projects) } catch { return null }
  for (const d of dirs) {
    const f = join(projects, d, `${sid}.jsonl`)
    if (existsSync(f)) return f
  }
  return null
}

/** 기록 파일의 끝 256KB만 읽는다. 중간에서 시작했으면 잘린 첫 줄은 버린다 (바이트 단위라 UTF-8이 안 깨진다) */
function readTail(file) {
  const fd = openSync(file, 'r')
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - TAIL_BYTES)
    const want = size - start
    const buf = Buffer.alloc(want)
    let got = 0
    while (got < want) {
      const n = readSync(fd, buf, got, want - got, start + got)
      if (n <= 0) break
      got += n
    }
    let data = buf.subarray(0, got)
    if (start > 0) {
      const nl = data.indexOf(0x0a)
      data = nl === -1 ? data.subarray(data.length) : data.subarray(nl + 1)
    }
    return data.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** Claude 패인의 마지막 요청·답. 세션 ID나 기록 파일을 못 찾으면 null */
function claudeTail(p) {
  const v = p.agent_session
  const sid = typeof v === 'string' ? v : v?.value
  if (typeof sid !== 'string' || sid === '') return null
  const file = findTranscript(p.cwd ?? '', sid)
  if (!file) return null
  try {
    return parseTranscriptTail(readTail(file))
  } catch {
    return null
  }
}

/** 허더 패인 한 개 → 출력용 객체 */
function describePane(p, selfId, tabNames = {}) {
  const agent = p.agent ?? ''
  const tail = (agent === 'claude' ? claudeTail(p) : null) ?? readPaneTail(p.pane_id)
  return {
    pane_id: p.pane_id,
    tab_id: p.tab_id,
    tab_name: tabNames[p.tab_id] ?? '',
    name: nameOf(p),
    agent,
    status: p.agent_status ?? 'unknown',
    cwd: p.cwd ?? '',
    self: p.pane_id === selfId,
    lastAsk: tail.lastAsk,
    lastAnswer: tail.lastAnswer,
  }
}

function symbolOf(status) {
  switch (status) {
    case 'working': return '●'
    case 'done': return '✓'
    case 'idle': return '○'
    default: return '·'
  }
}

/** 사람이 읽는 패인 한 덩이 (최대 3줄) */
function formatPane(r) {
  const meta = [r.agent, r.status].filter(Boolean).join(' · ')
  let head = `${symbolOf(r.status)} ${r.pane_id}`
  if (r.name) head += `  ${r.name}`
  if (meta) head += `  (${meta})`
  if (r.self) head += ' ← 나'
  const lines = [head]
  if (r.lastAsk) lines.push(`  요청: ${r.lastAsk}`)
  if (r.lastAnswer) lines.push(`  답: ${r.lastAnswer}`)
  return lines.join('\n')
}

function footer(rows) {
  const n = s => rows.filter(r => r.status === s).length
  return `패인 ${rows.length}개 · 일하는 중 ${n('working')} · 끝남 ${n('done')} · 쉼 ${n('idle')}`
}

const USAGE = [
  '사용법:',
  '  node bin/herdr-panes.mjs list [--tab <tab_id> | --all] [--json]',
  '      기본은 내 패인(HERDR_PANE_ID)과 같은 탭. --tab 은 그 탭, --all 은 전부.',
  '  node bin/herdr-panes.mjs close <pane_id…> [--force] [--json]',
  '      내 패인은 닫지 않는다. 일하는 중인 패인은 --force 없이 닫지 않는다.',
  '  node bin/herdr-panes.mjs help',
  '환경 변수: HERDR_BIN_PATH(기본 herdr), HERDR_PANE_ID(내 패인), CLAUDE_CONFIG_DIR(기본 ~/.claude)',
].join('\n')

function usageError(msg) {
  process.stderr.write(`${msg}\n${USAGE}\n`)
  return 2
}

function cmdList(argv) {
  let all = false
  let json = false
  let tab = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--all') all = true
    else if (a === '--json') json = true
    else if (a === '--tab') {
      tab = argv[++i] ?? ''
      if (tab === '' || tab.startsWith('--')) return usageError('--tab 뒤에 tab_id를 주세요')
    } else return usageError(`모르는 옵션이에요: ${a}`)
  }
  if (all && tab !== null) return usageError('--all 과 --tab 은 같이 못 써요')

  const selfId = process.env.HERDR_PANE_ID || ''
  if (!selfId && !all && tab === null) {
    process.stderr.write('허더 안에서만 써요 (--all 로 전체)\n')
    return 2
  }

  const panes = fetchPanes()
  let scope
  if (all) scope = panes
  else if (tab !== null) scope = panes.filter(p => p.tab_id === tab)
  else {
    const me = panes.find(p => p.pane_id === selfId)
    if (!me) {
      process.stderr.write(`내 패인(${selfId})을 허더 목록에서 못 찾았어요 (--all 로 전체)\n`)
      return 1
    }
    scope = panes.filter(p => p.tab_id === me.tab_id)
  }

  const rows = scope.map(p => describePane(p, selfId, fetchTabNames()))
  if (json) say(JSON.stringify({ panes: rows }) + '\n')
  else say([...rows.map(formatPane), footer(rows)].join('\n') + '\n')
  return 0
}

/** 패인 하나 닫기 판정. 실제 닫기는 여기서만 실행한다 */
function closeOne(id, panes, selfId, force) {
  const verdict = (ok, label, reason) => ({ pane_id: id, ok, reason, line: `${label} ${id}: ${reason}` })
  if (selfId !== '' && id === selfId) return verdict(false, '거절', '이 세션(나)은 닫지 않아요')
  const p = panes.find(x => x.pane_id === id)
  if (!p) return verdict(true, '없음', '이미 닫혔거나 없는 패인이에요')
  if ((p.agent_status ?? 'unknown') === 'working' && !force) {
    return verdict(false, '거절', '일하는 중이에요 (--force 로 닫기)')
  }
  const name = nameOf(p)
  const tag = name ? ` (${name})` : ''
  const r = runHerdr(['pane', 'close', id])
  if (!r.ok) return verdict(false, '실패', r.err)
  return { pane_id: id, ok: true, reason: `닫음${tag}`, line: `닫음 ${id}${tag}` }
}

function cmdClose(argv) {
  let force = false
  let json = false
  const ids = []
  for (const a of argv) {
    if (a === '--force') force = true
    else if (a === '--json') json = true
    else if (a.startsWith('-')) return usageError(`모르는 옵션이에요: ${a}`)
    else if (a !== '' && !ids.includes(a)) ids.push(a)
  }
  if (ids.length === 0) return usageError('닫을 pane_id를 주세요')

  const selfId = process.env.HERDR_PANE_ID || ''
  const panes = fetchPanes() // 닫기 직전에 목록을 다시 받아 상태를 본다
  const results = ids.map(id => closeOne(id, panes, selfId, force))

  if (json) {
    say(JSON.stringify({ results: results.map(({ pane_id, ok, reason }) => ({ pane_id, ok, reason })) }) + '\n')
  } else {
    say(results.map(r => r.line).join('\n') + '\n')
  }
  return results.some(r => !r.ok) ? 1 : 0
}

function main(argv) {
  const [cmd, ...rest] = argv
  if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    say(USAGE + '\n')
    return 0
  }
  if (cmd === 'list') return cmdList(rest)
  if (cmd === 'close') return cmdClose(rest)
  return usageError(`모르는 명령이에요: ${cmd}`)
}

/** 심링크 경로로 돌아도 메인으로 판별하도록 realpath로 비교 */
function isMainModule() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMainModule()) {
  process.stdout.on('error', e => process.exit(e.code === 'EPIPE' ? 0 : 1))
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (e) {
    process.stderr.write(`${e.message}\n`)
    process.exitCode = 1
  }
}
