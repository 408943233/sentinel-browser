#!/bin/bash

# Sentinel Log Server 启动脚本

echo "🚀 启动 Sentinel Log Server..."

# 检查 Node.js 是否安装
if ! command -v node &> /dev/null; then
    echo "❌ 错误: Node.js 未安装"
    echo "请先安装 Node.js: https://nodejs.org/"
    exit 1
fi

# 检查端口是否被占用
PORT=80
if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "⚠️  警告: 端口 $PORT 已被占用"
    echo "正在尝试关闭占用端口的进程..."
    sudo kill -9 $(lsof -Pi :$PORT -sTCP:LISTEN -t) 2>/dev/null || true
    sleep 1
fi

# 创建必要的目录
mkdir -p logs uploads

# 启动服务器
echo "📁 日志目录: $(pwd)/logs"
echo "📁 上传目录: $(pwd)/uploads"
echo "🌐 管理界面: http://localhost:$PORT/"
echo ""
echo "正在启动服务器..."
echo ""

# 使用 sudo 因为端口 80 需要管理员权限
sudo node server.js
