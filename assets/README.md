# Sentinel Log Server

Sentinel Browser 日志接收服务，用于接收和存储客户端上传的日志文件。

## 功能特性

- ✅ 接收客户端日志上传
- ✅ 按日期自动组织日志文件
- ✅ 保存日志元数据
- ✅ Web 管理界面查看日志
- ✅ 支持日志下载
- ✅ 跨域支持 (CORS)
- ✅ 统计信息展示

## 快速开始

### 1. 安装依赖

```bash
# 确保已安装 Node.js (>= 14.0.0)
node --version

# 进入项目目录
cd log-server

# 安装依赖 (本服务无额外依赖，纯 Node.js 实现)
npm install
```

### 2. 启动服务

```bash
# 方式1: 使用启动脚本 (推荐)
./start.sh

# 方式2: 直接启动
sudo npm start

# 方式3: 使用 PM2 守护进程
npm run pm2:start
```

服务将在端口 **80** 启动。

### 3. 访问管理界面

打开浏览器访问: `http://42.193.126.52/`

## API 接口

### 上传日志

```http
POST /api/logs/upload
Content-Type: application/json

{
  "content": "日志内容...",
  "filename": "main.log",
  "size": 12345,
  "timestamp": 1234567890,
  "platform": "win32",
  "arch": "x64",
  "version": "1.0.0",
  "type": "task_logs",
  "taskId": "task_xxx",
  "taskName": "任务名称",
  "taskUrl": "https://example.com",
  "recordingDuration": 60000
}
```

**响应:**

```json
{
  "success": true,
  "message": "Log uploaded successfully",
  "id": "abc123",
  "savedAs": "task_xxx_win32_12-00-00_abc123.log"
}
```

### 获取日志列表

```http
GET /api/logs
```

**响应:**

```json
{
  "success": true,
  "count": 10,
  "logs": [...]
}
```

### 查看日志内容

```http
GET /logs/{id}
```

### 下载日志

```http
GET /download/{id}
```

## 目录结构

```
log-server/
├── server.js          # 主服务文件
├── package.json       # 项目配置
├── start.sh          # 启动脚本
├── README.md         # 本文件
├── logs/             # 服务器日志
└── uploads/          # 上传的日志文件
    ├── 2024-01-15/   # 按日期组织
    │   ├── task_xxx_win32_12-00-00_abc123.log
    │   └── task_xxx_win32_12-00-00_abc123.log.json
    └── index.json    # 日志索引
```

## 部署说明

### 使用 PM2 部署

```bash
# 安装 PM2
npm install -g pm2

# 启动服务
cd log-server
pm2 start server.js --name sentinel-log-server

# 查看状态
pm2 status

# 查看日志
pm2 logs sentinel-log-server

# 重启
pm2 restart sentinel-log-server

# 停止
pm2 stop sentinel-log-server

# 开机自启
pm2 startup
pm2 save
```

### 使用 systemd 部署

创建服务文件 `/etc/systemd/system/sentinel-log-server.service`:

```ini
[Unit]
Description=Sentinel Log Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/path/to/log-server
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

启动服务:

```bash
sudo systemctl daemon-reload
sudo systemctl enable sentinel-log-server
sudo systemctl start sentinel-log-server
sudo systemctl status sentinel-log-server
```

### 使用 Docker 部署

创建 `Dockerfile`:

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 80
CMD ["node", "server.js"]
```

构建并运行:

```bash
docker build -t sentinel-log-server .
docker run -d -p 80:80 -v $(pwd)/logs:/app/logs -v $(pwd)/uploads:/app/uploads --name log-server sentinel-log-server
```

## 配置说明

如需修改端口，编辑 `server.js`:

```javascript
const PORT = 80;  // 修改为其他端口
```

## 注意事项

1. **端口权限**: 使用 80 端口需要 root 权限
2. **防火墙**: 确保防火墙允许 80 端口访问
3. **磁盘空间**: 定期清理旧日志文件
4. **备份**: 建议定期备份 `uploads` 目录

## 故障排查

### 端口被占用

```bash
# 查找占用 80 端口的进程
sudo lsof -i :80

# 结束进程
sudo kill -9 <PID>
```

### 查看服务日志

```bash
# 如果使用 PM2
pm2 logs sentinel-log-server

# 查看服务器日志
tail -f logs/server.log
```

## 更新日志

### v1.0.0
- 初始版本
- 支持日志上传和下载
- Web 管理界面
