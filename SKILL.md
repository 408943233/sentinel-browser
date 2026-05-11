# Sentinel Browser 2.0

工业级Web应用数据采集器，专为VLA（视觉-语言-动作）模型训练设计。

## 功能特性

- **视频录制**: FFmpeg高性能视频管线，支持硬件加速（NVIDIA NVENC/Intel QSV/macOS VideoToolbox），实现stdin缓冲区监控和背压处理
- **Shadow DOM遍历**: 基于Chrome DevTools Protocol的深度DOM捕获，支持闭合Shadow Root穿透
- **状态捕获**: 完整的localStorage、sessionStorage、IndexedDB递归序列化与恢复（Time-Travel Injection）
- **API监控**: 自动拦截和记录所有API请求/响应到结构化JSONL
- **错误检测**: JavaScript错误、Promise异常、UI错误（Toast/验证错误/红色文本）全面捕获
- **多窗口追踪**: 完整的窗口谱系关系记录（parent_window_id、opener_action_id）
- **文件I/O追踪**: 
  - 下载（will-download）
  - 上传（FormData劫持）
  - Blob URL持久化（内存图片捕获）
  - PDF流拦截（net.request下载）
- **磁盘安全**: 实时监控可用空间，少于2GB自动暂停并提醒
- **原子写入**: training_manifest.jsonl使用追加模式，每行独立合法的JSON对象
- **自动导出**: 一键导出为ZIP格式的训练数据集
- **非活动监控**: 5分钟无活动自动停止录制
- **Watchdog守护**: 独立进程监控主进程及FFmpeg健康状态
- **状态注入回放**: 在回放模式下劫持存储API，强制返回录制时的静态数据

## 安装

```bash
npm install
```

## 运行

```bash
npm run dev    # 开发模式
npm start      # 生产模式
```

## 构建

```bash
npm run build
```

## 项目结构

```
sentinel-browser/
├── src/
│   ├── main/           # 主进程
│   │   ├── main.js              # 主入口，窗口管理，IPC通信
│   │   ├── cdp-manager.js       # CDP管理器（Shadow DOM遍历）
│   │   ├── state-manager.js     # 状态管理器（IndexedDB序列化）
│   │   ├── state-injector.js    # 状态注入器（Time-Travel回放）
│   │   ├── ffmpeg-manager.js    # FFmpeg录制管理（硬件加速+背压处理）
│   │   ├── watchdog.js          # 守护进程
│   │   ├── error-detector.js    # 错误探测器
│   │   ├── lineage-tracker.js   # 谱系追踪器
│   │   └── data-schema.js       # 数据Schema管理器
│   ├── renderer/       # 渲染进程
│   │   ├── index.html           # 主界面
│   │   ├── styles.css           # 样式
│   │   └── renderer.js          # 渲染逻辑
│   ├── preload/        # 预加载脚本
│   │   └── preload.js           # 安全IPC桥接，Blob/上传拦截，状态注入
│   └── shared/         # 共享模块
│       └── constants.js         # 常量定义
├── docs/              # 文档
│   └── data-schema-example.json # 完整数据结构示例
└── tests/             # 测试
```

## 任务目录结构

```
/collections/task_{task_id}_{timestamp}/
├── video/
│   └── raw_record.mp4           # 包含OSD时间戳水印的高清录像(GPU加速)
├── network/
│   ├── api_traffic.jsonl        # 结构化请求序列，含Request/Response Body
│   └── resources/               # 离线回放所需的静态资源(.js, .css, .woff)
├── previews/                    # 【关键业务文档捕获】
│   ├── doc_001.pdf              # 拦截到的PDF流
│   ├── blob_123456789_image.png # 劫持URL.createObjectURL生成的内存图片
│   └── snapshots/               # 关键操作瞬间的全分辨率高精截图
├── sandbox/                     # 【核心】环境克隆数据
│   ├── browser_state.json       # 递归序列化后的IndexedDB, LocalStorage, Cookies
│   └── lineage.json             # 窗口谱系关系
├── logs/                        # 【健壮性】审计与诊断
│   ├── watchdog.log             # 监控进程记录（FFmpeg重启、丢帧等）
│   ├── console_errors.jsonl     # 页面运行时错误、验证失败捕获
│   └── errors.json              # 错误报告汇总
├── metadata.json                # 任务元数据（User ID, Role, OS, Browser Version）
└── training_manifest.jsonl      # 【黄金文件】全维度对齐清单
```

## 数据架构

所有条目严格遵循以下JSON结构，**严禁缺少字段**（无数据时填 `null` 或 `{}`）：

```json
{
  "timestamp": 1714286730123,
  "video_time": "00:02:15.500",
  "task_id": "acc_opening_001",
  "sub_task_id": "subtask_identity_verification",
  "window_context": {
    "window_id": "tab_02",
    "parent_window_id": "tab_01",
    "url": "https://biz-system.com/preview/..."
  },
  "user_context": {
    "user_id": "clerk_99",
    "role": "verifier",
    "permissions": ["view_docs"],
    "env": "prod_v8"
  },
  "event_details": {
    "action": "click",
    "semantic_label": "Confirm Identity",
    "dom_path": "//div[@id='root']/button",
    "shadow_dom_path": "custom-element::shadow-root > .btn",
    "coordinates": { "x": 850, "y": 420 }
  },
  "file_io": {
    "type": "preview",
    "local_path": "previews/id_card.pdf",
    "content_summary": "Extracted text..."
  },
  "page_state": {
    "fingerprint": "hash_123",
    "has_errors": false,
    "is_loading": false,
    "mutations": []
  },
  "network_correlation": {
    "api_requests": ["req_9928"],
    "response_status": 200
  },
  "lineage": {
    "previous_event_id": "evt_041",
    "next_event_id": "evt_043"
  }
}
```

## 技术实现细节

### A. 深度DOM审计器 (CDP-based)
- 使用 `webContents.debugger` 附加到页面
- 调用 `DOM.enable` 和 `DOM.getFlattenedDocument(pierce: true)`
- 生成穿透Shadow DOM的唯一路径: `custom-element::shadow-root > div.container`

### B. Deep State状态爬虫 (IndexedDB序列化)
- 注入异步脚本遍历 `indexedDB.databases()`
- 递归遍历每个数据库的ObjectStores
- 使用 `cursor.continue()` 提取所有记录
- 序列化为 `browser_state.json`

### C. 同步状态注入器 (Time-Travel Injection)
- 在回放模式下劫持存储API
- `Object.defineProperty` 重写 `window.indexedDB`、`localStorage`
- 强制返回 `browser_state.json` 中的静态数据
- 阻止所有写入操作

### D. 动态媒体捕获管线
- **Blob拦截**: 重写 `URL.createObjectURL`，读取二进制数据通过IPC发送
- **PDF持久化**: 拦截 `Content-Type: application/pdf`，使用 `net.request` 下载字节流

### E. 高性能视频管线 (FFmpeg Buffer模式)
- 使用 `desktopCapturer` 获取视频流
- FFmpeg配置硬件加速参数 (`h264_nvenc`/`h264_videotoolbox`)
- **背压处理**: 监控 `ffmpeg.stdin.write()` 返回值
- **丢帧策略**: 缓冲区超过95%时触发丢帧，防止内存溢出

## 快捷键

- `Ctrl+Shift+L`: 切换开发者工具

## 存储路径

- **项目目录**: `/Users/gaoyiwei/Documents/trae_projects/openclaw/output/collections/`

## 暂停/继续逻辑

- **暂停**: 停止视频帧捕获，FFmpeg继续编码已缓冲的帧
- **继续**: 恢复视频帧捕获，保持时间戳连续性
- **实现**: 通过 `isPaused` 标志控制帧捕获循环
