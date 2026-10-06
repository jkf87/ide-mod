import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, On, Register, RenderElement, RenderInput } from 'claude-code'

import type { AgentPhase, AgentRow, ViewMode } from '../types'

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
  if (isRecapping || !isInteractive || Date.now() - lastDrawnAt > 30_000) return
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

/** session.start에서 한 번: 요약·정리 타이머를 건다 (비대화형 세션에서는 걸지 않는다) */
function startAgents($: EngineInterface, interactive: boolean) {
  isInteractive = interactive
  if (!interactive) return
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
    if (e.text.trim() !== '') {
      await patch($, MAIN, row => ({
        ...row,
        role: 'main',
        task: oneLine(e.text, 120),
        phase: 'running',
        activity: '생각 중',
        log: [],
        recap: '',
        isRecapStale: false,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        endedAt: undefined,
      }))
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

  const header = (
    <Box key="board-header" flexDirection="row" columnGap={2} height={1} overflow="hidden">
      <Text bold wrap="truncate-end">{summary}</Text>
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
    const doing = row.phase === 'running' && row.recap !== '' ? `요약 ${row.recap}` : row.phase === 'running' && row.activity !== '' ? `지금 ${row.activity}` : row.recap !== '' ? `결과 ${row.recap}` : row.activity
    lines.push(
      <Text key={`agent:${row.id}`} wrap="truncate-end">
        <Text dimColor>{lead}{depth === 0 ? '' : branch}</Text>
        <Text color={PHASE_COLOR[row.phase]}>{PHASE_ICON[row.phase]} </Text>
        <Text bold color={row.id === MAIN ? 'claude' : colorOf(row.role)}>{row.id === MAIN ? '메인' : row.role}</Text>
        <Text>  {brain}</Text>
        <Text dimColor>  {PHASE_LABEL[row.phase]} {elapsed}{row.isBackground ? ' · 백그라운드' : ''}{row.toolCount > 0 ? ` · 도구 ${row.toolCount}` : ''}</Text>
        <Text>{row.task !== '' ? `  ${oneLine(row.task, 80)}` : ''}</Text>
      </Text>,
    )
    if (doing !== '') {
      lines.push(
        <Text key={`agent-doing:${row.id}`} wrap="truncate-end" dimColor>
          {pad}{oneLine(doing, Math.max(10, width))}
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
}
// 스크롤할 때마다 디스크를 다시 읽지 않도록: 트리는 (뿌리·펼친 폴더·세대)로, 파일은 수정 시각으로 재사용한다
let treeEpoch = 0
let treeCache: { key: string; rows: TreeRow[]; isCut: boolean } | undefined
const fileCache = new Map<string, { mtimeMs: number; size: number; lines: string[] }>()
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
    if (isOverTree) {
      await update($, treeOffsetAtom, n => clamp(n + e.by, 0, layout.treeRows - layout.treeView))
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

  const isWide = width >= SPLIT_MIN_COLUMNS
  const showTree = isWide ? !isTreeHidden || active === '' : !(isTreeHidden && active !== '')
  const showFile = isWide ? true : !showTree
  const treeWidth = showTree && showFile ? clamp(Math.round(width * 0.3), 24, 44) : width
  const fileWidth = showTree && showFile ? width - treeWidth - 1 : width
  const mainRows = Math.max(1, rows - 1)
  const isMarkdown = MARKDOWN.test(active)
  layout.topRows = topRows

  // ── 툴바 ──
  const toolbar = (
    <Box key="ide-toolbar" flexDirection="row" columnGap={2} height={1} overflow="hidden">
      <Button key="tree" plain hotkey="t" label={showTree && showFile ? '트리 접기' : '트리'} onPress={() => void update($, treeHiddenAtom, v => (active === '' ? false : !v))} />
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
          fileCache.clear()
          treeEpoch += 1
          void update($, revAtom, n => n + 1)
        }}
      />
      {active !== '' && isMarkdown && (
        <Button key="mode" plain hotkey="m" label={mode === 'rendered' ? '원문' : '렌더'} onPress={() => void update($, modeAtom, m => (m === 'rendered' ? 'code' : 'rendered'))} />
      )}
      {active !== '' && <Button key="mention" plain hotkey="p" label="@프롬프트" onPress={() => void $.prompt.fill({ text: `@${active} `, mode: 'insert' })} />}
      {active !== '' && <Button key="copy" plain hotkey="c" label="경로 복사" onPress={() => void $.ui.copy({ text: active, surface: e.surface })} />}
      {active !== '' && <Button key="close" plain hotkey="w" label="탭 닫기" onPress={() => void closeTab($, active)} />}
    </Box>
  )

  // ── 트리 ──
  let treeColumn: RenderElement | false = false
  if (showTree) {
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
    Object.assign(layout, { active, fileMaxOffset: 0 })

    if (active === '') {
      fileColumn = frame('', <Text dimColor>왼쪽 트리에서 파일을 고르세요. 휠·방향키로 스크롤, j/k로 트리 넘기기.</Text>)
    } else {
      const relative = isInside(active, root) && active !== root ? active.slice(root.length).replace(/^\//, '') : active
      const stat = await $.fs.stat(active).catch(() => undefined)
      if (stat === undefined) {
        fileColumn = frame(relative, <Text color="error">파일이 없어졌어요.</Text>)
      } else if (stat.kind !== 'file') {
        fileColumn = frame(relative, <Text dimColor>일반 파일이 아니라 미리볼 수 없어요.</Text>)
      } else if (PNG.test(active)) {
        if (e.surface === 'terminal') {
          const { Image } = $.ui.resolve(e)
          fileColumn = frame(
            `${relative} · ${formatSize(stat.size)}`,
            <Image source={{ file: active, format: 'png', generation: stat.mtimeMs }} columns={clamp(fileWidth, 1, 255)} rows={clamp(contentRows, 1, 255)} alt={`이미지 ${baseName(active)} (kitty·Ghostty 터미널에서 보여요)`} />,
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

// ════════════════ 연결 ════════════════
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // 이름이 다른 플러그인과 겹쳐 하나가 거절돼도 나머지는 등록되게 따로 부른다
    await $.command.register({ name: 'ide', description: 'IDE 창: 에이전트 보드 + 파일 트리 + 탭 에디터', argumentHint: '[경로]' }).catch(() => undefined)
    startAgents($, e.isInteractive)
    await $.command.register({ name: 'open', description: 'IDE 창에서 폴더나 파일을 엽니다', argumentHint: '[경로]' }).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'ide' }, async ($, e) => ({ text: await openIde($, e.args ?? '') }))
  on('command.run', { command: 'open' }, async ($, e) => ({ text: await openIde($, e.args ?? '.') }))

  registerAgents(on)
  registerExplorerScroll(on)

  // 도구 호출 하나를 보드에는 "지금 하는 일"로, 탐색기에는 "고친 파일"로 남긴다
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    await recordToolCall($, e.agentId, tool, input).catch(() => undefined)
    const ran = await next(e)
    await noteEdit($, tool, input, ran as { deny?: string; isError?: true }).catch(() => undefined)
    return ran
  }).catch(($, e, next) => next(e))

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
