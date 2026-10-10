#!/usr/bin/env node
// agy(Antigravity CLI) 상태줄: ide-mod 띠와 같은 도트 게이지 한 줄.
//   agy 안에서:  /statusline node ~/ide-mod/bin/agy-statusline.mjs
//
// agy가 stdin으로 주는 JSON(model·context_window·quota·terminal_width)을 읽고,
// Claude·Codex 한도는 ide-mod가 남긴 ~/.cache/ide-mod/limits.json에서 읽는다.
// 거꾸로 agy가 준 Antigravity 한도는 ~/.cache/ide-mod/agy-usage.tsv에 남겨서
// ide-mod가 agy를 따로 띄우지 않고 쓰게 한다 (agy /usage 출력과 같은 모양).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CACHE = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ide-mod')
const LIMITS_MAX_AGE_MS = 30 * 60_000

let input = {}
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
} catch {
  // 형식이 바뀌어도 상태줄은 비우지 않는다
}

// ── Antigravity 한도: 쓴 비율로, 그리고 ide-mod와 나눠 쓰게 파일로 ──
const QUOTA = [
  ['gemini-5h', 'Gemini Models', 'Five Hour Limit Remaining', 'Gemini', '5h'],
  ['gemini-weekly', 'Gemini Models', 'Weekly Limit Remaining', 'Gemini', '주'],
  ['3p-5h', 'Claude and GPT models', 'Five Hour Limit Remaining', 'AG Claude·GPT', '5h'],
  ['3p-weekly', 'Claude and GPT models', 'Weekly Limit Remaining', 'AG Claude·GPT', '주'],
]
const quota = input.quota && typeof input.quota === 'object' ? input.quota : {}
const agyRows = QUOTA.flatMap(([key, group, kind, name, label]) => {
  const q = quota[key]
  if (!q || typeof q.remaining_fraction !== 'number') return []
  const left = Math.round(Math.min(Math.max(q.remaining_fraction, 0), 1) * 100)
  return [{ group, kind, name, label, left, reset: q.reset_time ?? '' }]
})
if (agyRows.length > 0) {
  try {
    fs.mkdirSync(CACHE, { recursive: true })
    const tmp = path.join(CACHE, `agy-usage.tsv.${process.pid}`)
    fs.writeFileSync(tmp, agyRows.map(r => `${r.group}\t${r.kind}\t${r.left}%\t${r.reset}`).join('\n') + '\n')
    fs.renameSync(tmp, path.join(CACHE, 'agy-usage.tsv'))
  } catch {
    // 캐시는 덤이다
  }
}

// ── Claude·Codex 한도: ide-mod가 남긴 것 (30분 넘은 값은 쓰지 않는다) ──
let shared = {}
try {
  shared = JSON.parse(fs.readFileSync(path.join(CACHE, 'limits.json'), 'utf8'))
} catch {
  // ide-mod를 안 쓰면 없다
}
const isFresh = key => Date.now() - (shared[`${key}At`] ?? shared.updatedAt ?? 0) < LIMITS_MAX_AGE_MS

// ── 그리기: 묶음 [이름, 항목들], 항목 { label, pct, kind } ──
const shortLabel = label => label.replace(/^5시간$/, '5h').replace(/^주간$/, '주')
const resetNote = (pct, resetsAt) => {
  if (pct < 70 || !resetsAt) return ''
  const mins = Math.max(0, Math.round((new Date(resetsAt).getTime() - Date.now()) / 60_000))
  if (!Number.isFinite(mins)) return ''
  return mins >= 1440 ? ` ${Math.floor(mins / 1440)}일` : mins >= 60 ? ` ${Math.floor(mins / 60)}시간` : ` ${mins}분`
}
const groups = []
const ctx = input.context_window?.used_percentage
const model = String(input.model?.display_name ?? input.model?.id ?? 'agy').replace(/\s*\(.*\)\s*$/, '')
groups.push({ name: model, color: [138, 180, 248], items: typeof ctx === 'number' ? [{ label: '컨텍스트', pct: Math.round(ctx), kind: 'use' }] : [], tail: input.agent_state && input.agent_state !== 'idle' ? '작업 중' : undefined })
for (const name of ['Gemini', 'AG Claude·GPT']) {
  const rows = agyRows.filter(r => r.name === name)
  if (rows.length > 0) groups.push({ name, items: rows.map(r => ({ label: r.label, pct: 100 - r.left, kind: 'use', note: resetNote(100 - r.left, r.reset) })) })
}
for (const [name, key] of [['Claude', 'claude'], ['Codex', 'codex']]) {
  const windows = Array.isArray(shared[key]) && isFresh(key) ? shared[key] : []
  if (windows.length > 0) groups.push({ name, items: windows.map(w => ({ label: shortLabel(String(w.label)), pct: Math.round(w.pct), kind: 'use', note: resetNote(w.pct, w.resetsAt) })) })
}
// Antigravity 다음에 Claude·Codex: 오른쪽부터 게이지를 빼니 agy 자기 것이 가장 오래 남는다

// 점자 게이지: 칸마다 점 2열, 쓴 비율 게이지는 칸 위치마다 초록→노랑→빨강
const RAMP = [[95, 215, 135], [215, 215, 95], [255, 175, 95], [255, 95, 95]]
const rampAt = t => {
  const x = Math.min(Math.max(t, 0), 1) * (RAMP.length - 1)
  const i = Math.min(Math.floor(x), RAMP.length - 2)
  const f = x - i
  return RAMP[i].map((c, k) => Math.round(c * (1 - f) + RAMP[i + 1][k] * f))
}
const fg = ([r, g, b]) => `\x1b[38;2;${r};${g};${b}m`
const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const CELLS = 4
const gauge = pct => {
  const cols = Math.round((Math.min(Math.max(pct, 0), 100) / 100) * CELLS * 2)
  let out = ''
  for (let i = 0; i < CELLS; i++) {
    const filled = Math.min(Math.max(cols - i * 2, 0), 2)
    out += filled === 0 ? `${fg([90, 90, 90])}⣀` : `${fg(rampAt((i + 0.5) / CELLS))}${filled === 2 ? '⣿' : '⡇'}`
  }
  return out + RESET
}
const pctColor = pct => (pct >= 90 ? fg([255, 95, 95]) : pct >= 70 ? fg([255, 175, 95]) : '')

// 화면 폭 계산 (한글은 두 칸)
const width = s => [...s].reduce((n, ch) => n + ((ch.codePointAt(0) ?? 0) >= 0x1100 && !/[⠀-⣿│·]/.test(ch) ? 2 : 1), 0)
const itemText = it => `${it.pct}%${it.note ?? ''}`
const keep = groups.map(g => g.items.map(() => true))
const total = () =>
  groups.reduce(
    (n, g, gi) => n + (gi === 0 ? 0 : 3) + width(g.name) + (g.tail ? 1 + width(g.tail) : 0) + g.items.reduce((m, it, ii) => m + 1 + width(it.label) + 1 + (keep[gi][ii] ? CELLS + 1 : 0) + width(itemText(it)), 0),
    0,
  )
const room = Math.max(20, (Number(input.terminal_width) || 120) - 2)
for (let gi = groups.length - 1; gi >= 1 && total() > room; gi--) for (let ii = groups[gi].items.length - 1; ii >= 0 && total() > room; ii--) keep[gi][ii] = false
// 그래도 넘치면 오른쪽 묶음부터 통째로 뺀다
while (groups.length > 1 && total() > room) {
  groups.pop()
  keep.pop()
}

const line = groups
  .map((g, gi) => {
    const name = `${BOLD}${g.color ? fg(g.color) : ''}${g.name}${RESET}`
    const items = g.items.map((it, ii) => `${DIM}${it.label}${RESET} ${keep[gi][ii] ? `${gauge(it.pct)} ` : ''}${BOLD}${pctColor(it.pct)}${itemText(it)}${RESET}`)
    return [name, ...items, ...(g.tail ? [`${fg([255, 175, 95])}${g.tail}${RESET}`] : [])].join(' ')
  })
  .join(` ${DIM}│${RESET} `)
process.stdout.write(line + '\n')
