/**
 * ============================================================================
 * 异步上下文追踪器 (AsyncContextTracker)
 * ============================================================================
 * 
 * 【核心职责】
 * 1. 追踪异步调用链，确保 eventId 在异步操作中正确传递
 * 2. 解决 setTimeout/Promise/async-await 中的上下文丢失问题
 * 3. 支持嵌套事件场景（一个操作触发多个异步子操作）
 * 
 * 【技术挑战】
 * JavaScript 的异步操作会导致执行上下文切换，传统的全局变量方式
 * 无法在异步回调中保持正确的 eventId。例如：
 * - 用户点击按钮 -> 设置 currentEventId = "evt_123"
 * - 调用 fetch() 发起请求
 * - 在 Promise.then() 中 currentEventId 可能已经变成 "evt_456"
 * - 导致请求关联到错误的事件
 * 
 * 【解决方案】
 * 使用栈结构管理上下文，拦截所有异步 API，在回调执行前恢复上下文
 * 
 * 【拦截的异步 API】
 * 1. setTimeout / setInterval
 * 2. Promise (构造函数、then/catch/finally)
 * 3. requestAnimationFrame
 * 4. MutationObserver
 * 5. addEventListener
 * 
 * 【数据结构】
 * - contextStack: 上下文栈，支持嵌套事件
 * - contextMap: 上下文映射，用于快速查找
 * ============================================================================
 */

// 简单的日志函数
function createLogger(module) {
  return {
    debug: (msg, meta = {}) => console.log(`[${module}] [DEBUG] ${msg}`, meta),
    info: (msg, meta = {}) => console.log(`[${module}] [INFO] ${msg}`, meta),
    warn: (msg, meta = {}) => console.warn(`[${module}] [WARN] ${msg}`, meta),
    error: (msg, meta = {}) => console.error(`[${module}] [ERROR] ${msg}`, meta)
  };
}

const contextLog = createLogger('AsyncContextTracker');

class AsyncContextTracker {
  /**
   * 构造函数
   * 初始化数据结构和拦截器
   */
  constructor() {
    // ==================== 核心数据结构 ====================
    
    /**
     * 上下文栈（使用数组模拟栈）
     * 栈顶是当前活动的上下文
     * 支持嵌套事件：用户操作A触发异步操作B，B又触发C
     */
    this.contextStack = [];
    
    /**
     * 上下文映射表
     * key: contextId, value: context 对象
     * 用于快速查找和清理
     */
    this.contextMap = new Map();
    
    /**
     * 上下文ID计数器
     * 用于生成唯一的 contextId
     */
    this.contextId = 0;
    
    /**
     * 当前上下文
     * 用于在异步回调中恢复上下文
     */
    this.currentContext = null;
    
    // ==================== 初始化所有拦截器 ====================
    this.initTimeoutIntercept();              // 拦截 setTimeout
    this.initIntervalIntercept();             // 拦截 setInterval
    this.initPromiseIntercept();              // 拦截 Promise
    this.initRequestAnimationFrameIntercept(); // 拦截 requestAnimationFrame
    this.initMutationObserverIntercept();      // 拦截 MutationObserver
    this.initEventListenerIntercept();         // 拦截 addEventListener
    
    contextLog.info('Initialized with stack', {
      interceptors: ['setTimeout', 'setInterval', 'Promise', 'requestAnimationFrame', 'MutationObserver', 'addEventListener'],
      contextStackSize: this.contextStack.length,
      contextMapSize: this.contextMap.size
    });
  }
  
  /**
   * ==========================================================================
   * 上下文管理 - 创建上下文
   * ==========================================================================
   * 【功能】
   * 创建新的上下文并压入栈顶
   * 
   * 【使用场景】
   * 当用户操作发生时（如点击按钮），调用此方法创建新的因果链上下文
   * 
   * @param {string} eventId - 事件唯一ID
   * @param {string} eventType - 事件类型（如 'click', 'keydown'）
   * @param {Object} metadata - 额外的元数据
   * @returns {Object} 创建的上下文对象
   * ==========================================================================
   */
  createContext(eventId, eventType, metadata = {}) {
    const contextId = ++this.contextId;
    const context = {
      id: contextId,              // 上下文唯一ID
      eventId: eventId,           // 关联的事件ID
      eventType: eventType,       // 事件类型
      createdAt: Date.now(),      // 创建时间戳
      metadata: metadata,         // 元数据
      asyncOperations: new Set()  // 异步操作集合（用于追踪未完成的异步操作）
    };
    
    // 存入映射表
    this.contextMap.set(contextId, context);
    
    // 压入栈顶
    this.contextStack.push(context);
    
    // 更新当前上下文
    this.currentContext = context;
    
    contextLog.info('Context created and pushed', {
      contextId,
      eventId,
      eventType,
      stackSize: this.contextStack.length,
      contextMapSize: this.contextMap.size
    });
    
    return context;
  }
  
  /**
   * ==========================================================================
   * 上下文管理 - 获取当前上下文
   * ==========================================================================
   * 【功能】
   * 获取栈顶的上下文（当前活动的上下文）
   * 
   * @returns {Object|null} 当前上下文对象，如果栈为空则返回 null
   * ==========================================================================
   */
  getCurrentContext() {
    return this.contextStack.length > 0 ? this.contextStack[this.contextStack.length - 1] : null;
  }
  
  /**
   * ==========================================================================
   * 上下文管理 - 获取当前事件ID
   * ==========================================================================
   * 【功能】
   * 获取当前上下文中的 eventId
   * 
   * 【使用场景】
   * 所有拦截器通过此方法获取当前 eventId 进行关联
   * 
   * @returns {string|null} 当前事件ID，如果没有上下文则返回 null
   * ==========================================================================
   */
  getCurrentEventId() {
    const current = this.getCurrentContext();
    return current ? current.eventId : null;
  }
  
  /**
   * ==========================================================================
   * 上下文管理 - 设置当前上下文
   * ==========================================================================
   * 【功能】
   * 将指定上下文压入栈顶
   * 
   * 【使用场景】
   * 在异步回调执行前，恢复之前的上下文
   * 
   * @param {Object} context - 要设置的上下文对象
   * ==========================================================================
   */
  setCurrentContext(context) {
    if (context) {
      this.contextStack.push(context);
    }
  }
  
  /**
   * ==========================================================================
   * 上下文管理 - 清除当前上下文
   * ==========================================================================
   * 【功能】
   * 弹出栈顶的上下文
   * 
   * 【使用场景】
   * 当用户操作完成时，清除对应的上下文
   * 
   * 【内存管理】
   * 1分钟后从 contextMap 中删除，防止内存泄漏
   * ==========================================================================
   */
  clearCurrentContext() {
    if (this.contextStack.length > 0) {
      const context = this.contextStack.pop();  // 弹出栈顶
      
      // 更新当前上下文为新的栈顶
      this.currentContext = this.contextStack.length > 0 ? this.contextStack[this.contextStack.length - 1] : null;
      
      console.log('[AsyncContextTracker] Context popped:', context.id, 'stack size:', this.contextStack.length);
      
      // 延迟清理 Map 中的上下文（防止还有异步操作在引用）
      setTimeout(() => {
        this.contextMap.delete(context.id);
      }, 60000);  // 1分钟后清理
    }
  }
  
  /**
   * ==========================================================================
   * 回调包装 - 保留上下文
   * ==========================================================================
   * 【功能】
   * 包装回调函数，在执行时自动恢复上下文
   * 
   * 【原理】
   * 闭包捕获当前上下文，在回调执行前设置，执行后恢复
   * 
   * @param {Function} callback - 原始回调函数
   * @param {Object} context - 要保留的上下文
   * @returns {Function} 包装后的回调函数
   * ==========================================================================
   */
  wrapCallback(callback, context = this.currentContext) {
    if (!context) return callback;
    
    const self = this;
    return function(...args) {
      // 保存之前的上下文
      const prevContext = self.currentContext;
      
      // 恢复目标上下文
      self.currentContext = context;
      
      try {
        return callback.apply(this, args);
      } finally {
        // 恢复之前的上下文
        self.currentContext = prevContext;
      }
    };
  }
  
  /**
   * ==========================================================================
   * 异步 API 拦截器 - setTimeout
   * ==========================================================================
   * 【拦截目标】window.setTimeout
   * 【拦截内容】
   * - 捕获当前上下文
   * - 包装回调函数，在回调执行前恢复上下文
   * 
   * 【实现说明】
   * 使用闭包捕获当前上下文，在回调执行时恢复
   * ==========================================================================
   */
  initTimeoutIntercept() {
    const originalSetTimeout = window.setTimeout;
    const originalClearTimeout = window.clearTimeout;
    const self = this;
    
    window.setTimeout = function(callback, delay, ...args) {
      // 捕获当前上下文（创建闭包）
      const context = self.currentContext;
      
      // 包装回调
      const wrappedCallback = function() {
        // 保存之前的上下文
        const prevContext = self.currentContext;
        
        // 恢复目标上下文
        self.currentContext = context;
        
        try {
          if (typeof callback === 'string') {
            // 不推荐的方式，但为了兼容性
            eval(callback);
          } else {
            callback.apply(this, args);
          }
        } finally {
          // 恢复之前的上下文
          self.currentContext = prevContext;
        }
      };
      
      return originalSetTimeout.call(this, wrappedCallback, delay);
    };
    
    window.clearTimeout = function(id) {
      return originalClearTimeout.call(this, id);
    };
    
    console.log('[AsyncContextTracker] setTimeout intercepted');
  }
  
  /**
   * ==========================================================================
   * 异步 API 拦截器 - setInterval
   * ==========================================================================
   * 【拦截目标】window.setInterval
   * 【拦截内容】
   * - 捕获当前上下文
   * - 包装回调函数，在回调执行前恢复上下文
   * 
   * 【说明】
   * 与 setTimeout 类似，但会周期性执行
   * ==========================================================================
   */
  initIntervalIntercept() {
    const originalSetInterval = window.setInterval;
    const originalClearInterval = window.clearInterval;
    const self = this;
    
    window.setInterval = function(callback, delay, ...args) {
      // 捕获当前上下文
      const context = self.currentContext;
      
      // 包装回调
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
    
    window.clearInterval = function(id) {
      return originalClearInterval.call(this, id);
    };
    
    console.log('[AsyncContextTracker] setInterval intercepted');
  }
  
  /**
   * ==========================================================================
   * 异步 API 拦截器 - Promise
   * ==========================================================================
   * 【拦截目标】Promise 构造函数和原型方法
   * 【拦截内容】
   * - Promise 构造函数
   * - then / catch / finally 方法
   * 
   * 【实现说明】
   * 这是最关键的拦截器，因为现代 JavaScript 大量使用 Promise
   * 包括 async/await 也是基于 Promise 的语法糖
   * 
   * 【技术细节】
   * 1. 包装 Promise 构造函数，在 executor 中恢复上下文
   * 2. 包装 then/catch/finally，在回调中恢复上下文
   * 3. 确保 resolve/reject 回调也有正确的上下文
   * ==========================================================================
   */
  initPromiseIntercept() {
    const OriginalPromise = window.Promise;
    const self = this;
    
    // 包装 Promise 构造函数
    window.Promise = function(executor) {
      // 捕获当前上下文
      const context = self.currentContext;
      
      // 包装 executor
      const wrappedExecutor = function(resolve, reject) {
        const prevContext = self.currentContext;
        self.currentContext = context;
        
        try {
          executor(
            function(value) {
              self.currentContext = context;
              try {
                resolve(value);
              } finally {
                self.currentContext = prevContext;
              }
            },
            function(reason) {
              self.currentContext = context;
              try {
                reject(reason);
              } finally {
                self.currentContext = prevContext;
              }
            }
          );
        } finally {
          self.currentContext = prevContext;
        }
      };
      
      return new OriginalPromise(wrappedExecutor);
    };
    
    // 复制静态方法
    window.Promise.resolve = OriginalPromise.resolve;
    window.Promise.reject = OriginalPromise.reject;
    window.Promise.all = OriginalPromise.all;
    window.Promise.race = OriginalPromise.race;
    window.Promise.allSettled = OriginalPromise.allSettled;
    
    // 包装 then 方法
    const originalThen = OriginalPromise.prototype.then;
    OriginalPromise.prototype.then = function(onFulfilled, onRejected) {
      const context = self.currentContext;
      
      // 包装 onFulfilled 回调
      const wrappedOnFulfilled = onFulfilled ? function(value) {
        const prevContext = self.currentContext;
        self.currentContext = context;
        try {
          return onFulfilled(value);
        } finally {
          self.currentContext = prevContext;
        }
      } : undefined;
      
      // 包装 onRejected 回调
      const wrappedOnRejected = onRejected ? function(reason) {
        const prevContext = self.currentContext;
        self.currentContext = context;
        try {
          return onRejected(reason);
        } finally {
          self.currentContext = prevContext;
        }
      } : undefined;
      
      return originalThen.call(this, wrappedOnFulfilled, wrappedOnRejected);
    };
    
    // 包装 catch 方法（复用 then）
    OriginalPromise.prototype.catch = function(onRejected) {
      return this.then(undefined, onRejected);
    };
    
    // 包装 finally 方法
    const originalFinally = OriginalPromise.prototype.finally;
    OriginalPromise.prototype.finally = function(onFinally) {
      const context = self.currentContext;
      
      const wrappedOnFinally = function() {
        const prevContext = self.currentContext;
        self.currentContext = context;
        try {
          return onFinally();
        } finally {
          self.currentContext = prevContext;
        }
      };
      
      return originalFinally.call(this, wrappedOnFinally);
    };
    
    console.log('[AsyncContextTracker] Promise intercepted');
  }
  
  /**
   * ==========================================================================
   * 异步 API 拦截器 - requestAnimationFrame
   * ==========================================================================
   * 【拦截目标】window.requestAnimationFrame
   * 【拦截内容】
   * - 捕获当前上下文
   * - 包装回调函数，在回调执行前恢复上下文
   * 
   * 【使用场景】
   * 动画相关的代码经常使用 requestAnimationFrame
   * ==========================================================================
   */
  initRequestAnimationFrameIntercept() {
    const originalRAF = window.requestAnimationFrame;
    const originalCancelRAF = window.cancelAnimationFrame;
    const self = this;
    
    window.requestAnimationFrame = function(callback) {
      // 捕获当前上下文
      const context = self.currentContext;
      
      // 包装回调
      const wrappedCallback = function(timestamp) {
        const prevContext = self.currentContext;
        self.currentContext = context;
        
        try {
          callback(timestamp);
        } finally {
          self.currentContext = prevContext;
        }
      };
      
      return originalRAF.call(this, wrappedCallback);
    };
    
    window.cancelAnimationFrame = function(id) {
      return originalCancelRAF.call(this, id);
    };
    
    console.log('[AsyncContextTracker] requestAnimationFrame intercepted');
  }
  
  /**
   * ==========================================================================
   * 异步 API 拦截器 - MutationObserver
   * ==========================================================================
   * 【拦截目标】window.MutationObserver
   * 【拦截内容】
   * - 包装回调函数，在回调执行前恢复上下文
   * 
   * 【使用场景】
   * DOM 变化观察器，常用于现代前端框架
   * ==========================================================================
   */
  initMutationObserverIntercept() {
    const OriginalMutationObserver = window.MutationObserver;
    const self = this;
    
    window.MutationObserver = function(callback) {
      // 捕获当前上下文
      const context = self.currentContext;
      
      // 包装回调
      const wrappedCallback = function(mutations, observer) {
        const prevContext = self.currentContext;
        self.currentContext = context;
        
        try {
          callback(mutations, observer);
        } finally {
          self.currentContext = prevContext;
        }
      };
      
      return new OriginalMutationObserver(wrappedCallback);
    };
    
    // 复制原型方法
    window.MutationObserver.prototype = OriginalMutationObserver.prototype;
    
    console.log('[AsyncContextTracker] MutationObserver intercepted');
  }
  
  /**
   * ==========================================================================
   * 异步 API 拦截器 - addEventListener
   * ==========================================================================
   * 【拦截目标】EventTarget.prototype.addEventListener
   * 【拦截内容】
   * - 包装事件处理函数，在回调执行前恢复上下文
   * 
   * 【实现说明】
   * 使用 WeakMap 存储原始回调和包装回调的映射关系
   * 确保 removeEventListener 能正确移除监听器
   * 
   * 【技术细节】
   * 1. 在 addEventListener 时捕获当前上下文
   * 2. 包装监听器，在回调执行前恢复上下文
   * 3. 存储原始回调和包装回调的映射
   * 4. 在 removeEventListener 时使用包装回调移除
   * ==========================================================================
   */
  initEventListenerIntercept() {
    const originalAddEventListener = EventTarget.prototype.addEventListener;
    const originalRemoveEventListener = EventTarget.prototype.removeEventListener;
    const self = this;
    
    // 存储原始回调和包装回调的映射
    // 使用 WeakMap 防止内存泄漏（当 DOM 元素被回收时，映射自动清除）
    const listenerMap = new WeakMap();
    
    EventTarget.prototype.addEventListener = function(type, listener, options) {
      if (!listener) return;
      
      // 捕获当前上下文
      const context = self.currentContext;
      
      // 包装监听器
      const wrappedListener = function(event) {
        const prevContext = self.currentContext;
        self.currentContext = context;
        
        try {
          listener.call(this, event);
        } finally {
          self.currentContext = prevContext;
        }
      };
      
      // 存储映射关系
      if (!listenerMap.has(listener)) {
        listenerMap.set(listener, new Map());
      }
      listenerMap.get(listener).set(type, wrappedListener);
      
      return originalAddEventListener.call(this, type, wrappedListener, options);
    };
    
    EventTarget.prototype.removeEventListener = function(type, listener, options) {
      if (!listener || !listenerMap.has(listener)) {
        return originalRemoveEventListener.call(this, type, listener, options);
      }
      
      // 获取包装后的监听器
      const wrappedListener = listenerMap.get(listener).get(type);
      if (wrappedListener) {
        return originalRemoveEventListener.call(this, type, wrappedListener, options);
      }
      
      return originalRemoveEventListener.call(this, type, listener, options);
    };
    
    console.log('[AsyncContextTracker] EventListener intercepted');
  }
  
  /**
   * ==========================================================================
   * 上下文清理
   * ==========================================================================
   * 【功能】
   * 清理过期的上下文
   * 
   * 【触发条件】
   * 当上下文的异步操作全部完成时，可以安全清理
   * 
   * @param {number} contextId - 要清理的上下文ID
   * ==========================================================================
   */
  cleanupContext(contextId) {
    const context = this.contextMap.get(contextId);
    if (context && context.asyncOperations.size === 0) {
      this.contextMap.delete(contextId);
      console.log('[AsyncContextTracker] Context cleaned up:', contextId);
    }
  }
  
  /**
   * ==========================================================================
   * 统计信息
   * ==========================================================================
   * 【功能】
   * 获取当前追踪器的统计信息
   * 
   * @returns {Object} 统计信息对象
   *   - activeContexts: 活动上下文数量
   *   - currentContext: 当前上下文ID
   * ==========================================================================
   */
  getStats() {
    return {
      activeContexts: this.contextMap.size,
      currentContext: this.currentContext ? this.currentContext.id : null
    };
  }
}

module.exports = AsyncContextTracker;
