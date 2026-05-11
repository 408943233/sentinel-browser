#!/bin/bash
# Sentinel Browser Server Entrypoint

set -e

echo "=================================="
echo "Starting Sentinel Browser Server"
echo "=================================="

# 启动XVFB虚拟显示
Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!
echo "✓ XVFB started (PID: $XVFB_PID)"

# 等待XVFB启动
sleep 2

# 设置显示环境
export DISPLAY=:99

# 创建必要的目录
mkdir -p /app/data/output/collections
mkdir -p /app/data/logs

# 检查ffmpeg
if [ -f /app/bin/ffmpeg ]; then
    chmod +x /app/bin/ffmpeg
    echo "✓ FFmpeg ready"
fi

echo ""
echo "=================================="
echo "Server Configuration:"
echo "  Data Directory: $SENTINEL_DATA_DIR"
echo "  Output Directory: $SENTINEL_OUTPUT_DIR"
echo "  Display: $DISPLAY"
echo "=================================="
echo ""

# 启动Sentinel Browser服务
cd /app
echo "Starting Sentinel Browser..."

# 使用node直接启动服务端API
exec node src/server/server.js
