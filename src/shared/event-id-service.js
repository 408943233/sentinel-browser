/**
 * ============================================================================
 * 统一 Event ID 生成服务
 * ============================================================================
 * 
 * 【核心职责】
 * 1. 提供全局唯一的 Event ID 生成
 * 2. 确保所有组件使用统一的 ID 格式
 * 3. 提供降级生成能力，确保系统容错性
 * 
 * 【ID 格式】
 * 格式: {type}_{timestamp}_{counter}_{random}
 * 示例: evt_1778743560380_042_abc123def
 * 
 * 【使用方式】
 * 1. 优先使用传入的 eventId（继承上下文）
 * 2. 没有传入时，调用 generateId() 生成新的
 * 3. 使用 ensureId() 确保一定有有效 ID
 * 
 * 【类型前缀】
 * - evt: 通用事件
 * - evt_page_load: 页面加载事件
 * - evt_orphan: 孤儿请求事件
 * - req: 网络请求
 * - ws: WebSocket
 * - win: 窗口事件
 * ============================================================================
 */

const logger = require('./logger');
const log = logger.create('EventIdService');

class EventIdService {
  constructor() {
    this.counter = 0;
    this.lastTimestamp = 0;
    this.stats = {
      totalGenerated: 0,
      fallbackGenerated: 0,
      byType: new Map()
    };
    
    // 启动统计上报
    this.startStatsReporting();
  }

  /**
   * 生成唯一 Event ID
   * @param {string} type - ID 类型前缀 (默认 'evt')
   * @param {Object} metadata - 元数据（用于日志和调试）
   * @returns {string} 唯一 Event ID
   */
  generateId(type = 'evt', metadata = {}) {
    const timestamp = Date.now();
    
    // 确保计数器在同一毫秒内递增
    if (timestamp === this.lastTimestamp) {
      this.counter++;
    } else {
      this.counter = 1;
      this.lastTimestamp = timestamp;
    }
    
    const random = Math.random().toString(36).substr(2, 9);
    const eventId = `${type}_${timestamp}_${this.counter.toString().padStart(3, '0')}_${random}`;
    
    // 统计
    this.stats.totalGenerated++;
    const typeCount = this.stats.byType.get(type) || 0;
    this.stats.byType.set(type, typeCount + 1);
    
    log.debug('EventId generated:', eventId, metadata);
    return eventId;
  }

  /**
   * 确保返回有效的 Event ID
   * 优先使用传入的，无效时降级生成
   * 
   * @param {string|null} eventId - 传入的 eventId
   * @param {string} fallbackType - 降级生成时的类型
   * @param {Object} metadata - 元数据
   * @returns {string} 有效的 Event ID
   */
  ensureId(eventId, fallbackType = 'evt', metadata = {}) {
    // 验证传入的 ID
    if (eventId && this.validateId(eventId)) {
      return eventId;
    }
    
    // 降级生成
    this.stats.fallbackGenerated++;
    const newId = this.generateId(fallbackType, {
      ...metadata,
      fallback: true,
      requestedId: eventId
    });
    
    log.warn('EventId fallback generated:', {
      requested: eventId,
      generated: newId,
      reason: metadata.reason || 'invalid-or-missing',
      source: metadata.source
    });
    
    return newId;
  }

  /**
   * 验证 Event ID 格式
   * @param {string} eventId - 要验证的 ID
   * @returns {boolean} 是否有效
   */
  validateId(eventId) {
    if (typeof eventId !== 'string') return false;
    
    // 格式: {type}_{timestamp}_{counter}_{random}
    // type: evt, req, ws, orphan, page_load 等
    // timestamp: 13位数字
    // counter: 3位数字
    // random: 9位字母数字
    const pattern = /^(evt|evt_page_load|evt_orphan|req|ws|sse|beacon|pm|bc|idb|cache|win|orphan)_\d{13}_\d{3}_[a-z0-9]{9}$/;
    return pattern.test(eventId);
  }

  /**
   * 解析 Event ID
   * @param {string} eventId - Event ID
   * @returns {Object|null} 解析结果
   */
  parseId(eventId) {
    if (!this.validateId(eventId)) return null;
    
    const parts = eventId.split('_');
    return {
      prefix: parts[0],
      timestamp: parseInt(parts[1]),
      counter: parseInt(parts[2]),
      random: parts[3]
    };
  }

  /**
   * 从 eventId 生成 snapshot 文件名
   * 使用 eventId 作为文件名，确保 100% 关联
   * 
   * @param {string} eventId - Event ID
   * @param {string} extension - 文件扩展名 (默认 'json')
   * @returns {string} 文件名
   */
  getSnapshotFileName(eventId, extension = 'json') {
    if (!eventId || !this.validateId(eventId)) {
      // 降级使用时间戳
      log.warn('Invalid eventId for snapshot filename, using timestamp fallback');
      return `snapshot_${Date.now()}.${extension}`;
    }
    return `${eventId}.${extension}`;
  }

  /**
   * 获取统计信息
   * @returns {Object} 统计对象
   */
  getStats() {
    return {
      totalGenerated: this.stats.totalGenerated,
      fallbackGenerated: this.stats.fallbackGenerated,
      fallbackRate: this.stats.totalGenerated > 0 
        ? (this.stats.fallbackGenerated / this.stats.totalGenerated * 100).toFixed(2) + '%'
        : '0%',
      byType: Object.fromEntries(this.stats.byType)
    };
  }

  /**
   * 启动统计上报
   */
  startStatsReporting() {
    setInterval(() => {
      const stats = this.getStats();
      if (stats.totalGenerated > 0) {
        log.info('EventIdService stats:', stats);
      }
    }, 60000); // 每分钟上报
  }
}

// 单例实例
let instance = null;

function getInstance() {
  if (!instance) {
    instance = new EventIdService();
  }
  return instance;
}

// 模块导出
module.exports = {
  // 获取单例
  getInstance,
  
  // 便捷方法
  generateId: (...args) => getInstance().generateId(...args),
  ensureId: (...args) => getInstance().ensureId(...args),
  validateId: (...args) => getInstance().validateId(...args),
  parseId: (...args) => getInstance().parseId(...args),
  getSnapshotFileName: (...args) => getInstance().getSnapshotFileName(...args),
  getStats: () => getInstance().getStats()
};
