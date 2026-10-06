import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { blockStarts, describeCall, fit, shortModel } from '../hooks/register'

// ── 가짜 작업 폴더 (테스트 엔진은 상대 경로를 플러그인 폴더 기준으로 풀어서 절대 경로만 쓴다) ──
const ROOT = '/work'
const LONG = Array.from({ length: 100 }, (_, i) => `const line${i + 1} = ${i + 1}`).join('\n')
const FILES: Record<string, string> = {
  '/work/README.md': '# 제목\n\n본문 문단',
  '/work/src/app.ts': 'export const answer = 42\n',
  '/work/src/long.ts': LONG,
}
const DIRS: Record<string, string[]> = {
  '/work': ['src', 'link', 'README.md', '.DS_Store'],
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

type World = { opened: number; statuses: (string | undefined)[] }

function fakeWorld(on: On): World {
  const world: World = { opened: 0, statuses: [] }
  on('session.cwd', () => ({ value: ROOT }))
  on('env.get', () => ({ value: '/home/me' }))
  on('fs.stat', ($, e) => {
    const abs = norm(e.path)
    const target = real(e.path)
    const isLink = abs in LINKS
    if (target in DIRS) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 1, isLink, realPath: target } }
    const text = FILES[target]
    if (text === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file' as const, size: text.length, mtimeMs: 1, isLink, realPath: target } }
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
  on('tool.call', ($, e) => (String(e.tool) === 'Write' && (e as unknown as { content?: string }).content === 'DENY' ? { deny: 'no' } : ({ result: 'ok' } as never)))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return world
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
    // 보드(빈 상태 2행) + 구분선 1 + 툴바 1 + 탭 1 + 정보 1 을 뺀 나머지
    expect(shown).toBe(30 - 2 - 1 - 1 - 2)
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
    await $.turn.start({ text: '로그인 버그 고쳐줘', turnId: 't1' })
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
    await $.turn.start({ text: '작업', turnId: 't1' })
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
    await $.turn.start({ text: '작업', turnId: 't1' })
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
    await $.turn.start({ text: '작업', turnId: 't1' })
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
