/**
 * ============================================================================
 * Webview Preload Script - 页面预加载脚本
 * ============================================================================
 * 
 * 【核心职责】
 * 1. 注入到 webview 中捕获用户行为（点击、输入、滚动、键盘等）
 * 2. 支持 rrweb 标准的 DOM 序列化，实现页面状态记录
 * 3. 使用因果关系链追踪实现 100% 准确的事件关联
 * 4. 与主进程通信，发送事件数据和 DOM 快照
 * 
 * 【架构设计】
 * - 事件捕获层：监听用户交互事件（click, input, scroll, keydown等）
 * - DOM 序列化层：使用 rrweb 标准序列化 DOM 结构
 * - 因果关系链层：通过 CausalChainTracker 实现事件关联
 * - IPC 通信层：通过 ipcRenderer 与主进程通信
 * 
 * 【主要功能模块】
 * 
 * 1. rrweb 标准 DOM 序列化
 *    - serializeNode: 序列化单个 DOM 节点
 *    - serializeDocument: 序列化整个文档
 *    - createFullSnapshot: 创建完整 DOM 快照
 *    - createIncrementalSnapshot: 创建增量 DOM 快照
 *    - MutationObserver: 监听 DOM 变化
 * 
 * 2. 事件监听和上报
 *    - 点击事件 (click)
 *    - 输入事件 (input)
 *    - 滚动事件 (scroll) - 支持滚动序列检测
 *    - 键盘事件 (keydown)
 *    - 悬停事件 (hover)
 *    - 文件上传 (file-upload, file-drop)
 * 
 * 3. 因果关系链追踪
 *    - 使用 CausalChainTracker 管理 eventId
 *    - 在事件发生时设置上下文
 *    - 在异步操作后清除上下文
 * 
 * 4. 辅助功能
 *    - getXPath: 获取元素 XPath
 *    - getSelector: 获取元素 CSS 选择器
 *    - getShadowDOMPath: 获取 Shadow DOM 路径
 *    - collectDOMStats: 收集 DOM 统计信息
 * 
 * 【数据流】
 * 用户操作 -> 事件监听 -> 设置因果链上下文 -> 发送 IPC 消息 -> 延迟触发 DOM 快照 -> 清除上下文
 * 
 * 【与主进程的通信】
 * - sentinel-click: 点击事件
 * - sentinel-input: 输入事件
 * - sentinel-scroll-start: 滚动开始
 * - sentinel-scroll: 滚动中
 * - sentinel-scroll-end: 滚动结束
 * - sentinel-keydown: 键盘事件
 * - sentinel-hover: 悬停事件
 * - sentinel-file-upload: 文件上传
 * - sentinel-file-drop: 文件拖放
 * - sentinel-dom-snapshot: DOM 快照
 * - sentinel-page-loaded: 页面加载完成
 * 
 * 【暂停机制】
 * 支持录制暂停功能，当 isRecordingPaused 为 true 时：
 * - 不记录新的用户事件
 * - 不触发 DOM 快照
 * - 但继续监听（恢复后立即生效）
 * ============================================================================
 */

console.log('[Sentinel Webview] Preload script starting...');

const { ipcRenderer } = require('electron');

console.log('[Sentinel Webview] ipcRenderer loaded:', !!ipcRenderer);

// ============================================================================
// 内联的 AsyncContextTracker 类
// ============================================================================
class AsyncContextTracker {
  constructor() {
    this.contextStack = [];
    this.contextMap = new Map();
    this.contextId = 0;
    this.currentContext = null;

    this.initTimeoutIntercept();
    this.initIntervalIntercept();
    this.initPromiseIntercept();
    this.initRequestAnimationFrameIntercept();
    this.initMutationObserverIntercept();
    this.initEventListenerIntercept();

    console.log('[AsyncContextTracker] Initialized');
  }

  createContext(eventId, eventType, metadata = {}) {
    const contextId = ++this.contextId;
    const context = {
      id: contextId,
      eventId: eventId,
      eventType: eventType,
      createdAt: Date.now(),
      metadata: metadata,
      asyncOperations: new Set()
    };

    this.contextMap.set(contextId, context);
    this.contextStack.push(context);
    this.currentContext = context;

    console.log('[AsyncContextTracker] Context created:', contextId, eventId);
    return context;
  }

  getCurrentContext() {
    return this.contextStack.length > 0 ? this.contextStack[this.contextStack.length - 1] : null;
  }

  getCurrentEventId() {
    const current = this.getCurrentContext();
    return current ? current.eventId : null;
  }

  clearCurrentContext() {
    if (this.contextStack.length > 0) {
      const context = this.contextStack.pop();
      this.currentContext = this.contextStack.length > 0 ? this.contextStack[this.contextStack.length - 1] : null;
      console.log('[AsyncContextTracker] Context popped:', context.id);

      setTimeout(() => {
        this.contextMap.delete(context.id);
      }, 60000);
    }
  }

  initTimeoutIntercept() {
    const originalSetTimeout = window.setTimeout;
    const self = this;

    window.setTimeout = function(callback, delay, ...args) {
      const context = self.currentContext;
      const wrappedCallback = function() {
        const prevContext = self.currentContext;
        self.currentContext = context;
        try {
          if (typeof callback === 'string') {
            eval(callback);
          } else {
            callback.apply(this, args);
          }
        } finally {
          self.currentContext = prevContext;
        }
      };
      return originalSetTimeout.call(this, wrappedCallback, delay);
    };
  }

  initIntervalIntercept() {
    const originalSetInterval = window.setInterval;
    const self = this;

    window.setInterval = function(callback, delay, ...args) {
      const context = self.currentContext;
      const wrappedCallback = function() {
        const prevContext = self.currentContext;
        self.currentContext = context;
        try {
          if (typeof callback === 'string') {
            eval(callback);
          } else {
            callback.apply(this, args);
          }
        } finally {
          self.currentContext = prevContext;
        }
      };
      return originalSetInterval.call(this, wrappedCallback, delay);
    };
  }

  initPromiseIntercept() {
    const OriginalPromise = window.Promise;
    const self = this;

    window.Promise = function(executor) {
      const context = self.currentContext;
      const wrappedExecutor = function(resolve, reject) {
        const prevContext = self.currentContext;
        self.currentContext = context;
        try {
          executor(
            function(value) {
              self.currentContext = context;
              try { resolve(value); } finally { self.currentContext = prevContext; }
            },
            function(reason) {
              self.currentContext = context;
              try { reject(reason); } finally { self.currentContext = prevContext; }
            }
          );
        } finally {
          self.currentContext = prevContext;
        }
      };
      return new OriginalPromise(wrappedExecutor);
    };

    window.Promise.resolve = OriginalPromise.resolve;
    window.Promise.reject = OriginalPromise.reject;
    window.Promise.all = OriginalPromise.all;
    window.Promise.race = OriginalPromise.race;
    window.Promise.allSettled = OriginalPromise.allSettled;

    const originalThen = OriginalPromise.prototype.then;
    OriginalPromise.prototype.then = function(onFulfilled, onRejected) {
      const context = self.currentContext;
      const wrappedOnFulfilled = onFulfilled ? function(value) {
        const prevContext = self.currentContext;
        self.currentContext = context;
        try { return onFulfilled(value); } finally { self.currentContext = prevContext; }
      } : undefined;
      const wrappedOnRejected = onRejected ? function(reason) {
        const prevContext = self.currentContext;
        self.currentContext = context;
        try { return onRejected(reason); } finally { self.currentContext = prevContext; }
      } : undefined;
      return originalThen.call(this, wrappedOnFulfilled, wrappedOnRejected);
    };

    OriginalPromise.prototype.catch = function(onRejected) {
      return this.then(undefined, onRejected);
    };

    const originalFinally = OriginalPromise.prototype.finally;
    OriginalPromise.prototype.finally = function(onFinally) {
      const context = self.currentContext;
      const wrappedOnFinally = function() {
        const prevContext = self.currentContext;
        self.currentContext = context;
        try { return onFinally(); } finally { self.currentContext = prevContext; }
      };
      return originalFinally.call(this, wrappedOnFinally);
    };
  }

  initRequestAnimationFrameIntercept() {
    const originalRAF = window.requestAnimationFrame;
    const self = this;
    window.requestAnimationFrame = function(callback) {
      const context = self.currentContext;
      const wrappedCallback = function(timestamp) {
        const prevContext = self.currentContext;
        self.currentContext = context;
        try { callback(timestamp); } finally { self.currentContext = prevContext; }
      };
      return originalRAF.call(this, wrappedCallback);
    };
  }

  initMutationObserverIntercept() {
    const OriginalMutationObserver = window.MutationObserver;
    const self = this;
    window.MutationObserver = function(callback) {
      const context = self.currentContext;
      const wrappedCallback = function(mutations, observer) {
        const prevContext = self.currentContext;
        self.currentContext = context;
        try { callback(mutations, observer); } finally { self.currentContext = prevContext; }
      };
      return new OriginalMutationObserver(wrappedCallback);
    };
    window.MutationObserver.prototype = OriginalMutationObserver.prototype;
  }

  initEventListenerIntercept() {
    const originalAddEventListener = EventTarget.prototype.addEventListener;
    const originalRemoveEventListener = EventTarget.prototype.removeEventListener;
    const self = this;
    const listenerMap = new WeakMap();

    EventTarget.prototype.addEventListener = function(type, listener, options) {
      const context = self.currentContext;
      const wrappedListener = function(event) {
        const prevContext = self.currentContext;
        self.currentContext = context;
        try { return listener.call(this, event); } finally { self.currentContext = prevContext; }
      };

      if (!listenerMap.has(listener)) {
        listenerMap.set(listener, new Map());
      }
      listenerMap.get(listener).set(type, wrappedListener);
      return originalAddEventListener.call(this, type, wrappedListener, options);
    };

    EventTarget.prototype.removeEventListener = function(type, listener, options) {
      const wrappedMap = listenerMap.get(listener);
      if (wrappedMap && wrappedMap.has(type)) {
        const wrappedListener = wrappedMap.get(type);
        wrappedMap.delete(type);
        return originalRemoveEventListener.call(this, type, wrappedListener, options);
      }
      return originalRemoveEventListener.call(this, type, listener, options);
    };
  }
}

// ============================================================================
// 内联的 CausalChainTracker 类
// ============================================================================
class CausalChainTracker {
  constructor(ipcRenderer) {
    this.ipcRenderer = ipcRenderer;
    this.requestMap = new Map();
    this.eventCounter = 0;
    this.requestTimeout = 30000;

    // 诊断统计：eventId 为 null 的情况
    this.eventIdNullStats = {
      totalRequests: 0,
      nullEventIdRequests: 0,
      scenarios: new Map(), // 场景 -> 次数
      urls: new Map() // URL -> { total, nullCount }
    };

    // 定期上报统计信息（每30秒）
    this.startStatsReporting();

    try {
      this.asyncContext = new AsyncContextTracker();
      console.log('[CausalChainTracker] AsyncContextTracker initialized successfully');
    } catch (e) {
      console.error('[CausalChainTracker] Failed to initialize AsyncContextTracker:', e.message);
      this.asyncContext = null;
    }

    this.startRequestCleanup();
    this.initFetchIntercept();
    this.initXHRIntercept();
    this.initWebSocketIntercept();
    this.initEventSourceIntercept();
    this.initBeaconIntercept();
    this.initPostMessageIntercept();
    this.initBroadcastChannelIntercept();
    this.initStorageIntercept();
    this.initIndexedDBIntercept();
    this.initCacheAPIIntercept();
    this.initClipboardIntercept();
    this.initCompositionIntercept();
    this.initMediaIntercept();
    this.initFormIntercept();
    this.initPointerIntercept();
    this.initTouchIntercept();
    this.initLifecycleIntercept();
    this.initPerformanceIntercept();
    this.initSecurityIntercept();
    this.initCSSAnimationIntercept();

    console.log('[CausalChainTracker] Initialized with all interceptors');
  }

  // 记录 eventId 为 null 的诊断信息
  recordNullEventId(scenario, url, method = 'GET') {
    const stats = this.eventIdNullStats;
    
    // 统计场景
    const scenarioCount = stats.scenarios.get(scenario) || 0;
    stats.scenarios.set(scenario, scenarioCount + 1);
    
    // 统计 URL
    const urlStats = stats.urls.get(url) || { total: 0, nullCount: 0 };
    urlStats.total++;
    urlStats.nullCount++;
    stats.urls.set(url, urlStats);
    
    // 详细的诊断日志
    console.warn(`[CausalChainTracker] EventId is NULL - Scenario: ${scenario}, URL: ${url}, Method: ${method}`);
    
    // 发送诊断信息到主进程
    this.ipcRenderer.sendToHost('sentinel-eventid-null-diagnostic', {
      scenario: scenario,
      url: url,
      method: method,
      timestamp: Date.now(),
      currentEventId: this.getCurrentEventId(),
      hasAsyncContext: !!this.asyncContext,
      pageUrl: window.location.href
    });
  }

  // 记录请求统计
  recordRequestStats(eventId, url) {
    const stats = this.eventIdNullStats;
    stats.totalRequests++;
    
    if (!eventId) {
      stats.nullEventIdRequests++;
    }
    
    // 更新 URL 统计
    const urlStats = stats.urls.get(url) || { total: 0, nullCount: 0 };
    urlStats.total++;
    if (!eventId) {
      urlStats.nullCount++;
    }
    stats.urls.set(url, urlStats);
  }

  // 定期上报统计信息
  startStatsReporting() {
    setInterval(() => {
      const stats = this.eventIdNullStats;
      if (stats.totalRequests === 0) return;
      
      const nullRatio = (stats.nullEventIdRequests / stats.totalRequests * 100).toFixed(2);
      
      // 找出 eventId 为 null 最多的 URL
      const topNullUrls = Array.from(stats.urls.entries())
        .filter(([url, urlStats]) => urlStats.nullCount > 0)
        .sort((a, b) => b[1].nullCount - a[1].nullCount)
        .slice(0, 5)
        .map(([url, urlStats]) => ({
          url: url.substring(0, 100), // 截断长 URL
          total: urlStats.total,
          nullCount: urlStats.nullCount,
          ratio: (urlStats.nullCount / urlStats.total * 100).toFixed(2) + '%'
        }));
      
      // 找出 eventId 为 null 最多的场景
      const topScenarios = Array.from(stats.scenarios.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([scenario, count]) => ({ scenario, count }));
      
      const report = {
        timestamp: Date.now(),
        summary: {
          totalRequests: stats.totalRequests,
          nullEventIdRequests: stats.nullEventIdRequests,
          nullRatio: nullRatio + '%'
        },
        topNullUrls: topNullUrls,
        topScenarios: topScenarios
      };
      
      console.log('[CausalChainTracker] EventId Null Statistics:', JSON.stringify(report, null, 2));
      
      // 发送统计到主进程
      this.ipcRenderer.sendToHost('sentinel-eventid-stats', report);
    }, 30000); // 每30秒上报一次
  }

  generateId(prefix = 'id') {
    return `${prefix}_${Date.now()}_${++this.eventCounter}_${Math.random().toString(36).substr(2, 9)}`;
  }

  setCurrentEvent(eventType, eventData = {}) {
    if (!this.asyncContext) {
      console.warn('[CausalChainTracker] asyncContext not initialized, skipping setCurrentEvent');
      return null;
    }

    const eventId = this.generateId('evt');
    const timestamp = Date.now();

    this.asyncContext.createContext(eventId, eventType, {
      timestamp: timestamp,
      url: window.location.href,
      title: document.title,
      ...eventData
    });

    const context = {
      eventId: eventId,
      eventType: eventType,
      timestamp: timestamp,
      url: window.location.href,
      title: document.title,
      ...eventData
    };

    this.ipcRenderer.sendToHost('sentinel-event-context', context);
    console.log('[CausalChainTracker] Event context set:', eventId, eventType);
    return eventId;
  }

  clearCurrentEvent() {
    if (!this.asyncContext) {
      console.warn('[CausalChainTracker] asyncContext not initialized, skipping clearCurrentEvent');
      return;
    }
    this.asyncContext.clearCurrentContext();
  }

  getCurrentEventId() {
    if (!this.asyncContext) {
      console.warn('[CausalChainTracker] asyncContext not initialized, returning null');
      return null;
    }
    return this.asyncContext.getCurrentEventId();
  }

  recordRequestStart(requestId, type, url, method, body = null) {
    const eventId = this.getCurrentEventId();
    
    // 记录统计信息
    this.recordRequestStats(eventId, url);
    
    // 如果 eventId 为 null，记录诊断信息
    if (!eventId) {
      this.recordNullEventId(`request-start-${type}`, url, method);
    }
    
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
    console.log('[CausalChainTracker] recordRequestComplete called:', { requestId, status });
    
    let startRecord = this.requestMap.get(requestId);
    if (!startRecord) {
      console.warn('[CausalChainTracker] Request start record not found:', requestId);
      startRecord = {
        requestId: requestId,
        eventId: null,
        type: 'unknown',
        url: 'unknown',
        method: 'unknown',
        timestamp: Date.now()
      };
    }

    // 修复：如果请求开始时没有 eventId，在请求完成时重新获取
    // 这可以处理页面加载期间的请求，因为 page-load 事件上下文可能在请求开始后才设置
    let eventId = startRecord.eventId;
    let recoveredEventId = false;
    
    if (!eventId) {
      eventId = this.getCurrentEventId();
      if (eventId) {
        recoveredEventId = true;
        console.log('[CausalChainTracker] Request completed with delayed eventId:', requestId, eventId);
      } else {
        // 记录诊断：请求完成时仍然无法获取 eventId
        this.recordNullEventId(`request-complete-no-recovery`, startRecord.url, startRecord.method);
      }
    }

    const record = {
      ...startRecord,
      eventId: eventId,
      status: status,
      responseHeaders: responseHeaders,
      responseBody: responseBody,
      endTime: performance.now(),
      duration: performance.now() - (startRecord.startTime || performance.now()),
      timestamp: Date.now(),
      recoveredEventId: recoveredEventId // 标记是否通过延迟获取恢复了 eventId
    };

    console.log('[CausalChainTracker] Sending sentinel-request-complete:', { 
      requestId: record.requestId, 
      type: record.type, 
      url: record.url,
      eventId: record.eventId 
    });
    this.ipcRenderer.sendToHost('sentinel-request-complete', record);
    this.requestMap.delete(requestId);
    return record;
  }

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
    }, 30000);
  }

  initFetchIntercept() {
    const originalFetch = window.fetch;
    const self = this;

    window.fetch = async function(input, init = {}) {
      const requestId = self.generateId('fetch');
      const url = typeof input === 'string' ? input : input.url;
      const method = init.method || 'GET';
      const body = init.body || null;

      self.recordRequestStart(requestId, 'fetch', url, method, body);

      try {
        const response = await originalFetch.call(this, input, init);
        const clonedResponse = response.clone();
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
        } catch (e) {}

        const headers = {};
        response.headers.forEach((value, key) => { headers[key] = value; });
        self.recordRequestComplete(requestId, response.status, headers, responseBody);
        return response;
      } catch (error) {
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
        self.recordRequestStart(requestId, 'xhr', url, method, body);

        this.addEventListener('load', function() {
          const headers = {};
          const headerString = this.getAllResponseHeaders();
          if (headerString) {
            headerString.split('\r\n').forEach(line => {
              const parts = line.split(': ');
              if (parts.length === 2) headers[parts[0]] = parts[1];
            });
          }
          self.recordRequestComplete(requestId, this.status, headers, this.response);
        });

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

  initWebSocketIntercept() {
    const OriginalWebSocket = window.WebSocket;
    const self = this;

    window.WebSocket = function(url, protocols) {
      const ws = new OriginalWebSocket(url, protocols);
      const wsId = self.generateId('ws');
      const eventId = self.getCurrentEventId();

      console.log('[CausalChainTracker] WebSocket created:', wsId, url);
      self.ipcRenderer.sendToHost('sentinel-websocket-created', {
        wsId: wsId,
        eventId: eventId,
        url: url,
        protocols: protocols,
        timestamp: Date.now()
      });

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

      ws.addEventListener('message', (event) => {
        self.ipcRenderer.sendToHost('sentinel-websocket-message', {
          wsId: wsId,
          eventId: self.getCurrentEventId(),
          direction: 'receive',
          data: typeof event.data === 'string' ? event.data : '[Binary]',
          timestamp: Date.now()
        });
      });

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

  initEventSourceIntercept() {
    const OriginalEventSource = window.EventSource;
    const self = this;

    window.EventSource = function(url, options) {
      const es = new OriginalEventSource(url, options);
      const esId = self.generateId('sse');

      console.log('[CausalChainTracker] EventSource created:', esId, url);
      self.ipcRenderer.sendToHost('sentinel-sse-created', {
        esId: esId,
        eventId: self.getCurrentEventId(),
        url: url,
        timestamp: Date.now()
      });

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

  initBeaconIntercept() {
    const originalSendBeacon = navigator.sendBeacon;
    const self = this;

    navigator.sendBeacon = function(url, data) {
      const eventId = self.getCurrentEventId();
      self.ipcRenderer.sendToHost('sentinel-beacon', {
        eventId: eventId,
        url: url,
        data: data ? String(data) : null,
        timestamp: Date.now()
      });
      return originalSendBeacon.call(this, url, data);
    };
    console.log('[CausalChainTracker] Beacon API intercepted');
  }

  initPostMessageIntercept() {
    const originalPostMessage = window.postMessage;
    const self = this;

    window.postMessage = function(message, targetOrigin, transfer) {
      self.ipcRenderer.sendToHost('sentinel-postmessage', {
        eventId: self.getCurrentEventId(),
        message: typeof message === 'object' ? JSON.stringify(message) : String(message),
        targetOrigin: targetOrigin,
        timestamp: Date.now()
      });
      return originalPostMessage.call(this, message, targetOrigin, transfer);
    };
    console.log('[CausalChainTracker] PostMessage intercepted');
  }

  initBroadcastChannelIntercept() {
    if (typeof BroadcastChannel === 'undefined') return;
    const OriginalBroadcastChannel = BroadcastChannel;
    const self = this;

    window.BroadcastChannel = function(name) {
      const channel = new OriginalBroadcastChannel(name);
      const bcId = self.generateId('bc');

      const originalPostMessage = channel.postMessage;
      channel.postMessage = function(message) {
        self.ipcRenderer.sendToHost('sentinel-broadcastchannel', {
          bcId: bcId,
          eventId: self.getCurrentEventId(),
          name: name,
          message: typeof message === 'object' ? JSON.stringify(message) : String(message),
          timestamp: Date.now()
        });
        return originalPostMessage.call(this, message);
      };

      return channel;
    };
    console.log('[CausalChainTracker] BroadcastChannel intercepted');
  }

  initStorageIntercept() {
    const self = this;

    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      self.ipcRenderer.sendToHost('sentinel-storage', {
        eventId: self.getCurrentEventId(),
        type: this === localStorage ? 'localStorage' : 'sessionStorage',
        action: 'setItem',
        key: key,
        timestamp: Date.now()
      });
      return originalSetItem.call(this, key, value);
    };

    const originalRemoveItem = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function(key) {
      self.ipcRenderer.sendToHost('sentinel-storage', {
        eventId: self.getCurrentEventId(),
        type: this === localStorage ? 'localStorage' : 'sessionStorage',
        action: 'removeItem',
        key: key,
        timestamp: Date.now()
      });
      return originalRemoveItem.call(this, key);
    };

    const originalClear = Storage.prototype.clear;
    Storage.prototype.clear = function() {
      self.ipcRenderer.sendToHost('sentinel-storage', {
        eventId: self.getCurrentEventId(),
        type: this === localStorage ? 'localStorage' : 'sessionStorage',
        action: 'clear',
        timestamp: Date.now()
      });
      return originalClear.call(this);
    };
    console.log('[CausalChainTracker] Storage API intercepted');
  }

  initIndexedDBIntercept() {
    if (!window.indexedDB) return;
    const originalOpen = window.indexedDB.open;
    const self = this;

    window.indexedDB.open = function(name, version) {
      self.ipcRenderer.sendToHost('sentinel-indexeddb', {
        eventId: self.getCurrentEventId(),
        action: 'open',
        name: name,
        version: version,
        timestamp: Date.now()
      });
      return originalOpen.call(this, name, version);
    };
    console.log('[CausalChainTracker] IndexedDB intercepted');
  }

  initCacheAPIIntercept() {
    if (!window.caches) return;
    const originalOpen = window.caches.open;
    const self = this;

    window.caches.open = function(cacheName) {
      self.ipcRenderer.sendToHost('sentinel-cache', {
        eventId: self.getCurrentEventId(),
        action: 'open',
        cacheName: cacheName,
        timestamp: Date.now()
      });
      return originalOpen.call(this, cacheName);
    };
    console.log('[CausalChainTracker] Cache API intercepted');
  }

  initClipboardIntercept() {
    const self = this;

    const originalWriteText = navigator.clipboard.writeText;
    navigator.clipboard.writeText = function(text) {
      self.ipcRenderer.sendToHost('sentinel-clipboard', {
        eventId: self.getCurrentEventId(),
        action: 'writeText',
        timestamp: Date.now()
      });
      return originalWriteText.call(this, text);
    };

    const originalWrite = navigator.clipboard.write;
    navigator.clipboard.write = function(data) {
      self.ipcRenderer.sendToHost('sentinel-clipboard', {
        eventId: self.getCurrentEventId(),
        action: 'write',
        timestamp: Date.now()
      });
      return originalWrite.call(this, data);
    };
    console.log('[CausalChainTracker] Clipboard API intercepted');
  }

  initCompositionIntercept() {
    const self = this;
    ['compositionstart', 'compositionupdate', 'compositionend'].forEach(eventType => {
      document.addEventListener(eventType, (e) => {
        self.ipcRenderer.sendToHost('sentinel-composition', {
          eventId: self.getCurrentEventId(),
          type: eventType,
          target: e.target.tagName,
          xpath: self.getXPath(e.target),
          data: e.data,
          timestamp: Date.now()
        });
      }, true);
    });
    console.log('[CausalChainTracker] Composition events intercepted');
  }

  initMediaIntercept() {
    const self = this;
    ['play', 'pause', 'seeked', 'ended'].forEach(eventType => {
      document.addEventListener(eventType, (e) => {
        if (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO') {
          self.ipcRenderer.sendToHost('sentinel-media-event', {
            eventId: self.getCurrentEventId(),
            type: eventType,
            mediaType: e.target.tagName.toLowerCase(),
            src: e.target.src,
            currentTime: e.target.currentTime,
            timestamp: Date.now()
          });
        }
      }, true);
    });
    console.log('[CausalChainTracker] Media events intercepted');
  }

  initFormIntercept() {
    const self = this;
    document.addEventListener('submit', (e) => {
      const form = e.target;
      const formData = new FormData(form);
      const data = {};
      for (const [key, value] of formData.entries()) {
        data[key] = key.toLowerCase().includes('password') || key.toLowerCase().includes('token') ? '[REDACTED]' : value;
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

  initPointerIntercept() {
    const self = this;
    ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'].forEach(eventType => {
      document.addEventListener(eventType, (e) => {
        self.ipcRenderer.sendToHost('sentinel-pointer-event', {
          eventId: self.getCurrentEventId(),
          type: eventType,
          pointerId: e.pointerId,
          pointerType: e.pointerType,
          x: e.clientX,
          y: e.clientY,
          target: e.target.tagName,
          timestamp: Date.now()
        });
      }, true);
    });
    console.log('[CausalChainTracker] Pointer events intercepted');
  }

  initTouchIntercept() {
    const self = this;
    ['touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach(eventType => {
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

  initLifecycleIntercept() {
    const self = this;

    document.addEventListener('visibilitychange', () => {
      self.ipcRenderer.sendToHost('sentinel-visibility-change', {
        eventId: self.getCurrentEventId(),
        hidden: document.hidden,
        visibilityState: document.visibilityState,
        timestamp: Date.now()
      });
    });

    window.addEventListener('beforeunload', () => {
      self.ipcRenderer.sendToHost('sentinel-before-unload', {
        eventId: self.getCurrentEventId(),
        url: window.location.href,
        timestamp: Date.now()
      });
    });

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
      }, 250);
    });
    console.log('[CausalChainTracker] Lifecycle events intercepted');
  }

  initPerformanceIntercept() {
    const self = this;
    if (window.PerformanceObserver) {
      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            self.ipcRenderer.sendToHost('sentinel-performance', {
              eventId: self.getCurrentEventId(),
              type: entry.entryType,
              name: entry.name,
              duration: entry.duration,
              timestamp: Date.now()
            });
          }
        });
        observer.observe({ entryTypes: ['measure', 'navigation', 'resource'] });
      } catch (e) {}
    }
    console.log('[CausalChainTracker] Performance observer initialized');
  }

  initSecurityIntercept() {
    const self = this;
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

  initCSSAnimationIntercept() {
    const self = this;
    ['animationstart', 'animationend'].forEach(eventType => {
      document.addEventListener(eventType, (e) => {
        self.ipcRenderer.sendToHost('sentinel-css-animation', {
          eventId: self.getCurrentEventId(),
          type: eventType,
          animationName: e.animationName,
          target: e.target.tagName,
          timestamp: Date.now()
        });
      }, true);
    });
    ['transitionstart', 'transitionend'].forEach(eventType => {
      document.addEventListener(eventType, (e) => {
        self.ipcRenderer.sendToHost('sentinel-css-transition', {
          eventId: self.getCurrentEventId(),
          type: eventType,
          propertyName: e.propertyName,
          target: e.target.tagName,
          timestamp: Date.now()
        });
      }, true);
    });
    console.log('[CausalChainTracker] CSS Animation/Transition intercepted');
  }

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
}

// ============================================================================
// 初始化 CausalChainTracker
// ============================================================================
let causalChain = null;
let pageLoadEventId = null;
let pageLoadStartTime = null;

console.log('[Sentinel Webview] Starting CausalChainTracker initialization...');

try {
  console.log('[Sentinel Webview] CausalChainTracker class exists:', typeof CausalChainTracker);
  causalChain = new CausalChainTracker(ipcRenderer);
  console.log('[Sentinel Webview] CausalChainTracker initialized successfully, instance:', !!causalChain);
} catch (e) {
  console.error('[Sentinel Webview] Failed to initialize CausalChainTracker:', e.message, e.stack);
}

// ============================================================================
// 页面加载开始事件 - 在脚本执行时立即创建（HTML下载前）
// ============================================================================
function initPageLoadStart() {
  pageLoadStartTime = performance.now();
  
  if (causalChain && causalChain.setCurrentEvent && typeof causalChain.setCurrentEvent === 'function') {
    try {
      pageLoadEventId = causalChain.setCurrentEvent('page-load-start', {
        url: window.location.href,
        title: document.title,
        navigationStart: performance.timeOrigin + performance.now()
      });
      console.log('[Sentinel Webview] Page-load-start event created, eventId:', pageLoadEventId);
    } catch (err) {
      console.warn('[Sentinel Webview] Failed to create page-load-start event:', err.message);
    }
  } else {
    console.warn('[Sentinel Webview] causalChain not available for page-load-start');
  }

  // 发送 page-load-start 事件到主进程
  ipcRenderer.sendToHost('sentinel-page-load-start', {
    eventId: pageLoadEventId,
    type: 'page-load-start',
    url: window.location.href,
    title: document.title,
    timestamp: Date.now(),
    navigationTiming: {
      startTime: pageLoadStartTime
    }
  });
  
  console.log('[Sentinel Webview] Page-load-start event sent to host');
}

// 立即执行页面加载开始事件初始化
initPageLoadStart();

// 自定义日志函数，通过 IPC 发送到主进程
function sendLog(level, ...args) {
  const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
  ipcRenderer.sendToHost('sentinel-console-log', { level, message, timestamp: Date.now() });
}

// 全局错误捕获
try {
  sendLog('log', '[Sentinel Webview] Preload script loaded, location:', window.location.href);
  sendLog('log', '[Sentinel Webview] ipcRenderer available:', !!ipcRenderer);
} catch (e) {
  sendLog('error', '[Sentinel Webview] Error in preload:', e.message);
}

// 立即发送测试消息
ipcRenderer.sendToHost('sentinel-preload-loaded', { timestamp: Date.now(), url: window.location.href });
console.log('[Sentinel Webview] Test message sent to host');

// 防止重复注入
if (window.__sentinelWebviewLoaded) {
  console.log('[Sentinel Webview] Already loaded, skipping');
  return;
}
window.__sentinelWebviewLoaded = true;
console.log('[Sentinel Webview] Initializing...');

// 全局暂停状态
let isRecordingPaused = false;

// 监听录制暂停/恢复状态
ipcRenderer.on('recording-paused', (event, data) => {
  isRecordingPaused = data.isPaused;
  console.log('[Sentinel Webview] Recording paused state:', isRecordingPaused);
});

// 检查是否处于暂停状态的辅助函数
function checkPaused() {
  return isRecordingPaused;
}

// ============ rrweb 标准 DOM 序列化 ============

const NodeType = {
  Document: 0,
  DocumentType: 1,
  Element: 2,
  Text: 3,
  CDATA: 4,
  Comment: 5
};

const sensitiveAttributes = ['password', 'credit-card', 'ssn'];

function isSensitiveAttribute(name, value) {
  const lowerName = name.toLowerCase();
  return sensitiveAttributes.some(keyword => 
    lowerName.includes(keyword) || (value && value.toLowerCase().includes(keyword))
  );
}

function serializeNode(node, doc, map, parentId = null) {
  if (!node) return null;
  const id = getNodeId(node);
  if (id === null) return null;
  if (map.nodes.has(id)) return map.nodes.get(id);

  const serializedNode = { id };

  switch (node.nodeType) {
    case Node.DOCUMENT_NODE:
      serializedNode.type = NodeType.Document;
      serializedNode.childNodes = [];
      break;

    case Node.DOCUMENT_TYPE_NODE:
      serializedNode.type = NodeType.DocumentType;
      serializedNode.name = node.name;
      serializedNode.publicId = node.publicId || '';
      serializedNode.systemId = node.systemId || '';
      break;

    case Node.ELEMENT_NODE:
      serializedNode.type = NodeType.Element;
      serializedNode.tagName = node.tagName.toLowerCase();
      const attributes = {};
      for (let i = 0; i < node.attributes.length; i++) {
        const attr = node.attributes[i];
        attributes[attr.name] = isSensitiveAttribute(attr.name, attr.value) ? '***' : attr.value;
      }
      serializedNode.attributes = attributes;
      if (node.shadowRoot) {
        serializedNode.isShadowHost = true;
        serializedNode.shadowRoot = serializeNode(node.shadowRoot, doc, map, id);
      }
      serializedNode.childNodes = [];
      break;

    case Node.TEXT_NODE:
      serializedNode.type = NodeType.Text;
      let textContent = node.textContent || '';
      if (textContent.length > 10000) {
        textContent = textContent.substring(0, 10000) + '... [truncated]';
      }
      serializedNode.textContent = textContent;
      break;

    case Node.CDATA_SECTION_NODE:
      serializedNode.type = NodeType.CDATA;
      serializedNode.textContent = node.textContent || '';
      break;

    case Node.COMMENT_NODE:
      serializedNode.type = NodeType.Comment;
      serializedNode.textContent = node.textContent || '';
      break;

    default:
      return null;
  }

  if (parentId !== null) {
    const parent = map.nodes.get(parentId);
    if (parent && parent.childNodes) {
      parent.childNodes.push(id);
    }
  }

  map.nodes.set(id, serializedNode);

  if (node.childNodes && node.childNodes.length > 0) {
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes[i];
      if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'SCRIPT') continue;
      serializeNode(child, doc, map, id);
    }
  }

  return serializedNode;
}

function serializeDocument() {
  const map = { nodes: new Map() };
  const doc = document;
  const rootNode = serializeNode(doc, doc, map, null);
  const nodeArray = Array.from(map.nodes.values());
  return { node: rootNode, nodes: nodeArray, id: nextNodeId };
}

function createFullSnapshot() {
  const serialized = serializeDocument();
  return {
    type: 2,
    data: {
      node: serialized.node,
      nodes: serialized.nodes,
      initialOffset: {
        left: window.pageXOffset || document.documentElement.scrollLeft || 0,
        top: window.pageYOffset || document.documentElement.scrollTop || 0
      }
    },
    timestamp: Date.now()
  };
}

let domMutations = { adds: [], removes: [], texts: [], attributes: [] };
let nodeIdMap = new WeakMap();
let nextNodeId = 1;
let autoFullSnapshotTimer = null;
let incrementalSnapshotInterval = null;  // 【修复】存储定期发送增量快照的定时器 ID
let pendingMutationsCount = 0;

// 【修复】使用 window 对象存储初始化标志，避免页面导航时重置
const isInitialized = () => window.__sentinelWebviewInitialized === true;
const setInitialized = () => { window.__sentinelWebviewInitialized = true; };
const AUTO_SNAPSHOT_DELAY = 500;
const AUTO_SNAPSHOT_THRESHOLD = 50;  // 【修复】从 10 增加到 50，减少自动 FullSnapshot 触发频率

function getNodeId(node) {
  if (!node) return null;
  if (nodeIdMap.has(node)) return nodeIdMap.get(node);
  const id = nextNodeId++;
  nodeIdMap.set(node, id);
  return id;
}

function triggerAutoFullSnapshot() {
  if (autoFullSnapshotTimer) {
    clearTimeout(autoFullSnapshotTimer);
    autoFullSnapshotTimer = null;
  }
  pendingMutationsCount = 0;
  console.log('[Sentinel Webview] Auto-triggering full snapshot');
  ipcRenderer.sendToHost('sentinel-request-full-snapshot', { reason: 'auto', timestamp: Date.now() });
}

function scheduleAutoFullSnapshot() {
  if (autoFullSnapshotTimer) return;
  autoFullSnapshotTimer = setTimeout(() => {
    triggerAutoFullSnapshot();
  }, AUTO_SNAPSHOT_DELAY);
}

let mutationObserver = null;

function initMutationObserver() {
  if (mutationObserver) return;

  mutationObserver = new MutationObserver((mutations) => {
    let significantChange = false;
    
    mutations.forEach(mutation => {
      switch (mutation.type) {
        case 'childList':
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
              const parentId = getNodeId(mutation.target);
              if (parentId !== null) {
                domMutations.adds.push({
                  parentId: parentId,
                  node: serializeNodeForMutation(node),
                  nextId: getNodeId(mutation.nextSibling)
                });
                pendingMutationsCount++;
              }
            }
          });

          mutation.removedNodes.forEach(node => {
            const nodeId = getNodeId(node);
            if (nodeId !== null) {
              domMutations.removes.push({ parentId: getNodeId(mutation.target), id: nodeId });
              pendingMutationsCount++;
            }
          });
          
          if (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0) {
            significantChange = true;
          }
          break;

        case 'characterData':
          const textNodeId = getNodeId(mutation.target);
          if (textNodeId !== null) {
            domMutations.texts.push({ id: textNodeId, value: mutation.target.textContent });
          }
          break;

        case 'attributes':
          const attrNodeId = getNodeId(mutation.target);
          if (attrNodeId !== null) {
            domMutations.attributes.push({
              id: attrNodeId,
              attributes: { [mutation.attributeName]: mutation.target.getAttribute(mutation.attributeName) }
            });
          }
          break;
      }
    });
    
    // 【修复】检测到变化时立即发送增量快照，而不是等待阈值
    if (significantChange && !checkPaused()) {
      // 使用 setTimeout 批量处理，避免每个 mutation 都发送
      if (!window.__sentinelPendingSnapshot) {
        window.__sentinelPendingSnapshot = true;
        setTimeout(() => {
          window.__sentinelPendingSnapshot = false;
          if (domMutations.adds.length > 0 || 
              domMutations.removes.length > 0 || 
              domMutations.texts.length > 0 || 
              domMutations.attributes.length > 0) {
            console.log('[Sentinel Webview] Sending incremental snapshot, changes:', {
              adds: domMutations.adds.length,
              removes: domMutations.removes.length,
              texts: domMutations.texts.length,
              attributes: domMutations.attributes.length
            });
            saveDOMSnapshot('incremental');
          }
        }, 100); // 100ms 后发送，批量处理
      }
    }
  });

  mutationObserver.observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeOldValue: true
  });

  console.log('[Sentinel Webview] MutationObserver initialized');
}

function serializeNodeForMutation(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    return { type: NodeType.Text, textContent: node.textContent, id: getNodeId(node) };
  }

  if (node.nodeType === Node.ELEMENT_NODE) {
    const attributes = {};
    for (const attr of node.attributes || []) {
      if (!isSensitiveAttribute(attr.name, attr.value)) {
        attributes[attr.name] = attr.value;
      }
    }

    // 【修复】递归序列化子节点，而不是只记录 ID
    const childNodes = [];
    for (const child of node.childNodes) {
      const serializedChild = serializeNodeForMutation(child);
      if (serializedChild) {
        childNodes.push(serializedChild);
      }
    }

    return {
      type: NodeType.Element,
      tagName: node.tagName.toLowerCase(),
      attributes: attributes,
      childNodes: childNodes,  // 【修复】存储完整的子节点对象
      id: getNodeId(node)
    };
  }

  return null;
}

function createIncrementalSnapshot() {
  initMutationObserver();

  const snapshot = {
    type: 3,
    data: {
      source: 0,
      adds: domMutations.adds,
      removes: domMutations.removes,
      texts: domMutations.texts,
      attributes: domMutations.attributes
    },
    timestamp: Date.now()
  };

  domMutations = { adds: [], removes: [], texts: [], attributes: [] };
  return snapshot;
}

// ============ 事件监听和上报 ============

function getXPath(element) {
  if (element.id) return `//*[@id="${element.id}"]`;
  if (element === document.body) return '/html/body';
  
  let ix = 0;
  const siblings = element.parentNode ? element.parentNode.childNodes : [];
  for (let i = 0; i < siblings.length; i++) {
    const sibling = siblings[i];
    if (sibling === element) {
      return getXPath(element.parentNode) + '/' + element.tagName.toLowerCase() + '[' + (ix + 1) + ']';
    }
    if (sibling.nodeType === 1 && sibling.tagName === element.tagName) ix++;
  }
  return '';
}

function getSelector(element) {
  if (element.id) return '#' + element.id;
  if (element.className) {
    const classes = element.className.split(' ').filter(c => c.trim());
    if (classes.length > 0) {
      return element.tagName.toLowerCase() + '.' + classes.join('.');
    }
  }
  return element.tagName.toLowerCase();
}

function getShadowDOMPath(element) {
  const path = [];
  let current = element;
  
  while (current && current !== document.body) {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      selector += `#${current.id}`;
    } else if (current.className) {
      const classes = current.className.split(' ').filter(c => c.trim());
      if (classes.length > 0) selector += `.${classes.join('.')}`;
    }
    
    if (current.getRootNode() instanceof ShadowRoot) {
      const host = current.getRootNode().host;
      if (host) selector = `${host.tagName.toLowerCase()}::shadow-root > ${selector}`;
    }
    
    path.unshift(selector);
    current = current.parentElement || current.getRootNode().host;
  }
  
  return path.join(' > ');
}

function collectDOMStats() {
  try {
    return {
      buttons: document.querySelectorAll('button, input[type="button"], input[type="submit"]').length,
      links: document.querySelectorAll('a').length,
      forms: document.querySelectorAll('form').length,
      inputs: document.querySelectorAll('input, textarea, select').length,
      images: document.querySelectorAll('img').length
    };
  } catch (e) {
    console.error('[Sentinel Webview] Error collecting DOM stats:', e);
    return {};
  }
}

// 监听点击事件
document.addEventListener('click', (e) => {
  if (checkPaused()) return;

  const timestamp = Date.now();
  let eventId = null;
  
  // 修复：添加更严格的空值检查
  if (causalChain && causalChain.setCurrentEvent && typeof causalChain.setCurrentEvent === 'function') {
    try {
      eventId = causalChain.setCurrentEvent('click', {
        xpath: getXPath(e.target),
        selector: getSelector(e.target),
        tagName: e.target.tagName
      });
    } catch (err) {
      console.warn('[Sentinel Webview] Failed to set causal chain context:', err.message);
    }
  }
  
  const clickData = {
    eventId: eventId,
    type: 'click',
    timestamp: timestamp,
    xpath: getXPath(e.target),
    selector: getSelector(e.target),
    shadowPath: getShadowDOMPath(e.target),
    tagName: e.target.tagName,
    text: e.target.textContent ? e.target.textContent.substring(0, 100) : '',
    coordinates: { x: e.clientX, y: e.clientY },
    url: window.location.href,
    title: document.title,
    domStats: collectDOMStats()
  };

  ipcRenderer.sendToHost('sentinel-click', clickData);
  console.log('[Sentinel Webview] Click tracked:', clickData.selector, 'eventId:', eventId);
  
  setTimeout(() => {
    saveDOMSnapshot('incremental', timestamp);
    setTimeout(() => {
      // 修复：添加更严格的空值检查
      if (causalChain && causalChain.clearCurrentEvent && typeof causalChain.clearCurrentEvent === 'function') {
        try {
          causalChain.clearCurrentEvent();
        } catch (err) {
          console.warn('[Sentinel Webview] Failed to clear causal chain context:', err.message);
        }
      }
    }, 5000); // 修复：延长到 5 秒，确保 API 请求能关联到事件
  }, 100);
}, true);

// 监听输入事件
document.addEventListener('input', (e) => {
  if (checkPaused()) return;

  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
    const timestamp = Date.now();
    let eventId = null;

    // 修复：设置事件上下文，使 API 请求能关联到 input 事件
    if (causalChain && causalChain.setCurrentEvent && typeof causalChain.setCurrentEvent === 'function') {
      try {
        eventId = causalChain.setCurrentEvent('input', {
          xpath: getXPath(e.target),
          selector: getSelector(e.target),
          tagName: e.target.tagName
        });
      } catch (err) {
        console.warn('[Sentinel Webview] Failed to set causal chain context for input:', err.message);
      }
    }

    const inputData = {
      eventId: eventId,
      type: 'input',
      timestamp: timestamp,
      xpath: getXPath(e.target),
      selector: getSelector(e.target),
      tagName: e.target.tagName,
      inputType: e.target.type,
      name: e.target.name || e.target.id || '',
      value: e.target.type === 'password' ? '[REDACTED]' : (e.target.value ? e.target.value.substring(0, 200) : ''),
      url: window.location.href,
      title: document.title,
      domStats: collectDOMStats()
    };

    ipcRenderer.sendToHost('sentinel-input', inputData);
    setTimeout(() => { saveDOMSnapshot('incremental', timestamp); }, 100);

    // 修复：延迟清除事件上下文
    setTimeout(() => {
      if (causalChain && causalChain.clearCurrentEvent && typeof causalChain.clearCurrentEvent === 'function') {
        try {
          causalChain.clearCurrentEvent();
        } catch (err) {
          console.warn('[Sentinel Webview] Failed to clear causal chain context for input:', err.message);
        }
      }
    }, 5000);
  }
}, true);

// 监听滚动事件
let scrollTimeout;
let scrollStartTime = 0;
let scrollStartY = 0;
let scrollStartX = 0;
let lastScrollY = 0;
let lastScrollX = 0;
let lastScrollDirection = null;

function getScrollDirection(currentY, currentX) {
  const deltaY = currentY - lastScrollY;
  const deltaX = currentX - lastScrollX;
  
  if (Math.abs(deltaY) > Math.abs(deltaX)) {
    return deltaY > 0 ? 'down' : 'up';
  } else if (Math.abs(deltaX) > 0) {
    return deltaX > 0 ? 'right' : 'left';
  }
  return null;
}

function handleScrollStart() {
  if (checkPaused()) return;

  scrollStartTime = Date.now();
  scrollStartY = window.scrollY;
  scrollStartX = window.scrollX;
  lastScrollY = scrollStartY;
  lastScrollX = scrollStartX;
  lastScrollDirection = null;

  // 修复：设置事件上下文，使 API 请求能关联到 scroll 事件
  if (causalChain && causalChain.setCurrentEvent && typeof causalChain.setCurrentEvent === 'function') {
    try {
      causalChain.setCurrentEvent('scroll', {
        startX: scrollStartX,
        startY: scrollStartY
      });
    } catch (err) {
      console.warn('[Sentinel Webview] Failed to set causal chain context for scroll:', err.message);
    }
  }

  const scrollStartData = {
    type: 'scroll-start',
    timestamp: scrollStartTime,
    startX: scrollStartX,
    startY: scrollStartY,
    url: window.location.href,
    title: document.title,
    domStats: collectDOMStats()
  };

  ipcRenderer.sendToHost('sentinel-scroll-start', scrollStartData);
  console.log('[Sentinel Webview] Scroll start:', scrollStartY);
}

function handleScroll() {
  if (checkPaused()) return;
  if (scrollStartTime === 0) return;
  
  const currentY = window.scrollY;
  const currentX = window.scrollX;
  const currentDirection = getScrollDirection(currentY, currentX);
  
  if (currentDirection && currentDirection !== lastScrollDirection) {
    lastScrollDirection = currentDirection;
  }
  
  const scrollData = {
    type: 'scroll',
    timestamp: Date.now(),
    x: currentX,
    y: currentY,
    deltaX: currentX - lastScrollX,
    deltaY: currentY - lastScrollY,
    direction: currentDirection,
    url: window.location.href,
    title: document.title,
    domStats: collectDOMStats()
  };
  
  ipcRenderer.sendToHost('sentinel-scroll', scrollData);
  
  lastScrollY = currentY;
  lastScrollX = currentX;
  
  clearTimeout(scrollTimeout);
  scrollTimeout = setTimeout(handleScrollEnd, 150);
}

function handleScrollEnd() {
  if (checkPaused()) return;

  const scrollEndData = {
    type: 'scroll-end',
    timestamp: Date.now(),
    startX: scrollStartX,
    startY: scrollStartY,
    endX: window.scrollX,
    endY: window.scrollY,
    deltaX: window.scrollX - scrollStartX,
    deltaY: window.scrollY - scrollStartY,
    direction: lastScrollDirection,
    duration: Date.now() - scrollStartTime,
    url: window.location.href,
    title: document.title,
    domStats: collectDOMStats()
  };

  ipcRenderer.sendToHost('sentinel-scroll-end', scrollEndData);
  console.log('[Sentinel Webview] Scroll end:', scrollEndData);

  scrollStartTime = 0;
  lastScrollDirection = null;

  // 修复：延迟清除事件上下文，确保 API 请求能关联到 scroll 事件
  setTimeout(() => {
    if (causalChain && causalChain.clearCurrentEvent && typeof causalChain.clearCurrentEvent === 'function') {
      try {
        causalChain.clearCurrentEvent();
      } catch (err) {
        console.warn('[Sentinel Webview] Failed to clear causal chain context for scroll:', err.message);
      }
    }
  }, 5000);
}

window.addEventListener('scroll', () => {
  if (scrollStartTime === 0) {
    handleScrollStart();
  }
  handleScroll();
}, { passive: true });

// 监听键盘事件
document.addEventListener('keydown', (e) => {
  if (checkPaused()) return;

  const timestamp = Date.now();
  let eventId = null;

  // 修复：设置事件上下文，使 API 请求能关联到 keydown 事件
  if (causalChain && causalChain.setCurrentEvent && typeof causalChain.setCurrentEvent === 'function') {
    try {
      eventId = causalChain.setCurrentEvent('keydown', {
        key: e.key,
        target: e.target.tagName
      });
    } catch (err) {
      console.warn('[Sentinel Webview] Failed to set causal chain context for keydown:', err.message);
    }
  }

  const keyData = {
    eventId: eventId,
    type: 'keydown',
    timestamp: timestamp,
    key: e.key,
    code: e.code,
    ctrlKey: e.ctrlKey,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
    target: e.target.tagName,
    xpath: getXPath(e.target),
    selector: getSelector(e.target),
    url: window.location.href,
    title: document.title
  };

  ipcRenderer.sendToHost('sentinel-keydown', keyData);

  // 修复：延迟清除事件上下文
  setTimeout(() => {
    if (causalChain && causalChain.clearCurrentEvent && typeof causalChain.clearCurrentEvent === 'function') {
      try {
        causalChain.clearCurrentEvent();
      } catch (err) {
        console.warn('[Sentinel Webview] Failed to clear causal chain context for keydown:', err.message);
      }
    }
  }, 5000);
}, true);

// 监听悬停事件
let hoverTimeout;
document.addEventListener('mouseover', (e) => {
  if (checkPaused()) return;

  clearTimeout(hoverTimeout);
  hoverTimeout = setTimeout(() => {
    const hoverData = {
      type: 'hover',
      timestamp: Date.now(),
      xpath: getXPath(e.target),
      selector: getSelector(e.target),
      tagName: e.target.tagName,
      text: e.target.textContent ? e.target.textContent.substring(0, 100) : '',
      url: window.location.href,
      title: document.title
    };

    ipcRenderer.sendToHost('sentinel-hover', hoverData);
  }, 500);
}, true);

// 文件上传监控
document.addEventListener('change', (e) => {
  if (checkPaused()) return;

  if (e.target.tagName === 'INPUT' && e.target.type === 'file') {
    const files = e.target.files;
    if (files && files.length > 0) {
      const fileList = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        fileList.push({
          name: file.name,
          size: file.size,
          type: file.type,
          lastModified: file.lastModified
        });
      }

      const uploadData = {
        type: 'file-upload',
        timestamp: Date.now(),
        xpath: getXPath(e.target),
        selector: getSelector(e.target),
        fileCount: files.length,
        files: fileList,
        url: window.location.href,
        title: document.title
      };

      ipcRenderer.sendToHost('sentinel-file-upload', uploadData);
      console.log('[Sentinel Webview] File upload tracked:', fileList.map(f => f.name).join(', '));

      Array.from(files).forEach(file => {
        readFileContent(file);
      });
    }
  }
}, true);

function readFileContent(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    console.log('[Sentinel Webview] File content read:', file.name);
  };
  reader.onerror = (error) => {
    console.error('[Sentinel Webview] Failed to read file:', file.name, error);
  };
  if (file.type.startsWith('image/')) {
    reader.readAsDataURL(file);
  } else if (file.type.startsWith('text/') || file.type === 'application/json') {
    reader.readAsText(file);
  }
}

// 拖拽文件上传监控
document.addEventListener('dragover', (e) => { e.preventDefault(); }, true);

document.addEventListener('drop', (e) => {
  e.preventDefault();
  if (checkPaused()) return;

  const files = e.dataTransfer.files;
  if (files && files.length > 0) {
    const fileList = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      fileList.push({ name: file.name, size: file.size, type: file.type, lastModified: file.lastModified });
    }

    const dropData = {
      type: 'file-drop',
      timestamp: Date.now(),
      xpath: getXPath(e.target),
      selector: getSelector(e.target),
      tagName: e.target.tagName,
      fileCount: files.length,
      files: fileList,
      coordinates: { x: e.clientX, y: e.clientY },
      url: window.location.href,
      title: document.title
    };

    ipcRenderer.sendToHost('sentinel-file-drop', dropData);
    console.log('[Sentinel Webview] File drop tracked:', fileList.map(f => f.name).join(', '));
  }
}, true);

// 保存 DOM 快照
function saveDOMSnapshot(type = 'snapshot', externalTimestamp = null) {
  if (type !== 'initial' && type !== 'auto' && checkPaused()) return;

  let rrwebEvent;
  if (type === 'initial' || type === 'auto') {
    rrwebEvent = createFullSnapshot();
    console.log('[Sentinel Webview] Creating full snapshot for type:', type);
  } else {
    rrwebEvent = createIncrementalSnapshot();
  }

  const snapshot = {
    type: type,
    rrwebEvent: rrwebEvent,
    url: window.location.href,
    title: document.title,
    timestamp: externalTimestamp || Date.now()
  };

  ipcRenderer.sendToHost('sentinel-dom-snapshot', snapshot);
  console.log('[Sentinel Webview] DOM snapshot saved:', type, 'event type:', rrwebEvent.type);
}

window.saveDOMSnapshot = saveDOMSnapshot;
console.log('[Sentinel Webview] saveDOMSnapshot bound to window:', typeof window.saveDOMSnapshot);

if (typeof global !== 'undefined') {
  global.saveDOMSnapshot = saveDOMSnapshot;
  console.log('[Sentinel Webview] saveDOMSnapshot bound to global:', typeof global.saveDOMSnapshot);
}

ipcRenderer.on('trigger-dom-snapshot', (event, data) => {
  console.log('[Sentinel Webview] Received trigger-dom-snapshot message:', data);
  const type = data?.type || 'incremental';
  const timestamp = data?.timestamp || Date.now();
  saveDOMSnapshot(type, timestamp);
});

// 页面加载完成处理函数
function handlePageLoadComplete() {
  const timestamp = Date.now();
  const pageLoadEndTime = performance.now();
  const duration = pageLoadStartTime ? (pageLoadEndTime - pageLoadStartTime) : null;
  
  console.log('[Sentinel Webview] Page load completed, sending page-load-complete event');

  // 使用 page-load-start 时创建的 eventId，确保事件关联
  const eventId = pageLoadEventId;
  
  if (!eventId) {
    console.warn('[Sentinel Webview] pageLoadEventId not available for page-load-complete');
  }

  // 发送 page-load-complete 事件到主进程，使用相同的 eventId
  ipcRenderer.sendToHost('sentinel-page-load-complete', {
    eventId: eventId,
    type: 'page-load-complete',
    url: window.location.href,
    title: document.title,
    timestamp: timestamp,
    navigationTiming: {
      startTime: pageLoadStartTime,
      endTime: pageLoadEndTime,
      duration: duration
    }
  });
  
  console.log('[Sentinel Webview] Page-load-complete event sent to host, eventId:', eventId, 'duration:', duration);

  // 【修复】页面加载完成后，立即生成 initial DOM snapshot
  console.log('[Sentinel Webview] Creating initial DOM snapshot after page load');
  saveDOMSnapshot('initial', timestamp);

  // 【修复】防止重复初始化
  if (isInitialized()) {
    console.log('[Sentinel Webview] Already initialized, skipping');
    return;
  }
  setInitialized();

  initMutationObserver();
  console.log('[Sentinel Webview] MutationObserver initialized on page load complete');

  // 【修复】不再使用定时器发送空快照
  // 改为在 MutationObserver 中检测到变化时立即发送
  console.log('[Sentinel Webview] Incremental snapshot on-demand mode enabled');

  // 延迟清除事件上下文，确保页面加载完成后的短暂时间内 API 请求仍能关联
  setTimeout(() => {
    if (causalChain && causalChain.clearCurrentEvent && typeof causalChain.clearCurrentEvent === 'function') {
      try {
        causalChain.clearCurrentEvent();
        console.log('[Sentinel Webview] Page-load event context cleared');
      } catch (err) {
        console.warn('[Sentinel Webview] Failed to clear causal chain context for page-load:', err.message);
      }
    }
  }, 5000); // 5秒后清除上下文
}

// 页面加载完成通知
// 使用 window.load 事件确保页面完全加载（包括图片等资源）
if (document.readyState === 'loading') {
  // 页面仍在加载中，等待 load 事件
  window.addEventListener('load', handlePageLoadComplete);
} else if (document.readyState === 'interactive' || document.readyState === 'complete') {
  // 页面已经加载完成或交互状态，立即处理
  console.log('[Sentinel Webview] Page already loaded, handling page-load-complete immediately');
  handlePageLoadComplete();
}

// 监听页面导航
let lastUrl = location.href;
new MutationObserver(() => {
  const url = location.href;
  if (url !== lastUrl) {
    lastUrl = url;
    ipcRenderer.sendToHost('sentinel-navigation', {
      from: lastUrl,
      to: url,
      timestamp: Date.now()
    });
  }
}).observe(document, { subtree: true, childList: true });

console.log('[Sentinel Webview] Event listeners installed');
