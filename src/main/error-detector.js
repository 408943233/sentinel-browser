const log = require('electron-log');

/**
 * 错误/异常探测器
 * 捕获JavaScript错误、Promise异常、UI错误等
 */
class ErrorDetector {
  constructor() {
    this.errors = [];
    this.uiErrors = [];
    this.maxErrors = 1000; // 最大错误数量限制
  }

  /**
   * 生成错误监控脚本
   */
  generateMonitoringScript() {
    return `
      (function() {
        'use strict';
        
        const errors = [];
        const maxErrors = 100;
        
        function sendError(errorData) {
          if (window.sentinelAPI && window.sentinelAPI.reportError) {
            window.sentinelAPI.reportError(errorData);
          }
          
          if (errors.length < maxErrors) {
            errors.push(errorData);
          }
        }
        
        // 捕获全局错误
        window.addEventListener('error', function(event) {
          sendError({
            type: 'javascript',
            message: event.message,
            filename: event.filename,
            lineno: event.lineno,
            colno: event.colno,
            stack: event.error ? event.error.stack : null,
            timestamp: Date.now()
          });
        });
        
        // 捕获未处理的Promise拒绝
        window.addEventListener('unhandledrejection', function(event) {
          sendError({
            type: 'promise',
            message: event.reason ? event.reason.toString() : 'Unhandled rejection',
            stack: event.reason && event.reason.stack ? event.reason.stack : null,
            timestamp: Date.now()
          });
        });
        
        // 捕获控制台错误
        const originalConsoleError = console.error;
        console.error = function(...args) {
          sendError({
            type: 'console',
            message: args.map(arg => {
              if (arg instanceof Error) {
                return arg.message + '\\n' + arg.stack;
              }
              return String(arg);
            }).join(' '),
            timestamp: Date.now()
          });
          
          return originalConsoleError.apply(this, args);
        };
        
        // 使用MutationObserver监控UI错误
        const observer = new MutationObserver(function(mutations) {
          mutations.forEach(function(mutation) {
            // 监控Toast消息
            const toastSelectors = [
              '.el-message', '.ant-message', '.toast', 
              '[role="alert"]', '.notification', '.snackbar'
            ];
            
            toastSelectors.forEach(selector => {
              const elements = document.querySelectorAll(selector);
              elements.forEach(el => {
                if (el.textContent && !el._sentinelReported) {
                  el._sentinelReported = true;
                  
                  const isError = el.classList.contains('error') || 
                                  el.classList.contains('danger') ||
                                  el.classList.contains('el-message--error');
                  
                  sendError({
                    type: 'ui_toast',
                    content: el.textContent,
                    className: el.className,
                    isError: isError,
                    timestamp: Date.now()
                  });
                }
              });
            });
            
            // 监控表单验证错误
            const errorElements = document.querySelectorAll(
              '.error, .is-error, .has-error, .invalid, [aria-invalid="true"]'
            );
            
            errorElements.forEach(el => {
              if (!el._sentinelErrorReported) {
                el._sentinelErrorReported = true;
                
                const errorText = el.textContent || 
                                  el.getAttribute('data-error') || 
                                  el.title ||
                                  'Validation error';
                
                sendError({
                  type: 'ui_validation',
                  element: el.tagName,
                  className: el.className,
                  message: errorText,
                  timestamp: Date.now()
                });
              }
            });
            
            // 监控红色文本（可能的错误提示）
            const redTextElements = document.querySelectorAll('*');
            redTextElements.forEach(el => {
              const style = window.getComputedStyle(el);
              const color = style.color;
              
              if (color.includes('rgb(255, 0, 0)') || 
                  color.includes('rgb(220, 53, 69)') ||
                  color.includes('rgb(244, 67, 54)') ||
                  color.includes('#f56c6c') ||
                  color.includes('#ff4d4f')) {
                
                if (!el._sentinelRedReported && el.textContent.trim()) {
                  el._sentinelRedReported = true;
                  
                  sendError({
                    type: 'ui_red_text',
                    content: el.textContent.trim(),
                    color: color,
                    timestamp: Date.now()
                  });
                }
              }
            });
          });
        });
        
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'style', 'aria-invalid']
        });
        
        // 监控网络错误
        const originalFetch = window.fetch;
        window.fetch = async function(...args) {
          try {
            const response = await originalFetch.apply(this, args);
            
            if (!response.ok) {
              sendError({
                type: 'network',
                url: args[0],
                method: args[1] && args[1].method ? args[1].method : 'GET',
                status: response.status,
                statusText: response.statusText,
                timestamp: Date.now()
              });
            }
            
            return response;
          } catch (error) {
            sendError({
              type: 'network',
              url: args[0],
              method: args[1] && args[1].method ? args[1].method : 'GET',
              error: error.message,
              timestamp: Date.now()
            });
            
            throw error;
          }
        };
        
        // 监控XMLHttpRequest错误
        const originalXHR = window.XMLHttpRequest;
        window.XMLHttpRequest = function() {
          const xhr = new originalXHR();
          
          xhr.addEventListener('error', function() {
            sendError({
              type: 'network',
              url: xhr.responseURL,
              method: xhr._method || 'GET',
              error: 'Network error',
              timestamp: Date.now()
            });
          });
          
          xhr.addEventListener('load', function() {
            if (xhr.status >= 400) {
              sendError({
                type: 'network',
                url: xhr.responseURL,
                method: xhr._method || 'GET',
                status: xhr.status,
                statusText: xhr.statusText,
                timestamp: Date.now()
              });
            }
          });
          
          const originalOpen = xhr.open;
          xhr.open = function(method, url, ...args) {
            xhr._method = method;
            xhr._url = url;
            return originalOpen.call(this, method, url, ...args);
          };
          
          return xhr;
        };
        
        console.log('[Sentinel] Error monitoring initialized');
      })();
    `;
  }

  /**
   * 注入错误监控脚本到webContents
   */
  async injectMonitoring(webContents) {
    try {
      const script = this.generateMonitoringScript();
      await webContents.executeJavaScript(script);
      log.info('Error monitoring injected');
      return true;
    } catch (error) {
      log.error('Failed to inject error monitoring:', error);
      return false;
    }
  }

  /**
   * 添加错误记录
   */
  addError(errorData) {
    if (this.errors.length >= this.maxErrors) {
      this.errors.shift(); // 移除最旧的错误
    }
    
    this.errors.push({
      ...errorData,
      id: this.generateErrorId()
    });
    
    log.warn('Error detected:', errorData);
  }

  /**
   * 添加UI错误记录
   */
  addUIError(errorData) {
    if (this.uiErrors.length >= this.maxErrors) {
      this.uiErrors.shift();
    }
    
    this.uiErrors.push({
      ...errorData,
      id: this.generateErrorId()
    });
  }

  /**
   * 生成错误ID
   */
  generateErrorId() {
    return 'err_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  /**
   * 获取所有错误
   */
  getErrors() {
    return [...this.errors];
  }

  /**
   * 获取UI错误
   */
  getUIErrors() {
    return [...this.uiErrors];
  }

  /**
   * 获取错误统计
   */
  getErrorStats() {
    const stats = {
      total: this.errors.length,
      byType: {},
      recent: this.errors.slice(-10)
    };
    
    this.errors.forEach(error => {
      const type = error.type || 'unknown';
      stats.byType[type] = (stats.byType[type] || 0) + 1;
    });
    
    return stats;
  }

  /**
   * 清除错误记录
   */
  clearErrors() {
    this.errors = [];
    this.uiErrors = [];
    log.info('Error records cleared');
  }

  /**
   * 检查是否有严重错误
   */
  hasCriticalErrors() {
    return this.errors.some(error => 
      error.type === 'javascript' || 
      error.type === 'promise' ||
      (error.type === 'network' && error.status >= 500)
    );
  }

  /**
   * 导出错误报告
   */
  exportErrors() {
    return {
      timestamp: Date.now(),
      summary: this.getErrorStats(),
      errors: this.errors,
      uiErrors: this.uiErrors
    };
  }
}

module.exports = ErrorDetector;
