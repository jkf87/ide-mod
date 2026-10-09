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

/** 이번 세션에 사람이 보낸 요청 하나 */
export type SysStat = {
  at: number
  memTotal: number
  memUsed: number
  /** 1 정상, 2 경고, 4 위험 (macOS 메모리 압력) */
  pressure: number
  swapUsed: number
  diskTotal: number
  diskFree: number
  /** 메모리를 많이 쓰는 앱 (이름별로 합침) */
  top: { name: string; bytes: number }[]
}

/** 사용 한도 창 하나: 쓴 비율(0~100)과 리셋 시각(ms) */
export type LimitWindow = { label: string; pct: number; resetsAt?: number }

export type LimitsSnapshot = {
  /** Claude: 5시간·주간·모델별 주간, 컨텍스트 사용률 */
  claude: LimitWindow[]
  context?: number
  codex: LimitWindow[]
  /** Antigravity: Gemini·Claude·GPT 각각 5시간·주간 */
  agy: { group: string; windows: LimitWindow[] }[]
  /** 각 출처를 마지막으로 받은 시각, 받지 못한 이유 */
  at: { claude?: number; codex?: number; agy?: number }
  errors: { claude?: string; codex?: string; agy?: string }
}

/** 이 세션의 메인 에이전트가 받은 마지막 응답: 컨텍스트, 프롬프트 캐시 적중, 생성 속도 */
export type SessionPerf = {
  /** 컨텍스트 창 사용률(0~100)과 토큰 수, 창 크기 */
  context?: number
  contextTokens?: number
  window?: number
  /** 마지막 응답의 입력 중 캐시에서 읽은 비율(0~100) */
  cacheHit?: number
  /** 이 세션 메인 응답을 모두 더한 캐시 적중률(0~100)과 그 재료 */
  sessionHit?: number
  readTokens: number
  inputTokens: number
  /** 마지막 응답의 출력 속도(토큰/초)와 첫 조각까지 걸린 시간 */
  tokPerSec?: number
  firstMs?: number
  outputTokens?: number
  at?: number
}

export type PeerRow = {
  name: string
  ref: string
  status: string
  detail: string
}

export type RequestItem = {
  n: number
  text: string
  at: number
  status: 'running' | 'done' | 'stopped'
  /** 이 요청을 처리한 턴 */
  turnId?: string
  /** Claude 답의 첫 줄 */
  answer: string
  endedAt?: number
}

export type GateCheck = { label: string; count: number; limit: number; isHard: boolean }

/** 한국어 문체 게이트 결과 (noslop-ko grep 게이트와 같은 기준) */
export type GateResult = {
  path: string
  verdict: 'pass' | 'warn' | 'stop'
  violations: number
  checks: GateCheck[]
  examples: string[]
  sentences: number
  longRuns: number
  at: number
}

/** 강의 모드 자막 */
export type Caption = { text: string; prev: string; step: number; startedAt: number }

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

      // ── 요청 기록 ──
      /** 왼쪽 칸: 파일 트리 또는 요청 기록 */
      leftMode: 'files' | 'requests' | 'handoff'
      requests: RequestItem[]
      /** 오른쪽에 펼친 요청 번호; 0이면 가장 최근 */
      selectedRequest: number
      requestOffset: number
      /** 오른쪽: all 이번 세션 요청 전부를 이어서, one 고른 요청 하나 */
      requestView: 'all' | 'one'

      // ── 시스템 상태 ──
      /** 메모리·스왑·디스크 (보드가 떠 있을 때 10초마다) */
      sys: SysStat | null
      /** 메모리를 많이 쓰는 앱 줄을 펼쳤는지 */
      showProcs: boolean

      // ── 사용 한도 띠 (입력창 위) ──
      limits: LimitsSnapshot
      /** full: 출처마다 한 줄, compact: 한 줄, off: 숨김 */
      limitsLayout: 'full' | 'compact' | 'off'
      perf: SessionPerf

      // ── 자동으로 열기 ──
      /** 이 세션에서 IDE 창을 저절로 한 번 열었는지 (/reload-plugins 뒤에 다시 열지 않게) */
      autoOpened: boolean

      // ── 핸드오프 ──
      /** ListAgents로 받은 다른 세션들 (핸드오프 화면을 열 때·r로 새로 받음) */
      peers: PeerRow[]
      /** 이 세션이 다른 세션에 불리는 이름 */
      selfName: string
      /** 마지막으로 보낸 핸드오프 결과 */
      handoffSent: { to: string; at: number; ok: boolean; reason?: string } | null

      // ── HWP 뷰어 ──
      /** doc: 쪽을 글자 격자로(기본), image: rhwp가 그린 쪽 그림 */
      hwpView: 'doc' | 'image'
      hwpPages: Record<string, number>

      // ── 강의 모드·문체 게이트 ──
      isLecture: boolean
      caption: Caption
      gate: GateResult | null
      isGateOn: boolean
      isGateOpen: boolean
    }
  }
}
