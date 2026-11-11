#!/usr/bin/env bash
set -euo pipefail

apt_dir="${1:?pass the Ubuntu APT configuration directory}"
archive="${2:-https://archive.ubuntu.com/ubuntu}"
# Hosted runner images can point at an Azure archive hostname that fails DNS.
find "$apt_dir" -maxdepth 2 -type f \( -name '*.list' -o -name '*.sources' \) \
  -exec sed -i -E "s@https?://([a-z]{2}\.|azure\.)?archive\.ubuntu\.com/ubuntu@${archive}@g; s@https?://security\.ubuntu\.com/ubuntu@${archive}@g" {} +
