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

// 全局变量，用于存储当前事件的 apiRequests，绕过参数传递问题
let currentApiRequests = null;

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

// 简单的UUID生成函数（不依赖外部模块）
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

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
    console.log('[Main] Created log directory:', logDir);
  }
} catch (err) {
  console.error('[Main] Failed to create log directory:', err);
}

// electron-log v5 配置 - 使用绝对路径
log.transports.file.resolvePathFn = () => logFilePath;

// 强制立即写入日志
log.transports.file.sync = true;

// 记录日志配置信息（使用 log.info 确保写入文件）
console.log('[Main] Log directory:', logDir);
console.log('[Main] Log file:', logFilePath);
log.info('[Main] Logging initialized');
log.info('[Main] Log directory:', logDir);
log.info('[Main] Log file:', logFilePath);
log.info('[Main] Logging initialized');
log.info('[Main] Log directory:', logDir);
log.info('[Main] Log file:', logFilePath);

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
  manifestStream: null,
  apiLogStream: null,
  consoleErrorStream: null,
  stateInjector: null,
  initialSnapshotSaved: false,  // 标记是否已保存初始 DOM snapshot
  isReplayMode: false,
  isReplaying: false,  // 回放模式标志
  replayTaskDir: null, // 回放任务目录
  docSequence: 0, // PDF 文档序列号计数器
  downloadedPdfs: new Set(), // 已下载的 PDF URL 集合，用于去重
  pendingEvents: [], // 暂存待写入的事件，等待网络请求完成后再写入
  flushedEvents: new Map() // 已写入文件的事件缓存（timestamp -> event），用于网络请求延迟关联
};

// 动态资源列表（用于懒加载等资源）
const dynamicResources = [];

// 网络请求缓冲队列（用于 page-load 事件的延迟关联）
const requestBuffer = [];
const REQUEST_BUFFER_WINDOW = 10000; // 10 秒的缓冲窗口

// 添加动态资源（用于懒加载等资源）
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

// 查找与请求时间戳最接近的事件时间戳（提前定义避免Windows打包问题）
function findEventTimestampForRequest(requestTimestamp) {
  // 在 pendingEvents 中查找最接近的事件
  for (const event of globalState.pendingEvents) {
    const timeDiff = Math.abs(event.timestamp - requestTimestamp);
    // 如果在 5 秒内，认为是同一个事件
    if (timeDiff < 5000) {
      return event.timestamp;
    }
  }
  
  // 在已刷新的事件中查找
  for (const [timestamp, event] of globalState.flushedEvents) {
    const timeDiff = Math.abs(timestamp - requestTimestamp);
    if (timeDiff < 5000) {
      return timestamp;
    }
  }
  
  return null;
}

// 存储路径配置 - Mac/Linux 使用默认路径，Windows 由用户选择
let STORAGE_PATH = null;

const getDefaultStoragePath = () => {
  // Windows 使用用户数据目录，macOS/Linux 使用 /tmp
  if (process.platform === 'win32') {
    return path.join(app.getPath('userData'), 'SentinelBrowser', 'collections');
  }
  // 使用 /tmp 目录避免 macOS iCloud 和权限问题
  return path.join('/tmp', 'SentinelBrowser', 'collections');
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
  // 避免重复初始化
  if (globalState.ffmpegManager) {
    log.debug('Managers already initialized, skipping...');
    return;
  }

  log.info('Initializing managers...');

  // Windows 平台：等待用户选择存储目录，不自动设置默认路径
  if (!STORAGE_PATH && process.platform !== 'win32') {
    log.warn('STORAGE_PATH not set, using default path');
    STORAGE_PATH = getDefaultStoragePath();
  }

  globalState.ffmpegManager = new FFmpegManager();
  globalState.watchdogManager = new WatchdogManager();
  globalState.errorDetector = new ErrorDetector();
  globalState.lineageTracker = new LineageTracker();
  globalState.stateManager = new StateManager(STORAGE_PATH);
  globalState.cdpManager = new CDPManager();
  globalState.dataSchemaManager = new DataSchemaManager();
  globalState.stateInjector = new StateInjector();
  globalState.logUploader = new LogUploader('http://42.193.126.52');

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

  // Windows 平台隐藏菜单栏
  if (process.platform === 'win32') {
    mainWindow.setMenuBarVisibility(false);
  }

  // 加载渲染进程
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 开发工具 - 默认不打开，需要时按 Ctrl+Shift+I 或 Cmd+Option+I 打开
  // if (!app.isPackaged) {
  //   mainWindow.webContents.openDevTools();
  // }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    
    // Windows: 如果缺少 VC++ Redistributable，显示友好提示
    if (process.platform === 'win32' && global.vcRedistMissing) {
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
            // 打开下载链接
            shell.openExternal('https://aka.ms/vs/17/release/vc_redist.x64.exe');
          }
        });
      }, 1000); // 延迟1秒显示，避免遮挡启动画面
    }
  });

  // 窗口关闭处理
  mainWindow.on('closed', () => {
    stopRecording();
  });

  // 注册窗口到谱系追踪器
  globalState.lineageTracker.registerWindow(`win_${mainWindow.id}`, {
    url: '',
    title: 'Sentinel Browser'
  });

  globalState.windows.set(mainWindow.id, {
    window: mainWindow,
    parentId: null,
    lineage: []
  });

  // 设置网络请求监听（主窗口也需要）
  setupTabNetworkListeners(mainWindow);

  // 注入错误监控
  mainWindow.webContents.on('dom-ready', () => {
    if (globalState.errorDetector) {
      globalState.errorDetector.injectMonitoring(mainWindow.webContents);
    }
  });

  // 捕获 renderer 进程的 console 消息
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const levelNames = ['debug', 'log', 'warning', 'error'];
    const levelName = levelNames[level] || 'log';
    if (message.includes('[Sentinel]') || message.includes('[Sentinel Renderer]')) {
      log.info('[Renderer Console]', message);
    }
  });
  
  // 处理 webview 的 ipc-message（点击事件等）
  mainWindow.webContents.on('ipc-message', (event, channel, ...args) => {
    const data = args[0];

    // DOM snapshot 事件由 renderer 处理，不再直接处理
    // renderer.js 会调用 window.sentinelAPI.saveDOMSnapshot，发送 dom-snapshot 消息
    if (channel === 'sentinel-dom-snapshot') {
      // 忽略，由 renderer 处理
      return;
    }

    if (!globalState.isRecording || !globalState.currentTask) return;

    // 检查是否处于暂停状态
    if (globalState.isPaused) {
      return;
    }

    switch (channel) {
      case 'sentinel-click':
        log.info('Webview click received:', data.selector, 'event.sender:', typeof event.sender, 'id:', event.sender?.id);

        // 记录 click 事件（不再实时截图，改为记录 video_time，录制结束后从视频截取）
        {
          // 使用事件中的 timestamp，确保与 DOM snapshot 文件名一致
          const timestamp = data.timestamp || Date.now();
          const clickData = {
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
            // 生成 snapshot 文件名（用于后续从视频截取）
            snapshotFileName: `snapshot_${timestamp}.png`,
            snapshotPath: `previews/snapshots/snapshot_${timestamp}.png`,
            domSnapshotFileName: `snapshot_${timestamp}.json`,
            domSnapshotPath: `dom/snapshot_${timestamp}.json`
          };

          // 记录 click 事件（包含 snapshot 引用信息，截图将在录制结束后从视频截取）
          recordUserAction(clickData);
          // DOM snapshot 由 renderer.js 触发，这里不再重复触发
        }
        break;

      case 'sentinel-input':
        log.debug('Webview input received:', data.selector);
        {
          const timestamp = data.timestamp || Date.now();
          recordUserAction({
            type: 'input',
            timestamp: timestamp,
            xpath: data.xpath,
            selector: data.selector,
            tagName: data.tagName,
            inputType: data.inputType,
            value: data.value,
            url: data.url,
            domSnapshotFileName: `snapshot_${timestamp}.json`,
            domSnapshotPath: `dom/snapshot_${timestamp}.json`
          });

          // DOM snapshot 由 renderer.js 触发，这里不再重复触发
        }
        break;

      case 'sentinel-scroll-start':
        {
          const timestamp = data.timestamp || Date.now();
          recordUserAction({
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
            domSnapshotFileName: `snapshot_${timestamp}.json`,
            domSnapshotPath: `dom/snapshot_${timestamp}.json`
          });
        }
        break;

      case 'sentinel-scroll':
        {
          const timestamp = data.timestamp || Date.now();
          recordUserAction({
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
            scrollSequenceId: data.scrollSequenceId,
            triggerSource: data.triggerSource,
            url: data.url,
            domSnapshotFileName: `snapshot_${timestamp}.json`,
            domSnapshotPath: `dom/snapshot_${timestamp}.json`
          });
          // DOM snapshot 由 renderer.js 触发，这里不再重复触发
        }
        break;

      case 'sentinel-scroll-end':
        {
          const timestamp = data.timestamp || Date.now();
          recordUserAction({
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
            scrollSequenceId: data.scrollSequenceId,
            directionChanged: data.directionChanged,
            url: data.url,
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

      case 'sentinel-page-loaded':
        log.info('Webview page loaded:', data.url);
        {
          // 使用后端生成的时间戳，确保与网络请求时间戳一致
          const timestamp = Date.now();
          // 只有第一次页面加载使用 snapshot_initial.json，后续使用 timestamp 文件名
          const isInitial = !globalState.initialSnapshotSaved;
          recordUserAction({
            type: 'page-load',
            timestamp: timestamp,
            url: data.url,
            title: data.title,
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

  // 设置网络请求监听（关键：新标签页需要独立的网络监听）
  setupTabNetworkListeners(tabWindow);

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
          // 使用后端生成的时间戳，确保与网络请求时间戳一致
          const timestamp = Date.now();
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
        
        // 写入API流量日志
        if (globalState.apiLogStream) {
          const apiEntry = {
            timestamp: timestamp,
            url: url,
            status: statusCode,
            method: details.method,
            resourceType: resourceType,
            windowId: windowId
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
        
        // 将请求加入缓冲队列，等待后续统一关联
        // 实际关联由 post-process-correlation.js 脚本在录制结束后完成
        requestBuffer.push(apiRequest);
        log.debug('WebRequest buffered:', url, 'timestamp:', requestTimestamp);
      }
    }
  });

  // 拦截文件请求（PDF、图片、文档等）
  session.webRequest.onBeforeRequest((details, callback) => {
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
          const fileEvent = globalState.dataSchemaManager.generateFileIOEvent('preview', {
            fileName: path.basename(details.url),
            mimeType: matchedPattern.mimeType,
            localPath: null,
            contentSummary: `${matchedPattern.type.toUpperCase()} detected: ${details.url}`,
            windowId: windowId,
            url: details.url
          });

          appendToManifest(fileEvent);
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
      
      // 记录下载事件 - 使用完整Schema
      const downloadEvent = globalState.dataSchemaManager.generateFileIOEvent('download', {
        fileName: fileName,
        fileSize: totalBytes,
        mimeType: item.getMimeType(),
        localPath: path.join('downloads', fileName),
        windowId: `win_${browserWindow.id}`,
        url: item.getURL()
      });
      
      appendToManifest(downloadEvent);
      
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

  // 清空动态资源列表
  clearDynamicResources();

  // 打开 training_manifest.jsonl（黄金文件，取代原 user_actions）
  const manifestPath = path.join(taskDir, 'training_manifest.jsonl');
  globalState.manifestStream = fs.createWriteStream(manifestPath, { flags: 'a' });

  // 打开API流量日志
  const apiLogPath = path.join(taskDir, 'network', 'api_traffic.jsonl');
  globalState.apiLogStream = fs.createWriteStream(apiLogPath, { flags: 'a' });

  // 打开控制台错误日志
  const consoleErrorPath = path.join(taskDir, 'logs', 'console_errors.jsonl');
  globalState.consoleErrorStream = fs.createWriteStream(consoleErrorPath, { flags: 'a' });

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
  const startEvent = globalState.dataSchemaManager.generateUserContextEvent({
    type: 'task_start',
    description: `Task started: ${taskConfig.name || taskId}`
  });
  appendToManifest(startEvent);

  // 视频录制现在在 renderer 进程中完成
  // 主进程只负责视频转换
  log.info('Video recording will be handled by renderer process');

  // Watchdog 已禁用，避免启动警告
  // globalState.watchdogManager.start();

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

  globalState.isRecording = false;

  // 清空已下载的 PDF 集合
  globalState.downloadedPdfs.clear();

  // 视频录制在 renderer 进程中完成，主进程不需要停止录制
  log.info('Video recording stopped by renderer process');

  // Watchdog 已禁用
  // globalState.watchdogManager.stop();

  // 清除非活动定时器
  if (globalState.inactivityTimer) {
    clearTimeout(globalState.inactivityTimer);
    globalState.inactivityTimer = null;
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

  // 关闭 console_errors.jsonl 流
  if (globalState.consoleErrorStream) {
    globalState.consoleErrorStream.end();
    globalState.consoleErrorStream = null;
  }

  // 保存任务数据
  if (globalState.currentTask) {
    // 记录任务结束事件
    if (globalState.dataSchemaManager) {
      const stopEvent = globalState.dataSchemaManager.generateUserContextEvent({
        type: 'task_stop',
        description: `Task stopped: ${globalState.currentTask.id}`
      });
      appendToManifest(stopEvent);
    }

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
        const taskInfo = {
          id: globalState.currentTask.id,
          name: globalState.currentTask.config?.name || 'unknown',
          url: globalState.currentTask.config?.url || 'unknown',
          duration: Date.now() - globalState.currentTask.startTime
        };
        const uploadResults = await globalState.logUploader.uploadTaskLogs(logDir, taskInfo);
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

      // 只处理有 snapshotFileName 的事件
      if (event._metadata?.snapshotFileName) {
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

        const outputPath = path.join(snapshotsDir, event._metadata.snapshotFileName);

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

// 追加到manifest（原子写入）
function appendToManifest(event) {
  if (!globalState.isRecording || !globalState.manifestStream) {
    return;
  }

  // 先写入之前暂存的事件
  flushPendingEvents();

  // 如果事件已经是完整Schema格式，直接使用
  // 否则需要包装成完整Schema格式
  let fullEvent = event;

  if (!event.window_context || !event.user_context) {
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
    }
  }

  // 验证数据完整性
  if (globalState.dataSchemaManager && !globalState.dataSchemaManager.validateEvent(fullEvent)) {
    log.warn('Event validation failed, attempting to sanitize');
    fullEvent = globalState.dataSchemaManager.sanitizeEvent(fullEvent);
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
  }

  const line = JSON.stringify(fullEvent) + '\n';
  globalState.manifestStream.write(line);
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
    const ext = path.extname(fileName) || getExtensionByMimeType(headers);
    const safeFileName = `${Date.now()}_${fileName.replace(/[^a-zA-Z0-9.-]/g, '_')}${ext}`;
    
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
  // 在 pendingEvents 中查找
  const pendingEvent = globalState.pendingEvents.find(e => e.timestamp === eventTimestamp);
  if (pendingEvent) {
    if (!pendingEvent.apiRequests) {
      pendingEvent.apiRequests = [];
    }
    pendingEvent.apiRequests.push(apiRequest);
    return;
  }
  
  // 在已刷新的事件中查找并更新
  const flushedEvent = globalState.flushedEvents.get(eventTimestamp);
  if (flushedEvent) {
    if (!flushedEvent.apiRequests) {
      flushedEvent.apiRequests = [];
    }
    flushedEvent.apiRequests.push(apiRequest);
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
// 使用 flushedEvents 中的完整事件数据（包含后续关联的网络请求）
function regenerateManifestFile(taskDir) {
  try {
    const manifestPath = path.join(taskDir, 'training_manifest.jsonl');
    
    // 按时间戳排序所有事件
    const sortedEvents = Array.from(globalState.flushedEvents.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([_, event]) => event);
    
    // 写入文件
    const lines = sortedEvents.map(event => JSON.stringify(event)).join('\n') + '\n';
    fs.writeFileSync(manifestPath, lines);
    
    log.info('Regenerated manifest file with', sortedEvents.length, 'events');
    return true;
  } catch (error) {
    log.error('Failed to regenerate manifest file:', error);
    return false;
  }
}

// 记录用户操作
function recordUserAction(actionData) {
  if (!globalState.isRecording || !globalState.manifestStream) {
    return;
  }

  // 检查是否处于暂停状态
  if (globalState.isPaused) {
    return;
  }

  // 使用 DataSchemaManager 生成完整格式的事件
  if (globalState.dataSchemaManager) {
    // 网络请求将通过 webRequest.onCompleted 异步关联到 pendingEvents 中的事件
    // 这里先创建事件，不传递 apiRequests（初始为空数组）
    log.info('Recording user action:', actionData.type, 'timestamp:', actionData.timestamp);
    
    // 使用增强版事件生成，包含页面指纹和用户意图
    const fullEvent = globalState.dataSchemaManager.generateEnhancedUserActionEvent(actionData.type, {
      semanticLabel: `${actionData.type} on ${actionData.selector || actionData.xpath || 'unknown element'}`,
      domPath: actionData.xpath || actionData.selector,
      shadowDomPath: actionData.shadowPath,
      coordinates: actionData.coordinates,
      windowId: actionData.windowId || 'win_1',
      url: actionData.url,
      title: actionData.title,
      // DOM统计信息（如果可用）
      domStats: actionData.domStats || {},
      // 元素信息用于意图推断
      text: actionData.text,
      selector: actionData.selector,
      inputType: actionData.inputType,
      name: actionData.name,
      key: actionData.key,
      // 错误信息
      hasErrors: actionData.hasErrors || false,
      errorInfo: actionData.errorInfo || null,
      apiRequests: [], // 初始为空，由 webRequest.onCompleted 异步填充
      metadata: {
        tagName: actionData.tagName,
        text: actionData.text,
        inputType: actionData.inputType,
        value: actionData.value,
        key: actionData.key,
        // Scroll 基础字段
        scrollX: actionData.scrollX,
        scrollY: actionData.scrollY,
        // Scroll 增强字段（用于记录完整的滚动信息）
        scrollStartX: actionData.scrollStartX,
        scrollStartY: actionData.scrollStartY,
        scrollDeltaX: actionData.scrollDeltaX,
        scrollDeltaY: actionData.scrollDeltaY,
        scrollDuration: actionData.scrollDuration,
        direction: actionData.direction,
        scrollSequenceId: actionData.scrollSequenceId,
        directionChanged: actionData.directionChanged,
        triggerSource: actionData.triggerSource,
        // 其他字段
        title: actionData.title,
        snapshotFileName: actionData.snapshotFileName,
        snapshotPath: actionData.snapshotPath,
        domSnapshotFileName: actionData.domSnapshotFileName,
        domSnapshotPath: actionData.domSnapshotPath
      }
    });
    
    // 将事件暂存，等待网络请求完成后再写入
    globalState.pendingEvents.push(fullEvent);
    log.info('Event pending, waiting for network requests:', actionData.type, 'pending events:', globalState.pendingEvents.length);
    
    // 延迟写入，等待网络请求完成（2秒后，确保所有相关请求都已完成）
    setTimeout(() => {
      flushPendingEvents();
    }, 2000);
    
    log.debug('User action recorded:', actionData.type);
  } else {
    // 降级处理：直接写入简单格式
    const action = {
      timestamp: actionData.timestamp || Date.now(),
      type: actionData.type,
      url: actionData.url,
      xpath: actionData.xpath,
      selector: actionData.selector,
      tagName: actionData.tagName,
      text: actionData.text,
      coordinates: actionData.coordinates,
      inputType: actionData.inputType,
      value: actionData.value,
      key: actionData.key,
      code: actionData.code,
      scrollX: actionData.scrollX,
      scrollY: actionData.scrollY,
      title: actionData.title,
      changeCount: actionData.changeCount
    };

    const line = JSON.stringify(action) + '\n';
    globalState.manifestStream.write(line);
    log.debug('User action recorded (simple format):', action.type);
  }
}

// 保存 DOM 快照
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
    
    // 生成文件名
    // 只有第一次 initial snapshot 使用 snapshot_initial.json
    // 后续的 initial snapshot（如页面跳转后的新页面）使用 timestamp 文件名
    let fileName;
    if (isInitial && !globalState.initialSnapshotSaved) {
      fileName = 'snapshot_initial.json';
      globalState.initialSnapshotSaved = true;
    } else {
      fileName = `snapshot_${timestamp}.json`;
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
    if (globalState.dataSchemaManager) {
      const fileSavedEvent = globalState.dataSchemaManager.generateFileIOEvent('upload-saved', {
        fileName: fileData.fileName,
        fileSize: fileSize,
        mimeType: fileData.fileType,
        localPath: path.join('uploads', fileName),
        windowId: 'win_1',
        url: fileData.url,
        metadata: {
          xpath: fileData.xpath,
          selector: fileData.selector,
          isImage: fileData.isImage,
          savedFileName: fileName,
          savedFilePath: filePath
        }
      });

      appendToManifest(fileSavedEvent);
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

// 选择存储目录（Windows）
ipcMain.handle('select-storage-directory', async (event) => {
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
  if (globalState.dataSchemaManager) {
    const pauseEvent = globalState.dataSchemaManager.generateUserContextEvent({
      type: 'pause',
      description: 'Recording paused by user'
    });
    appendToManifest(pauseEvent);
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
  if (globalState.dataSchemaManager) {
    const resumeEvent = globalState.dataSchemaManager.generateUserContextEvent({
      type: 'resume',
      description: 'Recording resumed by user'
    });
    appendToManifest(resumeEvent);
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
        const eventTimestamp = findEventTimestampForRequest(requestTimestamp);
        log.info('WebRequest onCompleted - request timestamp:', requestTimestamp, 'matched event:', eventTimestamp, 'url:', url);
        
        if (eventTimestamp) {
          // 更新暂存的事件，添加网络请求
          updatePendingEventWithApiRequest(eventTimestamp, apiRequest);
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
          // 记录文件事件 - 使用完整Schema
          const fileEvent = globalState.dataSchemaManager.generateFileIOEvent('preview', {
            fileName: path.basename(details.url),
            mimeType: matchedPattern.mimeType,
            localPath: null, // 流拦截不保存文件，只记录元数据
            contentSummary: `${matchedPattern.type.toUpperCase()} detected: ${details.url}`,
            windowId: `win_${details.webContentsId}`,
            url: details.url
          });

          appendToManifest(fileEvent);
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
            const fileEvent = globalState.dataSchemaManager.generateFileIOEvent('download', {
              fileName: fileName,
              mimeType: mimeType,
              fileSize: buffer.length,
              localPath: relativePath,
              contentSummary: `${fileType.toUpperCase()} downloaded: ${url}`,
              windowId: 'main',
              url: url,
              metadata: {
                originalUrl: url,
                fileType: fileType,
                contentLength: headers['content-length'] ? headers['content-length'][0] : buffer.length
              }
            });

            appendToManifest(fileEvent);

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

    // 保存Blob信息 - 使用完整Schema
    const blobEvent = globalState.dataSchemaManager.generateFileIOEvent('blob', {
      fileName: fileName,
      mimeType: blobType,
      fileSize: blobSize,
      localPath: localPath,
      contentSummary: `Blob URL created: ${blobUrl}`,
      windowId: `win_${event.sender.id}`,
      url: blobUrl
    });

    appendToManifest(blobEvent);

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

    const uploadEvent = globalState.dataSchemaManager.generateFileIOEvent('upload', {
      fileName: fileName,
      fileSize: fileSize,
      mimeType: fileType,
      localPath: null,
      contentSummary: `File upload: ${fileName} (${fileSize} bytes)`,
      windowId: `win_${event.sender.id}`,
      url: null,
      metadata: {
        formData: formData
      }
    });

    appendToManifest(uploadEvent);

    log.info(`File upload captured: ${fileName}, size: ${fileSize}`);
  }
});

// 监听错误报告
ipcMain.on('report-error', (event, errorData) => {
  if (globalState.errorDetector) {
    globalState.errorDetector.addError(errorData);
  }

  if (globalState.isRecording && globalState.currentTask && globalState.dataSchemaManager) {
      const errorEvent = globalState.dataSchemaManager.generateErrorEvent(
        errorData.type || 'unknown',
        {
          message: errorData.message,
          stack: errorData.stack,
          windowId: `win_${event.sender.id}`,
          url: null
        }
      );

      appendToManifest(errorEvent);
    }
});

// 监听UI事件
ipcMain.on('report-ui-event', (event, eventData) => {
  if (globalState.isRecording && globalState.currentTask && globalState.dataSchemaManager) {
      const uiEvent = globalState.dataSchemaManager.generateUserActionEvent(
        eventData.type || 'ui_event',
        {
          semanticLabel: eventData.semanticLabel || `${eventData.type} event`,
          domPath: eventData.domPath || null,
          shadowDomPath: eventData.shadowDomPath || null,
          coordinates: eventData.coordinates || null,
          windowId: `win_${event.sender.id}`,
          url: eventData.url || null,
          hasErrors: eventData.hasErrors || false,
          apiRequests: eventData.apiRequests || [],
          responseStatus: eventData.responseStatus || null
        }
      );

      appendToManifest(uiEvent);
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
  recordUserAction(actionData);
});

// 监听 DOM 快照
ipcMain.on('dom-snapshot', (event, snapshotData) => {
  saveDOMSnapshot(snapshotData);
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

          // 检查是否启用了截图功能
          const captureScreenshots = globalState.currentTask?.config?.options?.captureScreenshots || false;
          
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

  // 设置网络监听（必须在app ready后）
  setupNetworkListeners();

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
        const newWindowEvent = globalState.dataSchemaManager.generateUserActionEvent('new_window', {
          semanticLabel: `New window opened: ${url}`,
          windowId: `win_${window.id}`,
          url: url,
          metadata: {
            frameName: frameName,
            disposition: disposition,
            windowFeatures: options,
            timestamp: timestamp
          }
        });
        appendToManifest(newWindowEvent);

        // 不再实时截图，改为记录 snapshot 引用（截图将在录制结束后从视频截取）
        const fileName = `snapshot_newwindow_${timestamp}.png`;
        newWindowEvent.metadata.snapshotFileName = fileName;
        newWindowEvent.metadata.snapshotPath = `previews/snapshots/${fileName}`;
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
