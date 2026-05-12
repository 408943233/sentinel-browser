// Sentinel Browser 2.0 - 渲染进程主逻辑

class SentinelRenderer {
  constructor() {
    this.isRecording = false;
    this.currentTask = null;
    this.recordingStartTime = null;
    this.recordingTimer = null;
    this.eventCount = 0;
    this.apiCount = 0;

    // 视频录制相关
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.recordingStream = null;

    // 标签卡管理
    this.tabs = [];
    this.activeTabId = null;
    this.tabCounter = 0;

    // Preload 路径缓存
    this.preloadPath = null;

    this.init();
    this.loadPreloadPath();
  }

  // 预加载 webview preload 路径
  async loadPreloadPath() {
    console.log('[Sentinel] loadPreloadPath called');
    console.log('[Sentinel] window.sentinelAPI:', !!window.sentinelAPI);
    try {
      if (window.sentinelAPI && window.sentinelAPI.getWebviewPreloadPath) {
        console.log('[Sentinel] Calling getWebviewPreloadPath...');
        this.preloadPath = await window.sentinelAPI.getWebviewPreloadPath();
        console.log('[Sentinel] Preload path loaded:', this.preloadPath);
      } else {
        console.error('[Sentinel] window.sentinelAPI or getWebviewPreloadPath not available');
      }
    } catch (err) {
      console.error('[Sentinel] Failed to load preload path:', err);
    }
  }

  init() {
    this.bindEvents();
    this.loadTasks();
    this.updateDiskSpace();
    
    // 监听录制事件
    window.sentinelAPI.onRecordingStarted((data) => {
      this.onRecordingStarted(data);
    });

    window.sentinelAPI.onRecordingStopped((data) => {
      this.onRecordingStopped(data);
    });

    // 监听数据关联进度
    window.sentinelAPI.onCorrelationStarted((data) => {
      this.onCorrelationStarted(data);
    });

    window.sentinelAPI.onCorrelationProgress((data) => {
      this.onCorrelationProgress(data);
    });

    // 监听截图提取进度
    window.sentinelAPI.onSnapshotExtractionProgress((data) => {
      this.onSnapshotExtractionProgress(data);
    });

    // 监听录制暂停/恢复状态
    window.sentinelAPI.onRecordingPaused((data) => {
      this.onRecordingPaused(data);
    });

    // 监听创建新标签卡消息
    window.sentinelAPI.onCreateNewTab((url) => {
      console.log('[Sentinel] Received create-new-tab message:', url);
      this.createTab(url);
    });

    // 定期更新磁盘空间
    setInterval(() => this.updateDiskSpace(), 30000);
  }

  bindEvents() {
    // 导航控制
    document.getElementById('btn-back').addEventListener('click', () => this.goBack());
    document.getElementById('btn-forward').addEventListener('click', () => this.goForward());
    document.getElementById('btn-refresh').addEventListener('click', () => this.refresh());

    // 地址栏
    document.getElementById('url-input').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.navigateToUrl();
    });
    document.getElementById('btn-go').addEventListener('click', () => this.navigateToUrl());

    // 任务控制
    document.getElementById('btn-start-task').addEventListener('click', () => this.showTaskModal());

    const pauseBtn = document.getElementById('btn-pause-task');
    console.log('[Sentinel] Binding pause button:', pauseBtn);
    pauseBtn.addEventListener('click', (e) => {
      console.log('[Sentinel] Pause button clicked!', e);
      this.pauseTask();
    });

    document.getElementById('btn-stop-task').addEventListener('click', () => this.stopTask());
    document.getElementById('btn-start-welcome').addEventListener('click', () => this.showTaskModal());

    // 侧边栏收起/展开
    const sidebarToggle = document.getElementById('sidebar-toggle');
    if (sidebarToggle) {
      sidebarToggle.addEventListener('click', () => this.toggleSidebar());
    }

    // 新建标签卡按钮
    const addTabBtn = document.getElementById('btn-add-tab');
    if (addTabBtn) {
      addTabBtn.addEventListener('click', () => this.createTab());
    }

    // 模态框
    document.getElementById('close-modal').addEventListener('click', () => this.hideTaskModal());
    document.getElementById('btn-cancel').addEventListener('click', () => this.hideTaskModal());
    document.getElementById('btn-confirm-start').addEventListener('click', () => this.startTask());

    // 导出模态框
    document.getElementById('close-export-modal').addEventListener('click', () => this.hideExportModal());
    document.getElementById('btn-cancel-export').addEventListener('click', () => this.hideExportModal());
    document.getElementById('btn-confirm-export').addEventListener('click', () => this.exportTask());
    document.getElementById('btn-open-folder').addEventListener('click', () => this.openTaskFolder());

    // 点击模态框外部关闭
    document.getElementById('task-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.hideTaskModal();
    });
    document.getElementById('export-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.hideExportModal();
    });
  }

  // 侧边栏收起/展开
  toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (sidebar) {
      sidebar.classList.toggle('collapsed');
      const isCollapsed = sidebar.classList.contains('collapsed');
      console.log('[Sentinel] Sidebar', isCollapsed ? 'collapsed' : 'expanded');
    }
  }

  // 收起侧边栏
  collapseSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (sidebar && !sidebar.classList.contains('collapsed')) {
      sidebar.classList.add('collapsed');
      console.log('[Sentinel] Sidebar auto-collapsed');
    }
  }

  // 展开侧边栏
  expandSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (sidebar && sidebar.classList.contains('collapsed')) {
      sidebar.classList.remove('collapsed');
      console.log('[Sentinel] Sidebar auto-expanded');
    }
  }

  // ==================== 标签卡管理 ====================

  // 创建新标签卡
  createTab(url = null, title = '新标签卡') {
    this.tabCounter++;
    const tabId = `tab_${this.tabCounter}`;

    const tab = {
      id: tabId,
      url: url,
      title: title,
      webview: null,
      isLoading: false
    };

    this.tabs.push(tab);
    this.renderTab(tab);
    this.switchToTab(tabId);

    if (url) {
      this.loadUrlInTab(tabId, url);
    }

    return tabId;
  }

  // 渲染标签卡UI
  renderTab(tab) {
    const tabList = document.getElementById('tab-list');
    if (!tabList) return;

    const tabElement = document.createElement('div');
    tabElement.className = 'tab-item';
    tabElement.dataset.tabId = tab.id;
    tabElement.innerHTML = `
      <span class="tab-title">${tab.title}</span>
      <span class="tab-close" data-tab-id="${tab.id}">×</span>
    `;

    // 点击切换标签卡
    tabElement.addEventListener('click', (e) => {
      if (!e.target.classList.contains('tab-close')) {
        this.switchToTab(tab.id);
      }
    });

    // 点击关闭按钮
    const closeBtn = tabElement.querySelector('.tab-close');
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeTab(tab.id);
    });

    tabList.appendChild(tabElement);
  }

  // 切换到指定标签卡
  switchToTab(tabId) {
    // 更新活跃状态
    this.activeTabId = tabId;

    // 更新UI
    document.querySelectorAll('.tab-item').forEach(el => {
      el.classList.toggle('active', el.dataset.tabId === tabId);
    });

    // 显示对应的webview
    const tab = this.tabs.find(t => t.id === tabId);
    if (tab && tab.webview) {
      this.showWebview(tab.webview);
      this.updateCurrentUrl(tab.webview.src);
    }

    console.log('[Sentinel] Switched to tab:', tabId);
  }

  // 关闭标签卡
  closeTab(tabId) {
    const index = this.tabs.findIndex(t => t.id === tabId);
    if (index === -1) return;

    const tab = this.tabs[index];

    // 移除webview
    if (tab.webview && tab.webview.parentNode) {
      tab.webview.parentNode.removeChild(tab.webview);
    }

    // 从数组中移除
    this.tabs.splice(index, 1);

    // 移除UI
    const tabElement = document.querySelector(`.tab-item[data-tab-id="${tabId}"]`);
    if (tabElement) {
      tabElement.remove();
    }

    // 如果关闭的是当前标签卡，切换到其他标签卡
    if (this.activeTabId === tabId) {
      if (this.tabs.length > 0) {
        const newIndex = Math.min(index, this.tabs.length - 1);
        this.switchToTab(this.tabs[newIndex].id);
      } else {
        this.activeTabId = null;
        this.showWelcomeScreen();
      }
    }

    console.log('[Sentinel] Closed tab:', tabId);
  }

  // 显示webview
  showWebview(webview) {
    const container = document.getElementById('browser-container');
    if (!container) return;

    // 隐藏所有webview
    container.querySelectorAll('webview').forEach(wv => {
      wv.style.visibility = 'hidden';
      wv.style.zIndex = '0';
    });

    // 显示当前webview
    webview.style.visibility = 'visible';
    webview.style.zIndex = '1';

    // 隐藏欢迎屏幕
    const welcomeScreen = container.querySelector('.welcome-screen');
    if (welcomeScreen) {
      welcomeScreen.style.display = 'none';
    }
  }

  // 显示欢迎屏幕
  showWelcomeScreen() {
    const container = document.getElementById('browser-container');
    if (!container) return;

    // 隐藏所有webview
    container.querySelectorAll('webview').forEach(wv => {
      wv.style.display = 'none';
    });

    // 显示欢迎屏幕
    const welcomeScreen = container.querySelector('.welcome-screen');
    if (welcomeScreen) {
      welcomeScreen.style.display = 'flex';
    }
  }

  // 获取当前活跃的标签卡
  getActiveTab() {
    return this.tabs.find(t => t.id === this.activeTabId);
  }

  // 获取当前活跃的webview
  getActiveWebview() {
    const tab = this.getActiveTab();
    return tab ? tab.webview : null;
  }

  // 导航功能
  goBack() {
    const webview = this.getActiveWebview();
    if (webview) webview.goBack();
  }

  goForward() {
    const webview = this.getActiveWebview();
    if (webview) webview.goForward();
  }

  refresh() {
    const webview = this.getActiveWebview();
    if (webview) webview.reload();
  }

  navigateToUrl() {
    const urlInput = document.getElementById('url-input');
    let url = urlInput.value.trim();

    if (!url) return;

    // 自动添加协议（仅当用户未输入协议时）
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      // 检查是否包含协议分隔符，如果没有才添加 https
      if (!url.includes('://')) {
        url = 'https://' + url;
      }
    }

    // 如果没有标签卡，创建一个
    if (this.tabs.length === 0) {
      this.createTab(url);
    } else {
      // 在当前标签卡加载
      this.loadUrlInTab(this.activeTabId, url);
    }
  }

  async loadUrl(url) {
    // 兼容旧代码，创建新标签卡加载
    this.createTab(url);
  }

  loadUrlInTab(tabId, url) {
    console.log('[Sentinel] loadUrlInTab called:', tabId, url);
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab) {
      console.error('[Sentinel] Tab not found:', tabId);
      return;
    }

    const container = document.getElementById('browser-container');
    if (!container) {
      console.error('[Sentinel] browser-container not found');
      return;
    }

    // 如果标签卡已经有 webview，先移除
    if (tab.webview && tab.webview.parentNode) {
      tab.webview.parentNode.removeChild(tab.webview);
    }

    // 使用预加载的 preload 路径
    const preloadPath = this.preloadPath;
    console.log('[Sentinel] Using preload path:', preloadPath);

    // 创建 webview
    const webview = document.createElement('webview');
    webview.style.width = '100%';
    webview.style.height = '100%';
    webview.style.position = 'absolute';
    webview.style.top = '0';
    webview.style.left = '0';
    webview.style.visibility = 'hidden'; // 先隐藏，等切换时再显示
    webview.setAttribute('nodeintegration', 'true');
    webview.setAttribute('contextIsolation', 'false');
    webview.setAttribute('allowpopups', 'true');
    webview.setAttribute('webpreferences', 'contextIsolation=false, nodeIntegration=true, enableRemoteModule=false, allowRunningInsecureContent=true, webSecurity=false');
    
    // 设置 preload 脚本（必须在设置 src 之前）
    if (preloadPath) {
      webview.setAttribute('preload', preloadPath);
      console.log('[Sentinel] Webview preload set:', preloadPath);
    } else {
      console.warn('[Sentinel] Preload path not available yet');
    }

    // 保存到标签卡
    tab.webview = webview;

    // 设置 src
    console.log('[Sentinel] Setting webview src to:', url);
    webview.src = url;

    // 监听 webview 事件
    webview.addEventListener('dom-ready', () => {
      console.log('[Sentinel] Webview loaded:', url);
      console.log('[Sentinel] Webview actual src:', webview.src);
      this.updateCurrentUrl(url);
      this.injectClickTracker(webview);

      // 更新标签卡标题
      webview.executeJavaScript('document.title').then(title => {
        tab.title = title || url;
        this.updateTabTitle(tabId, tab.title);
      }).catch(() => {
        tab.title = url;
        this.updateTabTitle(tabId, url);
      });
    });

    webview.addEventListener('did-navigate', (e) => {
      if (this.activeTabId === tabId) {
        this.updateCurrentUrl(e.url);
        document.getElementById('url-input').value = e.url;
      }
      tab.url = e.url;
    });

    webview.addEventListener('console-message', (e) => {
      const levelNames = ['log', 'warning', 'error', 'error'];
      const levelName = levelNames[e.level] || 'log';
      
      // 调试用：输出所有 console 消息
      if (e.message) {
        console.log(`[Webview Raw][${levelName}]`, e.message.substring(0, 200));
      }
      
      // 捕获所有包含 Sentinel 的消息，不管级别
      if (e.message && (e.message.includes('[Sentinel Webview]') || e.message.includes('Sentinel'))) {
        console.log('[Webview]', e.message);
      } else if (e.level === 3) {
        console.error('[Webview Error]', e.message);
      }
      // 调试用：捕获所有 fetch 相关的消息
      if (e.message && (e.message.includes('fetch') || e.message.includes('XMLHttpRequest'))) {
        console.log('[Webview Debug]', e.message);
      }
    });

    // 监听加载失败事件
    webview.addEventListener('did-fail-load', (e) => {
      // 忽略 ERR_ABORTED (-3) 错误，这通常是正常的重定向或取消
      if (e.errorCode === -3) {
        console.log('[Sentinel] Webview load aborted (normal for redirects):', e.validatedURL);
        return;
      }
      console.error('[Sentinel] Webview failed to load:', e.errorCode, e.errorDescription, e.validatedURL);
    });

    // 拦截新窗口，转为新标签卡
    webview.addEventListener('new-window', (e) => {
      console.log('[Sentinel] New window intercepted:', e.url);
      e.preventDefault();
      this.createTab(e.url);
    });

    // 监听 ipc-message
    webview.addEventListener('ipc-message', (e) => {
      const { channel, args } = e;

      // 处理 preload 加载消息
      if (channel === 'sentinel-preload-loaded') {
        console.log('[Sentinel Renderer] Webview preload loaded:', args[0]?.url, 'timestamp:', args[0]?.timestamp);
        return;
      }

      // 处理 webview 的 console 日志
      if (channel === 'sentinel-console-log') {
        const { level, message, timestamp } = args[0] || {};
        console.log(`[Webview Console][${level}]`, message);
        return;
      }

      switch (channel) {
        case 'sentinel-click':
          if (window.sentinelAPI && window.sentinelAPI.reportUserAction) {
            window.sentinelAPI.reportUserAction(args[0]);
          }
          // 触发 DOM snapshot
          if (webview && args[0]) {
            webview.send('trigger-dom-snapshot', { type: 'incremental', timestamp: args[0].timestamp });
          }
          break;
        case 'sentinel-input':
          console.log('[Sentinel Renderer] Input received from webview:', args[0]?.selector);
          if (window.sentinelAPI && window.sentinelAPI.reportUserAction) {
            window.sentinelAPI.reportUserAction(args[0]);
          }
          // 触发 DOM snapshot
          if (webview && args[0]) {
            webview.send('trigger-dom-snapshot', { type: 'incremental', timestamp: args[0].timestamp });
          }
          break;
        case 'sentinel-scroll-start':
          console.log('[Sentinel Renderer] Scroll start received from webview');
          if (window.sentinelAPI && window.sentinelAPI.reportUserAction) {
            window.sentinelAPI.reportUserAction(args[0]);
          }
          break;

        case 'sentinel-scroll':
          console.log('[Sentinel Renderer] Scroll received from webview');
          if (window.sentinelAPI && window.sentinelAPI.reportUserAction) {
            window.sentinelAPI.reportUserAction(args[0]);
          }
          // 触发 DOM snapshot
          if (webview && args[0]) {
            webview.send('trigger-dom-snapshot', { type: 'incremental', timestamp: args[0].timestamp });
          }
          break;

        case 'sentinel-scroll-end':
          console.log('[Sentinel Renderer] Scroll end received from webview');
          if (window.sentinelAPI && window.sentinelAPI.reportUserAction) {
            window.sentinelAPI.reportUserAction(args[0]);
          }
          // 触发 DOM snapshot
          if (webview && args[0]) {
            webview.send('trigger-dom-snapshot', { type: 'incremental', timestamp: args[0].timestamp });
          }
          break;
        case 'sentinel-keydown':
          console.log('[Sentinel Renderer] Keydown received from webview:', args[0]?.key);
          if (window.sentinelAPI && window.sentinelAPI.reportUserAction) {
            window.sentinelAPI.reportUserAction(args[0]);
          }
          // 触发 DOM snapshot
          if (webview && args[0]) {
            webview.send('trigger-dom-snapshot', { type: 'incremental', timestamp: args[0].timestamp });
          }
          break;
        case 'sentinel-page-loaded':
          console.log('[Sentinel Renderer] Page loaded:', args[0]?.url);
          if (window.sentinelAPI && window.sentinelAPI.reportUserAction) {
            window.sentinelAPI.reportUserAction(args[0]);
          }
          // 触发初始 DOM snapshot
          if (webview && args[0]) {
            webview.send('trigger-dom-snapshot', { type: 'initial', timestamp: args[0].timestamp });
          }
          break;
        case 'sentinel-navigation':
          console.log('[Sentinel Renderer] Navigation:', args[0]?.from, '->', args[0]?.to);
          if (window.sentinelAPI && window.sentinelAPI.reportUserAction) {
            window.sentinelAPI.reportUserAction(args[0]);
          }
          // 注意：不在 navigation 事件触发 DOM snapshot，只在 page-loaded 事件触发
          // 避免重复保存 DOM snapshot
          break;
        case 'sentinel-dom-snapshot':
          console.log('[Sentinel Renderer] DOM snapshot received from webview');
          if (window.sentinelAPI && window.sentinelAPI.saveDOMSnapshot) {
            window.sentinelAPI.saveDOMSnapshot(args[0]);
          }
          break;
        case 'sentinel-request-full-snapshot':
          // 自动触发的完整快照请求（由于 DOM 变化显著）
          console.log('[Sentinel Renderer] Auto full snapshot requested:', args[0]?.reason);
          if (webview && args[0]) {
            webview.send('trigger-dom-snapshot', { type: 'auto', timestamp: args[0].timestamp, reason: args[0].reason });
          }
          break;
        case 'sentinel-request-tracked':
          // 已废弃：网络请求跟踪现在由主进程的 webRequest.onCompleted 处理
          console.log('[Sentinel Renderer] Request tracked from webview (ignored):', args[0]?.requestUrl);
          break;
      }
    });

    container.appendChild(webview);

    // 如果是当前活跃标签卡，显示它
    if (this.activeTabId === tabId) {
      this.showWebview(webview);
      document.getElementById('url-input').value = url;
      this.updateCurrentUrl(url);
    }
  }

  // 更新标签卡标题
  updateTabTitle(tabId, title) {
    const tabElement = document.querySelector(`.tab-item[data-tab-id="${tabId}"] .tab-title`);
    if (tabElement) {
      tabElement.textContent = title.substring(0, 20) + (title.length > 20 ? '...' : '');
    }
  }
  
  // 注入点击追踪脚本到 webview
  injectClickTracker(webview) {
    const script = `
      (function() {
        if (window.__sentinelClickTrackerInstalled) return;
        window.__sentinelClickTrackerInstalled = true;
        
        document.addEventListener('click', function(e) {
          // 获取元素信息
          function getXPath(element) {
            if (element.id) return '//*[@id="' + element.id + '"]';
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
            if (element.className) return element.tagName.toLowerCase() + '.' + element.className.split(' ').join('.');
            return element.tagName.toLowerCase();
          }
          
          const clickData = {
            type: 'click',
            timestamp: Date.now(),
            xpath: getXPath(e.target),
            selector: getSelector(e.target),
            tagName: e.target.tagName,
            text: e.target.textContent ? e.target.textContent.substring(0, 100) : '',
            coordinates: { x: e.clientX, y: e.clientY },
            url: window.location.href
          };
          
          // 发送到主进程
          if (typeof require !== 'undefined') {
            try {
              const { ipcRenderer } = require('electron');
              ipcRenderer.sendToHost('sentinel-click', clickData);
            } catch(err) {
              console.log('[Sentinel] Click tracked:', clickData);
            }
          }
        }, true);
        
        console.log('[Sentinel] Click tracker installed');
      })();
    `;
    
    webview.executeJavaScript(script).then(() => {
      console.log('[Sentinel] Click tracker injected into webview');
    }).catch(err => {
      console.error('[Sentinel] Failed to inject click tracker:', err);
    });
  }

  updateCurrentUrl(url) {
    document.getElementById('current-url').textContent = url;
  }
  
  // 设置 webview preload 脚本
  async setupWebviewPreload(webview) {
    try {
      if (window.sentinelAPI && window.sentinelAPI.getWebviewPreloadPath) {
        const preloadPath = await window.sentinelAPI.getWebviewPreloadPath();
        if (preloadPath) {
          webview.setAttribute('preload', preloadPath);
          console.log('[Sentinel] Webview preload set:', preloadPath);
        }
      }
    } catch (err) {
      console.error('[Sentinel] Failed to set webview preload:', err);
    }
  }

  // 任务管理
  showTaskModal() {
    document.getElementById('task-modal').classList.add('active');
    document.getElementById('task-name').focus();
  }

  hideTaskModal() {
    document.getElementById('task-modal').classList.remove('active');
    document.getElementById('task-form').reset();
  }

  async startTask() {
    // 防止重复点击
    if (this.isStartingTask) {
      console.log('[Sentinel] Task is already starting, ignoring duplicate click');
      return;
    }
    this.isStartingTask = true;

    const name = document.getElementById('task-name').value.trim();
    const operator = document.getElementById('task-operator').value.trim();
    let url = document.getElementById('task-url').value.trim();
    const description = document.getElementById('task-description').value.trim();

    if (!name || !operator || !url) {
      alert('请填写任务名称、操作人姓名和起始URL');
      this.isStartingTask = false;
      return;
    }

    // 自动添加协议
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }

    const config = {
      name,
      operator,
      url,
      description,
      options: {
        recordVideo: document.getElementById('record-video').checked,
        captureDOM: document.getElementById('capture-dom').checked,
        captureAPI: document.getElementById('capture-api').checked,
        captureState: document.getElementById('capture-state').checked,
        captureScreenshots: document.getElementById('capture-screenshots').checked
      }
    };
    
    try {
      console.log('[Sentinel] Starting task...');
      const taskId = await window.sentinelAPI.startRecording(config);
      
      this.currentTask = {
        id: taskId,
        name,
        url,
        config
      };
      
      this.isRecording = true;
      this.recordingStartTime = Date.now();
      this.eventCount = 0;
      this.apiCount = 0;
      
      // 更新UI
      console.log('[Sentinel] Updating UI for recording state');
      this.updateRecordingUI(true);
      this.startRecordingTimer();

      // 收起侧边栏
      this.collapseSidebar();

      // 启动视频录制
      console.log('[Sentinel] recordVideo option:', config.options.recordVideo);
      if (config.options.recordVideo) {
        console.log('[Sentinel] Calling startVideoRecording...');
        await this.startVideoRecording(taskId);
        console.log('[Sentinel] startVideoRecording completed');
      } else {
        console.log('[Sentinel] Video recording disabled');
      }
      
      // 加载URL
      this.loadUrl(url);
      
      this.hideTaskModal();
      
      console.log('[Sentinel] Task started:', taskId);
    } catch (error) {
      console.error('[Sentinel] Failed to start task:', error);
      alert('启动任务失败: ' + error.message);
    } finally {
      this.isStartingTask = false;
    }
  }

  async pauseTask() {
    console.log('[Sentinel] pauseTask called, isRecording:', this.isRecording);

    if (!this.isRecording) {
      console.log('[Sentinel] Not recording, ignoring pause click');
      return;
    }

    try {
      const pauseBtn = document.getElementById('btn-pause-task');
      console.log('[Sentinel] Pause button:', pauseBtn);
      console.log('[Sentinel] Pause button disabled:', pauseBtn?.disabled);
      console.log('[Sentinel] Pause button classes:', pauseBtn?.className);

      if (!pauseBtn) {
        console.error('[Sentinel] Pause button not found!');
        return;
      }

      const isPaused = pauseBtn.classList.contains('paused');
      console.log('[Sentinel] Current pause state:', isPaused);

      if (isPaused) {
        // 恢复录制
        console.log('[Sentinel] Resuming recording...');
        await window.sentinelAPI.resumeRecording();
        pauseBtn.classList.remove('paused');
        pauseBtn.innerHTML = '<span class="btn-icon">⏸️</span><span>暂停</span>';
        this.startRecordingTimer();
        console.log('[Sentinel] Task resumed');
      } else {
        // 暂停录制
        console.log('[Sentinel] Pausing recording...');
        await window.sentinelAPI.pauseRecording();
        pauseBtn.classList.add('paused');
        pauseBtn.innerHTML = '<span class="btn-icon">▶️</span><span>继续</span>';
        this.stopRecordingTimer();
        console.log('[Sentinel] Task paused');
      }
    } catch (error) {
      console.error('[Sentinel] Failed to pause/resume task:', error);
      alert('暂停/恢复失败: ' + error.message);
    }
  }

  async stopTask() {
    if (!this.isRecording) return;

    try {
      // 停止视频录制
      await this.stopVideoRecording();

      // 显示视频处理进度条
      this.showSnapshotProgressModal('正在处理视频...');

      // 检查是否启用了截图功能
      const captureScreenshots = this.currentTask?.config?.options?.captureScreenshots || false;

      // 停止录制（这会触发视频转换和截图处理）
      await window.sentinelAPI.stopRecording();

      this.isRecording = false;
      this.stopRecordingTimer();

      // 更新UI
      this.updateRecordingUI(false);

      // 隐藏进度条
      this.hideSnapshotProgressModal();

      // 展开侧边栏
      this.expandSidebar();

      // 刷新任务列表
      this.loadTasks();

      console.log('[Sentinel] Task stopped successfully');
    } catch (error) {
      console.error('[Sentinel] Failed to stop task:', error);
      this.hideSnapshotProgressModal();
      alert('停止任务失败: ' + error.message);
    }
  }

  // 录制状态UI更新
  updateRecordingUI(recording) {
    const startBtn = document.getElementById('btn-start-task');
    const pauseBtn = document.getElementById('btn-pause-task');
    const stopBtn = document.getElementById('btn-stop-task');
    const statusIndicator = document.getElementById('status-indicator');
    const recordingStatus = document.getElementById('recording-status');
    
    console.log('[Sentinel] updateRecordingUI called:', recording);
    console.log('[Sentinel] Buttons:', { startBtn: !!startBtn, pauseBtn: !!pauseBtn, stopBtn: !!stopBtn });
    
    if (recording) {
      if (startBtn) startBtn.disabled = true;
      if (pauseBtn) {
        pauseBtn.disabled = false;
        pauseBtn.classList.remove('paused');
        pauseBtn.innerHTML = '<span class="btn-icon">⏸️</span><span>暂停</span>';
      }
      if (stopBtn) stopBtn.disabled = false;
      if (statusIndicator) {
        statusIndicator.classList.add('recording');
        const statusText = statusIndicator.querySelector('.status-text');
        if (statusText) statusText.textContent = '录制中';
      }
      if (recordingStatus) {
        recordingStatus.textContent = '录制中';
        recordingStatus.classList.add('recording');
      }
    } else {
      if (startBtn) startBtn.disabled = false;
      if (pauseBtn) {
        pauseBtn.disabled = true;
        pauseBtn.classList.remove('paused');
        pauseBtn.innerHTML = '<span class="btn-icon">⏸️</span><span>暂停</span>';
      }
      if (stopBtn) stopBtn.disabled = true;
      if (statusIndicator) {
        statusIndicator.classList.remove('recording');
        const statusText = statusIndicator.querySelector('.status-text');
        if (statusText) statusText.textContent = '就绪';
      }
      if (recordingStatus) {
        recordingStatus.textContent = '未录制';
        recordingStatus.classList.remove('recording');
      }
    }
  }

  // 视频录制方法
  async startVideoRecording(taskId) {
    try {
      console.log('[Sentinel] Starting video recording...');

      // 使用 sentinelAPI 获取窗口列表
      if (!window.sentinelAPI || !window.sentinelAPI.getWindowSources) {
        console.error('[Sentinel] getWindowSources API not available');
        return;
      }

      // 获取当前窗口ID
      const currentWindowId = await window.sentinelAPI.getCurrentWindowId();
      console.log('[Sentinel] Current window ID:', currentWindowId);

      // 获取所有窗口源
      const sources = await window.sentinelAPI.getWindowSources();
      console.log('[Sentinel] Found', sources.length, 'window sources');

      if (sources.length === 0) {
        console.error('[Sentinel] No window source available');
        return;
      }

      // 查找当前应用的窗口（通过名称匹配 Sentinel Browser）
      let source = sources.find(s => s.name.includes('Sentinel Browser'));

      // 如果没找到 Sentinel Browser，尝试找 webview 或相关窗口
      if (!source) {
        source = sources.find(s => 
          s.name.includes('webview') || 
          s.name.includes('Browser') ||
          s.name.includes('Chrome')
        );
      }

      // 如果还是没找到，使用第一个窗口
      if (!source) {
        source = sources[0];
      }

      console.log('[Sentinel] Available window sources:', sources.map(s => ({ id: s.id, name: s.name })));
      console.log('[Sentinel] Using window source:', source.id, source.name);

      // 等待窗口准备好（Windows 需要额外时间）
      const platform = await window.sentinelAPI.getPlatform();
      if (platform === 'win32') {
        console.log('[Sentinel] Waiting for window to be ready on Windows...');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // 使用 getUserMedia 获取窗口流（初始版本实现）
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: source.id,
            minWidth: 1280,
            maxWidth: 1920,
            minHeight: 720,
            maxHeight: 1080
          }
        }
      });

      this.recordingStream = stream;

      // 检查视频轨道设置
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        const settings = videoTrack.getSettings();
        console.log('[Sentinel] Video track settings:', settings);
        
        // 监听轨道结束事件
        videoTrack.onended = () => {
          console.log('[Sentinel] Video track ended');
        };
      }

      // 使用 MediaRecorder 录制（初始版本实现）
      this.mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'video/webm;codecs=vp9',
        videoBitsPerSecond: 5000000
      });

      this.recordedChunks = [];

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.recordedChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = async () => {
        console.log('[Sentinel] MediaRecorder stopped, sending video data...');
        await this.sendVideoData(taskId);
      };

      this.mediaRecorder.start(1000); // 每秒收集一次数据
      console.log('[Sentinel] Video recording started for window:', source.name);
    } catch (error) {
      console.error('[Sentinel] Failed to start video recording:', error);
    }
  }
  
  async stopVideoRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      console.log('[Sentinel] Stopping video recording...');
      this.mediaRecorder.stop();
    }
    
    if (this.recordingStream) {
      this.recordingStream.getTracks().forEach(track => track.stop());
      this.recordingStream = null;
    }
  }
  
  async sendVideoData(taskId) {
    if (this.recordedChunks.length === 0) {
      console.warn('[Sentinel] No video data to send');
      return;
    }

    try {
      // 使用 MediaRecorder 的 MIME 类型
      const mimeType = this.mediaRecorder ? this.mediaRecorder.mimeType : 'video/webm';
      console.log('[Sentinel] Creating blob with MIME type:', mimeType);
      
      // 合并所有数据块
      const blob = new Blob(this.recordedChunks, { type: mimeType });
      const arrayBuffer = await blob.arrayBuffer();

      console.log('[Sentinel] Sending video data to main process, size:', arrayBuffer.byteLength, 'chunks:', this.recordedChunks.length);

      // 通过 IPC 发送视频数据到主进程（使用 Uint8Array 代替 Buffer）
      if (window.sentinelAPI && window.sentinelAPI.saveVideoData) {
        const uint8Array = new Uint8Array(arrayBuffer);
        await window.sentinelAPI.saveVideoData(taskId, uint8Array);
      }

      // 清理
      this.recordedChunks = [];
      this.mediaRecorder = null;
    } catch (error) {
      console.error('[Sentinel] Failed to send video data:', error);
    }
  }

  // 录制计时器
  startRecordingTimer() {
    this.recordingTimer = setInterval(() => {
      const elapsed = Date.now() - this.recordingStartTime;
      const timeStr = this.formatDuration(elapsed);
      document.getElementById('recording-time').textContent = timeStr;
    }, 1000);
  }

  stopRecordingTimer() {
    if (this.recordingTimer) {
      clearInterval(this.recordingTimer);
      this.recordingTimer = null;
    }
  }

  formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    const pad = (n) => n.toString().padStart(2, '0');
    return `${pad(hours)}:${pad(minutes % 60)}:${pad(seconds % 60)}`;
  }

  // 事件处理
  onRecordingStarted(data) {
    console.log('[Sentinel] Recording started:', data);
  }

  onRecordingStopped(data) {
    console.log('[Sentinel] Recording stopped:', data);
    this.isRecording = false;
    this.updateRecordingUI(false);
    this.stopRecordingTimer();
    
    // 隐藏数据关联进度模态框
    this.hideCorrelationProgressModal();
    
    // 显示导出对话框
    this.showExportModal();
  }

  // 数据关联开始处理
  onCorrelationStarted(data) {
    console.log('[Sentinel] Correlation started:', data);
    this.showCorrelationProgressModal();
  }

  // 数据关联进度处理
  onCorrelationProgress(data) {
    console.log('[Sentinel] Correlation progress:', data);
    
    const description = document.getElementById('correlation-progress-description');
    const progressText = document.getElementById('correlation-progress-text');
    const progressCount = document.getElementById('correlation-progress-count');
    const progressFill = document.getElementById('correlation-progress-fill');
    
    if (description) description.textContent = data.message || '正在处理...';
    if (progressText) progressText.textContent = data.message || '处理中...';
    if (progressCount) progressCount.textContent = `${data.current} / ${data.total}`;
    if (progressFill) progressFill.style.width = `${data.percent}%`;
  }

  // 显示数据关联进度模态框
  showCorrelationProgressModal() {
    const modal = document.getElementById('correlation-progress-modal');
    if (modal) {
      modal.classList.add('active');
    }
    // 初始化进度
    this.updateCorrelationProgress(0, 0, 0, '准备中...');
  }

  // 隐藏数据关联进度模态框
  hideCorrelationProgressModal() {
    const modal = document.getElementById('correlation-progress-modal');
    if (modal) {
      modal.classList.remove('active');
    }
  }

  // 更新数据关联进度
  updateCorrelationProgress(current, total, percent, message) {
    const progressFill = document.getElementById('correlation-progress-fill');
    const progressText = document.getElementById('correlation-progress-text');
    const progressCount = document.getElementById('correlation-progress-count');
    const description = document.getElementById('correlation-progress-description');
    
    if (progressFill) progressFill.style.width = `${percent}%`;
    if (progressText) progressText.textContent = message || '处理中...';
    if (progressCount) progressCount.textContent = `${current} / ${total}`;
    if (description) description.textContent = message || '正在处理...';
  }

  // 截图提取进度处理
  onSnapshotExtractionProgress(data) {
    console.log('[Sentinel] Snapshot extraction progress:', data);

    switch (data.status) {
      case 'started':
        // 显示进度条
        this.showSnapshotProgressModal();
        this.updateSnapshotProgress(0, data.total, 0);
        break;

      case 'progress':
        // 更新进度
        this.updateSnapshotProgress(data.current, data.total, data.percent);
        break;

      case 'completed':
        // 隐藏进度条
        this.hideSnapshotProgressModal();
        
        // 显示导出对话框
        this.showExportModal();
        console.log(`[Sentinel] Snapshot extraction completed: ${data.success} success, ${data.failed} failed`);
        break;
    }
  }

  // 录制暂停/恢复状态处理
  onRecordingPaused(data) {
    console.log('[Sentinel] Recording paused state changed:', data.isPaused);

    // 暂停/恢复视频录制
    if (this.mediaRecorder) {
      try {
        if (data.isPaused && this.mediaRecorder.state === 'recording') {
          this.mediaRecorder.pause();
          console.log('[Sentinel] Video recording paused');
        } else if (!data.isPaused && this.mediaRecorder.state === 'paused') {
          this.mediaRecorder.resume();
          console.log('[Sentinel] Video recording resumed');
        }
      } catch (error) {
        console.error('[Sentinel] Failed to pause/resume video recording:', error);
      }
    }

    // 将暂停状态传递给所有 webview
    this.tabs.forEach(tab => {
      if (tab.webview) {
        try {
          tab.webview.send('recording-paused', { isPaused: data.isPaused });
        } catch (error) {
          console.error('[Sentinel] Failed to send pause state to webview:', error);
        }
      }
    });
  }

  // 任务列表
  async loadTasks() {
    try {
      const tasks = await window.sentinelAPI.getTasks();
      const taskList = document.getElementById('task-list');
      
      if (tasks.length === 0) {
        taskList.innerHTML = '<div class="empty-state">暂无任务</div>';
        return;
      }
      
      taskList.innerHTML = tasks.map(task => `
        <div class="task-item" data-task-id="${task.id}" onclick="sentinelRenderer.showTaskInFolder('${task.id}')" title="点击在文件夹中显示">
          <div class="task-info">
            <div class="task-name">${task.dirName ? task.dirName.slice(0, 30) : task.id.slice(0, 8)}</div>
            <div class="task-meta">${new Date(task.createdAt).toLocaleString()}</div>
          </div>
          <div class="task-actions" onclick="event.stopPropagation()">
            <button class="task-action-btn" onclick="sentinelRenderer.exportTaskById('${task.id}')" title="导出">
              📦
            </button>
          </div>
        </div>
      `).join('');
    } catch (error) {
      console.error('[Sentinel] Failed to load tasks:', error);
    }
  }

  // 导出功能
  showExportModal() {
    document.getElementById('export-modal').classList.add('active');
  }

  hideExportModal() {
    document.getElementById('export-modal').classList.remove('active');
  }

  async exportTask() {
    console.log('[Sentinel] exportTask called, currentTask:', this.currentTask);

    if (!this.currentTask) {
      console.error('[Sentinel] No current task to export');
      alert('没有可导出的任务');
      return;
    }

    this.showExportProgress();

    try {
      console.log('[Sentinel] Exporting task:', this.currentTask.id);
      const zipPath = await window.sentinelAPI.exportTask(this.currentTask.id);
      console.log('[Sentinel] Export successful:', zipPath);
      this.hideExportProgress();
      alert(`任务已导出到: ${zipPath}`);
      this.hideExportModal();
    } catch (error) {
      console.error('[Sentinel] Export failed:', error);
      this.hideExportProgress();
      alert('导出失败: ' + error.message);
    }
  }

  async exportTaskById(taskId) {
    this.showExportProgress();

    try {
      const zipPath = await window.sentinelAPI.exportTask(taskId);
      this.hideExportProgress();
      alert(`任务已导出到: ${zipPath}`);
    } catch (error) {
      console.error('[Sentinel] Export failed:', error);
      this.hideExportProgress();
      alert('导出失败: ' + error.message);
    }
  }

  // 在文件夹中显示任务
  async showTaskInFolder(taskId) {
    try {
      console.log('[Sentinel] Showing task in folder:', taskId);
      await window.sentinelAPI.showInFolder(taskId);
    } catch (error) {
      console.error('[Sentinel] Failed to show task in folder:', error);
      alert('打开文件夹失败: ' + error.message);
    }
  }

  // 显示导出进度
  showExportProgress() {
    const progressDiv = document.getElementById('export-progress');
    const progressFill = document.getElementById('progress-fill');
    const progressText = document.getElementById('progress-text');

    if (progressDiv) {
      progressDiv.style.display = 'block';
    }
    if (progressFill) {
      progressFill.style.width = '0%';
    }
    if (progressText) {
      progressText.textContent = '准备导出...';
    }

    // 监听进度更新
    if (window.sentinelAPI && window.sentinelAPI.onExportProgress) {
      window.sentinelAPI.onExportProgress((data) => {
        this.updateExportProgress(data);
      });
    }
  }

  // 更新导出进度
  updateExportProgress(data) {
    const progressFill = document.getElementById('progress-fill');
    const progressText = document.getElementById('progress-text');

    if (progressFill && data.percent !== undefined) {
      progressFill.style.width = data.percent + '%';
    }
    if (progressText && data.message) {
      progressText.textContent = data.message;
    }
  }

  // 隐藏导出进度
  hideExportProgress() {
    const progressDiv = document.getElementById('export-progress');
    if (progressDiv) {
      progressDiv.style.display = 'none';
    }
  }

  // 显示截图处理进度模态框
  showSnapshotProgressModal(message) {
    const modal = document.getElementById('snapshot-progress-modal');
    if (modal) {
      modal.classList.add('active');
    }
    // 初始化进度
    this.updateSnapshotProgress(0, 0, 0, message);
  }

  // 隐藏截图处理进度模态框
  hideSnapshotProgressModal() {
    const modal = document.getElementById('snapshot-progress-modal');
    if (modal) {
      modal.classList.remove('active');
    }
  }

  // 更新截图处理进度
  updateSnapshotProgress(current, total, percent, message) {
    const progressFill = document.getElementById('snapshot-progress-fill');
    const progressText = document.getElementById('snapshot-progress-text');
    const progressCount = document.getElementById('snapshot-progress-count');

    if (progressFill) {
      progressFill.style.width = percent + '%';
    }
    if (progressText) {
      if (message) {
        progressText.textContent = message;
      } else if (percent === 0) {
        progressText.textContent = '准备中...';
      } else if (percent === 100) {
        progressText.textContent = '处理完成';
      } else {
        progressText.textContent = '正在截取...';
      }
    }
    if (progressCount) {
      progressCount.textContent = `${current} / ${total}`;
    }
  }

  // 打开当前任务文件夹
  async openTaskFolder() {
    if (!this.currentTask) {
      console.error('[Sentinel] No current task');
      return;
    }

    try {
      await window.sentinelAPI.showInFolder(this.currentTask.id);
    } catch (error) {
      console.error('[Sentinel] Failed to open task folder:', error);
      alert('打开文件夹失败: ' + error.message);
    }
  }

  // 磁盘空间监控
  async updateDiskSpace() {
    try {
      // 使用navigator.storage API获取存储信息
      if (navigator.storage && navigator.storage.estimate) {
        const estimate = await navigator.storage.estimate();
        const used = estimate.usage || 0;
        const total = estimate.quota || 0;
        const available = total - used;
        
        const formatSize = (bytes) => {
          if (bytes === 0) return '0 B';
          const k = 1024;
          const sizes = ['B', 'KB', 'MB', 'GB'];
          const i = Math.floor(Math.log(bytes) / Math.log(k));
          return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        };
        
        document.getElementById('disk-space').textContent = 
          `可用空间: ${formatSize(available)}`;
      }
    } catch (error) {
      console.error('[Sentinel] Failed to get disk space:', error);
    }
  }

  // 统计更新
  updateStats() {
    document.getElementById('event-count').textContent = this.eventCount;
    document.getElementById('api-count').textContent = this.apiCount;
  }
}

// 初始化
const sentinelRenderer = new SentinelRenderer();

// 暴露到全局以便HTML调用
window.sentinelRenderer = sentinelRenderer;
