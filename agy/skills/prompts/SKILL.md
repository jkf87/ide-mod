---
name: prompts
description: Shows the prompts the user sent in this folder to Claude Code, Codex and agy, oldest first. Use only when the user types /prompts or asks to see their own prompt history ("내가 보낸 프롬프트", "프롬프트 기록", "요청 기록").
---

# /prompts — 내가 보낸 프롬프트 보기

1. Run this one command with `run_command` in the current workspace folder. Pass through whatever the user typed after `/prompts` as arguments (a number such as `100` for how many, `--all` for every folder):

   ```
   node ~/ide-mod/bin/prompts.mjs <arguments>
   ```

2. Reply with the command's output exactly as printed, inside one code block. Do not summarize, translate, reorder or comment on it. Add nothing before or after the code block.

If the command fails because the file is missing, reply with one line: `ide-mod가 ~/ide-mod에 없어요. 셸에서 !node <ide-mod 폴더>/bin/prompts.mjs 로 실행하세요.`
