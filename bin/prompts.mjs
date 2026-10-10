#!/usr/bin/env node
// 이 폴더에서 내가 보낸 프롬프트: Claude Code와 agy(Antigravity CLI)의 입력 기록을 시간순으로 합쳐 보여 준다.
//   node bin/prompts.mjs            이 폴더, 최근 30개
//   node bin/prompts.mjs 100        최근 100개
//   node bin/prompts.mjs --all      모든 폴더
//   node bin/prompts.mjs --cwd DIR  다른 폴더
// agy 안에서는 `!node ~/ide-mod/bin/prompts.mjs`로 부른다 (모델을 거치지 않는다)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const flag = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
const isAll = argv.includes('--all')
const cwd = path.resolve(flag('--cwd') ?? process.cwd())
const limit = Number(argv.find(a => /^\d+$/.test(a))) || 30

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
const rows = [
  ...readJsonl(path.join(claudeDir, 'history.jsonl')).map(r => ({ tool: 'Claude', text: r.display, at: Number(r.timestamp), dir: r.project, session: r.sessionId })),
  ...readJsonl(path.join(home, '.gemini', 'antigravity-cli', 'history.jsonl'))
    .filter(r => r.type === undefined)
    .map(r => ({ tool: 'agy', text: r.display, at: Number(r.timestamp), dir: r.workspace, session: r.conversationId })),
]
  .filter(r => typeof r.text === 'string' && r.text.trim() !== '' && !r.text.trim().startsWith('/') && Number.isFinite(r.at))
  .filter(r => isAll || r.dir === cwd)
  .sort((a, b) => a.at - b.at)
  // 같은 글을 연달아 다시 보낸 것은 한 번만
  .filter((r, i, all) => i === 0 || !(all[i - 1].text === r.text && all[i - 1].tool === r.tool && r.at - all[i - 1].at < 10 * 60_000))
  .slice(-limit)

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
  const tag = r.tool === 'agy' ? paint('38;2;138;180;248', 'agy   ') : paint('38;2;215;119;87', 'Claude')
  const where = isAll ? paint('2', ` ${r.dir?.replace(home, '~') ?? ''}`) : ''
  const [first, ...rest] = r.text.trim().split('\n')
  console.log(`${paint('2', clock(r.at))} ${tag}${where} ${first}`)
  for (const line of rest) console.log(`             ${line}`)
}
