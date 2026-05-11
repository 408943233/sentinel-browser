// Webview Preload Script - 注入到 webview 中用于捕获用户行为
// 支持 rrweb 标准的 DOM 序列化

const { ipcRenderer } = require('electron');

// 自定义日志函数，通过 IPC 发送到主进程
function sendLog(level, ...args) {
  const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
  ipcRenderer.sendToHost('sentinel-console-log', { level, message, timestamp: Date.now() });
}

// 全局错误捕获
try {
  sendLog('log', '[Sentinel Webview] Preload script loaded, location:', window.location.href);
  sendLog('log', '[Sentinel Webview] window.__sentinelWebviewLoaded:', window.__sentinelWebviewLoaded);
  sendLog('log', '[Sentinel Webview] ipcRenderer available:', !!ipcRenderer);
} catch (e) {
  sendLog('error', '[Sentinel Webview] Error in preload:', e.message);
}

// 立即发送测试消息
ipcRenderer.sendToHost('sentinel-preload-loaded', { timestamp: Date.now(), url: window.location.href });
console.log('[Sentinel Webview] Test message sent to host');

// 防止重复注入
console.log('[Sentinel Webview] Checking __sentinelWebviewLoaded:', window.__sentinelWebviewLoaded);
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

// 节点类型常量 (rrweb 标准)
const NodeType = {
  Document: 0,
  DocumentType: 1,
  Element: 2,
  Text: 3,
  CDATA: 4,
  Comment: 5
};

// 需要屏蔽的敏感属性
const sensitiveAttributes = ['password', 'credit-card', 'ssn'];

// 检查属性是否需要屏蔽
function isSensitiveAttribute(name, value) {
  const lowerName = name.toLowerCase();
  return sensitiveAttributes.some(keyword => 
    lowerName.includes(keyword) || (value && value.toLowerCase().includes(keyword))
  );
}

// 序列化单个节点
function serializeNode(node, doc, map, parentId = null) {
  if (!node) return null;

  // 使用统一的 getNodeId 函数来获取或创建节点 ID
  const id = getNodeId(node);
  if (id === null) return null;

  // 检查是否已经序列化过这个节点
  if (map.nodes.has(id)) {
    return map.nodes.get(id);
  }

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
      
      // 处理属性
      const attributes = {};
      for (let i = 0; i < node.attributes.length; i++) {
        const attr = node.attributes[i];
        // 屏蔽敏感属性
        if (isSensitiveAttribute(attr.name, attr.value)) {
          attributes[attr.name] = '***';
        } else {
          attributes[attr.name] = attr.value;
        }
      }
      
      // 特殊处理：记录 scroll 位置
      if (node.scrollLeft || node.scrollTop) {
        // 在 rrweb 中，scroll 位置通常通过增量快照记录
      }
      
      serializedNode.attributes = attributes;
      
      // 处理 Shadow DOM
      if (node.shadowRoot) {
        serializedNode.isShadowHost = true;
        serializedNode.shadowRoot = serializeNode(node.shadowRoot, doc, map, id);
      }
      
      serializedNode.childNodes = [];
      break;

    case Node.TEXT_NODE:
      serializedNode.type = NodeType.Text;
      // 对文本内容进行截断和保护
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

  // 建立父子关系映射
  if (parentId !== null) {
    const parent = map.nodes.get(parentId);
    if (parent && parent.childNodes) {
      parent.childNodes.push(id);
    }
  }

  map.nodes.set(id, serializedNode);

  // 递归处理子节点
  if (node.childNodes && node.childNodes.length > 0) {
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes[i];
      // 跳过 script 标签的内容（可选，用于减小体积）
      if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'SCRIPT') {
        continue;
      }
      serializeNode(child, doc, map, id);
    }
  }

  return serializedNode;
}

// 序列化整个文档为 rrweb 格式
function serializeDocument() {
  const map = {
    nodes: new Map()
  };

  const doc = document;
  const rootNode = serializeNode(doc, doc, map, null);

  // 将 map.nodes 转换为数组
  const nodeArray = Array.from(map.nodes.values());

  return {
    node: rootNode,
    nodes: nodeArray,
    id: nextNodeId
  };
}

// 生成 rrweb 标准的全量快照事件
function createFullSnapshot() {
  const serialized = serializeDocument();

  return {
    type: 2, // EventType.FullSnapshot
    data: {
      node: serialized.node,
      nodes: serialized.nodes, // 包含所有节点
      initialOffset: {
        left: window.pageXOffset || document.documentElement.scrollLeft || 0,
        top: window.pageYOffset || document.documentElement.scrollTop || 0
      }
    },
    timestamp: Date.now()
  };
}

// 存储 DOM 变化记录
let domMutations = {
  adds: [],
  removes: [],
  texts: [],
  attributes: []
};

// 节点 ID 映射（用于 rrweb 格式）
let nodeIdMap = new WeakMap();
let nextNodeId = 1;

// 自动完整快照相关变量
let autoFullSnapshotTimer = null;
let pendingMutationsCount = 0;
const AUTO_SNAPSHOT_DELAY = 500; // 延迟 500ms 触发完整快照，避免频繁触发
const AUTO_SNAPSHOT_THRESHOLD = 10; // 当累积超过 10 个节点变化时触发

// 获取或创建节点 ID
function getNodeId(node) {
  if (!node) return null;
  if (nodeIdMap.has(node)) {
    return nodeIdMap.get(node);
  }
  const id = nextNodeId++;
  nodeIdMap.set(node, id);
  return id;
}

// 触发完整快照（用于自动快照）
function triggerAutoFullSnapshot() {
  // 清除定时器
  if (autoFullSnapshotTimer) {
    clearTimeout(autoFullSnapshotTimer);
    autoFullSnapshotTimer = null;
  }
  
  // 重置计数器
  pendingMutationsCount = 0;
  
  // 发送完整快照请求到主进程
  console.log('[Sentinel Webview] Auto-triggering full snapshot due to significant DOM changes');
  ipcRenderer.sendToHost('sentinel-request-full-snapshot', {
    reason: 'auto',
    timestamp: Date.now()
  });
}

// 调度自动完整快照
function scheduleAutoFullSnapshot() {
  // 如果已经有定时器，不重复创建
  if (autoFullSnapshotTimer) return;
  
  autoFullSnapshotTimer = setTimeout(() => {
    triggerAutoFullSnapshot();
  }, AUTO_SNAPSHOT_DELAY);
}

// 初始化 MutationObserver
let mutationObserver = null;

function initMutationObserver() {
  if (mutationObserver) return;

  mutationObserver = new MutationObserver((mutations) => {
    let significantChange = false;
    
    mutations.forEach(mutation => {
      switch (mutation.type) {
        case 'childList':
          // 处理添加的节点
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

          // 处理移除的节点
          mutation.removedNodes.forEach(node => {
            const nodeId = getNodeId(node);
            if (nodeId !== null) {
              domMutations.removes.push({
                parentId: getNodeId(mutation.target),
                id: nodeId
              });
              pendingMutationsCount++;
            }
          });
          
          // 如果有大量节点变化，标记为显著变化
          if (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0) {
            significantChange = true;
          }
          break;

        case 'characterData':
          // 处理文本变化
          const textNodeId = getNodeId(mutation.target);
          if (textNodeId !== null) {
            domMutations.texts.push({
              id: textNodeId,
              value: mutation.target.textContent
            });
          }
          break;

        case 'attributes':
          // 处理属性变化
          const attrNodeId = getNodeId(mutation.target);
          if (attrNodeId !== null) {
            domMutations.attributes.push({
              id: attrNodeId,
              attributes: {
                [mutation.attributeName]: mutation.target.getAttribute(mutation.attributeName)
              }
            });
          }
          break;
      }
    });
    
    // 如果检测到显著变化且超过阈值，调度自动完整快照
    if (significantChange && pendingMutationsCount >= AUTO_SNAPSHOT_THRESHOLD) {
      scheduleAutoFullSnapshot();
    }
  });

  // 开始观察整个文档
  mutationObserver.observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeOldValue: true
  });

  console.log('[Sentinel Webview] MutationObserver initialized');
}

// 序列化节点用于 mutation 记录
function serializeNodeForMutation(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    return {
      type: NodeType.Text,
      textContent: node.textContent,
      id: getNodeId(node)
    };
  }

  if (node.nodeType === Node.ELEMENT_NODE) {
    const attributes = {};
    for (const attr of node.attributes || []) {
      if (!isSensitiveAttribute(attr.name, attr.value)) {
        attributes[attr.name] = attr.value;
      }
    }

    return {
      type: NodeType.Element,
      tagName: node.tagName.toLowerCase(),
      attributes: attributes,
      childNodes: Array.from(node.childNodes).map(child => getNodeId(child)).filter(id => id !== null),
      id: getNodeId(node)
    };
  }

  return null;
}

// 生成增量快照（用于记录 DOM 变化）
function createIncrementalSnapshot() {
  // 确保 MutationObserver 已初始化
  initMutationObserver();

  // 获取并清空当前的 mutation 记录
  const snapshot = {
    type: 3, // EventType.IncrementalSnapshot
    data: {
      source: 0, // IncrementalSource.Mutation
      adds: domMutations.adds,
      removes: domMutations.removes,
      texts: domMutations.texts,
      attributes: domMutations.attributes
    },
    timestamp: Date.now()
  };

  // 清空 mutation 记录
  domMutations = {
    adds: [],
    removes: [],
    texts: [],
    attributes: []
  };

  return snapshot;
}

// ============ 事件监听和上报 ============

// 获取元素 XPath
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

// 获取元素选择器
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

// 获取 Shadow DOM 路径
function getShadowDOMPath(element) {
  const path = [];
  let current = element;
  
  while (current && current !== document.body) {
    let selector = current.tagName.toLowerCase();
    
    if (current.id) {
      selector += `#${current.id}`;
    } else if (current.className) {
      const classes = current.className.split(' ').filter(c => c.trim());
      if (classes.length > 0) {
        selector += `.${classes.join('.')}`;
      }
    }
    
    // 检查是否在 Shadow Root 中
    if (current.getRootNode() instanceof ShadowRoot) {
      const host = current.getRootNode().host;
      if (host) {
        selector = `${host.tagName.toLowerCase()}::shadow-root > ${selector}`;
      }
    }
    
    path.unshift(selector);
    current = current.parentElement || current.getRootNode().host;
  }
  
  return path.join(' > ');
}

// 收集DOM统计信息
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
  // 检查是否处于暂停状态
  if (checkPaused()) return;

  const timestamp = Date.now();
  
  const clickData = {
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

  // 发送到主进程
  ipcRenderer.sendToHost('sentinel-click', clickData);
  console.log('[Sentinel Webview] Click tracked:', clickData.selector);
  
  // 延迟触发 DOM snapshot，确保页面变化已发生
  setTimeout(() => {
    saveDOMSnapshot('incremental', timestamp);
  }, 100);
}, true);

// 监听输入事件
document.addEventListener('input', (e) => {
  // 检查是否处于暂停状态
  if (checkPaused()) return;

  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
    const timestamp = Date.now();
    
    const inputData = {
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
    
    // 延迟触发 DOM snapshot，确保页面变化已发生
    setTimeout(() => {
      saveDOMSnapshot('incremental', timestamp);
    }, 100);
  }
}, true);

// 监听滚动事件（增强版）
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
  // 检查是否处于暂停状态
  if (checkPaused()) return;

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
    
    // 发送滚动开始事件
    const scrollStartData = {
      type: 'scroll-start',
      timestamp: timestamp,
      scrollX: currentX,
      scrollY: currentY,
      scrollSequenceId: scrollSequenceId,
      direction: currentDirection,
      url: window.location.href,
      triggerSource: e.target === document ? 'window' : 'element'
    };
    ipcRenderer.sendToHost('sentinel-scroll-start', scrollStartData);
    
  } else if (currentDirection && lastScrollDirection && currentDirection !== lastScrollDirection) {
    // 方向发生变化！结束当前序列，开始新序列
    
    // 先发送当前序列的结束事件
    const scrollEndData = {
      type: 'scroll-end',
      timestamp: timestamp,
      scrollX: lastScrollX,
      scrollY: lastScrollY,
      scrollStartX: scrollStartX,
      scrollStartY: scrollStartY,
      scrollDeltaX: Math.abs(lastScrollX - scrollStartX),
      scrollDeltaY: Math.abs(lastScrollY - scrollStartY),
      scrollDuration: timestamp - scrollStartTime,
      direction: lastScrollDirection,
      scrollSequenceId: scrollSequenceId,
      directionChanged: true,
      url: window.location.href
    };
    ipcRenderer.sendToHost('sentinel-scroll-end', scrollEndData);
    
    // 开始新序列
    scrollStartTime = timestamp;
    scrollStartY = currentY;
    scrollStartX = currentX;
    lastScrollDirection = currentDirection;
    scrollSequenceId++;
    
    // 发送新序列的开始事件
    const newScrollStartData = {
      type: 'scroll-start',
      timestamp: timestamp,
      scrollX: currentX,
      scrollY: currentY,
      scrollSequenceId: scrollSequenceId,
      direction: currentDirection,
      directionChangedFrom: lastScrollDirection,
      url: window.location.href,
      triggerSource: e.target === document ? 'window' : 'element'
    };
    ipcRenderer.sendToHost('sentinel-scroll-start', newScrollStartData);
  }
  
  // 更新最后位置
  lastScrollY = currentY;
  lastScrollX = currentX;
  if (currentDirection) {
    lastScrollDirection = currentDirection;
  }
  
  // 清除之前的超时
  clearTimeout(scrollTimeout);
  
  // 设置滚动结束检测（150ms无新滚动视为结束）
  scrollTimeout = setTimeout(() => {
    const endTimestamp = Date.now();
    
    const scrollData = {
      type: 'scroll',
      timestamp: endTimestamp,
      scrollX: currentX,
      scrollY: currentY,
      scrollStartX: scrollStartX,
      scrollStartY: scrollStartY,
      scrollDeltaX: Math.abs(currentX - scrollStartX),
      scrollDeltaY: Math.abs(currentY - scrollStartY),
      scrollDuration: endTimestamp - scrollStartTime,
      direction: lastScrollDirection,
      scrollSequenceId: scrollSequenceId,
      url: window.location.href,
      triggerSource: e.target === document ? 'window' : 'element'
    };

    ipcRenderer.sendToHost('sentinel-scroll', scrollData);
    
    // 同时发送 scroll-end 事件（包含完整信息）
    const scrollEndData = {
      type: 'scroll-end',
      timestamp: endTimestamp,
      scrollX: currentX,
      scrollY: currentY,
      scrollStartX: scrollStartX,
      scrollStartY: scrollStartY,
      scrollDeltaX: Math.abs(currentX - scrollStartX),
      scrollDeltaY: Math.abs(currentY - scrollStartY),
      scrollDuration: endTimestamp - scrollStartTime,
      direction: lastScrollDirection,
      scrollSequenceId: scrollSequenceId,
      url: window.location.href
    };
    ipcRenderer.sendToHost('sentinel-scroll-end', scrollEndData);
    
    // 延迟触发 DOM snapshot，确保页面变化已发生
    setTimeout(() => {
      saveDOMSnapshot('incremental', endTimestamp);
    }, 100);
    
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

// 监听键盘事件
document.addEventListener('keydown', (e) => {
  // 检查是否处于暂停状态
  if (checkPaused()) return;

  const timestamp = Date.now();
  
  const keyData = {
    type: 'keydown',
    timestamp: timestamp,
    key: e.key,
    code: e.code,
    ctrlKey: e.ctrlKey,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
    url: window.location.href
  };

  ipcRenderer.sendToHost('sentinel-keydown', keyData);
  
  // 延迟触发 DOM snapshot，确保页面变化已发生
  setTimeout(() => {
    saveDOMSnapshot('incremental', timestamp);
  }, 100);
}, true);

// ============ 鼠标悬停事件监控 ============
// 用于检测鼠标经过控件时触发的页面变化

// 记录上一个悬停的元素
let lastHoveredElement = null;
let hoverTimeout = null;
let lastHoverTime = 0;

// 监听鼠标移入事件
document.addEventListener('mouseover', (e) => {
  // 检查是否处于暂停状态
  if (checkPaused()) return;

  const now = Date.now();

  // 防抖：如果距离上次悬停时间太短，不处理
  if (now - lastHoverTime < 100) return;
  lastHoverTime = now;

  const target = e.target;

  // 如果悬停在同一个元素上，不重复处理
  if (target === lastHoveredElement) return;
  lastHoveredElement = target;

  const hoverData = {
    type: 'hover',
    timestamp: now,
    xpath: getXPath(target),
    selector: getSelector(target),
    shadowPath: getShadowDOMPath(target),
    tagName: target.tagName,
    text: target.textContent ? target.textContent.substring(0, 100) : '',
    coordinates: { x: e.clientX, y: e.clientY },
    url: window.location.href,
    title: document.title
  };

  // 发送到主进程
  ipcRenderer.sendToHost('sentinel-hover', hoverData);
  console.log('[Sentinel Webview] Hover tracked:', hoverData.selector);
  
  // 注意：DOM snapshot 由 main.js 触发，这里不再重复触发
}, true);

// 监听鼠标移出事件
document.addEventListener('mouseout', (e) => {
  // 可以在这里记录鼠标离开事件，如果需要的话
}, true);

// ============ 文件上传监控 ============

// 监听文件选择变化
document.addEventListener('change', (e) => {
  // 检查是否处于暂停状态
  if (checkPaused()) return;

  const target = e.target;

  // 检查是否是文件输入元素
  if (target.tagName === 'INPUT' && target.type === 'file') {
    const files = target.files;

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

        // 读取文件内容（如果是图片或文本文件）
        if (file.type.startsWith('image/') || file.type.startsWith('text/')) {
          readFileContent(file, target, i);
        }
      }

      const uploadData = {
        type: 'file-upload',
        timestamp: Date.now(),
        xpath: getXPath(target),
        selector: getSelector(target),
        tagName: target.tagName,
        inputType: target.type,
        multiple: target.multiple,
        fileCount: files.length,
        files: fileList,
        url: window.location.href,
        title: document.title
      };

      ipcRenderer.sendToHost('sentinel-file-upload', uploadData);
      console.log('[Sentinel Webview] File upload tracked:', fileList.map(f => f.name).join(', '));
    }
  }
}, true);

// 读取文件内容
function readFileContent(file, inputElement, fileIndex) {
  const reader = new FileReader();
  
  reader.onload = (event) => {
    const result = event.target.result;
    
    // 对于图片，转换为 base64
    // 对于文本，直接读取内容
    const isImage = file.type.startsWith('image/');
    
    ipcRenderer.sendToHost('sentinel-file-content', {
      type: 'file-content',
      timestamp: Date.now(),
      xpath: getXPath(inputElement),
      selector: getSelector(inputElement),
      fileName: file.name,
      fileType: file.type,
      fileSize: file.size,
      fileIndex: fileIndex,
      isImage: isImage,
      content: isImage ? result : result.substring(0, 10000), // 文本文件限制大小
      url: window.location.href
    });
    
    console.log('[Sentinel Webview] File content read:', file.name);
  };
  
  reader.onerror = (error) => {
    console.error('[Sentinel Webview] Failed to read file:', file.name, error);
  };
  
  // 根据文件类型选择读取方式
  if (file.type.startsWith('image/')) {
    reader.readAsDataURL(file); // 读取为 base64
  } else if (file.type.startsWith('text/') || file.type === 'application/json') {
    reader.readAsText(file); // 读取为文本
  }
}

// 拖拽文件上传监控
document.addEventListener('dragover', (e) => {
  e.preventDefault();
}, true);

document.addEventListener('drop', (e) => {
  e.preventDefault();

  // 检查是否处于暂停状态
  if (checkPaused()) return;

  const files = e.dataTransfer.files;
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

// 保存 DOM 快照 (rrweb 格式)
function saveDOMSnapshot(type = 'snapshot', externalTimestamp = null) {
  // 检查是否处于暂停状态（除了初始快照和自动快照）
  if (type !== 'initial' && type !== 'auto' && checkPaused()) return;

  // 根据类型创建不同的快照
  let rrwebEvent;
  if (type === 'initial' || type === 'auto') {
    // 初始快照和自动快照都创建完整快照
    rrwebEvent = createFullSnapshot();
    console.log('[Sentinel Webview] Creating full snapshot for type:', type);
  } else {
    // 增量快照
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

// 显式绑定到 window 对象，确保可以从外部访问
window.saveDOMSnapshot = saveDOMSnapshot;
console.log('[Sentinel Webview] saveDOMSnapshot bound to window:', typeof window.saveDOMSnapshot);

// 同时绑定到 global 对象（用于 executeJavaScript 访问）
if (typeof global !== 'undefined') {
  global.saveDOMSnapshot = saveDOMSnapshot;
  console.log('[Sentinel Webview] saveDOMSnapshot bound to global:', typeof global.saveDOMSnapshot);
}

// 监听来自主进程的触发 DOM snapshot 消息
ipcRenderer.on('trigger-dom-snapshot', (event, data) => {
  console.log('[Sentinel Webview] Received trigger-dom-snapshot message:', data);
  const type = data?.type || 'incremental';
  const timestamp = data?.timestamp || Date.now();
  saveDOMSnapshot(type, timestamp);
});

// 页面加载完成通知
window.addEventListener('load', () => {
  const timestamp = Date.now();
  
  ipcRenderer.sendToHost('sentinel-page-loaded', {
    type: 'page-load',
    url: window.location.href,
    title: document.title,
    timestamp: timestamp
  });

  // 初始化 MutationObserver 以跟踪 DOM 变化
  initMutationObserver();
  console.log('[Sentinel Webview] MutationObserver initialized on page load');

  // 注意：初始 DOM 快照由 renderer.js 通过 trigger-dom-snapshot 消息触发
  // 不再在这里直接保存，避免重复保存两个 snapshot 文件
});

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
