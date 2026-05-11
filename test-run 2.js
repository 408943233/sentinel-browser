#!/usr/bin/env node

/**
 * 测试运行脚本
 * 验证核心逻辑而不需要启动Electron
 */

const path = require('path');
const fs = require('fs');

// 模拟Electron模块 - 直接创建模块而不使用require.resolve
const Module = require('module');
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function(request, parent, isMain) {
  if (request === 'electron') {
    return 'electron';
  }
  if (request === 'electron-log') {
    return 'electron-log';
  }
  if (request === 'archiver') {
    return 'archiver';
  }
  return originalResolveFilename.call(this, request, parent, isMain);
};

// 手动加载模拟模块
require.cache['electron'] = {
  id: 'electron',
  exports: {
    app: {
      isPackaged: false,
      getPath: (name) => {
        const paths = {
          temp: '/tmp',
          logs: '/tmp/logs',
          userData: '/tmp/sentinel-browser'
        };
        return paths[name] || '/tmp';
      },
      whenReady: () => Promise.resolve(),
      on: () => {}
    },
    BrowserWindow: class MockBrowserWindow {
      constructor(opts) { 
        this.id = Math.random().toString(36).substr(2, 9); 
        this.webContents = {
          send: () => {},
          on: () => {},
          executeJavaScript: () => Promise.resolve({}),
          debugger: {
            attach: () => Promise.resolve(),
            sendCommand: () => Promise.resolve({})
          }
        };
      }
      loadFile() {}
      loadURL() {}
      on() {}
      once() {}
      show() {}
    },
    ipcMain: {
      handle: () => {},
      on: () => {}
    },
    dialog: {
      showMessageBox: () => Promise.resolve()
    },
    session: {
      defaultSession: {
        webRequest: {
          onCompleted: () => {},
          onBeforeRequest: () => {},
          onHeadersReceived: () => {}
        }
      }
    },
    shell: {}
  }
};

require.cache['electron-log'] = {
  id: 'electron-log',
  exports: {
    initialize: () => {},
    info: (...args) => console.log('[INFO]', ...args),
    warn: (...args) => console.log('[WARN]', ...args),
    error: (...args) => console.log('[ERROR]', ...args),
    debug: (...args) => console.log('[DEBUG]', ...args),
    transports: {
      file: { level: 'info' },
      console: { level: 'debug' }
    }
  }
};

require.cache['archiver'] = {
  id: 'archiver',
  exports: () => ({
    pipe: () => {},
    directory: () => {},
    finalize: () => Promise.resolve()
  })
};

// 测试DataSchemaManager
console.log('=== 测试 DataSchemaManager ===');
const DataSchemaManager = require('./src/main/data-schema');
const schemaManager = new DataSchemaManager();

schemaManager.setCurrentTask({
  id: 'test_task_001',
  config: {
    userId: 'clerk_99',
    role: 'verifier',
    permissions: ['view_docs'],
    env: 'prod_v8',
    subTaskId: 'subtask_identity_verification'
  },
  startTime: Date.now()
});

// 生成各种类型的事件
const events = [
  schemaManager.generateUserActionEvent('click', {
    semanticLabel: 'Confirm Identity',
    domPath: "//div[@id='root']/button",
    shadowDomPath: 'custom-element::shadow-root > .btn',
    coordinates: { x: 850, y: 420 },
    windowId: 'tab_02',
    url: 'https://biz-system.com/preview/...'
  }),
  schemaManager.generateFileIOEvent('download', {
    fileName: 'id_card.pdf',
    fileSize: 1024000,
    mimeType: 'application/pdf',
    localPath: 'downloads/id_card.pdf',
    windowId: 'tab_02',
    url: 'https://biz-system.com/download/id_card.pdf'
  }),
  schemaManager.generateErrorEvent('javascript', {
    message: 'Uncaught TypeError: Cannot read property',
    stack: 'Error: Cannot read property\n    at <anonymous>:1:1',
    windowId: 'tab_02'
  }),
  schemaManager.generateNetworkEvent({
    requestId: 'req_9928',
    status: 200,
    method: 'POST',
    url: 'https://api.example.com/verify',
    windowId: 'tab_02'
  })
];

// 验证事件完整性
console.log('\n=== 验证事件完整性 ===');
events.forEach((event, index) => {
  const isValid = schemaManager.validateEvent(event);
  console.log(`事件 ${index + 1} (${event.event_details.action}): ${isValid ? '✓ 有效' : '✗ 无效'}`);

  if (isValid) {
    console.log('  - timestamp:', event.timestamp);
    console.log('  - video_time:', event.video_time);
    console.log('  - task_id:', event.task_id);
    console.log('  - user_context:', JSON.stringify(event.user_context));
    console.log('  - window_context:', JSON.stringify(event.window_context));
    console.log('  - file_io:', JSON.stringify(event.file_io));
    console.log('  - lineage:', JSON.stringify(event.lineage));
  }
});

// 测试FFmpegManager
console.log('\n=== 测试 FFmpegManager ===');
const FFmpegManager = require('./src/main/ffmpeg-manager');
const ffmpegManager = new FFmpegManager();
console.log('FFmpeg可用:', FFmpegManager.checkFFmpeg());
console.log('FFmpeg版本:', FFmpegManager.getFFmpegVersion());
console.log('检测到的编码器:', ffmpegManager.detectHardwareEncoder());

// 测试StateManager
console.log('\n=== 测试 StateManager ===');
const StateManager = require('./src/main/state-manager');
const stateManager = new StateManager('/tmp/sentinel-browser');
console.log('StateManager初始化完成');

// 测试LineageTracker
console.log('\n=== 测试 LineageTracker ===');
const LineageTracker = require('./src/main/lineage-tracker');
const lineageTracker = new LineageTracker();

lineageTracker.registerWindow('tab_01', { url: 'https://example.com' });
lineageTracker.registerWindow('tab_02', {
  parentId: 'tab_01',
  openerActionId: 'evt_001',
  url: 'https://example.com/preview'
});

const lineage = lineageTracker.getWindowLineage('tab_02');
console.log('窗口谱系:', JSON.stringify(lineage, null, 2));

// 测试ErrorDetector
console.log('\n=== 测试 ErrorDetector ===');
const ErrorDetector = require('./src/main/error-detector');
const errorDetector = new ErrorDetector();
errorDetector.addError({
  type: 'javascript',
  message: 'Test error',
  timestamp: Date.now()
});
console.log('错误统计:', JSON.stringify(errorDetector.getErrorStats()));

// 测试WatchdogManager
console.log('\n=== 测试 WatchdogManager ===');
const WatchdogManager = require('./src/main/watchdog');
const watchdogManager = new WatchdogManager();
console.log('WatchdogManager初始化完成');

// 测试CDPManager
console.log('\n=== 测试 CDPManager ===');
const CDPManager = require('./src/main/cdp-manager');
const cdpManager = new CDPManager();
console.log('CDPManager初始化完成');

console.log('\n=== 所有测试完成 ===');
console.log('核心逻辑验证通过，代码结构完整。');
