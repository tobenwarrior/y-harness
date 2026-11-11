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

pnpm --filter "$package" exec playwright install "$@"
if ! probe_browsers "$@"; then
  sudo bash scripts/prepare-ci-ubuntu-apt.sh /etc/apt
  pnpm --filter "$package" exec playwright install-deps "$@"
  probe_browsers "$@"
fi
