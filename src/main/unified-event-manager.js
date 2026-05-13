/**
 * 统一事件管理器（UnifiedEventManager）
 * 
 * 核心职责：
 * 1. 统一管理所有浏览器事件的创建、存储和写入
 * 2. 基于因果关系链（eventId）实现精确的事件关联，不使用时间窗匹配
 * 3. 支持 20+ 种数据类型的关联：网络请求、存储操作、通信、用户交互等
 * 4. 提供可靠的写入机制，带重试和防重复写入
 * 
 * 架构位置：
 * - 位于 Main Process（主进程）
 * - 接收来自 Preload 层（CausalChainTracker）的事件数据
 * - 输出到 training_manifest.jsonl（黄金文件）
 * 
 * 关键设计：
 * - 使用 Map 存储事件（eventId -> event），支持快速查找
 * - 使用队列管理写入操作，确保顺序和可靠性
 * - 写入成功后立即从内存删除，防止内存泄漏
 */

const fs = require('fs');
const path = require('path');
const logger = require('../shared/logger');
const eventLog = logger.create('UnifiedEventManager');

class UnifiedEventManager {
  /**
   * 构造函数
   * @param {Object} options - 配置选项
   * @param {number} options.maxCacheSize - 最大缓存事件数（默认 10000），超过后触发 onMaxCacheReached
   * @param {Function} options.onMaxCacheReached - 缓存达到上限时的回调函数（用于自动停止录制）
   * @param {number} options.maxRetries - 写入失败时的最大重试次数（默认 3）
   * @param {number} options.retryDelay - 重试延迟基数（默认 100ms，实际延迟 = retryDelay * 重试次数）
   */
  constructor(options = {}) {
    this.options = {
      maxCacheSize: options.maxCacheSize || 10000,
      onMaxCacheReached: options.onMaxCacheReached || null,
      maxRetries: options.maxRetries || 3,
      retryDelay: options.retryDelay || 100,
      eventRetentionTime: options.eventRetentionTime || 60000, // 事件保留时间（毫秒），默认60秒（修复：从30秒增加到60秒，确保网络请求能关联）
      ...options
    };

    // ==================== 任务和上下文信息 ====================
    this.currentTaskId = null;           // 当前任务ID
    this.currentSubTaskId = null;        // 当前子任务ID
    this.currentUserId = null;           // 当前用户ID
    this.currentUserRole = null;         // 当前用户角色
    this.currentUserPermissions = [];    // 当前用户权限
    this.currentWindowId = null;         // 当前窗口ID
    this.taskStartTime = null;           // 任务开始时间（用于计算video_time）
    this.previousEventId = null;         // 前一个事件ID（用于维护lineage）
    this.eventCounter = 0;               // 事件计数器

    // ==================== 核心数据结构 ====================
    
    /**
     * 事件存储（内存缓存）
     * Key: eventId（例如：evt_1234567890）
     * Value: 完整的事件对象，包含用户操作、网络请求、存储操作等所有关联数据
     * 生命周期：创建 -> 关联数据 -> 写入文件 -> 保留一段时间 -> 从内存删除（防止内存泄漏）
     */
    this.events = new Map();
    
    /**
     * 写入状态跟踪
     * Key: eventId
     * Value: 'pending'（等待写入）| 'written'（已写入）| { status: 'written', writtenAt: timestamp, deleteAt: timestamp }
     * 用途：防止重复写入同一事件，并跟踪事件保留时间
     */
    this.pendingWrites = new Map();
    
    /**
     * 已写入文件但仍在内存中保留的事件ID集合
     * 用于在事件写入文件后仍然接受关联数据（如网络请求）
     * Key: eventId
     * Value: 删除时间戳（超过此时间后可以从内存中删除）
     */
    this.retentionEvents = new Map();
    
    // 启动事件保留清理定时器
    this.retentionCleanupInterval = setInterval(() => {
      this.cleanupRetentionEvents();
    }, 5000); // 每5秒清理一次
    
    /**
     * 请求关联存储（预留，用于未来扩展）
     * Key: requestId
     * Value: 请求数据
     */
    this.requests = new Map();
    
    // ==================== 写入队列 ====================
    
    /**
     * 写入队列（先进先出）
     * 元素格式：{ type: 'event', data: eventObject, retries: 0 }
     * 用途：确保事件按顺序写入文件，支持重试机制
     */
    this.writeQueue = [];
    
    /**
     * 队列处理状态锁
     * true: 正在处理队列（防止并发处理）
     * false: 队列空闲
     */
    this.isProcessingQueue = false;
    
    // ==================== 文件流 ====================
    
    /** 
     * Manifest 文件写入流
     * 写入目标：training_manifest.jsonl（黄金文件）
     */
    this.manifestStream = null;
    
    /**
     * 关联日志写入流（预留）
     */
    this.correlationLogStream = null;

    /**
     * API 流量日志写入流
     * 写入目标：api_traffic.jsonl
     */
    this.apiLogStream = null;

    /**
     * 当前任务目录
     * 用于构建文件绝对路径
     */
    this.taskDir = null;
  }

  /**
   * 初始化管理器
   * 在 startRecording() 中调用，建立与文件系统的连接
   *
   * @param {string} taskDir - 任务目录路径（例如：/path/to/task_name_123）
   * @param {WriteStream} manifestStream - Manifest 文件写入流
   * @param {WriteStream} correlationLogStream - 关联日志写入流（可选）
   * @param {WriteStream} apiLogStream - API 日志写入流（可选）
   * @param {Object} taskConfig - 任务配置（可选，用于设置任务ID和开始时间）
   */
  initialize(taskDir, manifestStream, correlationLogStream, apiLogStream, taskConfig = {}) {
    const timer = eventLog.timer('initialize');
    eventLog.info('Initializing UnifiedEventManager', {
      taskDir,
      hasManifestStream: !!manifestStream,
      hasCorrelationLogStream: !!correlationLogStream,
      hasApiLogStream: !!apiLogStream
    });

    this.taskDir = taskDir;
    this.manifestStream = manifestStream;
    this.correlationLogStream = correlationLogStream;
    this.apiLogStream = apiLogStream;

    // 重置任务相关信息
    this.currentTaskId = taskConfig.taskId || taskConfig.id || null;
    this.currentSubTaskId = taskConfig.subTaskId || null;
    this.currentUserId = taskConfig.userId || null;
    this.currentUserRole = taskConfig.role || null;
    this.currentUserPermissions = taskConfig.permissions || [];
    this.currentWindowId = null; // 将在事件创建时动态设置
    this.taskStartTime = Date.now();
    this.previousEventId = null;
    this.eventCounter = 0;

    // 清空之前的事件缓存
    this.events.clear();
    this.pendingWrites.clear();
    this.retentionEvents.clear();
    this.requests.clear();
    this.writeQueue = [];

    eventLog.info('UnifiedEventManager initialized successfully', {
      taskDir,
      currentTaskId: this.currentTaskId,
      taskStartTime: this.taskStartTime,
      eventsInMemory: this.events.size,
      pendingWrites: this.pendingWrites.size,
      writeQueueLength: this.writeQueue.length
    });
    timer.end();
  }

  /**
   * 计算视频时间码
   * 从任务开始时间算起
   * @returns {string} 格式：HH:MM:SS.mmm
   */
  calculateVideoTime() {
    if (!this.taskStartTime) {
      return '00:00:00.000';
    }

    const elapsed = Date.now() - this.taskStartTime;
    const totalSeconds = Math.floor(elapsed / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const ms = elapsed % 1000;

    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
  }

  /**
   * 获取当前活动窗口的ID
   * @returns {string|null} 窗口ID或null
   */
  getCurrentWindowId() {
    try {
      // 使用 Electron 的 BrowserWindow 获取当前活动窗口
      const { BrowserWindow } = require('electron');
      const focusedWindow = BrowserWindow.getFocusedWindow();
      if (focusedWindow) {
        return `win_${focusedWindow.id}`;
      }
      // 如果没有焦点窗口，获取第一个窗口
      const allWindows = BrowserWindow.getAllWindows();
      if (allWindows.length > 0) {
        return `win_${allWindows[0].id}`;
      }
    } catch (e) {
      // 如果无法获取窗口，返回null
    }
    return null;
  }

  /**
   * 生成页面状态指纹
   * 基于URL、标题和DOM结构特征生成唯一标识
   * @param {string} url - 页面URL
   * @param {string} title - 页面标题
   * @param {Object} domStats - DOM统计信息
   * @returns {Object|null} 页面指纹对象
   */
  generatePageFingerprint(url, title, domStats = {}) {
    if (!url) return null;

    try {
      const urlObj = new URL(url);
      const path = urlObj.pathname;
      const query = urlObj.search;

      // 组合关键信息生成指纹
      const fingerprint = {
        // URL路径（去掉域名，保留路径结构）
        path: path,
        // 查询参数键（不包含值，保护隐私）
        query_keys: query ? query.slice(1).split('&').map(p => p.split('=')[0]).sort() : [],
        // 页面标题（去掉动态部分如数字、日期）
        title_normalized: title ? title.replace(/\d+/g, '#').trim() : null,
        // DOM统计信息
        dom_stats: {
          buttons: domStats?.buttons || 0,
          links: domStats?.links || 0,
          forms: domStats?.forms || 0,
          inputs: domStats?.inputs || 0,
          images: domStats?.images || 0
        },
        // 页面类型推断
        page_type: this.inferPageType(path, title)
      };

      // 生成哈希值作为唯一标识
      const fingerprintStr = JSON.stringify(fingerprint);
      const hash = this.simpleHash(fingerprintStr);

      return {
        hash: hash,
        details: fingerprint
      };
    } catch (error) {
      eventLog.error('Failed to generate page fingerprint:', error);
      return null;
    }
  }

  /**
   * 简单的字符串哈希函数
   * @param {string} str - 输入字符串
   * @returns {string} 哈希值
   */
  simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // 转换为32位整数
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
  }

  /**
   * 推断页面类型
   * @param {string} path - URL路径
   * @param {string} title - 页面标题
   * @returns {string} 页面类型
   */
  inferPageType(path, title) {
    const pathLower = path.toLowerCase();
    const titleLower = (title || '').toLowerCase();

    if (pathLower.includes('login') || pathLower.includes('signin') || titleLower.includes('登录')) {
      return 'login';
    }
    if (pathLower.includes('register') || pathLower.includes('signup') || titleLower.includes('注册')) {
      return 'register';
    }
    if (pathLower.includes('search') || titleLower.includes('搜索')) {
      return 'search';
    }
    if (pathLower.includes('product') || pathLower.includes('item') || titleLower.includes('商品')) {
      return 'product';
    }
    if (pathLower.includes('cart') || titleLower.includes('购物车')) {
      return 'cart';
    }
    if (pathLower.includes('checkout') || titleLower.includes('结算')) {
      return 'checkout';
    }
    if (pathLower.includes('profile') || pathLower.includes('account') || titleLower.includes('个人')) {
      return 'profile';
    }
    if (pathLower.includes('dashboard') || titleLower.includes('仪表板') || titleLower.includes('控制台')) {
      return 'dashboard';
    }
    if (pathLower.includes('list') || pathLower.includes('index') || titleLower.includes('列表')) {
      return 'list';
    }
    if (pathLower.includes('detail') || titleLower.includes('详情')) {
      return 'detail';
    }

    return 'generic';
  }

  /**
   * 创建新事件
   * 在用户操作（click/input/scroll 等）发生时调用
   * 
   * 执行流程：
   * 1. 检查缓存上限（防止内存耗尽）
   * 2. 生成/使用传入的 eventId
   * 3. 构建完整的事件对象（包含所有关联字段的初始值）
   * 4. 存入内存缓存（等待后续关联和写入）
   * 
   * @param {Object} eventData - 事件数据
   * @param {string} eventData.eventId - 事件唯一ID（可选，未提供时自动生成）
   * @param {string} eventData.type - 事件类型（click/input/scroll 等）
   * @param {number} eventData.timestamp - 事件时间戳（毫秒）
   * @param {string} eventData.url - 页面 URL
   * @param {string} eventData.title - 页面标题
   * @param {Object} eventData.userAction - 用户操作详情（xpath/selector/coordinates 等）
   * @param {Object} eventData.metadata - 元数据（domStats/isLoading 等）
   * @returns {Object|null} 创建的事件对象，或 null（缓存已满）
   */
  createEvent(eventData) {
    eventLog.trace('createEvent', [eventData.type, eventData.eventId], {
      url: eventData.url,
      timestamp: eventData.timestamp
    });

    // 检查缓存上限，防止内存耗尽
    if (this.events.size >= this.options.maxCacheSize) {
      eventLog.error('Max cache size reached', null, {
        maxCacheSize: this.options.maxCacheSize,
        currentSize: this.events.size
      });
      if (this.options.onMaxCacheReached) {
        this.options.onMaxCacheReached();
      }
      return null;
    }

    // 使用传入的 eventId 或生成新的
    const timestamp = eventData.timestamp || Date.now();
    const eventId = eventData.eventId || this.generateId('evt', timestamp);
    
    // 修复：如果事件已存在，不再重新创建（避免覆盖已关联的数据）
    if (this.events.has(eventId)) {
      eventLog.debug('Event already exists, skipping creation', {
        eventId,
        type: eventData.type
      });
      return this.events.get(eventId);
    }
    
    eventLog.debug('Creating event', {
      eventId,
      type: eventData.type,
      url: eventData.url,
      currentTaskId: this.currentTaskId,
      currentUserId: this.currentUserId
    });
    
    // 构建完整的事件对象
    // 统一格式：合并旧格式（DataSchemaManager）和新格式（UnifiedEventManager）的有用字段
    const event = {
      // ==================== 基础信息 ====================
      eventId: eventId,                           // 事件唯一ID
      timestamp: timestamp,                       // 事件发生时间
      video_time: eventData.videoTime || this.calculateVideoTime(), // 视频时间（从旧格式添加）
      type: eventData.type,                       // 事件类型

      // ==================== 任务和上下文（从旧格式添加）====================
      task_id: eventData.taskId || this.currentTaskId || null,
      sub_task_id: eventData.subTaskId || this.currentSubTaskId || null,
      window_context: {
        window_id: eventData.windowId || this.currentWindowId || this.getCurrentWindowId() || null,
        parent_window_id: eventData.parentWindowId || null,
        url: eventData.windowUrl || eventData.url || null
      },
      user_context: {
        user_id: eventData.userId || this.currentUserId || null,
        role: eventData.role || this.currentUserRole || null,
        permissions: eventData.permissions || this.currentUserPermissions || [],
        env: eventData.env || null
      },

      // ==================== 页面信息 ====================
      url: eventData.url || null,                 // 页面URL
      title: eventData.title || null,             // 页面标题
      page_state: {                              // 页面状态（从旧格式添加）
        fingerprint: eventData.pageFingerprint || this.generatePageFingerprint(
          eventData.url,
          eventData.title,
          eventData.domStats || eventData.metadata?.domStats
        ),
        has_errors: eventData.hasErrors || false,
        is_loading: eventData.isLoading || false,
        mutations: eventData.mutations || []
      },

      // ==================== 用户操作数据 ====================
      userAction: {
        xpath: eventData.userAction?.xpath,                   // XPath 路径
        selector: eventData.userAction?.selector,             // CSS 选择器
        shadowPath: eventData.userAction?.shadowPath,         // Shadow DOM 路径
        tagName: eventData.userAction?.tagName,               // 元素标签名
        text: eventData.userAction?.text,                     // 元素文本内容
        coordinates: eventData.userAction?.coordinates,       // 点击坐标 {x, y}
        value: eventData.userAction?.value,                   // 输入值（input事件）
        inputType: eventData.userAction?.inputType,           // 输入类型
        key: eventData.userAction?.key,                       // 按键
        scrollX: eventData.userAction?.scrollX,               // 滚动位置 X
        scrollY: eventData.userAction?.scrollY,               // 滚动位置 Y
        scrollStartX: eventData.userAction?.scrollStartX,     // 滚动开始 X
        scrollStartY: eventData.userAction?.scrollStartY,     // 滚动开始 Y
        scrollDeltaX: eventData.userAction?.scrollDeltaX,     // 滚动增量 X
        scrollDeltaY: eventData.userAction?.scrollDeltaY,     // 滚动增量 Y
        scrollDuration: eventData.userAction?.scrollDuration, // 滚动持续时间
        direction: eventData.userAction?.direction,           // 滚动方向
        scrollSequenceId: eventData.userAction?.scrollSequenceId, // 滚动序列ID
        directionChanged: eventData.userAction?.directionChanged, // 方向是否改变
        triggerSource: eventData.userAction?.triggerSource    // 触发来源
      },

      // ==================== 网络关联数据（由 Preload 层填充）====================
      network: {
        requests: [],           // HTTP/HTTPS 请求（fetch/xhr）
        websocketMessages: [],  // WebSocket 消息
        sseEvents: [],          // Server-Sent Events
        beaconRequests: []      // Beacon API 请求
      },
      network_correlation: {   // 网络关联（从旧格式添加）
        api_requests: eventData.apiRequests || [],
        static_resources: eventData.staticResources || [],
        dynamic_resources: eventData.dynamicResources || [],
        response_status: eventData.responseStatus || null
      },

      // ==================== 通信数据（由 Preload 层填充）====================
      communication: {
        postMessages: [],       // window.postMessage
        broadcastChannels: []   // BroadcastChannel
      },

      // ==================== 存储操作（由 Preload 层填充）====================
      storage: {
        localStorageOps: [],    // localStorage 操作
        sessionStorageOps: [],  // sessionStorage 操作
        indexedDBOps: [],       // IndexedDB 操作
        cacheOps: []            // Cache API 操作
      },

      // ==================== 其他操作（由 Preload 层填充）====================
      operations: {
        clipboardOps: [],       // 剪贴板操作
        mediaEvents: [],        // 媒体播放事件
        performanceEntries: [], // 性能指标
        compositionEvents: [],  // 输入法组合事件
        pointerEvents: [],      // 指针事件
        touchEvents: [],        // 触摸事件
        formSubmissions: [],    // 表单提交
        lifecycleEvents: [],    // 生命周期事件
        securityEvents: [],     // 安全事件
        cssAnimations: []       // CSS 动画
      },

      // ==================== 文件IO（从旧格式添加）====================
      file_io: {
        type: eventData.fileType || null,
        local_path: eventData.localPath || null,
        content_summary: eventData.contentSummary || null
      },

      // ==================== 血缘关系（从旧格式添加）====================
      lineage: {
        previous_event_id: this.previousEventId || null,
        next_event_id: null
      },

      // ==================== 元数据 ====================
      metadata: {
        domStats: eventData.domStats || eventData.metadata?.domStats || null,     // DOM 统计信息
        createdAt: Date.now(),                    // 创建时间
        contextType: eventData.contextType || eventData.type, // 上下文类型（从旧格式 _metadata 添加）
        description: eventData.description || eventData.semanticLabel || null, // 描述（从旧格式 _metadata 添加）
        // 修复：添加 DOM 快照路径信息
        domSnapshotFileName: eventData.domSnapshotFileName || eventData.metadata?.domSnapshotFileName || null,
        domSnapshotPath: eventData.domSnapshotPath || eventData.metadata?.domSnapshotPath || null,
        snapshotFileName: eventData.snapshotFileName || eventData.metadata?.snapshotFileName || null,
        snapshotPath: eventData.snapshotPath || eventData.metadata?.snapshotPath || null
      }
    };

    // 更新前一个事件的 next_event_id（在内存中维护）
    if (this.previousEventId && this.events.has(this.previousEventId)) {
      const prevEvent = this.events.get(this.previousEventId);
      if (prevEvent) {
        prevEvent.lineage.next_event_id = eventId;
      }
    }
    this.previousEventId = eventId;

    // 存入内存缓存
    this.events.set(eventId, event);
    eventLog.info('Event created', {
      eventId,
      type: eventData.type,
      totalEvents: this.events.size,
      memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024 + 'MB'
    });
    
    return event;
  }

  /**
   * 关联网络请求到事件
   * 在收到 sentinel-request-start/complete 消息时调用
   * 
   * 关联逻辑：
   * - 根据 requestData.type 分类存储到 event.network 的不同数组
   * - 支持类型：fetch/xhr/websocket/sse/beacon
   * 
   * @param {string} eventId - 目标事件ID
   * @param {Object} requestData - 请求数据
   * @param {string} requestData.type - 请求类型（fetch/xhr/websocket/sse/beacon）
   * @param {string} requestData.requestId - 请求唯一ID
   * @param {string} requestData.url - 请求URL
   * @param {string} requestData.method - HTTP 方法
   * @param {number} requestData.status - HTTP 状态码
   * @param {number} requestData.duration - 请求耗时（毫秒）
   * @returns {boolean} 关联成功返回 true，事件不存在返回 false
   */
  associateRequest(eventId, requestData) {
    // 处理 eventId 为 null 的情况：创建一个临时事件来存储这些请求
    if (!eventId) {
      console.warn('[UnifiedEventManager] Request with null eventId, creating orphan event:', requestData.url);
      eventId = this.createOrphanEvent(requestData);
    }
    
    const event = this.events.get(eventId);
    if (!event) {
      console.warn('[UnifiedEventManager] Event not found for request association:', eventId);
      return false;
    }

    // 根据请求类型分类存储
    switch (requestData.type) {
      case 'fetch':
      case 'xhr':
        // HTTP/HTTPS 请求
        event.network.requests.push({
          requestId: requestData.requestId,
          type: requestData.type,
          url: requestData.url,
          method: requestData.method,
          status: requestData.status,
          duration: requestData.duration,
          startTime: requestData.startTime,
          endTime: requestData.endTime,
          body: requestData.body,
          responseBody: requestData.responseBody
        });

        // 修复：同时写入 api_traffic.jsonl
        if (this.apiLogStream) {
          const apiEntry = {
            timestamp: Date.now(),
            eventId: eventId,
            requestId: requestData.requestId,
            type: requestData.type,
            url: requestData.url,
            method: requestData.method,
            status: requestData.status,
            duration: requestData.duration
          };
          this.apiLogStream.write(JSON.stringify(apiEntry) + '\n');
          eventLog.debug('API request logged to api_traffic.jsonl', { url: requestData.url, type: requestData.type });
        }

        // 保存静态资源（JS/CSS/图片/字体等）
        this.saveStaticResource(requestData);
        break;

      case 'websocket':
        // WebSocket 消息
        event.network.websocketMessages.push(requestData);
        break;

      case 'sse':
        // Server-Sent Events
        event.network.sseEvents.push(requestData);
        break;

      case 'beacon':
        // Beacon API
        event.network.beaconRequests.push(requestData);
        break;

      default:
        console.warn('[UnifiedEventManager] Unknown request type:', requestData.type);
    }

    console.log('[UnifiedEventManager] Request associated:', requestData.requestId, '->', eventId, 'type:', requestData.type);
    
    // 修复：立即将更新后的事件重新写入文件，确保 network.requests 被保存
    // 这样用户操作事件（click/scroll）关联的网络请求会被正确记录
    try {
      const line = JSON.stringify(event) + '\n';
      const manifestPath = path.join(this.taskDir, 'training_manifest.jsonl');
      fs.appendFileSync(manifestPath, line);
      console.log('[UnifiedEventManager] Event re-written with request:', eventId, 
        'requests count:', event.network.requests.length,
        'url:', requestData.url);
    } catch (error) {
      console.error('[UnifiedEventManager] Failed to re-write event with request:', eventId, error);
    }
    
    return true;
  }

  /**
   * 保存静态资源
   * 当检测到静态资源请求时（JS/CSS/图片/字体等），下载并保存到 network/resources 目录
   *
   * @param {Object} requestData - 请求数据
   * @param {string} requestData.url - 资源URL
   * @param {string} requestData.method - HTTP 方法
   * @param {number} requestData.status - HTTP 状态码
   */
  async saveStaticResource(requestData) {
    // 只处理成功的 GET 请求
    if (requestData.method !== 'GET' || requestData.status !== 200) {
      return;
    }

    const url = requestData.url;

    // 判断是否是静态资源（通过URL扩展名或Content-Type）
    const isStaticResource = this.isStaticResourceUrl(url);
    if (!isStaticResource) {
      return;
    }

    try {
      // 生成安全的文件名
      const urlObj = new URL(url);
      const fileName = path.basename(urlObj.pathname) || `resource_${Date.now()}`;
      const ext = path.extname(fileName) || this.getExtensionByUrl(url);
      const safeFileName = `${Date.now()}_${fileName.replace(/[^a-zA-Z0-9.-]/g, '_')}${ext}`;

      const resourcesDir = path.join(this.taskDir, 'network', 'resources');
      const filePath = path.join(resourcesDir, safeFileName);
      const relativePath = path.join('network', 'resources', safeFileName);

      // 确保 resources 目录存在
      if (!fs.existsSync(resourcesDir)) {
        fs.mkdirSync(resourcesDir, { recursive: true });
      }

      // 检查文件是否已存在（避免重复下载）
      if (fs.existsSync(filePath)) {
        console.log('[UnifiedEventManager] Resource already exists:', safeFileName);
        return;
      }

      // 下载资源
      const response = await fetch(url);
      if (!response.ok) {
        console.warn('[UnifiedEventManager] Failed to download resource:', url, response.status);
        return;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(filePath, buffer);

      console.log('[UnifiedEventManager] Resource saved:', safeFileName, `(${buffer.length} bytes)`);
    } catch (error) {
      console.warn('[UnifiedEventManager] Failed to save resource:', url, error.message);
    }
  }

  /**
   * 判断URL是否是静态资源
   * @param {string} url - 资源URL
   * @returns {boolean} 是否是静态资源
   */
  isStaticResourceUrl(url) {
    // 修复：移除 .pdf，让 PDF 文件通过 downloadAndSaveFile 保存到 downloads 目录
    const staticExtensions = /\.(js|css|png|jpg|jpeg|gif|svg|webp|woff|woff2|ttf|otf|eot|ico|json|xml)(\?.*)?$/i;
    return staticExtensions.test(url);
  }

  /**
   * 根据URL获取文件扩展名
   * @param {string} url - 资源URL
   * @returns {string} 文件扩展名
   */
  getExtensionByUrl(url) {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const ext = path.extname(pathname);
    if (ext) return ext;

    // 根据路径特征推断类型
    if (pathname.includes('.js') || pathname.includes('/js/')) return '.js';
    if (pathname.includes('.css') || pathname.includes('/css/')) return '.css';
    if (pathname.includes('/img/') || pathname.includes('/images/')) return '.png';
    if (pathname.includes('/font/') || pathname.includes('/fonts/')) return '.woff2';

    return '';
  }

  /**
   * 关联存储操作到事件
   * 在收到 sentinel-storage-operation/indexeddb-operation/cache-operation 消息时调用
   * 
   * @param {string} eventId - 目标事件ID
   * @param {Object} operationData - 操作数据
   * @param {string} operationData.type - 存储类型（localStorage/sessionStorage/indexedDB/cache）
   * @returns {boolean} 关联成功返回 true
   */
  associateStorageOperation(eventId, operationData) {
    const event = this.events.get(eventId);
    if (!event) {
      console.warn('[UnifiedEventManager] Event not found for storage association:', eventId);
      return false;
    }

    switch (operationData.type) {
      case 'localStorage':
        event.storage.localStorageOps.push(operationData);
        break;
      case 'sessionStorage':
        event.storage.sessionStorageOps.push(operationData);
        break;
      case 'indexedDB':
        event.storage.indexedDBOps.push(operationData);
        break;
      case 'cache':
        event.storage.cacheOps.push(operationData);
        break;
      default:
        console.warn('[UnifiedEventManager] Unknown storage type:', operationData.type);
    }

    // 修复：立即将更新后的事件重新写入文件，确保 storage 数据被保存
    try {
      const line = JSON.stringify(event) + '\n';
      const manifestPath = path.join(this.taskDir, 'training_manifest.jsonl');
      fs.appendFileSync(manifestPath, line);
      console.log('[UnifiedEventManager] Event re-written with storage:', eventId, 
        'localStorageOps:', event.storage.localStorageOps.length,
        'sessionStorageOps:', event.storage.sessionStorageOps.length,
        'indexedDBOps:', event.storage.indexedDBOps.length,
        'cacheOps:', event.storage.cacheOps.length);
    } catch (error) {
      console.error('[UnifiedEventManager] Failed to re-write event with storage:', eventId, error);
    }

    return true;
  }

  /**
   * 关联通信操作到事件
   * 在收到 sentinel-postmessage/broadcastchannel-message 消息时调用
   * 
   * @param {string} eventId - 目标事件ID
   * @param {Object} commData - 通信数据
   * @param {string} commData.type - 通信类型（postMessage/broadcastChannel）
   * @returns {boolean} 关联成功返回 true
   */
  associateCommunication(eventId, commData) {
    const event = this.events.get(eventId);
    if (!event) {
      console.warn('[UnifiedEventManager] Event not found for communication association:', eventId);
      return false;
    }

    if (commData.type === 'postMessage') {
      event.communication.postMessages.push(commData);
    } else if (commData.type === 'broadcastChannel') {
      event.communication.broadcastChannels.push(commData);
    } else {
      console.warn('[UnifiedEventManager] Unknown communication type:', commData.type);
    }

    // 修复：立即将更新后的事件重新写入文件，确保 communication 数据被保存
    try {
      const line = JSON.stringify(event) + '\n';
      const manifestPath = path.join(this.taskDir, 'training_manifest.jsonl');
      fs.appendFileSync(manifestPath, line);
      console.log('[UnifiedEventManager] Event re-written with communication:', eventId, 
        'postMessages:', event.communication.postMessages.length,
        'broadcastChannels:', event.communication.broadcastChannels.length);
    } catch (error) {
      console.error('[UnifiedEventManager] Failed to re-write event with communication:', eventId, error);
    }

    return true;
  }

  /**
   * 关联其他操作到事件
   * 通用关联方法，用于 clipboard/media/performance 等操作
   * 
   * @param {string} eventId - 目标事件ID
   * @param {Object} opData - 操作数据
   * @param {string} opData.type - 操作类型（clipboard/media/performance）
   * @returns {boolean} 关联成功返回 true
   */
  associateOperation(eventId, opData) {
    const event = this.events.get(eventId);
    if (!event) {
      console.warn('[UnifiedEventManager] Event not found for operation association:', eventId);
      return false;
    }

    switch (opData.type) {
      case 'clipboard':
        event.operations.clipboardOps.push(opData);
        break;
      case 'media':
        event.operations.mediaEvents.push(opData);
        break;
      case 'performance':
        event.operations.performanceEntries.push(opData);
        break;
      default:
        console.warn('[UnifiedEventManager] Unknown operation type:', opData.type);
    }

    // 修复：立即将更新后的事件重新写入文件，确保 operations 数据被保存
    try {
      const line = JSON.stringify(event) + '\n';
      const manifestPath = path.join(this.taskDir, 'training_manifest.jsonl');
      fs.appendFileSync(manifestPath, line);
      console.log('[UnifiedEventManager] Event re-written with operation:', eventId, 
        'type:', opData.type,
        'clipboardOps:', event.operations.clipboardOps.length,
        'mediaEvents:', event.operations.mediaEvents.length,
        'performanceEntries:', event.operations.performanceEntries.length);
    } catch (error) {
      console.error('[UnifiedEventManager] Failed to re-write event with operation:', eventId, error);
    }

    return true;
  }

  // ==================== 特定类型的关联方法 ====================
  
  // 以下方法都是 associateOperation 的特化版本，提供更清晰的语义

  /**
   * 关联输入法组合事件
   * @param {string} eventId - 目标事件ID
   * @param {Object} compositionData - 组合事件数据
   */
  associateComposition(eventId, compositionData) {
    const event = this.events.get(eventId);
    if (!event) return false;

    if (!event.operations.compositionEvents) {
      event.operations.compositionEvents = [];
    }
    event.operations.compositionEvents.push(compositionData);
    return true;
  }

  /**
   * 关联指针事件
   * @param {string} eventId - 目标事件ID
   * @param {Object} pointerData - 指针事件数据
   */
  associatePointerEvent(eventId, pointerData) {
    const event = this.events.get(eventId);
    if (!event) return false;

    if (!event.operations.pointerEvents) {
      event.operations.pointerEvents = [];
    }
    event.operations.pointerEvents.push(pointerData);
    return true;
  }

  /**
   * 关联触摸事件
   * @param {string} eventId - 目标事件ID
   * @param {Object} touchData - 触摸事件数据
   */
  associateTouchEvent(eventId, touchData) {
    const event = this.events.get(eventId);
    if (!event) return false;

    if (!event.operations.touchEvents) {
      event.operations.touchEvents = [];
    }
    event.operations.touchEvents.push(touchData);
    return true;
  }

  /**
   * 关联表单提交
   * @param {string} eventId - 目标事件ID
   * @param {Object} formData - 表单数据
   */
  associateFormSubmit(eventId, formData) {
    const event = this.events.get(eventId);
    if (!event) return false;

    if (!event.operations.formSubmissions) {
      event.operations.formSubmissions = [];
    }
    event.operations.formSubmissions.push(formData);
    return true;
  }

  /**
   * 关联生命周期事件
   * @param {string} eventId - 目标事件ID
   * @param {Object} lifecycleData - 生命周期数据
   */
  associateLifecycleEvent(eventId, lifecycleData) {
    const event = this.events.get(eventId);
    if (!event) return false;

    if (!event.operations.lifecycleEvents) {
      event.operations.lifecycleEvents = [];
    }
    event.operations.lifecycleEvents.push(lifecycleData);
    return true;
  }

  /**
   * 关联安全事件
   * @param {string} eventId - 目标事件ID
   * @param {Object} securityData - 安全事件数据
   */
  associateSecurityEvent(eventId, securityData) {
    const event = this.events.get(eventId);
    if (!event) return false;

    if (!event.operations.securityEvents) {
      event.operations.securityEvents = [];
    }
    event.operations.securityEvents.push(securityData);
    return true;
  }

  /**
   * 关联 CSS 动画事件
   * @param {string} eventId - 目标事件ID
   * @param {Object} cssData - CSS 动画数据
   */
  associateCSSAnimation(eventId, cssData) {
    const event = this.events.get(eventId);
    if (!event) return false;

    if (!event.operations.cssAnimations) {
      event.operations.cssAnimations = [];
    }
    event.operations.cssAnimations.push(cssData);
    return true;
  }

  // ==================== 写入管理 ====================

  /**
   * 延迟函数
   * 用于重试延迟
   * 
   * @param {number} ms - 延迟毫秒数
   * @returns {Promise} 延迟完成后 resolve
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 刷新单个事件到文件
   * 将事件添加到写入队列，等待异步写入
   * 
   * 防重复机制：
   * - 检查 pendingWrites，如果事件已在队列或已写入，直接返回 false
   * - 避免同一事件被写入多次
   * 
   * @param {string} eventId - 要刷新的事件ID
   * @returns {boolean} 添加成功返回 true，已在队列或事件不存在返回 false
   */
  async flushEvent(eventId) {
    // 防重复写入检查
    if (this.pendingWrites.has(eventId)) {
      console.log('[UnifiedEventManager] Event already pending or written:', eventId);
      return false;
    }

    const event = this.events.get(eventId);
    if (!event) {
      console.warn('[UnifiedEventManager] Event not found for flush:', eventId);
      return false;
    }

    // 检查 taskDir 是否已设置
    if (!this.taskDir) {
      console.error('[UnifiedEventManager] taskDir is not set, cannot flush event:', eventId);
      eventLog.error('Cannot flush event: taskDir is not initialized', { eventId });
      return false;
    }

    // 修复：直接同步写入，确保事件立即落盘，不依赖异步队列
    try {
      const line = JSON.stringify(event) + '\n';
      const manifestPath = path.join(this.taskDir, 'training_manifest.jsonl');
      
      // 调试日志
      console.log('[UnifiedEventManager] Writing to:', manifestPath);
      eventLog.info('Writing event to manifest', { eventId, manifestPath, lineLength: line.length });
      
      fs.appendFileSync(manifestPath, line);

      // 标记为已写入，但保留在内存中一段时间以接受后续关联数据
      const now = Date.now();
      const deleteAt = now + this.options.eventRetentionTime;
      this.pendingWrites.set(eventId, { status: 'written', writtenAt: now, deleteAt });
      this.retentionEvents.set(eventId, deleteAt);
      
      // 注意：不从 this.events 中删除，保留在内存中以接受后续请求关联
      // 事件将在 cleanupRetentionEvents 中定期清理

      console.log('[UnifiedEventManager] Event flushed successfully (retained in memory):', eventId, 'will delete at:', new Date(deleteAt).toISOString());
      eventLog.info('Event flushed directly (retained in memory):', { eventId, type: event.type, retentionTime: this.options.eventRetentionTime });
      return true;
    } catch (error) {
      console.error('[UnifiedEventManager] Direct flush failed:', error);
      eventLog.error('Direct flush failed, falling back to queue:', error);

      // 回退到队列机制
      this.writeQueue.push({
        type: 'event',
        data: event,
        retries: 0
      });
      this.pendingWrites.set(eventId, 'pending');
      await this.processWriteQueue();
      return true;
    }
  }

  /**
   * 刷新所有事件到文件
   * 在停止录制时调用，确保所有事件都被写入
   *
   * @returns {Promise} 写入完成返回 Promise
   */
  async flushAll() {
    console.log('[UnifiedEventManager] Flushing all events:', this.events.size);

    for (const [eventId, event] of this.events) {
      if (!this.pendingWrites.has(eventId)) {
        this.writeQueue.push({
          type: 'event',
          data: event,
          retries: 0
        });
        this.pendingWrites.set(eventId, 'pending');
      }
    }

    return this.processWriteQueue();
  }

  /**
   * 创建并立即刷新事件到文件
   * 用于替代 DataSchemaManager 的直接事件生成
   *
   * @param {Object} eventData - 事件数据（与 createEvent 相同）
   * @returns {Object|null} 创建的事件对象，或 null（创建失败）
   */
  createAndFlushEvent(eventData) {
    // 创建事件
    const event = this.createEvent(eventData);
    if (!event) {
      console.error('[UnifiedEventManager] Failed to create event:', eventData.type);
      return null;
    }

    // 立即刷新到文件
    this.flushEvent(event.eventId).catch(err => {
      console.error('[UnifiedEventManager] Failed to flush event:', event.eventId, err);
    });

    return event;
  }

  /**
   * 处理写入队列
   * 核心写入逻辑，确保可靠写入和错误恢复
   * 
   * 执行流程：
   * 1. 检查是否正在处理（防止并发）
   * 2. 循环处理队列中的每个项目
   * 3. 写入成功：从队列移除，标记为已写入，保留在内存中一段时间（以便后续关联数据）
   * 4. 写入失败：增加重试计数，超过最大重试次数后丢弃
   * 
   * @returns {Promise} 处理完成返回 Promise
   */
  async processWriteQueue() {
    // 防止并发处理（如果正在处理，等待完成）
    if (this.isProcessingQueue) {
      while (this.isProcessingQueue) {
        await this.delay(10);
      }
      return;
    }

    if (this.writeQueue.length === 0) return;

    this.isProcessingQueue = true;

    try {
      while (this.writeQueue.length > 0) {
        const item = this.writeQueue[0];

        try {
          if (item.type === 'event') {
            await this.writeEvent(item.data);
          }

          // 写入成功，从队列移除
          this.writeQueue.shift();
          
          // 标记为已写入，但保留在内存中一段时间以接受后续关联数据
          if (item.data && item.data.eventId) {
            const now = Date.now();
            const deleteAt = now + this.options.eventRetentionTime;
            this.pendingWrites.set(item.data.eventId, { status: 'written', writtenAt: now, deleteAt });
            this.retentionEvents.set(item.data.eventId, deleteAt);
            
            // 注意：不从 this.events 中删除，保留在内存中以接受后续请求关联
            // 事件将在 cleanupRetentionEvents 中定期清理
            
            console.log('[UnifiedEventManager] Event written (retained in memory):', item.data.eventId, 'will delete at:', new Date(deleteAt).toISOString());
          }
        } catch (error) {
          console.error('[UnifiedEventManager] Write failed:', error);

          // 增加重试计数
          item.retries++;
          
          if (item.retries >= this.options.maxRetries) {
            // 超过最大重试次数，丢弃该事件
            console.error('[UnifiedEventManager] Max retries reached, dropping event:', item.data?.eventId);
            this.writeQueue.shift();
          } else {
            // 延迟后重试（指数退避）
            await this.delay(this.options.retryDelay * item.retries);
          }
        }
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  /**
   * 写入单个事件到文件
   * 实际的文件写入操作
   * 
   * 写入策略：
   * 1. 优先使用同步写入（fs.appendFileSync），确保数据立即落盘
   * 2. 同步写入失败时，回退到流写入
   * 
   * @param {Object} event - 要写入的事件对象
   * @returns {Promise} 写入完成返回 resolve，失败返回 reject
   */
  async writeEvent(event) {
    return new Promise((resolve, reject) => {
      // 将事件序列化为 JSON 行格式（JSON Lines）
      const line = JSON.stringify(event) + '\n';

      try {
        // 策略1：同步写入（优先，确保数据落盘）
        const manifestPath = path.join(this.taskDir, 'training_manifest.jsonl');
        fs.appendFileSync(manifestPath, line);
        resolve();
      } catch (error) {
        // 策略2：流写入（回退）
        if (this.manifestStream) {
          this.manifestStream.write(line, (err) => {
            if (err) reject(err);
            else resolve();
          });
        } else {
          reject(error);
        }
      }
    });
  }

  /**
   * 生成唯一ID
   * 用于生成 eventId、requestId 等
   * 
   * 格式：{prefix}_{时间戳}_{计数器}_{随机数}
   * 示例：evt_1234567890123_42_a1b2c3d4e
   * 
   * @param {string} prefix - ID 前缀（默认 'id'）
   * @returns {string} 唯一ID
   */
  generateId(prefix = 'id', timestamp = null) {
    const ts = timestamp || Date.now();
    return `${prefix}_${ts}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 获取统计信息
   * 用于监控和调试
   * 
   * @returns {Object} 统计信息对象
   * @returns {number} .events - 内存中事件数
   * @returns {number} .pendingWrites - 等待写入的事件数
   * @returns {number} .writeQueue - 写入队列长度
   * @returns {boolean} .isProcessing - 是否正在处理队列
   */
  getStats() {
    return {
      events: this.events.size,              // 内存中事件数
      pendingWrites: this.pendingWrites.size, // 等待写入的事件数
      retentionEvents: this.retentionEvents.size, // 保留中的事件数
      writeQueue: this.writeQueue.length,     // 写入队列长度
      isProcessing: this.isProcessingQueue    // 是否正在处理队列
    };
  }
  
  /**
   * 创建孤儿事件（用于存储没有关联 eventId 的请求）
   * 当请求发生时没有有效的 eventId，创建一个临时事件来存储这些请求
   * 
   * @param {Object} requestData - 请求数据
   * @returns {string} 创建的孤儿事件ID
   */
  createOrphanEvent(requestData) {
    const timestamp = Date.now();
    const eventId = this.generateId('evt_orphan', timestamp);

    // 使用 createEvent 创建基础事件，然后添加请求信息
    const orphanEvent = {
      // ==================== 基础信息 ====================
      eventId: eventId,
      timestamp: timestamp,
      video_time: this.calculateVideoTime(),
      type: 'orphan-request',

      // ==================== 任务和上下文 ====================
      task_id: this.currentTaskId || null,
      sub_task_id: null,
      window_context: {
        window_id: null,
        parent_window_id: null,
        url: requestData.url || null
      },
      user_context: {
        user_id: null,
        role: null,
        permissions: [],
        env: null
      },

      // ==================== 页面信息 ====================
      url: requestData.url || null,
      title: 'Orphan Request Event',
      page_state: {
        fingerprint: this.generatePageFingerprint(requestData.url, 'Orphan Request Event', {}),
        has_errors: false,
        is_loading: false,
        mutations: []
      },

      // ==================== 用户操作 ====================
      userAction: {},

      // ==================== 网络数据 ====================
      network: {
        requests: [{
          requestId: requestData.requestId,
          type: requestData.type,
          url: requestData.url,
          method: requestData.method,
          status: requestData.status,
          duration: requestData.duration,
          startTime: requestData.startTime,
          endTime: requestData.endTime,
          body: requestData.body,
          responseBody: requestData.responseBody
        }],
        websocketMessages: [],
        sseEvents: [],
        beaconRequests: []
      },
      network_correlation: {
        api_requests: [],
        static_resources: [],
        dynamic_resources: [],
        response_status: null
      },

      // ==================== 通信和存储 ====================
      communication: {
        postMessages: [],
        broadcastChannels: []
      },
      storage: {
        localStorageOps: [],
        sessionStorageOps: [],
        indexedDBOps: [],
        cacheOps: []
      },

      // ==================== 其他操作 ====================
      operations: {
        clipboardOps: [],
        mediaEvents: [],
        performanceEntries: [],
        compositionEvents: [],
        pointerEvents: [],
        touchEvents: [],
        formSubmissions: [],
        lifecycleEvents: [],
        securityEvents: [],
        cssAnimations: []
      },

      // ==================== 文件IO ====================
      file_io: {
        type: null,
        local_path: null,
        content_summary: null
      },

      // ==================== 血缘关系 ====================
      lineage: {
        previous_event_id: this.previousEventId || null,
        next_event_id: null
      },

      // ==================== 元数据 ====================
      metadata: {
        domStats: null,
        createdAt: timestamp,
        contextType: 'orphan-request',
        description: `Orphan request: ${requestData.url || 'unknown'}`,
        isOrphan: true
      }
    };
    
    // 存入内存
    this.events.set(eventId, orphanEvent);
    
    // 立即写入文件
    try {
      const line = JSON.stringify(orphanEvent) + '\n';
      const manifestPath = path.join(this.taskDir, 'training_manifest.jsonl');
      fs.appendFileSync(manifestPath, line);
      
      // 标记为已写入并设置保留时间
      const deleteAt = timestamp + this.options.eventRetentionTime;
      this.pendingWrites.set(eventId, { status: 'written', writtenAt: timestamp, deleteAt });
      this.retentionEvents.set(eventId, deleteAt);
      
      console.log('[UnifiedEventManager] Orphan event created and flushed:', eventId, 'for request:', requestData.url);
    } catch (error) {
      console.error('[UnifiedEventManager] Failed to flush orphan event:', error);
    }
    
    return eventId;
  }
  
  /**
   * 清理保留期已过的事件
   * 定期从内存中删除已写入文件且保留期已过的事件
   * 
   * 修复：在删除前，将更新后的事件数据重新写入文件，确保网络请求等关联数据被保存
   */
  cleanupRetentionEvents() {
    const now = Date.now();
    let cleaned = 0;
    let updated = 0;
    
    for (const [eventId, deleteAt] of this.retentionEvents) {
      if (now >= deleteAt) {
        const event = this.events.get(eventId);
        if (event) {
          // 修复：在删除前，将更新后的事件数据重新写入文件
          // 这样网络请求等关联数据会被保存到文件中
          try {
            const line = JSON.stringify(event) + '\n';
            const manifestPath = path.join(this.taskDir, 'training_manifest.jsonl');
            fs.appendFileSync(manifestPath, line);
            updated++;
            console.log('[UnifiedEventManager] Updated event with associated data:', eventId, 
              'requests:', event.network?.requests?.length || 0,
              'storage:', event.storage?.localStorageOps?.length || 0);
          } catch (error) {
            console.error('[UnifiedEventManager] Failed to update event before cleanup:', eventId, error);
          }
        }
        
        // 从内存中删除事件
        this.events.delete(eventId);
        this.retentionEvents.delete(eventId);
        this.pendingWrites.delete(eventId);
        cleaned++;
      }
    }
    
    if (updated > 0 || cleaned > 0) {
      console.log('[UnifiedEventManager] Cleaned up', cleaned, 'retention events, updated:', updated, 'remaining:', this.retentionEvents.size);
    }
  }
  
  /**
   * 停止管理器
   * 在停止录制时调用，确保所有数据都被写入并清理资源
   * 
   * 修复：停止时重新生成 manifest 文件，去重并保留最新版本的事件
   * 
   * @returns {Promise} 停止完成返回 Promise
   */
  async stop() {
    console.log('[UnifiedEventManager] Stopping, flushing remaining events...');
    
    // 清理保留定时器
    if (this.retentionCleanupInterval) {
      clearInterval(this.retentionCleanupInterval);
      this.retentionCleanupInterval = null;
    }
    
    // 刷新所有剩余事件
    await this.flushAll();
    
    // 清理所有保留的事件（在删除前会重新写入更新后的事件）
    this.cleanupRetentionEvents();
    
    // 修复：重新生成 manifest 文件，去重并保留最新版本的事件
    await this.regenerateManifest();
    
    console.log('[UnifiedEventManager] Stopped');
  }
  
  /**
   * 重新生成 manifest 文件
   * 去重并保留最新版本的事件（基于 eventId）
   * 
   * 修复：解决事件重复写入导致的文件中有多个版本的问题
   */
  async regenerateManifest() {
    try {
      const manifestPath = path.join(this.taskDir, 'training_manifest.jsonl');
      
      // 检查文件是否存在
      if (!fs.existsSync(manifestPath)) {
        console.log('[UnifiedEventManager] Manifest file not found, skipping regeneration');
        return;
      }
      
      // 读取所有行
      const content = fs.readFileSync(manifestPath, 'utf8');
      const lines = content.split('\n').filter(line => line.trim());
      
      // 使用 Map 去重，保留最新版本（后出现的覆盖先出现的）
      const eventMap = new Map();
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.eventId) {
            eventMap.set(event.eventId, event);
          }
        } catch (e) {
          console.warn('[UnifiedEventManager] Failed to parse event line:', e.message);
        }
      }
      
      // 按时间戳排序
      const uniqueEvents = Array.from(eventMap.values()).sort((a, b) => a.timestamp - b.timestamp);
      
      // 重新写入文件
      const newContent = uniqueEvents.map(e => JSON.stringify(e)).join('\n') + '\n';
      fs.writeFileSync(manifestPath, newContent);
      
      console.log('[UnifiedEventManager] Manifest regenerated:', 
        'original lines:', lines.length, 
        'unique events:', uniqueEvents.length,
        'duplicates removed:', lines.length - uniqueEvents.length);
    } catch (error) {
      console.error('[UnifiedEventManager] Failed to regenerate manifest:', error);
    }
  }
}

module.exports = UnifiedEventManager;
