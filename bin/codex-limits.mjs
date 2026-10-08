#!/usr/bin/env node
// Codex 사용 한도: Codex CLI의 앱 서버(`codex app-server`, 줄 단위 JSON-RPC)에 account/rateLimits/read를 묻고
// 답(rateLimits)만 한 줄 JSON으로 출력한다. 인증은 Codex가 스스로 하므로 토큰을 만지지 않는다.
//   node bin/codex-limits.mjs   →  {"primary":{"usedPercent":27,"windowDurationMins":10080,"resetsAt":1791948528},"secondary":null}
import { spawn } from 'node:child_process'

const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] })
let buffer = ''
let done = false
const finish = (out, code) => {
  if (done) return
  done = true
  process.stdout.write(`${JSON.stringify(out)}\n`)
  child.kill()
  process.exitCode = code
}
const timer = setTimeout(() => finish({ error: 'codex app-server did not answer in 12s' }, 1), 12_000)
child.on('error', error => {
  clearTimeout(timer)
  finish({ error: String(error.message ?? error) }, 1)
})
child.stdout.on('data', chunk => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (message.id !== 2) continue
    clearTimeout(timer)
    const limits = message.result?.rateLimits
    finish(limits ? { primary: limits.primary ?? null, secondary: limits.secondary ?? null } : { error: message.error?.message ?? 'no rateLimits' }, limits ? 0 : 1)
  }
})
const send = message => child.stdin.write(`${JSON.stringify(message)}\n`)
send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'ide-mod', version: '0.7.0' } } })
send({ method: 'initialized', params: {} })
send({ id: 2, method: 'account/rateLimits/read', params: {} })
