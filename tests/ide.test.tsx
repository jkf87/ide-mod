import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { blockStarts, cacheHitOf, parseAgyHistory, captionFor, dotGauge, fitLine, lineGroups, normLayout, type GaugeKind, describeCall, fit, handoffNote, isMachineText, parseAgyUsage, parseClaudeUsage, parseCodexLimits, parsePeers, parseSysStat, personText, pickPeer, requestsAsText, shortModel, shortTokens, styleGate, tokPerSecOf, untilReset } from '../hooks/register'

// ── 가짜 작업 폴더 (테스트 엔진은 상대 경로를 플러그인 폴더 기준으로 풀어서 절대 경로만 쓴다) ──
const ROOT = '/work'
// 1×1 PNG (엔진이 IHDR까지 검사한다)
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
const SLOP = '이것은 단순한 도구가 아니라 동반자다. 결론적으로 혁신적이고 획기적인 변화다. 요약하면 이제 나아가야 할 때입니다. 그것은 기술이 아니라 문화다. 우리는 모두 함께 앞으로 걸어가야 한다는 사실을 잊지 말아야 한다.'
const LONG = Array.from({ length: 100 }, (_, i) => `const line${i + 1} = ${i + 1}`).join('\n')
const FILES: Record<string, string> = {
  '/work/README.md': '# 제목\n\n본문 문단',
  '/work/src/app.ts': 'export const answer = 42\n',
  '/work/src/long.ts': LONG,
  '/work/doc.hwpx': 'PK-가짜-hwpx',
  '/work/draft.md': SLOP,
  '/work/pic.png': 'PNG',
  '/work/notice.pdf': '%PDF-1.7',
}
const DIRS: Record<string, string[]> = {
  '/work': ['src', 'link', 'README.md', 'doc.hwpx', 'notice.pdf', 'draft.md', 'pic.png', '.DS_Store'],
  '/work/src': ['app.ts', 'long.ts'],
}
// /work/link → /work/src 를 가리키는 심볼릭 링크
const LINKS: Record<string, string> = { '/work/link': '/work/src' }

const norm = (p: string) => (p.startsWith('/') ? p : `${ROOT}/${p}`).replace(/\/\.$/, '').replace(/\/+$/, '') || '/'
const real = (p: string) => {
  const abs = norm(p)
  for (const [link, target] of Object.entries(LINKS)) if (abs === link || abs.startsWith(`${link}/`)) return target + abs.slice(link.length)
  return abs
}

type World = { opened: number; statuses: (string | undefined)[]; rhwpCalls: string[]; scripts: string[]; saved?: unknown; sent: { to: string; text: string }[]; copied: string[]; extraRuns?: (argv: string[]) => string | undefined; store: Map<string, unknown>; written: Map<string, string> }

const LISTING = `This session is 모드에 대해 [634505] — the name other sessions use to message it.

Peer sessions (2):
  화목난로 자동 보충 기능 [a33860]  ·  interactive  ·  idle  ·  Claude Desktop session  ·  started 10h ago
  목차작성 [ed478e]  ·  interactive  ·  busy  ·  started 3h ago`

function fakeWorld(on: On): World {
  const world: World = { opened: 0, statuses: [], rhwpCalls: [], scripts: [], sent: [], copied: [], store: new Map(), written: new Map() }
  on('session.cwd', () => ({ value: ROOT }))
  on('env.get', () => ({ value: '/home/me' }))
  on('fs.stat', ($, e) => {
    const abs = norm(e.path)
    const target = real(e.path)
    const isLink = abs in LINKS
    if (target in DIRS) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 1, isLink, realPath: target } }
    const text = FILES[target]
    if (text === undefined) throw new Error('ENOENT')
    // 실제 파일 시스템처럼 수정 시각에 소수가 붙는다
    return { value: { kind: 'file' as const, size: text.length, mtimeMs: 1791255799123.456, isLink, realPath: target } }
  })
  on('fs.list', ($, e) => {
    const dir = real(e.path)
    return {
      value: (DIRS[dir] ?? []).map(name => {
        const abs = `${dir}/${name}`
        const isLink = abs in LINKS
        const kind = isLink ? ('other' as const) : abs in DIRS ? ('dir' as const) : ('file' as const)
        return { name, kind, size: 0, mtimeMs: 0, isLink }
      }),
    }
  })
  on('fs.read', ($, e) => {
    if (e.as === 'bytes') return { value: { base64: TINY_PNG } }
    const text = FILES[real(e.path)]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('ui.open', () => {
    world.opened += 1
    return { value: { isPlaced: true as const } }
  })
  on('ui.status', ($, e) => {
    world.statuses.push((e as unknown as { text?: string }).text)
    return { value: undefined } as never
  })
  on('tool.call', ($, e) => {
    if (String(e.tool) === 'ListAgents') return { result: { listing: LISTING } } as never
    return String(e.tool) === 'Write' && (e as unknown as { content?: string }).content === 'DENY' ? { deny: 'no' } : ({ result: 'ok' } as never)
  })
  on('session.root', () => ({ value: ROOT }))
  on('fs.exists', ($, e) => ({ value: e.path === `/home/me/projects/${ROOT.replace(/[^a-zA-Z0-9]/g, '-')}/test-session.jsonl` }))
  on('session.send', ($, e) => {
    world.sent.push({ to: e.to, text: e.text })
    return { isDelivered: true as const }
  })
  on('ui.copy', ($, e) => {
    world.copied.push((e as unknown as { text: string }).text)
    return { value: undefined } as never
  })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('process.run', ($, e) => {
    const extra = world.extraRuns?.(e.argv.map(String))
    if (extra !== undefined) return { value: { exitCode: 0, stdout: extra, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (String(e.argv[1]).endsWith('agy-usage.sh')) return { value: { exitCode: 127, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (String(e.argv[1]).endsWith('codex-limits.mjs')) return { value: { exitCode: 1, stdout: '{"error":"no codex"}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (e.argv[0] === '/bin/sh') return { value: { exitCode: 0, stdout: SYS_MAC, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    world.rhwpCalls.push(e.argv.slice(2).join(' '))
    world.scripts.push(String(e.argv[1]).split('/').pop() ?? '')
    const page = Number(e.argv[4])
    const grid: { t: string; b?: number; l?: number; r?: number }[][] = Array.from({ length: 30 }, (_, i) => [{ t: `${page + 1}쪽 ${i + 1}줄` }])
    grid[0] = [{ t: '연구 계획서', b: 1 }]
    grid[1] = [{ t: '┌──┬──┐', l: 1 }]
    grid[2] = [{ t: '기관 ' }, { t: '{{기관명}}', r: 1 }]
    const stdout = e.argv[2] === 'text'
      ? JSON.stringify({ format: 'hwpx', pages: 2, residues: ['{{기관명}}'], blocks: [] })
      : e.argv[2] === 'grid'
        ? JSON.stringify({ pages: 2, page, cols: Number(e.argv[5]), width: 40, rows: grid })
        : JSON.stringify({ pages: 2, page, pngPath: '/tmp/page.png', pngWidth: 990, pngHeight: 1400, svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' })
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('session.id', () => ({ value: 'test-session' }))
  on('store.get', ($, e) => ({ value: world.store.get(String((e as unknown as { key: string }).key)) }) as never)
  on('store.set', ($, e) => {
    const { key, value } = e as unknown as { key: string; value: unknown }
    world.store.set(String(key), value)
    if (String(key).startsWith('requests:')) world.saved = value
    return { value: undefined } as never
  })
  on('store.keys', () => ({ value: [...world.store.keys()] }))
  on('fs.write', ($, e) => {
    const { path, text } = e as unknown as { path: string; text: string }
    world.written.set(path, text)
    return { value: undefined } as never
  })
  return world
}

/** 사람이 입력창에서 보낸 요청: prompt.submit(composer) 뒤에 그 턴이 시작된다 */
async function ask($: Parameters<Parameters<typeof test>[1]>[0], text: string, turnId: string) {
  await $.prompt.submit({ text, origin: { kind: 'composer' } } as never)
  await $.turn.start({ text, turnId })
}

const typed = (command: string, args: string) => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 160 },
})
const props = (bodyColumns: number, bodyRows = 30) => ({
  title: 'IDE',
  isFocused: true,
  bodyColumns,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows },
  view: {},
})
const PANE = { plugin: 'ide-mod', component: 'Pane', requestId: 'ide-mod' } as const
const BAND = { plugin: 'ide-mod', component: 'AbovePrompt' } as const
const bandProps = { hasSurvey: false, isWorking: true, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 11 }, view: {} }
const textOf = (found: { text: string }[]) => found.map(f => f.text).join('\n')
const spawn = (id: string, description: string, subagentType: string) => ({
  tool_use_id: `tu-${id}`,
  prompt: description,
  description,
  subagentType,
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel: 'claude-opus-5-5[1m]',
  background: false,
  fork: false,
})

describe('순수 함수', () => {
  test('모델 이름을 짧게 줄인다 (Bedrock·Vertex 표기 포함)', () => {
    expect(shortModel('claude-opus-5-5[1m]')).toBe('opus 5.5 1M')
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('haiku 4.5')
    expect(shortModel('claude-fable-5-1')).toBe('fable 5.1')
    expect(shortModel('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('sonnet 4.5')
    expect(shortModel('claude-sonnet-4-5@20250929')).toBe('sonnet 4.5')
    expect(shortModel('claude-3-5-haiku-20241022')).toBe('haiku 3.5')
    expect(shortModel('gpt-x')).toBe('gpt-x')
  })

  test('도구 호출을 한 줄 활동으로 바꾼다', () => {
    expect(describeCall('Bash', { command: 'ls -la', description: '파일 목록' })).toBe('Bash  파일 목록')
    expect(describeCall('Agent', { subagent_type: 'Explore', description: '인증 코드 찾기' })).toBe('Agent → Explore: 인증 코드 찾기')
    expect(describeCall('mcp__stitch__stitch_get', {})).toBe('stitch_get')
  })

  test('풀어 쓴(NFD) 한글 이름도 칸 수대로 자른다', () => {
    const nfd = '스크린샷'.normalize('NFD')
    expect(fit(nfd, 8)).toBe('스크린샷')
    expect(fit(nfd, 5)).toBe('스크…')
  })

  test('렌더 창은 코드 울타리 안에서 시작하지 않는다', () => {
    expect(blockStarts(['# a', '', 'para', '```', 'x', '', 'y', '```', '', 'end'])).toEqual([0, 2, 9])
  })
})

describe('탐색기', () => {
  test('트리를 펼쳐 파일을 탭으로 열고, 탭을 오가고 닫는다', async ($, on) => {
    fakeWorld(on)
    await $.command.run(typed('open', '/work'))

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface, props: props(140) })
      expect(await ui.find({ key: 'tree:/work/src' })).toBeDefined()
      expect(await ui.find({ key: 'tree:/work/.DS_Store' })).toBeUndefined()
      await ui.unmount()
    }

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: props(140) })
    await ui.press({ key: 'tree:/work/src' })
    await ui.press({ key: 'tree:/work/src/app.ts' })
    expect(await ui.find({ key: 'tree:/work/src' })).toBeDefined()
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe('export const answer = 42')
    await ui.press({ key: 'tree:/work/README.md' })
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe('# 제목\n\n본문 문단')
    await ui.press({ key: 'mode' })
    expect(await ui.find({ type: 'Markdown' })).toBeDefined()
    await ui.press({ key: 'tab:/work/src/app.ts' })
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe('export const answer = 42')
    await ui.press({ key: 'close' })
    expect(await ui.find({ key: 'tab:/work/src/app.ts' })).toBeUndefined()
    await ui.unmount()
  })

  test('심볼릭 링크 폴더도 펼쳐진다', async ($, on) => {
    fakeWorld(on)
    await $.command.run(typed('open', '/work'))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: props(140) })
    await ui.press({ key: 'tree:/work/link' })
    expect(await ui.find({ key: 'tree:/work/link/app.ts' })).toBeDefined()
    await ui.unmount()
  })

  test('파일 경로로 열면 조상 폴더가 펼쳐지고, 긴 파일은 화면 행만큼만 그린다', async ($, on) => {
    fakeWorld(on)
    await $.command.run(typed('open', '/work/src/long.ts'))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: props(140, 30) })
    expect(await ui.find({ key: 'tree:/work/src/long.ts' })).toBeDefined()
    const code = await ui.find({ type: 'Code' })
    expect(code?.props.startLine).toBe(1)
    const shown = String(code?.props.source).split('\n').length
    // 보드(시스템 줄 1 + 머리줄 1 + 빈 보드 안내 1) · 구분선 1 · 툴바 1 · 탭 1 · 파일 정보 1을 뺀 행
    expect(shown).toBe(30 - 3 - 1 - 1 - 2)
    await ui.unmount()
  })

  test('좁은 화면에서는 트리와 파일을 번갈아 보여준다', async ($, on) => {
    fakeWorld(on)
    await $.command.run(typed('open', '/work'))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: props(50) })
    await ui.press({ key: 'tree:/work/README.md' })
    expect(await ui.find({ key: 'tree:/work/src' })).toBeUndefined()
    expect(await ui.find({ type: 'Code' })).toBeDefined()
    await ui.press({ key: 'tree' })
    expect(await ui.find({ key: 'tree:/work/src' })).toBeDefined()
    await ui.unmount()
  })

  test('거절된 Write는 고친 파일로 표시하지 않고, 성공한 Edit은 표시한다', async ($, on) => {
    fakeWorld(on)
    await $.command.run(typed('open', '/work/src/app.ts'))
    await $.tool.call({ tool: 'Write', file_path: '/work/src/app.ts', content: 'DENY' } as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: props(140) })
    expect((await ui.find({ key: 'tab:/work/src/app.ts' }))?.props.label).not.toContain('●')
    await $.tool.call({ tool: 'Edit', file_path: '/work/src/app.ts', old_string: 'a', new_string: 'b' } as never)
    expect((await ui.find({ key: 'tab:/work/src/app.ts' }))?.props.label).toContain('●')
    await ui.unmount()
  })

  test('없는 경로는 친절하게 거절한다', async ($, on) => {
    fakeWorld(on)
    const ran = await $.command.run(typed('open', 'nope.txt'))
    expect(ran.text).toContain('찾을 수 없어요')
  })
})

describe('에이전트 보드', () => {
  test('보드가 IDE 맨 위에 메인과 서브에이전트를 트리로 그린다', async ($, on) => {
    const world = fakeWorld(on)
    on('agent.spawn', () => ({ model: 'claude-haiku-4-5-20251001', agentId: 'sub-1' }))
    await $.command.run(typed('ide', ''))
    await ask($, '로그인 버그 고쳐줘', 't1')
    await $.agent.spawn(spawn('sub-1', '인증 코드 찾기', 'Explore'))
    await $.tool.call({ tool: 'Grep', pattern: 'login', agentId: 'sub-1' } as never)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface, props: props(140) })
      const all = await ui.findAll({ type: 'Text' })
      const text = textOf(all)
      expect(text).toContain('메인')
      expect(text).toContain('로그인 버그 고쳐줘')
      expect(text).toContain('└─ ')
      expect(text).toContain('Explore')
      expect(text).toContain('haiku 4.5')
      expect(text).toMatch(/지금 Grep\s+login/)
      // 보드가 탐색기보다 위에 있다
      expect(text.indexOf('메인')).toBeLessThan(text.indexOf('열린 파일 없음'))
      await ui.unmount()
    }
    expect(world.statuses.some(s => s?.includes('서브에이전트 1개'))).toBe(true)
    // 색: 맡긴 일(사람의 프롬프트·서브에이전트 작업 설명)은 초록, 돌고 있는 에이전트의 지금 하는 일은 노랑
    const colored = await $.ui.mount({ ...PANE, surface: 'terminal', props: props(140) })
    const texts = await colored.findAll({ type: 'Text' })
    expect(texts.find(x => x.text.includes('로그인 버그 고쳐줘') && x.props.color === 'success')).toBeDefined()
    expect(texts.find(x => x.text.includes('Grep') && x.props.color === 'warning')).toBeDefined()
    // 서브에이전트에게 맡긴 작업 설명도 초록
    expect(texts.find(x => x.text.includes('인증 코드 찾기') && x.props.color === 'success')).toBeDefined()
    await colored.unmount()

    await $.turn.complete({ answer: '## 찾았다\nlogin.ts 42행', durationMs: 1200, isAborted: false, turnId: 't2', agentId: 'sub-1', reason: 'answer' } as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: props(140) })
    const text = textOf(await ui.findAll({ type: 'Text' }))
    expect(text).toContain('✓')
    expect(text).toContain('찾았다')
    await ui.unmount()
  })

  test('오류로 끝난 서브에이전트는 실패로 표시한다', async ($, on) => {
    fakeWorld(on)
    on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'sub-err' }))
    await ask($, '작업', 't1')
    await $.agent.spawn(spawn('sub-err', '깨질 작업', 'general-purpose'))
    await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 't3', agentId: 'sub-err', reason: 'error' } as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: props(140) })
    const text = textOf(await ui.findAll({ type: 'Text' }))
    expect(text).toContain('✗')
    expect(text).toContain('실패')
    await ui.unmount()
  })

  test('spawn 없이 온 내부 포크는 보드에 줄을 만들지 않는다', async ($, on) => {
    fakeWorld(on)
    await ask($, '작업', 't1')
    await $.tool.call({ tool: 'Read', file_path: '/work/README.md', agentId: 'compaction-fork' } as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: props(140) })
    const text = textOf(await ui.findAll({ type: 'Text' }))
    expect(text).toContain('서브 0개 작업 중')
    await ui.unmount()
  })

  test('끝난 것을 숨겨도 돌고 있는 손자 에이전트는 남는다', async ($, on) => {
    fakeWorld(on)
    let n = 0
    on('agent.spawn', () => ({ model: 'claude-haiku-4-5-20251001', agentId: n++ === 0 ? 'parent' : 'child' }))
    await ask($, '작업', 't1')
    await $.agent.spawn(spawn('parent', '부모 작업', 'Plan'))
    await $.agent.spawn({ ...spawn('child', '손자 작업', 'Explore'), parentAgentId: 'parent' })
    await $.turn.complete({ answer: '부모 끝', durationMs: 10, isAborted: false, turnId: 't4', agentId: 'parent', reason: 'answer' } as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: props(140) })
    await ui.press({ key: 'board-hide' })
    const text = textOf(await ui.findAll({ type: 'Text' }))
    expect(text).toContain('손자 작업')
    await ui.press({ key: 'board-fold' })
    expect(textOf(await ui.findAll({ type: 'Text' }))).not.toContain('손자 작업')
    await ui.unmount()
  })
})

describe('HWP 뷰어 (rhwp)', () => {
  test('문서 보기로 쪽을 글자 격자 그대로 그리고, 끝까지 내리면 다음 쪽으로 넘어간다', async ($, on) => {
    const world = fakeWorld(on)
    const clock = mock.clock(on)
    await $.command.run(typed('open', '/work/doc.hwpx'))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: props(140) })
    // 엔진은 그리기 밖(타이머)에서 돈다
    expect(textOf(await ui.findAll({ type: 'Text' }))).toContain('rhwp 엔진으로 읽는 중')
    expect(world.rhwpCalls).toEqual([])
    await clock.advance(5)
    await clock.advance(5)
    const text = textOf(await ui.findAll({ type: 'Text' }))
    expect(text).toContain('연구 계획서')
    expect(text).toContain('┌──┬──┐')
    expect(text).toContain('치환 안 된 칸 1개')
    expect(text).toContain('1/2쪽')
    const residue = (await ui.findAll({ type: 'Text' })).find(t => t.text === '{{기관명}}')
    expect(residue?.props.color).toBe('error')
    expect(world.rhwpCalls[0]).toBe('text /work/doc.hwpx')
    expect(world.rhwpCalls[1]).toMatch(/^grid \/work\/doc\.hwpx 0 \d+$/)
    await ui.unmount()
  })

  test('그림 보기와 쪽 넘김, 데스크톱은 SVG로 그린다', async ($, on) => {
    const world = fakeWorld(on)
    const clock = mock.clock(on)
    await $.command.run(typed('open', '/work/doc.hwpx'))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: props(140) })
    await clock.advance(5)
    await ui.press({ key: 'hwp-view' })
    await clock.advance(5)
    const image = await ui.find({ type: 'Image' })
    expect(image?.props.source).toEqual({ png: TINY_PNG })
    expect(String(image?.props.alt)).toContain('o로 미리보기')
    await ui.press({ key: 'hwp-next' })
    await clock.advance(5)
    expect(world.rhwpCalls).toContain('page /work/doc.hwpx 1')
    // 같은 쪽은 다시 돌리지 않는다
    const before = world.rhwpCalls.length
    await ui.press({ key: 'hwp-prev' })
    await clock.advance(5)
    expect(world.rhwpCalls.length).toBe(before)
    await ui.unmount()

    const desk = await $.ui.mount({ ...PANE, surface: 'desktop', props: props(140) })
    await clock.advance(5)
    expect(await desk.find({ type: 'Svg' })).toBeDefined()
    await desk.unmount()
  })
})

describe('PDF 뷰어 (pdf.js)', () => {
  test('PDF는 pdf.js 엔진으로 문서 보기를 그린다', async ($, on) => {
    const world = fakeWorld(on)
    const clock = mock.clock(on)
    await $.command.run(typed('open', '/work/notice.pdf'))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: props(140) })
    expect(textOf(await ui.findAll({ type: 'Text' }))).toContain('pdf.js 엔진으로 읽는 중')
    await clock.advance(5)
    await clock.advance(5)
    expect(textOf(await ui.findAll({ type: 'Text' }))).toContain('1/2쪽')
    expect(world.scripts.every(s => s === 'pdf-view.mjs')).toBe(true)
    expect(world.rhwpCalls[0]).toBe('text /work/notice.pdf')
    await ui.unmount()
  })

  test('HWP는 rhwp 엔진으로 연다', async ($, on) => {
    const world = fakeWorld(on)
    const clock = mock.clock(on)
    await $.command.run(typed('open', '/work/doc.hwpx'))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: props(140) })
    await clock.advance(5)
    expect(world.scripts[0]).toBe('rhwp-view.mjs')
    await ui.unmount()
  })
})

describe('그림 파일', () => {
  test('PNG는 base64로 넘기고, 수정 시각에 소수가 있어도 창이 그려진다', async ($, on) => {
    fakeWorld(on)
    await $.command.run(typed('open', '/work/pic.png'))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: props(140) })
    expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: TINY_PNG })
    await ui.unmount()
  })
})

describe('요청 기록', () => {
  test('보낸 요청이 쌓이고 끝나면 답 첫 줄과 함께 완료로 바뀐다', async ($, on) => {
    const world = fakeWorld(on)
    await ask($, '로그인 버그 고쳐줘', 't1')
    await $.turn.complete({ answer: '고쳤어요. login.ts 42행이 원인', durationMs: 50, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    await ask($, '테스트도 추가해줘', 't2')
    await $.command.run(typed('ide', ''))

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: props(140) })
    await ui.press({ key: 'left-mode' })
    expect((await ui.find({ key: 'req:1' }))?.props.label).toContain('✓')
    expect((await ui.find({ key: 'req:2' }))?.props.label).toContain('●')
    // 기본은 이번 세션 요청 전부를 최근 것부터 이어서 보여 준다
    const all = textOf(await ui.findAll({ type: 'Text' }))
    expect(all).toContain('이번 세션 요청 2개 전부')
    expect(all.indexOf('테스트도 추가해줘')).toBeLessThan(all.indexOf('로그인 버그 고쳐줘'))
    expect(all).toContain('└ Claude: 고쳤어요. login.ts 42행이 원인')
    expect((await ui.find({ key: 'request-all' }))?.props.label).toBe('하나만 보기')
    expect(requestsAsText((world.saved as { items: Parameters<typeof requestsAsText>[0] }).items)).toMatch(/#1 .*✓\n로그인 버그 고쳐줘\n└ Claude: 고쳤어요/)
    // 하나를 고르면 그 요청만 펼치고, l로 다시 전부 보기
    await ui.press({ key: 'req:1' })
    const text = textOf(await ui.findAll({ type: 'Text' }))
    expect(text).toContain('요청 #1')
    expect(text).toContain('Claude 답: 고쳤어요. login.ts 42행이 원인')
    expect((await ui.findAll({ type: 'Text' })).find(x => x.text === '로그인 버그 고쳐줘')?.props.color).toBe('success')
    expect(JSON.stringify(world.saved)).toContain('테스트도 추가해줘')
    await ui.press({ key: 'request-all' })
    expect(textOf(await ui.findAll({ type: 'Text' }))).toContain('이번 세션 요청 2개 전부')
    await ui.unmount()
  })
})

describe('핸드오프', () => {
  test('ListAgents 목록을 읽고 세션 이름으로 고른다', () => {
    const { self, peers } = parsePeers(LISTING)
    expect(self).toBe('모드에 대해')
    expect(peers.map(p => [p.name, p.ref, p.status])).toEqual([['화목난로 자동 보충 기능', 'a33860', 'idle'], ['목차작성', 'ed478e', 'busy']])
    expect(pickPeer(peers, '목차작성 3장 검토 부탁')?.ref).toBe('ed478e')
    expect(pickPeer(peers, 'a33860')?.name).toBe('화목난로 자동 보충 기능')
    expect(pickPeer(peers, '없는 세션')).toBeUndefined()
  })

  test('핸드오프 글에 세션 ID·기록 경로·이어서 열기 명령·요청이 들어간다', () => {
    const note = handoffNote(
      { id: 'abc', root: '/my proj', transcript: '/c/projects/-my-proj/abc.jsonl' },
      [
        { n: 1, text: '로그인 고쳐줘\n에러 로그도 봐줘', at: Date.now(), status: 'done', answer: '고쳤어요' },
        { n: 2, text: '<task-notification>agent finished</task-notification>', at: Date.now(), status: 'done', answer: '' },
      ],
      '테스트 돌리는 중',
      '3장만',
    )
    expect(note).toContain('세션 ID: abc')
    expect(note).toContain('대화 기록: /c/projects/-my-proj/abc.jsonl')
    expect(note).toContain("이어서 열기: cd '/my proj' && claude --resume abc --fork-session")
    expect(note).toContain('메모: 3장만')
    expect(note).toContain('에이전트가 마지막에 하던 일: 테스트 돌리는 중')
    expect(note).toContain('사용자가 보낸 요청 1개 (오래된 것부터):')
    expect(note).toMatch(/1\. \[\d\d:\d\d\] 로그인 고쳐줘\n {3}에러 로그도 봐줘/)
    expect(note).not.toContain('고쳤어요')
    expect(note).not.toContain('task-notification')
  })

  test('보드의 i로 핸드오프 화면을 열고, 세션을 누르면 그 세션에 보낸다', async ($, on) => {
    const world = fakeWorld(on)
    await ask($, '로그인 버그 고쳐줘', 't1')
    await $.command.run(typed('ide', ''))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: props(140) })
    expect(textOf(await ui.findAll({ type: 'Text' }))).toContain('세션 test-ses')
    await ui.press({ key: 'board-handoff' })
    const text = textOf(await ui.findAll({ type: 'Text' }))
    expect(text).toContain('이 세션: 모드에 대해')
    expect(text).toContain(`대화 기록: /home/me/projects/${ROOT.replace(/[^a-zA-Z0-9]/g, '-')}/test-session.jsonl`)
    expect((await ui.find({ key: 'peer:ed478e' }))?.props.label).toContain('목차작성 · 작업 중')
    await ui.press({ key: 'peer:a33860' })
    expect(world.sent[0].to).toBe('화목난로 자동 보충 기능 [a33860]')
    expect(world.sent[0].text).toContain('세션 ID: test-session')
    expect(world.sent[0].text).toContain('로그인 버그 고쳐줘')
    expect(textOf(await ui.findAll({ type: 'Text' }))).toContain('화목난로 자동 보충 기능에 보냈어요')
    await ui.press({ key: 'handoff-id' })
    expect(world.copied.at(-1)).toBe('test-session')
    await ui.unmount()
  })

  test('/handoff 세션 이름 메모 로 바로 보낸다', async ($, on) => {
    const world = fakeWorld(on)
    const out = await $.command.run(typed('handoff', '목차작성 3장 검토 부탁'))
    expect(JSON.stringify(out)).toContain('핸드오프를 보냈어요 → 목차작성')
    expect(world.sent[0].to).toBe('목차작성 [ed478e]')
    expect(world.sent[0].text).toContain('메모: 3장 검토 부탁')
  })
})

// 2026-10-08 이 Mac(32GB)의 실제 출력에서 필요한 줄만
const SYS_MAC = `==mem
34359738368
2
total = 22528.00M  used = 21987.12M  free = 540.88M  (encrypted)
==vm
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages active:                                 290740.
Pages wired down:                             725770.
Pages occupied by compressor:                 732822.
==linux
==df
Filesystem   1024-blocks       Used Available Capacity  iused      ifree %iused  Mounted on
/dev/disk3s5  1948404040 1789869024 109552504    95% 11795201 1095525040    1%   /System/Volumes/Data
==ps
2097152 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
1048576 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)
1572864 /opt/homebrew/bin/node
524288 /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder
`

describe('시스템 상태', () => {
  test('macOS 출력에서 메모리·압력·스왑·디스크·앱별 메모리를 읽는다', () => {
    const s = parseSysStat(SYS_MAC, 1)!
    expect(s.memTotal).toBe(32 * 1024 ** 3)
    expect(s.memUsed).toBe((290740 + 725770 + 732822) * 16384)
    expect(s.pressure).toBe(2)
    expect(Math.round(s.swapUsed / 1024 ** 2)).toBe(21987)
    expect(s.diskFree).toBe(109552504 * 1024)
    expect(s.top[0]).toEqual({ name: 'Google Chrome', bytes: 3 * 1024 ** 3 })
    expect(s.top.map(p => p.name)).toEqual(['Google Chrome', 'node', 'Finder'])
  })

  test('Linux /proc/meminfo도 읽는다', () => {
    const s = parseSysStat(`==mem\n==vm\n==linux\nMemTotal:       16000000 kB\nMemAvailable:    1000000 kB\nSwapTotal:       2000000 kB\nSwapFree:        1500000 kB\n==df\n/dev/sda1 100000000 90000000 10000000 90% /\n==ps\n`, 1)!
    expect(s.memUsed).toBe(15000000 * 1024)
    expect(s.pressure).toBe(2)
    expect(s.swapUsed).toBe(500000 * 1024)
  })

  test('보드 맨 위에 시스템 줄이 뜨고 z로 메모리 많이 쓰는 앱을 펼친다', async ($, on) => {
    fakeWorld(on)
    const clock = mock.clock(on)
    await $.command.run(typed('ide', ''))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: props(160) })
    await clock.advance(1_000)
    const sys = (await ui.findAll({ type: 'Text' })).filter(t => /메모리|스왑|디스크/.test(t.text))
    expect(sys.find(t => t.text.includes('메모리'))?.text).toContain('26.7GB/32.0GB · 압력 경고')
    expect(sys.find(t => t.text.includes('메모리'))?.props.color).toBe('warning')
    expect(sys.find(t => t.text.includes('스왑'))?.props.color).toBe('error')
    expect(sys.find(t => t.text.includes('디스크'))?.text).toContain('남은 104GB')
    await ui.press({ key: 'sys-procs' })
    expect(textOf(await ui.findAll({ type: 'Text' }))).toContain('Google Chrome 3.0GB · node 1.5GB · Finder 0.5GB')
    await ui.unmount()
  })
})

// 2026-10-08 실제 응답에서 뽑은 모양
const CLAUDE_USAGE = { five_hour: { utilization: 24.0, resets_at: '2026-10-08T15:00:00Z' }, seven_day: { utilization: 20.0, resets_at: '2026-10-13T14:00:00Z' }, limits: [{ kind: 'weekly_scoped', percent: 2, resets_at: '2026-10-13T14:00:00Z', scope: { model: { display_name: 'Fable' } } }, { kind: 'five_hour' }] }
const CODEX_OUT = '{"primary":{"usedPercent":27,"windowDurationMins":10080,"resetsAt":1791948528},"secondary":{"usedPercent":81,"windowDurationMins":300,"resetsAt":1791900000}}'
const AGY_OUT = 'Gemini Models\tWeekly Limit Remaining\t94%\t2026-10-14T03:39:45Z\nGemini Models\tFive Hour Limit Remaining\t97%\t2026-10-08T17:01:49Z\nClaude and GPT models\tWeekly Limit Remaining\t100%\t2026-10-15T14:04:10Z\nClaude and GPT models\tFive Hour Limit Remaining\t100%\t2026-10-08T19:04:10Z'

describe('사용 한도 띠', () => {
  test('Claude·Codex·Antigravity 응답을 쓴 비율로 읽는다', () => {
    expect(parseClaudeUsage(CLAUDE_USAGE)).toEqual([
      { label: '5시간', pct: 24, resetsAt: Date.parse('2026-10-08T15:00:00Z') },
      { label: '주간', pct: 20, resetsAt: Date.parse('2026-10-13T14:00:00Z') },
      { label: 'Fable', pct: 2, resetsAt: Date.parse('2026-10-13T14:00:00Z') },
    ])
    expect(parseCodexLimits(CODEX_OUT).map(w => [w.label, w.pct])).toEqual([['5시간', 81], ['주간', 27]])
    expect(parseCodexLimits('{"error":"no codex"}')).toEqual([])
    const agy = parseAgyUsage(AGY_OUT)
    expect(agy.map(g => [g.group, g.windows.map(w => `${w.label} ${w.pct}`)])).toEqual([['Gemini', ['5시간 3', '주간 6']], ['Claude·GPT', ['5시간 0', '주간 0']]])
    expect(untilReset(Date.now() + 44 * 60_000 + 10_000)).toBe('44분 후')
    expect(untilReset(Date.now() + (5 * 1440 + 60) * 60_000 + 10_000)).toBe('5일 1시간 후')
  })

  test('입력창 위에 출처마다 한 줄, 많이 쓴 창은 색으로', async ($, on) => {
    const world = fakeWorld(on)
    const clock = mock.clock(on)
    on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 1_000_000, percent: 31 } } }) as never)
    on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
    on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(CLAUDE_USAGE) } }) as never)
    world.extraRuns = (argv: string[]) => (String(argv[1]).endsWith('codex-limits.mjs') ? CODEX_OUT : String(argv[1]).endsWith('agy-usage.sh') ? AGY_OUT : undefined)
    await $.command.run(typed('limits', 'rows'))
    const band = await $.ui.mount({ ...BAND, surface: 'terminal', props: bandProps })
    await clock.advance(1_000)
    const texts = await band.findAll({ type: 'Text' })
    const all = textOf(texts)
    expect(all).toContain('Claude')
    expect(all).toMatch(/5시간 ██▍?░+\s+24%/)
    expect(all).toContain('Fable')
    expect(all).toMatch(/컨텍스트 ███░+\s+31%/)
    expect(all).toContain('Codex')
    expect(texts.find(t => t.text.startsWith('5시간') && t.text.includes('81%'))?.props.color).toBe('warning')
    expect(all).toContain('Antigravity')
    // agy 상태줄이 읽게 Claude·Codex 한도를 파일로 남긴다
    const shared = JSON.parse([...world.written].find(([k]) => k.endsWith('/ide-mod/limits.json'))?.[1] ?? '{}')
    expect(shared.claude[0]).toMatchObject({ label: '5시간', pct: 24 })
    expect(shared.codex.length).toBe(2)
    expect(all).toContain('Gemini 5시간')
    // 기본: 모든 출처를 한 줄에, 게이지는 도트(Raster)
    await $.command.run(typed('limits', 'line'))
    await clock.advance(100)
    const line = textOf(await band.findAll({ type: 'Text' }))
    expect(line).toContain('Codex')
    expect(line).toContain('Gemini')
    expect(line).toMatch(/81% \d+일/)
    expect((await band.findAll({ type: 'Raster' })).length).toBeGreaterThan(0)
    await band.unmount()
  })
})

describe('이 세션 줄', () => {
  test('캐시 적중·속도 계산', () => {
    expect(cacheHitOf({ input_tokens: 10, cache_read_input_tokens: 950, cache_creation_input_tokens: 40 })).toBe(95)
    expect(cacheHitOf({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })).toBeUndefined()
    expect(tokPerSecOf(400, 1000, 6000)).toBe(80)
    expect(tokPerSecOf(5, 1000, 6000)).toBeUndefined()
    expect(shortTokens(412_345)).toBe('412k')
    expect(shortTokens(1_000_000)).toBe('1M')
  })

  test('메인 응답이 끝나면 띠 맨 위에 컨텍스트·캐시 적중·tok/s가 뜬다', async ($, on) => {
    fakeWorld(on)
    const clock = mock.clock(on)
    on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 1_000_000, tokens: 412_000, percent: 41 } } }) as never)
    on('session.authorize', () => ({ value: null }) as never)
    on('turn.step', async function* () {
      yield { kind: 'text', index: 0, text: '안녕', ref: 1 } as never
      await clock.advance(5_000)
      yield { kind: 'stop', stopReason: 'end_turn', usage: { model: 'claude-opus-5-5', input_tokens: 20, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 11_980, output_tokens: 400 }, ref: 2 } as never
      return { turnId: 't1', index: 0, answer: '안녕', toolUses: [], stopReason: 'end_turn', usage: null }
    })
    await $.command.run(typed('limits', 'rows'))
    const chunks: unknown[] = []
    for await (const c of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) chunks.push(c)
    expect(chunks.length).toBe(2)
    await clock.advance(10)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal', props: bandProps })
    await clock.advance(1_000)
    const texts = await band.findAll({ type: 'Text' })
    const all = textOf(texts)
    expect(all).toContain('이 세션')
    expect(all).toMatch(/컨텍스트 ████░+\s+41% 412k\/1M/)
    expect(all).toContain('캐시 적중 97%')
    expect(all).toContain('속도 80 tok/s')
    expect(texts.find(t => t.text.startsWith('캐시 적중'))?.props.color).toBe('success')
    await band.unmount()
  })
})

describe('도트 게이지', () => {
  test('점자 칸을 왼쪽부터 채우고, 빈 칸은 바닥 점', () => {
    const chars = (pct: number, kind: GaugeKind = 'use') => String.fromCodePoint(...dotGauge(pct, kind).map(c => c[0]))
    expect(chars(0)).toBe('⣀⣀⣀⣀')
    expect(chars(50)).toBe('⣿⣿⣀⣀')
    expect(chars(63)).toBe('⣿⣿⡇⣀')
    expect(chars(100)).toBe('⣿⣿⣿⣿')
    // 쓴 비율은 칸마다 초록→빨강, 캐시 적중은 값에 따라 한 색
    const use = dotGauge(100, 'use').map(c => c[1])
    expect(use[0]).not.toBe(use[3])
    expect(new Set(dotGauge(100, 'good').map(c => c[1])).size).toBe(1)
    // 좁으면 오른쪽 묶음부터 게이지를 뺀다
    const groups = lineGroups({ claude: [{ label: '5시간', pct: 3 }, { label: '주간', pct: 95 }], codex: [{ label: '주간', pct: 78 }], agy: [{ group: 'Gemini', windows: [{ label: '5시간', pct: 5 }] }], at: {}, errors: {} }, { readTokens: 0, inputTokens: 0, context: 4, cacheHit: 76, tokPerSec: 114 })
    expect(fitLine(groups, 300).flat().every(Boolean)).toBe(true)
    const narrow = fitLine(groups, 100)
    expect(narrow[0].every(Boolean)).toBe(true)
    expect(narrow.at(-1)?.[0]).toBe(false)
    expect(normLayout('compact')).toBe('line')
    expect(normLayout('full')).toBe('rows')
  })
})

describe('세션 시작 때 열기', () => {
  test('/ide auto off|on으로 자동 열기를 바꾸고 저장한다', async ($, on) => {
    const world = fakeWorld(on)
    expect(JSON.stringify(await $.command.run(typed('ide', 'auto')))).toContain('자동 열기: 켜짐')
    expect(JSON.stringify(await $.command.run(typed('ide', 'auto off')))).toContain('자동 열기: 꺼짐')
    expect(world.store.get('autoOpen')).toBe(false)
    expect(JSON.stringify(await $.command.run(typed('ide', 'auto on')))).toContain('자동 열기: 켜짐')
  })
})

describe('데스크톱 앱', () => {
  test('isInteractive가 false로 와도(데스크톱·SDK) 보드가 그려지면 요약 타이머가 돈다', async ($, on) => {
    fakeWorld(on)
    const clock = mock.clock(on)
    const asked: string[] = []
    on('model.complete', ($, e) => {
      asked.push(String((e as unknown as { prompt: string }).prompt))
      return { value: { isAnswered: true, text: '로그인 코드를 읽는 중' } } as never
    })
    // 데스크톱 앱은 session.start에 isInteractive: false를 준다 → 그때는 타이머를 걸지 않고, 보드를 처음 그릴 때 건다
    await ask($, '로그인 버그 고쳐줘', 't1')
    await $.tool.call({ tool: 'Read', file_path: '/work/src/app.ts' } as never)
    await clock.advance(25_000)
    expect(asked).toEqual([])
    await $.command.run(typed('ide', ''))
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: props(140) })
    await clock.advance(25_000)
    expect(asked.length).toBe(1)
    await ui.unmount()
  })
})

describe('지난 세션 요청', () => {
  test('같은 폴더에서 연 지난 세션의 요청이 요청 기록에 함께 나온다 (다른 폴더 것은 빼고)', async ($, on) => {
    const world = fakeWorld(on)
    const clock = mock.clock(on)
    world.store.set('requests:old-session-1', { updatedAt: 1000, root: ROOT, items: [{ n: 1, text: '어제 보낸 요청', at: 1000, status: 'done', answer: '' }] })
    world.store.set('requests:other-folder', { updatedAt: 2000, root: '/elsewhere', items: [{ n: 1, text: '다른 폴더 요청', at: 2000, status: 'done', answer: '' }] })
    await ask($, '오늘 요청', 't1')
    await $.command.run(typed('ide', ''))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: props(140) })
    await ui.press({ key: 'left-mode' })
    await clock.advance(10)
    const text = textOf(await ui.findAll({ type: 'Text' }))
    expect(text).toContain('어제 보낸 요청')
    expect(text).toContain('오늘 요청')
    expect(text).toContain('지난 세션 old-sess')
    expect(text).not.toContain('다른 폴더 요청')
    expect((world.store.get('requests:test-session') as { root?: string }).root).toBe(ROOT)
    await ui.unmount()
  })
})

describe('agy 프롬프트', () => {
  test('agy 입력 기록에서 이 폴더 프롬프트만, 슬래시·셸 명령과 연달아 다시 보낸 글은 빼고', () => {
    const lines = [
      { display: '그림 그려줘', timestamp: '1000', workspace: '/work', conversationId: 'abcdef123456' },
      { display: '그림 그려줘', timestamp: '2000', workspace: '/work', conversationId: 'abcdef123456' },
      { display: '/model', timestamp: '3000', workspace: '/work', conversationId: 'abcdef123456', type: 'slash_command' },
      { display: 'ls', timestamp: '4000', workspace: '/work', conversationId: 'abcdef123456', type: 'shell' },
      { display: '다른 폴더', timestamp: '5000', workspace: '/elsewhere', conversationId: 'x' },
    ].map(r => JSON.stringify(r)).join('\n')
    const items = parseAgyHistory(lines, '/work')
    expect(items.map(i => [i.text, i.from])).toEqual([['그림 그려줘', 'agy abcdef12']])
  })
})

describe('요청 기록 거르기', () => {
  test('데스크톱이 앞에 붙이는 system-reminder 블록은 걷어 내고 사람이 쓴 글만 남긴다', () => {
    const typed = '<system-reminder>\nThe user started this session without choosing a project folder.\n</system-reminder>\n로그인 버그 고쳐줘'
    expect(personText(typed)).toBe('로그인 버그 고쳐줘')
    expect(isMachineText(typed)).toBe(false)
    expect(isMachineText('<system-reminder>only a notice</system-reminder>')).toBe(true)
    expect(isMachineText('<task-notification>done</task-notification>')).toBe(true)
  })

  test('작업 알림으로 시작한 턴은 요청으로 적지 않고 메인 작업 줄도 그대로 둔다', async ($, on) => {
    const world = fakeWorld(on)
    await ask($, '로그인 버그 고쳐줘', 't1')
    await $.turn.start({ text: '<task-notification>Agent "Explore" finished</task-notification>', turnId: 't2' })
    await $.command.run(typed('ide', ''))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: props(140) })
    await ui.press({ key: 'left-mode' })
    const text = textOf(await ui.findAll({ type: 'Text' }))
    expect(text).toContain('이번 세션 요청 1개 전부')
    expect(text).not.toContain('task-notification')
    expect(text).toContain('로그인 버그 고쳐줘')
    expect(JSON.stringify(world.saved)).not.toContain('task-notification')
    await ui.unmount()
  })
})

describe('강의 모드·문체 게이트', () => {
  test('도구 호출을 쉬운 한국어 자막으로', () => {
    expect(captionFor('Read', { file_path: '/a/b/login.ts' })).toBe('파일을 읽고 있어요 · login.ts')
    expect(captionFor('Bash', { command: 'npm test', description: '테스트 실행' })).toBe('터미널에서: 테스트 실행')
    expect(captionFor('Grep', { pattern: 'login' })).toBe("코드에서 찾는 중 · 'login'")
    expect(captionFor('mcp__stitch__stitch_get', {})).toBe('stitch 도구를 써요 · stitch_get')
  })

  test('문체 게이트가 noslop 기준으로 판정한다', () => {
    const g = styleGate(SLOP, '/work/draft.md')
    expect(g.verdict).toBe('stop')
    expect(g.violations).toBe(3)
    expect(g.examples[0]).toContain('대조 구문')
    expect(styleGate('평범한 문장입니다. 오늘은 회의를 했습니다.', 'a.md').verdict).toBe('pass')
    // 코드 펜스 안은 세지 않는다
    expect(styleGate('```\n혁신적 획기적 압도적\n```', 'a.md').violations).toBe(0)
  })

  test('/lecture를 켜면 입력창 위에 자막이 뜨고, 원고를 쓰면 문체 게이트가 뜬다', async ($, on) => {
    fakeWorld(on)
    await $.command.run(typed('lecture', 'on'))
    await $.tool.call({ tool: 'Read', file_path: '/work/src/app.ts' } as never)
    await $.tool.call({ tool: 'Write', file_path: '/work/draft.md', content: SLOP } as never)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface, props: bandProps })
      const text = textOf(await ui.findAll({ type: 'Text' }))
      expect(text).toContain('새 파일을 쓰고 있어요 · draft.md')
      expect(text).toContain('방금: 파일을 읽고 있어요 · app.ts')
      expect(text).toContain('문체 게이트 · draft.md · 중단')
      await ui.press({ key: 'gate-open' })
      expect(textOf(await ui.findAll({ type: 'Text' }))).toContain('대조 구문')
      await ui.press({ key: 'gate-open' })
      await ui.unmount()
    }
    const closing = await $.ui.mount({ ...BAND, surface: 'terminal', props: bandProps })
    await closing.press({ key: 'gate-close' })
    expect(textOf(await closing.findAll({ type: 'Text' }))).not.toContain('문체 게이트')
    await closing.unmount()
    await $.command.run(typed('lecture', 'off'))
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: bandProps })
    expect(textOf(await ui.findAll({ type: 'Text' }))).not.toContain('▶')
    await ui.unmount()
  })
})
