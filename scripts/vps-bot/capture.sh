#!/bin/sh
set -eu
directory=$(mktemp -d /tmp/yharness-frame.XXXXXX)
trap 'rm -rf -- "$directory"' EXIT
scrot --pointer --quality 85 "$directory/frame.jpg"
cat "$directory/frame.jpg"
