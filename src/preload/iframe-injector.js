/**
 * ============================================================================
 * iframe 注入器 (IframeInjector)
 * ============================================================================
 * 
 * 【核心职责】
 * 自动为所有 iframe 注入 preload 脚本，确保拦截覆盖率
 * 解决 iframe 中的事件无法被父页面拦截的问题
 * 
 * 【技术挑战】
 * 1. iframe 有独立的 JavaScript 执行环境
 * 2. 跨域 iframe 无法访问 contentWindow
 * 3. 动态创建的 iframe 需要实时拦截
 * 4. 嵌套 iframe（iframe 中的 iframe）需要递归处理
 * 
 * 【解决方案】
 * 1. 拦截 document.createElement，在 iframe 创建时注入
 * 2. 拦截 appendChild/insertBefore，捕获已添加到 DOM 的 iframe
 * 3. 监听 src 属性变化，在加载新页面时重新注入
 * 4. 使用 WeakSet 避免重复注入
 * 
 * 【拦截点】
 * - document.createElement: 拦截 iframe 元素创建
 * - Element.prototype.appendChild: 拦截 iframe 添加到 DOM
 * - Element.prototype.insertBefore: 拦截 iframe 插入到 DOM
 * - MutationObserver: 监听 src 属性变化
 * 
 * 【限制】
 * - 跨域 iframe 无法注入（浏览器安全限制）
 * - 需要配合 Service Worker 作为补充方案
 * ============================================================================
 */

const path = require('path');

class IframeInjector {
  /**
   * 构造函数
   * @param {Object} ipcRenderer - Electron 的 ipcRenderer 实例
   * @param {string} preloadPath - preload 脚本的绝对路径
   */
  constructor(ipcRenderer, preloadPath) {
    // ==================== 核心依赖 ====================
    this.ipcRenderer = ipcRenderer;
    this.preloadPath = preloadPath;
    
    // ==================== 状态管理 ====================
    // 使用 WeakSet 存储已注入的 iframe
    // WeakSet 不会阻止垃圾回收，当 iframe 被移除时自动释放
    this.injectedIframes = new WeakSet();
    
    // ==================== 初始化拦截器 ====================
    this.initIframeIntercept();
    
    console.log('[IframeInjector] Initialized');
  }
  
  /**
   * ==========================================================================
   * 初始化 iframe 拦截
   * ==========================================================================
   * 【功能】
   * 拦截所有可能创建或添加 iframe 的 API
   * 
   * 【拦截点】
   * 1. document.createElement - 创建 iframe 元素
   * 2. Element.prototype.appendChild - 添加 iframe 到 DOM
   * 3. Element.prototype.insertBefore - 插入 iframe 到 DOM
   * 4. 处理已存在的 iframe
   * ==========================================================================
   */
  initIframeIntercept() {
    const self = this;
    
    /**
     * 拦截 document.createElement
     * 在 iframe 元素创建时设置监听器
     */
    const originalCreateElement = document.createElement;
    document.createElement = function(tagName, options) {
      const element = originalCreateElement.call(this, tagName, options);
      
      // 检查是否是 iframe 元素
      if (tagName.toLowerCase() === 'iframe') {
        console.log('[IframeInjector] iframe created, preparing injection');
        
        // 使用 MutationObserver 监听 src 属性变化
        // 因为 iframe 可能在创建后才设置 src
        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            if (mutation.attributeName === 'src') {
              console.log('[IframeInjector] iframe src changed:', element.src);
              self.injectPreload(element);
            }
          }
        });
        
        observer.observe(element, { attributes: true });
        
        // 如果已经有 src，立即注入
        if (element.src) {
          self.injectPreload(element);
        }
      }
      
      return element;
    };
    
    /**
     * 拦截 Element.prototype.appendChild
     * 捕获已添加到 DOM 的 iframe
     */
    const originalAppendChild = Element.prototype.appendChild;
    Element.prototype.appendChild = function(child) {
      const result = originalAppendChild.call(this, child);
      
      if (child.tagName && child.tagName.toLowerCase() === 'iframe') {
        console.log('[IframeInjector] iframe appended to DOM');
        self.injectPreload(child);
      }
      
      return result;
    };
    
    /**
     * 拦截 Element.prototype.insertBefore
     * 捕获插入到 DOM 的 iframe
     */
    const originalInsertBefore = Element.prototype.insertBefore;
    Element.prototype.insertBefore = function(newChild, refChild) {
      const result = originalInsertBefore.call(this, newChild, refChild);
      
      if (newChild.tagName && newChild.tagName.toLowerCase() === 'iframe') {
        console.log('[IframeInjector] iframe inserted into DOM');
        self.injectPreload(newChild);
      }
      
      return result;
    };
    
    /**
     * 处理已存在的 iframe
     * 页面加载时可能已经有 iframe 存在
     */
    document.querySelectorAll('iframe').forEach(iframe => {
      console.log('[IframeInjector] Found existing iframe');
      self.injectPreload(iframe);
    });
    
    console.log('[IframeInjector] iframe intercept initialized');
  }
  
  /**
   * ==========================================================================
   * 注入 preload 脚本到 iframe
   * ==========================================================================
   * 【功能】
   * 向 iframe 注入 preload 脚本，使其具有与父页面相同的拦截能力
   * 
   * 【实现说明】
   * 1. 检查 iframe 是否已注入（使用 WeakSet）
   * 2. 获取 iframe 的 contentWindow 和 contentDocument
   * 3. 创建 script 元素并设置 src 为 preload 脚本路径
   * 4. 将 script 添加到 iframe 的 head 中
   * 5. 通知主进程注入成功
   * 
   * 【错误处理】
   * - 跨域 iframe 无法访问 contentWindow，会抛出异常
   * - 捕获异常并记录，不影响其他功能
   * 
   * @param {HTMLIFrameElement} iframe - 要注入的 iframe 元素
   * ==========================================================================
   */
  injectPreload(iframe) {
    // 检查是否已注入
    if (this.injectedIframes.has(iframe)) {
      return; // 已注入，跳过
    }
    
    try {
      // 定义注入函数
      const doInject = () => {
        try {
          // 获取 iframe 的 window 和 document
          const iframeWindow = iframe.contentWindow;
          const iframeDoc = iframe.contentDocument;
          
          // 检查是否可访问（跨域检查）
          if (!iframeWindow || !iframeDoc) {
            console.warn('[IframeInjector] iframe content not accessible (cross-origin)');
            return;
          }
          
          // 标记为已注入
          this.injectedIframes.add(iframe);
          
          // 创建 script 元素
          const script = iframeDoc.createElement('script');
          // 使用 file:// 协议加载本地脚本
          script.src = `file://${this.preloadPath}`;
          
          // 添加到 iframe 的 head 中
          iframeDoc.head.appendChild(script);
          
          console.log('[IframeInjector] Preload injected into iframe:', iframe.src);
          
          // 通知主进程
          this.ipcRenderer.sendToHost('sentinel-iframe-injected', {
            src: iframe.src,
            timestamp: Date.now()
          });
        } catch (e) {
          console.error('[IframeInjector] Failed to inject:', e.message);
        }
      };
      
      // 如果 iframe 已经加载完成，立即注入
      if (iframe.contentDocument && iframe.contentDocument.readyState === 'complete') {
        doInject();
      } else {
        // 等待 iframe 加载完成
        iframe.addEventListener('load', doInject);
      }
    } catch (e) {
      // 跨域 iframe 无法访问
      console.error('[IframeInjector] Cross-origin iframe, cannot inject:', e.message);
    }
  }
  
  /**
   * ==========================================================================
   * 递归注入所有 iframe
   * ==========================================================================
   * 【功能】
   * 递归处理所有 iframe，包括嵌套的 iframe
   * 
   * 【使用场景】
   * 页面加载完成后，手动触发一次完整的注入
   * 处理那些可能通过其他方式创建的 iframe
   * 
   * 【实现说明】
   * 递归遍历所有 iframe 的 contentWindow
   * 对每个 iframe 注入 preload 脚本
   * ==========================================================================
   */
  injectAllIframes() {
    const injectRecursive = (win) => {
      try {
        // 注入当前 window（如果不是主窗口）
        if (win !== window) {
          const script = win.document.createElement('script');
          script.src = `file://${this.preloadPath}`;
          win.document.head.appendChild(script);
        }
        
        // 递归处理子 iframe
        const iframes = win.document.querySelectorAll('iframe');
        for (const iframe of iframes) {
          try {
            if (iframe.contentWindow) {
              injectRecursive(iframe.contentWindow);
            }
          } catch (e) {
            // 跨域 iframe，无法访问
            console.warn('[IframeInjector] Cannot access nested iframe (cross-origin)');
          }
        }
      } catch (e) {
        console.error('[IframeInjector] Failed to inject recursively:', e.message);
      }
    };
    
    // 从主窗口开始递归
    injectRecursive(window);
  }
}

module.exports = IframeInjector;
