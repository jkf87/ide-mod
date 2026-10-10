#!/bin/sh
# Antigravity 사용 한도: `agy -p=/usage` 출력(탭으로 나눈 줄들)을 찍는다.
#   sh bin/agy-usage.sh [최대 나이(초), 기본 900]
#
# agy는 부를 때마다 로그인 토큰을 갱신하는데, 갱신(oauth2.googleapis.com)이 DNS 문제로 실패하면
# print 모드가 대화형 로그인으로 넘어가 인증 코드를 물어본다. 그래서
#   - 결과를 ~/.cache/ide-mod에 두고 모든 세션이 나눠 읽는다 (세션마다 agy를 띄우지 않는다)
#   - 한 번에 하나만 agy를 띄운다 (잠금 폴더)
#   - 갱신 주소의 DNS가 안 풀리면 agy를 띄우지 않는다
#   - 한 번 실패하면 30분 동안 다시 띄우지 않는다
max_age=${1:-900}
dir="${XDG_CACHE_HOME:-$HOME/.cache}/ide-mod"
cache="$dir/agy-usage.tsv"
fail="$dir/agy-usage.failed"
lock="$dir/agy-usage.lock"
mkdir -p "$dir" 2>/dev/null || exit 1

now=$(date +%s)
mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0; }
age() { [ -e "$1" ] && echo $((now - $(mtime "$1"))) || echo 999999; }
stale() { [ -s "$cache" ] && cat "$cache" && exit 0; exit "${1:-75}"; }

[ "$(age "$cache")" -lt "$max_age" ] && stale
[ "$(age "$fail")" -lt 1800 ] && stale

# 다른 세션이 받는 중이면 기다리지 않고 있던 값을 쓴다 (2분 넘은 잠금은 죽은 것으로 본다)
if ! mkdir "$lock" 2>/dev/null; then
  [ "$(age "$lock")" -lt 120 ] && stale
  rmdir "$lock" 2>/dev/null
  mkdir "$lock" 2>/dev/null || stale
fi
trap 'rmdir "$lock" 2>/dev/null' EXIT

resolves() {
  if [ -x /usr/bin/dscacheutil ]; then /usr/bin/dscacheutil -q host -a name "$1" 2>/dev/null | grep -q ip_address
  elif command -v getent >/dev/null 2>&1; then getent hosts "$1" >/dev/null 2>&1
  else return 0
  fi
}
resolves oauth2.googleapis.com || stale

agy=
for p in "$HOME/.local/bin/agy" /opt/homebrew/bin/agy /usr/local/bin/agy; do [ -x "$p" ] && agy=$p && break; done
[ -z "$agy" ] && agy=$(command -v agy 2>/dev/null)
[ -z "$agy" ] && exit 127

tmp="$cache.$$"
# 대화형 로그인으로 넘어가지 않게 제어 터미널을 떼고 띄운다
# (agy는 로그인이 풀렸는데 제어 터미널이 없으면 "cannot complete interactive login"으로 포기한다)
detach=
command -v perl >/dev/null 2>&1 && detach="perl -MPOSIX=setsid -e setsid();exec(@ARGV)"
if $detach "$agy" --print-timeout 8s -p=/usage </dev/null >"$tmp" 2>/dev/null && grep -q "	" "$tmp"; then
  mv "$tmp" "$cache"
  rm -f "$fail"
  cat "$cache"
  exit 0
fi
rm -f "$tmp"
: >"$fail"
stale 1
