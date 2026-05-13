/**
 * ============================================================================
 * 因果关系链追踪器 (CausalChainTracker)
 * ============================================================================
 * 
 * 【核心职责】
 * 1. 在 Preload 层拦截浏览器所有关键 API 调用
 * 2. 建立精确的因果关系链，使用 eventId 实现 100% 准确的事件关联
 * 3. 支持 20+ 种数据类型的拦截和记录
 * 4. 使用 AsyncContextTracker 确保异步操作中的上下文传递
 * 
 * 【架构设计】
 * - 拦截层：在页面 JavaScript 执行前拦截原生 API
 * - 上下文层：通过 AsyncContextTracker 维护异步调用链
 * - 通信层：通过 IPC 将事件发送到主进程
 * - 清理层：定期清理过期请求，防止内存泄漏
 * 
 * 【拦截的数据类型】
 * 1. 网络通信：Fetch、XHR、WebSocket、EventSource(SSE)、Beacon
 * 2. 跨窗口通信：PostMessage、BroadcastChannel
 * 3. 存储操作：localStorage、sessionStorage、IndexedDB、Cache API
 * 4. 用户交互：Clipboard、Composition、Media、Form、Pointer、Touch
 * 5. 生命周期：Page Visibility、BeforeUnload、Resize
 * 6. 性能指标：Performance Observer
 * 7. 安全事件：CSP 违规
 * 8. CSS 动画：Animation、Transition
 * 
 * 【关联机制】
 * - 每个用户操作创建唯一的 eventId
 * - 通过 AsyncContextTracker 在异步调用中传递 eventId
 * - 所有拦截到的操作都携带当前 eventId，实现精确关联
 * ============================================================================
 */

// 加载 AsyncContextTracker（注意：在 webview preload 中不能使用 path 模块）
let AsyncContextTracker;

try {
  AsyncContextTracker = require('./async-context-tracker');
  console.log('[CausalChainTracker] AsyncContextTracker loaded successfully');
} catch (e) {
  console.error('[CausalChainTracker] Failed to load AsyncContextTracker:', e.message);
  // 创建一个空的 AsyncContextTracker 作为 fallback
  AsyncContextTracker = class FakeAsyncContextTracker {
    constructor() {
      console.warn('[CausalChainTracker] Using fake AsyncContextTracker');
    }
    createContext() { return {}; }
    getCurrentContext() { return null; }
    getCurrentEventId() { return null; }
    clearCurrentContext() {}
  };
}

// 简单的日志函数（preload 环境不能使用 electron-log）
function createLogger(module) {
  return {
    debug: (msg, meta = {}) => console.log(`[${module}] [DEBUG] ${msg}`, meta),
    info: (msg, meta = {}) => console.log(`[${module}] [INFO] ${msg}`, meta),
    warn: (msg, meta = {}) => console.warn(`[${module}] [WARN] ${msg}`, meta),
    error: (msg, meta = {}) => console.error(`[${module}] [ERROR] ${msg}`, meta),
    trace: (fn, args = [], meta = {}) => console.log(`[${module}] [TRACE] ${fn}`, { args, ...meta })
  };
}

const trackerLog = createLogger('CausalChainTracker');

class CausalChainTracker {
  /**
   * 构造函数
   * @param {Object} ipcRenderer - Electron 的 ipcRenderer 实例，用于与主进程通信
   */
  constructor(ipcRenderer) {
    // ==================== 核心依赖 ====================
    this.ipcRenderer = ipcRenderer;

    // ==================== 请求管理 ====================
    this.requestMap = new Map();      // 存储进行中的请求，key: requestId, value: requestRecord
    this.eventCounter = 0;            // 事件计数器，用于生成唯一ID
    this.requestTimeout = 30000;      // 请求超时时间（30秒），超时的请求会被清理

    // ==================== 异步上下文追踪 ====================
    // 使用 AsyncContextTracker 管理异步调用链中的 eventId 传递
    // 使用 try-catch 确保即使 AsyncContextTracker 初始化失败，CausalChainTracker 也能继续工作
    try {
      this.asyncContext = new AsyncContextTracker();
      console.log('[CausalChainTracker] AsyncContextTracker initialized successfully');
    } catch (e) {
      console.error('[CausalChainTracker] Failed to initialize AsyncContextTracker:', e.message);
      // 创建一个空的 AsyncContextTracker 作为 fallback
      this.asyncContext = null;
    }

    // ==================== 启动清理定时器 ====================
    // 定期清理过期请求，防止内存泄漏
    this.startRequestCleanup();
    
    // ==================== 初始化所有拦截器 ====================
    // 按类别分组初始化，便于维护和理解
    
    // 1. 网络通信类拦截器（5个）
    this.initFetchIntercept();        // Fetch API
    this.initXHRIntercept();          // XMLHttpRequest
    this.initWebSocketIntercept();    // WebSocket
    this.initEventSourceIntercept();  // Server-Sent Events
    this.initBeaconIntercept();       // Beacon API
    
    // 2. 跨窗口通信类拦截器（2个）
    this.initPostMessageIntercept();      // PostMessage
    this.initBroadcastChannelIntercept(); // BroadcastChannel
    
    // 3. 存储类拦截器（3个）
    this.initStorageIntercept();      // localStorage/sessionStorage
    this.initIndexedDBIntercept();    // IndexedDB
    this.initCacheAPIIntercept();     // Cache API
    
    // 4. 用户交互类拦截器（6个）
    this.initClipboardIntercept();    // 剪贴板操作
    this.initCompositionIntercept();  // 输入法组合事件
    this.initMediaIntercept();        // 媒体播放事件
    this.initFormIntercept();         // 表单提交
    this.initPointerIntercept();      // 指针事件
    this.initTouchIntercept();        // 触摸事件
    
    // 5. 生命周期类拦截器（1个）
    this.initLifecycleIntercept();    // 页面生命周期
    
    // 6. 性能类拦截器（1个）
    this.initPerformanceIntercept();  // 性能指标
    
    // 7. 安全类拦截器（1个）
    this.initSecurityIntercept();     // 安全事件
    
    // 8. CSS类拦截器（1个）
    this.initCSSAnimationIntercept(); // CSS 动画/过渡
    
    trackerLog.info('Initialized with full intercepts', {
      interceptors: {
        network: 5,      // Fetch, XHR, WebSocket, SSE, Beacon
        communication: 2, // PostMessage, BroadcastChannel
        storage: 3,      // localStorage/sessionStorage, IndexedDB, Cache API
        userInteraction: 6, // Clipboard, Composition, Media, Form, Pointer, Touch
        lifecycle: 1,    // Page Visibility, BeforeUnload, Resize
        performance: 1,  // Performance Observer
        security: 1,     // CSP violations
        css: 1           // Animation, Transition
      },
      requestTimeout: this.requestTimeout,
      eventCounter: this.eventCounter
    });
  }
  
  /**
   * ==========================================================================
   * 唯一ID生成
   * ==========================================================================
   * 生成格式：prefix_时间戳_计数器_随机数
   * 确保在单次会话中 ID 的唯一性
   * 
   * @param {string} prefix - ID 前缀（如 'evt', 'fetch', 'xhr'）
   * @returns {string} 生成的唯一ID
   * ==========================================================================
   */
  generateId(prefix = 'id') {
    return `${prefix}_${Date.now()}_${++this.eventCounter}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * ==========================================================================
   * 事件上下文管理
   * ==========================================================================
   * 
   * 【setCurrentEvent】
   * 在用户操作发生时调用，创建新的因果链上下文
   * 生成唯一的 eventId 并通过 AsyncContextTracker 创建上下文
   * 
   * @param {string} eventType - 事件类型（如 'click', 'keydown'）
   * @param {Object} eventData - 额外的元数据
   * @returns {string} 生成的 eventId
   * 
   * 【clearCurrentEvent】
   * 清除当前事件上下文，在操作完成后调用
   * 
   * 【getCurrentEventId】
   * 获取当前上下文中的 eventId
   * 所有拦截器通过此方法获取当前 eventId 进行关联
   * ==========================================================================
   */
  setCurrentEvent(eventType, eventData = {}) {
    // 安全检查：确保 asyncContext 已初始化
    if (!this.asyncContext) {
      console.warn('[CausalChainTracker] asyncContext not initialized, skipping setCurrentEvent');
      return null;
    }

    const eventId = this.generateId('evt');
    const timestamp = Date.now();

    // 创建异步上下文，将 eventId 存入上下文栈
    this.asyncContext.createContext(eventId, eventType, {
      timestamp: timestamp,
      url: window.location.href,
      title: document.title,
      ...eventData
    });

    // 构建上下文对象
    const context = {
      eventId: eventId,
      eventType: eventType,
      timestamp: timestamp,
      url: window.location.href,
      title: document.title,
      ...eventData
    };

    // 发送到主进程，用于创建事件记录
    this.ipcRenderer.sendToHost('sentinel-event-context', context);

    console.log('[CausalChainTracker] Event context set:', eventId, eventType);

    return eventId;
  }

  clearCurrentEvent() {
    // 安全检查：确保 asyncContext 已初始化
    if (!this.asyncContext) {
      console.warn('[CausalChainTracker] asyncContext not initialized, skipping clearCurrentEvent');
      return;
    }
    this.asyncContext.clearCurrentContext();
  }

  getCurrentEventId() {
    // 安全检查：确保 asyncContext 已初始化
    if (!this.asyncContext) {
      console.warn('[CausalChainTracker] asyncContext not initialized, returning null');
      return null;
    }
    return this.asyncContext.getCurrentEventId();
  }
  
  /**
   * ==========================================================================
   * 请求记录管理
   * ==========================================================================
   * 
   * 【recordRequestStart】
   * 在请求开始时调用，记录请求的基本信息
   * 将请求信息存入 requestMap，等待请求完成时补充结果
   * 
   * @param {string} requestId - 请求唯一ID
   * @param {string} type - 请求类型（'fetch', 'xhr'）
   * @param {string} url - 请求URL
   * @param {string} method - HTTP方法
   * @param {any} body - 请求体
   * @returns {Object} 请求记录对象
   * 
   * 【recordRequestComplete】
   * 在请求完成时调用，补充请求结果信息
   * 即使找不到开始记录，也会创建简化版记录防止数据丢失
   * 
   * @param {string} requestId - 请求唯一ID
   * @param {number} status - HTTP状态码
   * @param {Object} responseHeaders - 响应头
   * @param {any} responseBody - 响应体
   * @returns {Object} 完整的请求记录
   * ==========================================================================
   */
  recordRequestStart(requestId, type, url, method, body = null) {
    const eventId = this.getCurrentEventId();
    
    const record = {
      requestId: requestId,
      eventId: eventId,
      type: type,
      url: url,
      method: method,
      body: body,
      startTime: performance.now(),
      timestamp: Date.now()
    };
    
    this.requestMap.set(requestId, record);
    
    this.ipcRenderer.sendToHost('sentinel-request-start', record);
    
    return record;
  }
  
  recordRequestComplete(requestId, status, responseHeaders, responseBody = null) {
    let startRecord = this.requestMap.get(requestId);
    
    // 如果找不到开始记录，创建一个简化版记录
    // 这种情况可能发生在请求开始时页面被刷新或跳转
    if (!startRecord) {
      console.warn('[CausalChainTracker] Request start record not found, creating simplified record:', requestId);
      startRecord = {
        requestId: requestId,
        eventId: this.getCurrentEventId(), // 使用当前事件ID（可能不准确，但总比丢失好）
        type: 'unknown',
        url: 'unknown',
        method: 'unknown',
        timestamp: Date.now()
      };
    }
    
    const record = {
      ...startRecord,
      status: status,
      responseHeaders: responseHeaders,
      responseBody: responseBody,
      endTime: performance.now(),
      duration: performance.now() - (startRecord.startTime || performance.now()),
      timestamp: Date.now()
    };
    
    this.ipcRenderer.sendToHost('sentinel-request-complete', record);
    
    // 清理已完成的请求记录
    this.requestMap.delete(requestId);
    
    return record;
  }
  
  /**
   * ==========================================================================
   * 网络通信拦截器 - Fetch API
   * ==========================================================================
   * 【拦截目标】window.fetch
   * 【拦截内容】
   * - 请求URL、方法、体
   * - 响应状态码、头、体
   * - 错误信息
   * 
   * 【关联机制】
   * - 在请求开始时获取当前 eventId
   * - 请求完成时携带相同的 eventId
   * - 实现精确的因果关系关联
   * ==========================================================================
   */
  initFetchIntercept() {
    const originalFetch = window.fetch;
    const self = this;
    
    window.fetch = async function(input, init = {}) {
      const requestId = self.generateId('fetch');
      const url = typeof input === 'string' ? input : input.url;
      const method = init.method || 'GET';
      const body = init.body || null;
      
      // 记录请求开始
      self.recordRequestStart(requestId, 'fetch', url, method, body);
      
      try {
        const response = await originalFetch.call(this, input, init);
        
        // 克隆响应以便读取（不破坏原响应）
        const clonedResponse = response.clone();
        
        // 尝试读取响应体
        let responseBody = null;
        try {
          const contentType = response.headers.get('content-type');
          if (contentType) {
            if (contentType.includes('application/json')) {
              responseBody = await clonedResponse.json();
            } else if (contentType.includes('text/')) {
              responseBody = await clonedResponse.text();
            }
          }
        } catch (e) {
          // 忽略读取错误（如二进制数据）
        }
        
        // 记录请求完成
        const headers = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        
        self.recordRequestComplete(requestId, response.status, headers, responseBody);
        
        return response;
      } catch (error) {
        // 记录请求失败
        self.ipcRenderer.sendToHost('sentinel-request-error', {
          requestId: requestId,
          error: error.message,
          timestamp: Date.now()
        });
        throw error;
      }
    };
    
    console.log('[CausalChainTracker] Fetch API intercepted');
  }
  
  /**
   * ==========================================================================
   * 网络通信拦截器 - XMLHttpRequest
   * ==========================================================================
   * 【拦截目标】XMLHttpRequest.prototype.open/send
   * 【拦截内容】
   * - 请求URL、方法、体
   * - 响应状态码、头、体
   * - 错误信息
   * 
   * 【实现说明】
   * - open 方法被调用时生成 requestId 并存储
   * - send 方法被调用时记录请求开始
   * - 通过 addEventListener 监听 load/error 事件
   * ==========================================================================
   */
  initXHRIntercept() {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    const self = this;
    
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this._sentinelRequestId = self.generateId('xhr');
      this._sentinelMethod = method;
      this._sentinelUrl = url;
      return originalOpen.call(this, method, url, ...rest);
    };
    
    XMLHttpRequest.prototype.send = function(body) {
      const requestId = this._sentinelRequestId;
      const method = this._sentinelMethod;
      const url = this._sentinelUrl;
      
      if (requestId) {
        // 记录请求开始
        self.recordRequestStart(requestId, 'xhr', url, method, body);
        
        // 监听完成
        this.addEventListener('load', function() {
          const headers = {};
          const headerString = this.getAllResponseHeaders();
          if (headerString) {
            headerString.split('\r\n').forEach(line => {
              const parts = line.split(': ');
              if (parts.length === 2) {
                headers[parts[0]] = parts[1];
              }
            });
          }
          
          self.recordRequestComplete(requestId, this.status, headers, this.response);
        });
        
        // 监听错误
        this.addEventListener('error', function() {
          self.ipcRenderer.sendToHost('sentinel-request-error', {
            requestId: requestId,
            error: 'Network error',
            timestamp: Date.now()
          });
        });
      }
      
      return originalSend.call(this, body);
    };
    
    console.log('[CausalChainTracker] XMLHttpRequest intercepted');
  }
  
  /**
   * ==========================================================================
   * 网络通信拦截器 - WebSocket
   * ==========================================================================
   * 【拦截目标】window.WebSocket
   * 【拦截内容】
   * - WebSocket 创建
   * - 发送的消息
   * - 接收的消息
   * - 连接关闭
   * 
   * 【关联机制】
   * - 创建时记录 eventId
   * - 后续所有消息都携带创建时的 eventId
   * ==========================================================================
   */
  initWebSocketIntercept() {
    const OriginalWebSocket = window.WebSocket;
    const self = this;
    
    window.WebSocket = function(url, protocols) {
      const ws = new OriginalWebSocket(url, protocols);
      const wsId = self.generateId('ws');
      const eventId = self.getCurrentEventId();
      
      console.log('[CausalChainTracker] WebSocket created:', wsId, url);
      
      // 记录 WebSocket 创建
      self.ipcRenderer.sendToHost('sentinel-websocket-created', {
        wsId: wsId,
        eventId: eventId,
        url: url,
        protocols: protocols,
        timestamp: Date.now()
      });
      
      // 包装 send 方法
      const originalSend = ws.send;
      ws.send = function(data) {
        self.ipcRenderer.sendToHost('sentinel-websocket-message', {
          wsId: wsId,
          eventId: self.getCurrentEventId(),
          direction: 'send',
          data: typeof data === 'string' ? data : '[Binary]',
          timestamp: Date.now()
        });
        return originalSend.call(this, data);
      };
      
      // 监听接收
      ws.addEventListener('message', (event) => {
        self.ipcRenderer.sendToHost('sentinel-websocket-message', {
          wsId: wsId,
          eventId: self.getCurrentEventId(),
          direction: 'receive',
          data: typeof event.data === 'string' ? event.data : '[Binary]',
          timestamp: Date.now()
        });
      });
      
      // 监听关闭
      ws.addEventListener('close', () => {
        self.ipcRenderer.sendToHost('sentinel-websocket-closed', {
          wsId: wsId,
          timestamp: Date.now()
        });
      });
      
      return ws;
    };
    
    console.log('[CausalChainTracker] WebSocket intercepted');
  }
  
  /**
   * ==========================================================================
   * 网络通信拦截器 - EventSource (SSE)
   * ==========================================================================
   * 【拦截目标】window.EventSource
   * 【拦截内容】
   * - EventSource 创建
   * - 接收的服务端消息
   * ==========================================================================
   */
  initEventSourceIntercept() {
    const OriginalEventSource = window.EventSource;
    const self = this;
    
    window.EventSource = function(url, options) {
      const es = new OriginalEventSource(url, options);
      const esId = self.generateId('sse');
      
      console.log('[CausalChainTracker] EventSource created:', esId, url);
      
      // 记录创建
      self.ipcRenderer.sendToHost('sentinel-sse-created', {
        esId: esId,
        eventId: self.getCurrentEventId(),
        url: url,
        timestamp: Date.now()
      });
      
      // 监听消息
      es.addEventListener('message', (event) => {
        self.ipcRenderer.sendToHost('sentinel-sse-message', {
          esId: esId,
          eventId: self.getCurrentEventId(),
          data: event.data,
          timestamp: Date.now()
        });
      });
      
      return es;
    };
    
    console.log('[CausalChainTracker] EventSource intercepted');
  }
  
  /**
   * ==========================================================================
   * 网络通信拦截器 - Beacon API
   * ==========================================================================
   * 【拦截目标】navigator.sendBeacon
   * 【拦截内容】
   * - Beacon 发送的URL和数据
   * 
   * 【说明】
   * Beacon API 用于在页面卸载时可靠地发送数据
   * 常用于分析和日志记录
   * ==========================================================================
   */
  initBeaconIntercept() {
    const originalSendBeacon = navigator.sendBeacon;
    const self = this;
    
    navigator.sendBeacon = function(url, data) {
      const beaconId = self.generateId('beacon');
      
      console.log('[CausalChainTracker] Beacon sent:', beaconId, url);
      
      self.ipcRenderer.sendToHost('sentinel-beacon', {
        beaconId: beaconId,
        eventId: self.getCurrentEventId(),
        url: url,
        data: data,
        timestamp: Date.now()
      });
      
      return originalSendBeacon.call(this, url, data);
    };
    
    console.log('[CausalChainTracker] Beacon API intercepted');
  }
  
  /**
   * ==========================================================================
   * 跨窗口通信拦截器 - PostMessage
   * ==========================================================================
   * 【拦截目标】window.postMessage
   * 【拦截内容】
   * - 发送的消息内容
   * - 目标域名
   * - 接收的消息内容
   * - 消息来源
   * 
   * 【使用场景】
   * - iframe 与父窗口通信
   * - 窗口间通信
   * - Web Worker 通信
   * ==========================================================================
   */
  initPostMessageIntercept() {
    const originalPostMessage = window.postMessage;
    const self = this;
    
    window.postMessage = function(message, targetOrigin, transfer) {
      const pmId = self.generateId('pm');
      
      self.ipcRenderer.sendToHost('sentinel-postmessage', {
        pmId: pmId,
        eventId: self.getCurrentEventId(),
        message: typeof message === 'object' ? JSON.stringify(message) : message,
        targetOrigin: targetOrigin,
        timestamp: Date.now()
      });
      
      return originalPostMessage.call(this, message, targetOrigin, transfer);
    };
    
    // 监听接收
    window.addEventListener('message', (event) => {
      self.ipcRenderer.sendToHost('sentinel-postmessage-received', {
        eventId: self.getCurrentEventId(),
        data: typeof event.data === 'object' ? JSON.stringify(event.data) : event.data,
        origin: event.origin,
        timestamp: Date.now()
      });
    });
    
    console.log('[CausalChainTracker] PostMessage intercepted');
  }
  
  /**
   * ==========================================================================
   * 存储类拦截器 - Storage API
   * ==========================================================================
   * 【拦截目标】localStorage/sessionStorage
   * 【拦截内容】
   * - setItem 操作（键、值）
   * - removeItem 操作（键）
   * 
   * 【说明】
   * 只拦截写操作，读操作不记录
   * ==========================================================================
   */
  initStorageIntercept() {
    const self = this;
    
    // 拦截 localStorage
    const localStorageSetItem = localStorage.setItem;
    localStorage.setItem = function(key, value) {
      self.ipcRenderer.sendToHost('sentinel-storage-operation', {
        type: 'localStorage',
        operation: 'setItem',
        key: key,
        value: value,
        eventId: self.getCurrentEventId(),
        timestamp: Date.now()
      });
      return localStorageSetItem.call(this, key, value);
    };
    
    const localStorageRemoveItem = localStorage.removeItem;
    localStorage.removeItem = function(key) {
      self.ipcRenderer.sendToHost('sentinel-storage-operation', {
        type: 'localStorage',
        operation: 'removeItem',
        key: key,
        eventId: self.getCurrentEventId(),
        timestamp: Date.now()
      });
      return localStorageRemoveItem.call(this, key);
    };
    
    // 拦截 sessionStorage
    const sessionStorageSetItem = sessionStorage.setItem;
    sessionStorage.setItem = function(key, value) {
      self.ipcRenderer.sendToHost('sentinel-storage-operation', {
        type: 'sessionStorage',
        operation: 'setItem',
        key: key,
        value: value,
        eventId: self.getCurrentEventId(),
        timestamp: Date.now()
      });
      return sessionStorageSetItem.call(this, key, value);
    };
    
    console.log('[CausalChainTracker] Storage API intercepted');
  }
  
  /**
   * ==========================================================================
   * 存储类拦截器 - IndexedDB
   * ==========================================================================
   * 【拦截目标】indexedDB.open
   * 【拦截内容】
   * - 数据库打开
   * - 事务创建
   * 
   * 【实现说明】
   * 在数据库打开成功后，包装 transaction 方法
   * ==========================================================================
   */
  initIndexedDBIntercept() {
    const originalOpen = indexedDB.open;
    const self = this;
    
    indexedDB.open = function(name, version) {
      const request = originalOpen.call(this, name, version);
      
      request.addEventListener('success', () => {
        const db = request.result;
        const dbId = self.generateId('idb');
        
        // 包装 transaction 方法
        const originalTransaction = db.transaction;
        db.transaction = function(storeNames, mode) {
          const transaction = originalTransaction.call(this, storeNames, mode);
          
          self.ipcRenderer.sendToHost('sentinel-indexeddb-operation', {
            dbId: dbId,
            dbName: name,
            eventId: self.getCurrentEventId(),
            operation: 'transaction',
            stores: storeNames,
            mode: mode,
            timestamp: Date.now()
          });
          
          return transaction;
        };
      });
      
      return request;
    };
    
    console.log('[CausalChainTracker] IndexedDB intercepted');
  }
  
  /**
   * ==========================================================================
   * 存储类拦截器 - Cache API
   * ==========================================================================
   * 【拦截目标】caches.open
   * 【拦截内容】
   * - 缓存打开
   * - put 操作
   * - delete 操作
   * 
   * 【说明】
   * Cache API 用于 Service Worker 缓存管理
   * ==========================================================================
   */
  initCacheAPIIntercept() {
    if (!window.caches) return;
    
    const originalOpen = caches.open;
    const self = this;
    
    caches.open = async function(cacheName) {
      const cache = await originalOpen.call(this, cacheName);
      const cacheId = self.generateId('cache');
      
      // 包装 put
      const originalPut = cache.put;
      cache.put = function(request, response) {
        self.ipcRenderer.sendToHost('sentinel-cache-operation', {
          cacheId: cacheId,
          cacheName: cacheName,
          eventId: self.getCurrentEventId(),
          operation: 'put',
          url: typeof request === 'string' ? request : request.url,
          timestamp: Date.now()
        });
        return originalPut.call(this, request, response);
      };
      
      // 包装 delete
      const originalDelete = cache.delete;
      cache.delete = function(request) {
        self.ipcRenderer.sendToHost('sentinel-cache-operation', {
          cacheId: cacheId,
          cacheName: cacheName,
          eventId: self.getCurrentEventId(),
          operation: 'delete',
          url: typeof request === 'string' ? request : request.url,
          timestamp: Date.now()
        });
        return originalDelete.call(this, request);
      };
      
      return cache;
    };
    
    console.log('[CausalChainTracker] Cache API intercepted');
  }
  
  /**
   * ==========================================================================
   * 用户交互拦截器 - Clipboard
   * ==========================================================================
   * 【拦截目标】copy/cut/paste 事件
   * 【拦截内容】
   * - 复制的文本
   * - 剪切的文本
   * - 粘贴的文本
   * 
   * 【隐私说明】
   * 文本长度限制为1000字符，防止记录敏感信息
   * ==========================================================================
   */
  initClipboardIntercept() {
    const self = this;
    
    // 拦截 copy 事件
    document.addEventListener('copy', (e) => {
      const selectedText = window.getSelection().toString();
      self.ipcRenderer.sendToHost('sentinel-clipboard-operation', {
        operation: 'copy',
        eventId: self.getCurrentEventId(),
        text: selectedText.substring(0, 1000), // 限制长度
        timestamp: Date.now()
      });
    });
    
    // 拦截 cut 事件
    document.addEventListener('cut', (e) => {
      const selectedText = window.getSelection().toString();
      self.ipcRenderer.sendToHost('sentinel-clipboard-operation', {
        operation: 'cut',
        eventId: self.getCurrentEventId(),
        text: selectedText.substring(0, 1000),
        timestamp: Date.now()
      });
    });
    
    // 拦截 paste 事件
    document.addEventListener('paste', (e) => {
      const text = e.clipboardData.getData('text');
      self.ipcRenderer.sendToHost('sentinel-clipboard-operation', {
        operation: 'paste',
        eventId: self.getCurrentEventId(),
        text: text.substring(0, 1000),
        timestamp: Date.now()
      });
    });
    
    console.log('[CausalChainTracker] Clipboard intercepted');
  }
  
  /**
   * ==========================================================================
   * 性能类拦截器 - Performance API
   * ==========================================================================
   * 【拦截目标】PerformanceObserver
   * 【拦截内容】
   * - navigation: 页面导航性能
   * - resource: 资源加载性能
   * - paint: 首次绘制(FP)、首次内容绘制(FCP)
   * - largest-contentful-paint: 最大内容绘制(LCP)
   * - layout-shift: 累积布局偏移(CLS)
   * 
   * 【说明】
   * 只发送关键性能指标，避免数据量过大
   * ==========================================================================
   */
  initPerformanceIntercept() {
    const self = this;
    
    // 监听性能条目
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // 只发送关键性能指标
        if (['navigation', 'resource', 'paint', 'largest-contentful-paint', 'layout-shift'].includes(entry.entryType)) {
          self.ipcRenderer.sendToHost('sentinel-performance-entry', {
            eventId: self.getCurrentEventId(),
            entryType: entry.entryType,
            name: entry.name,
            startTime: entry.startTime,
            duration: entry.duration,
            timestamp: Date.now()
          });
        }
      }
    });
    
    observer.observe({ entryTypes: ['navigation', 'resource', 'paint', 'largest-contentful-paint', 'layout-shift'] });
    
    console.log('[CausalChainTracker] Performance API intercepted');
  }
  
  /**
   * ==========================================================================
   * 跨窗口通信拦截器 - BroadcastChannel
   * ==========================================================================
   * 【拦截目标】window.BroadcastChannel
   * 【拦截内容】
   * - 频道创建
   * - 发送的消息
   * - 接收的消息
   * 
   * 【使用场景】
   * 同源的不同窗口/标签页间通信
   * ==========================================================================
   */
  initBroadcastChannelIntercept() {
    const OriginalBroadcastChannel = window.BroadcastChannel;
    const self = this;
    
    window.BroadcastChannel = function(name) {
      const channel = new OriginalBroadcastChannel(name);
      const channelId = self.generateId('bc');
      
      console.log('[CausalChainTracker] BroadcastChannel created:', channelId, name);
      
      // 记录创建
      self.ipcRenderer.sendToHost('sentinel-broadcastchannel-created', {
        channelId: channelId,
        eventId: self.getCurrentEventId(),
        name: name,
        timestamp: Date.now()
      });
      
      // 包装 postMessage
      const originalPostMessage = channel.postMessage;
      channel.postMessage = function(message) {
        self.ipcRenderer.sendToHost('sentinel-broadcastchannel-message', {
          channelId: channelId,
          eventId: self.getCurrentEventId(),
          direction: 'send',
          message: typeof message === 'object' ? JSON.stringify(message) : message,
          timestamp: Date.now()
        });
        return originalPostMessage.call(this, message);
      };
      
      // 监听接收
      channel.addEventListener('message', (event) => {
        self.ipcRenderer.sendToHost('sentinel-broadcastchannel-message', {
          channelId: channelId,
          eventId: self.getCurrentEventId(),
          direction: 'receive',
          message: typeof event.data === 'object' ? JSON.stringify(event.data) : event.data,
          timestamp: Date.now()
        });
      });
      
      return channel;
    };
    
    console.log('[CausalChainTracker] BroadcastChannel intercepted');
  }
  
  /**
   * ==========================================================================
   * 用户交互拦截器 - Composition 事件（输入法组合）
   * ==========================================================================
   * 【拦截目标】compositionstart/compositionupdate/compositionend
   * 【拦截内容】
   * - 组合开始
   * - 组合更新
   * - 组合结束
   * - 目标元素
   * - XPath 路径
   * 
   * 【使用场景】
   * 中文、日文等需要输入法组合的语言输入
   * ==========================================================================
   */
  initCompositionIntercept() {
    const self = this;
    
    document.addEventListener('compositionstart', (e) => {
      self.ipcRenderer.sendToHost('sentinel-composition', {
        eventId: self.getCurrentEventId(),
        type: 'compositionstart',
        target: e.target.tagName,
        xpath: self.getXPath(e.target),
        data: e.data,
        timestamp: Date.now()
      });
    }, true);
    
    document.addEventListener('compositionupdate', (e) => {
      self.ipcRenderer.sendToHost('sentinel-composition', {
        eventId: self.getCurrentEventId(),
        type: 'compositionupdate',
        target: e.target.tagName,
        xpath: self.getXPath(e.target),
        data: e.data,
        timestamp: Date.now()
      });
    }, true);
    
    document.addEventListener('compositionend', (e) => {
      self.ipcRenderer.sendToHost('sentinel-composition', {
        eventId: self.getCurrentEventId(),
        type: 'compositionend',
        target: e.target.tagName,
        xpath: self.getXPath(e.target),
        data: e.data,
        timestamp: Date.now()
      });
    }, true);
    
    console.log('[CausalChainTracker] Composition events intercepted');
  }
  
  /**
   * ==========================================================================
   * 辅助方法 - 获取元素的 XPath
   * ==========================================================================
   * 【用途】
   * 精确定位 DOM 元素，用于 Composition 等事件的元素标识
   * 
   * 【算法】
   * 1. 如果元素有 id，直接返回 //*[@id="xxx"]
   * 2. 如果是 body，返回 /html/body
   * 3. 否则向上遍历，构建路径
   * ==========================================================================
   */
  getXPath(element) {
    if (!element) return '';
    if (element.id) return `//*[@id="${element.id}"]`;
    if (element === document.body) return '/html/body';
    
    let path = '';
    let current = element;
    
    while (current && current !== document.body) {
      let tag = current.tagName.toLowerCase();
      let index = 1;
      let sibling = current.previousElementSibling;
      
      while (sibling) {
        if (sibling.tagName.toLowerCase() === tag) index++;
        sibling = sibling.previousElementSibling;
      }
      
      path = `/${tag}[${index}]${path}`;
      current = current.parentElement;
    }
    
    return '/html/body' + path;
  }
  
  /**
   * ==========================================================================
   * 用户交互拦截器 - Media 播放事件
   * ==========================================================================
   * 【拦截目标】VIDEO/AUDIO 元素的事件
   * 【拦截内容】
   * - play: 开始播放
   * - pause: 暂停
   * - seeked: 跳转
   * - ended: 结束
   * - 当前时间、时长、音量、播放速率
   * 
   * 【实现方式】
   * 使用事件委托，监听 document 上的事件
   * 通过 e.target.tagName 判断是否为媒体元素
   * ==========================================================================
   */
  initMediaIntercept() {
    const self = this;
    const mediaEvents = ['play', 'pause', 'seeking', 'seeked', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'ended', 'volumechange', 'ratechange'];
    
    // 使用事件委托监听所有媒体元素
    document.addEventListener('play', (e) => {
      if (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO') {
        self.ipcRenderer.sendToHost('sentinel-media-event', {
          eventId: self.getCurrentEventId(),
          type: 'play',
          mediaType: e.target.tagName.toLowerCase(),
          src: e.target.src,
          currentTime: e.target.currentTime,
          duration: e.target.duration,
          volume: e.target.volume,
          playbackRate: e.target.playbackRate,
          timestamp: Date.now()
        });
      }
    }, true);
    
    document.addEventListener('pause', (e) => {
      if (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO') {
        self.ipcRenderer.sendToHost('sentinel-media-event', {
          eventId: self.getCurrentEventId(),
          type: 'pause',
          mediaType: e.target.tagName.toLowerCase(),
          src: e.target.src,
          currentTime: e.target.currentTime,
          timestamp: Date.now()
        });
      }
    }, true);
    
    document.addEventListener('seeked', (e) => {
      if (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO') {
        self.ipcRenderer.sendToHost('sentinel-media-event', {
          eventId: self.getCurrentEventId(),
          type: 'seeked',
          mediaType: e.target.tagName.toLowerCase(),
          src: e.target.src,
          currentTime: e.target.currentTime,
          timestamp: Date.now()
        });
      }
    }, true);
    
    document.addEventListener('ended', (e) => {
      if (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO') {
        self.ipcRenderer.sendToHost('sentinel-media-event', {
          eventId: self.getCurrentEventId(),
          type: 'ended',
          mediaType: e.target.tagName.toLowerCase(),
          src: e.target.src,
          timestamp: Date.now()
        });
      }
    }, true);
    
    console.log('[CausalChainTracker] Media events intercepted');
  }
  
  /**
   * ==========================================================================
   * 用户交互拦截器 - Form 提交
   * ==========================================================================
   * 【拦截目标】form submit 事件
   * 【拦截内容】
   * - 表单 action
   * - 表单 method
   * - 表单 enctype
   * - 表单数据（敏感信息脱敏）
   * 
   * 【隐私保护】
   * 对 password、token 等敏感字段进行脱敏处理
   * ==========================================================================
   */
  initFormIntercept() {
    const self = this;
    
    document.addEventListener('submit', (e) => {
      const form = e.target;
      const formData = new FormData(form);
      const data = {};
      
      for (const [key, value] of formData.entries()) {
        // 敏感信息脱敏
        if (key.toLowerCase().includes('password') || key.toLowerCase().includes('token')) {
          data[key] = '[REDACTED]';
        } else {
          data[key] = value;
        }
      }
      
      self.ipcRenderer.sendToHost('sentinel-form-submit', {
        eventId: self.getCurrentEventId(),
        action: form.action,
        method: form.method,
        enctype: form.enctype,
        data: data,
        timestamp: Date.now()
      });
    }, true);
    
    console.log('[CausalChainTracker] Form submission intercepted');
  }
  
  /**
   * ==========================================================================
   * 用户交互拦截器 - Pointer 事件
   * ==========================================================================
   * 【拦截目标】Pointer Events API
   * 【拦截内容】
   * - pointerdown, pointermove, pointerup, pointercancel
   * - pointerenter, pointerleave, pointerover, pointerout
   * - 指针ID、类型（mouse/pen/touch）
   * - 坐标、压力、倾斜角度
   * 
   * 【说明】
   * Pointer Events 统一了鼠标、触摸、手写笔的输入
   * ==========================================================================
   */
  initPointerIntercept() {
    const self = this;
    const pointerEvents = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerenter', 'pointerleave', 'pointerover', 'pointerout'];
    
    pointerEvents.forEach(eventType => {
      document.addEventListener(eventType, (e) => {
        self.ipcRenderer.sendToHost('sentinel-pointer-event', {
          eventId: self.getCurrentEventId(),
          type: eventType,
          pointerId: e.pointerId,
          pointerType: e.pointerType, // 'mouse', 'pen', 'touch'
          x: e.clientX,
          y: e.clientY,
          pressure: e.pressure,
          tiltX: e.tiltX,
          tiltY: e.tiltY,
          target: e.target.tagName,
          timestamp: Date.now()
        });
      }, true);
    });
    
    console.log('[CausalChainTracker] Pointer events intercepted');
  }
  
  /**
   * ==========================================================================
   * 用户交互拦截器 - Touch 事件
   * ==========================================================================
   * 【拦截目标】Touch Events API
   * 【拦截内容】
   * - touchstart, touchmove, touchend, touchcancel
   * - 触摸点列表（identifier, x, y, force）
   * 
   * 【说明】
   * 主要用于移动端设备
   * ==========================================================================
   */
  initTouchIntercept() {
    const self = this;
    const touchEvents = ['touchstart', 'touchmove', 'touchend', 'touchcancel'];
    
    touchEvents.forEach(eventType => {
      document.addEventListener(eventType, (e) => {
        const touches = [];
        for (let i = 0; i < e.touches.length; i++) {
          touches.push({
            identifier: e.touches[i].identifier,
            x: e.touches[i].clientX,
            y: e.touches[i].clientY,
            force: e.touches[i].force
          });
        }
        
        self.ipcRenderer.sendToHost('sentinel-touch-event', {
          eventId: self.getCurrentEventId(),
          type: eventType,
          touches: touches,
          target: e.target.tagName,
          timestamp: Date.now()
        });
      }, true);
    });
    
    console.log('[CausalChainTracker] Touch events intercepted');
  }
  
  /**
   * ==========================================================================
   * 生命周期拦截器
   * ==========================================================================
   * 【拦截目标】
   * - visibilitychange: 页面可见性变化
   * - beforeunload: 页面卸载前
   * - resize: 窗口大小变化
   * 
   * 【用途】
   * 记录页面生命周期事件，辅助分析用户行为
   * ==========================================================================
   */
  initLifecycleIntercept() {
    const self = this;
    
    // Page Visibility
    document.addEventListener('visibilitychange', () => {
      self.ipcRenderer.sendToHost('sentinel-visibility-change', {
        eventId: self.getCurrentEventId(),
        hidden: document.hidden,
        visibilityState: document.visibilityState,
        timestamp: Date.now()
      });
    });
    
    // BeforeUnload
    window.addEventListener('beforeunload', () => {
      self.ipcRenderer.sendToHost('sentinel-before-unload', {
        eventId: self.getCurrentEventId(),
        url: window.location.href,
        timestamp: Date.now()
      });
    });
    
    // Resize（防抖处理）
    let resizeTimeout;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        self.ipcRenderer.sendToHost('sentinel-resize', {
          eventId: self.getCurrentEventId(),
          width: window.innerWidth,
          height: window.innerHeight,
          timestamp: Date.now()
        });
      }, 250); // 防抖 250ms
    });
    
    console.log('[CausalChainTracker] Lifecycle events intercepted');
  }
  
  /**
   * ==========================================================================
   * 安全事件拦截器
   * ==========================================================================
   * 【拦截目标】securitypolicyviolation 事件
   * 【拦截内容】
   * - 被阻止的 URI
   * - 违反的指令
   * - 原始策略
   * - 文档 URI
   * 
   * 【说明】
   * CSP (Content Security Policy) 违规事件
   * ==========================================================================
   */
  initSecurityIntercept() {
    const self = this;
    
    // CSP 违规
    document.addEventListener('securitypolicyviolation', (e) => {
      self.ipcRenderer.sendToHost('sentinel-csp-violation', {
        eventId: self.getCurrentEventId(),
        blockedURI: e.blockedURI,
        violatedDirective: e.violatedDirective,
        originalPolicy: e.originalPolicy,
        documentURI: e.documentURI,
        timestamp: Date.now()
      });
    });
    
    console.log('[CausalChainTracker] Security events intercepted');
  }
  
  /**
   * ==========================================================================
   * CSS 动画拦截器
   * ==========================================================================
   * 【拦截目标】
   * - animationstart, animationend
   * - transitionstart, transitionend
   * 
   * 【拦截内容】
   * - 动画名称
   * - 过渡属性名
   * - 目标元素
   * ==========================================================================
   */
  initCSSAnimationIntercept() {
    const self = this;
    
    // Animation 事件
    document.addEventListener('animationstart', (e) => {
      self.ipcRenderer.sendToHost('sentinel-css-animation', {
        eventId: self.getCurrentEventId(),
        type: 'animationstart',
        animationName: e.animationName,
        target: e.target.tagName,
        timestamp: Date.now()
      });
    }, true);
    
    document.addEventListener('animationend', (e) => {
      self.ipcRenderer.sendToHost('sentinel-css-animation', {
        eventId: self.getCurrentEventId(),
        type: 'animationend',
        animationName: e.animationName,
        target: e.target.tagName,
        timestamp: Date.now()
      });
    }, true);
    
    // Transition 事件
    document.addEventListener('transitionstart', (e) => {
      self.ipcRenderer.sendToHost('sentinel-css-transition', {
        eventId: self.getCurrentEventId(),
        type: 'transitionstart',
        propertyName: e.propertyName,
        target: e.target.tagName,
        timestamp: Date.now()
      });
    }, true);
    
    document.addEventListener('transitionend', (e) => {
      self.ipcRenderer.sendToHost('sentinel-css-transition', {
        eventId: self.getCurrentEventId(),
        type: 'transitionend',
        propertyName: e.propertyName,
        target: e.target.tagName,
        timestamp: Date.now()
      });
    }, true);
    
    console.log('[CausalChainTracker] CSS Animation/Transition intercepted');
  }
  
  /**
   * ==========================================================================
   * 请求清理定时器
   * ==========================================================================
   * 【用途】
   * 定期清理超时的请求记录，防止内存泄漏
   * 
   * 【机制】
   * - 每 30 秒执行一次清理
   * - 清理超过 requestTimeout（默认30秒）的请求
   * ==========================================================================
   */
  startRequestCleanup() {
    setInterval(() => {
      const now = Date.now();
      const cutoff = now - this.requestTimeout;
      let cleaned = 0;
      
      for (const [requestId, record] of this.requestMap) {
        if (record.timestamp < cutoff) {
          this.requestMap.delete(requestId);
          cleaned++;
        }
      }
      
      if (cleaned > 0) {
        console.log('[CausalChainTracker] Cleaned up', cleaned, 'expired requests');
      }
    }, 30000); // 每 30 秒清理一次
  }
}

module.exports = CausalChainTracker;
