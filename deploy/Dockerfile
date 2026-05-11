# Sentinel Browser Server Deployment
# 基于Electron + XVFB的无头浏览器服务端部署方案

FROM node:18-slim

# 安装系统依赖
RUN apt-get update && apt-get install -y \
    # Electron运行依赖
    libgtk-3-0 \
    libnotify4 \
    libnss3 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    libatspi2.0-0 \
    libuuid1 \
    libsecret-1-0 \
    # 视频录制依赖
    ffmpeg \
    # 中文字体支持
    fonts-wqy-zenhei \
    fonts-wqy-microhei \
    # XVFB虚拟显示
    xvfb \
    # 其他依赖
    libgconf-2-4 \
    libgbm-dev \
    libasound2 \
    libgtkextra-3.0 \
    libgconf2-4 \
    libnss3-tools \
    libx11-xcb-dev \
    libxss-dev \
    libappindicator3-1 \
    libindicator3-7 \
    # 清理
    && rm -rf /var/lib/apt/lists/*

# 设置工作目录
WORKDIR /app

# 复制package.json
COPY package.json ./

# 安装依赖
RUN npm install --production

# 复制应用代码
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY bin/ ./bin/

# 创建数据目录
RUN mkdir -p /app/data/output /app/data/collections /app/logs

# 设置环境变量
ENV NODE_ENV=production
ENV DISPLAY=:99
ENV ELECTRON_ENABLE_LOGGING=1
ENV SENTINEL_DATA_DIR=/app/data
ENV SENTINEL_OUTPUT_DIR=/app/data/output

# 暴露API端口
EXPOSE 3000

# 启动脚本
COPY deploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
