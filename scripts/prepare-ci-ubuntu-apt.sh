#!/usr/bin/env bash
set -euo pipefail

apt_dir="${1:?pass the Ubuntu APT configuration directory}"
# Hosted runner images can point at an Azure archive hostname that fails DNS.
find "$apt_dir" -maxdepth 2 -type f \( -name '*.list' -o -name '*.sources' \) \
  -exec sed -i -E 's@https?://([a-z]{2}\.|azure\.)?archive\.ubuntu\.com/ubuntu@https://archive.ubuntu.com/ubuntu@g; s@http://security\.ubuntu\.com/ubuntu@https://security.ubuntu.com/ubuntu@g' {} +
