/**
 * ============================================================================
 * Service Worker 拦截器 (ServiceWorkerInterceptor)
 * ============================================================================
 * 
 * 【核心职责】
 * 注册 Service Worker 拦截所有网络请求
 * 作为 Preload 层拦截的补充方案，确保 100% 请求捕获
 * 
 * 【技术背景】
 * Service Worker 是浏览器提供的特殊脚本，可以：
 * 1. 拦截和处理网络请求
 * 2. 在页面和浏览器之间充当代理
 * 3. 即使页面关闭也能运行
 * 4. 可以访问 fetch API 拦截所有请求
 * 
 * 【使用场景】
 * 1. 跨域 iframe 无法通过 Preload 注入
 * 2. 某些请求可能绕过 Preload 拦截
 * 3. 作为冗余方案提高可靠性
 * 
 * 【实现原理】
 * 1. 创建内联 Service Worker 代码（Blob URL）
 * 2. 注册 Service Worker 到当前页面
 * 3. Service Worker 拦截所有 fetch 请求
 * 4. 将请求信息发送到主页面
 * 5. 主页面转发到主进程
 * 
 * 【限制】
 * - 需要 HTTPS 或 localhost 环境
 * - 首次注册后需要刷新页面才能生效
 * - 某些浏览器可能不支持 Service Worker
 * ============================================================================
 */

class ServiceWorkerInterceptor {
  /**
   * 构造函数
   * @param {Object} ipcRenderer - Electron 的 ipcRenderer 实例
   */
  constructor(ipcRenderer) {
    // ==================== 核心依赖 ====================
    this.ipcRenderer = ipcRenderer;
    
    // ==================== 状态管理 ====================
    this.swRegistration = null;  // Service Worker 注册对象
    this.isRegistered = false;   // 是否已注册
    
    // ==================== 初始化 ====================
    this.init();
  }
  
  /**
   * ==========================================================================
   * 初始化
   * ==========================================================================
   * 【功能】
   * 检查浏览器支持并注册 Service Worker
   * 
   * 【流程】
   * 1. 检查浏览器是否支持 Service Worker
   * 2. 调用 register() 方法注册
   * 3. 捕获并记录错误
   * ==========================================================================
   */
  async init() {
    // 检查浏览器是否支持 Service Worker
    if (!('serviceWorker' in navigator)) {
      console.log('[ServiceWorkerInterceptor] Service Worker not supported');
      return;
    }
    
    try {
      await this.register();
    } catch (error) {
      console.error('[ServiceWorkerInterceptor] Failed to initialize:', error);
    }
  }
  
  /**
   * ==========================================================================
   * 注册 Service Worker
   * ==========================================================================
   * 【功能】
   * 创建并注册 Service Worker
   * 
   * 【实现说明】
   * 1. 生成 Service Worker 代码
   * 2. 创建 Blob URL
   * 3. 调用 navigator.serviceWorker.register()
   * 4. 设置消息监听器
   * 5. 通知主进程注册成功
   * 
   * 【注意】
   * 使用 Blob URL 而不是外部文件，避免文件路径问题
   * ==========================================================================
   */
  async register() {
    // 生成 Service Worker 代码
    const swCode = this.generateServiceWorkerCode();
    
    // 创建 Blob URL
    const swBlob = new Blob([swCode], { type: 'application/javascript' });
    const swUrl = URL.createObjectURL(swBlob);
    
    try {
      // 注册 Service Worker
      this.swRegistration = await navigator.serviceWorker.register(swUrl, {
        scope: '/'  // 作用域为根路径，拦截所有请求
      });
      
      this.isRegistered = true;
      console.log('[ServiceWorkerInterceptor] Service Worker registered:', swUrl);
      
      // 监听 Service Worker 消息
      navigator.serviceWorker.addEventListener('message', (event) => {
        this.handleSWMessage(event.data);
      });
      
      // 通知主进程
      this.ipcRenderer.sendToHost('sentinel-sw-registered', {
        scope: '/',
        timestamp: Date.now()
      });
      
    } catch (error) {
      console.error('[ServiceWorkerInterceptor] Registration failed:', error);
      throw error;
    }
  }
  
  /**
   * ==========================================================================
   * 生成 Service Worker 代码
   * ==========================================================================
   * 【功能】
   * 生成内联 Service Worker 代码字符串
   * 
   * 【Service Worker 功能】
   * 1. install 事件：安装时跳过等待，立即激活
   * 2. activate 事件：激活后控制所有客户端
   * 3. fetch 事件：拦截所有网络请求，记录并转发
   * 4. message 事件：接收主页面发送的上下文
   * 
   * 【返回】
   * @returns {string} Service Worker 代码字符串
   * ==========================================================================
   */
  generateServiceWorkerCode() {
    return `
      // Service Worker 拦截器
      // 拦截所有网络请求并发送到主页面
      
      // 存储当前事件上下文（从主页面接收）
      self.currentEventContext = null;
      
      // 安装事件
      self.addEventListener('install', (event) => {
        console.log('[SW] Installed');
        // skipWaiting 立即激活，不等待旧版本
        self.skipWaiting();
      });
      
      // 激活事件
      self.addEventListener('activate', (event) => {
        console.log('[SW] Activated');
        // claim 控制所有客户端
        event.waitUntil(self.clients.claim());
      });
      
      // 拦截所有 fetch 请求
      self.addEventListener('fetch', (event) => {
        const request = event.request;
        
        // 创建请求记录
        const requestRecord = {
          type: 'fetch',
          url: request.url,
          method: request.method,
          headers: Array.from(request.headers.entries()),
          timestamp: Date.now(),
          // 如果有事件上下文，一并发送
          eventContext: self.currentEventContext
        };
        
        // 发送到所有客户端（主页面）
        event.waitUntil(
          self.clients.matchAll().then(clients => {
            clients.forEach(client => {
              client.postMessage({
                type: 'sentinel-sw-request',
                data: requestRecord
              });
            });
          })
        );
        
        // 继续请求（不拦截响应，只记录）
        // 使用 event.respondWith 可以修改响应，这里只是记录
        event.respondWith(fetch(request));
      });
      
      // 监听消息（从主页面）
      self.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'sentinel-event-context') {
          // 存储当前事件上下文
          self.currentEventContext = event.data.context;
          console.log('[SW] Event context received:', event.data.context);
        }
      });
    `;
  }
  
  /**
   * ==========================================================================
   * 处理 Service Worker 消息
   * ==========================================================================
   * 【功能】
   * 处理从 Service Worker 发送的消息
   * 
   * 【消息类型】
   * - sentinel-sw-request: 网络请求记录
   * 
   * 【处理流程】
   * 1. 验证消息类型
   * 2. 转发到主进程
   * 3. 添加时间戳和来源信息
   * 
   * @param {Object} data - Service Worker 发送的消息数据
   * ==========================================================================
   */
  handleSWMessage(data) {
    // 验证消息类型
    if (!data || data.type !== 'sentinel-sw-request') return;
    
    // 转发到主进程
    this.ipcRenderer.sendToHost('sentinel-sw-request', {
      ...data.data,
      source: 'service-worker',  // 标记来源
      timestamp: Date.now()
    });
  }
  
  /**
   * ==========================================================================
   * 发送事件上下文到 Service Worker
   * ==========================================================================
   * 【功能】
   * 将当前事件上下文发送到 Service Worker
   * 
   * 【使用场景】
   * 当用户操作发生时，将 eventId 发送到 Service Worker
   * Service Worker 可以在拦截请求时携带这个上下文
   * 
   * 【实现说明】
   * 使用 postMessage 向 Service Worker 发送消息
   * 
   * @param {Object} context - 事件上下文对象
   * ==========================================================================
   */
  sendEventContext(context) {
    // 检查是否已注册且有控制器
    if (!this.isRegistered || !navigator.serviceWorker.controller) {
      return;
    }
    
    // 发送消息到 Service Worker
    navigator.serviceWorker.controller.postMessage({
      type: 'sentinel-event-context',
      context: context
    });
  }
  
  /**
   * ==========================================================================
   * 注销 Service Worker
   * ==========================================================================
   * 【功能】
   * 注销已注册的 Service Worker
   * 
   * 【使用场景】
   * 录制结束时清理资源
   * 
   * 【实现说明】
   * 调用 ServiceWorkerRegistration.unregister()
   * ==========================================================================
   */
  async unregister() {
    if (!this.swRegistration) return;
    
    try {
      await this.swRegistration.unregister();
      this.isRegistered = false;
      console.log('[ServiceWorkerInterceptor] Service Worker unregistered');
    } catch (error) {
      console.error('[ServiceWorkerInterceptor] Failed to unregister:', error);
    }
  }
}

module.exports = ServiceWorkerInterceptor;
