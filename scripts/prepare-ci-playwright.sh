#!/usr/bin/env bash
set -euo pipefail

package="${1:?pass the workspace package that owns Playwright}"
shift
(( $# > 0 )) || { echo 'pass at least one Playwright browser name' >&2; exit 1; }

probe_browsers() {
  pnpm --filter "$package" exec node --input-type=module - "$@" <<'JS'
import { chromium, webkit } from 'playwright'

for (const name of process.argv.slice(2)) {
  const browser = await { chromium, webkit }[name].launch()
  await browser.close()
}
JS
}

select_ubuntu_archive() {
  local archive
  source /etc/os-release
  for archive in https://archive.ubuntu.com/ubuntu https://mirrors.edge.kernel.org/ubuntu https://mirror.math.princeton.edu/pub/ubuntu; do
    if curl -fsIL --max-time 8 "$archive/dists/$VERSION_CODENAME/InRelease" >/dev/null \
      && curl -fsIL --max-time 8 "$archive/dists/$VERSION_CODENAME-security/InRelease" >/dev/null; then
      printf '%s\n' "$archive"
      return
    fi
  done
  echo 'No Ubuntu archive mirror was reachable for Playwright dependencies.' >&2
  return 1
}

pnpm --filter "$package" exec playwright install "$@"
if ! probe_browsers "$@"; then
  archive=$(select_ubuntu_archive)
  sudo bash scripts/prepare-ci-ubuntu-apt.sh /etc/apt "$archive"
  pnpm --filter "$package" exec playwright install-deps "$@"
  probe_browsers "$@"
fi
