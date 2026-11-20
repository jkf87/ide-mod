---
name: herdr-panes
description: 허더 탭의 세션을 한 번에 조회하고, 끝난 세션을 사용자 확인 뒤 닫는다. "허더 세션 정리", "끝난 패인 닫아", "탭에 뭐 떠 있어", "세션들 뭐 하는지 봐 줘", "herdr panes" 요청에 사용. 허더(herdr) 안에서 돌 때만 쓴다.
---

# 허더 세션 조회·닫기 (ide-mod)

허더 탭에 떠 있는 Claude Code·Codex·agy·셸 패인을 한 번에 보고, 사용자가 닫으라고 한 패인만 닫는다.
스크립트는 ide-mod 플러그인의 `bin/herdr-panes.mjs` 하나다 (사람용 IDE 창 `/panes`도 같은 스크립트를 쓴다).

## 스크립트 위치

```bash
HP="${CLAUDE_PLUGIN_ROOT}/bin/herdr-panes.mjs"
[ -f "$HP" ] || HP="$(ls ~/.claude/plugins/cache/*/ide-mod/*/bin/herdr-panes.mjs 2>/dev/null | tail -1)"
[ -f "$HP" ] || HP="$HOME/ide-mod/bin/herdr-panes.mjs"
```

허더 밖(`HERDR_PANE_ID`가 없음)이면 "허더 안에서만 써요"라고 알리고 멈춘다.

## 절차

1. **조회**: `node "$HP" list` (지금 탭). 사용자가 전체를 원하면 `--all`, 특정 탭이면 `--tab <tab_id>`. 표로 정리하려면 `--json`.
   - 패인마다 pane_id · 이름 · agent · 상태(working 일하는 중 / done 끝남 / idle 쉼) · 나(← 나) · 마지막 요청 · 마지막 답 한 줄.
   - Claude 패인은 대화 기록 끝 256KB에서, 그 밖은 화면 마지막 두 줄에서 읽는다. 오래 일한 세션은 요청 칸이 빌 수 있다.
2. **보고**: 사용자에게 표로 알린다 — 패인마다 무엇을 했고(요청), 어떻게 끝났는지(답), 지금 상태. 끝난 것(done·idle)과 일하는 중인 것을 나눠 보여 주고, 닫아도 될 후보를 제안만 한다.
3. **닫기**: **사용자가 닫으라고 한 패인만** `node "$HP" close <pane_id…>`.
   - 묻지 않고 닫지 않는다. "끝난 거 다 닫아"처럼 범위로 말하면, 닫을 목록을 한 번 보여 주고 확인을 받은 뒤 닫는다.
   - 이 세션(← 나)은 스크립트가 거절한다. 일하는 중(working)인 패인도 거절한다 — 사용자가 그 패인을 꼭 닫으라고 다시 말할 때만 `--force`.
   - 스크립트는 닫기 직전에 목록을 다시 받아 상태를 확인하고, 패인마다 한 줄(닫음 / 거절 / 없음 / 실패)을 낸다. 그 줄을 그대로 보고한다.

## 하지 않는 것

- 다른 패인에 글자·키를 보내지 않는다 (`herdr pane send-text`·`send-keys`·`run` 금지).
- 닫은 패인은 되살릴 수 없다. 사용자가 고르지 않은 패인을 "정리"하지 않는다.
