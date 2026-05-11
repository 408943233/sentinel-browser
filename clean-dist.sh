#!/bin/bash
# 清理 dist 目录，只保留必要的文件

cd "$(dirname "$0")"

# 删除临时构建目录
rm -rf dist/mac
rm -rf dist/mac-arm64
rm -rf dist/win-unpacked
rm -rf dist/win-ia32-unpacked
rm -rf dist/.icon-ico

# 删除 blockmap 文件（除非需要自动更新）
rm -f dist/*.blockmap

# 删除调试文件
rm -f dist/builder-debug.yml
rm -f dist/builder-effective-config.yaml

echo "✅ dist 目录清理完成"
ls -la dist/
