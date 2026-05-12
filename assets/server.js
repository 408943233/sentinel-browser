const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// 配置
const PORT = 80;
const LOGS_DIR = path.join(__dirname, 'logs');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// 确保目录存在
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// 简单的日志记录
function serverLog(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  console.log(logMessage.trim());
  
  // 写入服务器日志
  const serverLogPath = path.join(LOGS_DIR, 'server.log');
  fs.appendFileSync(serverLogPath, logMessage);
}

// 生成唯一ID
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// 保存上传的日志文件
function saveLogFile(data) {
  const timestamp = new Date();
  const dateStr = timestamp.toISOString().split('T')[0];
  const timeStr = timestamp.toTimeString().split(' ')[0].replace(/:/g, '-');
  
  // 按日期组织目录
  const dailyDir = path.join(UPLOADS_DIR, dateStr);
  if (!fs.existsSync(dailyDir)) {
    fs.mkdirSync(dailyDir, { recursive: true });
  }
  
  // 生成文件名
  const taskId = data.taskId || 'unknown';
  const platform = data.platform || 'unknown';
  const filename = `${taskId}_${platform}_${timeStr}_${generateId()}.log`;
  const filepath = path.join(dailyDir, filename);
  
  // 保存日志内容
  fs.writeFileSync(filepath, data.content);
  
  // 保存元数据
  const metadata = {
    id: generateId(),
    filename: data.filename,
    savedAs: filename,
    filepath: filepath,
    size: data.size,
    timestamp: data.timestamp,
    uploadTime: timestamp.toISOString(),
    platform: data.platform,
    arch: data.arch,
    version: data.version,
    type: data.type,
    taskId: data.taskId,
    taskName: data.taskName,
    taskUrl: data.taskUrl,
    recordingDuration: data.recordingDuration
  };
  
  const metadataPath = filepath + '.json';
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  
  // 更新索引
  updateIndex(metadata);
  
  return metadata;
}

// 更新索引文件
function updateIndex(metadata) {
  const indexPath = path.join(UPLOADS_DIR, 'index.json');
  let index = [];
  
  if (fs.existsSync(indexPath)) {
    try {
      index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    } catch (e) {
      serverLog('Error reading index: ' + e.message);
    }
  }
  
  index.unshift(metadata);
  
  // 只保留最近1000条记录
  if (index.length > 1000) {
    index = index.slice(0, 1000);
  }
  
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
}

// 获取所有日志列表
function getLogsList() {
  const indexPath = path.join(UPLOADS_DIR, 'index.json');
  if (fs.existsSync(indexPath)) {
    try {
      return JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    } catch (e) {
      return [];
    }
  }
  return [];
}

// 生成管理界面HTML
function generateAdminHTML() {
  const logs = getLogsList();
  
  let tableRows = logs.map(log => `
    <tr>
      <td>${new Date(log.uploadTime).toLocaleString()}</td>
      <td>${log.taskName || 'N/A'}</td>
      <td>${log.platform}</td>
      <td>${log.arch}</td>
      <td>${(log.size / 1024).toFixed(2)} KB</td>
      <td>${log.taskId || 'N/A'}</td>
      <td>
        <a href="/logs/${log.id}" target="_blank">查看</a>
        <a href="/download/${log.id}" download>下载</a>
      </td>
    </tr>
  `).join('');
  
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Sentinel Browser 日志管理</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f5f5;
      padding: 20px;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      padding: 30px;
    }
    h1 {
      color: #333;
      margin-bottom: 20px;
      padding-bottom: 10px;
      border-bottom: 2px solid #007acc;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px;
      margin-bottom: 30px;
    }
    .stat-card {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 20px;
      border-radius: 8px;
      text-align: center;
    }
    .stat-card h3 {
      font-size: 2em;
      margin-bottom: 5px;
    }
    .stat-card p {
      opacity: 0.9;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 20px;
    }
    th, td {
      text-align: left;
      padding: 12px;
      border-bottom: 1px solid #eee;
    }
    th {
      background: #f8f9fa;
      font-weight: 600;
      color: #555;
    }
    tr:hover {
      background: #f8f9fa;
    }
    a {
      color: #007acc;
      text-decoration: none;
      margin-right: 10px;
    }
    a:hover {
      text-decoration: underline;
    }
    .empty {
      text-align: center;
      padding: 40px;
      color: #999;
    }
    .refresh-btn {
      float: right;
      background: #007acc;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
    }
    .refresh-btn:hover {
      background: #005fa3;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>
      📝 Sentinel Browser 日志管理
      <button class="refresh-btn" onclick="location.reload()">刷新</button>
    </h1>
    
    <div class="stats">
      <div class="stat-card">
        <h3>${logs.length}</h3>
        <p>总日志数</p>
      </div>
      <div class="stat-card">
        <h3>${new Set(logs.map(l => l.taskId)).size}</h3>
        <p>不同任务</p>
      </div>
      <div class="stat-card">
        <h3>${new Set(logs.map(l => l.platform)).size}</h3>
        <p>平台类型</p>
      </div>
      <div class="stat-card">
        <h3>${(logs.reduce((sum, l) => sum + (l.size || 0), 0) / 1024 / 1024).toFixed(2)} MB</h3>
        <p>总大小</p>
      </div>
    </div>
    
    ${logs.length === 0 ? 
      '<div class="empty">暂无日志记录</div>' :
      `<table>
        <thead>
          <tr>
            <th>上传时间</th>
            <th>任务名称</th>
            <th>平台</th>
            <th>架构</th>
            <th>大小</th>
            <th>任务ID</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>`
    }
  </div>
  
  <script>
    // 每30秒自动刷新
    setTimeout(() => location.reload(), 30000);
  </script>
</body>
</html>`;
}

// 创建HTTP服务器
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  
  // 设置CORS头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Log-Source, X-Client-Version');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // API: 上传日志
  if (pathname === '/api/logs/upload' && req.method === 'POST') {
    let body = '';
    
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        serverLog(`Received log upload: ${data.filename} from ${data.platform}/${data.arch}, task: ${data.taskName || 'unknown'}`);
        
        const metadata = saveLogFile(data);
        serverLog(`Log saved: ${metadata.savedAs}`);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: 'Log uploaded successfully',
          id: metadata.id,
          savedAs: metadata.savedAs
        }));
      } catch (error) {
        serverLog('Error processing upload: ' + error.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: error.message
        }));
      }
    });
    
    return;
  }
  
  // API: 获取日志列表
  if (pathname === '/api/logs' && req.method === 'GET') {
    const logs = getLogsList();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      count: logs.length,
      logs: logs
    }));
    return;
  }
  
  // 查看日志详情
  if (pathname.startsWith('/logs/') && req.method === 'GET') {
    const logId = pathname.split('/')[2];
    const logs = getLogsList();
    const log = logs.find(l => l.id === logId);
    
    if (log && fs.existsSync(log.filepath)) {
      const content = fs.readFileSync(log.filepath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(content);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Log not found' }));
    }
    return;
  }
  
  // 下载日志
  if (pathname.startsWith('/download/') && req.method === 'GET') {
    const logId = pathname.split('/')[2];
    const logs = getLogsList();
    const log = logs.find(l => l.id === logId);
    
    if (log && fs.existsSync(log.filepath)) {
      const content = fs.readFileSync(log.filepath);
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', `attachment; filename="${log.filename}"`);
      res.writeHead(200);
      res.end(content);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Log not found' }));
    }
    return;
  }
  
  // 管理界面
  if (pathname === '/' || pathname === '/admin') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(generateAdminHTML());
    return;
  }
  
  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// 启动服务器
server.listen(PORT, () => {
  serverLog(`Log server started on port ${PORT}`);
  serverLog(`Logs directory: ${LOGS_DIR}`);
  serverLog(`Uploads directory: ${UPLOADS_DIR}`);
  serverLog(`Admin panel: http://localhost:${PORT}/`);
});

// 优雅关闭
process.on('SIGTERM', () => {
  serverLog('SIGTERM received, shutting down gracefully');
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  serverLog('SIGINT received, shutting down gracefully');
  server.close(() => {
    process.exit(0);
  });
});
