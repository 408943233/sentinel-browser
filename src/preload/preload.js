const { contextBridge, ipcRenderer } = require('electron');

// Sentinel API - 暴露给渲染进程的安全接口
const api = {
  // 录制控制
  startRecording: (config) => ipcRenderer.invoke('start-recording', config),
  stopRecording: () => ipcRenderer.invoke('stop-recording'),
  pauseRecording: () => ipcRenderer.invoke('pause-recording'),
  resumeRecording: () => ipcRenderer.invoke('resume-recording'),

  // 任务管理
  getTasks: () => ipcRenderer.invoke('get-tasks'),
  exportTask: (taskId) => ipcRenderer.invoke('export-task', taskId),

  // 事件监听
  onRecordingStarted: (callback) => {
    ipcRenderer.on('recording-started', (event, data) => callback(data));
  },
  onRecordingStopped: (callback) => {
    ipcRenderer.on('recording-stopped', (event, data) => callback(data));
  },
  onCorrelationStarted: (callback) => {
    ipcRenderer.on('correlation-started', (event, data) => callback(data));
  },
  onCorrelationProgress: (callback) => {
    ipcRenderer.on('correlation-progress', (event, data) => callback(data));
  },

  // 监听创建新标签卡消息
  onCreateNewTab: (callback) => {
    ipcRenderer.on('create-new-tab', (event, url) => callback(url));
  },

  // 监听导出进度
  onExportProgress: (callback) => {
    ipcRenderer.on('export-progress', (event, data) => callback(data));
  },

  // 监听截图提取进度
  onSnapshotExtractionProgress: (callback) => {
    ipcRenderer.on('snapshot-extraction-progress', (event, data) => callback(data));
  },

  // 监听录制暂停/恢复状态
  onRecordingPaused: (callback) => {
    ipcRenderer.on('recording-paused', (event, data) => callback(data));
  },

  // 在文件夹中显示
  showInFolder: (taskId) => ipcRenderer.invoke('show-in-folder', taskId),
  
  // 获取 webview preload 路径（通过 IPC 从主进程获取）
  getWebviewPreloadPath: () => {
    return ipcRenderer.invoke('get-webview-preload-path');
  },

  // 错误报告
  reportError: (errorData) => {
    ipcRenderer.send('report-error', errorData);
  },

  // UI事件报告
  reportUIEvent: (eventData) => {
    ipcRenderer.send('report-ui-event', eventData);
  },

  // 用户活动报告
  reportActivity: () => {
    ipcRenderer.send('user-activity');
  },

  // Blob URL报告
  reportBlobURL: (blobData) => {
    ipcRenderer.send('blob-url-created', blobData);
  },

  // 文件上传报告
  reportFileUpload: (uploadData) => {
    ipcRenderer.send('file-upload', uploadData);
  },

  // 用户操作报告
  reportUserAction: (actionData) => {
    ipcRenderer.send('user-action', actionData);
  },

  // 页面加载开始报告（从 renderer.js 调用，比 preload 脚本更早）
  reportPageLoadStart: (loadData) => {
    ipcRenderer.send('page-load-start', loadData);
  },

  // DOM 快照保存
  saveDOMSnapshot: (snapshotData) => {
    ipcRenderer.send('dom-snapshot', snapshotData);
  },

  // 网络请求关联跟踪（已废弃，使用主进程 webRequest.onCompleted 替代）
  trackRequestAssociation: (requestData) => {
    console.log('[Sentinel Preload] trackRequestAssociation is deprecated');
  },

  // 日志发送（用于调试）
  sendLog: (level, message) => {
    ipcRenderer.send('renderer-log', { level, message, timestamp: Date.now() });
  },

  // 保存视频数据
  saveVideoData: (taskId, buffer) => {
    return ipcRenderer.invoke('save-video-data', taskId, buffer);
  },

  // 获取屏幕录制源（用于视频录制）
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),

  // 获取窗口列表（用于录制特定窗口）
  getWindowSources: () => ipcRenderer.invoke('get-window-sources'),

  // 获取当前窗口ID
  getCurrentWindowId: () => ipcRenderer.invoke('get-current-window-id'),

  // 修复：获取当前窗口尺寸
  getCurrentWindowBounds: () => ipcRenderer.invoke('get-current-window-bounds'),

  // 修复：聚焦当前窗口（避免被其他窗口遮挡）
  focusCurrentWindow: () => ipcRenderer.invoke('focus-current-window'),

  // 获取元素路径（支持 Shadow DOM）
  getElementPath: (params) => ipcRenderer.invoke('get-element-path', params),

  // 获取当前 webContents ID
  getWebContentsId: () => ipcRenderer.invoke('get-webcontents-id'),

  // 获取平台信息
  getPlatform: () => ipcRenderer.invoke('get-platform'),

  // 聚焦窗口（确保录制时窗口可见）
  focusWindow: () => ipcRenderer.invoke('focus-window'),

  // DOM操作
  getDOMSnapshot: () => {
    return {
      html: document.documentElement.outerHTML,
      url: window.location.href,
      title: document.title,
      timestamp: Date.now()
    };
  },

  // Shadow DOM遍历
  getShadowDOMTree: () => {
    return traverseShadowDOM(document.body);
  },

  // 状态捕获
  captureState: () => {
    return {
      localStorage: { ...localStorage },
      sessionStorage: { ...sessionStorage },
      cookies: document.cookie,
      url: window.location.href,
      timestamp: Date.now()
    };
  },

  // IndexedDB捕获
  captureIndexedDB: async () => {
    const databases = await window.indexedDB.databases();
    const result = {};

    for (const dbInfo of databases) {
      try {
        const db = await openDatabase(dbInfo.name);
        result[dbInfo.name] = await exportDatabase(db);
      } catch (err) {
        console.error(`Failed to export IndexedDB ${dbInfo.name}:`, err);
      }
    }

    return result;
  }
};

// Shadow DOM遍历函数
function traverseShadowDOM(element, path = '') {
  const result = {
    tagName: element.tagName,
    className: element.className,
    id: element.id,
    path: path || getElementPath(element),
    children: []
  };

  // 检查是否有Shadow Root
  if (element.shadowRoot) {
    result.shadowRoot = {
      mode: element.shadowRoot.mode,
      children: []
    };

    element.shadowRoot.childNodes.forEach((child, index) => {
      if (child.nodeType === Node.ELEMENT_NODE) {
        result.shadowRoot.children.push(
          traverseShadowDOM(child, `${path}::shadow-root > ${child.tagName.toLowerCase()}[${index}]`)
        );
      }
    });
  }

  // 遍历普通子元素
  element.childNodes.forEach((child, index) => {
    if (child.nodeType === Node.ELEMENT_NODE) {
      result.children.push(
        traverseShadowDOM(child, `${path} > ${child.tagName.toLowerCase()}[${index}]`)
      );
    }
  });

  return result;
}

// 获取元素路径
function getElementPath(element) {
  const path = [];
  let current = element;

  while (current && current !== document.body) {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      selector += `#${current.id}`;
    } else if (current.className) {
      // 处理 className - 可能是字符串或 SVGAnimatedString
      let className = '';
      if (typeof current.className === 'string') {
        className = current.className;
      } else if (current.className && typeof current.className.baseVal === 'string') {
        className = current.className.baseVal;
      }
      
      if (className) {
        const classes = className.split(' ').filter(c => c.trim()).join('.');
        if (classes) {
          selector += `.${classes}`;
        }
      }
    }

    path.unshift(selector);
    current = current.parentElement;
  }

  return path.join(' > ');
}

// 打开IndexedDB数据库
function openDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// 导出IndexedDB数据
function exportDatabase(db) {
  return new Promise((resolve, reject) => {
    const result = {};
    const objectStoreNames = Array.from(db.objectStoreNames);

    if (objectStoreNames.length === 0) {
      resolve(result);
      return;
    }

    const transaction = db.transaction(objectStoreNames, 'readonly');
    let completed = 0;

    objectStoreNames.forEach(storeName => {
      const store = transaction.objectStore(storeName);
      const request = store.getAll();

      request.onsuccess = () => {
        result[storeName] = request.result;
        completed++;

        if (completed === objectStoreNames.length) {
          resolve(result);
        }
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  });
}

// 监听用户活动
let activityTimeout;
const reportActivity = () => {
  clearTimeout(activityTimeout);
  activityTimeout = setTimeout(() => {
    if (window.sentinelAPI && window.sentinelAPI.reportActivity) {
      window.sentinelAPI.reportActivity();
    }
  }, 100);
};

// 获取元素的 XPath
function getXPath(element) {
  if (!element) return '';
  if (element.id) return `//*[@id="${element.id}"]`;
  if (element === document.body) return '/html/body';
  
  let path = '';
  let current = element;
  
  while (current && current !== document.body) {
    const parent = current.parentElement;
    if (!parent) break;
    
    const siblings = Array.from(parent.children).filter(s => s.tagName === current.tagName);
    const index = siblings.indexOf(current) + 1;
    
    const tagName = current.tagName.toLowerCase();
    const segment = siblings.length > 1 ? `${tagName}[${index}]` : tagName;
    path = '/' + segment + path;
    
    current = parent;
  }
  
  return '/html/body' + path;
}

// 获取元素的选择器
function getSelector(element) {
  if (!element) return '';
  if (element.id) return `#${element.id}`;
  
  // 处理 className - 可能是字符串或 SVGAnimatedString
  let className = '';
  if (typeof element.className === 'string') {
    className = element.className;
  } else if (element.className && typeof element.className.baseVal === 'string') {
    // SVG 元素
    className = element.className.baseVal;
  }
  
  if (className) {
    const classes = className.split(' ').filter(c => c.trim()).join('.');
    if (classes) return `${element.tagName.toLowerCase()}.${classes}`;
  }
  
  return element.tagName.toLowerCase();
}

// 记录用户操作
function recordUserAction(type, data) {
  if (window.sentinelAPI && window.sentinelAPI.reportUserAction) {
    window.sentinelAPI.reportUserAction({
      type,
      timestamp: Date.now(),
      url: window.location.href,
      ...data
    });
  }
}

// 监听各种用户活动事件（仅在主窗口中，不在 webview 中）
if (typeof process !== 'undefined' && process.type === 'renderer') {
  // 点击事件 - 使用 CDP 获取 Shadow DOM 路径
  document.addEventListener('click', async (e) => {
    reportActivity();

    // 获取 webContents ID
    const { ipcRenderer } = require('electron');
    const webContentsId = await ipcRenderer.invoke('get-webcontents-id');

    // 通过 CDP 获取元素路径（支持 Shadow DOM）
    let shadowDomPath = null;
    let cdpElementInfo = null;

    try {
      if (window.sentinelAPI && window.sentinelAPI.getElementPath) {
        cdpElementInfo = await window.sentinelAPI.getElementPath({
          x: e.clientX,
          y: e.clientY,
          webContentsId: webContentsId
        });

        if (cdpElementInfo) {
          shadowDomPath = cdpElementInfo.shadowPath;
        }
      }
    } catch (err) {
      console.warn('Failed to get CDP element path:', err);
    }

    recordUserAction('click', {
      xpath: getXPath(e.target),
      selector: getSelector(e.target),
      tagName: e.target.tagName,
      text: e.target.textContent?.substring(0, 100),
      coordinates: { x: e.clientX, y: e.clientY },
      shadowDomPath: shadowDomPath,
      cdpElementInfo: cdpElementInfo
    });
  }, true);
  
  // 输入事件
  document.addEventListener('input', (e) => {
    reportActivity();
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
      recordUserAction('input', {
        xpath: getXPath(e.target),
        selector: getSelector(e.target),
        tagName: e.target.tagName,
        inputType: e.target.type,
        value: e.target.type === 'password' ? '[REDACTED]' : e.target.value?.substring(0, 200)
      });
    }
  }, true);
  
  // 键盘事件
  document.addEventListener('keydown', (e) => {
    reportActivity();
    recordUserAction('keydown', {
      key: e.key,
      code: e.code,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey
    });
  }, true);
  
  // 滚动事件（增强版）
  // 功能：
  // 1. 记录滚动起始位置、结束位置
  // 2. 检测滚动方向变化，方向变化时按新事件记录
  // 3. 支持鼠标滚轮、拖动滚动条、触摸滑动等多种滚动方式
  let scrollTimeout;
  let scrollStartTime = 0;
  let scrollStartY = 0;
  let scrollStartX = 0;
  let lastScrollY = 0;
  let lastScrollX = 0;
  let lastScrollDirection = null;  // 'up', 'down', 'left', 'right'
  let isScrolling = false;
  let scrollSequenceId = 0;  // 滚动序列ID，方向变化时递增
  
  document.addEventListener('scroll', (e) => {
    reportActivity();
    
    const timestamp = Date.now();
    const currentY = window.scrollY;
    const currentX = window.scrollX;
    
    // 计算滚动方向
    let currentDirection = null;
    const deltaY = currentY - lastScrollY;
    const deltaX = currentX - lastScrollX;
    
    if (Math.abs(deltaY) > Math.abs(deltaX)) {
      // 垂直滚动为主
      currentDirection = deltaY > 0 ? 'down' : 'up';
    } else if (Math.abs(deltaX) > 0) {
      // 水平滚动
      currentDirection = deltaX > 0 ? 'right' : 'left';
    }
    
    // 检测滚动开始或方向变化
    if (!isScrolling) {
      // 新的滚动序列开始
      isScrolling = true;
      scrollStartTime = timestamp;
      scrollStartY = currentY;
      scrollStartX = currentX;
      lastScrollDirection = currentDirection;
      scrollSequenceId++;
      
      // 记录滚动开始事件
      recordUserAction('scroll-start', {
        scrollX: currentX,
        scrollY: currentY,
        scrollSequenceId: scrollSequenceId,
        direction: currentDirection,
        triggerSource: e.target === document ? 'window' : 'element'
      });
      
    } else if (currentDirection && lastScrollDirection && currentDirection !== lastScrollDirection) {
      // 方向发生变化！结束当前序列，开始新序列
      
      // 先发送当前序列的结束事件
      recordUserAction('scroll-end', {
        scrollX: lastScrollX,
        scrollY: lastScrollY,
        scrollStartX: scrollStartX,
        scrollStartY: scrollStartY,
        scrollDeltaX: Math.abs(lastScrollX - scrollStartX),
        scrollDeltaY: Math.abs(lastScrollY - scrollStartY),
        scrollDuration: timestamp - scrollStartTime,
        direction: lastScrollDirection,
        scrollSequenceId: scrollSequenceId,
        directionChanged: true
      });
      
      // 开始新序列
      scrollStartTime = timestamp;
      scrollStartY = currentY;
      scrollStartX = currentX;
      lastScrollDirection = currentDirection;
      scrollSequenceId++;
      
      // 发送新序列的开始事件
      recordUserAction('scroll-start', {
        scrollX: currentX,
        scrollY: currentY,
        scrollSequenceId: scrollSequenceId,
        direction: currentDirection,
        directionChangedFrom: lastScrollDirection
      });
    }
    
    // 更新最后位置
    lastScrollY = currentY;
    lastScrollX = currentX;
    if (currentDirection) {
      lastScrollDirection = currentDirection;
    }
    
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      const endTimestamp = Date.now();
      
      // 记录主要 scroll 事件
      recordUserAction('scroll', {
        scrollX: currentX,
        scrollY: currentY,
        scrollStartX: scrollStartX,
        scrollStartY: scrollStartY,
        scrollDeltaX: Math.abs(currentX - scrollStartX),
        scrollDeltaY: Math.abs(currentY - scrollStartY),
        scrollDuration: endTimestamp - scrollStartTime,
        direction: lastScrollDirection,
        scrollSequenceId: scrollSequenceId,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight
      });
      
      // 同时发送 scroll-end 事件（包含完整信息）
      recordUserAction('scroll-end', {
        scrollX: currentX,
        scrollY: currentY,
        scrollStartX: scrollStartX,
        scrollStartY: scrollStartY,
        scrollDeltaX: Math.abs(currentX - scrollStartX),
        scrollDeltaY: Math.abs(currentY - scrollStartY),
        scrollDuration: endTimestamp - scrollStartTime,
        direction: lastScrollDirection,
        scrollSequenceId: scrollSequenceId
      });
      
      isScrolling = false;
    }, 150);  // 150ms无新滚动视为结束
  }, true);
  
  // 注：拖动滚动条也会触发 scroll 事件
  // scroll 事件是由浏览器触发的，无论是以下哪种方式都会触发：
  // 1. 鼠标滚轮滚动
  // 2. 拖动滚动条
  // 3. 触摸滑动
  // 4. 键盘方向键/PgUp/PgDn
  // 5. JavaScript 调用 scrollTo/scrollBy
  // 所以不需要额外监听滚动条的拖动事件
  
  // 鼠标移动（节流）
  let mouseMoveTimeout;
  document.addEventListener('mousemove', (e) => {
    reportActivity();
    clearTimeout(mouseMoveTimeout);
    mouseMoveTimeout = setTimeout(() => {
      recordUserAction('mousemove', {
        x: e.clientX,
        y: e.clientY
      });
    }, 1000);
  }, true);
  
  // 表单提交
  document.addEventListener('submit', (e) => {
    reportActivity();
    recordUserAction('form_submit', {
      xpath: getXPath(e.target),
      selector: getSelector(e.target),
      action: e.target.action,
      method: e.target.method
    });
  }, true);
  
  // 页面加载完成
  window.addEventListener('load', () => {
    recordUserAction('page_load', {
      url: window.location.href,
      title: document.title,
      timestamp: Date.now()
    });
    
    // 保存初始 DOM 快照
    saveDOMSnapshot('initial');
  });
  
  // 监听 DOM 变化（使用 MutationObserver）
  let domChangeTimeout;
  const observer = new MutationObserver((mutations) => {
    clearTimeout(domChangeTimeout);
    domChangeTimeout = setTimeout(() => {
      // 记录 DOM 变化事件，但不保存完整快照（避免过多数据）
      if (window.sentinelAPI && window.sentinelAPI.reportUserAction) {
        window.sentinelAPI.reportUserAction({
          type: 'dom_change',
          timestamp: Date.now(),
          url: window.location.href,
          changeCount: mutations.length
        });
      }
    }, 1000);
  });
  
  // 开始观察 DOM 变化（等待 body 存在）
  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      characterData: true,
      characterDataOldValue: true
    });
  } else {
    // 如果 body 还不存在，等待 DOMContentLoaded
    document.addEventListener('DOMContentLoaded', () => {
      if (document.body) {
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeOldValue: true,
          characterData: true,
          characterDataOldValue: true
        });
      }
    });
  }
}

// 保存 DOM 快照
function saveDOMSnapshot(type = 'snapshot') {
  if (window.sentinelAPI && window.sentinelAPI.saveDOMSnapshot) {
    const snapshot = {
      html: document.documentElement.outerHTML,
      url: window.location.href,
      title: document.title,
      timestamp: Date.now(),
      type: type
    };
    window.sentinelAPI.saveDOMSnapshot(snapshot);
  }
}

// 拦截fetch请求以捕获API响应
const originalFetch = window.fetch;
window.fetch = async function(...args) {
  const response = await originalFetch.apply(this, args);

  // 克隆响应以便读取
  const clonedResponse = response.clone();

  try {
    const body = await clonedResponse.json();
    if (window.sentinelAPI && window.sentinelAPI.reportUIEvent) {
      window.sentinelAPI.reportUIEvent({
        type: 'api_response',
        url: args[0],
        method: args[1]?.method || 'GET',
        status: response.status,
        body: body
      });
    }
  } catch {
    // 非JSON响应，忽略
  }

  return response;
};

// 拦截XMLHttpRequest
const originalXHR = window.XMLHttpRequest;
window.XMLHttpRequest = function() {
  const xhr = new originalXHR();
  const originalSend = xhr.send;

  xhr.send = function(body) {
    xhr.addEventListener('load', function() {
      try {
        const response = JSON.parse(xhr.responseText);
        if (window.sentinelAPI && window.sentinelAPI.reportUIEvent) {
          window.sentinelAPI.reportUIEvent({
            type: 'api_response',
            url: xhr.responseURL,
            method: xhr._method || 'GET',
            status: xhr.status,
            body: response
          });
        }
      } catch {
        // 非JSON响应，忽略
      }
    });

    return originalSend.call(this, body);
  };

  const originalOpen = xhr.open;
  xhr.open = function(method, url, ...args) {
    xhr._method = method;
    xhr._url = url;
    return originalOpen.call(this, method, url, ...args);
  };

  return xhr;
};

// Blob URL捕获 - 重写URL.createObjectURL
const originalCreateObjectURL = URL.createObjectURL;
URL.createObjectURL = function(blob) {
  const url = originalCreateObjectURL.call(this, blob);

  // 读取Blob二进制数据并发送到主进程
  (async () => {
    try {
      // 将Blob转换为ArrayBuffer
      const arrayBuffer = await blob.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);

      // 转换为base64以便通过IPC传输
      const binaryData = Array.from(uint8Array);

      // 发送Blob信息和二进制数据到主进程
      if (window.sentinelAPI && window.sentinelAPI.reportBlobURL) {
        window.sentinelAPI.reportBlobURL({
          blobUrl: url,
          blobType: blob.type,
          blobSize: blob.size,
          timestamp: Date.now(),
          binaryData: binaryData  // 包含二进制数据
        });
      }

      // 同时通过UI事件报告
      if (window.sentinelAPI && window.sentinelAPI.reportUIEvent) {
        window.sentinelAPI.reportUIEvent({
          type: 'blob_created',
          url: url,
          size: blob.size,
          type: blob.type
        });
      }
    } catch (error) {
      console.error('[Sentinel] Failed to capture blob data:', error);

      // 即使读取失败，也发送元数据
      if (window.sentinelAPI && window.sentinelAPI.reportBlobURL) {
        window.sentinelAPI.reportBlobURL({
          blobUrl: url,
          blobType: blob.type,
          blobSize: blob.size,
          timestamp: Date.now(),
          error: error.message
        });
      }
    }
  })();

  return url;
};

// 文件上传追踪 - 劫持FormData.prototype.append
const originalFormDataAppend = FormData.prototype.append;
FormData.prototype.append = function(name, value, filename) {
  // 检查是否是文件上传
  if (value instanceof File || value instanceof Blob) {
    const fileInfo = {
      name: name,
      fileName: filename || (value instanceof File ? value.name : 'blob'),
      fileSize: value.size,
      fileType: value.type,
      timestamp: Date.now()
    };

    // 报告文件上传
    if (window.sentinelAPI && window.sentinelAPI.reportFileUpload) {
      window.sentinelAPI.reportFileUpload(fileInfo);
    }

    // 同时通过UI事件报告
    if (window.sentinelAPI && window.sentinelAPI.reportUIEvent) {
      window.sentinelAPI.reportUIEvent({
        type: 'file_upload',
        ...fileInfo
      });
    }
  }

  return originalFormDataAppend.call(this, name, value, filename);
};

// 同步状态注入 - Time-Travel Sandbox
// 在页面加载前恢复状态
function injectStateRestoration() {
  // 检查是否有保存的状态
  const savedState = window.__SENTINEL_STATE__;
  if (savedState) {
    // 恢复localStorage
    if (savedState.localStorage) {
      Object.entries(savedState.localStorage).forEach(([key, value]) => {
        localStorage.setItem(key, value);
      });
    }

    // 恢复sessionStorage
    if (savedState.sessionStorage) {
      Object.entries(savedState.sessionStorage).forEach(([key, value]) => {
        sessionStorage.setItem(key, value);
      });
    }

    console.log('[Sentinel] State restored from snapshot');
  }
}

// 在DOMContentLoaded时执行状态恢复
document.addEventListener('DOMContentLoaded', () => {
  injectStateRestoration();
});

// 页面加载完成后初始化监控
document.addEventListener('DOMContentLoaded', () => {
  // 检查是否在 webview 中运行（webview 使用不同的 preload 脚本）
  const isWebview = !window.sentinelAPI || typeof window.sentinelAPI.startRecording !== 'function';
  
  if (isWebview) {
    console.log('[Sentinel] Running in webview context, skipping main preload initialization');
    return;
  }
  
  // 初始化错误监控
  initializeErrorMonitoring();

  // 初始化UI监控
  initializeUIMonitoring();

  console.log('[Sentinel] Monitoring initialized');
});

// 错误监控初始化
function initializeErrorMonitoring() {
  // 检查 sentinelAPI 是否可用
  if (!window.sentinelAPI) {
    console.warn('[Sentinel] sentinelAPI not available, error monitoring disabled');
    return;
  }

  // 全局错误捕获
  window.addEventListener('error', (event) => {
    if (window.sentinelAPI && window.sentinelAPI.reportError) {
      window.sentinelAPI.reportError({
        type: 'javascript',
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: event.error ? event.error.stack : null,
        timestamp: Date.now()
      });
    }
  });

  // 未处理的Promise拒绝
  window.addEventListener('unhandledrejection', (event) => {
    if (window.sentinelAPI && window.sentinelAPI.reportError) {
      window.sentinelAPI.reportError({
        type: 'promise',
        message: event.reason ? event.reason.toString() : 'Unhandled rejection',
        stack: event.reason && event.reason.stack ? event.reason.stack : null,
        timestamp: Date.now()
      });
    }
  });

  // 控制台错误拦截
  const originalConsoleError = console.error;
  console.error = function(...args) {
    if (window.sentinelAPI && window.sentinelAPI.reportError) {
      window.sentinelAPI.reportError({
        type: 'console',
        message: args.map(arg => {
          if (arg instanceof Error) {
            return arg.message + '\n' + arg.stack;
          }
          return String(arg);
        }).join(' '),
        timestamp: Date.now()
      });
    }

    return originalConsoleError.apply(this, args);
  };
}

// UI监控初始化
function initializeUIMonitoring() {
  // 检查 sentinelAPI 是否可用
  if (!window.sentinelAPI || !window.sentinelAPI.reportUIEvent) {
    console.warn('[Sentinel] sentinelAPI.reportUIEvent not available, UI monitoring disabled');
    return;
  }

  // 使用MutationObserver监控UI变化
  const observer = new MutationObserver((mutations) => {
    // 检查 sentinelAPI 是否仍然可用
    if (!window.sentinelAPI || !window.sentinelAPI.reportUIEvent) {
      return;
    }

    mutations.forEach((mutation) => {
      // 监控Toast消息
      const toastSelectors = [
        '.el-message', '.ant-message', '.toast',
        '[role="alert"]', '.notification', '.snackbar',
        '.toast-message', '.alert'
      ];

      toastSelectors.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => {
          if (el.textContent && !el._sentinelReported) {
            el._sentinelReported = true;

            const isError = el.classList.contains('error') ||
                            el.classList.contains('danger') ||
                            el.classList.contains('el-message--error') ||
                            el.classList.contains('ant-message-error');

            window.sentinelAPI.reportUIEvent({
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
        '.error, .is-error, .has-error, .invalid, [aria-invalid="true"], .el-form-item__error'
      );

      errorElements.forEach(el => {
        if (!el._sentinelErrorReported) {
          el._sentinelErrorReported = true;

          const errorText = el.textContent ||
                            el.getAttribute('data-error') ||
                            el.title ||
                            'Validation error';

          window.sentinelAPI.reportUIEvent({
            type: 'ui_validation',
            element: el.tagName,
            className: el.className,
            message: errorText,
            timestamp: Date.now()
          });
        }
      });

      // 监控红色文本（可能的错误提示）
      const allElements = document.querySelectorAll('*');
      allElements.forEach(el => {
        try {
          const style = window.getComputedStyle(el);
          const color = style.color;

          if (color && (
              color.includes('rgb(255, 0, 0)') ||
              color.includes('rgb(220, 53, 69)') ||
              color.includes('rgb(244, 67, 54)') ||
              color.includes('#f56c6c') ||
              color.includes('#ff4d4f') ||
              color.includes('#dc3545')
          )) {
            if (!el._sentinelRedReported && el.textContent.trim()) {
              el._sentinelRedReported = true;

              window.sentinelAPI.reportUIEvent({
                type: 'ui_red_text',
                content: el.textContent.trim(),
                color: color,
                timestamp: Date.now()
              });
            }
          }
        } catch (e) {
          // 忽略跨域样式访问错误
        }
      });
    });
  });

  // 开始监控
  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'aria-invalid']
    });
  } else {
    // 如果body还不存在，等待DOM加载完成
    document.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'aria-invalid']
      });
    });
  }
}

// 网络请求拦截 - 用于捕获PDF流
const originalFetch2 = window.fetch;
window.fetch = async function(...args) {
  const response = await originalFetch2.apply(this, args);

  // 检查是否是PDF响应
  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/pdf')) {
    window.sentinelAPI.reportUIEvent({
      type: 'pdf_response',
      url: args[0],
      contentType: contentType,
      contentLength: response.headers.get('content-length'),
      timestamp: Date.now()
    });
  }

  return response;
};

// Windows 平台：添加存储目录选择功能
// macOS/Linux：无需选择，使用默认路径
// 注意：在 macOS 上调用此 API 会返回 null，renderer.js 应该处理这种情况
api.selectStorageDirectory = () => ipcRenderer.invoke('select-storage-directory');

// 暴露 API 到渲染进程
contextBridge.exposeInMainWorld('sentinelAPI', api);

console.log('[Sentinel] Preload script loaded successfully');
