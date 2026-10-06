import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, On, Register, RenderElement, RenderInput } from 'claude-code'

import type { AgentPhase, AgentRow, Caption, GateCheck, GateResult, PeerRow, RequestItem, ViewMode } from '../types'

// ════════════════ 에이전트 보드 ════════════════
const MAIN = 'main'
const agentsAtom = atom({ plugin: 'ide-mod', key: 'agents' } as const, {} as Record<string, AgentRow>)
const tickAtom = atom({ plugin: 'ide-mod', key: 'tick' } as const, 0)
const foldedAtom = atom({ plugin: 'ide-mod', key: 'isBoardFolded' } as const, false)
const hideDoneAtom = atom({ plugin: 'ide-mod', key: 'hideDone' } as const, false)
const recapOnAtom = atom({ plugin: 'ide-mod', key: 'isRecapOn' } as const, true)

const LOG_SIZE = 12
const MAX_AGENTS = 40
const RECAP_EVERY_MS = 20_000
const RECAP_TIMEOUT_MS = 15_000
const RECAP_MODEL = 'haiku'
const RECAP_MAX_FAILURES = 3
// 목록에서 빠진 지 이만큼 소식이 없으면 끝난 것으로 본다
const STALE_AFTER_MS = 30_000
// 도구 입력에서 "무엇을 하는지" 가장 잘 말해주는 필드 순서
const SUMMARY_KEYS = ['description', 'command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'skill', 'subject', 'prompt', 'path']

const PHASE_ICON: Record<AgentPhase, string> = { running: '●', idle: '○', done: '✓', failed: '✗' }
const PHASE_COLOR: Record<AgentPhase, Color> = { running: 'warning', idle: 'subtle', done: 'success', failed: 'error' }
const PHASE_LABEL: Record<AgentPhase, string> = { running: '작업 중', idle: '대기', done: '완료', failed: '실패' }
const ROLE_COLORS: Color[] = ['suggestion', 'claude', 'permission', 'planMode', 'autoAccept', 'remember', 'ide', 'merged']
const LIST_PHASE: Record<string, AgentPhase> = {
  pending: 'running', running: 'running', waiting: 'idle', idle: 'idle', completed: 'done', failed: 'failed', killed: 'failed',
}

// 재로드되면 처음부터 다시 세는 값들: 화면이 읽는 값은 전부 $.state에 둔다
let isInteractive = true
let timersStarted = false
let isRecapping = false
let recapFailures = 0
let lastStatus: string | undefined
/** 보드가 마지막으로 그려진 시각: 창이 열려 있을 때만 요약을 만든다 */
let lastDrawnAt = 0

const oneLine = (text: string, max: number) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
const firstLine = (text: string) => text.split('\n').map(l => l.replace(/^[#>*\-\s]+/, '').trim()).find(l => l !== '') ?? ''

/** claude-opus-5-5[1m] → opus 5.5 1M, us.anthropic.claude-sonnet-4-5-20250929-v1:0 → sonnet 4.5 */
export const shortModel = (model: string) => {
  const isLong = /\[1m\]/i.test(model)
  const bare = model
    .replace(/\[.*?\]/g, '')
    .replace(/^.*?(?=claude-)/, '')
    .replace(/@.*$/, '')
    .replace(/-v\d+(:\d+)?$/, '')
  const m = /^(?:claude-)?([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(bare)
    ?? /^(?:claude-)(\d+)-(\d+)-([a-z]+)(?:-\d{8})?$/i.exec(bare)
  let name = bare
  if (m !== null && /^[a-z]/i.test(m[1] ?? '')) name = `${m[1]} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
  else if (m !== null) name = `${m[3]} ${m[1]}.${m[2]}`
  return isLong ? `${name} 1M` : name
}
const toolName = (tool: string) => (tool.startsWith('mcp__') ? tool.split('__').slice(2).join('__') || tool : tool)

export const describeCall = (tool: string, input: Record<string, unknown>) => {
  if (tool === 'Agent') {
    const type = typeof input.subagent_type === 'string' ? input.subagent_type : 'agent'
    return `Agent → ${type}: ${oneLine(String(input.description ?? ''), 50)}`
  }
  const key = SUMMARY_KEYS.find(k => typeof input[k] === 'string' && input[k] !== '')
  const detail = key === undefined ? '' : oneLine(String(input[key]), 60)
  return detail === '' ? toolName(tool) : `${toolName(tool)}  ${detail}`
}

const formatElapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

const freshRow = (id: string, fields: Partial<AgentRow>): AgentRow => ({
  id,
  role: id === MAIN ? 'main' : 'agent',
  task: '',
  model: '',
  phase: 'running',
  isBackground: false,
  isTeammate: false,
  activity: '',
  log: [],
  toolCount: 0,
  recap: '',
  isRecapStale: false,
  startedAt: Date.now(),
  updatedAt: Date.now(),
  ...fields,
})

/**
 * 한 에이전트 줄을 고친다. 서브에이전트 줄은 agent.spawn만 만든다: 엔진 내부의 포크(압축·메모리)는
 * spawn 없이 agentId를 달고 오고 끝을 알리지 않아서, 여기서 만들면 영영 "작업 중"으로 남는다.
 */
async function patch($: EngineInterface, id: string, fn: (row: AgentRow) => AgentRow | undefined, canCreate = id === MAIN) {
  await update($, agentsAtom, all => {
    const existing = all[id]
    if (existing === undefined && !canCreate) return all
    const changed = fn(existing ?? freshRow(id, {}))
    if (changed === undefined || changed === existing) return all
    const next = { ...all, [id]: changed }
    const ids = Object.keys(next)
    if (ids.length <= MAX_AGENTS) return next
    // 오래전에 끝난 서브에이전트부터 정리한다
    const drop = ids
      .filter(k => k !== MAIN && next[k]?.phase !== 'running')
      .sort((a, b) => (next[a]?.startedAt ?? 0) - (next[b]?.startedAt ?? 0))
      .slice(0, ids.length - MAX_AGENTS)
    for (const k of drop) delete next[k]
    return next
  })
  await refreshStatus($)
}

/** 서브에이전트가 돌 때만 상태줄에 모델·effort와 개수를 띄운다 (메인 모델은 기본 화면에도 있다) */
async function refreshStatus($: EngineInterface) {
  const all = await read($, agentsAtom)
  const running = Object.values(all).filter(r => r.id !== MAIN && r.phase === 'running').length
  const main = all[MAIN]
  const brain = main === undefined ? '' : `${shortModel(main.model) || '?'}${main.effort ? ` · ${main.effort}` : ''}  `
  const text = running > 0 ? `◆ ${brain}⇉ 서브에이전트 ${running}개 작업 중` : undefined
  if (text === lastStatus) return
  lastStatus = text
  $.ui.status(text)
}

/** 엔진의 에이전트 목록과 맞춰, 죽었거나 사라진 서브에이전트가 "작업 중"에 머물지 않게 한다 */
async function reconcile($: EngineInterface) {
  const all = await read($, agentsAtom)
  const running = Object.values(all).filter(r => r.id !== MAIN && r.phase === 'running')
  if (running.length === 0) return
  const listed = new Map((await $.agent.list().catch(() => [])).map(info => [info.id, info]))
  const now = Date.now()
  for (const row of running) {
    const info = listed.get(row.id)
    const phase: AgentPhase | undefined = info !== undefined
      ? LIST_PHASE[info.status]
      : now - row.updatedAt > STALE_AFTER_MS ? 'done' : undefined
    if (phase === undefined || phase === 'running') continue
    await patch($, row.id, r => (r.phase !== 'running' ? undefined : { ...r, phase, activity: '', endedAt: r.endedAt ?? now }))
  }
}

/** 쌓인 도구 기록을 haiku로 한 줄 요약한다. 타이머에서만, 보드가 화면에 있을 때만 부른다 */
async function recapStale($: EngineInterface) {
  if (isRecapping || Date.now() - lastDrawnAt > 30_000) return
  if (!(await read($, recapOnAtom))) return
  isRecapping = true
  try {
    const all = await read($, agentsAtom)
    const due = Object.values(all).filter(r => r.phase === 'running' && r.isRecapStale && r.log.length > 0).slice(0, 3)
    for (const row of due) {
      const seenTools = row.toolCount
      const prompt = [
        '아래는 코딩 에이전트 하나의 맡은 작업과 최근 도구 호출 기록이다.',
        '이 에이전트가 지금 무엇을 하고 있는지 한국어 한 문장(40자 이내, 마침표 없이)으로만 답하라.',
        `역할: ${row.role}`,
        `맡은 작업: ${row.task || '(알 수 없음)'}`,
        '최근 도구 호출(오래된 것부터):',
        ...row.log.map(l => `- ${l}`),
      ].join('\n')
      const answer = await $.model
        .complete({ model: RECAP_MODEL, prompt, maxTokens: 120, effort: 'low', timeoutMs: RECAP_TIMEOUT_MS })
        .catch(() => undefined)
      if (answer === undefined || !answer.isAnswered) {
        recapFailures += 1
        if (recapFailures >= RECAP_MAX_FAILURES) {
          await update($, recapOnAtom, () => false)
          $.ui.toast(`ide-mod: ${RECAP_MODEL} 요약 호출이 ${RECAP_MAX_FAILURES}번 실패해서 요약을 껐어요 (보드에서 s로 다시 켜기)`)
        }
        return
      }
      recapFailures = 0
      const recap = oneLine(answer.text.replace(/^["'「]|["'」.]$/g, ''), 80)
      // 기다리는 사이 끝났거나, 지워졌거나, 새 도구 호출이 쌓였으면 덮어쓰지 않는다
      await patch($, row.id, r => (r.phase !== 'running' || r.toolCount !== seenTools ? undefined : { ...r, recap, isRecapStale: false }), false)
    }
  } finally {
    isRecapping = false
  }
}

/** 요약·정리 타이머를 건다. 터미널(REPL)은 session.start에서, 데스크톱 앱·SDK처럼 isInteractive가 false로 오는
 *  화면은 보드가 처음 그려질 때 건다 (-p 실행처럼 아무것도 그리지 않으면 걸리지 않는다) */
function startAgents($: EngineInterface, interactive: boolean) {
  isInteractive = interactive
  if (interactive) startTimers($)
}

function startTimers($: EngineInterface) {
  if (timersStarted) return
  timersStarted = true
  $.clock.every(RECAP_EVERY_MS, () => void recapStale($).catch(() => undefined))
  $.clock.every(5_000, () =>
    void (async () => {
      await reconcile($)
      const all = await read($, agentsAtom)
      if (Object.values(all).some(r => r.phase === 'running')) await update($, tickAtom, n => n + 1)
    })().catch(() => undefined),
  )
}

function registerAgents(on: On) {
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, agentsAtom, () => ({}))
      lastStatus = undefined
      $.ui.status(undefined)
    }
    return next(e)
  })

  // 사람이 프롬프트를 보내면 메인 에이전트의 작업이 새로 정해진다 (서브에이전트는 turn.start가 없다)
  on('turn.start', async ($, e, next) => {
    // 사람이 보낸 요청으로 시작한 턴만 메인 작업을 바꾼다. 백그라운드 작업 알림·다른 세션 메시지로 시작한 턴은
    // 작업 줄은 두고 "지금 하는 일"만 바꾼다 (그 글은 사람이 쓴 게 아니라서 요청 기록에도 넣지 않는다)
    const own = personText(e.text)
    const isPersonTurn = own !== '' && (await requestTurnStarted($, own, e.turnId).catch(() => false))
    if (!isPersonTurn && e.text.trim() !== '') {
      await patch($, MAIN, row => ({ ...row, role: 'main', phase: 'running', activity: '알림·메시지 처리 중', updatedAt: Date.now(), endedAt: undefined }))
    }
    if (isPersonTurn) {
      await patch($, MAIN, row => ({
        ...row,
        role: 'main',
        task: oneLine(own, 120),
        phase: 'running',
        activity: '생각 중',
        log: [],
        recap: '',
        isRecapStale: false,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        endedAt: undefined,
      }))
      await setCaption($, '요청을 읽고 계획을 세우는 중이에요', true).catch(() => undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // 모델 요청마다 그 에이전트가 실제로 쓰는 모델과 effort가 실려 온다
  on('turn.step', async function* ($, e, next) {
    const effort = e.effort === undefined ? undefined : String(e.effort)
    await patch($, e.agentId ?? MAIN, row =>
      row.model === e.model && row.effort === effort && row.phase === 'running'
        ? undefined
        : { ...row, model: e.model, effort, phase: 'running', updatedAt: Date.now(), endedAt: undefined },
    ).catch(() => undefined)
    return yield* next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.agentId === undefined) return started
    const role = e.name ? `${e.subagentType} · ${e.name}` : e.fork ? `${e.subagentType} (fork)` : e.subagentType
    await patch(
      $,
      started.agentId,
      row => ({
        ...row,
        parentId: e.parentAgentId ?? MAIN,
        role,
        task: oneLine(e.description || firstLine(e.prompt), 120),
        model: row.model || started.model,
        isBackground: e.background,
        isTeammate: e.isTeammate === true,
        phase: 'running',
        activity: '시작하는 중',
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }),
      true,
    )
    await setCaption($, `${role} 에이전트가 일을 시작했어요 · ${oneLine(e.description, 50)}`).catch(() => undefined)
    return started
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId ?? MAIN
    const isFailed = e.reason !== 'answer'
    await patch($, id, row => {
      // 메인과 팀원은 턴이 끝나도 다음 지시를 기다릴 뿐이다
      const phase: AgentPhase = id === MAIN || row.isTeammate ? 'idle' : isFailed ? 'failed' : 'done'
      const note = e.isAborted ? '중단됨' : e.reason === 'error' ? '오류로 끝남' : e.reason === 'refusal' ? '거절로 끝남' : ''
      return {
        ...row,
        phase,
        activity: note,
        recap: oneLine(firstLine(e.answer), 120) || row.recap,
        isRecapStale: false,
        updatedAt: Date.now(),
        endedAt: Date.now(),
      }
    })
    if (id === MAIN) {
      await requestTurnEnded($, e.turnId, e.answer, e.isAborted || e.reason !== 'answer').catch(() => undefined)
      await setCaption($, e.isAborted ? '작업을 멈췄어요' : '답을 다 썼어요. 다음 요청을 기다려요').catch(() => undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}

/** 도구 호출 하나를 그 에이전트의 "지금 하는 일"로 기록한다 (탐색기와 같은 tool.call 훅에서 부른다) */
async function recordToolCall($: EngineInterface, agentId: string | undefined, tool: string, input: Record<string, unknown>) {
  const line = describeCall(tool, input)
  await patch($, agentId ?? MAIN, row => ({
    ...row,
    phase: 'running',
    activity: line,
    log: [...row.log, line].slice(-LOG_SIZE),
    toolCount: row.toolCount + 1,
    isRecapStale: true,
    updatedAt: Date.now(),
  }))
}

/**
 * IDE 창 맨 위의 에이전트 보드: 한 줄이 한 행인 요소들을 돌려준다.
 * 아래 탐색기가 남은 행을 정확히 쓰도록 maxRows를 넘기지 않는다.
 */
async function drawBoard($: EngineInterface, e: RenderInput<'Pane'>, width: number, maxRows: number): Promise<RenderElement[]> {
  const { Box, Text, Button } = $.ui.resolve(e)
  lastDrawnAt = Date.now()
  startTimers($)
  const all = await read($, agentsAtom)
  const isFolded = await read($, foldedAtom)
  const hideDone = await read($, hideDoneAtom)
  const isRecapOn = await read($, recapOnAtom)
  await read($, tickAtom)
  const now = Date.now()

  const subs = Object.values(all).filter(r => r.id !== MAIN)
  const running = subs.filter(r => r.phase === 'running').length
  const main = all[MAIN]
  const mainBrain = main === undefined ? '' : `${shortModel(main.model) || '…'}${main.effort ? ` · ${main.effort}` : ''}`
  const summary = `에이전트 ${main === undefined ? '대기' : `${PHASE_ICON[main.phase]} ${mainBrain}`} · 서브 ${running}개 작업 중 / ${subs.length - running}개 끝남`

  const sessionId = await $.session.id().catch(() => '')
  const header = (
    <Box key="board-header" flexDirection="row" columnGap={2} height={1} overflow="hidden">
      <Text bold wrap="truncate-end">{summary}</Text>
      {sessionId !== '' && <Text dimColor wrap="truncate-end">세션 {sessionId.slice(0, 8)}</Text>}
      <Button key="board-handoff" plain hotkey="i" label="핸드오프" onPress={() => void openHandoff($)} />
      <Button key="board-fold" plain hotkey="a" label={isFolded ? '보드 펼치기' : '보드 접기'} onPress={() => void update($, foldedAtom, v => !v)} />
      {!isFolded && <Button key="board-hide" plain hotkey="h" label={hideDone ? '끝난 것 보이기' : '끝난 것 숨기기'} onPress={() => void update($, hideDoneAtom, v => !v)} />}
      {!isFolded && <Button key="board-recap" plain hotkey="s" label={isRecapOn ? `요약 끄기(${RECAP_MODEL})` : '요약 켜기'} onPress={() => { recapFailures = 0; void update($, recapOnAtom, v => !v) }} />}
      {!isFolded && (
        <Button
          key="board-clear"
          plain
          hotkey="x"
          label="끝난 것 지우기"
          onPress={() => void update($, agentsAtom, list => Object.fromEntries(Object.entries(list).filter(([id, r]) => id === MAIN || r.phase === 'running')))}
        />
      )}
    </Box>
  )
  if (isFolded || maxRows <= 1) return [header]

  // 숨길 때도 돌고 있는 에이전트와 그 조상은 남겨 트리가 끊기지 않게 한다
  const visible = new Set<string>([MAIN])
  for (const row of subs) {
    if (hideDone && row.phase !== 'running') continue
    for (let at: AgentRow | undefined = row; at !== undefined && !visible.has(at.id); at = at.parentId === undefined ? undefined : all[at.parentId]) visible.add(at.id)
  }
  const children = new Map<string, AgentRow[]>()
  for (const row of subs) {
    if (!visible.has(row.id)) continue
    const parent = row.parentId !== undefined && visible.has(row.parentId) && all[row.parentId] !== undefined ? row.parentId : MAIN
    children.set(parent, [...(children.get(parent) ?? []), row])
  }
  for (const list of children.values()) list.sort((a, b) => a.startedAt - b.startedAt)
  const roleColor = new Map<string, Color>()
  const colorOf = (role: string) => {
    const base = role.split(' ')[0] ?? role
    if (!roleColor.has(base)) roleColor.set(base, ROLE_COLORS[roleColor.size % ROLE_COLORS.length] ?? 'suggestion')
    return roleColor.get(base) ?? 'suggestion'
  }

  const lines: RenderElement[] = []
  const draw = (row: AgentRow, lead: string, branch: string, depth: number) => {
    const elapsed = formatElapsed((row.endedAt ?? now) - row.startedAt)
    const brain = `${shortModel(row.model) || '모델 확인 중'}${row.effort ? ` · ${row.effort}` : ''}`
    const pad = `${lead}${depth === 0 ? '' : branch === '└─ ' ? '   ' : '│  '}  `
    // 지금 하는 일·요약은 노란색(돌고 있을 때만), 끝난 결과는 흐리게
    const isLive = row.phase === 'running'
    const [label, body] = isLive && row.recap !== '' ? ['요약', row.recap] : isLive && row.activity !== '' ? ['지금', row.activity] : row.recap !== '' ? ['결과', row.recap] : ['', row.activity]
    const live = isLive && body !== ''
    lines.push(
      <Text key={`agent:${row.id}`} wrap="truncate-end">
        <Text dimColor>{lead}{depth === 0 ? '' : branch}</Text>
        <Text color={PHASE_COLOR[row.phase]}>{PHASE_ICON[row.phase]} </Text>
        <Text bold color={row.id === MAIN ? 'claude' : colorOf(row.role)}>{row.id === MAIN ? '메인' : row.role}</Text>
        <Text>  {brain}</Text>
        <Text dimColor>  {PHASE_LABEL[row.phase]} {elapsed}{row.isBackground ? ' · 백그라운드' : ''}{row.toolCount > 0 ? ` · 도구 ${row.toolCount}` : ''}</Text>
        {/* 맡긴 일(메인은 사람이 입력한 프롬프트, 서브에이전트는 받은 작업 설명)은 초록색 */}
        <Text color="success">{row.task !== '' ? `  ${oneLine(row.task, 80)}` : ''}</Text>
      </Text>,
    )
    if (body !== '') {
      lines.push(
        <Text key={`agent-doing:${row.id}`} wrap="truncate-end">
          <Text dimColor>{pad}{label === '' ? '' : `${label} `}</Text>
          <Text color={live ? 'warning' : undefined} dimColor={!live}>{oneLine(body, Math.max(10, width))}</Text>
        </Text>,
      )
    }
    const kids = children.get(row.id) ?? []
    kids.forEach((kid, i) => {
      const nextLead = depth === 0 ? lead : `${lead}${branch === '└─ ' ? '   ' : '│  '}`
      draw(kid, nextLead, i === kids.length - 1 ? '└─ ' : '├─ ', depth + 1)
    })
  }
  if (main !== undefined) draw(main, '', '', 0)
  else (children.get(MAIN) ?? []).forEach((kid, i, kids) => draw(kid, '', i === kids.length - 1 ? '└─ ' : '├─ ', 1))

  const room = maxRows - 1
  if (lines.length === 0) return [header, <Text key="board-empty" dimColor>프롬프트를 보내면 에이전트가 여기 나타나요.</Text>].slice(0, maxRows)
  if (lines.length <= room) return [header, ...lines]
  return [header, ...lines.slice(0, room - 1), <Text key="board-more" dimColor>… {lines.length - room + 1}줄 더 (a로 접기, h로 끝난 것 숨기기)</Text>]
}

// ════════════════ 탐색기 ════════════════
const PANE = 'ide-mod'
const rootAtom = atom({ plugin: 'ide-mod', key: 'root' } as const, '')
const expandedAtom = atom({ plugin: 'ide-mod', key: 'expanded' } as const, [] as string[])
const tabsAtom = atom({ plugin: 'ide-mod', key: 'tabs' } as const, [] as string[])
const activeAtom = atom({ plugin: 'ide-mod', key: 'active' } as const, '')
const treeOffsetAtom = atom({ plugin: 'ide-mod', key: 'treeOffset' } as const, 0)
const offsetsAtom = atom({ plugin: 'ide-mod', key: 'offsets' } as const, {} as Record<string, number>)
const modeAtom = atom({ plugin: 'ide-mod', key: 'mode' } as const, 'code' as ViewMode)
const revAtom = atom({ plugin: 'ide-mod', key: 'rev' } as const, 0)
const touchedAtom = atom({ plugin: 'ide-mod', key: 'touched' } as const, [] as string[])
const treeHiddenAtom = atom({ plugin: 'ide-mod', key: 'isTreeHidden' } as const, false)

const MAX_BYTES = 4 * 1024 * 1024
const MAX_TREE_ROWS = 3000
const MAX_TABS = 8
const MAX_RENDERED_CHARS = 90_000
// 이보다 좁으면 트리와 파일을 한 번에 하나만 보여준다
const SPLIT_MIN_COLUMNS = 70
const SKIP_NAMES = new Set(['.DS_Store'])
const MARKDOWN = /\.(md|markdown|mdx)$/i
const PNG = /\.png$/i
const OTHER_IMAGE = /\.(jpe?g|gif|webp|bmp|heic|tiff?|ico)$/i
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

type TreeRow = { path: string; name: string; depth: number; isDir: boolean; isOpen: boolean; isLoop: boolean }

// 스크롤 훅이 쓰는 마지막 배치: 그릴 때마다 다시 잰다
const layout = {
  /** 탐색기 위에 놓인 행 수(에이전트 보드·구분선·툴바) */
  topRows: 0,
  showTree: true,
  showFile: true,
  treeWidth: 30,
  treeRows: 0,
  treeView: 10,
  active: '',
  fileMaxOffset: 0,
  leftMode: 'files' as 'files' | 'requests' | 'handoff',
  requestRows: 0,
}
// 스크롤할 때마다 디스크를 다시 읽지 않도록: 트리는 (뿌리·펼친 폴더·세대)로, 파일은 수정 시각으로 재사용한다
let treeEpoch = 0
let treeCache: { key: string; rows: TreeRow[]; isCut: boolean } | undefined
const fileCache = new Map<string, { mtimeMs: number; size: number; lines: string[] }>()
// 그림은 터미널이 파일을 직접 읽게 하지 않고 base64로 넘긴다(그래픽 터미널마다 파일 읽기 처리가 달라 멈출 수 있음).
// Image가 받는 최대 크기(2 MiB)를 넘으면 그리지 않는다
const PNG_INLINE_MAX = 2 * 1024 * 1024
const pngCache = new Map<string, { key: string; base64: string }>()
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
/** base64 앞부분만 바이트로 푼다 */
const base64Head = (text: string, count: number) => {
  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (const ch of text) {
    const v = B64.indexOf(ch)
    if (v < 0) break
    buffer = (buffer << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >> bits) & 0xff)
      if (out.length >= count) break
    }
  }
  return out
}
async function pngData($: EngineInterface, path: string, key: string) {
  const hit = pngCache.get(path)
  if (hit?.key === key) return hit.base64
  const { base64 } = await $.fs.read(path, { as: 'bytes' })
  if ((base64.length * 3) / 4 > PNG_INLINE_MAX) return undefined
  // PNG 서명과 IHDR가 없으면 엔진이 창 전체를 거절하므로 미리 걸러낸다
  const head = base64Head(base64, 16)
  const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 && String.fromCharCode(...head.slice(12, 16)) === 'IHDR'
  if (!isPng) return undefined
  pngCache.set(path, { key, base64 })
  while (pngCache.size > 6) pngCache.delete(pngCache.keys().next().value as string)
  return base64
}
const FILE_CACHE_SIZE = 8

const baseName = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path
const parentOf = (path: string) => {
  const cut = path.replace(/\/+$/, '').lastIndexOf('/')
  return cut <= 0 ? '/' : path.slice(0, cut)
}
const joinPath = (dir: string, name: string) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`)
const isInside = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith('/') ? dir : `${dir}/`)
export const clamp = (n: number, low: number, high: number) => Math.min(Math.max(n, low), Math.max(low, high))
const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B`
    : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`
// 그리기 요소는 탭과 줄바꿈 말고 제어 문자를 받지 않는다
const cleanText = (text: string) =>
  text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')

// 한글·한자·이모지는 터미널에서 두 칸, 조합용 모음·받침과 결합 부호는 0칸
const WIDE = /[ᄀ-ᅟ☀-➿⬀-⯿⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1f300}-\u{1faff}]/u
const ZERO = /[̀-ͯᅠ-ᇿ​-‏︀-️]/
const cellsOf = (ch: string) => (ZERO.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1)
/** 터미널 칸 수에 맞춰 자른다 (macOS가 풀어 쓴 한글 이름은 먼저 모아 쓴다) */
export const fit = (raw: string, columns: number) => {
  const text = raw.normalize('NFC')
  if ([...text].reduce((n, ch) => n + cellsOf(ch), 0) <= columns) return text
  let used = 0
  let out = ''
  for (const ch of text) {
    if (used + cellsOf(ch) > columns - 1) break
    used += cellsOf(ch)
    out += ch
  }
  return `${out}…`
}

/** 렌더 모드에서 창을 시작해도 되는 줄: 빈 줄 다음이면서 코드 울타리(```) 밖 */
export const blockStarts = (lines: string[]) => {
  const starts = [0]
  let isFenced = false
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) isFenced = !isFenced
    if (!isFenced && i + 1 < lines.length && line.trim() === '' && lines[i + 1]?.trim() !== '') starts.push(i + 1)
  })
  return starts
}

/** 입력한 경로(상대, ~, 따옴표, @ 포함)를 실제 절대 경로로 바꾼다 */
async function resolvePath($: EngineInterface, raw: string): Promise<{ path: string; isDir: boolean } | { error: string }> {
  let target = raw.trim().replace(/^@/, '').replace(/^(['"])(.*)\1$/, '$2')
  if (target === '') target = '.'
  if (target === '~' || target.startsWith('~/')) {
    const home = await $.env.get('HOME')
    if (home === undefined) return { error: '홈 폴더(HOME)를 알 수 없어요.' }
    target = home + target.slice(1)
  }
  const stat = await $.fs.stat(target, { resolve: true }).catch(() => undefined)
  if (stat?.realPath === undefined) return { error: `파일을 찾을 수 없어요: ${raw.trim()}` }
  return { path: stat.realPath, isDir: stat.kind === 'dir' }
}

const remember = (path: string, entry: { mtimeMs: number; size: number; lines: string[] }) => {
  fileCache.delete(path)
  fileCache.set(path, entry)
  while (fileCache.size > FILE_CACHE_SIZE) {
    const oldest = fileCache.keys().next().value
    if (oldest === undefined) break
    fileCache.delete(oldest)
  }
}

/** 파일을 탭으로 열고, 트리에서 보이도록 조상 폴더를 펼친다 */
async function openFile($: EngineInterface, raw: string) {
  const path = (await $.fs.stat(raw, { resolve: true }).catch(() => undefined))?.realPath ?? raw
  const root = (await read($, rootAtom)) || (await $.session.cwd())
  if (!isInside(path, root)) {
    await update($, rootAtom, () => parentOf(path))
    await update($, treeOffsetAtom, () => 0)
  } else {
    const ancestors: string[] = []
    for (let dir = parentOf(path); isInside(dir, root) && dir !== root; dir = parentOf(dir)) ancestors.push(dir)
    await update($, expandedAtom, list => [...new Set([...list, ...ancestors])])
  }
  await update($, tabsAtom, list => {
    if (list.includes(path)) return list
    const next = [...list, path]
    return next.length > MAX_TABS ? next.slice(next.length - MAX_TABS) : next
  })
  await update($, activeAtom, () => path)
  // 좁은 화면에서는 파일을 고르면 파일 쪽으로 넘어간다
  if (!(layout.showTree && layout.showFile)) await update($, treeHiddenAtom, () => true)
}

async function closeTab($: EngineInterface, path: string) {
  const tabs = await read($, tabsAtom)
  const at = tabs.indexOf(path)
  const rest = tabs.filter(t => t !== path)
  fileCache.delete(path)
  await update($, tabsAtom, () => rest)
  if ((await read($, activeAtom)) === path) await update($, activeAtom, () => rest[Math.min(at, rest.length - 1)] ?? '')
}

async function pressEntry($: EngineInterface, row: TreeRow) {
  if (row.isDir) {
    if (row.isLoop) return
    await update($, expandedAtom, list => (list.includes(row.path) ? list.filter(p => p !== row.path) : [...list, row.path]))
  } else {
    await openFile($, row.path)
  }
}

async function buildTree($: EngineInterface, root: string, expanded: Set<string>) {
  const rows: TreeRow[] = []
  let isCut = false
  const walk = async (dir: string, real: string, depth: number) => {
    const entries = await $.fs.list(dir).catch(() => [])
    const items = await Promise.all(
      entries
        .filter(entry => !SKIP_NAMES.has(entry.name))
        .map(async entry => {
          const path = joinPath(dir, entry.name)
          if (!entry.isLink) return { entry, path, isDir: entry.kind === 'dir', real: joinPath(real, entry.name) }
          // 링크는 가리키는 곳을 따라가서 폴더면 폴더로 보여준다
          const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
          return { entry, path, isDir: stat?.kind === 'dir', real: stat?.realPath ?? path }
        }),
    )
    items.sort((a, b) => (a.isDir === b.isDir ? a.entry.name.localeCompare(b.entry.name) : a.isDir ? -1 : 1))
    for (const item of items) {
      if (rows.length >= MAX_TREE_ROWS) {
        isCut = true
        return
      }
      // 자기 조상을 가리키는 링크는 펼치지 않는다 (무한 트리 방지)
      const isLoop = item.isDir && item.entry.isLink && isInside(real, item.real)
      const isOpen = item.isDir && !isLoop && expanded.has(item.path)
      rows.push({ path: item.path, name: item.entry.name, depth, isDir: item.isDir, isOpen, isLoop })
      if (isOpen) await walk(item.path, item.real, depth + 1)
    }
  }
  const rootReal = (await $.fs.stat(root, { resolve: true }).catch(() => undefined))?.realPath ?? root
  await walk(root, rootReal, 0)
  return { rows, isCut }
}

async function treeRows($: EngineInterface, root: string, expanded: string[], rev: number) {
  const key = JSON.stringify([root, [...expanded].sort(), rev, treeEpoch])
  if (treeCache?.key !== key) treeCache = { key, ...(await buildTree($, root, new Set(expanded))) }
  return treeCache
}

async function readLines($: EngineInterface, path: string, mtimeMs: number, size: number) {
  const cached = fileCache.get(path)
  if (cached !== undefined && cached.mtimeMs === mtimeMs && cached.size === size) return cached.lines
  const raw = await $.fs.read(path)
  if (raw.slice(0, 8000).includes('\u0000')) return undefined
  const lines = cleanText(raw).split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  remember(path, { mtimeMs, size, lines })
  return lines
}

/** /open, /ide가 부른다: 경로를 열고 창을 띄운다 */
async function openIde($: EngineInterface, args: string) {
  if (args.trim() !== '') {
    const resolved = await resolvePath($, args)
    if ('error' in resolved) return resolved.error
    if (resolved.isDir) {
      await update($, rootAtom, () => resolved.path)
      await update($, treeOffsetAtom, () => 0)
      await update($, treeHiddenAtom, () => false)
    } else {
      await openFile($, resolved.path)
    }
  }
  await $.ui.open({ id: PANE, title: 'IDE', focus: true, rows: 36, columns: 150 })
  const root = (await read($, rootAtom)) || (await $.session.cwd())
  return `IDE를 열었어요: ${root}`
}

/** Claude가 파일을 고치면 트리에 표시하고, 열려 있는 탭은 다시 읽는다 (거절·실패한 호출은 빼고) */
async function noteEdit($: EngineInterface, tool: string, input: Record<string, unknown>, ran: { deny?: string; isError?: true }) {
  if (!EDIT_TOOLS.includes(tool) || ran.deny !== undefined || ran.isError === true) return
  const touched = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined
  if (touched === undefined) return
  const real = (await $.fs.stat(touched, { resolve: true }).catch(() => undefined))?.realPath
  if (real === undefined) return
  fileCache.delete(real)
  treeEpoch += 1
  await update($, touchedAtom, list => (list.includes(real) ? list : [...list, real].slice(-300)))
  await update($, revAtom, n => n + 1)
}

function registerExplorerScroll(on: On) {
  // 휠은 포인터가 있는 쪽(트리/파일)을, 키보드는 열린 파일을(없으면 트리를) 스크롤한다
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.pointer !== undefined && e.pointer.row < layout.topRows) return {}
    const isOverTree = layout.showTree && (!layout.showFile || layout.active === '' || (e.pointer !== undefined && e.pointer.column < layout.treeWidth))
    if (isOverTree && layout.leftMode === 'requests') {
      await update($, requestOffsetAtom, n => clamp(n + e.by, 0, layout.requestRows - layout.treeView))
    } else if (isOverTree) {
      await update($, treeOffsetAtom, n => clamp(n + e.by, 0, layout.treeRows - layout.treeView))
    } else if (layout.active !== '' && hwpNow.path === layout.active && HWP.test(layout.active) && (await read($, hwpViewAtom)) === 'doc') {
      // 문서 보기: 쪽 안에서 움직이다 끝에 닿으면 다음(앞) 쪽으로 넘긴다
      const { path, page, pages } = hwpNow
      const key = hwpOffsetKey(path, page)
      const now = (await read($, offsetsAtom))[key] ?? 0
      if (e.by > 0 && now >= layout.fileMaxOffset && page < pages - 1) {
        await update($, offsetsAtom, all => ({ ...all, [hwpOffsetKey(path, page + 1)]: 0 }))
        await update($, hwpPagesAtom, all => ({ ...all, [path]: page + 1 }))
      } else if (e.by < 0 && now <= 0 && page > 0) {
        await update($, offsetsAtom, all => ({ ...all, [hwpOffsetKey(path, page - 1)]: 100_000 }))
        await update($, hwpPagesAtom, all => ({ ...all, [path]: page - 1 }))
      } else {
        await update($, offsetsAtom, all => ({ ...all, [key]: clamp(now + e.by, 0, layout.fileMaxOffset) }))
      }
    } else if (layout.active !== '') {
      const path = layout.active
      await update($, offsetsAtom, all => ({ ...all, [path]: clamp((all[path] ?? 0) + e.by, 0, layout.fileMaxOffset) }))
    }
    return {}
  }).catch(($, e, next) => next(e))
}

/** 탐색기 부분: 툴바 한 줄 + 트리 | 탭 에디터. 정확히 rows 행을 쓴다 */
async function drawExplorer($: EngineInterface, e: RenderInput<'Pane'>, width: number, rows: number, topRows: number): Promise<RenderElement> {
  const { Box, Text, Button, Code, Markdown } = $.ui.resolve(e)
  const root = (await read($, rootAtom)) || (await $.session.cwd())
  const expanded = await read($, expandedAtom)
  const tabs = await read($, tabsAtom)
  const active = await read($, activeAtom)
  const offsets = await read($, offsetsAtom)
  const mode = await read($, modeAtom)
  const touched = new Set(await read($, touchedAtom))
  const isTreeHidden = await read($, treeHiddenAtom)
  const rev = await read($, revAtom)
  const leftMode = await read($, leftModeAtom)
  const requests = await read($, requestsAtom)
  const selectedN = await read($, selectedRequestAtom)
  const hwpView = await read($, hwpViewAtom)
  const isRequests = leftMode === 'requests'
  const isHandoff = leftMode === 'handoff'
  const isFiles = leftMode === 'files'
  const peers = isHandoff ? await read($, peersAtom) : []
  const handoff = isHandoff ? await currentHandoff($).catch(() => undefined) : undefined
  const sent = isHandoff ? await read($, handoffSentAtom) : null
  // 요청 기록 모드: 기본은 이번 세션 요청 전부를 오른쪽에 이어서 보여 주고, 왼쪽에서 고르면 그 요청 하나만 펼친다
  const requestView = await read($, requestViewAtom)
  const isAllRequests = isRequests && requestView === 'all' && requests.length > 0
  const selected = requests.find(r => r.n === selectedN) ?? requests[requests.length - 1]
  const rightKey = isHandoff ? 'handoff' : isRequests ? (isAllRequests ? 'requests:all' : selected === undefined ? '' : `request:${selected.n}`) : active
  const isHwp = isFiles && HWP.test(active)

  const isWide = width >= SPLIT_MIN_COLUMNS
  const showTree = isWide ? !isTreeHidden || rightKey === '' : !(isTreeHidden && rightKey !== '')
  const showFile = isWide ? true : !showTree
  const treeWidth = showTree && showFile ? clamp(Math.round(width * 0.3), 24, 44) : width
  const fileWidth = showTree && showFile ? width - treeWidth - 1 : width
  const mainRows = Math.max(1, rows - 1)
  const isMarkdown = isFiles && MARKDOWN.test(active)
  layout.topRows = topRows
  layout.leftMode = leftMode

  // ── 툴바 ──
  const toolbar = (
    <Box key="ide-toolbar" flexDirection="row" columnGap={2} height={1} overflow="hidden">
      <Button key="tree" plain hotkey="t" label={showTree && showFile ? '트리 접기' : '트리'} onPress={() => void update($, treeHiddenAtom, v => (rightKey === '' ? false : !v))} />
      <Button
        key="left-mode"
        plain
        hotkey="q"
        label={isFiles ? `요청 기록 ${requests.length}` : '파일 트리'}
        onPress={() =>
          void (async () => {
            await update($, leftModeAtom, m => (m === 'files' ? 'requests' : 'files'))
            await update($, treeHiddenAtom, () => false)
          })()
        }
      />
      <Button
        key="up"
        plain
        hotkey="u"
        label="상위 폴더"
        onPress={() =>
          void (async () => {
            await update($, expandedAtom, list => [...new Set([...list, root])])
            await update($, rootAtom, () => parentOf(root))
            await update($, treeOffsetAtom, () => 0)
          })()
        }
      />
      <Button
        key="reload"
        plain
        hotkey="r"
        label="새로고침"
        onPress={() => {
          if (isHandoff) {
            void loadPeers($).catch(() => undefined)
            return
          }
          fileCache.clear()
          hwpTextCache.clear()
          hwpPageCache.clear()
          hwpGridCache.clear()
          treeEpoch += 1
          void update($, revAtom, n => n + 1)
        }}
      />
      {isHwp && (
        <Button key="hwp-view" plain hotkey="v" label={hwpView === 'image' ? '문서 보기' : '그림 보기'} onPress={() => void update($, hwpViewAtom, v => (v === 'image' ? 'doc' : 'image'))} />
      )}
      {isHwp && (
        <Button key="hwp-open" plain hotkey="o" label="미리보기로 열기" onPress={() => void openHwpPreview($, active, hwpNow.path === active ? hwpNow.page : 0)} />
      )}
      {isHwp && (
        <Button key="hwp-prev" plain hotkey="b" label="◀ 앞쪽" onPress={() => void update($, hwpPagesAtom, all => ({ ...all, [active]: Math.max(0, (all[active] ?? 0) - 1) }))} />
      )}
      {isHwp && (
        <Button key="hwp-next" plain hotkey="n" label="뒤쪽 ▶" onPress={() => void update($, hwpPagesAtom, all => ({ ...all, [active]: (all[active] ?? 0) + 1 }))} />
      )}
      {isRequests && requests.length > 0 && (
        <Button key="request-all" plain hotkey="l" label={isAllRequests ? '하나만 보기' : '모두 보기'} onPress={() => void update($, requestViewAtom, v => (v === 'all' ? 'one' : 'all'))} />
      )}
      {isRequests && !isAllRequests && selected !== undefined && (
        <Button key="request-again" plain hotkey="p" label="입력창에 다시 넣기" onPress={() => void $.prompt.fill({ text: selected.text, mode: 'insert' })} />
      )}
      {isRequests && !isAllRequests && selected !== undefined && <Button key="request-copy" plain hotkey="c" label="복사" onPress={() => void $.ui.copy({ text: selected.text, surface: e.surface })} />}
      {isAllRequests && <Button key="request-copy-all" plain hotkey="c" label="전부 복사" onPress={() => void $.ui.copy({ text: requestsAsText(requests), surface: e.surface })} />}
      {isHandoff && handoff !== undefined && (
        <Button key="handoff-copy" plain hotkey="c" label="핸드오프 글 복사" onPress={() => void $.ui.copy({ text: handoff.text, surface: e.surface })} />
      )}
      {isHandoff && handoff !== undefined && <Button key="handoff-id" plain hotkey="y" label="세션 ID 복사" onPress={() => void $.ui.copy({ text: handoff.info.id, surface: e.surface })} />}
      {isHandoff && handoff !== undefined && (
        <Button
          key="handoff-resume"
          plain
          hotkey="e"
          label="이어서 열기 명령 복사"
          onPress={() => void $.ui.copy({ text: `cd ${shellQuote(handoff.info.root)} && claude --resume ${handoff.info.id} --fork-session`, surface: e.surface })}
        />
      )}
      {isFiles && active !== '' && isMarkdown && (
        <Button key="mode" plain hotkey="m" label={mode === 'rendered' ? '원문' : '렌더'} onPress={() => void update($, modeAtom, m => (m === 'rendered' ? 'code' : 'rendered'))} />
      )}
      {isFiles && active !== '' && <Button key="mention" plain hotkey="p" label="@프롬프트" onPress={() => void $.prompt.fill({ text: `@${active} `, mode: 'insert' })} />}
      {isFiles && active !== '' && <Button key="copy" plain hotkey="c" label="경로 복사" onPress={() => void $.ui.copy({ text: active, surface: e.surface })} />}
      {isFiles && active !== '' && <Button key="close" plain hotkey="w" label="탭 닫기" onPress={() => void closeTab($, active)} />}
    </Box>
  )

  // ── 트리 / 요청 기록 ──
  let treeColumn: RenderElement | false = false
  if (showTree && isHandoff) {
    const self = await read($, selfNameAtom)
    treeColumn = (
      <Box key="ide-peers" flexDirection="column" width={treeWidth} height={mainRows} overflow="hidden">
        <Text bold wrap="truncate-end">보낼 세션 {peers.length}개 · r 새로고침</Text>
        {self !== '' && <Text dimColor wrap="truncate-end">이 세션: {self}</Text>}
        {peers.length === 0 && <Text dimColor>열려 있는 다른 세션이 없어요. c로 핸드오프 글을 복사해 다른 에이전트에 붙여 넣으세요.</Text>}
        {peers.slice(0, Math.max(1, mainRows - 2)).map(peer => (
          <Box key={`peer-row:${peer.ref}`} flexDirection="row" height={1} overflow="hidden">
            <Button
              key={`peer:${peer.ref}`}
              plain
              dimColor={peer.status !== 'idle'}
              label={fit(`→ ${peer.name} · ${peer.status === 'busy' ? '작업 중' : peer.status === 'idle' ? '대기' : peer.status}`, treeWidth)}
              onPress={() => void sendHandoff($, peer)}
            />
          </Box>
        ))}
      </Box>
    )
  } else if (showTree && isRequests) {
    const treeView = Math.max(1, mainRows - 1)
    const newestFirst = [...requests].reverse()
    const requestOffset = clamp(await read($, requestOffsetAtom), 0, newestFirst.length - treeView)
    Object.assign(layout, { requestRows: newestFirst.length, treeView })
    const shown = newestFirst.slice(requestOffset, requestOffset + treeView)
    treeColumn = (
      <Box key="ide-requests" flexDirection="column" width={treeWidth} height={mainRows} overflow="hidden">
        <Text bold wrap="truncate-end">요청 기록 {requests.length}개{requests.length > treeView ? ` · ${requestOffset + 1}-${requestOffset + shown.length}` : ''}</Text>
        {shown.length === 0 && <Text dimColor>아직 보낸 요청이 없어요. 이 세션에서 보내는 요청이 여기 쌓여요.</Text>}
        {shown.map(r => {
          const isOn = !isAllRequests && r.n === selected?.n
          return (
            <Box key={`req-row:${r.n}`} flexDirection="row" height={1} overflow="hidden" backgroundColor={isOn ? 'promptBorder' : undefined}>
              <Button
                key={`req:${r.n}`}
                plain
                dimColor={r.status !== 'running' && !isOn}
                label={fit(`${r.n}. ${REQUEST_ICON[r.status]} ${clock(r.at)} ${oneLine(r.text, 200)}`, treeWidth)}
                onPress={() =>
                  void (async () => {
                    await update($, selectedRequestAtom, () => r.n)
                    await update($, requestViewAtom, () => 'one')
                    if (!(layout.showTree && layout.showFile)) await update($, treeHiddenAtom, () => true)
                  })()
                }
              />
            </Box>
          )
        })}
      </Box>
    )
  } else if (showTree) {
    const tree = await treeRows($, root, expanded, rev)
    const treeView = Math.max(1, mainRows - 1)
    const treeOffset = clamp(await read($, treeOffsetAtom), 0, tree.rows.length - treeView)
    Object.assign(layout, { treeRows: tree.rows.length, treeView })
    const shown = tree.rows.slice(treeOffset, treeOffset + treeView)
    const position = tree.rows.length > treeView ? ` ${treeOffset + 1}-${treeOffset + shown.length}/${tree.rows.length}${tree.isCut ? '+' : ''}` : ''
    const page = Math.max(1, Math.floor(treeView / 2))

    treeColumn = (
      <Box key="ide-tree" flexDirection="column" width={treeWidth} height={mainRows} overflow="hidden">
        <Box flexDirection="row" height={1} overflow="hidden">
          <Text bold wrap="truncate-end">{fit(baseName(root) || '/', Math.max(4, treeWidth - position.length - 6))}</Text>
          <Text dimColor>{position} </Text>
          <Button key="tree-up" plain hotkey="k" label="▲" onPress={() => void update($, treeOffsetAtom, n => clamp(n - page, 0, tree.rows.length - treeView))} />
          <Button key="tree-down" plain hotkey="j" label="▼" onPress={() => void update($, treeOffsetAtom, n => clamp(n + page, 0, tree.rows.length - treeView))} />
        </Box>
        {shown.length === 0 && <Text dimColor>빈 폴더예요.</Text>}
        {shown.map(row => {
          const isActive = row.path === active
          const isTouched = row.isDir ? [...touched].some(p => isInside(p, row.path)) : touched.has(row.path)
          const icon = row.isDir ? (row.isLoop ? '↻ ' : row.isOpen ? '▾ ' : '▸ ') : '  '
          const label = fit(`${'  '.repeat(row.depth)}${icon}${row.name}${row.isDir ? '/' : ''}`, treeWidth - (isTouched ? 2 : 0))
          return (
            <Box key={`row:${row.path}`} flexDirection="row" height={1} overflow="hidden" backgroundColor={isActive ? 'promptBorder' : undefined}>
              <Button key={`tree:${row.path}`} plain dimColor={row.name.startsWith('.') && !isActive} label={label} onPress={() => void pressEntry($, row)} />
              {isTouched && <Text color="warning"> ●</Text>}
            </Box>
          )
        })}
      </Box>
    )
  }

  // ── 파일 ──
  let fileColumn: RenderElement | false = false
  if (showFile) {
    const contentRows = Math.max(1, mainRows - 2)
    const tabRow = (
      <Box flexDirection="row" columnGap={1} height={1} overflow="hidden">
        {tabs.length === 0 && <Text dimColor>열린 파일 없음</Text>}
        {tabs.map(tab => (
          <Button
            key={`tab:${tab}`}
            plain
            dimColor={tab !== active}
            label={`${tab === active ? '▎' : ' '}${fit(baseName(tab), 24)}${touched.has(tab) ? ' ●' : ''}`}
            onPress={() => void update($, activeAtom, () => tab)}
          />
        ))}
      </Box>
    )
    const frame = (info: string, body: RenderElement) => (
      <Box key="ide-file" flexDirection="column" width={fileWidth} height={mainRows} overflow="hidden">
        {tabRow}
        <Text dimColor wrap="truncate-start">{info}</Text>
        <Box flexDirection="column" height={contentRows} overflow="hidden">{body}</Box>
      </Box>
    )
    Object.assign(layout, { active: rightKey, fileMaxOffset: 0 })

    if (isHandoff) {
      const lines = handoff === undefined ? ['세션 정보를 읽지 못했어요.'] : handoff.text.split('\n')
      const offset = clamp(offsets[rightKey] ?? 0, 0, lines.length - 1)
      layout.fileMaxOffset = Math.max(0, lines.length - 1)
      const note =
        sent === null
          ? '왼쪽에서 세션을 누르면 아래 글을 그 세션에 보내요.'
          : sent.ok
            ? `${clock(sent.at)} ${sent.to}에 보냈어요.`
            : `${clock(sent.at)} ${sent.to}에 못 보냈어요: ${sent.reason ?? ''}`
      fileColumn = (
        <Box key="ide-file" flexDirection="column" width={fileWidth} height={mainRows} overflow="hidden">
          <Text bold wrap="truncate-end">핸드오프 · 세션 {handoff?.info.id ?? ''}</Text>
          <Text dimColor={sent === null} color={sent === null ? undefined : sent.ok ? 'success' : 'error'} wrap="truncate-end">{note}</Text>
          <Box flexDirection="column" height={Math.max(1, mainRows - 2)} overflow="hidden">
            {lines.slice(offset).map((line, i) => (
              <Text key={`handoff-line:${offset + i}`} color={/^\d+\. \[|^ {3}\S/.test(line) ? 'success' : line.startsWith('세션 ID') || line.startsWith('이어서 열기') ? 'warning' : undefined}>
                {line === '' ? ' ' : line}
              </Text>
            ))}
          </Box>
        </Box>
      )
    } else if (isRequests) {
      const head = <Text dimColor>요청 기록 · {requests.length}개 · {requests.filter(r => r.status === 'running').length}개 진행 중</Text>
      if (isAllRequests) {
        // 요청 하나가 머리줄 + 본문 줄들 + 답 한 줄 + 빈 줄. 스크롤은 이 논리 줄 단위로, 넘치는 줄은 창이 자른다
        const segments: RenderElement[] = []
        for (const r of [...requests].reverse()) {
          segments.push(
            <Text key={`all-head:${r.n}`} bold wrap="truncate-end">
              #{r.n} · {dayClock(r.at)} · {REQUEST_ICON[r.status]} {requestStatus(r)}
            </Text>,
          )
          r.text.split('\n').forEach((line, i) => segments.push(<Text key={`all-line:${r.n}:${i}`} color="success">{line === '' ? ' ' : line}</Text>))
          if (r.answer !== '') segments.push(<Text key={`all-answer:${r.n}`} dimColor wrap="truncate-end">  └ Claude: {r.answer}</Text>)
          segments.push(<Text key={`all-gap:${r.n}`}> </Text>)
        }
        const offset = clamp(offsets[rightKey] ?? 0, 0, segments.length - 1)
        layout.fileMaxOffset = Math.max(0, segments.length - 1)
        fileColumn = (
          <Box key="ide-file" flexDirection="column" width={fileWidth} height={mainRows} overflow="hidden">
            <Text bold wrap="truncate-end">이번 세션 요청 {requests.length}개 전부 · 최근 것이 위 · 휠로 스크롤</Text>
            <Box flexDirection="column" height={Math.max(1, mainRows - 1)} overflow="hidden">
              {segments.slice(offset)}
            </Box>
          </Box>
        )
      } else if (selected === undefined) {
        fileColumn = (
          <Box key="ide-file" flexDirection="column" width={fileWidth} height={mainRows} overflow="hidden">
            {head}
            <Text dimColor>이 세션에서 보낸 요청이 왼쪽에 쌓이고, 고르면 여기 전문이 보여요.</Text>
          </Box>
        )
      } else {
        const lines = selected.text.split('\n')
        const offset = clamp(offsets[rightKey] ?? 0, 0, lines.length - 1)
        layout.fileMaxOffset = Math.max(0, lines.length - 1)
        const status = requestStatus(selected)
        fileColumn = (
          <Box key="ide-file" flexDirection="column" width={fileWidth} height={mainRows} overflow="hidden">
            <Text bold wrap="truncate-end">요청 #{selected.n} · {clock(selected.at)} · {status}</Text>
            {selected.answer !== '' ? <Text dimColor wrap="truncate-end">Claude 답: {selected.answer}</Text> : <Text dimColor> </Text>}
            <Box flexDirection="column" height={contentRows} overflow="hidden">
              <Text color="success">{lines.slice(offset).join('\n')}</Text>
            </Box>
          </Box>
        )
      }
    } else if (active === '') {
      fileColumn = frame('', <Text dimColor>왼쪽 트리에서 파일을 고르세요. 휠·방향키로 스크롤, j/k로 트리 넘기기.</Text>)
    } else {
      const relative = isInside(active, root) && active !== root ? active.slice(root.length).replace(/^\//, '') : active
      const stat = await $.fs.stat(active).catch(() => undefined)
      if (stat === undefined) {
        fileColumn = frame(relative, <Text color="error">파일이 없어졌어요.</Text>)
      } else if (stat.kind !== 'file') {
        fileColumn = frame(relative, <Text dimColor>일반 파일이 아니라 미리볼 수 없어요.</Text>)
      } else if (isHwp) {
        const hwp = await drawHwp($, e, active, stat, fileWidth, contentRows, offsets)
        fileColumn = frame(hwp.info, hwp.body)
      } else if (PNG.test(active)) {
        if (e.surface === 'terminal') {
          const { Image } = $.ui.resolve(e)
          const png = await pngData($, active, `${stat.mtimeMs}|${stat.size}`).catch(() => undefined)
          fileColumn = frame(
            `${relative} · ${formatSize(stat.size)}`,
            png === undefined
              ? <Text dimColor>이 PNG는 창 안에 그리지 않아요 (2 MB 초과 또는 PNG 형식이 아님).</Text>
              : <Image source={{ png }} columns={clamp(fileWidth, 1, 255)} rows={clamp(contentRows, 1, 255)} alt={`이미지 ${baseName(active)} (kitty·Ghostty 터미널에서 보여요)`} />,
          )
        } else {
          fileColumn = frame(relative, <Text dimColor>이 화면에서는 이미지를 그릴 수 없어요.</Text>)
        }
      } else if (OTHER_IMAGE.test(active)) {
        fileColumn = frame(relative, <Text dimColor>PNG만 미리볼 수 있어요.</Text>)
      } else if (stat.size > MAX_BYTES) {
        fileColumn = frame(relative, <Text dimColor>4 MB가 넘는 파일은 열 수 없어요.</Text>)
      } else {
        const lines = await readLines($, active, stat.mtimeMs, stat.size).catch(() => null)
        if (lines === null) fileColumn = frame(relative, <Text color="error">파일을 읽을 수 없어요.</Text>)
        else if (lines === undefined) fileColumn = frame(relative, <Text dimColor>바이너리 파일이라 미리볼 수 없어요.</Text>)
        else if (lines.length === 0) fileColumn = frame(`${relative} · 빈 파일`, <Text dimColor>빈 파일이에요.</Text>)
        else if (isMarkdown && mode === 'rendered') {
          // 렌더하면 줄이 접혀 행 수가 달라지므로, 문단 경계에서 시작해 끝까지 그리고 창이 자르게 한다
          const starts = blockStarts(lines)
          const wanted = clamp(offsets[active] ?? 0, 0, lines.length - 1)
          const start = [...starts].reverse().find(s => s <= wanted) ?? 0
          layout.fileMaxOffset = lines.length - 1
          let text = lines.slice(start).join('\n')
          if (text.length > MAX_RENDERED_CHARS) text = text.slice(0, MAX_RENDERED_CHARS)
          fileColumn = frame(`${relative} · ${formatSize(stat.size)} · ${start + 1}줄부터/${lines.length}줄 · 렌더`, <Markdown text={text} />)
        } else {
          const offset = clamp(offsets[active] ?? 0, 0, lines.length - contentRows)
          layout.fileMaxOffset = Math.max(0, lines.length - contentRows)
          const end = Math.min(lines.length, offset + contentRows)
          fileColumn = frame(
            `${relative} · ${formatSize(stat.size)} · ${offset + 1}-${end}/${lines.length}줄`,
            <Code source={lines.slice(offset, end).join('\n')} path={active} startLine={offset + 1} wrap="truncate-end" />,
          )
        }
      }
    }
  }
  Object.assign(layout, { showTree, showFile, treeWidth: showTree && showFile ? treeWidth + 1 : showTree ? width : 0 })

  return (
    <Box key="ide-explorer" flexDirection="column" width={width} height={rows} overflow="hidden">
      {toolbar}
      <Box flexDirection="row" columnGap={1} height={mainRows} overflow="hidden">
        {treeColumn}
        {fileColumn}
      </Box>
    </Box>
  )
}

// ════════════════ 요청 기록 · HWP 뷰어 · 강의 모드 · 문체 게이트 ════════════════
const leftModeAtom = atom({ plugin: 'ide-mod', key: 'leftMode' } as const, 'files' as 'files' | 'requests' | 'handoff')
const requestsAtom = atom({ plugin: 'ide-mod', key: 'requests' } as const, [] as RequestItem[])
const selectedRequestAtom = atom({ plugin: 'ide-mod', key: 'selectedRequest' } as const, 0)
const requestOffsetAtom = atom({ plugin: 'ide-mod', key: 'requestOffset' } as const, 0)
const requestViewAtom = atom({ plugin: 'ide-mod', key: 'requestView' } as const, 'all' as 'all' | 'one')
const hwpViewAtom = atom({ plugin: 'ide-mod', key: 'hwpView' } as const, 'doc' as 'doc' | 'image')
const hwpPagesAtom = atom({ plugin: 'ide-mod', key: 'hwpPages' } as const, {} as Record<string, number>)
const lectureAtom = atom({ plugin: 'ide-mod', key: 'isLecture' } as const, false)
const captionAtom = atom({ plugin: 'ide-mod', key: 'caption' } as const, { text: '', prev: '', step: 0, startedAt: 0 } as Caption)
const gateAtom = atom({ plugin: 'ide-mod', key: 'gate' } as const, null as GateResult | null)
const gateOnAtom = atom({ plugin: 'ide-mod', key: 'isGateOn' } as const, true)
const gateOpenAtom = atom({ plugin: 'ide-mod', key: 'isGateOpen' } as const, false)

// 쪽 단위 문서: HWP·HWPX는 rhwp, PDF는 pdf.js 엔진으로 연다
const HWP = /\.(hwp|hwpx|pdf)$/i
const isPdf = (path: string) => /\.pdf$/i.test(path)
const PROSE = /\.(md|markdown|txt)$/i
const MAX_REQUESTS = 300
const STORE_PREFIX = 'requests:'
const STORE_SESSIONS = 40
const REQUEST_ORIGINS = ['composer', 'bridge', 'sdk']

// ── 요청 기록 ──
const clock = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const REQUEST_ICON: Record<RequestItem['status'], string> = { running: '●', done: '✓', stopped: '■' }
/** 오늘이 아니면 날짜도 붙인다 (세션을 며칠에 걸쳐 이어 쓸 때) */
const dayClock = (ms: number) => {
  const d = new Date(ms)
  const isToday = d.toDateString() === new Date().toDateString()
  return isToday ? clock(ms) : `${d.getMonth() + 1}/${d.getDate()} ${clock(ms)}`
}
const requestStatus = (r: RequestItem) => {
  const took = r.endedAt !== undefined ? ` · ${formatElapsed(r.endedAt - r.at)}` : ''
  return r.status === 'running' ? '진행 중' : r.status === 'done' ? `끝남${took}` : `중단됨${took}`
}
// ════════════════ 핸드오프 ════════════════
// 이 세션을 다른 에이전트 세션에 넘긴다: 세션 ID·작업 폴더·대화 기록 경로·이어서 여는 명령·요청 목록을 한 글로

const peersAtom = atom({ plugin: 'ide-mod', key: 'peers' } as const, [] as PeerRow[])
const selfNameAtom = atom({ plugin: 'ide-mod', key: 'selfName' } as const, '')
const handoffSentAtom = atom({ plugin: 'ide-mod', key: 'handoffSent' } as const, null as { to: string; at: number; ok: boolean; reason?: string } | null)

type SessionInfo = { id: string; root: string; transcript: string | undefined }
let sessionInfoCache: SessionInfo | undefined

/** 세션 ID와 대화 기록 파일 경로. 기록은 <설정 폴더>/projects/<루트의 영숫자 외 문자를 -로>/<id>.jsonl 에 있다 */
async function sessionInfo($: EngineInterface): Promise<SessionInfo> {
  const id = await $.session.id()
  const root = await $.session.root()
  if (sessionInfoCache?.id === id && sessionInfoCache.root === root && sessionInfoCache.transcript !== undefined) return sessionInfoCache
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) ?? ''}/.claude`
  const projects = `${config}/projects`
  let transcript: string | undefined = `${projects}/${root.replace(/[^a-zA-Z0-9]/g, '-')}/${id}.jsonl`
  if (!(await $.fs.exists(transcript).catch(() => false))) {
    transcript = undefined
    const dirs = await $.fs.list(projects).catch(() => [])
    for (const d of dirs) {
      const candidate = `${projects}/${d.name}/${id}.jsonl`
      if (await $.fs.exists(candidate).catch(() => false)) {
        transcript = candidate
        break
      }
    }
  }
  sessionInfoCache = { id, root, transcript }
  return sessionInfoCache
}

/** 다른 에이전트가 읽고 바로 이어받을 수 있는 핸드오프 글 */
export function handoffNote(info: SessionInfo, requests: RequestItem[], status: string, memo = '') {
  const prompts = requests.filter(r => !isMachineText(r.text))
  const recent = prompts.slice(-20)
  const lines = [
    '[핸드오프] Claude Code 세션을 이어받아 주세요.',
    '',
    `세션 ID: ${info.id}`,
    `작업 폴더: ${info.root}`,
    `대화 기록: ${info.transcript ?? '(찾지 못함)'}`,
    `이어서 열기: cd ${shellQuote(info.root)} && claude --resume ${info.id} --fork-session`,
  ]
  if (memo.trim() !== '') lines.push('', `메모: ${memo.trim()}`)
  if (recent.length > 0) {
    lines.push('', `사용자가 보낸 요청 ${prompts.length}개${prompts.length > recent.length ? ` 중 최근 ${recent.length}개` : ''} (오래된 것부터):`)
    for (const [i, r] of recent.entries()) {
      const [first, ...rest] = r.text.trim().split('\n')
      lines.push(`${prompts.length - recent.length + i + 1}. [${dayClock(r.at)}${r.status === 'running' ? ' · 진행 중' : r.status === 'stopped' ? ' · 중단' : ''}] ${oneLine(first, 400)}`)
      const more = rest.join(' ').trim()
      if (more !== '') lines.push(`   ${oneLine(more, 400)}`)
    }
  }
  if (status !== '') lines.push('', `에이전트가 마지막에 하던 일: ${status}`)
  lines.push('', '먼저 대화 기록 파일을 읽어 맥락을 잡고, 이어서 할 일을 정리해 알려 주세요.')
  return lines.join('\n')
}

const shellQuote = (s: string) => (/^[\w./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

/** ListAgents 결과에서 다른 세션들과 이 세션의 이름을 읽는다 */
export function parsePeers(listing: string): { self: string; peers: PeerRow[] } {
  const self = listing.match(/This session is (.+?) \[[0-9a-f]+\]/)?.[1] ?? ''
  const peers: PeerRow[] = []
  for (const line of listing.split('\n')) {
    const m = line.match(/^\s+(.+?) \[([0-9a-f]{4,})\]\s+·\s+(.*)$/)
    if (m === null) continue
    const parts = m[3].split('·').map(x => x.trim()).filter(Boolean)
    peers.push({ name: m[1], ref: m[2], status: parts[1] ?? parts[0] ?? '', detail: parts.slice(2).join(' · ') })
  }
  return { self, peers }
}

async function loadPeers($: EngineInterface) {
  const ran = (await $.tool.call({ tool: 'ListAgents' } as never)) as { result?: { listing?: string }; text?: string; deny?: string }
  const listing = ran.result?.listing ?? ran.text ?? ''
  const { self, peers } = parsePeers(listing)
  await update($, peersAtom, () => peers)
  if (self !== '') await update($, selfNameAtom, () => self)
  return peers
}

/** 탐색기 왼쪽 칸을 핸드오프 화면으로 바꾸고 다른 세션 목록을 새로 받는다 */
async function openHandoff($: EngineInterface) {
  await update($, leftModeAtom, m => (m === 'handoff' ? 'files' : 'handoff'))
  await update($, treeHiddenAtom, () => false)
  if ((await read($, leftModeAtom)) === 'handoff') await loadPeers($).catch(() => undefined)
}

async function currentHandoff($: EngineInterface, memo = '') {
  const info = await sessionInfo($)
  const main = (await read($, agentsAtom))[MAIN]
  const status = main === undefined ? '' : oneLine(main.recap || main.activity || '', 200)
  return { info, text: handoffNote(info, await read($, requestsAtom), status, memo) }
}

/** 인자 앞부분과 가장 길게 맞는 세션 이름 또는 ref */
export function pickPeer(peers: PeerRow[], arg: string): PeerRow | undefined {
  const hits = peers.filter(p => arg === p.name || arg.startsWith(`${p.name} `) || arg === p.ref || arg.startsWith(`${p.ref} `))
  return hits.sort((a, b) => b.name.length - a.name.length)[0]
}

async function sendHandoff($: EngineInterface, peer: PeerRow, memo = '') {
  const { text } = await currentHandoff($, memo)
  const sent = await $.session.send({ to: `${peer.name} [${peer.ref}]`, text }).catch((err: unknown) => ({ isDelivered: false as const, reason: String(err) }))
  const result = { to: peer.name, at: Date.now(), ok: sent.isDelivered, reason: sent.isDelivered ? undefined : sent.reason }
  await update($, handoffSentAtom, () => result)
  $.ui.toast(sent.isDelivered ? `핸드오프를 보냈어요 → ${peer.name}` : `못 보냈어요: ${sent.reason ?? ''}`)
  return result
}

/** 요청 기록 전체를 붙여 넣기 좋은 글로 (오래된 것부터) */
export const requestsAsText = (items: RequestItem[]) =>
  items.map(r => `#${r.n} ${dayClock(r.at)} ${REQUEST_ICON[r.status]}\n${r.text}${r.answer !== '' ? `\n└ Claude: ${r.answer}` : ''}`).join('\n\n')

async function saveRequests($: EngineInterface) {
  const id = await $.session.id()
  await $.store.set(`${STORE_PREFIX}${id}`, { updatedAt: Date.now(), items: await read($, requestsAtom) })
}

/** 세션을 이어 열었거나 모드가 다시 로드됐을 때 저장해 둔 요청을 되살리고, 오래된 세션 기록은 정리한다 */
/** 프롬프트에서 사람이 쓴 부분만: 데스크톱 앱·훅이 앞뒤에 붙이는 <system-reminder> 같은 안내 블록을 걷어 낸다 */
export const personText = (text: string) =>
  text
    .replace(/<(system-reminder|local-command-caveat|command-message|command-name|command-args)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .trim()

/** 사람이 쓴 글이 아닌 것: 안내 블록을 걷어 내면 비거나, 백그라운드 작업 알림·다른 세션·팀원이 보낸 메시지 */
export const isMachineText = (text: string) => {
  const own = personText(text)
  return own === '' || /^\s*(<(task-notification|teammate-message|peer-message|cross-session-message)\b|\[SYSTEM NOTIFICATION)/i.test(own)
}

async function loadRequests($: EngineInterface) {
  const id = await $.session.id()
  if ((await read($, requestsAtom)).length === 0) {
    const saved = (await $.store.get(`${STORE_PREFIX}${id}`)) as { items?: RequestItem[] } | undefined
    // 0.5.0까지는 작업 알림·다른 세션 메시지로 시작한 턴도 요청으로 적었다: 불러올 때 걸러 낸다
    const items = Array.isArray(saved?.items) ? saved.items.filter(r => !isMachineText(r.text)).map(r => ({ ...r, text: personText(r.text) })) : []
    if (items.length > 0) await update($, requestsAtom, () => items)
  }
  const keys = (await $.store.keys()).filter(k => k.startsWith(STORE_PREFIX))
  if (keys.length <= STORE_SESSIONS) return
  const dated = await Promise.all(keys.map(async k => ({ k, at: ((await $.store.get(k)) as { updatedAt?: number } | undefined)?.updatedAt ?? 0 })))
  for (const { k } of dated.sort((a, b) => a.at - b.at).slice(0, keys.length - STORE_SESSIONS)) await $.store.delete(k)
}

async function addRequest($: EngineInterface, text: string, turnId: string | undefined) {
  await update($, requestsAtom, list => {
    const n = (list[list.length - 1]?.n ?? 0) + 1
    const item: RequestItem = { n, text: text.slice(0, 8000), at: Date.now(), status: 'running', answer: '' }
    if (turnId !== undefined) item.turnId = turnId
    return [...list, item].slice(-MAX_REQUESTS)
  })
  await update($, selectedRequestAtom, () => 0)
  await saveRequests($)
}

/** 턴이 시작되면 그 글을 보낸 요청(사람이 입력창·원격·SDK로 보낸 것)과 잇는다. 이어지면 true.
 *  사람이 보낸 요청이 아닌 턴(작업 알림, 다른 세션의 메시지 등)은 기록하지 않는다 */
async function requestTurnStarted($: EngineInterface, text: string, turnId: string) {
  const wanted = text.trim()
  let isLinked = false
  await update($, requestsAtom, list => {
    const at = [...list].reverse().find(r => r.status === 'running' && (r.turnId === undefined || r.turnId === turnId) && r.text.trim() === wanted)
    if (at === undefined) return list
    isLinked = true
    return list.map(r => (r === at ? { ...r, turnId } : r))
  })
  if (isLinked) await saveRequests($)
  return isLinked
}

async function requestTurnEnded($: EngineInterface, turnId: string, answer: string, isStopped: boolean) {
  let changed = false
  await update($, requestsAtom, list =>
    list.map(r => {
      if (r.turnId !== turnId || r.status !== 'running') return r
      changed = true
      return { ...r, status: isStopped ? 'stopped' : 'done', answer: firstLine(answer).slice(0, 300), endedAt: Date.now() }
    }),
  )
  if (changed) await saveRequests($)
}

// ── 강의 모드 자막 ──
const shortPath = (value: unknown) => (typeof value === 'string' ? baseName(value) : '')
/** 도구 호출 하나를 수강생이 읽을 한국어 한 줄로 */
export const captionFor = (tool: string, input: Record<string, unknown>) => {
  const str = (k: string) => (typeof input[k] === 'string' ? oneLine(String(input[k]), 60) : '')
  switch (tool) {
    case 'Read': return `파일을 읽고 있어요 · ${shortPath(input.file_path)}`
    case 'Write': return `새 파일을 쓰고 있어요 · ${shortPath(input.file_path)}`
    case 'Edit':
    case 'MultiEdit': return `파일을 고치고 있어요 · ${shortPath(input.file_path)}`
    case 'NotebookEdit': return `노트북을 고치고 있어요 · ${shortPath(input.notebook_path)}`
    case 'Bash': return str('description') !== '' ? `터미널에서: ${str('description')}` : `터미널 명령을 실행해요 · ${str('command')}`
    case 'Grep': return `코드에서 찾는 중 · '${str('pattern')}'`
    case 'Glob': return `파일을 찾는 중 · ${str('pattern')}`
    case 'WebFetch': return `웹페이지를 읽고 있어요 · ${str('url').replace(/^https?:\/\//, '').split('/')[0] ?? ''}`
    case 'WebSearch': return `웹에서 검색해요 · ${str('query')}`
    case 'Agent': return `${str('subagent_type') || '도우미'} 에이전트에게 맡겼어요 · ${str('description')}`
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate': return '할 일 목록을 정리해요'
    case 'AskUserQuestion': return '사용자에게 물어보고 있어요'
    case 'Skill': return `'${str('skill')}' 스킬을 꺼내 써요`
    default: {
      if (tool.startsWith('mcp__')) {
        const [, server = '', name = ''] = tool.split('__')
        return `${server} 도구를 써요 · ${name}`
      }
      return `${tool} 도구를 써요`
    }
  }
}

async function setCaption($: EngineInterface, text: string, isNewTurn = false) {
  if (!(await read($, lectureAtom))) return
  await update($, captionAtom, c => ({
    text,
    prev: isNewTurn ? '' : c.text,
    step: isNewTurn ? 0 : c.step + 1,
    startedAt: isNewTurn || c.startedAt === 0 ? Date.now() : c.startedAt,
  }))
}

// ── 한국어 문체 게이트 (noslop-ko grep_gate.sh 이식) ──
type GateRule = { label: string; re: RegExp; limit: number; isHard: boolean; isPerLine?: boolean }
const GATE_RULES: GateRule[] = [
  { label: '대조 구문(~이 아니라)', re: /아니라|[가-힣]인가,/g, limit: 2, isHard: true },
  { label: '접속어 뒤 쉼표', re: /(고|며|지만|면서|는데|니까|서), /g, limit: 3, isHard: true },
  { label: '맺음 상투어', re: /결론적으로|요약하면|정리하자면|라고 할 수 있다|라고 볼 수 있다|에 다름 아니다/g, limit: 2, isHard: true },
  { label: '이중 피동', re: /되어진다|지게 된다/g, limit: 1, isHard: true },
  { label: '중요성 부풀리기', re: /시사하는 바가|주목할 만|간과할 수 없|매우 중요하/g, limit: 2, isHard: true },
  { label: '이모지', re: /🚀|💡|✅|⚠️|📊|🎯|🔥|🙌|✨/gu, limit: 1, isHard: true },
  { label: '마무리 공식(~할 때입니다)', re: /때입니다|시점입니다|나아가야 합니다|해야 할 때/g, limit: 2, isHard: true },
  { label: '과장 어휘', re: /혁신적|획기적|압도적|파격적|폭발적|전례 없/g, limit: 2, isHard: true },
  { label: '영어 유행어', re: /seamless|robust|leverage|cutting-edge/g, limit: 1, isHard: true },
  { label: '번역투 조사', re: /에 대해|에 있어서|에 기반하여|와 관련하여/g, limit: 3, isHard: false },
  { label: '~에 의해', re: /에 의해/g, limit: 2, isHard: false },
  { label: '균형 얼버무림', re: /양쪽 모두|균형 잡힌|신중하게/g, limit: 3, isHard: false },
  { label: '메타 진입', re: /이는 .*을 의미한다|이 점에서|이 관점에서/g, limit: 3, isHard: false, isPerLine: true },
]
const countOf = (re: RegExp, text: string) => (text.match(new RegExp(re.source, re.flags)) ?? []).length

/** 원고 하나를 검사한다. 코드 펜스 안은 빼고 센다 */
export const styleGate = (text: string, path: string): GateResult => {
  const lines = text.split('\n')
  let isFenced = false
  const bodyLines = lines.filter(line => {
    if (/^```/.test(line)) {
      isFenced = !isFenced
      return false
    }
    return !isFenced
  })
  const body = bodyLines.join('\n')
  const checks: GateCheck[] = GATE_RULES.map(rule => ({
    label: rule.label,
    count: rule.isPerLine ? bodyLines.reduce((n, line) => n + countOf(rule.re, line), 0) : countOf(rule.re, body),
    limit: rule.limit,
    isHard: rule.isHard,
  }))
  checks.push({ label: '소제목 콜론', count: lines.filter(l => /^#+ [^:]+: /.test(l)).length, limit: 2, isHard: false })
  const violations = checks.filter(c => c.isHard && c.count >= c.limit).length
  const sentences = bodyLines.join(' ').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s !== '')
  const examples: string[] = []
  for (const rule of GATE_RULES.filter(r => r.isHard)) {
    if (countOf(rule.re, body) < rule.limit) continue
    const hit = sentences.find(s => countOf(rule.re, s) > 0)
    if (hit !== undefined && examples.length < 4) examples.push(`${rule.label}: ${oneLine(hit, 70)}`)
  }
  return {
    path,
    verdict: violations >= 3 ? 'stop' : violations >= 1 ? 'warn' : 'pass',
    violations,
    checks,
    examples,
    sentences: countOf(/[.!?]/g, body),
    longRuns: bodyLines.reduce((n, line) => n + countOf(/[^.!?]{100,}[.!?]/g, line), 0),
    at: Date.now(),
  }
}
const isKoreanProse = (text: string) => (text.match(/[가-힣]/g) ?? []).length >= 50

async function runGate($: EngineInterface, path: string) {
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat?.kind !== 'file' || stat.size > 1024 * 1024) return undefined
  const text = await $.fs.read(path)
  if (!isKoreanProse(text)) return undefined
  const result = styleGate(text, path)
  await update($, gateAtom, () => result)
  return result
}

const VERDICT_LABEL: Record<GateResult['verdict'], string> = { pass: '통과', warn: '경고', stop: '중단(다시 쓰기 권장)' }
const gateSummary = (g: GateResult) => {
  const over = g.checks.filter(c => c.count >= c.limit).map(c => `${c.label} ${c.count}`)
  return `${baseName(g.path)} · ${VERDICT_LABEL[g.verdict]} · 위반 ${g.violations}${over.length > 0 ? ` (${over.join(', ')})` : ''}${g.longRuns > 0 ? ` · 100자 넘는 문장 ${g.longRuns}` : ''}`
}

// ── HWP 뷰어 (rhwp 엔진: 플러그인의 bin/rhwp-view.mjs를 node로 부른다) ──
type HwpText = { format?: string; pages?: number; residues?: string[]; error?: string }
type HwpPage = { pages?: number; page?: number; svg?: string; pngPath?: string; pngWidth?: number; pngHeight?: number; error?: string }
type GridSeg = { t: string; b?: 1; c?: string; l?: 1; r?: 1 }
type HwpGrid = { pages?: number; page?: number; rows?: GridSeg[][]; error?: string }
const hwpTextCache = new Map<string, HwpText>()
const hwpPageCache = new Map<string, HwpPage>()
const hwpGridCache = new Map<string, HwpGrid>()
const hwpLoading = new Set<string>()
/** 문서 보기의 쪽 넘김: 스크롤 훅이 쓰는 지금 쪽 */
const hwpNow = { path: '', page: 0, pages: 0 }
const hwpOffsetKey = (path: string, page: number) => `${path}#${page}`

/**
 * rhwp를 그리기 밖에서 돌린다. 그리기는 자주 다시 시작되므로(보드 시계·핫 리로드) 타이머로 넘겨
 * 끝까지 돌리고, 끝나면 다시 그리게 한다.
 */
function loadHwp($: EngineInterface, key: string, args: string[], into: Map<string, Record<string, unknown>>) {
  if (hwpLoading.has(key) || into.has(key)) return
  hwpLoading.add(key)
  $.clock.after(1, () =>
    void (async () => {
      try {
        into.set(key, await runRhwp($, args))
      } finally {
        hwpLoading.delete(key)
        await update($, revAtom, n => n + 1)
      }
    })().catch(() => undefined),
  )
}

async function runRhwp($: EngineInterface, args: string[]): Promise<Record<string, unknown>> {
  const dir = $.plugin.root.replace(/\/\.claude-plugin\/?$/, '')
  // args[1]은 문서 경로다: PDF면 pdf.js 엔진, 아니면 rhwp 엔진
  const script = isPdf(args[1] ?? '') ? 'pdf-view.mjs' : 'rhwp-view.mjs'
  const ran = await $.process.run(['node', `${dir}/bin/${script}`, ...args], { timeoutMs: 60_000 }).catch(error => ({ exitCode: 127, stdout: '', stderr: String(error) }))
  try {
    const out = ran.stdout
    return JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) as Record<string, unknown>
  } catch {
    const why = ran.stderr.trim()
    return { error: /ENOENT|not found|spawn/i.test(why) || ran.exitCode === 127 ? '문서 엔진을 돌리려면 Node.js가 필요해요 (node 명령을 찾지 못함)' : oneLine(why, 200) || `문서 엔진 출력을 읽지 못했어요 (exit ${ran.exitCode}, ${ran.stdout.length}자, ${dir}/bin/${script})` }
  }
}

/** 원본 모양 그대로 보기: PDF는 파일을 그대로, HWP는 지금 쪽 그림을 macOS 미리보기로 연다 */
async function openHwpPreview($: EngineInterface, path: string, page: number) {
  if (isPdf(path)) {
    await $.process.run(['open', path], { timeoutMs: 10_000 }).catch(() => undefined)
    return
  }
  const shot = (await runRhwp($, ['page', path, String(page)])) as HwpPage
  if (shot.error !== undefined || shot.pngPath === undefined) {
    $.ui.toast(`미리보기를 만들지 못했어요: ${shot.error ?? 'PNG 변환 도구 없음'}`)
    return
  }
  await $.process.run(['open', shot.pngPath], { timeoutMs: 10_000 }).catch(() => undefined)
}

/** HWP를 그린다: 문서 보기(쪽을 글자 격자로) 또는 그림 보기(rhwp가 그린 쪽 그림) */
async function drawHwp(
  $: EngineInterface,
  e: RenderInput<'Pane'>,
  path: string,
  stat: { mtimeMs: number; size: number },
  fileWidth: number,
  contentRows: number,
  offsets: Record<string, number>,
): Promise<{ info: string; body: RenderElement }> {
  const { Box, Text } = $.ui.resolve(e)
  const view = await read($, hwpViewAtom)
  const version = `${stat.mtimeMs}|${stat.size}`
  const textKey = `${path}|${version}`
  const data = hwpTextCache.get(textKey)
  if (data === undefined) {
    loadHwp($, textKey, ['text', path], hwpTextCache as Map<string, Record<string, unknown>>)
    return { info: baseName(path), body: <Text dimColor>{isPdf(path) ? 'pdf.js' : 'rhwp'} 엔진으로 읽는 중…</Text> }
  }
  if (data.error !== undefined) return { info: baseName(path), body: <Text color="error">{data.error} (r로 다시 시도)</Text> }
  const residues = data.residues ?? []
  const pages = Math.max(1, data.pages ?? 1)
  const page = clamp((await read($, hwpPagesAtom))[path] ?? 0, 0, pages - 1)
  Object.assign(hwpNow, { path, page, pages })
  const head = `${baseName(path)} · ${page + 1}/${pages}쪽${residues.length > 0 ? ` · 치환 안 된 칸 ${residues.length}개: ${residues.slice(0, 3).join(' ')}` : ''}`

  if (view === 'image') {
    const pageKey = `${path}|${version}|${page}`
    const shot = hwpPageCache.get(pageKey)
    const info = `${head} · 그림 보기 (o: 미리보기로 열기)`
    if (shot === undefined) {
      loadHwp($, pageKey, ['page', path, String(page)], hwpPageCache as Map<string, Record<string, unknown>>)
      return { info, body: <Text dimColor>{page + 1}쪽을 그리는 중…</Text> }
    }
    if (shot.error !== undefined) return { info, body: <Text color="error">{shot.error} (r로 다시 시도)</Text> }
    const alt = `${baseName(path)} ${page + 1}쪽`
    if (e.surface === 'terminal') {
      if (shot.pngPath === undefined) return { info, body: <Text dimColor>쪽 그림(PNG)을 만들 도구가 없어요. 문서 보기(v)를 쓰거나 rsvg-convert를 설치해 주세요.</Text> }
      const { Image } = $.ui.resolve(e)
      const png = await pngData($, shot.pngPath, pageKey).catch(() => undefined)
      if (png === undefined) return { info, body: <Text dimColor>쪽 그림을 읽지 못했어요. v로 문서 보기, o로 미리보기에서 열기</Text> }
      const aspect = (shot.pngHeight ?? 1) / (shot.pngWidth ?? 1)
      let columns = clamp(fileWidth, 1, 255)
      let rows = Math.round((columns * aspect) / 2)
      if (rows > contentRows) {
        rows = contentRows
        columns = clamp(Math.round((rows * 2) / aspect), 1, 255)
      }
      return {
        info,
        body: <Image source={{ png }} columns={columns} rows={clamp(rows, 1, 255)} alt={`${alt}: 이 터미널은 그림을 못 그려요(kitty·Ghostty 필요). v로 문서 보기, o로 미리보기에서 열기`} />,
      }
    }
    if (e.surface === 'desktop' || e.surface === 'vscode' || e.surface === 'mobile') {
      const { Svg } = $.ui.resolve(e)
      if (shot.svg !== undefined) return { info, body: <Svg source={shot.svg} alt={alt} /> }
    }
    return { info, body: <Text dimColor>이 쪽은 그림이 너무 커서 여기 못 그려요. v로 문서 보기를 쓰거나 o로 미리보기에서 열어 주세요.</Text> }
  }

  // 문서 보기: rhwp가 그린 쪽을 이 칸 너비의 글자 격자로 (가운데 정렬·표·굵은 글씨를 그대로)
  const cols = clamp(fileWidth, 20, 400)
  const gridKey = `${path}|${version}|${page}|${cols}`
  const grid = hwpGridCache.get(gridKey)
  const info = `${head} · 문서 보기`
  if (grid === undefined) {
    loadHwp($, gridKey, ['grid', path, String(page), String(cols)], hwpGridCache as Map<string, Record<string, unknown>>)
    return { info, body: <Text dimColor>{page + 1}쪽을 펼치는 중…</Text> }
  }
  if (grid.error !== undefined) return { info, body: <Text color="error">{grid.error} (r로 다시 시도)</Text> }
  const rows = grid.rows ?? []
  const offset = clamp(offsets[hwpOffsetKey(path, page)] ?? 0, 0, rows.length - contentRows)
  layout.fileMaxOffset = Math.max(0, rows.length - contentRows)
  const shown = rows.slice(offset, offset + contentRows)
  return {
    info: `${info} ${offset + 1}-${offset + shown.length}/${rows.length}줄`,
    body: (
      <Box flexDirection="column">
        {shown.map((segments, i) => (
          <Text key={`hwp-row:${offset + i}`} wrap="truncate-end">
            {segments.length === 0 ? ' ' : segments.map((seg, j) => (
              <Text key={`s${j}`} bold={seg.b === 1} dimColor={seg.l === 1} color={seg.r === 1 ? 'error' : seg.c}>
                {seg.t}
              </Text>
            ))}
          </Text>
        ))}
      </Box>
    ),
  }
}

// ════════════════ 연결 ════════════════
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // 이름이 다른 플러그인과 겹쳐 하나가 거절돼도 나머지는 등록되게 따로 부른다
    await $.command.register({ name: 'ide', description: 'IDE 창: 에이전트 보드 + 파일 트리 + 탭 에디터', argumentHint: '[경로]' }).catch(() => undefined)
    startAgents($, e.isInteractive)
    await $.command.register({ name: 'open', description: 'IDE 창에서 폴더나 파일을 엽니다', argumentHint: '[경로]' }).catch(() => undefined)
    await $.command.register({ name: 'lecture', description: '강의 모드: Claude가 하는 일을 입력창 위에 쉬운 한국어 자막으로', argumentHint: '[on|off]' }).catch(() => undefined)
    await $.command.register({ name: 'handoff', description: '이 세션을 다른 에이전트 세션에 넘깁니다 (세션 ID·대화 기록·요청 목록)', argumentHint: '[세션 이름 또는 ref] [메모]' }).catch(() => undefined)
    await $.command.register({ name: 'style-gate', description: '한국어 문체 게이트: 원고의 AI티 지표를 검사 (자동 검사 on/off)', argumentHint: '[파일|on|off]' }).catch(() => undefined)
    await loadRequests($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'ide' }, async ($, e) => ({ text: await openIde($, e.args ?? '') }))
  on('command.run', { command: 'open' }, async ($, e) => ({ text: await openIde($, e.args ?? '.') }))

  on('command.run', { command: 'lecture' }, async ($, e) => {
    const arg = (e.args ?? '').trim()
    const isOn = arg === 'on' ? true : arg === 'off' ? false : !(await read($, lectureAtom))
    await update($, lectureAtom, () => isOn)
    if (isOn) await update($, captionAtom, () => ({ text: '강의 모드를 켰어요. Claude가 하는 일을 여기 보여 드려요', prev: '', step: 0, startedAt: Date.now() }))
    return { text: isOn ? '강의 모드를 켰어요. 입력창 위에 자막이 떠요 (/lecture off로 끄기).' : '강의 모드를 껐어요.' }
  })

  // /handoff: 인자가 없으면 핸드오프 글을 보여 주고 화면을 열고, 세션 이름(또는 ref)으로 시작하면 그 세션에 보낸다
  on('command.run', { command: 'handoff' }, async ($, e) => {
    const arg = (e.args ?? '').trim()
    if (arg === '') {
      const { text } = await currentHandoff($)
      await update($, leftModeAtom, () => 'handoff')
      await loadPeers($).catch(() => undefined)
      return { text: `${text}\n\n(/ide 창의 핸드오프 화면에서 보낼 세션을 고르거나 c로 복사하세요. /handoff <세션 이름> [메모]로 바로 보낼 수도 있어요.)` }
    }
    const peers = await loadPeers($).catch(() => [] as PeerRow[])
    const peer = pickPeer(peers, arg)
    if (peer === undefined) return { text: `그 이름의 세션을 찾지 못했어요. 열려 있는 세션: ${peers.map(p => `${p.name} [${p.ref}]`).join(', ') || '없음'}` }
    const memo = arg.startsWith(peer.ref) ? arg.slice(peer.ref.length) : arg.slice(peer.name.length)
    const sent = await sendHandoff($, peer, memo)
    return { text: sent.ok ? `핸드오프를 보냈어요 → ${peer.name} [${peer.ref}]` : `못 보냈어요 (${peer.name}): ${sent.reason ?? ''}` }
  })

  on('command.run', { command: 'style-gate' }, async ($, e) => {
    const arg = (e.args ?? '').trim()
    if (arg === 'on' || arg === 'off') {
      await update($, gateOnAtom, () => arg === 'on')
      if (arg === 'off') await update($, gateAtom, () => null)
      return { text: arg === 'on' ? '문체 게이트 자동 검사를 켰어요. Claude가 .md·.txt 원고를 쓰면 검사해요.' : '문체 게이트 자동 검사를 껐어요.' }
    }
    if (arg === '') {
      const g = await read($, gateAtom)
      return { text: `자동 검사 ${(await read($, gateOnAtom)) ? '켜짐' : '꺼짐'}. ${g === null ? '아직 검사한 원고가 없어요.' : `마지막 결과: ${gateSummary(g)}`} 사용법: /style-gate <파일> 또는 on/off` }
    }
    const real = (await $.fs.stat(arg.replace(/^@/, ''), { resolve: true }).catch(() => undefined))?.realPath
    if (real === undefined) return { text: `파일을 찾을 수 없어요: ${arg}` }
    const result = await runGate($, real)
    if (result === undefined) return { text: '한국어 원고가 아니거나(한글 50자 미만) 1 MB가 넘어서 검사하지 않았어요.' }
    await update($, gateOpenAtom, () => true)
    const lines = [gateSummary(result), ...result.checks.filter(c => c.count > 0).map(c => `- ${c.label}: ${c.count}회 (기준 ${c.limit}회${c.isHard ? '' : ', 참고'})`), ...result.examples.map(x => `  예) ${x}`)]
    return { text: lines.join('\n') }
  })

  // 사람이 보낸 요청을 기록한다 (키보드·원격 조종·SDK에서 온 것만, 인자 없는 슬래시 명령은 빼고)
  // 턴이 시작되기 전에 기록해 두어야 turn.start가 그 요청과 이을 수 있다
  on('prompt.submit', async ($, e, next) => {
    try {
      const text = personText(e.text)
      if (REQUEST_ORIGINS.includes(e.origin.kind) && text !== '' && !isMachineText(text) && !/^\/[\w:.-]+$/.test(text)) await addRequest($, text, e.turnId)
    } catch {
      // 기록은 덤이라 실패해도 프롬프트는 그대로 간다
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  registerAgents(on)
  registerExplorerScroll(on)

  // 도구 호출 하나를 보드에는 "지금 하는 일"로, 탐색기에는 "고친 파일"로 남긴다
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    // 핸드오프 화면이 세션 목록을 받으려고 부른 ListAgents는 보드·자막에 올리지 않는다
    if (tool === 'ListAgents' && e.agentId === undefined) return next(e)
    const input = e as unknown as Record<string, unknown>
    await recordToolCall($, e.agentId, tool, input).catch(() => undefined)
    const role = e.agentId === undefined ? undefined : (await read($, agentsAtom))[e.agentId]?.role
    await setCaption($, `${role === undefined ? '' : `[${role}] `}${captionFor(tool, input)}`).catch(() => undefined)
    const ran = await next(e)
    const outcome = ran as { deny?: string; isError?: true }
    await noteEdit($, tool, input, outcome).catch(() => undefined)
    // Claude가 한국어 원고를 쓰거나 고치면 문체 게이트를 돌린다
    const written = typeof input.file_path === 'string' ? input.file_path : undefined
    if (EDIT_TOOLS.includes(tool) && written !== undefined && PROSE.test(written) && outcome.deny === undefined && outcome.isError !== true && (await read($, gateOnAtom))) {
      const real = (await $.fs.stat(written, { resolve: true }).catch(() => undefined))?.realPath
      if (real !== undefined) await runGate($, real).catch(() => undefined)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const isLecture = await read($, lectureAtom)
    const gate = await read($, gateAtom)
    const isGateOpen = await read($, gateOpenAtom)
    const showGate = gate !== null && gate.verdict !== 'pass'
    if (!isLecture && !showGate) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(10, e.props.bodyColumns)
    await read($, tickAtom)
    const below = await next(e)
    const caption = isLecture ? await read($, captionAtom) : undefined
    const running = isLecture ? Object.values(await read($, agentsAtom)).filter(r => r.id !== MAIN && r.phase === 'running').length : 0

    return (
      <Box flexDirection="column" width={width}>
        {caption !== undefined && (
          <Box key="lecture" flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
            <Text bold color="warning" wrap="truncate-end">▶ {caption.text || '대기 중'}</Text>
            <Text dimColor wrap="truncate-end">
              {caption.prev !== '' ? `방금: ${caption.prev} · ` : ''}{caption.step}단계{caption.startedAt > 0 ? ` · ${formatElapsed(Date.now() - caption.startedAt)}` : ''}{running > 0 ? ` · 도우미 에이전트 ${running}명 작업 중` : ''}
            </Text>
          </Box>
        )}
        {showGate && gate !== null && (
          <Box key="gate" flexDirection="column">
            <Box flexDirection="row" columnGap={2} height={1} overflow="hidden">
              <Text color={gate.verdict === 'stop' ? 'error' : 'warning'} wrap="truncate-end">문체 게이트 · {gateSummary(gate)}</Text>
              <Button key="gate-open" plain hotkey="g" label={isGateOpen ? '접기' : '예문'} onPress={() => void update($, gateOpenAtom, v => !v)} />
              <Button key="gate-close" plain hotkey="d" label="닫기" onPress={() => void update($, gateAtom, () => null)} />
            </Box>
            {isGateOpen && gate.examples.map((x, i) => <Text key={`gate-ex:${i}`} dimColor wrap="truncate-end">  {x}</Text>)}
          </Box>
        )}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(10, e.props.bodyColumns)
    const bodyRows = Math.max(4, e.props.scroll.bodyRows)
    const board = await drawBoard($, e, width, clamp(Math.round(bodyRows * 0.35), 2, 12))
    const explorerRows = Math.max(2, bodyRows - board.length - 1)
    const explorer = await drawExplorer($, e, width, explorerRows, board.length + 2)

    return (
      <Box flexDirection="column" width={width}>
        {board}
        <Text key="board-rule" dimColor>{'─'.repeat(width)}</Text>
        {explorer}
      </Box>
    )
  })
}
