#!/bin/bash
# Electron 启动脚本（带参数）

cd "$(dirname "$0")"

./node_modules/electron/Electron.app/Contents/MacOS/Electron \
  --no-sandbox \
  --disable-gpu \
  --disable-software-rasterizer \
  --disable-dev-shm-usage \
  --disable-setuid-sandbox \
  --disable-features=IsolateOrigins,site-per-process \
  --user-data-dir=/tmp/sentinel-browser-data \
  . "$@"
