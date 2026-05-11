const log = require('electron-log');

// 简单的UUID生成函数（不依赖外部模块）
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * 数据Schema管理器
 * 确保所有数据条目严格遵循统一的JSON结构
 */
class DataSchemaManager {
  constructor() {
    this.currentTask = null;
    this.previousEventId = null;
    this.eventCounter = 0;
  }

  /**
   * 设置当前任务
   */
  setCurrentTask(task) {
    this.currentTask = task;
    this.previousEventId = null;
    this.eventCounter = 0;
  }

  /**
   * 生成完整的标准数据条目
   * 严格遵循需求文档中的JSON Schema，严禁缺少字段
   */
  generateEvent(eventType, data = {}) {
    console.log('[DataSchema] generateEvent called with eventType:', eventType, 'apiRequests:', data.apiRequests);
    if (!this.currentTask) {
      log.error('No current task set');
      return null;
    }

    this.eventCounter++;
    const eventId = `evt_${Date.now()}_${this.eventCounter.toString().padStart(3, '0')}`;

    // 计算视频时间（从任务开始时间算起）
    const videoTime = this.calculateVideoTime();

    // 构建标准数据结构
    const event = {
      // 基础时间信息
      timestamp: Date.now(),
      video_time: videoTime,

      // 任务标识
      task_id: this.currentTask.id,
      sub_task_id: data.subTaskId || this.currentTask.config.subTaskId || null,

      // 窗口上下文
      window_context: {
        window_id: data.windowId || null,
        parent_window_id: data.parentWindowId || null,
        url: data.url || null
      },

      // 用户上下文（从任务配置中获取）
      user_context: {
        user_id: this.currentTask.config.userId || null,
        role: this.currentTask.config.role || null,
        permissions: this.currentTask.config.permissions || [],
        env: this.currentTask.config.env || null
      },

      // 事件详情
      event_details: {
        action: eventType,
        semantic_label: data.semanticLabel || null,
        dom_path: data.domPath || null,
        shadow_dom_path: data.shadowDomPath || null,
        coordinates: data.coordinates || null
      },

      // 文件I/O
      file_io: {
        type: data.fileType || null, // 'download', 'upload', 'preview', 'blob'
        local_path: data.localPath || null,
        content_summary: data.contentSummary || null
      },

      // 页面状态
      page_state: {
        fingerprint: data.pageFingerprint || null,
        has_errors: data.hasErrors || false,
        is_loading: data.isLoading || false,
        mutations: data.mutations || []
      },

      // 网络关联
      network_correlation: {
        api_requests: data.apiRequests || [],
        resources: data.resources || [],
        response_status: data.responseStatus || null
      },

      // 谱系关系
      lineage: {
        previous_event_id: this.previousEventId,
        next_event_id: null // 将在下一个事件生成时更新
      },

      // 扩展字段（用于存储额外信息）
      _metadata: {
        event_id: eventId,
        ...data.metadata
      }
    };

    // 更新前一个事件的next_event_id
    if (this.previousEventId) {
      // 这里需要在manifest中更新前一个事件，但由于是追加写入，
      // 我们只能在内存中维护这个关系，或者在最终处理时更新
    }

    this.previousEventId = eventId;

    return event;
  }

  /**
   * 生成用户操作事件
   */
  generateUserActionEvent(action, details) {
    return this.generateEvent(action, {
      semanticLabel: details.semanticLabel,
      domPath: details.domPath,
      shadowDomPath: details.shadowDomPath,
      coordinates: details.coordinates,
      windowId: details.windowId,
      url: details.url,
      pageFingerprint: details.pageFingerprint,
      hasErrors: details.hasErrors,
      apiRequests: details.apiRequests,
      responseStatus: details.responseStatus,
      metadata: details.metadata
    });
  }

  /**
   * 生成文件I/O事件
   */
  generateFileIOEvent(ioType, details) {
    return this.generateEvent('file_io', {
      fileType: ioType,
      localPath: details.localPath,
      contentSummary: details.contentSummary,
      windowId: details.windowId,
      url: details.url,
      metadata: {
        fileName: details.fileName,
        fileSize: details.fileSize,
        mimeType: details.mimeType
      }
    });
  }

  /**
   * 生成错误事件
   */
  generateErrorEvent(errorType, details) {
    return this.generateEvent('error', {
      semanticLabel: `${errorType} error detected`,
      windowId: details.windowId,
      url: details.url,
      hasErrors: true,
      metadata: {
        errorType: errorType,
        errorMessage: details.message,
        errorStack: details.stack
      }
    });
  }

  /**
   * 生成网络事件
   */
  generateNetworkEvent(details) {
    return this.generateEvent('network', {
      windowId: details.windowId,
      url: details.url,
      apiRequests: [details.requestId],
      responseStatus: details.status,
      metadata: {
        method: details.method,
        requestHeaders: details.requestHeaders,
        responseHeaders: details.responseHeaders
      }
    });
  }

  /**
   * 生成页面状态事件
   */
  generatePageStateEvent(details) {
    return this.generateEvent('page_state', {
      windowId: details.windowId,
      url: details.url,
      pageFingerprint: details.fingerprint,
      hasErrors: details.hasErrors,
      isLoading: details.isLoading,
      mutations: details.mutations
    });
  }

  /**
   * 生成用户上下文事件（暂停/恢复等）
   */
  generateUserContextEvent(details) {
    return this.generateEvent('user_context', {
      semanticLabel: details.description || details.type,
      windowId: details.windowId,
      url: details.url,
      metadata: {
        contextType: details.type,
        description: details.description
      }
    });
  }

  /**
   * 计算视频时间码
   */
  calculateVideoTime() {
    if (!this.currentTask || !this.currentTask.startTime) {
      return '00:00:00.000';
    }

    const elapsed = Date.now() - this.currentTask.startTime;
    return this.formatTimeCode(elapsed);
  }

  /**
   * 格式化时间码
   */
  formatTimeCode(milliseconds) {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const ms = milliseconds % 1000;

    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
  }

  /**
   * 验证数据完整性
   */
  validateEvent(event) {
    const requiredFields = [
      'timestamp',
      'video_time',
      'task_id',
      'window_context',
      'user_context',
      'event_details',
      'file_io',
      'page_state',
      'network_correlation',
      'lineage'
    ];

    const missingFields = requiredFields.filter(field => !(field in event));

    if (missingFields.length > 0) {
      log.error(`Event validation failed, missing fields: ${missingFields.join(', ')}`);
      return false;
    }

    // 验证嵌套字段
    if (!event.window_context || typeof event.window_context !== 'object') {
      log.error('Event validation failed: window_context must be an object');
      return false;
    }

    if (!event.user_context || typeof event.user_context !== 'object') {
      log.error('Event validation failed: user_context must be an object');
      return false;
    }

    if (!event.event_details || typeof event.event_details !== 'object') {
      log.error('Event validation failed: event_details must be an object');
      return false;
    }

    if (!event.file_io || typeof event.file_io !== 'object') {
      log.error('Event validation failed: file_io must be an object');
      return false;
    }

    if (!event.page_state || typeof event.page_state !== 'object') {
      log.error('Event validation failed: page_state must be an object');
      return false;
    }

    if (!event.network_correlation || typeof event.network_correlation !== 'object') {
      log.error('Event validation failed: network_correlation must be an object');
      return false;
    }

    if (!event.lineage || typeof event.lineage !== 'object') {
      log.error('Event validation failed: lineage must be an object');
      return false;
    }

    return true;
  }

  /**
   * 清理数据（移除undefined值，替换为null）
   */
  sanitizeEvent(event) {
    const sanitized = JSON.parse(JSON.stringify(event, (key, value) => {
      if (value === undefined) {
        return null;
      }
      return value;
    }));

    return sanitized;
  }

  /**
   * 生成页面状态指纹
   * 基于URL、标题和DOM结构特征生成唯一标识
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
          buttons: domStats.buttons || 0,
          links: domStats.links || 0,
          forms: domStats.forms || 0,
          inputs: domStats.inputs || 0,
          images: domStats.images || 0
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
      log.error('Failed to generate page fingerprint:', error);
      return null;
    }
  }

  /**
   * 简单的字符串哈希函数
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
   */
  inferPageType(path, title) {
    const pathLower = path.toLowerCase();
    const titleLower = (title || '').toLowerCase();
    
    // 基于路径模式推断
    if (pathLower.includes('login') || pathLower.includes('signin')) return 'login';
    if (pathLower.includes('register') || pathLower.includes('signup')) return 'register';
    if (pathLower.includes('search')) return 'search';
    if (pathLower.includes('product') || pathLower.includes('item')) return 'product';
    if (pathLower.includes('cart') || pathLower.includes('basket')) return 'cart';
    if (pathLower.includes('checkout') || pathLower.includes('payment')) return 'checkout';
    if (pathLower.includes('order')) return 'order';
    if (pathLower.includes('profile') || pathLower.includes('account')) return 'profile';
    if (pathLower.includes('admin') || pathLower.includes('manage')) return 'admin';
    if (pathLower.includes('list') || pathLower.includes('category')) return 'list';
    if (pathLower.includes('detail') || pathLower.includes('view')) return 'detail';
    if (pathLower.includes('home') || pathLower === '/' || pathLower === '/index') return 'home';
    
    // 基于标题推断
    if (titleLower.includes('首页') || titleLower.includes('home')) return 'home';
    if (titleLower.includes('登录') || titleLower.includes('login')) return 'login';
    if (titleLower.includes('注册') || titleLower.includes('register')) return 'register';
    if (titleLower.includes('搜索') || titleLower.includes('search')) return 'search';
    if (titleLower.includes('详情') || titleLower.includes('detail')) return 'detail';
    if (titleLower.includes('列表') || titleLower.includes('list')) return 'list';
    
    return 'other';
  }

  /**
   * 推断用户意图
   * 基于操作类型、元素特征和上下文推断用户意图
   */
  inferUserIntent(action, elementData = {}, url = '') {
    const intents = [];
    
    // 基于操作类型的基础意图
    switch (action) {
      case 'click':
        intents.push('interact');
        break;
      case 'input':
        intents.push('enter_data');
        break;
      case 'keydown':
        if (elementData.key === 'Enter') {
          intents.push('submit');
        } else {
          intents.push('navigate_or_edit');
        }
        break;
      case 'scroll':
        intents.push('browse_content');
        break;
      case 'page-load':
        intents.push('navigate');
        break;
      default:
        intents.push('interact');
    }
    
    // 基于元素文本的意图推断
    const text = (elementData.text || '').toLowerCase().trim();
    const selector = (elementData.selector || '').toLowerCase();
    
    // 提交类
    if (text.includes('提交') || text.includes('保存') || text.includes('确认') || 
        text.includes('submit') || text.includes('save') || text.includes('confirm')) {
      intents.push('submit_form');
    }
    
    // 搜索类
    if (text.includes('搜索') || text.includes('查询') || text.includes('search') || 
        selector.includes('search') || selector.includes('query')) {
      intents.push('search');
    }
    
    // 导航类
    if (text.includes('返回') || text.includes('上一页') || text.includes('back') ||
        text.includes('首页') || text.includes('home')) {
      intents.push('navigate');
    }
    
    // 登录/认证类
    if (text.includes('登录') || text.includes('注册') || text.includes('login') || 
        text.includes('register') || text.includes('sign')) {
      intents.push('authenticate');
    }
    
    // 购买/交易类
    if (text.includes('购买') || text.includes('下单') || text.includes('支付') ||
        text.includes('buy') || text.includes('order') || text.includes('pay')) {
      intents.push('purchase');
    }
    
    // 下载类
    if (text.includes('下载') || text.includes('导出') || text.includes('download') ||
        text.includes('export')) {
      intents.push('download');
    }
    
    // 基于输入框类型的意图
    if (action === 'input') {
      const inputType = elementData.inputType || 'text';
      const name = (elementData.name || '').toLowerCase();
      
      if (name.includes('user') || name.includes('name') || name.includes('账号')) {
        intents.push('enter_username');
      }
      if (name.includes('pass') || name.includes('密码') || name.includes('pwd')) {
        intents.push('enter_password');
      }
      if (name.includes('search') || name.includes('query') || name.includes('搜索')) {
        intents.push('enter_search_query');
      }
      if (name.includes('email') || name.includes('邮箱')) {
        intents.push('enter_email');
      }
      if (name.includes('phone') || name.includes('mobile') || name.includes('电话')) {
        intents.push('enter_phone');
      }
      if (inputType === 'password') {
        intents.push('enter_sensitive_data');
      }
    }
    
    // 去重并返回
    return [...new Set(intents)];
  }

  /**
   * 生成增强的用户操作事件
   * 包含页面指纹和用户意图
   */
  generateEnhancedUserActionEvent(action, details) {
    // 生成页面指纹
    const pageFingerprint = this.generatePageFingerprint(
      details.url,
      details.title,
      details.domStats
    );
    
    // 推断用户意图
    const userIntents = this.inferUserIntent(action, {
      text: details.text,
      selector: details.selector,
      inputType: details.inputType,
      name: details.name,
      key: details.key
    }, details.url);
    
    return this.generateEvent(action, {
      semanticLabel: details.semanticLabel,
      domPath: details.domPath,
      shadowDomPath: details.shadowDomPath,
      coordinates: details.coordinates,
      windowId: details.windowId,
      url: details.url,
      pageFingerprint: pageFingerprint,
      hasErrors: details.hasErrors,
      isLoading: details.isLoading,
      apiRequests: details.apiRequests,
      responseStatus: details.responseStatus,
      metadata: {
        ...details.metadata,
        user_intents: userIntents,
        page_type: pageFingerprint?.details?.page_type || 'unknown'
      }
    });
  }
}

module.exports = DataSchemaManager;
