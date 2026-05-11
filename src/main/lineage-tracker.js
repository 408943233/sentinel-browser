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
 * 谱系追踪器
 * 追踪多窗口、多标签页的谱系关系
 */
class LineageTracker {
  constructor() {
    this.windows = new Map();
    this.events = [];
    this.relationships = new Map();
  }

  /**
   * 注册窗口
   */
  registerWindow(windowId, options = {}) {
    const windowInfo = {
      id: windowId,
      parentId: options.parentId || null,
      openerActionId: options.openerActionId || null,
      url: options.url || '',
      title: options.title || '',
      createdAt: Date.now(),
      closedAt: null,
      children: [],
      events: []
    };

    this.windows.set(windowId, windowInfo);

    // 建立父子关系
    if (options.parentId) {
      const parent = this.windows.get(options.parentId);
      if (parent) {
        parent.children.push(windowId);
        this.relationships.set(windowId, {
          type: 'child_of',
          parentId: options.parentId,
          actionId: options.openerActionId
        });
      }
    }

    log.info(`Window registered: ${windowId}, parent: ${options.parentId || 'none'}`);
    return windowInfo;
  }

  /**
   * 注销窗口
   */
  unregisterWindow(windowId) {
    const window = this.windows.get(windowId);
    if (window) {
      window.closedAt = Date.now();
      log.info(`Window unregistered: ${windowId}`);
    }
  }

  /**
   * 记录事件
   */
  recordEvent(windowId, eventData) {
    const event = {
      id: `evt_${generateUUID().slice(0, 8)}`,
      windowId,
      timestamp: Date.now(),
      ...eventData
    };

    this.events.push(event);

    // 关联到窗口
    const window = this.windows.get(windowId);
    if (window) {
      window.events.push(event.id);
    }

    // 更新事件链
    this.updateEventChain(event);

    return event;
  }

  /**
   * 更新事件链
   */
  updateEventChain(event) {
    const windowEvents = this.events.filter(e => e.windowId === event.windowId);
    
    if (windowEvents.length > 1) {
      const previousEvent = windowEvents[windowEvents.length - 2];
      event.previousEventId = previousEvent.id;
      previousEvent.nextEventId = event.id;
    }
  }

  /**
   * 获取窗口谱系
   */
  getWindowLineage(windowId) {
    const window = this.windows.get(windowId);
    if (!window) return null;

    const lineage = {
      window: { ...window },
      ancestors: this.getAncestors(windowId),
      descendants: this.getDescendants(windowId),
      siblings: this.getSiblings(windowId)
    };

    return lineage;
  }

  /**
   * 获取祖先窗口
   */
  getAncestors(windowId) {
    const ancestors = [];
    let currentId = windowId;

    while (currentId) {
      const relationship = this.relationships.get(currentId);
      if (relationship && relationship.parentId) {
        const parent = this.windows.get(relationship.parentId);
        if (parent) {
          ancestors.push({
            windowId: parent.id,
            actionId: relationship.actionId,
            url: parent.url
          });
          currentId = parent.id;
        } else {
          break;
        }
      } else {
        break;
      }
    }

    return ancestors.reverse();
  }

  /**
   * 获取后代窗口
   */
  getDescendants(windowId) {
    const window = this.windows.get(windowId);
    if (!window) return [];

    const descendants = [];
    
    const collectDescendants = (parentId) => {
      const parent = this.windows.get(parentId);
      if (!parent) return;

      parent.children.forEach(childId => {
        const child = this.windows.get(childId);
        if (child) {
          descendants.push({
            windowId: child.id,
            url: child.url,
            createdAt: child.createdAt
          });
          collectDescendants(childId);
        }
      });
    };

    collectDescendants(windowId);
    return descendants;
  }

  /**
   * 获取兄弟窗口
   */
  getSiblings(windowId) {
    const window = this.windows.get(windowId);
    if (!window || !window.parentId) return [];

    const parent = this.windows.get(window.parentId);
    if (!parent) return [];

    return parent.children
      .filter(id => id !== windowId)
      .map(id => {
        const sibling = this.windows.get(id);
        return {
          windowId: sibling.id,
          url: sibling.url,
          createdAt: sibling.createdAt
        };
      });
  }

  /**
   * 获取窗口事件序列
   */
  getWindowEvents(windowId, options = {}) {
    const window = this.windows.get(windowId);
    if (!window) return [];

    let events = this.events.filter(e => e.windowId === windowId);

    // 时间范围过滤
    if (options.startTime) {
      events = events.filter(e => e.timestamp >= options.startTime);
    }
    if (options.endTime) {
      events = events.filter(e => e.timestamp <= options.endTime);
    }

    // 事件类型过滤
    if (options.types) {
      events = events.filter(e => options.types.includes(e.type));
    }

    return events;
  }

  /**
   * 获取完整的谱系树
   */
  getLineageTree() {
    const roots = [];
    
    this.windows.forEach((window, id) => {
      if (!window.parentId) {
        roots.push(this.buildTreeNode(id));
      }
    });

    return roots;
  }

  /**
   * 构建树节点
   */
  buildTreeNode(windowId) {
    const window = this.windows.get(windowId);
    if (!window) return null;

    return {
      id: window.id,
      url: window.url,
      title: window.title,
      createdAt: window.createdAt,
      closedAt: window.closedAt,
      eventCount: window.events.length,
      children: window.children.map(childId => this.buildTreeNode(childId)).filter(Boolean)
    };
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const stats = {
      totalWindows: this.windows.size,
      activeWindows: 0,
      totalEvents: this.events.length,
      windowTypes: {},
      averageEventsPerWindow: 0
    };

    this.windows.forEach(window => {
      if (!window.closedAt) {
        stats.activeWindows++;
      }
    });

    if (this.windows.size > 0) {
      stats.averageEventsPerWindow = this.events.length / this.windows.size;
    }

    return stats;
  }

  /**
   * 导出谱系数据
   */
  exportLineage() {
    return {
      timestamp: Date.now(),
      windows: Array.from(this.windows.values()),
      events: this.events,
      relationships: Array.from(this.relationships.entries()),
      tree: this.getLineageTree(),
      stats: this.getStats()
    };
  }

  /**
   * 清理已关闭的窗口数据
   */
  cleanupClosedWindows(maxAge = 24 * 60 * 60 * 1000) { // 默认24小时
    const now = Date.now();
    
    this.windows.forEach((window, id) => {
      if (window.closedAt && (now - window.closedAt > maxAge)) {
        this.windows.delete(id);
        this.relationships.delete(id);
      }
    });

    // 清理孤立事件
    const validWindowIds = new Set(this.windows.keys());
    this.events = this.events.filter(e => validWindowIds.has(e.windowId));
  }

  /**
   * 查找相关事件
   */
  findRelatedEvents(eventId) {
    const event = this.events.find(e => e.id === eventId);
    if (!event) return null;

    const related = {
      event,
      previous: this.events.find(e => e.id === event.previousEventId),
      next: this.events.find(e => e.id === event.nextEventId),
      sameWindow: this.events.filter(e => 
        e.windowId === event.windowId && e.id !== event.id
      ),
      sameType: this.events.filter(e => 
        e.type === event.type && e.id !== event.id
      )
    };

    return related;
  }
}

module.exports = LineageTracker;
