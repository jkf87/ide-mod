#!/usr/bin/env node
// 이 폴더에서 내가 보낸 프롬프트: Claude Code·Codex·agy(Antigravity CLI)의 입력 기록을 시간순으로 합쳐 보여 준다.
//   node bin/prompts.mjs                  이 폴더, 최근 30개
//   node bin/prompts.mjs 100              최근 100개
//   node bin/prompts.mjs --all            모든 폴더
//   node bin/prompts.mjs --cwd DIR        다른 폴더
//   node bin/prompts.mjs --only codex,agy 고른 도구만
//   node bin/prompts.mjs --json           JSON 배열로 (ide-mod가 읽는다)
// agy 안에서는 `!node ~/ide-mod/bin/prompts.mjs`로 부른다 (모델을 거치지 않는다)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const argv = process.argv.slice(2)
const flag = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
const isAll = argv.includes('--all')
const cwd = path.resolve(flag('--cwd') ?? process.cwd())
const limit = Number(argv.find(a => /^\d+$/.test(a))) || 30
const only = flag('--only')?.split(',').map(t => t.trim().toLowerCase())
const wants = tool => only === undefined || only.includes(tool.toLowerCase())
const isJson = argv.includes('--json')

const readJsonl = file => {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .flatMap(line => {
        try {
          return [JSON.parse(line)]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

const home = os.homedir()
const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
const codexDir = process.env.CODEX_HOME || path.join(home, '.codex')

// Codex: 스레드 목록(state_*.sqlite)에서 이 폴더의 사람이 연 스레드(cli·데스크톱)만 고르고,
// 그 대화 파일에서 사람이 보낸 메시지(client_id가 붙은 UserMessage)만 뽑는다. 서브에이전트·codex exec는 뺀다
function codexRows() {
  let threads = []
  try {
    const state = fs.readdirSync(codexDir).filter(f => /^state_\d+\.sqlite$/.test(f)).sort().pop()
    if (state === undefined) return []
    process.removeAllListeners('warning') // node:sqlite 실험 경고를 출력에 섞지 않는다
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
    const db = new DatabaseSync(path.join(codexDir, state), { readOnly: true })
    const where = isAll ? '' : 'and cwd = ?'
    threads = db
      .prepare(`select id, cwd, rollout_path from threads where source in ('cli', 'vscode') and coalesce(originator, '') <> 'openclaw' ${where} order by updated_at_ms desc limit ?`)
      .all(...(isAll ? [] : [cwd]), isAll ? 40 : 20)
    db.close()
  } catch {
    return []
  }
  const rows = []
  for (const t of threads) {
    let text = ''
    try {
      text = fs.readFileSync(t.rollout_path, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"UserMessage"') || !line.includes('"client_id"')) continue
      try {
        const d = JSON.parse(line)
        const item = d.payload?.item
        if (d.type !== 'event_msg' || item?.type !== 'UserMessage' || !item.client_id) continue
        const said = (item.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim()
        if (said) rows.push({ tool: 'Codex', text: said, at: Date.parse(d.timestamp), dir: t.cwd, session: t.id })
      } catch {
        // 깨진 줄은 건너뛴다
      }
    }
  }
  return rows
}

const rows = [
  ...(wants('claude') ? readJsonl(path.join(claudeDir, 'history.jsonl')).map(r => ({ tool: 'Claude', text: r.display, at: Number(r.timestamp), dir: r.project, session: r.sessionId })) : []),
  ...(wants('codex') ? codexRows() : []),
  ...(wants('agy')
    ? readJsonl(path.join(home, '.gemini', 'antigravity-cli', 'history.jsonl'))
        .filter(r => r.type === undefined)
        .map(r => ({ tool: 'agy', text: r.display, at: Number(r.timestamp), dir: r.workspace, session: r.conversationId }))
    : []),
]
  .filter(r => typeof r.text === 'string' && r.text.trim() !== '' && !r.text.trim().startsWith('/') && Number.isFinite(r.at))
  .filter(r => isAll || r.dir === cwd)
  .sort((a, b) => a.at - b.at)
  // 같은 글을 연달아 다시 보낸 것은 한 번만
  .filter((r, i, all) => i === 0 || !(all[i - 1].text === r.text && all[i - 1].tool === r.tool && r.at - all[i - 1].at < 10 * 60_000))
  .slice(-limit)

if (isJson) {
  process.stdout.write(JSON.stringify(rows.map(r => ({ tool: r.tool, text: r.text, at: r.at, dir: r.dir, session: r.session }))) + '\n')
  process.exit(0)
}

const tty = process.stdout.isTTY || process.env.FORCE_COLOR
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)
const pad = n => String(n).padStart(2, '0')
const day = ms => {
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()}`
}
const clock = ms => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

if (rows.length === 0) {
  console.log(isAll ? '보낸 프롬프트가 없어요.' : `이 폴더(${cwd})에서 보낸 프롬프트가 없어요. --all로 모든 폴더를 볼 수 있어요.`)
  process.exit(0)
}
console.log(paint('1', `${isAll ? '모든 폴더' : cwd} · 프롬프트 ${rows.length}개 (오래된 것부터)`))
let lastDay = ''
for (const r of rows) {
  if (day(r.at) !== lastDay) {
    lastDay = day(r.at)
    console.log(paint('2', `── ${lastDay} ──`))
  }
  const tag = r.tool === 'agy' ? paint('38;2;138;180;248', 'agy   ') : r.tool === 'Codex' ? paint('38;2;120;200;160', 'Codex ') : paint('38;2;215;119;87', 'Claude')
  const where = isAll ? paint('2', ` ${r.dir?.replace(home, '~') ?? ''}`) : ''
  // 긴 글은 4줄까지만 (전문은 --json으로)
  const lines = r.text.trim().split('\n').map(l => (l.length > 300 ? `${l.slice(0, 300)}…` : l))
  const [first, ...rest] = lines.slice(0, 4)
  console.log(`${paint('2', clock(r.at))} ${tag}${where} ${first}`)
  for (const line of rest) console.log(`             ${line}`)
  if (lines.length > 4) console.log(paint('2', `             … (+${lines.length - 4}줄)`))
}
