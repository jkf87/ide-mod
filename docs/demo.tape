# ide-mod 데모 GIF (charmbracelet/vhs). 다른 플러그인·설정 없이 ide-mod만 올린 Claude Code로 녹화한다.
#   env -i HOME=$HOME USER=$USER PATH=$PATH TERM=xterm-256color LANG=ko_KR.UTF-8 vhs docs/demo.tape
# 데모 폴더(~/ide-mod-demo)는 미리 만들고 Claude Code에서 한 번 신뢰해 둔다.
Output docs/demo.gif

Set Shell zsh
Set FontSize 15
Set FontFamily "D2Coding"
Set Width 1600
Set Height 960
Set Padding 18
Set Framerate 12
Set TypingSpeed 45ms
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful

Hide
Type "cd ~/ide-mod-demo && clear && claude --setting-sources project --plugin-dir ~/ide-mod --strict-mcp-config"
Enter
Sleep 10s
Show

# 1. IDE 창: 에이전트 보드 + 파일 트리 + 탭
Type "/ide"
Sleep 600ms
Enter
Sleep 2.5s

# 2. 코드 파일 열기
Type "/open src/auth/login.ts"
Sleep 400ms
Enter
Sleep 3s

# 3. 한글(HWPX) 문서를 쪽 모양 그대로 (문서 보기: 표·제목·번호 상자)
Type "/open docs/업무계획.hwpx"
Sleep 400ms
Enter
Sleep 6s
# /open은 창에 포커스를 준다: 바로 n으로 다음 쪽
Type "n"
Sleep 3s
Type "n"
Sleep 6s
Escape
Sleep 1s

# 4. 서브에이전트에게 일을 맡기기 → 보드에 에이전트 트리 (맡긴 일은 초록, 지금 하는 일은 노랑)
Type "Explore 서브에이전트 하나로 src 폴더를 훑어보고 로그인 흐름을 세 줄로 요약해줘"
Sleep 800ms
Enter
Sleep 30s

# 5. 요청 기록: 내가 보낸 요청을 한눈에
Ctrl+X
Tab
Sleep 800ms
Type "q"
Sleep 4s
Escape
Sleep 2s
