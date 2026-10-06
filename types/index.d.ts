export type ViewMode = 'code' | 'rendered'

export type AgentPhase = 'running' | 'idle' | 'done' | 'failed'

export type AgentRow = {
  /** 'main' 또는 서브에이전트 id */
  id: string
  /** 이 에이전트를 띄운 에이전트; 메인은 없음 */
  parentId?: string
  /** 역할: 메인이면 'main', 아니면 서브에이전트 타입(+팀원 이름) */
  role: string
  /** 맡은 작업 한 줄 (Agent 호출의 description, 메인은 사용자 프롬프트) */
  task: string
  model: string
  effort?: string
  phase: AgentPhase
  isBackground: boolean
  isTeammate: boolean
  /** 지금 하고 있는 일: 마지막 도구 호출 */
  activity: string
  /** 최근 도구 호출 몇 개; 요약의 재료 */
  log: string[]
  toolCount: number
  /** 모델이 만든 한 줄 요약, 또는 끝난 에이전트의 답 첫 줄 */
  recap: string
  /** 마지막 요약 뒤로 일이 쌓였는지 */
  isRecapStale: boolean
  startedAt: number
  updatedAt: number
  endedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'ide-mod': {
      // ── 탐색기 ──
      /** 트리의 뿌리 폴더(절대 경로); 빈 문자열이면 작업 폴더 */
      root: string
      /** 펼친 폴더들(절대 경로) */
      expanded: string[]
      /** 탭으로 열어 둔 파일들, 연 순서대로 */
      tabs: string[]
      /** 지금 보이는 탭; 빈 문자열이면 없음 */
      active: string
      /** 트리 창이 보여주는 첫 줄 */
      treeOffset: number
      /** 파일마다 보던 첫 줄 */
      offsets: Record<string, number>
      /** 마크다운을 렌더링할지 원문 코드로 볼지 */
      mode: ViewMode
      /** 새로고침 때 올리는 값; 트리·파일을 다시 읽게 한다 */
      rev: number
      /** 이번 세션에 Claude가 고친 파일들 */
      touched: string[]
      /** 트리를 접었는지 (좁은 화면에서는 파일만 보기) */
      isTreeHidden: boolean

      // ── 에이전트 보드 ──
      agents: Record<string, AgentRow>
      /** 경과 시간을 다시 그리게 하는 시계 */
      tick: number
      isBoardFolded: boolean
      hideDone: boolean
      isRecapOn: boolean
    }
  }
}
