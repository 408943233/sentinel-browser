/**
 * ============================================================================
 * Sentinel Browser - 主进程入口 (main.js)
 * ============================================================================
 *
 * 【核心职责】
 * 1. 管理 Electron 应用生命周期（启动、退出）
 * 2. 创建和管理浏览器窗口（主窗口、标签页）
 * 3. 处理 IPC 通信（与渲染进程、Preload 脚本通信）
 * 4. 管理录制任务（开始、停止、暂停）
 * 5. 协调各管理器模块（FFmpeg、CDP、谱系追踪等）
 * 6. 处理文件下载、资源保存
 * 7. 生成和导出训练数据
 *
 * 【架构设计】
 *
 * 1. 初始化阶段
 *    - 检查系统依赖（Windows VC++ Redist）
 *    - 配置日志系统
 *    - 设置用户数据目录
 *    - 初始化全局状态
 *
 * 2. 管理器初始化
 *    - FFmpegManager: 视频录制和截图
 *    - WatchdogManager: 监控录制状态
 *    - ErrorDetector: 错误检测
 *    - LineageTracker: 窗口谱系追踪
 *    - StateManager: 状态管理
 *    - CDPManager: Chrome DevTools Protocol
 *    - DataSchemaManager: 数据格式验证
 *    - UnifiedEventManager: 统一事件管理（基于因果关系链）
 *    - LogUploader: 日志上传
 *
 * 3. 窗口管理
 *    - createMainWindow: 创建主窗口
 *    - createTabWindow: 创建标签页窗口
 *    - setupWebviewIPCListeners: 设置 IPC 监听器
 *
 * 4. 录制管理
 *    - startRecording: 开始录制
 *    - stopRecording: 停止录制
 *    - pauseRecording/resumeRecording: 暂停/恢复
 *    - recordUserAction: 记录用户操作
 *
 * 5. 数据处理
 *    - saveResource: 保存静态资源
 *    - saveDOMSnapshot: 保存 DOM 快照
 *    - extractSnapshotsFromVideo: 从视频提取截图
 *    - runCorrelationWithProgress: 运行关联分析
 *
 * 【IPC 通信】
 *
 * 从 Renderer/Preload 接收：
 * - sentinel-click: 点击事件
 * - sentinel-input: 输入事件
 * - sentinel-scroll*: 滚动事件
 * - sentinel-keydown: 键盘事件
 * - sentinel-request-start/complete: 网络请求
 * - sentinel-websocket*: WebSocket 事件
 * - sentinel-storage-operation: 存储操作
 * - sentinel-dom-snapshot: DOM 快照
 * - sentinel-page-loaded: 页面加载
 *
 * 发送到 Renderer：
 * - recording-started/stopped: 录制状态
 * - correlation-progress: 关联进度
 * - snapshot-extraction-progress: 截图进度
 *
 * 【数据流】
 *
 * 用户操作 -> Preload 拦截 -> IPC 发送 -> Main 接收 -> UnifiedEventManager
 *     -> 写入 manifest -> 后处理关联 -> 生成训练数据
 *
 * 【文件结构】
 *
 * 任务目录结构：
 * task_id/
 *   ├── training_manifest.jsonl  # 主事件日志
 *   ├── dom/                     # DOM 快照
 *   ├── previews/                # 视频截图
 *   ├── network/                 # 网络资源
 *   │   ├── resources/          # 静态资源
 *   │   └── api_bodies/         # API 响应体
 *   ├── sandbox/                # 浏览器状态
 *   └── video.mp4               # 录制视频
 *
 * 【关键技术】
 *
 * 1. 因果关系链追踪
 *    - 使用 eventId 精确关联事件和请求
 *    - 替代传统的时间窗口匹配
 *    - 实现 100% 准确的关联
 *
 * 2. rrweb 标准 DOM 序列化
 *    - 支持完整和增量快照
 *    - 记录 DOM 变化历史
 *    - 支持 Shadow DOM
 *
 * 3. 视频录制
 *    - 使用 FFmpeg 录制屏幕
 *    - 录制结束后提取关键帧
 *    - 生成预览截图
 *
 * 4. 后处理关联
 *    - 录制结束后运行关联脚本
 *    - 分析事件和请求的关系
 *    - 生成完整的关联数据
 * ============================================================================
 */

const { app, BrowserWindow, ipcMain, dialog, session, shell, systemPreferences } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const log = require('electron-log');
const { spawn } = require('child_process');
const archiver = require('archiver');

// Windows 依赖检查和启动错误处理
if (process.platform === 'win32') {
  // 检查 Visual C++ Redistributable
  function checkVCRedist() {
    try {
      const { execSync } = require('child_process');
      // 检查注册表
      const checkReg = (key) => {
        try {
          execSync(`reg query "${key}" /v Installed`, { stdio: 'pipe' });
          return true;
        } catch {
          return false;
        }
      };
      
      // 检查多个可能的注册表位置
      const keys = [
        'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64',
        'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64'
      ];
      
      return keys.some(checkReg);
    } catch (error) {
      console.error('检查 VC++ Redist 失败:', error);
      return false;
    }
  }
  
  // 在 app ready 之前检查依赖
  const vcInstalled = checkVCRedist();
  if (!vcInstalled) {
    console.warn('Visual C++ Redistributable 未安装');
    // 记录到日志，但不阻止启动（让用户在启动后看到提示）
    global.vcRedistMissing = true;
  }

  // 捕获未处理的异常，防止静默崩溃
  process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    const errorLogPath = path.join(os.tmpdir(), 'sentinel-browser-error.log');
    fs.writeFileSync(errorLogPath, `Uncaught Exception: ${error.stack || error.message}\n`, { flag: 'a' });
    
    // 检查是否是 VC++ 相关的错误
    const errorMsg = error.message || '';
    const isVCRelated = errorMsg.includes('dll') || 
                        errorMsg.includes('DLL') || 
                        errorMsg.includes('module') ||
                        errorMsg.includes('找不到');
    
    if (isVCRelated && !vcInstalled) {
      dialog.showErrorBox('缺少系统组件', 
        '应用程序无法启动，因为缺少必需的系统组件：Visual C++ Redistributable\n\n' +
        '请下载并安装：\n' +
        'https://aka.ms/vs/17/release/vc_redist.x64.exe\n\n' +
        '安装后重新启动应用程序。');
    } else {
      dialog.showErrorBox('启动错误', `应用程序启动失败:\n${error.message}\n\n详细错误已保存到:\n${errorLogPath}`);
    }
    app.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    const errorLogPath = path.join(os.tmpdir(), 'sentinel-browser-error.log');
    fs.writeFileSync(errorLogPath, `Unhandled Rejection: ${reason}\n`, { flag: 'a' });
  });
}

// 设置用户数据目录为应用支持目录（避免 app.asar 只读问题）
const userDataPath = path.join(app.getPath('userData'), 'SentinelBrowser');
if (!fs.existsSync(userDataPath)) {
  fs.mkdirSync(userDataPath, { recursive: true });
}
app.setPath('userData', userDataPath);
app.setPath('cache', path.join(userDataPath, 'Cache'));

// 日志目录：Windows使用安装目录，其他平台使用userData
let logsPath;
if (process.platform === 'win32' && app.isPackaged) {
  // Windows打包版本：使用安装目录下的logs
  logsPath = path.join(path.dirname(app.getPath('exe')), 'logs');
} else {
  // 其他情况：使用userData下的logs
  logsPath = path.join(userDataPath, 'logs');
}
app.setPath('logs', logsPath);

// 导入共享工具函数
const { generateUUID } = require('../shared/utils');

// 导入增强日志工具
const logger = require('../shared/logger');
const appLog = logger.create('Main');

// 导入自定义模块
const CDPManager = require('./cdp-manager');
const StateManager = require('./state-manager');
const StateInjector = require('./state-injector');
const FFmpegManager = require('./ffmpeg-manager');
const WatchdogManager = require('./watchdog');
const ErrorDetector = require('./error-detector');
const LineageTracker = require('./lineage-tracker');
const DataSchemaManager = require('./data-schema');
const LogUploader = require('./log-uploader');
const UnifiedEventManager = require('./unified-event-manager');

// 配置日志 - 同时输出到终端和文件
log.initialize();
log.transports.file.level = 'debug';
log.transports.console.level = 'debug';

// 设置日志文件路径（使用 app.getPath('logs') 确保一致性）
const logDir = app.getPath('logs');
const logFilePath = path.join(logDir, 'main.log');

// 确保日志目录存在
try {
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
    appLog.info('Created log directory', { path: logDir });
  }
} catch (err) {
  appLog.error('Failed to create log directory', err, { path: logDir });
}

// electron-log v5 配置 - 使用绝对路径
log.transports.file.resolvePathFn = () => logFilePath;

// 强制立即写入日志
log.transports.file.sync = true;

// 记录日志配置信息
appLog.info('Logging initialized', {
  logDir,
  logFilePath,
  electronVersion: process.versions.electron,
  nodeVersion: process.versions.node,
  platform: process.platform,
  arch: process.arch
});

// 记录启动信息
appLog.info('Application starting', {
  pid: process.pid,
  ppid: process.ppid,
  cwd: process.cwd(),
  execPath: process.execPath,
  argv: process.argv
});

// 全局状态
const globalState = {
  isRecording: false,
  isPaused: false,  // 暂停状态
  currentTask: null,
  windows: new Map(),
  apiResponses: new Map(),
  inactivityTimer: null,
  lastActivityTime: Date.now(),
  ffmpegManager: null,
  watchdogManager: null,
  errorDetector: null,
  lineageTracker: null,
  stateManager: null,
  cdpManager: null,
  dataSchemaManager: null,
  logUploader: null, // 日志上传器
  unifiedEventManager: null, // 统一事件管理器（基于因果关系链）
  manifestStream: null,
  apiLogStream: null,
  consoleErrorStream: null,
  correlationLogStream: null, // 关联日志流
  stateInjector: null,
  initialSnapshotSaved: false,  // 标记是否已保存初始 DOM snapshot
  isReplayMode: false,
  isReplaying: false,  // 回放模式标志
  replayTaskDir: null, // 回放任务目录
  docSequence: 0, // PDF 文档序列号计数器
  downloadedPdfs: new Set(), // 已下载的 PDF URL 集合，用于去重
  pendingEvents: [], // 待写入 manifest 的事件队列
  flushedEvents: new Map(), // 已写入 manifest 的事件缓存（用于后续关联）
  // DOM 快照去重相关
  lastDOMSnapshotTime: 0, // 最后一次 DOM 快照时间
  minDOMSnapshotInterval: 500, // 最小 DOM 快照间隔（毫秒）
  scrollSequenceSnapshots: new Map() // 滚动序列的快照记录（scrollSequenceId -> lastSnapshotTime）
};

// 动态资源列表（用于懒加载等资源）
const dynamicResources = [];

// API 请求缓冲区（用于请求关联）
const requestBuffer = [];

// 请求体临时存储（用于捕获请求 body）
const requestBodyMap = new Map();
const REQUEST_BODY_MAX_SIZE = 10 * 1024 * 1024; // 10MB
const REQUEST_BODY_TTL = 60000; // 60秒过期

// 添加动态资源
function addDynamicResource(resource) {
  dynamicResources.push(resource);
  log.info('Dynamic resource recorded:', resource.url);
}

// 保存动态资源到文件
function saveDynamicResources(taskFolder) {
  if (dynamicResources.length === 0) return;
  
  try {
    const dynamicResourcesPath = path.join(taskFolder, 'network', 'dynamic_resources.json');
    fs.writeFileSync(dynamicResourcesPath, JSON.stringify(dynamicResources, null, 2));
    log.info('Dynamic resources saved:', dynamicResources.length, 'to', dynamicResourcesPath);
  } catch (error) {
    log.error('Failed to save dynamic resources:', error);
  }
}

// 清空动态资源列表（用于新任务）
function clearDynamicResources() {
  dynamicResources.length = 0;
  log.info('Dynamic resources cleared');
}

// 生成唯一ID（用于事件、请求等）
function generateId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// 查找与请求时间戳最接近的事件时间戳
// 注意：此函数已废弃，新的因果关系链追踪使用 eventId 精确关联
// 保留此函数用于兼容旧代码和备用关联方案
function findEventTimestampForRequest(requestTimestamp) {
  // 基于时间戳的关联逻辑（备用方案）
  // 优先使用 eventId 关联，此函数仅在 eventId 关联失败时使用

  // 首先尝试在 pendingEvents 中查找
  if (Array.isArray(globalState.pendingEvents) && globalState.pendingEvents.length > 0) {
    const TIME_WINDOW = 5000; // 5秒
    let closestEvent = null;
    let minDiff = Infinity;

    for (const event of globalState.pendingEvents) {
      const diff = Math.abs(event.timestamp - requestTimestamp);
      if (diff < TIME_WINDOW && diff < minDiff) {
        minDiff = diff;
        closestEvent = event;
      }
    }

    if (closestEvent) {
      log.debug('Found closest event in pendingEvents:', closestEvent.timestamp, 'diff:', minDiff);
      return closestEvent.timestamp;
    }
  }

  // 然后在 flushedEvents 中查找
  if (globalState.flushedEvents && globalState.flushedEvents.size > 0) {
    const TIME_WINDOW = 5000; // 5秒
    let closestTimestamp = null;
    let minDiff = Infinity;

    for (const [timestamp, event] of globalState.flushedEvents) {
      const diff = Math.abs(timestamp - requestTimestamp);
      if (diff < TIME_WINDOW && diff < minDiff) {
        minDiff = diff;
        closestTimestamp = timestamp;
      }
    }

    if (closestTimestamp) {
      log.debug('Found closest event in flushedEvents:', closestTimestamp, 'diff:', minDiff);
      return closestTimestamp;
    }
  }

  return null;
}

// 存储路径配置 - Mac/Linux 使用默认路径，Windows 由用户选择
let STORAGE_PATH = null;

const getDefaultStoragePath = () => {
  // 使用项目本地目录避免 macOS TCC 权限问题
  const localPath = path.join(__dirname, '..', '..', 'collections');
  if (!fs.existsSync(localPath)) {
    try {
      fs.mkdirSync(localPath, { recursive: true });
    } catch (err) {
      console.warn('Failed to create local collections dir, falling back to userData:', err.message);
      return path.join(app.getPath('userData'), 'collections');
    }
  }
  return localPath;
};

// 选择存储目录（Windows 在启动任务时调用）
async function selectStorageDirectory(mainWindow) {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择录制文件保存位置',
    defaultPath: app.getPath('documents'),
    buttonLabel: '选择此文件夹'
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const selectedPath = result.filePaths[0];
  const collectionsPath = path.join(selectedPath, 'SentinelBrowser', 'collections');

  // 确保目录存在
  if (!fs.existsSync(collectionsPath)) {
    fs.mkdirSync(collectionsPath, { recursive: true });
  }

  return collectionsPath;
}

// 初始化管理器
function initializeManagers() {
  const timer = appLog.timer('initializeManagers');
  
  // 避免重复初始化
  if (globalState.ffmpegManager) {
    appLog.debug('Managers already initialized, skipping', {
      existingManagers: Object.keys(globalState).filter(k => globalState[k] !== null && k !== 'windows')
    });
    return;
  }

  appLog.info('Initializing managers', {
    platform: process.platform,
    storagePath: STORAGE_PATH || 'not set (will use default)'
  });

  // Windows 平台：等待用户选择存储目录，不自动设置默认路径
  if (!STORAGE_PATH && process.platform !== 'win32') {
    appLog.warn('STORAGE_PATH not set, using default path', {
      defaultPath: getDefaultStoragePath()
    });
    STORAGE_PATH = getDefaultStoragePath();
  }

  try {
    appLog.debug('Creating FFmpegManager');
    globalState.ffmpegManager = new FFmpegManager();
    appLog.debug('FFmpegManager created successfully');

    appLog.debug('Creating WatchdogManager');
    globalState.watchdogManager = new WatchdogManager();
    appLog.debug('WatchdogManager created successfully');

    appLog.debug('Creating ErrorDetector');
    globalState.errorDetector = new ErrorDetector();
    appLog.debug('ErrorDetector created successfully');

    appLog.debug('Creating LineageTracker');
    globalState.lineageTracker = new LineageTracker();
    appLog.debug('LineageTracker created successfully');

    appLog.debug('Creating StateManager', { storagePath: STORAGE_PATH });
    globalState.stateManager = new StateManager(STORAGE_PATH);
    appLog.debug('StateManager created successfully');

    appLog.debug('Creating CDPManager');
    globalState.cdpManager = new CDPManager();
    appLog.debug('CDPManager created successfully');

    appLog.debug('Creating DataSchemaManager');
    globalState.dataSchemaManager = new DataSchemaManager();
    appLog.debug('DataSchemaManager created successfully');

    appLog.debug('Creating StateInjector');
    globalState.stateInjector = new StateInjector();
    appLog.debug('StateInjector created successfully');

    appLog.debug('Creating LogUploader');
    globalState.logUploader = new LogUploader('http://42.193.126.52');
    appLog.debug('LogUploader created successfully');

    appLog.info('All managers initialized successfully');
    timer.end({ managerCount: 9 });
  } catch (error) {
    appLog.error('Failed to initialize managers', error);
    timer.end({ error: true });
    throw error;
  }

  log.info('Managers initialized successfully');
}

/**
 * 启用回放模式
 * @param {string} taskDir - 任务目录路径
 */
function enableReplayMode(taskDir) {
  globalState.isReplayMode = true;

  // 加载 browser_state.json
  const statePath = path.join(taskDir, 'sandbox', 'browser_state.json');
  if (globalState.stateInjector.loadState(statePath)) {
    log.info('Replay mode enabled for task:', taskDir);
    setupReplayInjection();
  } else {
    log.warn('Failed to enable replay mode, state file not found:', statePath);
  }
}

/**
 * 禁用回放模式
 */
function disableReplayMode() {
  globalState.isReplayMode = false;
  log.info('Replay mode disabled');
}

/**
 * 为窗口设置回放注入
 * @param {BrowserWindow} window - Electron 窗口
 */
function setupWindowReplayInjection(window) {
  if (!globalState.isReplayMode || !globalState.stateInjector) {
    return;
  }

  const injectionScript = globalState.stateInjector.getInjectionScript();
  if (!injectionScript) {
    log.warn('No injection script available');
    return;
  }

  // 在页面加载前注入脚本
  window.webContents.on('dom-ready', () => {
    log.info('Injecting state script into window');

    // 注入同步脚本
    window.webContents.executeJavaScript(injectionScript, true)
      .then(() => {
        log.info('State injection script executed successfully');
      })
      .catch((error) => {
        log.error('Failed to execute state injection script:', error);
      });
  });
}

/**
 * 创建回放窗口
 * @param {string} taskDir - 任务目录
 * @param {string} url - 要加载的 URL
 */
function createReplayWindow(taskDir, url) {
  // 启用回放模式
  enableReplayMode(taskDir);

  const replayWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      webSecurity: true,
      allowRunningInsecureContent: false
    },
    titleBarStyle: 'default'
  });

  // 设置回放注入
  setupWindowReplayInjection(replayWindow);

  // 加载 URL
  replayWindow.loadURL(url);

  // 窗口关闭时禁用回放模式
  replayWindow.on('closed', () => {
    disableReplayMode();
  });

  return replayWindow;
}

// 创建主窗口
function createMainWindow() {
  const timer = appLog.timer('createMainWindow');
  appLog.info('Creating main window', {
    windowSize: { width: 1400, height: 900 },
    platform: process.platform,
    preloadPath: path.join(__dirname, '..', 'preload', 'preload.js')
  });

  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: true
    },
    titleBarStyle: 'default',
    show: false,
    autoHideMenuBar: true
  });

  appLog.debug('Main window created', { windowId: mainWindow.id });

  // Windows 平台隐藏菜单栏
  if (process.platform === 'win32') {
    mainWindow.setMenuBarVisibility(false);
    appLog.debug('Menu bar hidden for Windows');
  }

  // 加载渲染进程
  const rendererPath = path.join(__dirname, '..', 'renderer', 'index.html');
  appLog.debug('Loading renderer', { path: rendererPath });
  mainWindow.loadFile(rendererPath);

  // 开发工具 - 默认不打开，需要时按 Ctrl+Shift+I 或 Cmd+Option+I 打开
  // if (!app.isPackaged) {
  //   mainWindow.webContents.openDevTools();
  // }

  mainWindow.once('ready-to-show', () => {
    appLog.info('Main window ready to show');
    mainWindow.show();
    appLog.info('Main window shown');
    
    // Windows: 如果缺少 VC++ Redistributable，显示友好提示
    if (process.platform === 'win32' && global.vcRedistMissing) {
      appLog.warn('VC++ Redistributable missing, showing warning dialog');
      setTimeout(() => {
        dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: '系统组件检查',
          message: '检测到可能缺少系统组件',
          detail: '为了获得最佳体验，建议安装 Visual C++ Redistributable。\n\n' +
                  '如果应用程序运行正常，可以忽略此提示。\n\n' +
                  '是否现在下载安装？',
          buttons: ['下载安装', '暂时忽略'],
          defaultId: 0,
          cancelId: 1
        }).then(result => {
          if (result.response === 0) {
            appLog.info('User chose to download VC++ Redistributable');
            shell.openExternal('https://aka.ms/vs/17/release/vc_redist.x64.exe');
          } else {
            appLog.info('User chose to ignore VC++ Redistributable warning');
          }
        });
      }, 1000);
    }
  });

  // 窗口关闭处理
  mainWindow.on('closed', () => {
    appLog.info('Main window closed, stopping recording');
    stopRecording();
  });

  // 注册窗口到谱系追踪器
  appLog.debug('Registering window to lineage tracker', { windowId: `win_${mainWindow.id}` });
  globalState.lineageTracker.registerWindow(`win_${mainWindow.id}`, {
    url: '',
    title: 'Sentinel Browser'
  });

  globalState.windows.set(mainWindow.id, {
    window: mainWindow,
    parentId: null,
    lineage: []
  });

  appLog.debug('Window registered', { 
    windowId: mainWindow.id, 
    totalWindows: globalState.windows.size 
  });

  // 修复：重新启用网络请求监听，api_traffic.jsonl 需要这些数据
  setupTabNetworkListeners(mainWindow);

  // 注入错误监控
  mainWindow.webContents.on('dom-ready', () => {
    appLog.debug('DOM ready, injecting error monitoring');
    if (globalState.errorDetector) {
      globalState.errorDetector.injectMonitoring(mainWindow.webContents)
        .then(() => appLog.debug('Error monitoring injected successfully'))
        .catch(err => appLog.error('Failed to inject error monitoring', err));
    }
  });

  // 捕获 renderer 进程的 console 消息
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const levelNames = ['debug', 'log', 'warning', 'error'];
    const levelName = levelNames[level] || 'log';
    if (message.includes('[Sentinel]') || message.includes('[Sentinel Renderer]')) {
      appLog.debug('[Renderer Console]', { level: levelName, message: message.substring(0, 200) });
    }
  });

  timer.end({ windowId: mainWindow.id });
  
  // 处理 webview 的 ipc-message（点击事件等）
  mainWindow.webContents.on('ipc-message', (event, channel, ...args) => {
    const data = args[0];

    appLog.trace('IPC message received', [channel], {
      hasData: !!data,
      isRecording: globalState.isRecording,
      hasTask: !!globalState.currentTask,
      isPaused: globalState.isPaused
    });

    // DOM snapshot 事件由 renderer 处理，不再直接处理
    // renderer.js 会调用 window.sentinelAPI.saveDOMSnapshot，发送 dom-snapshot 消息
    if (channel === 'sentinel-dom-snapshot') {
      appLog.debug('DOM snapshot message ignored (handled by renderer)');
      return;
    }

    if (!globalState.isRecording || !globalState.currentTask) {
      appLog.debug('Ignoring IPC message - not recording or no task', { channel });
      return;
    }

    // 检查是否处于暂停状态
    if (globalState.isPaused) {
      appLog.debug('Ignoring IPC message - recording paused', { channel });
      return;
    }

    switch (channel) {
      case 'sentinel-click':
        appLog.info('Click event received', {
          selector: data.selector,
          xpath: data.xpath,
          tagName: data.tagName,
          coordinates: data.coordinates,
          url: data.url,
          eventId: data.eventId,
          snapshotFileName: data.snapshotFileName
        });

        // 记录 click 事件（不再实时截图，改为记录 video_time，录制结束后从视频截取）
        {
          // 使用事件中的 timestamp，确保与 DOM snapshot 文件名一致
          const timestamp = data.timestamp || Date.now();
          // 【修复】使用 preload 传递的确定性文件名（基于 eventId）
          const domSnapshotFileName = data.snapshotFileName || `snapshot_${timestamp}.json`;
          const clickData = {
            // 修复：传递 eventId，确保网络请求能关联到 click 事件
            eventId: data.eventId,
            type: 'click',
            timestamp: timestamp,
            xpath: data.xpath,
            selector: data.selector,
            shadowPath: data.shadowPath,
            tagName: data.tagName,
            text: data.text,
            coordinates: data.coordinates,
            url: data.url,
            title: data.title,
            // 从 preload 传递的 DOM 统计信息
            domStats: data.domStats || null,
            // 生成 snapshot 文件名（用于后续从视频截取）
            snapshotFileName: `snapshot_${timestamp}.png`,
            snapshotPath: `previews/snapshots/snapshot_${timestamp}.png`,
            // 【修复】使用基于 eventId 的确定性文件名
            domSnapshotFileName: domSnapshotFileName,
            domSnapshotPath: `dom/${domSnapshotFileName}`
          };

          // 记录 click 事件（包含 snapshot 引用信息，截图将在录制结束后从视频截取）
          recordUserAction(clickData);
          // DOM snapshot 由 renderer.js 触发，这里不再重复触发
        }
        break;

      case 'sentinel-input':
        log.debug('Webview input received:', data.selector, 'eventId:', data.eventId, 'snapshotFileName:', data.snapshotFileName);
        {
          const timestamp = data.timestamp || Date.now();
          // 【修复】使用 preload 传递的确定性文件名（基于 eventId）
          const domSnapshotFileName = data.snapshotFileName || `snapshot_${timestamp}.json`;
          recordUserAction({
            // 修复：传递 eventId，确保网络请求能关联到 input 事件
            eventId: data.eventId,
            type: 'input',
            timestamp: timestamp,
            xpath: data.xpath,
            selector: data.selector,
            tagName: data.tagName,
            inputType: data.inputType,
            value: data.value,
            url: data.url,
            // 从 preload 传递的 DOM 统计信息
            domStats: data.domStats || null,
            // 【修复】使用基于 eventId 的确定性文件名
            domSnapshotFileName: domSnapshotFileName,
            domSnapshotPath: `dom/${domSnapshotFileName}`
          });

          // DOM snapshot 由 renderer.js 触发，这里不再重复触发
        }
        break;

      case 'sentinel-scroll-start':
        {
          const timestamp = data.timestamp || Date.now();
          recordUserAction({
            // 修复：传递 eventId，确保网络请求能关联到 scroll-start 事件
            eventId: data.eventId,
            type: 'scroll-start',
            timestamp: timestamp,
            scrollX: data.scrollX,
            scrollY: data.scrollY,
            scrollStartX: data.scrollX,
            scrollStartY: data.scrollY,
            direction: data.direction,
            scrollSequenceId: data.scrollSequenceId,
            triggerSource: data.triggerSource,
            url: data.url,
            // 从 preload 传递的 DOM 统计信息
            domStats: data.domStats || null,
            domSnapshotFileName: `snapshot_${timestamp}.json`,
            domSnapshotPath: `dom/snapshot_${timestamp}.json`
          });
        }
        break;

      case 'sentinel-scroll':
        {
          const timestamp = data.timestamp || Date.now();

          // 优化：对于滚动过程中的事件，减少 DOM 快照生成频率
          // 只在滚动方向改变或超过最小间隔时才生成快照
          const scrollSequenceId = data.scrollSequenceId;
          const lastSnapshotTime = globalState.scrollSequenceSnapshots.get(scrollSequenceId) || 0;
          const timeSinceLastSnapshot = timestamp - lastSnapshotTime;
          const shouldTakeSnapshot = timeSinceLastSnapshot >= globalState.minDOMSnapshotInterval;

          let domSnapshotFileName = null;
          let domSnapshotPath = null;

          if (shouldTakeSnapshot) {
            domSnapshotFileName = `snapshot_${timestamp}.json`;
            domSnapshotPath = `dom/snapshot_${timestamp}.json`;
            globalState.scrollSequenceSnapshots.set(scrollSequenceId, timestamp);
          }

          recordUserAction({
            // 修复：传递 eventId，确保网络请求能关联到 scroll 事件
            eventId: data.eventId,
            type: 'scroll',
            timestamp: timestamp,
            scrollX: data.scrollX,
            scrollY: data.scrollY,
            scrollStartX: data.scrollStartX,
            scrollStartY: data.scrollStartY,
            scrollDeltaX: data.scrollDeltaX,
            scrollDeltaY: data.scrollDeltaY,
            scrollDuration: data.scrollDuration,
            direction: data.direction,
            scrollSequenceId: scrollSequenceId,
            triggerSource: data.triggerSource,
            url: data.url,
            // 从 preload 传递的 DOM 统计信息
            domStats: data.domStats || null,
            domSnapshotFileName: domSnapshotFileName,
            domSnapshotPath: domSnapshotPath
          });
          // DOM snapshot 由 renderer.js 触发，这里不再重复触发
        }
        break;

      case 'sentinel-scroll-end':
        {
          const timestamp = data.timestamp || Date.now();

          // 滚动结束，清理序列记录
          const scrollSequenceId = data.scrollSequenceId;
          globalState.scrollSequenceSnapshots.delete(scrollSequenceId);

          recordUserAction({
            // 修复：传递 eventId，确保网络请求能关联到 scroll-end 事件
            eventId: data.eventId,
            type: 'scroll-end',
            timestamp: timestamp,
            scrollX: data.scrollX,
            scrollY: data.scrollY,
            scrollStartX: data.scrollStartX,
            scrollStartY: data.scrollStartY,
            scrollDeltaX: data.scrollDeltaX,
            scrollDeltaY: data.scrollDeltaY,
            scrollDuration: data.scrollDuration,
            direction: data.direction,
            scrollSequenceId: scrollSequenceId,
            directionChanged: data.directionChanged,
            url: data.url,
            // 从 preload 传递的 DOM 统计信息
            domStats: data.domStats || null,
            domSnapshotFileName: `snapshot_${timestamp}.json`,
            domSnapshotPath: `dom/snapshot_${timestamp}.json`
          });
          // DOM snapshot 由 renderer.js 触发，这里不再重复触发
        }
        break;

      case 'sentinel-keydown':
        {
          const timestamp = data.timestamp || Date.now();
          recordUserAction({
            type: 'keydown',
            timestamp: timestamp,
            key: data.key,
            code: data.code,
            ctrlKey: data.ctrlKey,
            shiftKey: data.shiftKey,
            altKey: data.altKey,
            metaKey: data.metaKey,
            url: data.url,
            domSnapshotFileName: `snapshot_${timestamp}.json`,
            domSnapshotPath: `dom/snapshot_${timestamp}.json`
          });
          // DOM snapshot 由 renderer.js 触发，这里不再重复触发
        }
        break;

      case 'sentinel-hover':
        log.debug('Webview hover received:', data.selector);
        {
          const timestamp = data.timestamp || Date.now();
          const hoverData = {
            type: 'hover',
            timestamp: timestamp,
            xpath: data.xpath,
            selector: data.selector,
            shadowPath: data.shadowPath,
            tagName: data.tagName,
            text: data.text,
            coordinates: data.coordinates,
            url: data.url,
            title: data.title
            // 注意：悬停事件不触发 DOM snapshot，避免生成过多文件
          };
          recordUserAction(hoverData);
        }
        break;

      case 'sentinel-file-upload':
        log.info('Webview file upload received:', data.files.map(f => f.name).join(', '));
        {
          const timestamp = data.timestamp || Date.now();
          const uploadData = {
            type: 'file-upload',
            timestamp: timestamp,
            xpath: data.xpath,
            selector: data.selector,
            tagName: data.tagName,
            inputType: data.inputType,
            multiple: data.multiple,
            fileCount: data.fileCount,
            files: data.files,
            url: data.url,
            title: data.title,
            domSnapshotFileName: `snapshot_${timestamp}.json`,
            domSnapshotPath: `dom/snapshot_${timestamp}.json`
          };
          recordUserAction(uploadData);
        }
        break;

      case 'sentinel-file-content':
        // 保存文件内容到 uploads 目录（只保存文件，不重复记录事件）
        if (globalState.isRecording && globalState.currentTask) {
          saveUploadedFile(data);
        }
        break;

      case 'sentinel-file-drop':
        log.info('Webview file drop received:', data.files.map(f => f.name).join(', '));
        {
          const timestamp = data.timestamp || Date.now();
          const dropData = {
            type: 'file-drop',
            timestamp: timestamp,
            xpath: data.xpath,
            selector: data.selector,
            tagName: data.tagName,
            fileCount: data.fileCount,
            files: data.files,
            coordinates: data.coordinates,
            url: data.url,
            title: data.title,
            domSnapshotFileName: `snapshot_${timestamp}.json`,
            domSnapshotPath: `dom/snapshot_${timestamp}.json`
          };
          recordUserAction(dropData);
        }
        break;

      case 'sentinel-page-load-start':
        log.info('[Main] Webview page load start received:', data.url, 'timestamp:', data.timestamp, 'eventId:', data.eventId, 'snapshotFileName:', data.snapshotFileName);
        {
          // 页面加载开始事件 - 在 HTML 下载前创建，确保后续请求能关联
          const timestamp = data.timestamp || Date.now();
          // 【修复】使用 preload 传递的确定性文件名（基于 eventId）
          const domSnapshotFileName = data.snapshotFileName || (data.eventId ? `${data.eventId}.json` : `snapshot_${timestamp}.json`);
          log.info('[Main] Recording page-load-start event, timestamp:', timestamp, 'eventId:', data.eventId, 'snapshot:', domSnapshotFileName);

          // 使用 UnifiedEventManager 创建事件，确保 eventId 被正确记录
          if (globalState.unifiedEventManager && data.eventId) {
            globalState.unifiedEventManager.createEvent({
              eventId: data.eventId,
              type: 'page-load-start',
              timestamp: timestamp,
              url: data.url,
              title: data.title,
              navigationTiming: data.navigationTiming,
              isLoading: true, // 页面开始加载
              // 【修复】添加 DOM 快照文件名
              domSnapshotFileName: domSnapshotFileName
            });
            // 立即刷新到磁盘，确保后续关联能找到
            globalState.unifiedEventManager.flushEvent(data.eventId);
          }

          // 同时记录到用户操作（向后兼容）
          recordUserAction({
            eventId: data.eventId,
            type: 'page-load-start',
            timestamp: timestamp,
            url: data.url,
            title: data.title,
            navigationTiming: data.navigationTiming,
            isLoading: true,
            // 【修复】添加基于 eventId 的确定性文件名
            domSnapshotFileName: domSnapshotFileName,
            domSnapshotPath: `dom/${domSnapshotFileName}`
          });
          log.info('[Main] Page-load-start event recorded, eventId:', data.eventId, 'snapshot:', domSnapshotFileName);
        }
        break;

      case 'sentinel-page-load-complete':
        log.info('[Main] Webview page load complete received:', data.url, 'timestamp:', data.timestamp, 'eventId:', data.eventId, 'snapshotFileName:', data.snapshotFileName);
        {
          // 页面加载完成事件 - 使用与 page-load-start 相同的 eventId
          const timestamp = data.timestamp || Date.now();
          // 【修复】使用 preload 传递的确定性文件名（基于 eventId）
          const domSnapshotFileName = data.snapshotFileName || (data.eventId ? `${data.eventId}.json` : `snapshot_${timestamp}.json`);
          log.info('[Main] Recording page-load-complete event, timestamp:', timestamp, 'eventId:', data.eventId, 'snapshot:', domSnapshotFileName);

          // 关联到 page-load-start 事件（如果存在）
          if (globalState.unifiedEventManager && data.eventId) {
            globalState.unifiedEventManager.associateOperation(data.eventId, {
              type: 'page-load-complete',
              timestamp: timestamp,
              navigationTiming: data.navigationTiming,
              isLoading: false // 页面加载完成
            });
          }

          // 【修复】使用基于 eventId 的确定性文件名，不再使用 snapshot_initial.json
          recordUserAction({
            eventId: data.eventId,
            type: 'page-load-complete',
            timestamp: timestamp,
            url: data.url,
            title: data.title,
            navigationTiming: data.navigationTiming,
            isLoading: false,
            // 【修复】使用基于 eventId 的确定性文件名
            domSnapshotFileName: domSnapshotFileName,
            domSnapshotPath: `dom/${domSnapshotFileName}`
          });
          log.info('[Main] Page-load-complete event recorded, eventId:', data.eventId, 'snapshot:', domSnapshotFileName, 'duration:', data.navigationTiming?.duration);
        }
        break;

      // 保留旧版本兼容性
      case 'sentinel-page-loaded':
        log.info('[Main] Webview page loaded received (legacy):', data.url, 'timestamp:', data.timestamp, 'eventId:', data.eventId);
        {
          const timestamp = data.timestamp || Date.now();
          const isInitial = !globalState.initialSnapshotSaved;
          recordUserAction({
            eventId: data.eventId,
            type: 'page-load',
            timestamp: timestamp,
            url: data.url,
            title: data.title,
            isLoading: false,
            domSnapshotFileName: isInitial ? 'snapshot_initial.json' : `snapshot_${timestamp}.json`,
            domSnapshotPath: isInitial ? 'dom/snapshot_initial.json' : `dom/snapshot_${timestamp}.json`
          });
        }
        break;

      case 'sentinel-navigation':
        log.info('Webview navigation:', data.from, '->', data.to);
        {
          const timestamp = data.timestamp || Date.now();
          recordUserAction({
            type: 'navigation',
            timestamp: timestamp,
            from: data.from,
            to: data.to
            // 注意：navigation 事件不关联 DOM snapshot，只在 page-loaded 事件关联
          });
        }
        break;

      // ========== 新增的事件类型处理 ==========

      case 'sentinel-event-context':
        // 事件上下文（由 CausalChainTracker 发送）
        {
          if (globalState.unifiedEventManager) {
            globalState.unifiedEventManager.createEvent({
              eventId: data.eventId,
              type: data.eventType,
              timestamp: data.timestamp,
              url: data.url,
              title: data.title,
              ...data.metadata
            });
          }
        }
        break;

      case 'sentinel-request-start':
      case 'sentinel-request-complete':
        // 请求开始/完成（由 CausalChainTracker 发送）
        {
          // 诊断日志：记录所有请求
          log.info('[Main] Request received:', {
            channel: channel,
            type: data.type,
            url: data.url,
            method: data.method,
            requestId: data.requestId,
            eventId: data.eventId,
            status: data.status,
            hasUnifiedEventManager: !!globalState.unifiedEventManager
          });
          
          // 诊断日志：记录 eventId 为 null 的请求
          if (!data.eventId) {
            log.warn('[Main] Request with null eventId:', {
              type: data.type,
              url: data.url,
              method: data.method,
              requestId: data.requestId,
              recovered: data.recoveredEventId
            });
          }
          
          if (globalState.unifiedEventManager) {
            const result = globalState.unifiedEventManager.associateRequest(data.eventId, {
              requestId: data.requestId,
              type: data.type,
              url: data.url,
              method: data.method,
              status: data.status,
              duration: data.duration,
              body: data.body,
              responseBody: data.responseBody,
              recoveredEventId: data.recoveredEventId
            });
            log.info('[Main] Request association result:', { 
              requestId: data.requestId, 
              result: result,
              eventId: data.eventId 
            });
          } else {
            log.error('[Main] UnifiedEventManager not available for request association');
          }
        }
        break;

      case 'sentinel-eventid-null-diagnostic':
        // EventId 为 null 的诊断信息
        {
          log.warn('[Main] EventId null diagnostic:', {
            scenario: data.scenario,
            url: data.url,
            method: data.method,
            hasAsyncContext: data.hasAsyncContext,
            currentEventId: data.currentEventId,
            pageUrl: data.pageUrl
          });
        }
        break;

      case 'sentinel-eventid-stats':
        // EventId 统计信息（每30秒上报一次）
        {
          log.info('[Main] EventId null statistics:', {
            summary: data.summary,
            topScenarios: data.topScenarios,
            topNullUrls: data.topNullUrls
          });
        }
        break;

      case 'sentinel-websocket-created':
      case 'sentinel-websocket-message':
        // WebSocket 事件
        {
          if (globalState.unifiedEventManager) {
            globalState.unifiedEventManager.associateRequest(data.eventId, {
              type: 'websocket',
              wsId: data.wsId,
              direction: data.direction,
              data: data.data,
              timestamp: data.timestamp
            });
          }
        }
        break;

      case 'sentinel-sse-created':
      case 'sentinel-sse-message':
        // SSE 事件
        {
          if (globalState.unifiedEventManager) {
            globalState.unifiedEventManager.associateRequest(data.eventId, {
              type: 'sse',
              esId: data.esId,
              data: data.data,
              timestamp: data.timestamp
            });
          }
        }
        break;

      case 'sentinel-beacon':
        // Beacon API
        {
          if (globalState.unifiedEventManager) {
            globalState.unifiedEventManager.associateRequest(data.eventId, {
              type: 'beacon',
              beaconId: data.beaconId,
              url: data.url,
              data: data.data,
              timestamp: data.timestamp
            });
          }
        }
        break;

      case 'sentinel-postmessage':
      case 'sentinel-postmessage-received':
        // PostMessage - 匹配 preload 发送的格式
        {
          if (globalState.unifiedEventManager) {
            globalState.unifiedEventManager.associateCommunication(data.eventId, {
              type: 'postMessage',
              direction: data.direction || 'sent',
              message: data.message,
              origin: data.targetOrigin || data.origin || '*',
              timestamp: data.timestamp
            });
          }
        }
        break;

      case 'sentinel-broadcastchannel':
      case 'sentinel-broadcastchannel-created':
      case 'sentinel-broadcastchannel-message':
        // BroadcastChannel - 匹配 preload 发送的格式
        {
          if (globalState.unifiedEventManager) {
            globalState.unifiedEventManager.associateCommunication(data.eventId, {
              type: 'broadcastChannel',
              channelId: data.bcId || data.channelId,
              name: data.name,
              direction: data.direction || 'sent',
              message: data.message,
              timestamp: data.timestamp
            });
          }
        }
        break;

      case 'sentinel-storage':
      case 'sentinel-storage-operation':
        // Storage 操作 - 匹配 preload 发送的格式
        {
          if (globalState.unifiedEventManager) {
            // preload 发送的 type 已经是 'localStorage' 或 'sessionStorage'
            globalState.unifiedEventManager.associateStorageOperation(data.eventId, {
              type: data.type,
              operation: data.action || data.operation,
              key: data.key,
              value: data.value,
              timestamp: data.timestamp
            });
          }
        }
        break;

      case 'sentinel-indexeddb':
      case 'sentinel-indexeddb-operation':
        // IndexedDB 操作 - 匹配 preload 发送的格式
        {
          if (globalState.unifiedEventManager) {
            globalState.unifiedEventManager.associateStorageOperation(data.eventId, {
              type: 'indexedDB',
              dbId: data.dbId,
              dbName: data.name || data.dbName,
              operation: data.action || data.operation,
              version: data.version,
              timestamp: data.timestamp
            });
          }
        }
        break;

      case 'sentinel-cache':
      case 'sentinel-cache-operation':
        // Cache API 操作 - 匹配 preload 发送的格式
        {
          if (globalState.unifiedEventManager) {
            globalState.unifiedEventManager.associateStorageOperation(data.eventId, {
              type: 'cache',
              cacheId: data.cacheId,
              cacheName: data.cacheName,
              operation: data.action || data.operation,
              url: data.url,
              timestamp: data.timestamp
            });
          }
        }
        break;

      case 'sentinel-composition':
        // Composition 事件（输入法）
        {
          if (globalState.unifiedEventManager) {
            globalState.unifiedEventManager.associateComposition(data.eventId, {
              type: data.type,
              target: data.target,
              xpath: data.xpath,
              data: data.data,
              timestamp: data.timestamp
            });
          }
        }
        break;

      case 'sentinel-media-event':
        // Media 播放事件
        {
          if (globalState.unifiedEventManager) {
            globalState.unifiedEventManager.associateOperation(data.eventId, {
              type: 'media',
              mediaType: data.mediaType,
              eventType: data.type,
              src: data.src,
              currentTime: data.currentTime,
              duration: data.duration,
              volume: data.volume,
              playbackRate: data.playbackRate,
              timestamp: data.timestamp
            });
          }
        }
        break;

      case 'sentinel-form-submit':
        // Form 提交
        {
          if (globalState.unifiedEventManager) {
            globalState.unifiedEventManager.associateFormSubmit(data.eventId, {
              action: data.action,
              method: data.method,
              enctype: data.enctype,
              data: data.data,
              timestamp: data.timestamp
            });
          }
        }
        break;

      case 'sentinel-pointer-event':
        // Pointer 事件
        {
          if (globalState.unifiedEventManager) {
            globalState.unifiedEventManager.associatePointerEvent(data.eventId, {
              type: data.type,
              pointerId: data.pointerId,
              pointerType: data.pointerType,
              x: data.x,
              y: data.y,
              pressure: data.pressure,
              tiltX: data.tiltX,
              tiltY: data.tiltY,
              target: data.target,
              timestamp: data.timestamp
            });
          }
        }
        break;

      case 'sentinel-touch-event':
        // Touch 事件
        {
          if (globalState.unifiedEventManager) {
            globalState.unifiedEventManager.associateTouchEvent(data.eventId, {
              type: data.type,
              touches: data.touches,
              target: data.target,
              timestamp: data.timestamp
            });
          }
        }
        break;

      case 'sentinel-visibility-change':
      case 'sentinel-before-unload':
      case 'sentinel-resize':
        // Lifecycle 事件
        {
          if (globalState.unifiedEventManager) {
            globalState.unifiedEventManager.associateLifecycleEvent(data.eventId, {
              type: data.type,
              hidden: data.hidden,
              visibilityState: data.visibilityState,
              width: data.width,
              height: data.height,
              url: data.url,
              timestamp: data.timestamp
            });
          }
        }
        break;

      case 'sentinel-csp-violation':
        // CSP 违规
        {
          if (globalState.unifiedEventManager) {
            globalState.unifiedEventManager.associateSecurityEvent(data.eventId, {
              type: 'csp',
              blockedURI: data.blockedURI,
              violatedDirective: data.violatedDirective,
              originalPolicy: data.originalPolicy,
              documentURI: data.documentURI,
              timestamp: data.timestamp
            });
          }
        }
        break;

      case 'sentinel-css-animation':
      case 'sentinel-css-transition':
        // CSS Animation/Transition
        {
          if (globalState.unifiedEventManager) {
            globalState.unifiedEventManager.associateCSSAnimation(data.eventId, {
              type: data.type,
              animationName: data.animationName,
              propertyName: data.propertyName,
              target: data.target,
              timestamp: data.timestamp
            });
          }
        }
        break;

      case 'sentinel-performance':
      case 'sentinel-performance-entry':
        // Performance 指标 - 匹配 preload 发送的格式
        {
          if (globalState.unifiedEventManager) {
            globalState.unifiedEventManager.associateOperation(data.eventId, {
              type: 'performance',
              entryType: data.entryType || data.type,
              name: data.name,
              startTime: data.startTime,
              duration: data.duration,
              timestamp: data.timestamp
            });
          }
        }
        break;

      case 'sentinel-clipboard':
      case 'sentinel-clipboard-operation':
        // Clipboard 操作 - 匹配 preload 发送的格式
        {
          if (globalState.unifiedEventManager) {
            globalState.unifiedEventManager.associateOperation(data.eventId, {
              type: 'clipboard',
              operation: data.action || data.operation,
              text: data.text,
              timestamp: data.timestamp
            });
          }
        }
        break;

      case 'sentinel-iframe-injected':
        // iframe 注入成功
        {
          log.info('Iframe preload injected:', data.src);
        }
        break;

      case 'sentinel-sw-registered':
        // Service Worker 注册成功
        {
          log.info('Service Worker registered:', data.scope);
        }
        break;

      case 'sentinel-sw-request':
        // Service Worker 拦截的请求
        {
          if (globalState.unifiedEventManager) {
            globalState.unifiedEventManager.associateRequest(data.eventId || 'unknown', {
              type: 'fetch',
              url: data.url,
              method: data.method,
              source: 'service-worker',
              timestamp: data.timestamp
            });
          }
        }
        break;

      case 'report-error':
        // 错误报告
        {
          log.debug('Error report from renderer:', data);
          // 错误事件已经通过 error-detector 处理，这里只需要记录
        }
        break;

      case 'dom-snapshot':
        // DOM 快照
        {
          log.debug('DOM snapshot received:', data.type);
          // DOM 快照已经通过 saveDOMSnapshot 处理
        }
        break;

      case 'user-action':
        // 用户操作
        {
          log.debug('User action received:', data.type);
          // 用户操作已经通过其他事件处理
        }
        break;

      case 'sentinel-console-log':
        // 控制台日志（错误、警告等）
        {
          if (globalState.consoleErrorStream && data.level === 'error') {
            const errorEntry = {
              timestamp: data.timestamp || Date.now(),
              level: data.level,
              message: data.message,
              url: data.url,
              source: data.source,
              line: data.line,
              column: data.column
            };
            globalState.consoleErrorStream.write(JSON.stringify(errorEntry) + '\n');
          }
          // 同时关联到当前事件
          if (globalState.unifiedEventManager && data.eventId) {
            globalState.unifiedEventManager.associateOperation(data.eventId, {
              type: 'console',
              level: data.level,
              message: data.message,
              timestamp: data.timestamp
            });
          }
        }
        break;

      default:
        // 未知事件类型
        log.debug('Unknown sentinel event:', channel, data);
        break;

    }
  });

  // 处理下载事件
  setupDownloadHandler(mainWindow);

  return mainWindow;
}

// 创建新标签页
function createTabWindow(url, parentId = null) {
  const tabWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'preload', 'webview-preload.js'), // 使用 webview-preload.js 以支持事件录制
      webSecurity: true
    }
  });

  if (url) {
    tabWindow.loadURL(url);
  }

  // 注册窗口到谱系追踪器
  const windowId = `win_${tabWindow.id}`;
  globalState.lineageTracker.registerWindow(windowId, {
    parentId: parentId ? `win_${parentId}` : null,
    url: url,
    title: tabWindow.getTitle()
  });

  globalState.windows.set(tabWindow.id, {
    window: tabWindow,
    parentId: parentId,
    lineage: []
  });

  // 设置 IPC 消息监听（与主窗口相同）
  setupWebviewIPCListeners(tabWindow);

  // 设置 CDP 网络监控
  if (globalState.isRecording && globalState.cdpManager) {
    globalState.cdpManager.attach(tabWindow.webContents);
  }

  // 网络请求监听已由 Preload 层的 CausalChainTracker 处理
  // 不再使用 webRequest API（避免重复拦截和时间匹配的不准确性）
  // setupTabNetworkListeners(tabWindow);

  // 注入错误监控
  tabWindow.webContents.on('dom-ready', () => {
    if (globalState.errorDetector) {
      globalState.errorDetector.injectMonitoring(tabWindow.webContents);
    }
  });

  // 处理下载事件
  setupDownloadHandler(tabWindow);

  // 窗口关闭时清理
  tabWindow.on('closed', () => {
    globalState.windows.delete(tabWindow.id);
    globalState.lineageTracker.unregisterWindow(windowId);
  });

  return tabWindow;
}

// 设置 webview IPC 监听器（用于新标签页）
function setupWebviewIPCListeners(browserWindow) {
  // 处理 webview 的 ipc-message（点击事件等）
  browserWindow.webContents.on('ipc-message', (event, channel, ...args) => {
    const data = args[0];

    // DOM snapshot 事件由 renderer 处理，不再直接处理
    if (channel === 'sentinel-dom-snapshot') {
      // 忽略，由 renderer 处理
      return;
    }

    if (!globalState.isRecording || !globalState.currentTask) return;
    if (globalState.isPaused) return;

    const windowId = `win_${browserWindow.id}`;

    switch (channel) {
      case 'sentinel-click':
        log.info('Tab click received:', data.selector);
        {
          const timestamp = data.timestamp || Date.now();
          recordUserAction({
            type: 'click',
            timestamp: timestamp,
            windowId: windowId,
            url: data.url,
            xpath: data.xpath,
            selector: data.selector,
            tagName: data.tagName,
            text: data.text,
            coordinates: data.coordinates,
            title: data.title
          });
        }
        break;

      case 'sentinel-input':
        log.info('Tab input received:', data.selector);
        {
          const timestamp = data.timestamp || Date.now();
          recordUserAction({
            type: 'input',
            timestamp: timestamp,
            windowId: windowId,
            url: data.url,
            xpath: data.xpath,
            selector: data.selector,
            tagName: data.tagName,
            inputType: data.inputType,
            value: data.value,
            title: data.title
          });
        }
        break;

      case 'sentinel-keydown':
        log.info('Tab keydown received:', data.key);
        {
          const timestamp = data.timestamp || Date.now();
          recordUserAction({
            type: 'keydown',
            timestamp: timestamp,
            windowId: windowId,
            url: data.url,
            xpath: data.xpath,
            selector: data.selector,
            tagName: data.tagName,
            key: data.key,
            code: data.code,
            title: data.title
          });
        }
        break;

      case 'sentinel-scroll':
        log.info('Tab scroll received');
        {
          const timestamp = data.timestamp || Date.now();
          recordUserAction({
            type: 'scroll',
            timestamp: timestamp,
            windowId: windowId,
            url: data.url,
            scrollX: data.scrollX,
            scrollY: data.scrollY,
            title: data.title
          });
        }
        break;

      case 'sentinel-page-loaded':
        log.info('Tab page loaded:', data.url);
        {
          // 使用 webview 传来的原始时间戳（DOMContentLoaded 触发时间），而不是生成新的时间戳
          const timestamp = data.timestamp || Date.now();
          const isInitial = !globalState.initialSnapshotSaved;
          
          recordUserAction({
            type: 'page-load',
            timestamp: timestamp,
            windowId: windowId,
            url: data.url,
            title: data.title,
            domSnapshotFileName: isInitial ? 'snapshot_initial.json' : `snapshot_${timestamp}.json`,
            domSnapshotPath: isInitial ? 'dom/snapshot_initial.json' : `dom/snapshot_${timestamp}.json`
          });
          
          // 注意：initialSnapshotSaved 标志在 saveDOMSnapshot 函数中设置
          // 确保 DOM 快照实际保存成功后才标记为已保存
        }
        break;

      case 'sentinel-file-drop':
        log.info('Tab file drop received:', data.fileCount, 'files');
        {
          const timestamp = data.timestamp || Date.now();
          recordUserAction({
            type: 'file-drop',
            timestamp: timestamp,
            windowId: windowId,
            url: data.url,
            xpath: data.xpath,
            selector: data.selector,
            tagName: data.tagName,
            fileCount: data.fileCount,
            files: data.files,
            coordinates: data.coordinates,
            title: data.title
          });
        }
        break;

      case 'sentinel-request-start':
      case 'sentinel-request-complete':
        // 请求开始/完成（由 CausalChainTracker 动态注入代码发送）
        {
          log.info('[Main] Request from webview:', {
            channel: channel,
            type: data.type,
            url: data.url,
            method: data.method,
            requestId: data.requestId,
            eventId: data.eventId,
            status: data.status,
            hasEventId: !!data.eventId
          });

          if (globalState.unifiedEventManager) {
            const result = globalState.unifiedEventManager.associateRequest(data.eventId, {
              requestId: data.requestId,
              type: data.type,
              url: data.url,
              method: data.method,
              status: data.status,
              timestamp: data.timestamp
            });
            log.info('[Main] Request association result:', {
              requestId: data.requestId,
              result: result,
              eventId: data.eventId,
              url: data.url
            });

            // 诊断：如果关联失败，记录详细原因
            if (!result) {
              if (!data.eventId) {
                log.warn('[Main] Request association failed: eventId is null. Request may have started before any user event.', {
                  url: data.url,
                  type: data.type
                });
              } else {
                log.warn('[Main] Request association failed: event not found in memory. Event may have been written and cleaned up.', {
                  eventId: data.eventId,
                  url: data.url
                });
              }
            }
          } else {
            log.error('[Main] UnifiedEventManager not available for request association');
          }
        }
        break;
    }
  });
}

// 设置新标签页的网络监听器
function setupTabNetworkListeners(browserWindow) {
  const session = browserWindow.webContents.session;
  const windowId = `win_${browserWindow.id}`;

  // 监听网络请求以捕获API响应和资源
  session.webRequest.onCompleted(async (details) => {
    const { statusCode, url, responseHeaders, resourceType } = details;

    // 只有在录制中且未暂停时才记录
    if (globalState.isRecording && globalState.currentTask && !globalState.isPaused) {
      
      // 保存静态资源和HTML页面
      let resourceRelativePath = null;

      // 检查是否是已知的资源类型
      const isKnownResourceType = ['stylesheet', 'script', 'image', 'font', 'mainFrame', 'subFrame', 'media'].includes(resourceType);

      // 通过 URL 和 Content-Type 检测额外的资源（如条件注释加载的 JS）
      const isScriptByUrl = url.match(/\.(js|mjs)(\?.*)?$/i);
      const isCssByUrl = url.match(/\.(css)(\?.*)?$/i);
      const isIconByUrl = url.match(/\.(ico|png|svg)(\?.*)?$/i) && (url.includes('favicon') || url.includes('icon'));
      const contentType = (responseHeaders['content-type']?.[0] || responseHeaders['Content-Type']?.[0] || '').toLowerCase();
      const isScriptByMime = contentType.includes('javascript') || contentType.includes('ecmascript');
      const isCssByMime = contentType.includes('text/css');

      // 综合判断是否是脚本或样式资源
      const shouldSaveResource = isKnownResourceType || isScriptByUrl || isCssByUrl || isScriptByMime || isCssByMime || isIconByUrl;
      
      if (shouldSaveResource) {
        // 对于检测到的脚本/样式，强制使用正确的资源类型
        const effectiveResourceType = isScriptByUrl || isScriptByMime ? 'script' : 
                                      (isCssByUrl || isCssByMime ? 'stylesheet' : resourceType);
        resourceRelativePath = await saveResource(url, effectiveResourceType, responseHeaders);
        
        if (resourceRelativePath) {
          log.debug(`Resource saved via detection: ${url} (type: ${effectiveResourceType})`);
        }
        
        // 静态资源关联由 post-process-correlation.js 脚本在录制结束后统一完成
        // 这里只保存资源文件，不进行实时关联
      }
      
      // 记录API响应
      if (resourceType === 'xhr' || resourceType === 'fetch') {
        const timestamp = Date.now();
        
        // 下载API响应体
        let responseBody = null;
        let responseBodyPath = null;
        try {
          const fetchResponse = await fetch(url, {
            method: details.method,
            headers: details.requestHeaders
          });
          
          if (fetchResponse.ok) {
            const contentType = responseHeaders['content-type']?.[0] || responseHeaders['Content-Type']?.[0] || '';
            
            if (contentType.includes('application/json')) {
              responseBody = await fetchResponse.json();
            } else if (contentType.includes('text/')) {
              responseBody = await fetchResponse.text();
            } else {
              // 尝试读取为文本（处理 content-type 不准确的情况）
              try {
                const textContent = await fetchResponse.clone().text();
                // 如果文本内容看起来是有效的文本数据（不是乱码），保存为文本
                if (textContent && textContent.length < 1024 * 1024) { // 小于 1MB
                  responseBody = textContent;
                } else {
                  // 二进制数据保存为文件
                  const buffer = Buffer.from(await fetchResponse.arrayBuffer());
                  const apiBodiesDir = path.join(globalState.currentTask.dir, 'network', 'api_bodies');
                  if (!fs.existsSync(apiBodiesDir)) {
                    fs.mkdirSync(apiBodiesDir, { recursive: true });
                  }
                  const safeFileName = `${timestamp}_${path.basename(new URL(url).pathname).replace(/[^a-zA-Z0-9.-]/g, '_') || 'response'}`;
                  const bodyFilePath = path.join(apiBodiesDir, safeFileName);
                  fs.writeFileSync(bodyFilePath, buffer);
                  responseBodyPath = path.join('network', 'api_bodies', safeFileName);
                }
              } catch (textError) {
                // 如果文本读取失败，保存为二进制文件
                const buffer = Buffer.from(await fetchResponse.arrayBuffer());
                const apiBodiesDir = path.join(globalState.currentTask.dir, 'network', 'api_bodies');
                if (!fs.existsSync(apiBodiesDir)) {
                  fs.mkdirSync(apiBodiesDir, { recursive: true });
                }
                const safeFileName = `${timestamp}_${path.basename(new URL(url).pathname).replace(/[^a-zA-Z0-9.-]/g, '_') || 'response'}`;
                const bodyFilePath = path.join(apiBodiesDir, safeFileName);
                fs.writeFileSync(bodyFilePath, buffer);
                responseBodyPath = path.join('network', 'api_bodies', safeFileName);
              }
            }
          }
        } catch (error) {
          log.warn(`Failed to fetch API response body for ${url}:`, error.message);
        }
        
        globalState.apiResponses.set(url, {
          status: statusCode,
          headers: responseHeaders,
          timestamp: timestamp,
          body: responseBody,
          bodyPath: responseBodyPath
        });

        // 注意：API流量日志现在由 UnifiedEventManager.associateRequest 统一写入
        // webRequest.onCompleted 路径通过 UnifiedEventManager 关联请求，确保 eventId 正确记录
        
        // 将请求与对应的事件关联
        // 使用 Date.now() 作为统一的时间戳，避免 Chrome 时间戳和 JS 时间戳的偏差
        const requestTimestamp = Date.now();
        const requestEndTime = Date.now();
        
        // 查找对应的请求 body
        let requestBody = null;
        const requestBodyKey = `${url}_${requestTimestamp}`;
        // 在 requestBodyMap 中查找最近 5 秒内匹配的请求 body
        for (const [key, value] of requestBodyMap.entries()) {
          if (key.startsWith(url) && Math.abs(value.timestamp - requestTimestamp) < 5000) {
            requestBody = value.body;
            // 找到后删除，避免重复关联
            requestBodyMap.delete(key);
            break;
          }
        }
        
        // 创建 API 请求对象
        const apiRequest = {
          url: url,
          method: details.method,
          status: statusCode,
          timestamp: requestTimestamp,
          duration: requestEndTime - requestTimestamp,
          resourceType: resourceType,
          requestBody: requestBody,  // 请求 body
          responseHeaders: responseHeaders,
          references: {
            apiResponsesKey: url,  // api_responses.json 中的 key
            resourcePath: resourceRelativePath,  // resources/ 目录中的文件路径
            responseBodyPath: responseBodyPath   // api_bodies/ 目录中的文件路径
          }
        };
        
        // 首先尝试通过 UnifiedEventManager 关联请求（使用 eventId）
        // 这是首选方案，符合重构的设计目标
        if (globalState.unifiedEventManager) {
          const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          const result = globalState.unifiedEventManager.associateRequest(null, {
            requestId: requestId,
            type: resourceType === 'xhr' ? 'xhr' : 'fetch',
            url: url,
            method: details.method,
            status: statusCode,
            startTime: requestTimestamp,
            endTime: requestEndTime,
            duration: requestEndTime - requestTimestamp,
            body: requestBody,
            responseBody: responseBody
          });

          if (result) {
            log.info('WebRequest associated via UnifiedEventManager:', url);
          } else {
            log.debug('WebRequest failed to associate via UnifiedEventManager, buffering:', url);
          }
        }

        // 将请求加入缓冲队列，作为备用关联方案
        // 实际关联由 post-process-correlation.js 脚本在录制结束后完成
        requestBuffer.push(apiRequest);
        log.debug('WebRequest buffered:', url, 'timestamp:', requestTimestamp, 'hasBody:', !!requestBody);
      }
    }
  });

  // 拦截 XHR/fetch 请求以捕获请求 body
  session.webRequest.onBeforeRequest((details, callback) => {
    // 只有在录制中且未暂停时才记录
    if (globalState.isRecording && globalState.currentTask && !globalState.isPaused) {
      if (details.resourceType === 'xhr' || details.resourceType === 'fetch') {
        // 捕获请求 body
        if (details.uploadData && details.uploadData.length > 0) {
          try {
            // 合并所有数据块
            const chunks = details.uploadData.map(data => data.bytes).filter(Boolean);
            const totalSize = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
            
            // 检查大小限制
            if (totalSize > 0 && totalSize <= REQUEST_BODY_MAX_SIZE) {
              const bodyBuffer = Buffer.concat(chunks);
              const bodyString = bodyBuffer.toString('utf-8');
              
              // 尝试解析为 JSON
              let parsedBody = null;
              try {
                parsedBody = JSON.parse(bodyString);
              } catch {
                // 不是 JSON，保存为字符串
                parsedBody = bodyString;
              }
              
              // 存储到临时 map，使用 URL + timestamp 作为 key
              const key = `${details.url}_${Date.now()}`;
              requestBodyMap.set(key, {
                body: parsedBody,
                rawBody: bodyString,
                size: totalSize,
                timestamp: Date.now()
              });
              
              // 清理过期的请求 body
              const cutoff = Date.now() - REQUEST_BODY_TTL;
              for (const [k, v] of requestBodyMap.entries()) {
                if (v.timestamp < cutoff) {
                  requestBodyMap.delete(k);
                }
              }
              
              log.debug('Request body captured:', details.url, 'size:', totalSize);
            } else if (totalSize > REQUEST_BODY_MAX_SIZE) {
              log.warn('Request body too large, skipped:', details.url, 'size:', totalSize);
            }
          } catch (err) {
            log.error('Failed to capture request body:', err);
          }
        }
      }
    }
    
    // 拦截文件请求（PDF、图片、文档等）
    if (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame') {
      const url = details.url.toLowerCase();
      
      // 检查URL是否指向用户下载的文件
      const filePatterns = [
        { ext: '.pdf', mimeType: 'application/pdf', type: 'document' },
        { ext: '.doc', mimeType: 'application/msword', type: 'document' },
        { ext: '.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', type: 'document' },
        { ext: '.xls', mimeType: 'application/vnd.ms-excel', type: 'spreadsheet' },
        { ext: '.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', type: 'spreadsheet' },
        { ext: '.ppt', mimeType: 'application/vnd.ms-powerpoint', type: 'presentation' },
        { ext: '.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', type: 'presentation' },
        { ext: '.zip', mimeType: 'application/zip', type: 'archive' },
        { ext: '.rar', mimeType: 'application/x-rar-compressed', type: 'archive' },
        { ext: '.7z', mimeType: 'application/x-7z-compressed', type: 'archive' },
        { ext: '.mp4', mimeType: 'video/mp4', type: 'video' },
        { ext: '.webm', mimeType: 'video/webm', type: 'video' },
        { ext: '.mp3', mimeType: 'audio/mpeg', type: 'audio' },
        { ext: '.wav', mimeType: 'audio/wav', type: 'audio' }
      ];
      
      const matchedPattern = filePatterns.find(pattern => url.endsWith(pattern.ext));

      if (matchedPattern) {
        log.info(`Tab file detected: ${details.url} (${matchedPattern.type})`);

        // 只有在录制中且未暂停时才记录
        if (globalState.isRecording && globalState.currentTask && !globalState.isPaused) {
          // 记录文件事件
          globalState.unifiedEventManager.createAndFlushEvent({
            type: 'file_io',
            fileType: 'preview',
            url: details.url,
            windowId: windowId,
            localPath: null,
            contentSummary: `${matchedPattern.type.toUpperCase()} detected: ${details.url}`,
            metadata: {
              fileName: path.basename(details.url),
              mimeType: matchedPattern.mimeType
            }
          });
        }
      }
    }

    callback({});
  });

  // 拦截响应以捕获各种文件内容和mainFrame HTML
  session.webRequest.onHeadersReceived((details, callback) => {
    const contentType = details.responseHeaders['content-type'] || details.responseHeaders['Content-Type'];

    if (contentType && contentType[0]) {
      const mimeType = contentType[0].toLowerCase();
      
      // 捕获 mainFrame HTML 内容
      if (details.resourceType === 'mainFrame' && mimeType.includes('text/html')) {
        // HTML 内容会在 onCompleted 中通过 saveResource 保存
        log.debug('Tab mainFrame HTML detected:', details.url);
      }
    }

    callback({});
  });
}

// 设置下载处理器
function setupDownloadHandler(browserWindow) {
  browserWindow.webContents.session.on('will-download', (event, item, webContents) => {
    const fileName = item.getFilename();
    const totalBytes = item.getTotalBytes();

    // 如果正在录制且未暂停，保存到任务目录
    if (globalState.isRecording && globalState.currentTask && !globalState.isPaused) {
      const downloadsDir = path.join(globalState.currentTask.dir, 'downloads');
      if (!fs.existsSync(downloadsDir)) {
        fs.mkdirSync(downloadsDir, { recursive: true });
      }
      
      const filePath = path.join(downloadsDir, fileName);
      item.setSavePath(filePath);
      
      // 记录下载事件 - 使用统一事件格式
      globalState.unifiedEventManager.createAndFlushEvent({
        type: 'file_io',
        fileType: 'download',
        url: item.getURL(),
        windowId: `win_${browserWindow.id}`,
        localPath: path.join('downloads', fileName),
        metadata: {
          fileName: fileName,
          fileSize: totalBytes,
          mimeType: item.getMimeType()
        }
      });
      
      item.once('done', (event, state) => {
        if (state === 'completed') {
          log.info(`Download completed: ${fileName}`);
        } else {
          log.error(`Download failed: ${fileName}`);
        }
      });
    }
  });
}

// 磁盘空间监控
function checkDiskSpace() {
  try {
    // 如果 STORAGE_PATH 未设置，跳过检查
    if (!STORAGE_PATH) {
      return true;
    }
    const stats = fs.statSync(STORAGE_PATH);
    const freeSpace = getFreeSpace(STORAGE_PATH);
    
    if (freeSpace < 2 * 1024 * 1024 * 1024) { // 2GB
      log.warn('Disk space low, pausing recording');
      
      if (globalState.isRecording) {
        stopRecording();
        
        dialog.showMessageBox({
          type: 'warning',
          title: '磁盘空间不足',
          message: '可用空间少于2GB，录制已自动暂停。请清理磁盘空间后继续。'
        });
      }
      
      return false;
    }
    
    return true;
  } catch (error) {
    log.error('Failed to check disk space:', error);
    return true;
  }
}

// 获取磁盘可用空间
function getFreeSpace(directory) {
  try {
    if (process.platform === 'win32') {
      const { execSync } = require('child_process');
      // 获取盘符，例如 C:\ -> C:
      const root = path.parse(directory).root;
      const driveLetter = root.charAt(0).toUpperCase() + ':';

      log.info('Checking free space for drive:', driveLetter);

      // 使用 wmic 获取磁盘空间
      const output = execSync(`wmic logicaldisk where "DeviceID='${driveLetter}'" get FreeSpace`, { encoding: 'utf-8' });
      const lines = output.trim().split('\n');
      if (lines.length > 1) {
        const freeSpace = parseInt(lines[1].trim());
        log.info('Free space on', driveLetter, ':', freeSpace, 'bytes');
        return freeSpace;
      }
    } else {
      const { execSync } = require('child_process');
      const output = execSync(`df -k "${directory}" | tail -1 | awk '{print $4}'`, { encoding: 'utf-8' });
      return parseInt(output.trim()) * 1024;
    }
  } catch (error) {
    log.error('Failed to get free space:', error);
    // 返回无限空间，让应用继续运行
    return Infinity;
  }
}

// 生成 readme.md 内容
function generateReadmeContent(taskConfig, taskId, taskDirName) {
  const now = new Date().toISOString();
  const options = taskConfig.options || {};
  
  return `# Task 录制数据说明

## 任务基本信息

- **任务ID**: ${taskDirName}
- **目标网站**: ${taskConfig.url || '未指定'}
- **录制时间**: ${now}
- **操作员**: ${taskConfig.userId || taskConfig.operator || process.env.USER || 'anonymous'}
- **任务类型**: 网页浏览与交互录制

## 录制配置

- **录制视频**: ${options.recordVideo ? '✅ 启用' : '❌ 禁用'}
- **捕获 DOM**: ${options.captureDOM ? '✅ 启用' : '❌ 禁用'}
- **捕获 API**: ${options.captureAPI ? '✅ 启用' : '❌ 禁用'}
- **捕获状态**: ${options.captureState ? '✅ 启用' : '❌ 禁用'}
- **生成截图**: ${options.captureScreenshots ? '✅ 启用' : '❌ 禁用'}

## 目录结构说明

\`\`\`
${taskDirName}/
├── training_manifest.jsonl    # 核心事件日志文件（黄金数据）
├── metadata.json              # 任务元数据
├── task_config.json           # 任务配置
├── readme.md                  # 本说明文件
├── video/                     # 录制视频文件
│   └── recording.mp4          # 屏幕录制视频
├── dom/                       # DOM 快照文件
│   ├── rrweb_events.json      # rrweb 格式 DOM 事件序列
│   └── snapshot_*.json        # 各时间点的 DOM 快照
├── network/                   # 网络数据
│   ├── resources/             # 静态资源文件（JS/CSS/图片等）
│   ├── api_responses.json     # API 响应数据
│   ├── api_traffic.jsonl      # API 流量日志
│   └── request_correlation.jsonl  # 请求关联日志
├── downloads/                 # 下载文件（PDF/文档等）
├── uploads/                   # 上传文件
├── previews/                  # 预览截图
│   └── snapshots/             # 页面截图（如启用截图功能）
├── sandbox/                   # 浏览器状态数据
│   └── lineage.json           # 事件血缘关系
└── logs/                      # 日志文件
    └── errors.json            # 错误日志
\`\`\`

## 数据文件详细说明

### 1. training_manifest.jsonl（核心文件）

**作用**: 记录所有用户操作、页面状态、网络请求等事件的完整信息

**内容**: 
- 用户操作事件（click、scroll、input 等）
- 页面加载事件（page-load-start、page-load-complete）
- 网络请求数据（XHR、fetch、WebSocket 等）
- 页面状态信息（fingerprint、DOM 统计等）
- 事件血缘关系（previous_event_id、next_event_id）

**使用场景**:
- 页面自动化测试脚本生成
- 用户行为分析与产品迭代
- 页面功能问答知识库建设
- 操作流程回放与验证

### 2. dom/ 目录

**rrweb_events.json**: 
- rrweb 格式的 DOM 变更序列
- 用于完整回放页面变化过程

**snapshot_*.json**:
- 特定时间点的完整 DOM 快照
- 与 training_manifest.jsonl 中的事件通过时间戳关联
- 用于分析特定操作时的页面状态

### 3. network/ 目录

**resources/**:
- 页面加载的静态资源（JS、CSS、图片、字体等）
- 用于离线分析页面依赖

**api_responses.json**:
- API 接口的响应数据
- 用于分析前后端交互

**api_traffic.jsonl**:
- API 请求流量日志
- 用于性能分析和接口监控

### 4. video/ 目录

**recording.mp4**:
- 屏幕录制视频
- 用于人工审核和可视化回放

## 数据使用建议

### 1. 页面产品迭代
- 分析 \`training_manifest.jsonl\` 中的用户操作路径
- 查看 \`dom/\` 目录下的 DOM 快照了解页面结构
- 结合 \`network/resources/\` 分析页面资源加载

### 2. 页面自动化测试
- 基于 \`training_manifest.jsonl\` 生成测试脚本
- 使用 \`domSnapshotPath\` 关联的 DOM 快照进行断言
- 参考 \`network/api_responses.json\` 模拟接口响应

### 3. 页面功能问答
- 提取 \`training_manifest.jsonl\` 中的操作序列作为知识库
- 结合 DOM 快照说明功能点的页面位置
- 使用视频文件进行可视化说明

### 4. 页面知识库建设
- 整理页面加载的静态资源清单
- 记录 API 接口的调用关系
- 建立事件血缘关系图谱

## 技术说明

- **录制工具**: sentinel-browser (基于 Electron)
- **DOM 序列化**: rrweb 标准
- **数据格式**: JSON Lines (JSONL)
- **视频编码**: H.264

---

*Generated by Sentinel Browser Recording System*
`;
}

// 开始录制
async function startRecording(taskConfig = {}) {
  if (globalState.isRecording) {
    throw new Error('Recording already in progress');
  }

  // 确保 STORAGE_PATH 已设置（Windows 在 IPC handler 中已处理）
  if (!STORAGE_PATH) {
    STORAGE_PATH = getDefaultStoragePath();
    if (!fs.existsSync(STORAGE_PATH)) {
      fs.mkdirSync(STORAGE_PATH, { recursive: true });
    }
  }

  // 检查磁盘空间
  if (!checkDiskSpace()) {
    throw new Error('Insufficient disk space');
  }

  // 生成任务ID和时间戳
  const timestamp = Date.now();
  // 如果提供了 id，直接使用；否则生成新的 task_id
  const taskId = taskConfig.id || `task_${timestamp}`;

  // 将 taskId 添加到 taskConfig，以便 UnifiedEventManager 可以访问
  taskConfig.id = taskId;
  taskConfig.taskId = taskId;

  // 添加用户信息的默认值（如果未提供）
  taskConfig.userId = taskConfig.userId || taskConfig.operator || process.env.USER || 'anonymous';
  taskConfig.role = taskConfig.role || 'operator';
  taskConfig.permissions = taskConfig.permissions || ['record', 'playback'];
  taskConfig.subTaskId = taskConfig.subTaskId || null;
  taskConfig.env = taskConfig.env || { platform: process.platform };

  // 构建友好的目录名：task_{任务名称}_{网页地址}_{taskId}
  // 清理任务名称和URL，移除非法字符
  const safeTaskName = (taskConfig.name || 'unnamed').replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_').substring(0, 30);
  const safeUrl = (taskConfig.url || 'no-url').replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9.-]/g, '_').substring(0, 30);
  const shortTaskId = taskId.replace(/^task_/, '').substring(0, 13); // 使用timestamp部分

  const taskDirName = `task_${safeTaskName}_${safeUrl}_${shortTaskId}`;
  const taskDir = path.join(STORAGE_PATH, taskDirName);

  log.info('Creating task directory:', taskDir);
  log.info('STORAGE_PATH:', STORAGE_PATH);
  log.info('Current user:', process.env.USER);
  log.info('Platform:', process.platform);

  // 创建任务目录结构（按照新设计规范）
  try {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.mkdirSync(path.join(taskDir, 'video'), { recursive: true });
    fs.mkdirSync(path.join(taskDir, 'network'), { recursive: true });
    fs.mkdirSync(path.join(taskDir, 'network', 'resources'), { recursive: true });
    fs.mkdirSync(path.join(taskDir, 'previews'), { recursive: true });
    fs.mkdirSync(path.join(taskDir, 'previews', 'snapshots'), { recursive: true });
    fs.mkdirSync(path.join(taskDir, 'sandbox'), { recursive: true });
    fs.mkdirSync(path.join(taskDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(taskDir, 'dom'), { recursive: true });
    fs.mkdirSync(path.join(taskDir, 'downloads'), { recursive: true });
    fs.mkdirSync(path.join(taskDir, 'uploads'), { recursive: true });
    log.info('Task directories created successfully');
    
    // 创建 readme.md 文件
    const readmeContent = generateReadmeContent(taskConfig, taskId, taskDirName);
    fs.writeFileSync(path.join(taskDir, 'readme.md'), readmeContent);
    log.info('readme.md created successfully');
  } catch (mkdirError) {
    log.error('Failed to create task directories:', mkdirError);
    log.error('Error code:', mkdirError.code);
    log.error('Error path:', mkdirError.path);
    throw new Error(`Failed to create task directory: ${mkdirError.message}`);
  }

  globalState.currentTask = {
    id: taskId,
    dir: taskDir,
    dirName: taskDirName,
    config: taskConfig,
    startTime: timestamp,
    events: []
  };

  // 初始化数据Schema管理器
  globalState.dataSchemaManager.setCurrentTask(globalState.currentTask);

  globalState.isRecording = true;
  
  // 重置初始 DOM snapshot 标志，确保新任务开始时能正确保存初始快照
  globalState.initialSnapshotSaved = false;

  // 重置 pendingEvents 和 flushedEvents（确保新任务开始时状态正确）
  globalState.pendingEvents = [];
  globalState.flushedEvents = new Map();
  log.info('[startRecording] Reset pendingEvents and flushedEvents');

  // 清空动态资源列表
  clearDynamicResources();

  // 打开 training_manifest.jsonl（黄金文件，取代原 user_actions）
  const manifestPath = path.join(taskDir, 'training_manifest.jsonl');
  
  // Windows: 不使用流写入，完全使用同步写入避免冲突
  if (process.platform === 'win32') {
    // 确保文件存在
    if (!fs.existsSync(manifestPath)) {
      fs.writeFileSync(manifestPath, '');
    }
    // 创建一个虚拟流对象，用于兼容代码
    globalState.manifestStream = {
      write: () => {},
      end: () => {},
      uncork: () => {}
    };
  } else {
    globalState.manifestStream = fs.createWriteStream(manifestPath, { flags: 'a' });
  }

  // 打开API流量日志
  const apiLogPath = path.join(taskDir, 'network', 'api_traffic.jsonl');
  globalState.apiLogStream = fs.createWriteStream(apiLogPath, { flags: 'a' });

  // 打开实时关联日志（用于保存 WebRequest 与事件的关联关系）
  const correlationLogPath = path.join(taskDir, 'network', 'request_correlation.jsonl');
  globalState.correlationLogStream = fs.createWriteStream(correlationLogPath, { flags: 'a' });

  // 打开控制台错误日志
  const consoleErrorPath = path.join(taskDir, 'logs', 'console_errors.jsonl');
  globalState.consoleErrorStream = fs.createWriteStream(consoleErrorPath, { flags: 'a' });

  // 初始化统一事件管理器（基于因果关系链）
  globalState.unifiedEventManager = new UnifiedEventManager({
    maxCacheSize: 10000,      // 最大缓存1万个事件
    maxRetries: 3,            // 写入重试3次
    retryDelay: 100,          // 重试延迟100ms
    onMaxCacheReached: () => {
      // 自动结束录制（缓存达到1万事件）
      log.error('[startRecording] Max event cache reached (10000), auto-stopping recording');
      stopRecording().catch(err => {
        log.error('[startRecording] Failed to auto-stop recording:', err);
      });
    }
  });
  globalState.unifiedEventManager.initialize(taskDir, globalState.manifestStream, globalState.correlationLogStream, globalState.apiLogStream, taskConfig);
  log.info('[startRecording] UnifiedEventManager initialized with maxCacheSize: 10000');

  // 创建 metadata.json
  const metadata = {
    task_id: taskId,
    timestamp: timestamp,
    user_id: taskConfig.userId || 'anonymous',
    role: taskConfig.role || 'unknown',
    os: process.platform,
    os_version: process.getSystemVersion ? process.getSystemVersion() : 'unknown',
    browser_version: process.versions.electron,
    node_version: process.versions.node,
    chromium_version: process.versions.chrome,
    task_name: taskConfig.name || taskId,
    start_url: taskConfig.url || null,
    created_at: new Date().toISOString()
  };
  fs.writeFileSync(
    path.join(taskDir, 'metadata.json'),
    JSON.stringify(metadata, null, 2)
  );

  // 保存任务配置到 task_config.json
  fs.writeFileSync(
    path.join(taskDir, 'task_config.json'),
    JSON.stringify(taskConfig, null, 2)
  );

  // 记录任务开始事件
  log.info('[startRecording] Generating task_start event...');
  const startEvent = globalState.unifiedEventManager.createAndFlushEvent({
    type: 'user_context',
    contextType: 'task_start',
    description: `Task started: ${taskConfig.name || taskId}`,
    semanticLabel: `Task started: ${taskConfig.name || taskId}`,
    taskId: taskId,
    subTaskId: taskConfig.subTaskId || null,
    userId: taskConfig.userId || null,
    role: taskConfig.role || null,
    permissions: taskConfig.permissions || [],
    env: taskConfig.env || null
  });
  log.info('[startRecording] Task start event generated:', startEvent?.type, 'timestamp:', startEvent?.timestamp, 'video_time:', startEvent?.video_time);
  log.info('[startRecording] Task start event appended to manifest');

  // 视频录制现在在 renderer 进程中完成
  // 主进程只负责视频转换
  log.info('Video recording will be handled by renderer process');

  // Watchdog 已禁用，避免启动警告
  // globalState.watchdogManager.start();

  // 修复：启动录制时重置活动时间，避免立即触发无活动停止
  updateActivityTime();
  log.info('[startRecording] Activity time reset');

  // 启动非活动监控
  startInactivityWatchdog();

  // 启动磁盘空间监控
  startDiskSpaceMonitor();

  log.info(`Recording started: ${taskId}`);

  // 通知所有窗口
  globalState.windows.forEach(({ window }) => {
    window.webContents.send('recording-started', { taskId });
  });

  return taskId;
}

// 停止录制
async function stopRecording() {
  if (!globalState.isRecording) {
    return;
  }

  // 修复：在关闭流之前先记录 task_stop 事件
  // 保存任务数据（在关闭流之前）
  if (globalState.currentTask) {
    // 记录任务结束事件（必须在关闭 manifestStream 之前）
    if (globalState.unifiedEventManager) {
      globalState.unifiedEventManager.createAndFlushEvent({
        type: 'user_context',
        contextType: 'task_stop',
        description: `Task stopped: ${globalState.currentTask.id}`,
        semanticLabel: `Task stopped: ${globalState.currentTask.id}`
      });
      log.info('[stopRecording] Task stop event appended to manifest');
    }
  }

  globalState.isRecording = false;

  // 清空已下载的 PDF 集合
  globalState.downloadedPdfs.clear();

  // 清空 DOM 快照序列记录
  globalState.scrollSequenceSnapshots.clear();
  globalState.lastDOMSnapshotTime = 0;

  // 视频录制在 renderer 进程中完成，主进程不需要停止录制
  log.info('Video recording stopped by renderer process');

  // Watchdog 已禁用
  // globalState.watchdogManager.stop();

  // 清除非活动定时器
  if (globalState.inactivityTimer) {
    clearTimeout(globalState.inactivityTimer);
    globalState.inactivityTimer = null;
  }

  // 停止 EventAssociationManager（确保所有数据写入）
  if (globalState.associationManager) {
    await globalState.associationManager.stop();
    globalState.associationManager = null;
  }

  // 修复：停止 UnifiedEventManager，确保 regenerateManifest 被执行
  if (globalState.unifiedEventManager) {
    await globalState.unifiedEventManager.stop();
    globalState.unifiedEventManager = null;
  }

  // 关闭 training_manifest.jsonl 流
  if (globalState.manifestStream) {
    globalState.manifestStream.end();
    globalState.manifestStream = null;
  }

  // 关闭 api_traffic.jsonl 流
  if (globalState.apiLogStream) {
    globalState.apiLogStream.end();
    globalState.apiLogStream = null;
  }

  // 关闭关联日志流
  if (globalState.correlationLogStream) {
    globalState.correlationLogStream.end();
    globalState.correlationLogStream = null;
  }

  // 关闭 console_errors.jsonl 流
  if (globalState.consoleErrorStream) {
    globalState.consoleErrorStream.end();
    globalState.consoleErrorStream = null;
  }

  // 保存任务数据（其他文件）
  if (globalState.currentTask) {

    // 保存API响应到 network 目录
    const apiResponsesDir = path.join(globalState.currentTask.dir, 'network');
    if (!fs.existsSync(apiResponsesDir)) {
      fs.mkdirSync(apiResponsesDir, { recursive: true });
    }
    const apiResponsesPath = path.join(apiResponsesDir, 'api_responses.json');
    const apiResponses = {};
    globalState.apiResponses.forEach((value, key) => {
      apiResponses[key] = value;
    });
    fs.writeFileSync(apiResponsesPath, JSON.stringify(apiResponses, null, 2));

    // 保存动态资源到 network 目录
    saveDynamicResources(globalState.currentTask.dir);

    // 保存谱系数据到 sandbox 目录
    const lineagePath = path.join(globalState.currentTask.dir, 'sandbox', 'lineage.json');
    fs.writeFileSync(lineagePath, JSON.stringify(globalState.lineageTracker.exportLineage(), null, 2));

    // 保存错误报告到 logs 目录
    const errorPath = path.join(globalState.currentTask.dir, 'logs', 'errors.json');
    fs.writeFileSync(errorPath, JSON.stringify(globalState.errorDetector.exportErrors(), null, 2));

    // 保存浏览器状态（IndexedDB, Cookies, LocalStorage）到 sandbox 目录
    if (globalState.stateManager && globalState.windows.size > 0) {
      try {
        // 获取第一个窗口的 webContents
        const firstWindow = globalState.windows.values().next().value;
        if (firstWindow && firstWindow.window) {
          const state = await globalState.stateManager.captureState(firstWindow.window.webContents);
          if (state) {
            globalState.stateManager.saveStateToTask(globalState.currentTask.dir, state);
            
            // 保存浏览器状态关联到 correlation log（关联到 task_stop 事件）
            const stopEventTimestamp = Date.now();
            const browserStateData = {
              url: state.url,
              title: state.title,
              localStorageKeys: Object.keys(state.localStorage || {}),
              sessionStorageKeys: Object.keys(state.sessionStorage || {}),
              cookieCount: (state.cookies || []).length,
              indexedDBDatabases: Object.keys(state.indexedDB || {})
            };
            
            if (globalState.associationManager) {
              globalState.associationManager.writeCorrelationLog(stopEventTimestamp, 'browser_state', browserStateData);
            } else {
              saveCorrelationLog(stopEventTimestamp, browserStateData, 'browser_state');
            }
          }
        }
      } catch (error) {
        log.error('Failed to capture browser state:', error);
      }
    }

    log.info(`Recording stopped: ${globalState.currentTask.id}`);

    // 重新生成 manifest 文件，确保所有网络请求关联都被写入
    regenerateManifestFile(globalState.currentTask.dir);

    // 异步运行后处理关联脚本，支持进度报告
    const runCorrelationWithProgress = async () => {
      // 根据是否打包选择正确的脚本路径
      // 开发环境：使用源码目录
      // 打包后：使用 extraResources 目录 (process.resourcesPath)
      const isPackaged = app.isPackaged;
      let scriptPath;
      if (isPackaged) {
        // 打包后，脚本在 resources/scripts/ 目录
        scriptPath = path.join(process.resourcesPath, 'scripts', 'post-process-correlation.js');
      } else {
        // 开发环境，脚本在项目根目录的 scripts/ 目录
        scriptPath = path.join(__dirname, '..', '..', 'scripts', 'post-process-correlation.js');
      }
      
      log.info('Looking for correlation script at:', scriptPath);
      
      if (!fs.existsSync(scriptPath)) {
        log.warn('Post-process correlation script not found at:', scriptPath);
        return { success: false, error: 'Script not found' };
      }

      return new Promise((resolve, reject) => {
        const { spawn } = require('child_process');
        
        // 在 Electron 中以 Node.js 模式运行脚本
        // 使用 ELECTRON_RUN_AS_NODE=1 让 Electron 像 Node.js 一样运行
        const electronPath = process.execPath;
        log.info('Running script with Electron as Node:', electronPath);
        
        const child = spawn(electronPath, [scriptPath, globalState.currentTask.dir], {
          stdio: ['inherit', 'pipe', 'pipe'],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => {
          stdout += data.toString();
          
          // 解析进度信息
          const lines = data.toString().split('\n');
          for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;
            
            try {
              const message = JSON.parse(trimmedLine);
              if (message.type === 'progress') {
                // 发送进度到所有窗口
                globalState.windows.forEach(({ window }) => {
                  window.webContents.send('correlation-progress', {
                    stage: message.stage,
                    current: message.current,
                    total: message.total,
                    percent: message.percent,
                    message: message.message
                  });
                });
              } else if (message.type === 'complete') {
                // 关联完成
                resolve(message);
              }
            } catch (e) {
              // 不是 JSON 格式，记录日志
              log.info('[Correlation]', trimmedLine);
            }
          }
        });

        child.stderr.on('data', (data) => {
          stderr += data.toString();
          log.error('[Correlation]', data.toString());
        });

        child.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`Correlation script exited with code ${code}: ${stderr}`));
          }
        });

        // 设置超时
        setTimeout(() => {
          child.kill();
          reject(new Error('Correlation script timeout'));
        }, 60000);
      });
    };

    // 发送开始关联的消息
    globalState.windows.forEach(({ window }) => {
      window.webContents.send('correlation-started', {
        taskId: globalState.currentTask.id
      });
    });

    // 给渲染进程一些时间显示进度条
    await new Promise(resolve => setTimeout(resolve, 100));

    try {
      const result = await runCorrelationWithProgress();
      log.info('Post-process correlation completed:', result);
      
      // 关联完成后，通知所有窗口
      globalState.windows.forEach(({ window }) => {
        window.webContents.send('recording-stopped', {
          taskId: globalState.currentTask.id,
          duration: Date.now() - globalState.currentTask.startTime,
          correlationResult: result
        });
      });
    } catch (error) {
      log.error('Failed to run post-process correlation:', error);
      
      // 即使关联失败，也要通知录制停止
      globalState.windows.forEach(({ window }) => {
        window.webContents.send('recording-stopped', {
          taskId: globalState.currentTask.id,
          duration: Date.now() - globalState.currentTask.startTime,
          correlationError: error.message
        });
      });
    }

    // 上传日志到服务器
    try {
      if (globalState.logUploader) {
        log.info('[Main] Uploading logs to server...');
        
        // 使用 app.getPath('logs') 获取当前日志目录（可能与logDir不同）
        const currentLogDir = app.getPath('logs');
        log.info('[Main] Current log directory:', currentLogDir);
        
        const taskInfo = {
          id: globalState.currentTask.id,
          name: globalState.currentTask.config?.name || 'unknown',
          url: globalState.currentTask.config?.url || 'unknown',
          duration: Date.now() - globalState.currentTask.startTime
        };
        const uploadResults = await globalState.logUploader.uploadTaskLogs(currentLogDir, taskInfo);
        log.info('[Main] Log upload results:', uploadResults);
      }
    } catch (uploadError) {
      log.error('[Main] Failed to upload logs:', uploadError.message);
    }

    // 清空当前任务
    globalState.currentTask = null;
  }
}

/**
 * 从视频中截取所有需要的帧
 * 根据 training_manifest.jsonl 中的 video_time 字段截取对应时间的帧
 * @param {string} taskDir - 任务目录
 * @param {string} videoPath - 视频文件路径
 */
async function extractSnapshotsFromVideo(taskDir, videoPath) {
  if (!globalState.ffmpegManager) {
    log.warn('FFmpeg manager not available, skipping snapshot extraction');
    return;
  }

  const manifestPath = path.join(taskDir, 'training_manifest.jsonl');
  const snapshotsDir = path.join(taskDir, 'previews', 'snapshots');

  // 确保截图目录存在
  if (!fs.existsSync(snapshotsDir)) {
    fs.mkdirSync(snapshotsDir, { recursive: true });
  }

  // 读取 manifest 文件
  if (!fs.existsSync(manifestPath)) {
    log.warn('Manifest file not found, skipping snapshot extraction');
    return;
  }

  const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
  const lines = manifestContent.split('\n').filter(line => line.trim());

  // 收集需要截取的事件和对应的 video_time
  const framesToExtract = [];

  for (const line of lines) {
    try {
      const event = JSON.parse(line);

      // 修复：支持新旧两种格式的 snapshotFileName
      // 旧格式: event._metadata.snapshotFileName
      // 新格式: event.metadata.snapshotFileName
      const snapshotFileName = event._metadata?.snapshotFileName || event.metadata?.snapshotFileName;
      if (snapshotFileName) {
        // 从 video_time 计算时间（秒）
        // video_time 格式通常是 "HH:MM:SS.mmm" 或毫秒数
        let timeInSeconds = 0;

        if (typeof event.video_time === 'string') {
          // 解析 "HH:MM:SS.mmm" 格式
          const parts = event.video_time.split(':');
          if (parts.length === 3) {
            const hours = parseInt(parts[0], 10) || 0;
            const minutes = parseInt(parts[1], 10) || 0;
            const seconds = parseFloat(parts[2]) || 0;
            timeInSeconds = hours * 3600 + minutes * 60 + seconds;
          }
        } else if (typeof event.video_time === 'number') {
          // 如果是毫秒数，转换为秒
          timeInSeconds = event.video_time / 1000;
        }

        // 如果没有 video_time，使用 event.timestamp 计算相对时间
        if (timeInSeconds === 0 && event.timestamp && globalState.currentTask?.startTime) {
          timeInSeconds = (event.timestamp - globalState.currentTask.startTime) / 1000;
        }

        const outputPath = path.join(snapshotsDir, snapshotFileName);

        // 检查是否已存在（避免重复截取）
        if (!fs.existsSync(outputPath)) {
          framesToExtract.push({
            time: timeInSeconds,
            outputPath: outputPath,
            eventType: event.event_details?.action || 'unknown'
          });
        }
      }
    } catch (error) {
      log.warn('Failed to parse manifest line:', error.message);
    }
  }

  if (framesToExtract.length === 0) {
    log.info('No snapshots to extract from video');
    return;
  }

  log.info(`Extracting ${framesToExtract.length} snapshots from video...`);

  // 获取主窗口，用于发送进度通知
  const mainWindow = globalState.windows.size > 0 ? globalState.windows.values().next().value.window : null;

  // 发送开始处理通知
  if (mainWindow) {
    mainWindow.webContents.send('snapshot-extraction-progress', {
      status: 'started',
      total: framesToExtract.length,
      current: 0,
      percent: 0
    });
  }

  // 批量截取帧（带进度通知和容错机制）
  const results = [];
  for (let i = 0; i < framesToExtract.length; i++) {
    const frame = framesToExtract[i];
    let success = false;
    let error = null;

    // 首先尝试在指定时间截取
    try {
      await globalState.ffmpegManager.extractFrame(videoPath, frame.time, frame.outputPath, {
        quality: 2,
        format: 'png'
      });
      success = true;
    } catch (err) {
      log.warn(`Failed to extract frame at ${frame.time}s, trying with offset...`);

      // 如果失败，尝试提前 0.5 秒截取
      try {
        const adjustedTime = Math.max(0, frame.time - 0.5);
        await globalState.ffmpegManager.extractFrame(videoPath, adjustedTime, frame.outputPath, {
          quality: 2,
          format: 'png'
        });
        success = true;
        log.info(`Successfully extracted frame at adjusted time ${adjustedTime}s`);
      } catch (err2) {
        error = err2.message;
        log.error(`Failed to extract frame at ${frame.time}s (and adjusted time):`, error);
      }
    }

    results.push({ ...frame, success, error });

    // 发送进度通知
    const percent = Math.round(((i + 1) / framesToExtract.length) * 100);
    if (mainWindow) {
      mainWindow.webContents.send('snapshot-extraction-progress', {
        status: 'progress',
        total: framesToExtract.length,
        current: i + 1,
        percent: percent
      });
    }
  }

  // 统计结果
  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;

  log.info(`Snapshot extraction completed: ${successCount} success, ${failCount} failed`);

  // 记录失败的截图到日志文件
  const failedFrames = results.filter(r => !r.success);
  if (failedFrames.length > 0) {
    log.warn('Failed to extract frames:', failedFrames.map(f => `${f.time}s: ${f.error}`).join('; '));

    // 保存失败记录到文件
    try {
      const logPath = path.join(taskDir, 'snapshot_extraction_log.json');
      const logData = {
        timestamp: new Date().toISOString(),
        videoPath: videoPath,
        totalFrames: framesToExtract.length,
        successCount: successCount,
        failCount: failCount,
        failedFrames: failedFrames.map(f => ({
          time: f.time,
          outputPath: f.outputPath,
          error: f.error
        }))
      };
      fs.writeFileSync(logPath, JSON.stringify(logData, null, 2));
      log.info(`Snapshot extraction log saved to: ${logPath}`);
    } catch (logError) {
      log.error('Failed to save snapshot extraction log:', logError.message);
    }
  }

  // 发送完成通知
  if (mainWindow) {
    mainWindow.webContents.send('snapshot-extraction-progress', {
      status: 'completed',
      total: framesToExtract.length,
      current: successCount,
      percent: 100,
      success: successCount,
      failed: failCount
    });
  }
}

// 获取当前事件上下文信息（用于填充事件字段）
function getCurrentEventContext() {
  if (!globalState.currentTask) {
    return {
      taskId: null,
      subTaskId: null,
      userId: null,
      role: null,
      permissions: [],
      env: null,
      windowId: null,
      url: null
    };
  }

  const taskConfig = globalState.currentTask.config || {};
  
  // 获取当前活动窗口
  let currentWindowId = null;
  let currentUrl = null;
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (focusedWindow) {
    currentWindowId = `win_${focusedWindow.id}`;
    // 尝试获取URL
    try {
      focusedWindow.webContents.executeJavaScript('window.location.href').then(url => {
        currentUrl = url;
      }).catch(() => {});
    } catch (e) {}
  }

  return {
    taskId: globalState.currentTask.id,
    subTaskId: taskConfig.subTaskId || null,
    userId: taskConfig.userId || null,
    role: taskConfig.role || null,
    permissions: taskConfig.permissions || [],
    env: taskConfig.env || null,
    windowId: currentWindowId,
    url: currentUrl
  };
}

// 追加到manifest（原子写入）
function appendToManifest(event) {
  if (!globalState.isRecording || !globalState.manifestStream) {
    log.warn('[appendToManifest] Cannot append: isRecording=' + globalState.isRecording + ', manifestStream=' + !!globalState.manifestStream);
    return;
  }

  log.info('[appendToManifest] Appending event:', event.type || event.event_details?.action, 'timestamp:', event.timestamp);

  // 如果事件已经是完整Schema格式，直接使用
  // 否则需要包装成完整Schema格式
  let fullEvent = event;

  if (!event.window_context || !event.user_context) {
    log.info('[appendToManifest] Event missing window_context or user_context, regenerating...');
    // 使用DataSchemaManager生成完整事件
    if (globalState.dataSchemaManager) {
      fullEvent = globalState.dataSchemaManager.generateEvent(event.type || 'unknown', {
        ...event,
        windowId: event.windowId || `win_${event.sender?.id || 'unknown'}`,
        url: event.url || null,
        metadata: {
          ...event.metadata,
          snapshotFileName: event.snapshotFileName,
          snapshotPath: event.snapshotPath,
          domSnapshotFileName: event.domSnapshotFileName,
          domSnapshotPath: event.domSnapshotPath,
          tagName: event.tagName,
          text: event.text,
          title: event.title,
          inputType: event.inputType,
          value: event.value,
          key: event.key,
          scrollX: event.scrollX,
          scrollY: event.scrollY
        }
      });
      log.info('[appendToManifest] Event regenerated, action:', fullEvent.event_details?.action);
    }
  } else {
    log.info('[appendToManifest] Event already has full schema');
  }

  // 验证数据完整性
  if (globalState.dataSchemaManager && !globalState.dataSchemaManager.validateEvent(fullEvent)) {
    log.warn('[appendToManifest] Event validation failed, attempting to sanitize');
    fullEvent = globalState.dataSchemaManager.sanitizeEvent(fullEvent);
  } else {
    log.info('[appendToManifest] Event validation passed');
  }

  // 记录到 lineage tracker
  if (globalState.lineageTracker && fullEvent.window_context) {
    const windowId = fullEvent.window_context.window_id;
    const url = fullEvent.window_context.url;
    const title = fullEvent._metadata?.title || '';
    
    // 更新窗口 URL 和标题
    globalState.lineageTracker.updateWindowInfo(windowId, { url, title });
    
    // 记录事件
    globalState.lineageTracker.recordEvent(windowId, {
      type: fullEvent.event_details?.action || fullEvent.type || 'unknown',
      timestamp: fullEvent.timestamp,
      metadata: fullEvent._metadata || {}
    });
    
    // 保存谱系关联到 correlation log
    saveCorrelationLog(fullEvent.timestamp, {
      windowId: windowId,
      url: url,
      title: title,
      action: fullEvent.event_details?.action || fullEvent.type || 'unknown'
    }, 'lineage');
  }

  // 直接写入文件 - 简化实现，确保事件被写入
  const line = JSON.stringify(fullEvent) + '\n';
  
  // 使用同步写入确保事件立即落盘
  try {
    const manifestPath = path.join(globalState.currentTask.dir, 'training_manifest.jsonl');
    fs.appendFileSync(manifestPath, line);
    log.info('[appendToManifest] Event written to disk:', event.type || event.event_details?.action, 'timestamp:', fullEvent.timestamp);
  } catch (err) {
    log.error('[appendToManifest] Failed to write event:', err);
    // 回退到流写入
    globalState.manifestStream.write(line);
  }
}

// 资源路径映射（URL -> 相对路径）
const resourcePathMap = new Map();

// 保存资源文件
async function saveResource(url, resourceType, headers) {
  if (!globalState.isRecording || !globalState.currentTask) {
    return null;
  }

  try {
    const urlObj = new URL(url);
    const fileName = path.basename(urlObj.pathname) || `resource_${Date.now()}`;
    const existingExt = path.extname(fileName);
    const ext = existingExt || getExtensionByMimeType(headers);
    // 【修复】避免重复添加扩展名：如果 fileName 已有扩展名，不再添加
    const baseName = existingExt ? fileName.slice(0, -existingExt.length) : fileName;
    const safeFileName = `${Date.now()}_${baseName.replace(/[^a-zA-Z0-9.-]/g, '_')}${ext}`;
    
    const resourcesDir = path.join(globalState.currentTask.dir, 'network', 'resources');
    const filePath = path.join(resourcesDir, safeFileName);
    const relativePath = path.join('network', 'resources', safeFileName);

    // 下载资源
    const response = await fetch(url);
    if (!response.ok) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(filePath, buffer);

    // 保存映射关系
    resourcePathMap.set(url, relativePath);

    // 关联到最近的事件
    const resourceTimestamp = Date.now();
    const eventTimestamp = globalState.associationManager 
      ? globalState.associationManager.findEventTimestamp(resourceTimestamp)
      : findEventTimestampForRequest(resourceTimestamp);
    
    if (eventTimestamp) {
      const resourceInfo = {
        url: url,
        path: relativePath,
        timestamp: resourceTimestamp,
        size: buffer.length,
        resourceType: resourceType
      };
      
      if (globalState.associationManager) {
        globalState.associationManager.associate(
          eventTimestamp, 
          'static_resource', 
          resourceInfo
        );
      } else {
        updatePendingEventWithResource(eventTimestamp, resourceInfo);
      }
      log.info('Resource associated to event:', eventTimestamp, 'url:', url);
    }

    log.debug(`Resource saved: ${safeFileName} (${resourceType})`);
    return relativePath;
  } catch (error) {
    log.warn(`Failed to save resource ${url}:`, error.message);
    return null;
  }
}

// 根据MIME类型获取扩展名
function getExtensionByMimeType(headers) {
  const contentType = headers['content-type']?.[0] || headers['Content-Type']?.[0] || '';
  const mimeToExt = {
    'text/css': '.css',
    'text/javascript': '.js',
    'application/javascript': '.js',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'image/webp': '.webp',
    'font/woff2': '.woff2',
    'font/woff': '.woff',
    'font/ttf': '.ttf',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav'
  };
  
  for (const [mime, ext] of Object.entries(mimeToExt)) {
    if (contentType.includes(mime)) return ext;
  }
  return '';
}

// 写入暂存的事件到 manifest
function flushPendingEvents() {
  if (!globalState.manifestStream) return;

  // 修复：添加 Array.isArray 检查，确保 pendingEvents 是数组
  if (!Array.isArray(globalState.pendingEvents)) {
    console.error('[flushPendingEvents] pendingEvents is not an array:', typeof globalState.pendingEvents, globalState.pendingEvents);
    globalState.pendingEvents = [];
    return;
  }

  for (const event of globalState.pendingEvents) {
    const line = JSON.stringify(event) + '\n';
    globalState.manifestStream.write(line);

    // 保存到已写入事件缓存，用于后续网络请求关联
    // 使用深拷贝，避免后续修改影响已写入文件的内容
    globalState.flushedEvents.set(event.timestamp, JSON.parse(JSON.stringify(event)));
  }

  // 清理过旧的缓存事件（保留最近 60 秒）
  const cutoff = Date.now() - 60000;
  for (const [timestamp, event] of globalState.flushedEvents) {
    if (timestamp < cutoff) {
      globalState.flushedEvents.delete(timestamp);
    }
  }

  globalState.pendingEvents = [];
}

// 更新暂存事件，添加 API 请求
function updatePendingEventWithApiRequest(eventTimestamp, apiRequest) {
  // 修复：添加 Array.isArray 检查
  if (!Array.isArray(globalState.pendingEvents)) {
    console.error('[updatePendingEventWithApiRequest] pendingEvents is not an array:', typeof globalState.pendingEvents);
    globalState.pendingEvents = [];
  }

  // 在 pendingEvents 中查找
  const pendingEvent = globalState.pendingEvents.find(e => e.timestamp === eventTimestamp);
  if (pendingEvent) {
    // 确保 network_correlation 和 api_requests 存在
    if (!pendingEvent.network_correlation) {
      pendingEvent.network_correlation = {};
    }
    if (!pendingEvent.network_correlation.api_requests) {
      pendingEvent.network_correlation.api_requests = [];
    }
    pendingEvent.network_correlation.api_requests.push(apiRequest);
    
    // 保存关联关系到日志文件（包含请求 body）
    saveCorrelationLog(eventTimestamp, {
      requestTimestamp: apiRequest.timestamp,
      url: apiRequest.url,
      method: apiRequest.method,
      status: apiRequest.status,
      resourceType: apiRequest.resourceType,
      requestBody: apiRequest.requestBody  // 包含请求 body
    }, 'api_request');
    return;
  }
  
  // 在已刷新的事件中查找并更新
  const flushedEvent = globalState.flushedEvents.get(eventTimestamp);
  if (flushedEvent) {
    // 确保 network_correlation 和 api_requests 存在
    if (!flushedEvent.network_correlation) {
      flushedEvent.network_correlation = {};
    }
    if (!flushedEvent.network_correlation.api_requests) {
      flushedEvent.network_correlation.api_requests = [];
    }
    flushedEvent.network_correlation.api_requests.push(apiRequest);
    globalState.flushedEvents.set(eventTimestamp, flushedEvent);
    
    // 保存关联关系到日志文件（包含请求 body）
    saveCorrelationLog(eventTimestamp, {
      requestTimestamp: apiRequest.timestamp,
      url: apiRequest.url,
      method: apiRequest.method,
      status: apiRequest.status,
      resourceType: apiRequest.resourceType,
      requestBody: apiRequest.requestBody  // 包含请求 body
    }, 'api_request');
  }
}

// 保存关联关系到日志文件
function saveCorrelationLog(eventTimestamp, data, type = 'api_request', eventId = null) {
  if (!globalState.correlationLogStream) return;

  const correlationRecord = {
    timestamp: Date.now(),
    type: type, // 'api_request', 'api_response', 'static_resource', 'dynamic_resource', 'lineage', 'browser_state'
    eventTimestamp: eventTimestamp,
    eventId: eventId, // 添加 eventId 字段
    data: data
  };

  globalState.correlationLogStream.write(JSON.stringify(correlationRecord) + '\n');
}

// 更新暂存事件，添加静态资源
function updatePendingEventWithResource(eventTimestamp, resource) {
  // 修复：添加 Array.isArray 检查
  if (!Array.isArray(globalState.pendingEvents)) {
    console.error('[updatePendingEventWithResource] pendingEvents is not an array:', typeof globalState.pendingEvents);
    globalState.pendingEvents = [];
  }

  // 在 pendingEvents 中查找
  const pendingEvent = globalState.pendingEvents.find(e => e.timestamp === eventTimestamp);
  if (pendingEvent) {
    // 确保 network_correlation 和 resources 存在
    if (!pendingEvent.network_correlation) {
      pendingEvent.network_correlation = {};
    }
    if (!pendingEvent.network_correlation.resources) {
      pendingEvent.network_correlation.resources = [];
    }
    pendingEvent.network_correlation.resources.push(resource);
    
    // 保存关联关系到日志文件
    saveCorrelationLog(eventTimestamp, {
      url: resource.url,
      path: resource.path,
      timestamp: resource.timestamp,
      size: resource.size
    }, 'static_resource');
    return;
  }
  
  // 在已刷新的事件中查找并更新
  const flushedEvent = globalState.flushedEvents.get(eventTimestamp);
  if (flushedEvent) {
    // 确保 network_correlation 和 resources 存在
    if (!flushedEvent.network_correlation) {
      flushedEvent.network_correlation = {};
    }
    if (!flushedEvent.network_correlation.resources) {
      flushedEvent.network_correlation.resources = [];
    }
    flushedEvent.network_correlation.resources.push(resource);
    globalState.flushedEvents.set(eventTimestamp, flushedEvent);
    
    // 保存关联关系到日志文件
    saveCorrelationLog(eventTimestamp, {
      url: resource.url,
      path: resource.path,
      timestamp: resource.timestamp,
      size: resource.size
    }, 'static_resource');
  }
}

// 更新暂存事件，设置 response_status
function updatePendingEventWithResponseStatus(eventTimestamp, responseStatus) {
  // 在 pendingEvents 中查找
  const pendingEvent = globalState.pendingEvents.find(e => e.timestamp === eventTimestamp);
  if (pendingEvent) {
    // 确保 network_correlation 存在
    if (!pendingEvent.network_correlation) {
      pendingEvent.network_correlation = {};
    }
    pendingEvent.network_correlation.response_status = responseStatus;
    return;
  }
  
  // 在已刷新的事件中查找并更新
  const flushedEvent = globalState.flushedEvents.get(eventTimestamp);
  if (flushedEvent) {
    // 确保 network_correlation 存在
    if (!flushedEvent.network_correlation) {
      flushedEvent.network_correlation = {};
    }
    flushedEvent.network_correlation.response_status = responseStatus;
    globalState.flushedEvents.set(eventTimestamp, flushedEvent);
  }
}

// 缓冲 API 请求，等待后续关联
function bufferApiRequest(apiRequest) {
  // 添加到请求缓冲区
  requestBuffer.push({
    ...apiRequest,
    bufferedAt: Date.now()
  });
  
  // 清理过旧的缓冲请求（超过 30 秒）
  const cutoff = Date.now() - 30000;
  for (let i = requestBuffer.length - 1; i >= 0; i--) {
    if (requestBuffer[i].bufferedAt < cutoff) {
      requestBuffer.splice(i, 1);
    }
  }
}

// 重新生成 training_manifest.jsonl 文件
// 注意：UnifiedEventManager 现在直接写入文件，此函数不再覆盖文件内容
function regenerateManifestFile(taskDir) {
  try {
    // 使用 EventAssociationManager 重新生成（如果可用）
    if (globalState.associationManager) {
      return globalState.associationManager.regenerateManifest();
    }
    
    // 修复：不再使用 flushedEvents 重新生成文件，因为 UnifiedEventManager 已经直接写入
    // 这避免了覆盖已写入的事件
    log.info('Skipping manifest regeneration - UnifiedEventManager writes directly to file');
    return true;
  } catch (error) {
    log.error('Failed to regenerate manifest file:', error);
    return false;
  }
}

// 记录用户操作
async function recordUserAction(actionData) {
  if (!globalState.isRecording || !globalState.unifiedEventManager) {
    return;
  }

  // 检查是否处于暂停状态
  if (globalState.isPaused) {
    return;
  }

  log.info('Recording user action:', actionData.type, 'timestamp:', actionData.timestamp);

  // 使用 UnifiedEventManager 创建事件（基于因果关系链）
  const eventId = actionData.eventId || generateId('evt');
  globalState.unifiedEventManager.createEvent({
    eventId: eventId,
    type: actionData.type,
    timestamp: actionData.timestamp || Date.now(),
    url: actionData.url,
    title: actionData.title,
    userAction: {
      xpath: actionData.xpath,
      selector: actionData.selector,
      shadowPath: actionData.shadowPath,
      tagName: actionData.tagName,
      text: actionData.text,
      coordinates: actionData.coordinates,
      inputType: actionData.inputType,
      value: actionData.value,
      key: actionData.key,
      scrollX: actionData.scrollX,
      scrollY: actionData.scrollY,
      scrollStartX: actionData.scrollStartX,
      scrollStartY: actionData.scrollStartY,
      scrollDeltaX: actionData.scrollDeltaX,
      scrollDeltaY: actionData.scrollDeltaY,
      scrollDuration: actionData.scrollDuration,
      direction: actionData.direction,
      scrollSequenceId: actionData.scrollSequenceId,
      directionChanged: actionData.directionChanged,
      triggerSource: actionData.triggerSource
    },
    metadata: {
      domStats: actionData.domStats,
      snapshotFileName: actionData.snapshotFileName,
      snapshotPath: actionData.snapshotPath,
      domSnapshotFileName: actionData.domSnapshotFileName,
      domSnapshotPath: actionData.domSnapshotPath,
      hasErrors: actionData.hasErrors || false,
      isLoading: actionData.isLoading || false
    }
  });

  // 立即刷新到文件（网络请求关联由 Preload 层的 CausalChainTracker 处理）
  // 修复：添加 await 确保事件被正确写入
  try {
    await globalState.unifiedEventManager.flushEvent(eventId);
    log.info('User action recorded and flushed:', actionData.type, 'eventId:', eventId);
  } catch (err) {
    log.error('Failed to flush event:', err);
  }
}

// 保存 DOM 快照
/**
 * 保存 DOM 快照
 * 【优化】使用确定性文件名（基于 eventId），确保 100% 关联准确率
 */
function saveDOMSnapshot(snapshotData) {
  if (!globalState.isRecording || !globalState.currentTask) {
    return;
  }

  // 检查是否处于暂停状态
  if (globalState.isPaused) {
    return;
  }

  try {
    const domDir = path.join(globalState.currentTask.dir, 'dom');
    
    // 确保 dom 目录存在
    if (!fs.existsSync(domDir)) {
      fs.mkdirSync(domDir, { recursive: true });
    }
    
    const timestamp = snapshotData.timestamp || Date.now();
    const isInitial = snapshotData.type === 'initial';
    
    // 【优化】使用传递的确定性文件名（基于 eventId）
    // 优先级: 1. snapshotData.fileName (来自 preload，基于 eventId)
    //        2. snapshot_initial.json (第一次初始快照)
    //        3. snapshot_${timestamp}.json (降级方案)
    let fileName;
    if (snapshotData.fileName) {
      // 使用 preload 传递的确定性文件名（基于 eventId）
      fileName = snapshotData.fileName;
      log.info('Using deterministic filename from preload:', fileName, 'eventId:', snapshotData.eventId);
    } else if (isInitial && !globalState.initialSnapshotSaved) {
      // 兼容：第一次初始快照使用 snapshot_initial.json
      fileName = 'snapshot_initial.json';
      globalState.initialSnapshotSaved = true;
      log.info('Using initial snapshot filename:', fileName);
    } else {
      // 降级：使用时间戳文件名（不推荐，仅用于兼容）
      fileName = `snapshot_${timestamp}.json`;
      log.warn('Using timestamp fallback filename:', fileName, 'consider updating preload');
    }
    
    const filePath = path.join(domDir, fileName);

    // 保存 rrweb 格式的 DOM 快照
    if (snapshotData.rrwebEvent) {
      // 新格式：包含完整的 rrweb 序列化节点树
      const snapshotContent = {
        type: snapshotData.type,
        timestamp: timestamp,
        url: snapshotData.url,
        title: snapshotData.title,
        rrwebEvent: snapshotData.rrwebEvent
      };
      fs.writeFileSync(filePath, JSON.stringify(snapshotContent, null, 2));
      
      // 追加到 rrweb_events.json
      const rrwebPath = path.join(domDir, 'rrweb_events.json');
      let events = [];
      if (fs.existsSync(rrwebPath)) {
        try {
          events = JSON.parse(fs.readFileSync(rrwebPath, 'utf-8'));
        } catch (e) {
          events = [];
        }
      }
      events.push(snapshotData.rrwebEvent);
      fs.writeFileSync(rrwebPath, JSON.stringify(events, null, 2));
      
      log.debug('DOM snapshot saved (rrweb format):', fileName);
    } else if (snapshotData.html) {
      // 兼容旧格式：直接保存 HTML
      const htmlFileName = isInitial 
        ? 'snapshot_initial.html'
        : `snapshot_${timestamp}.html`;
      const htmlFilePath = path.join(domDir, htmlFileName);
      fs.writeFileSync(htmlFilePath, snapshotData.html);
      
      // 同时创建一个简单的 rrweb 事件
      const simpleRrwebEvent = {
        type: isInitial ? 2 : 3,
        data: {
          html: snapshotData.html.substring(0, 1000) + '...',
          url: snapshotData.url,
          title: snapshotData.title
        },
        timestamp: timestamp
      };
      
      const rrwebPath = path.join(domDir, 'rrweb_events.json');
      let events = [];
      if (fs.existsSync(rrwebPath)) {
        try {
          events = JSON.parse(fs.readFileSync(rrwebPath, 'utf-8'));
        } catch (e) {
          events = [];
        }
      }
      events.push(simpleRrwebEvent);
      fs.writeFileSync(rrwebPath, JSON.stringify(events, null, 2));
      
      log.debug('DOM snapshot saved (legacy format):', htmlFileName);
    }
  } catch (error) {
    log.error('Failed to save DOM snapshot:', error.message);
  }
}

// 保存上传的文件
function saveUploadedFile(fileData) {
  try {
    const uploadsDir = path.join(globalState.currentTask.dir, 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const timestamp = Date.now();
    const safeFileName = fileData.fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const fileName = `upload_${timestamp}_${safeFileName}`;
    const filePath = path.join(uploadsDir, fileName);
    let fileSize = 0;

    // 根据文件类型保存
    if (fileData.isImage && fileData.content) {
      // 图片文件：base64 数据
      const base64Data = fileData.content.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      fs.writeFileSync(filePath, buffer);
      fileSize = buffer.length;
      log.info(`Uploaded image saved: ${fileName}, size: ${fileSize} bytes`);
    } else if (fileData.content) {
      // 文本文件
      fs.writeFileSync(filePath, fileData.content);
      fileSize = fileData.content.length;
      log.info(`Uploaded file saved: ${fileName}, size: ${fileSize} bytes`);
    }

    // 记录文件保存事件到 training_manifest.jsonl（与上传事件分开，用于关联 uploads 目录）
    if (globalState.unifiedEventManager) {
      globalState.unifiedEventManager.createAndFlushEvent({
        type: 'file_io',
        fileType: 'upload-saved',
        url: fileData.url,
        windowId: 'win_1',
        localPath: path.join('uploads', fileName),
        metadata: {
          fileName: fileData.fileName,
          fileSize: fileSize,
          mimeType: fileData.fileType,
          xpath: fileData.xpath,
          selector: fileData.selector,
          isImage: fileData.isImage,
          savedFileName: fileName,
          savedFilePath: filePath
        }
      });
    }

    log.info(`Uploaded file saved to: ${filePath}`);

    return {
      filePath,
      fileName,
      fileSize
    };
  } catch (error) {
    log.error('Failed to save uploaded file:', error);
    return null;
  }
}

// 非活动监控
function startInactivityWatchdog() {
  const checkInactivity = () => {
    const inactiveTime = Date.now() - globalState.lastActivityTime;
    const fiveMinutes = 5 * 60 * 1000;

    if (inactiveTime > fiveMinutes && globalState.isRecording) {
      log.info('Inactivity detected, auto-stopping recording');
      stopRecording();

      // 通知用户
      dialog.showMessageBox({
        type: 'info',
        title: '录制已自动停止',
        message: '检测到5分钟无活动，录制已自动停止并保存。'
      });
    } else {
      globalState.inactivityTimer = setTimeout(checkInactivity, 30000); // 每30秒检查一次
    }
  };

  globalState.inactivityTimer = setTimeout(checkInactivity, 30000);
}

// 磁盘空间监控
function startDiskSpaceMonitor() {
  const checkDisk = () => {
    if (!globalState.isRecording) {
      return;
    }

    checkDiskSpace();

    // 每5分钟检查一次
    setTimeout(checkDisk, 5 * 60 * 1000);
  };

  setTimeout(checkDisk, 5 * 60 * 1000);
}

// 更新活动时间
function updateActivityTime() {
  globalState.lastActivityTime = Date.now();
}

// IPC处理程序
ipcMain.handle('start-recording', async (event, config) => {
  log.info('start-recording called, platform:', process.platform, 'STORAGE_PATH:', STORAGE_PATH);

  // 确保管理器已初始化
  if (!globalState.ffmpegManager) {
    log.warn('Managers not initialized yet, initializing now...');
    initializeManagers();
  }
  return startRecording(config);
});

// 选择存储目录（仅 Windows 平台）
ipcMain.handle('select-storage-directory', async (event) => {
  // 只在 Windows 平台上支持选择存储目录
  if (process.platform !== 'win32') {
    console.log('[Main] select-storage-directory is only supported on Windows');
    return null;
  }

  const mainWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  const selectedPath = await selectStorageDirectory(mainWindow);
  if (selectedPath) {
    STORAGE_PATH = selectedPath;
  }
  return selectedPath;
});

ipcMain.handle('stop-recording', async () => {
  // 确保管理器已初始化
  if (!globalState.ffmpegManager) {
    log.warn('Managers not initialized, nothing to stop');
    return { stopped: false, reason: 'not_initialized' };
  }
  await stopRecording();
  return { stopped: true };
});

// 通知所有窗口暂停/恢复状态
function broadcastPauseState(isPaused) {
  globalState.windows.forEach(({ window }) => {
    if (window && !window.isDestroyed()) {
      window.webContents.send('recording-paused', { isPaused });
    }
  });
}

// 暂停/恢复录制
ipcMain.handle('pause-recording', async () => {
  if (!globalState.isRecording || !globalState.currentTask) {
    throw new Error('No recording in progress');
  }

  // 设置全局暂停状态
  globalState.isPaused = true;
  globalState.currentTask.isPaused = true;

  // 通知所有窗口暂停状态（包括暂停视频录制）
  broadcastPauseState(true);

  // 记录暂停事件
  if (globalState.unifiedEventManager) {
    globalState.unifiedEventManager.createAndFlushEvent({
      type: 'user_context',
      contextType: 'pause',
      description: 'Recording paused by user',
      semanticLabel: 'Recording paused by user'
    });
  }

  log.info('Recording paused');
  return { paused: true };
});

ipcMain.handle('resume-recording', async () => {
  if (!globalState.isRecording || !globalState.currentTask) {
    throw new Error('No recording in progress');
  }

  // 清除全局暂停状态
  globalState.isPaused = false;
  globalState.currentTask.isPaused = false;

  // 通知所有窗口恢复状态（包括恢复视频录制）
  broadcastPauseState(false);

  // 记录恢复事件
  if (globalState.unifiedEventManager) {
    globalState.unifiedEventManager.createAndFlushEvent({
      type: 'user_context',
      contextType: 'resume',
      description: 'Recording resumed by user',
      semanticLabel: 'Recording resumed by user'
    });
  }

  log.info('Recording resumed');
  return { resumed: true };
});

ipcMain.handle('export-task', async (event, taskId) => {
  log.info(`Exporting task: ${taskId}`);
  const { sender } = event;

  // 发送开始进度
  sender.send('export-progress', { percent: 10, message: '正在查找任务目录...' });

  try {
    // 清理 taskId，移除可能的 task_ 前缀
    const cleanTaskId = taskId.replace(/^task_/, '');
    log.info(`Clean taskId: ${cleanTaskId}`);

    // 尝试直接查找目录
    let taskDir = path.join(STORAGE_PATH, taskId);
    let actualTaskId = taskId;
    log.info(`Looking for task directory: ${taskDir}`);

    // 如果直接查找失败，尝试查找各种格式的目录
    if (!fs.existsSync(taskDir)) {
      const entries = fs.readdirSync(STORAGE_PATH, { withFileTypes: true });
      
      // 首先尝试匹配新的命名格式：task_{任务名称}_{网页地址}_{taskId}
      let matchingDir = entries.find(entry => {
        if (entry.isDirectory() && entry.name.startsWith('task_')) {
          const suffix = `_${cleanTaskId}`;
          return entry.name.endsWith(suffix);
        }
        return false;
      });
      
      // 如果没找到，尝试匹配旧的格式 task_{cleanTaskId}_{timestamp}
      if (!matchingDir) {
        matchingDir = entries.find(entry => {
          if (entry.isDirectory()) {
            const pattern = new RegExp(`^task_${cleanTaskId}_(\\d+)$`);
            return pattern.test(entry.name);
          }
          return false;
        });
      }

      // 如果没找到，尝试匹配 task_{timestamp} 格式
      if (!matchingDir) {
        matchingDir = entries.find(entry => {
          if (entry.isDirectory()) {
            if (/^\d+$/.test(cleanTaskId)) {
              const pattern1 = new RegExp(`^task_${cleanTaskId}$`);
              const pattern2 = new RegExp(`^task_${cleanTaskId}_(\\d+)$`);
              return pattern1.test(entry.name) || pattern2.test(entry.name);
            }
          }
          return false;
        });
      }

      // 如果还是没找到，尝试匹配包含 cleanTaskId 的任何目录
      if (!matchingDir) {
        matchingDir = entries.find(entry => {
          if (entry.isDirectory()) {
            return entry.name.includes(cleanTaskId);
          }
          return false;
        });
      }

      if (matchingDir) {
        taskDir = path.join(STORAGE_PATH, matchingDir.name);
        actualTaskId = matchingDir.name;
        log.info(`Found matching directory: ${matchingDir.name}`);
      }
    }

    const zipPath = path.join(STORAGE_PATH, `${actualTaskId}.zip`);

    log.info(`Task directory: ${taskDir}`);
    log.info(`Zip path: ${zipPath}`);

    // 检查任务目录是否存在
    if (!fs.existsSync(taskDir)) {
      log.error(`Task directory not found: ${taskDir}`);
      throw new Error(`Task directory not found: ${taskDir}`);
    }

    // 发送进度
    sender.send('export-progress', { percent: 30, message: '正在压缩文件...' });

    // 使用 archiver 库进行跨平台压缩
    return new Promise((resolve, reject) => {
      const archiver = require('archiver');
      const taskBaseName = path.basename(taskDir);

      log.info('Using archiver for cross-platform zip creation');

      // 创建输出流
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', {
        zlib: { level: 9 } // 最大压缩级别
      });

      // 监听事件
      output.on('close', () => {
        const stats = fs.statSync(zipPath);
        log.info(`Export completed: ${zipPath} (${stats.size} bytes)`);
        sender.send('export-progress', { percent: 100, message: '导出完成' });
        resolve(zipPath);
      });

      archive.on('error', (err) => {
        log.error('Archiver error:', err);
        reject(new Error(`Zip failed: ${err.message}`));
      });

      archive.on('warning', (err) => {
        if (err.code === 'ENOENT') {
          log.warn('Archiver warning:', err);
        } else {
          log.error('Archiver warning:', err);
        }
      });

      archive.on('progress', (progress) => {
        const percent = 30 + Math.floor((progress.entries.processed / progress.entries.total) * 60);
        sender.send('export-progress', { 
          percent: Math.min(percent, 90), 
          message: `正在打包... (${progress.entries.processed}/${progress.entries.total})` 
        });
      });

      // 连接管道
      archive.pipe(output);

      // 添加目录到压缩包
      sender.send('export-progress', { percent: 50, message: '正在打包...' });
      archive.directory(taskDir, taskBaseName);

      // 完成压缩
      archive.finalize();
    });
  } catch (error) {
    log.error('Export task error:', error);
    throw error;
  }
});

ipcMain.handle('get-tasks', async () => {
  // 如果 STORAGE_PATH 未设置，返回空数组
  if (!STORAGE_PATH) {
    log.warn('STORAGE_PATH not set, returning empty tasks list');
    return [];
  }
  
  const tasks = [];
  const entries = fs.readdirSync(STORAGE_PATH, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('task_')) {
      const taskDir = path.join(STORAGE_PATH, entry.name);
      // 使用新的 training_manifest.jsonl 路径
      const manifestPath = path.join(taskDir, 'training_manifest.jsonl');

      if (fs.existsSync(manifestPath)) {
        const stats = fs.statSync(manifestPath);
        // 从目录名中提取 taskId（最后一部分，通常是13位时间戳）
        const parts = entry.name.split('_');
        const taskId = parts.length >= 2 ? parts[parts.length - 1] : entry.name;
        tasks.push({
          id: taskId,
          dirName: entry.name,
          createdAt: stats.birthtime,
          size: stats.size
        });
      }
    }
  }

  return tasks;
});

// 在文件夹中显示任务
ipcMain.handle('show-in-folder', async (event, taskId) => {
  try {
    // 如果 STORAGE_PATH 未设置，报错
    if (!STORAGE_PATH) {
      throw new Error('STORAGE_PATH not set');
    }
    
    const cleanTaskId = taskId.replace(/^task_/, '');
    let taskDir = path.join(STORAGE_PATH, taskId);

    // 如果直接查找失败，尝试查找各种格式的目录
    if (!fs.existsSync(taskDir)) {
      const entries = fs.readdirSync(STORAGE_PATH, { withFileTypes: true });

      // 尝试匹配新的命名格式
      let matchingDir = entries.find(entry => {
        if (entry.isDirectory() && entry.name.startsWith('task_')) {
          const suffix = `_${cleanTaskId}`;
          return entry.name.endsWith(suffix);
        }
        return false;
      });

      // 如果没找到，尝试其他格式
      if (!matchingDir) {
        matchingDir = entries.find(entry => {
          if (entry.isDirectory()) {
            return entry.name.includes(cleanTaskId);
          }
          return false;
        });
      }

      if (matchingDir) {
        taskDir = path.join(STORAGE_PATH, matchingDir.name);
      }
    }

    if (!fs.existsSync(taskDir)) {
      throw new Error(`Task directory not found: ${taskId}`);
    }

    // 在文件夹中显示
    try {
      // Windows 上需要确保路径格式正确
      const normalizedPath = path.normalize(taskDir);
      log.info(`Opening folder with normalized path: ${normalizedPath}`);
      
      // 先尝试使用 showItemInFolder
      shell.showItemInFolder(normalizedPath);
      
      // Windows 上 showItemInFolder 可能不工作，使用 openPath 作为备选
      if (process.platform === 'win32') {
        setTimeout(() => {
          shell.openPath(normalizedPath).then((result) => {
            if (result) {
              log.warn('openPath result:', result);
            } else {
              log.info('openPath succeeded');
            }
          }).catch((err) => {
            log.error('openPath failed:', err);
          });
        }, 500);
      }
      
      return { success: true };
    } catch (err) {
      log.error('shell.showItemInFolder failed:', err);
      throw err;
    }
  } catch (error) {
    log.error('Failed to show task in folder:', error);
    throw error;
  }
});

// 设置网络请求监听（需要在app ready后调用）
function setupNetworkListeners() {
  // 监听网络请求以捕获API响应和资源
  session.defaultSession.webRequest.onCompleted(async (details) => {
    const { statusCode, url, responseHeaders, resourceType } = details;

    // 只有在录制中且未暂停时才记录
    if (globalState.isRecording && globalState.currentTask && !globalState.isPaused) {
      
      // 保存静态资源和HTML页面
      let resourceRelativePath = null;
      
      // 检查是否是已知的资源类型
      const isKnownResourceType = ['stylesheet', 'script', 'image', 'font', 'mainFrame', 'subFrame', 'media'].includes(resourceType);
      
      // 通过 URL 和 Content-Type 检测额外的资源（如条件注释加载的 JS）
      const isScriptByUrl = url.match(/\.(js|mjs)(\?.*)?$/i);
      const isCssByUrl = url.match(/\.(css)(\?.*)?$/i);
      const contentType = (responseHeaders['content-type']?.[0] || responseHeaders['Content-Type']?.[0] || '').toLowerCase();
      const isScriptByMime = contentType.includes('javascript') || contentType.includes('ecmascript');
      const isCssByMime = contentType.includes('text/css');
      
      // 综合判断是否是脚本或样式资源
      const shouldSaveResource = isKnownResourceType || isScriptByUrl || isCssByUrl || isScriptByMime || isCssByMime;
      
      if (shouldSaveResource) {
        // 对于检测到的脚本/样式，强制使用正确的资源类型
        const effectiveResourceType = isScriptByUrl || isScriptByMime ? 'script' : 
                                      (isCssByUrl || isCssByMime ? 'stylesheet' : resourceType);
        resourceRelativePath = await saveResource(url, effectiveResourceType, responseHeaders);
        
        if (resourceRelativePath) {
          log.debug(`Resource saved via detection: ${url} (type: ${effectiveResourceType})`);
        }
        
        // 静态资源关联由 post-process-correlation.js 脚本在录制结束后统一完成
        // 这里只保存资源文件，不进行实时关联
      }
      
      // 记录API响应
      if (resourceType === 'xhr' || resourceType === 'fetch') {
        const timestamp = Date.now();
        
        // 下载API响应体
        let responseBody = null;
        let responseBodyPath = null;
        try {
          const fetchResponse = await fetch(url, {
            method: details.method,
            headers: details.requestHeaders
          });
          
          if (fetchResponse.ok) {
            const contentType = responseHeaders['content-type']?.[0] || responseHeaders['Content-Type']?.[0] || '';
            
            if (contentType.includes('application/json')) {
              responseBody = await fetchResponse.json();
            } else if (contentType.includes('text/')) {
              responseBody = await fetchResponse.text();
            } else {
              // 二进制数据保存为文件
              const buffer = Buffer.from(await fetchResponse.arrayBuffer());
              const apiBodiesDir = path.join(globalState.currentTask.dir, 'network', 'api_bodies');
              if (!fs.existsSync(apiBodiesDir)) {
                fs.mkdirSync(apiBodiesDir, { recursive: true });
              }
              const safeFileName = `${timestamp}_${path.basename(new URL(url).pathname).replace(/[^a-zA-Z0-9.-]/g, '_') || 'response'}`;
              const bodyFilePath = path.join(apiBodiesDir, safeFileName);
              fs.writeFileSync(bodyFilePath, buffer);
              responseBodyPath = path.join('network', 'api_bodies', safeFileName);
            }
          }
        } catch (error) {
          log.warn(`Failed to fetch API response body for ${url}:`, error.message);
        }
        
        globalState.apiResponses.set(url, {
          status: statusCode,
          headers: responseHeaders,
          timestamp: timestamp,
          body: responseBody,
          bodyPath: responseBodyPath
        });

        // 写入API流量日志
        if (globalState.apiLogStream) {
          const apiEntry = {
            timestamp: timestamp,
            url: url,
            status: statusCode,
            method: details.method,
            resourceType: resourceType
          };
          globalState.apiLogStream.write(JSON.stringify(apiEntry) + '\n');
        }
        
        // 将请求与对应的事件关联
        // 使用 Date.now() 作为统一的时间戳，避免 Chrome 时间戳和 JS 时间戳的偏差
        const requestTimestamp = Date.now();
        const requestEndTime = Date.now();
        
        // 创建 API 请求对象
        const apiRequest = {
          url: url,
          method: details.method,
          status: statusCode,
          timestamp: requestTimestamp,
          duration: requestEndTime - requestTimestamp,
          resourceType: resourceType,
          responseHeaders: responseHeaders,
          references: {
            apiResponsesKey: url,  // api_responses.json 中的 key
            resourcePath: resourceRelativePath,  // resources/ 目录中的文件路径
            responseBodyPath: responseBodyPath   // api_bodies/ 目录中的文件路径
          }
        };
        
        // 首先尝试直接关联到已有事件
        const eventTimestamp = globalState.associationManager
          ? globalState.associationManager.findEventTimestamp(requestTimestamp)
          : findEventTimestampForRequest(requestTimestamp);
        
        log.info('WebRequest onCompleted - request timestamp:', requestTimestamp, 'matched event:', eventTimestamp, 'url:', url);
        
        if (eventTimestamp) {
          if (globalState.associationManager) {
            // 使用 EventAssociationManager 关联 API 请求
            globalState.associationManager.associate(eventTimestamp, 'api_request', apiRequest);
            // 设置 response_status
            globalState.associationManager.associate(eventTimestamp, 'response_status', {
              status: statusCode,
              url: url,
              timestamp: requestTimestamp
            });
          } else {
            // 回退到旧实现
            updatePendingEventWithApiRequest(eventTimestamp, apiRequest);
            updatePendingEventWithResponseStatus(eventTimestamp, {
              status: statusCode,
              url: url,
              timestamp: requestTimestamp
            });
          }
          log.info('WebRequest associated to event:', eventTimestamp, 'url:', url);
        } else {
          // 如果没有匹配到事件，将请求加入缓冲队列
          bufferApiRequest(apiRequest);
          log.debug('WebRequest buffered for later association:', url, 'timestamp:', requestTimestamp);
        }
      }
    }
  });

  // 拦截文件请求（PDF、图片、文档等）
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame') {
      const url = details.url.toLowerCase();
      
      // 检查URL是否指向用户下载的文件（不包括网页图片资源）
      // 网页图片资源（.jpg, .png, .gif等）由 saveResource 保存到 network/resources/
      const filePatterns = [
        { ext: '.pdf', mimeType: 'application/pdf', type: 'document' },
        { ext: '.doc', mimeType: 'application/msword', type: 'document' },
        { ext: '.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', type: 'document' },
        { ext: '.xls', mimeType: 'application/vnd.ms-excel', type: 'spreadsheet' },
        { ext: '.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', type: 'spreadsheet' },
        { ext: '.ppt', mimeType: 'application/vnd.ms-powerpoint', type: 'presentation' },
        { ext: '.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', type: 'presentation' },
        { ext: '.zip', mimeType: 'application/zip', type: 'archive' },
        { ext: '.rar', mimeType: 'application/x-rar-compressed', type: 'archive' },
        { ext: '.7z', mimeType: 'application/x-7z-compressed', type: 'archive' },
        { ext: '.mp4', mimeType: 'video/mp4', type: 'video' },
        { ext: '.webm', mimeType: 'video/webm', type: 'video' },
        { ext: '.mp3', mimeType: 'audio/mpeg', type: 'audio' },
        { ext: '.wav', mimeType: 'audio/wav', type: 'audio' }
        // 注意：图片扩展名 (.jpg, .png, .gif 等) 不在这里
        // 因为它们通常是网页资源，不是用户下载的文件
      ];
      
      const matchedPattern = filePatterns.find(pattern => url.endsWith(pattern.ext));

      if (matchedPattern) {
        log.info(`File detected: ${details.url} (${matchedPattern.type})`);

        // 只有在录制中且未暂停时才记录
        if (globalState.isRecording && globalState.currentTask && !globalState.isPaused) {
          // 记录文件事件 - 使用统一事件格式
          globalState.unifiedEventManager.createAndFlushEvent({
            type: 'file_io',
            fileType: 'preview',
            url: details.url,
            windowId: `win_${details.webContentsId}`,
            localPath: null, // 流拦截不保存文件，只记录元数据
            contentSummary: `${matchedPattern.type.toUpperCase()} detected: ${details.url}`,
            metadata: {
              fileName: path.basename(details.url),
              mimeType: matchedPattern.mimeType
            }
          });
        }
      }
    }

    callback({});
  });

  // 拦截响应以捕获各种文件内容和mainFrame HTML
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const contentType = details.responseHeaders['content-type'] || details.responseHeaders['Content-Type'];

    if (contentType && contentType[0]) {
      const mimeType = contentType[0].toLowerCase();
      
      // 定义需要捕获的文件 MIME 类型
      // 只捕获用户下载的文件（PDF、文档等），不捕获网页图片资源
      // 图片资源由 saveResource 函数在 network/resources/ 目录中保存
      const capturableTypes = [
        { mime: 'application/pdf', ext: '.pdf', type: 'document' },
        { mime: 'application/msword', ext: '.doc', type: 'document' },
        { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: '.docx', type: 'document' },
        { mime: 'application/vnd.ms-excel', ext: '.xls', type: 'spreadsheet' },
        { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: '.xlsx', type: 'spreadsheet' },
        { mime: 'application/vnd.ms-powerpoint', ext: '.ppt', type: 'presentation' },
        { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: '.pptx', type: 'presentation' },
        { mime: 'application/zip', ext: '.zip', type: 'archive' },
        { mime: 'application/x-rar-compressed', ext: '.rar', type: 'archive' },
        { mime: 'application/x-7z-compressed', ext: '.7z', type: 'archive' }
        // 注意：图片类型 (image/jpeg, image/png 等) 不在这里
        // 因为它们通常是网页资源，不是用户下载的文件
        // 网页图片资源由 saveResource 保存到 network/resources/
      ];
      
      const matchedType = capturableTypes.find(t => mimeType.includes(t.mime));
      
      if (matchedType) {
        log.info(`${matchedType.type.toUpperCase()} stream detected: ${details.url}`);

        if (globalState.isRecording && globalState.currentTask) {
          // 检查是否已经下载过这个文件
          if (globalState.downloadedPdfs.has(details.url)) {
            log.info(`File already downloaded, skipping: ${details.url}`);
          } else {
            // 标记为已下载
            globalState.downloadedPdfs.add(details.url);
            // 下载并保存文件
            downloadAndSaveFile(details.url, details.responseHeaders, matchedType.ext, matchedType.type);
          }
        }
      }
    }

    callback({ responseHeaders: details.responseHeaders });
  });
  
}

// 获取响应体内容
async function getResponseBody(details) {
  try {
    const { net } = require('electron');
    
    return new Promise((resolve, reject) => {
      const request = net.request({
        url: details.url,
        method: details.method,
        headers: details.requestHeaders
      });
      
      const chunks = [];
      
      request.on('response', (response) => {
        response.on('data', (chunk) => {
          chunks.push(chunk);
        });
        
        response.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve(body);
        });
        
        response.on('error', (err) => {
          reject(err);
        });
      });
      
      request.on('error', (err) => {
        reject(err);
      });
      
      // 如果有请求体，写入请求体
      if (details.uploadData) {
        details.uploadData.forEach(data => {
          if (data.bytes) {
            request.write(data.bytes);
          }
        });
      }
      
      request.end();
    });
  } catch (err) {
    log.error('Failed to get response body:', err);
    return null;
  }
}

// 生成状态注入脚本
function generateStateInjectionScript(browserState) {
  const stateJson = JSON.stringify(browserState);
  
  return `
// Sentinel State Injection Script - 同步状态伪造
(function() {
  'use strict';
  
  // 防止重复注入
  if (window.__sentinelStateInjected) return;
  window.__sentinelStateInjected = true;
  
  console.log('[Sentinel] State injection script executing...');
  
  // 解析状态数据
  const browserState = ${stateJson};
  
  // ===== localStorage 劫持 =====
  const originalLocalStorage = window.localStorage;
  const localStorageData = browserState.localStorage || {};
  
  // 创建伪造的 localStorage
  const fakeLocalStorage = {
    _data: { ...localStorageData },
    length: Object.keys(localStorageData).length,
    
    getItem(key) {
      return this._data[key] || null;
    },
    
    setItem(key, value) {
      this._data[key] = String(value);
      this.length = Object.keys(this._data).length;
    },
    
    removeItem(key) {
      delete this._data[key];
      this.length = Object.keys(this._data).length;
    },
    
    clear() {
      this._data = {};
      this.length = 0;
    },
    
    key(index) {
      const keys = Object.keys(this._data);
      return keys[index] || null;
    }
  };
  
  // 使用 Object.defineProperty 劫持 window.localStorage
  try {
    Object.defineProperty(window, 'localStorage', {
      get() {
        return fakeLocalStorage;
      },
      set() {
        // 禁止修改
      },
      configurable: false
    });
    console.log('[Sentinel] localStorage hijacked');
  } catch (e) {
    console.error('[Sentinel] Failed to hijack localStorage:', e);
  }
  
  // ===== sessionStorage 劫持 =====
  const sessionStorageData = browserState.sessionStorage || {};
  
  const fakeSessionStorage = {
    _data: { ...sessionStorageData },
    length: Object.keys(sessionStorageData).length,
    
    getItem(key) {
      return this._data[key] || null;
    },
    
    setItem(key, value) {
      this._data[key] = String(value);
      this.length = Object.keys(this._data).length;
    },
    
    removeItem(key) {
      delete this._data[key];
      this.length = Object.keys(this._data).length;
    },
    
    clear() {
      this._data = {};
      this.length = 0;
    },
    
    key(index) {
      const keys = Object.keys(this._data);
      return keys[index] || null;
    }
  };
  
  try {
    Object.defineProperty(window, 'sessionStorage', {
      get() {
        return fakeSessionStorage;
      },
      set() {
        // 禁止修改
      },
      configurable: false
    });
    console.log('[Sentinel] sessionStorage hijacked');
  } catch (e) {
    console.error('[Sentinel] Failed to hijack sessionStorage:', e);
  }
  
  // ===== IndexedDB 劫持 =====
  const indexedDBData = browserState.indexedDB || {};
  
  // 创建伪造的 IDBDatabase
  function createFakeIDBDatabase(dbName, dbData) {
    const objectStoreNames = Object.keys(dbData);
    
    return {
      name: dbName,
      version: 1,
      objectStoreNames: objectStoreNames,
      
      transaction(storeNames, mode) {
        return createFakeIDBTransaction(dbData, storeNames, mode);
      },
      
      close() {
        // 空实现
      }
    };
  }
  
  function createFakeIDBTransaction(dbData, storeNames, mode) {
    const stores = Array.isArray(storeNames) ? storeNames : [storeNames];
    
    return {
      objectStore(name) {
        return createFakeIDBObjectStore(dbData[name] || {});
      },
      
      oncomplete: null,
      onerror: null,
      onabort: null
    };
  }
  
  function createFakeIDBObjectStore(storeData) {
    const data = storeData || [];
    
    return {
      get(key) {
        const record = data.find(item => item.key === key || item.id === key);
        return createFakeIDBRequest(record || undefined);
      },
      
      getAll() {
        return createFakeIDBRequest(data);
      },
      
      put(value, key) {
        return createFakeIDBRequest(undefined);
      },
      
      add(value, key) {
        return createFakeIDBRequest(undefined);
      },
      
      delete(key) {
        return createFakeIDBRequest(undefined);
      },
      
      clear() {
        return createFakeIDBRequest(undefined);
      },
      
      openCursor() {
        let index = 0;
        const cursor = {
          continue() {
            index++;
            if (index < data.length) {
              this.value = data[index];
              this.key = data[index].key || data[index].id || index;
              if (this.onsuccess) this.onsuccess({ target: this });
            } else {
              this.value = null;
              this.key = null;
              if (this.onsuccess) this.onsuccess({ target: this });
            }
          },
          value: data[0] || null,
          key: data[0] ? (data[0].key || data[0].id || 0) : null
        };
        
        setTimeout(() => {
          if (cursor.onsuccess) cursor.onsuccess({ target: cursor });
        }, 0);
        
        return cursor;
      }
    };
  }
  
  function createFakeIDBRequest(result) {
    const request = {
      result: result,
      error: null,
      onsuccess: null,
      onerror: null,
      
      get(target, prop) {
        if (prop === 'result') return result;
        return target[prop];
      }
    };
    
    setTimeout(() => {
      if (request.onsuccess) {
        request.onsuccess({ target: request });
      }
    }, 0);
    
    return request;
  }
  
  // 劫持 window.indexedDB
  const fakeIndexedDB = {
    open(dbName, version) {
      const request = {
        result: createFakeIDBDatabase(dbName, indexedDBData[dbName] || {}),
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null
      };
      
      setTimeout(() => {
        if (request.onsuccess) {
          request.onsuccess({ target: request });
        }
      }, 0);
      
      return request;
    },
    
    deleteDatabase(dbName) {
      return createFakeIDBRequest(undefined);
    },
    
    databases() {
      return Promise.resolve(
        Object.keys(indexedDBData).map(name => ({ name, version: 1 }))
      );
    }
  };
  
  try {
    Object.defineProperty(window, 'indexedDB', {
      get() {
        return fakeIndexedDB;
      },
      set() {
        // 禁止修改
      },
      configurable: false
    });
    console.log('[Sentinel] indexedDB hijacked');
  } catch (e) {
    console.error('[Sentinel] Failed to hijack indexedDB:', e);
  }
  
  // ===== Cookies 劫持 =====
  const cookiesData = browserState.cookies || '';
  
  try {
    Object.defineProperty(document, 'cookie', {
      get() {
        return cookiesData;
      },
      set(value) {
        // 在回放模式下忽略 cookie 设置
        console.log('[Sentinel] Cookie modification blocked in replay mode:', value);
      },
      configurable: false
    });
    console.log('[Sentinel] document.cookie hijacked');
  } catch (e) {
    console.error('[Sentinel] Failed to hijack document.cookie:', e);
  }
  
  console.log('[Sentinel] State injection completed');
})();
  `.trim();
}

// 下载并保存文件（支持 PDF、图片、文档等多种类型）
async function downloadAndSaveFile(url, headers, ext = '.pdf', fileType = 'document') {
  try {
    const { net } = require('electron');

    // 创建 downloads 目录（PDF和图片应该保存在downloads目录）
    const downloadsDir = path.join(globalState.currentTask.dir, 'downloads');
    if (!fs.existsSync(downloadsDir)) {
      fs.mkdirSync(downloadsDir, { recursive: true });
    }

    // 生成文件名 - 格式: {type}_{sequence}.{ext}
    const timestamp = Date.now();
    const sequence = getNextDocSequence();
    const fileName = `${fileType}_${String(sequence).padStart(3, '0')}${ext}`;
    const filePath = path.join(downloadsDir, fileName);

    // 使用 net.request 下载文件
    const request = net.request(url);

    return new Promise((resolve, reject) => {
      const chunks = [];

      request.on('response', (response) => {
        log.info(`${fileType.toUpperCase()} download started: ${url}, status: ${response.statusCode}`);

        response.on('data', (chunk) => {
          chunks.push(chunk);
        });

        response.on('end', () => {
          try {
            // 合并所有 chunks
            const buffer = Buffer.concat(chunks);

            // 保存文件
            fs.writeFileSync(filePath, buffer);
            log.info(`${fileType.toUpperCase()} saved to: ${filePath}, size: ${buffer.length} bytes`);

            // 获取 MIME 类型
            const mimeType = getMimeTypeFromExt(ext);

            // 保存文件事件到 manifest
            // 使用相对路径 'downloads/filename' 而不是绝对路径
            const relativePath = path.join('downloads', fileName);
            globalState.unifiedEventManager.createAndFlushEvent({
              type: 'file_io',
              fileType: 'download',
              url: url,
              windowId: 'main',
              localPath: relativePath,
              contentSummary: `${fileType.toUpperCase()} downloaded: ${url}`,
              metadata: {
                fileName: fileName,
                mimeType: mimeType,
                fileSize: buffer.length,
                originalUrl: url,
                fileType: fileType,
                contentLength: headers['content-length'] ? headers['content-length'][0] : buffer.length
              }
            });

            resolve(filePath);
          } catch (error) {
            log.error(`Failed to save ${fileType}:`, error);
            reject(error);
          }
        });

        response.on('error', (error) => {
          log.error(`${fileType.toUpperCase()} download error:`, error);
          reject(error);
        });
      });

      request.on('error', (error) => {
        log.error(`${fileType.toUpperCase()} request error:`, error);
        reject(error);
      });

      request.end();
    });
  } catch (error) {
    log.error(`Failed to download ${fileType}:`, error);
  }
}

// 根据文件扩展名获取 MIME 类型
function getMimeTypeFromExt(ext) {
  const extToMime = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip': 'application/zip',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml'
  };
  return extToMime[ext.toLowerCase()] || 'application/octet-stream';
}

// 保持向后兼容：downloadAndSavePDF 调用 downloadAndSaveFile
async function downloadAndSavePDF(url, headers) {
  return downloadAndSaveFile(url, headers, '.pdf', 'document');
}

// 监听Blob URL创建（通过preload脚本）
ipcMain.on('blob-url-created', (event, data) => {
  if (globalState.isRecording && globalState.currentTask) {
    const { blobUrl, blobType, blobSize, binaryData, error } = data;

    // 创建 previews 目录
    const previewsDir = path.join(globalState.currentTask.dir, 'previews');
    if (!fs.existsSync(previewsDir)) {
      fs.mkdirSync(previewsDir, { recursive: true });
    }

    // 生成文件名 - 格式: blob_{uuid}_{type}.{ext}
    const timestamp = Date.now();
    const ext = getBlobExtension(blobType);
    const typeHint = getBlobTypeHint(blobType);
    const fileName = `blob_${timestamp}_${typeHint}${ext}`;
    const filePath = path.join(previewsDir, fileName);

    // 如果有二进制数据，保存到文件
    let localPath = null;
    if (binaryData && !error) {
      try {
        // 将数组转换为 Buffer
        const buffer = Buffer.from(binaryData);
        fs.writeFileSync(filePath, buffer);
        localPath = filePath;
        log.info(`Blob saved to: ${filePath}, size: ${buffer.length} bytes`);
      } catch (err) {
        log.error('Failed to save blob:', err);
      }
    }

    // 保存Blob信息 - 使用统一事件格式
    globalState.unifiedEventManager.createAndFlushEvent({
      type: 'file_io',
      fileType: 'blob',
      url: blobUrl,
      windowId: `win_${event.sender.id}`,
      localPath: localPath,
      contentSummary: `Blob URL created: ${blobUrl}`,
      metadata: {
        fileName: fileName,
        mimeType: blobType,
        fileSize: blobSize
      }
    });

    log.info(`Blob URL captured: ${blobUrl}, type: ${blobType}, saved: ${!!localPath}`);
  }
});

// 根据 MIME 类型获取 Blob 文件扩展名
function getBlobExtension(mimeType) {
  const mimeToExt = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'application/pdf': '.pdf',
    'application/json': '.json',
    'text/plain': '.txt',
    'text/html': '.html',
    'text/css': '.css',
    'application/javascript': '.js',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'audio/mp3': '.mp3',
    'audio/wav': '.wav',
    'audio/webm': '.weba'
  };

  return mimeToExt[mimeType] || '.bin';
}

// 根据 MIME 类型获取 Blob 类型提示
function getBlobTypeHint(mimeType) {
  if (!mimeType) return 'unknown';

  if (mimeType.startsWith('image/')) {
    return 'image';
  } else if (mimeType.startsWith('video/')) {
    return 'video';
  } else if (mimeType.startsWith('audio/')) {
    return 'audio';
  } else if (mimeType === 'application/pdf') {
    return 'document';
  } else if (mimeType === 'application/json') {
    return 'json';
  } else if (mimeType.startsWith('text/')) {
    return 'text';
  }

  return 'blob';
}

// 获取下一个文档序列号
function getNextDocSequence() {
  globalState.docSequence++;
  return globalState.docSequence;
}

// 监听上传文件事件
ipcMain.on('file-upload', (event, data) => {
  if (globalState.isRecording && globalState.currentTask) {
    const { fileName, fileSize, fileType, formData } = data;

    globalState.unifiedEventManager.createAndFlushEvent({
      type: 'file_io',
      fileType: 'upload',
      url: null,
      windowId: `win_${event.sender.id}`,
      localPath: null,
      contentSummary: `File upload: ${fileName} (${fileSize} bytes)`,
      metadata: {
        fileName: fileName,
        fileSize: fileSize,
        mimeType: fileType,
        formData: formData
      }
    });

    log.info(`File upload captured: ${fileName}, size: ${fileSize}`);
  }
});

// 监听错误报告
ipcMain.on('report-error', (event, errorData) => {
  if (globalState.errorDetector) {
    globalState.errorDetector.addError(errorData);
  }

  if (globalState.isRecording && globalState.currentTask && globalState.unifiedEventManager) {
      const errorEvent = globalState.unifiedEventManager.createAndFlushEvent({
        type: 'error',
        contextType: errorData.type || 'unknown',
        description: `Error: ${errorData.message}`,
        semanticLabel: `${errorData.type || 'unknown'} error detected`,
        windowId: `win_${event.sender.id}`,
        url: null,
        hasErrors: true,
        metadata: {
          errorType: errorData.type || 'unknown',
          errorMessage: errorData.message,
          errorStack: errorData.stack
        }
      });
      
      // 保存错误关联到 correlation log
      if (globalState.associationManager) {
        globalState.associationManager.writeCorrelationLog(errorEvent.timestamp, 'error', {
          errorType: errorData.type || 'unknown',
          message: errorData.message,
          filename: errorData.filename,
          lineno: errorData.lineno,
          stack: errorData.stack,
          windowId: `win_${event.sender.id}`
        });
      } else {
        saveCorrelationLog(errorEvent.timestamp, {
          errorType: errorData.type || 'unknown',
          message: errorData.message,
          filename: errorData.filename,
          lineno: errorData.lineno,
          stack: errorData.stack,
          windowId: `win_${event.sender.id}`
        }, 'error', errorEvent.eventId);
      }
    }
});

// 监听UI事件
ipcMain.on('report-ui-event', (event, eventData) => {
  if (globalState.isRecording && globalState.currentTask && globalState.unifiedEventManager) {
      globalState.unifiedEventManager.createAndFlushEvent({
        type: eventData.type || 'ui_event',
        url: eventData.url || null,
        windowId: `win_${event.sender.id}`,
        hasErrors: eventData.hasErrors || false,
        apiRequests: eventData.apiRequests || [],
        responseStatus: eventData.responseStatus || null,
        userAction: {
          xpath: eventData.domPath || null,
          shadowPath: eventData.shadowDomPath || null,
          coordinates: eventData.coordinates || null
        },
        semanticLabel: eventData.semanticLabel || `${eventData.type} event`
      });
    }
});

// 监听用户活动
ipcMain.on('user-activity', () => {
  updateActivityTime();
});

// 监听渲染进程日志
ipcMain.on('renderer-log', (event, logData) => {
  const { level, message, timestamp } = logData;
  const prefix = '[Renderer]';
  switch (level) {
    case 'error':
      log.error(prefix, message);
      break;
    case 'warn':
      log.warn(prefix, message);
      break;
    case 'info':
      log.info(prefix, message);
      break;
    default:
      log.debug(prefix, message);
  }
});

// 监听用户操作
ipcMain.on('user-action', async (event, actionData) => {
  // 不再实时截图，改为记录 snapshot 引用（截图将在录制结束后从视频截取）
  if (globalState.isRecording && globalState.currentTask) {
    // 使用 actionData 中的 timestamp，确保与 DOM snapshot 文件名一致
    const timestamp = actionData.timestamp || Date.now();

    // 检查是否启用了截图功能
    const captureScreenshots = globalState.currentTask.config.options?.captureScreenshots || false;

    if (captureScreenshots) {
      const fileName = `snapshot_${timestamp}.png`;
      // 添加 snapshot 引用信息到 actionData（截图将在录制结束后从视频截取）
      actionData.snapshotFileName = fileName;
      actionData.snapshotPath = `previews/snapshots/${fileName}`;
    }

    // 对于第一次页面加载事件，使用 snapshot_initial.json 作为 DOM 文件名
    // 后续的页面加载使用普通的 timestamp 文件名
    // 注意：initialSnapshotSaved 标志在 saveDOMSnapshot 函数中设置
    if ((actionData.type === 'page-load' || actionData.type === 'page_load') && !globalState.initialSnapshotSaved) {
      actionData.domSnapshotFileName = 'snapshot_initial.json';
      actionData.domSnapshotPath = 'dom/snapshot_initial.json';
    } else {
      actionData.domSnapshotFileName = `snapshot_${timestamp}.json`;
      actionData.domSnapshotPath = `dom/snapshot_${timestamp}.json`;
    }
  }

  // 记录用户行为（包含 snapshot 引用信息）
  // 修复：添加 await 确保异步写入完成
  await recordUserAction(actionData);
});

// 监听 DOM 快照
ipcMain.on('dom-snapshot', (event, snapshotData) => {
  saveDOMSnapshot(snapshotData);
});

// 监听页面加载开始（从 renderer.js 的 did-start-loading 事件发送，比 preload 脚本更早）
ipcMain.on('page-load-start', (event, loadData) => {
  if (!globalState.isRecording || !globalState.currentTask) {
    return;
  }
  
  const timestamp = loadData.timestamp || Date.now();
  log.info('[Main] Page load start received from renderer:', loadData.url, 'timestamp:', timestamp);
  
  // 【优化】使用统一 ID 生成服务创建 page-load-start 事件
  if (globalState.unifiedEventManager) {
    const EventIdService = require('../shared/event-id-service');
    const eventId = EventIdService.generateId('evt_page_load', {
      source: 'main.page-load-start',
      url: loadData.url?.substring(0, 100)
    });
    
    globalState.unifiedEventManager.createEvent({
      eventId: eventId,
      type: 'page-load-start',
      timestamp: timestamp,
      url: loadData.url,
      title: 'Page Load Start',
      isLoading: true
    });
    // 立即刷新到磁盘
    globalState.unifiedEventManager.flushEvent(eventId);
    log.info('[Main] Page-load-start event created from renderer:', eventId);
  }
});

// 监听网络请求跟踪（已废弃，使用 webRequest.onCompleted 替代）
ipcMain.on('request-tracked', (event, requestData) => {
  log.debug('Received request-tracked from renderer (ignored):', requestData.requestUrl);
});

// 监听获取元素路径请求（支持 Shadow DOM）
ipcMain.handle('get-element-path', async (event, { x, y, webContentsId }) => {
  try {
    const { webContents } = require('electron');
    const targetWebContents = webContents.fromId(webContentsId);

    if (!targetWebContents) {
      throw new Error('WebContents not found');
    }

    // 使用 CDPManager 获取元素路径
    const elementInfo = await globalState.cdpManager.getElementPathAtPoint(targetWebContents, x, y);
    return elementInfo;
  } catch (error) {
    log.error('Failed to get element path:', error);
    return null;
  }
});

// 监听获取 webContents ID
ipcMain.handle('get-webcontents-id', (event) => {
  return event.sender.id;
});

// 获取平台信息
ipcMain.handle('get-platform', () => {
  return process.platform;
});

// 聚焦窗口（确保录制时窗口可见）
ipcMain.handle('focus-window', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    if (win.isMinimized()) {
      win.restore();
    }
    win.show();
    win.focus();
    win.moveTop();
    log.info('Window focused for recording');
    return true;
  }
  return false;
});

// 获取 webview preload 脚本路径
ipcMain.handle('get-webview-preload-path', () => {
  return path.join(__dirname, '..', 'preload', 'webview-preload.js');
});

// 获取屏幕录制源
ipcMain.handle('get-screen-sources', async () => {
  try {
    const { desktopCapturer } = require('electron');
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 }
    });
    log.info(`Found ${sources.length} screen sources`);
    return sources;
  } catch (error) {
    log.error('Failed to get screen sources:', error);
    throw error;
  }
});

// 获取窗口列表（用于录制特定窗口）
ipcMain.handle('get-window-sources', async () => {
  try {
    const { desktopCapturer } = require('electron');
    // Windows 上同时获取 screen 和 window 类型
    const types = process.platform === 'win32' ? ['screen', 'window'] : ['window'];
    const sources = await desktopCapturer.getSources({
      types: types,
      thumbnailSize: { width: 1920, height: 1080 },
      fetchWindowIcons: true
    });
    log.info(`Found ${sources.length} window sources`);
    sources.forEach(source => {
      log.info(`Window source: id=${source.id}, name=${source.name}`);
    });
    return sources;
  } catch (error) {
    log.error('Failed to get window sources:', error);
    throw error;
  }
});

// 获取当前窗口ID
ipcMain.handle('get-current-window-id', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    return win.id;
  }
  return null;
});

// 修复：获取当前窗口尺寸
ipcMain.handle('get-current-window-bounds', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    const bounds = win.getBounds();
    log.info('Get window bounds:', bounds);
    return bounds;
  }
  return null;
});

// 修复：聚焦当前窗口（避免被其他窗口遮挡）
ipcMain.handle('focus-current-window', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    if (win.isMinimized()) {
      win.restore();
    }
    win.show();
    win.focus();
    win.moveTop();
    log.info('Window focused for recording');
    return true;
  }
  return false;
});

// 保存视频数据
ipcMain.handle('save-video-data', async (event, taskId, data) => {
  try {
    // 将 Uint8Array 转换为 Buffer
    const buffer = Buffer.from(data);
    log.info(`Received video data, size: ${buffer.length} bytes`);

    // 清理 taskId，移除 task_ 前缀
    const cleanTaskId = taskId.replace(/^task_/, '');
    log.info(`Clean taskId: ${cleanTaskId}`);

    // 查找任务目录
    let taskDir = path.join(STORAGE_PATH, taskId);

    // 如果直接查找失败，尝试查找各种格式的目录
    if (!fs.existsSync(taskDir)) {
      const entries = fs.readdirSync(STORAGE_PATH, { withFileTypes: true });

      // 首先尝试匹配新的命名格式：task_{任务名称}_{网页地址}_{cleanTaskId}
      let matchingDir = entries.find(entry => {
        if (entry.isDirectory() && entry.name.startsWith('task_')) {
          const suffix = `_${cleanTaskId}`;
          return entry.name.endsWith(suffix);
        }
        return false;
      });

      // 尝试匹配 task_{cleanTaskId}_{timestamp} 格式
      if (!matchingDir) {
        matchingDir = entries.find(entry => {
          if (entry.isDirectory()) {
            const pattern = new RegExp(`^task_${cleanTaskId}_(\\d+)$`);
            return pattern.test(entry.name);
          }
          return false;
        });
      }

      // 如果没找到，尝试匹配包含 cleanTaskId 的任何目录
      if (!matchingDir) {
        matchingDir = entries.find(entry => {
          if (entry.isDirectory()) {
            return entry.name.includes(cleanTaskId);
          }
          return false;
        });
      }

      if (matchingDir) {
        taskDir = path.join(STORAGE_PATH, matchingDir.name);
        log.info(`Found matching directory: ${matchingDir.name}`);
      }
    }

    if (!fs.existsSync(taskDir)) {
      throw new Error(`Task directory not found: ${taskId}`);
    }

    // 保存视频数据为 webm 文件（使用 .webm 扩展名，但内容可能是 webm 或 mp4 格式）
    const videoPath = path.join(taskDir, 'video', 'recording.webm');
    fs.writeFileSync(videoPath, buffer);
    
    log.info(`Video saved to: ${videoPath}, size: ${buffer.length} bytes`);
    
    // 使用 FFmpeg 转换为 MP4
    const mp4Path = path.join(taskDir, 'video', 'raw_record.mp4');
    const ffmpegPath = globalState.ffmpegManager ? globalState.ffmpegManager.ffmpegPath : 'ffmpeg';
    
    return new Promise((resolve, reject) => {
      // 检查 FFmpeg 是否可用
      if (!ffmpegPath) {
        log.error('FFmpeg is not available, cannot convert video');
        // 如果 FFmpeg 不可用，直接返回 webm 文件路径
        resolve({ success: true, path: videoPath, format: 'webm' });
        return;
      }
      
      const { spawn } = require('child_process');
      const encoder = process.platform === 'darwin' ? 'h264_videotoolbox' : 'libx264';
      
      const args = [
        '-fflags', '+genpts',  // 生成时间戳
        '-i', videoPath,
        '-c:v', encoder,
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-y'
      ];
      
      if (encoder === 'libx264') {
        args.push('-preset', 'fast');
        args.push('-crf', '23');
      } else if (encoder === 'h264_videotoolbox') {
        args.push('-b:v', '5000k');
        args.push('-allow_sw', '1');
      }
      
      args.push(mp4Path);
      
      log.info('Converting video to MP4:', args.join(' '));
      
      const ffmpeg = spawn(ffmpegPath, args);
      
      let stderr = '';
      ffmpeg.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      ffmpeg.on('close', async (code) => {
        if (code === 0) {
          log.info('Video conversion completed:', mp4Path);

          // 修复：从 task_config.json 读取截图配置，避免依赖 globalState.currentTask
          let captureScreenshots = false;
          try {
            const taskConfigPath = path.join(taskDir, 'task_config.json');
            if (fs.existsSync(taskConfigPath)) {
              const taskConfig = JSON.parse(fs.readFileSync(taskConfigPath, 'utf8'));
              captureScreenshots = taskConfig.options?.captureScreenshots || false;
            }
          } catch (err) {
            log.warn('Failed to read task config for screenshot setting:', err);
          }
          
          if (captureScreenshots) {
            // 从视频中截取所有需要的帧（根据 training_manifest.jsonl 中的 video_time）
            try {
              await extractSnapshotsFromVideo(taskDir, mp4Path);
            } catch (err) {
              log.error('Failed to extract snapshots from video:', err);
            }
          } else {
            log.info('Screenshots disabled, skipping snapshot extraction');
          }

          // 删除临时的 webm 文件
          try {
            fs.unlinkSync(videoPath);
            log.info('Cleaned up temporary webm file');
          } catch (err) {
            log.warn('Failed to cleanup webm file:', err);
          }
          resolve({ success: true, path: mp4Path });
        } else {
          log.error('FFmpeg conversion failed with code:', code);
          log.error('FFmpeg stderr:', stderr);
          log.error('FFmpeg command:', ffmpegPath, args.join(' '));
          reject(new Error(`FFmpeg exited with code ${code}: ${stderr}`));
        }
      });
      
      ffmpeg.on('error', (error) => {
        log.error('FFmpeg process error:', error);
        reject(error);
      });
    });
  } catch (error) {
    log.error('Failed to save video data:', error);
    throw error;
  }
});

// 监听启动回放模式
ipcMain.handle('start-replay', async (event, { taskId, url }) => {
  try {
    const taskDir = path.join(STORAGE_PATH, taskId);

    if (!fs.existsSync(taskDir)) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // 创建回放窗口
    const replayWindow = createReplayWindow(taskDir, url);

    return {
      success: true,
      windowId: replayWindow.id
    };
  } catch (error) {
    log.error('Failed to start replay:', error);
    throw error;
  }
});

// 应用生命周期
app.whenReady().then(async () => {
  // 记录启动日志（帮助诊断 Windows 启动问题）
  log.info('========================================');
  log.info('Sentinel Browser 启动');
  log.info(`平台: ${process.platform} ${os.release()}`);
  log.info(`架构: ${process.arch}`);
  log.info(`Electron: ${process.versions.electron}`);
  log.info(`Node: ${process.versions.node}`);
  log.info(`用户数据目录: ${app.getPath('userData')}`);
  log.info(`当前工作目录: ${process.cwd()}`);
  log.info(`应用路径: ${app.getAppPath()}`);
  log.info(`是否打包: ${app.isPackaged}`);
  log.info('========================================');

  // macOS 屏幕录制权限检查
  if (process.platform === 'darwin') {
    try {
      const screenCaptureStatus = systemPreferences.getMediaAccessStatus('screen');
      log.info('Screen capture permission status:', screenCaptureStatus);
      
      if (screenCaptureStatus !== 'granted') {
        log.info('Requesting screen capture permission...');
        const granted = await systemPreferences.askForMediaAccess('screen');
        log.info('Screen capture permission granted:', granted);
      }
    } catch (error) {
      log.error('Failed to check/request screen capture permission:', error);
    }
  }

  // 确保在应用 ready 时初始化管理器
  initializeManagers();
  createMainWindow();

  // 网络请求监听已由 Preload 层的 CausalChainTracker 处理
  // 不再使用 webRequest API（避免重复拦截和时间匹配的不准确性）
  // setupNetworkListeners();

  // 注册新窗口创建事件
  app.on('browser-window-created', (event, window) => {
    // 自动注入监控脚本
    window.webContents.on('dom-ready', () => {
      if (globalState.errorDetector) {
        globalState.errorDetector.injectMonitoring(window.webContents);
      }
    });

    // 设置下载处理器
    setupDownloadHandler(window);

    // 监听新窗口打开
    window.webContents.on('new-window', (event, url, frameName, disposition, options) => {
      log.info(`New window opened: ${url}`);

      if (globalState.isRecording && globalState.currentTask) {
        // 记录新窗口打开事件
        const timestamp = Date.now();
        const fileName = `snapshot_newwindow_${timestamp}.png`;
        globalState.unifiedEventManager.createAndFlushEvent({
          type: 'new_window',
          url: url,
          windowId: `win_${window.id}`,
          semanticLabel: `New window opened: ${url}`,
          metadata: {
            frameName: frameName,
            disposition: disposition,
            windowFeatures: options,
            timestamp: timestamp,
            snapshotFileName: fileName,
            snapshotPath: `previews/snapshots/${fileName}`
          }
        });
        log.info(`New window snapshot reference recorded: ${fileName}`);
      }
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopRecording();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopRecording();
});

// 全局快捷键
app.on('ready', () => {
  const { globalShortcut } = require('electron');

  // Ctrl+Shift+L 切换开发者工具
  globalShortcut.register('CommandOrControl+Shift+L', () => {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (focusedWindow) {
      focusedWindow.webContents.toggleDevTools();
    }
  });
});

// 处理外部链接和新窗口
app.on('web-contents-created', (event, contents) => {
  contents.setWindowOpenHandler(({ url, frameName, disposition }) => {
    log.info(`Window open handler triggered: ${url}, disposition: ${disposition}`);

    // 如果是新窗口或新标签页，通知 renderer 创建新标签卡
    if (disposition === 'new-window' || disposition === 'foreground-tab' || disposition === 'background-tab') {
      // 获取对应的窗口
      const win = BrowserWindow.fromWebContents(contents);
      if (win) {
        // 发送消息给 renderer 进程创建新标签卡
        win.webContents.send('create-new-tab', url);
        log.info(`Sent create-new-tab message to renderer: ${url}`);
      }
      return { action: 'deny' }; // 阻止默认行为
    }

    // 其他情况允许打开
    return { action: 'allow' };
  });
});

// 定期清理旧状态文件
setInterval(() => {
  if (globalState.stateManager) {
    globalState.stateManager.cleanupOldStates();
  }
}, 24 * 60 * 60 * 1000); // 每天清理一次

log.info('Sentinel Browser main process initialized');
