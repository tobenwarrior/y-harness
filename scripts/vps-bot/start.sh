#!/usr/bin/env bash
set -euo pipefail

readonly display="${DISPLAY:-:99}"
readonly authority="${XAUTHORITY:-/tmp/yharness-xauthority}"
readonly home_dir="${HOME:-/tmp/yharness-home}"
mkdir -p "$home_dir"
chmod 0700 "$home_dir"
rm -f "$authority"
touch "$authority"
chmod 0600 "$authority"

# The display and its authority file live in this container's private /tmp;
# no host X11 socket or authority file is mounted.
readonly cookie="$(od -An -N16 -tx1 /dev/urandom | tr -d '[:space:]')"
xauth -f "$authority" add "$display" MIT-MAGIC-COOKIE-1 "$cookie"
Xvfb "$display" -screen 0 1280x800x24 -nolisten tcp -auth "$authority" >/tmp/yharness-xvfb.log 2>&1 &
readonly xvfb_pid=$!
openbox_pid=''
browser_pid=''

cleanup() {
  if [[ -n "$browser_pid" ]]; then
    kill "$browser_pid" 2>/dev/null || true
    wait "$browser_pid" 2>/dev/null || true
  fi
  if [[ -n "$openbox_pid" ]]; then kill "$openbox_pid" 2>/dev/null || true; fi
  kill "$xvfb_pid" 2>/dev/null || true
  if [[ -n "$openbox_pid" ]]; then wait "$openbox_pid" 2>/dev/null || true; fi
  wait "$xvfb_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' INT TERM

open_browser() {
  if [[ -n "$browser_pid" ]] && kill -0 "$browser_pid" 2>/dev/null; then
    xdotool search --onlyvisible --class firefox windowactivate >/dev/null 2>&1 || true
    return
  fi
  /usr/bin/firefox-esr --profile "$profile" about:blank >/tmp/yharness-firefox.log 2>&1 &
  browser_pid=$!
}

ready=0
for _attempt in $(seq 1 100); do
  if DISPLAY="$display" XAUTHORITY="$authority" xdotool getdisplaygeometry >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.05
done
if [[ "$ready" != 1 ]]; then
  echo 'Y Harness Bot desktop did not become ready.' >&2
  exit 1
fi

openbox >/tmp/yharness-openbox.log 2>&1 &
openbox_pid=$!
if ! kill -0 "$openbox_pid" 2>/dev/null; then
  echo 'Y Harness Bot window manager did not start.' >&2
  exit 1
fi

if [[ "${YH_VPS_BOT_BROWSER:-}" == 'firefox' ]]; then
  readonly profile='/var/lib/yharness-browser-profile'
  if [[ ! -d "$profile" || ! -w "$profile" ]]; then
    echo 'Y Harness Bot browser needs a writable profile volume.' >&2
    exit 1
  fi
  chmod 0700 "$profile"
  trap open_browser USR1
  open_browser
  for _attempt in $(seq 1 250); do
    if ! kill -0 "$browser_pid" 2>/dev/null; then
      echo 'Y Harness Bot browser could not start.' >&2
      exit 1
    fi
    if xdotool search --onlyvisible --class firefox >/dev/null 2>&1; then
      touch /tmp/yharness-browser-ready
      break
    fi
    sleep 0.1
  done
  if [[ ! -f /tmp/yharness-browser-ready ]]; then
    echo 'Y Harness Bot browser did not become ready.' >&2
    exit 1
  fi
fi

while kill -0 "$xvfb_pid" 2>/dev/null && kill -0 "$openbox_pid" 2>/dev/null; do
  sleep 1
done
exit 1
