/**
 * ============================================================================
 * 增强日志工具模块
 * ============================================================================
 * 
 * 【核心职责】
 * 1. 提供统一的日志格式和级别控制
 * 2. 支持详细的调试信息输出
 * 3. 支持日志分类和标签
 * 4. 支持性能计时和内存监控
 * 5. 支持上下文追踪
 * 
 * 【日志级别】
 * - DEBUG: 详细的调试信息
 * - INFO: 一般信息
 * - WARN: 警告信息
 * - ERROR: 错误信息
 * - FATAL: 致命错误
 * 
 * 【使用示例】
 * const logger = require('./logger');
 * const log = logger.create('ModuleName');
 * 
 * log.debug('调试信息', { detail: 'value' });
 * log.info('一般信息');
 * log.warn('警告信息', { context: 'data' });
 * log.error('错误信息', error);
 * log.fatal('致命错误', error);
 * 
 * // 性能计时
 * const timer = log.timer('operation');
 * // ... 执行操作
 * timer.end();
 * 
 * // 内存监控
 * log.memory('checkpoint');
 * ============================================================================
 */

const log = require('electron-log');

// 日志级别
const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  FATAL: 4
};

// 当前日志级别（可在运行时调整）
let currentLogLevel = LogLevel.DEBUG;

// 是否启用详细模式
let verboseMode = true;

// 是否启用性能计时
let timingEnabled = true;

// 是否启用内存监控
let memoryTrackingEnabled = true;

/**
 * 格式化日志消息
 * @param {string} level - 日志级别
 * @param {string} module - 模块名
 * @param {string} message - 消息
 * @param {Object} meta - 元数据
 * @returns {string} 格式化后的消息
 */
function formatMessage(level, module, message, meta = {}) {
  const timestamp = new Date().toISOString();
  const pid = process.pid;
  const memory = process.memoryUsage();
  
  let formatted = `[${timestamp}] [${level}] [${module}] [PID:${pid}] ${message}`;
  
  if (verboseMode && Object.keys(meta).length > 0) {
    try {
      const metaStr = JSON.stringify(meta, null, 2);
      formatted += `\n  Metadata: ${metaStr}`;
    } catch (e) {
      formatted += `\n  Metadata: [无法序列化]`;
    }
  }
  
  if (memoryTrackingEnabled) {
    formatted += `\n  Memory: heapUsed=${(memory.heapUsed / 1024 / 1024).toFixed(2)}MB, heapTotal=${(memory.heapTotal / 1024 / 1024).toFixed(2)}MB, rss=${(memory.rss / 1024 / 1024).toFixed(2)}MB`;
  }
  
  return formatted;
}

/**
 * 创建模块日志器
 * @param {string} moduleName - 模块名称
 * @returns {Object} 日志器对象
 */
function create(moduleName) {
  return {
    /**
     * 调试日志
     * @param {string} message - 消息
     * @param {Object} meta - 元数据
     */
    debug(message, meta = {}) {
      if (currentLogLevel <= LogLevel.DEBUG) {
        const formatted = formatMessage('DEBUG', moduleName, message, meta);
        log.debug(formatted);
        console.log(formatted);
      }
    },

    /**
     * 信息日志
     * @param {string} message - 消息
     * @param {Object} meta - 元数据
     */
    info(message, meta = {}) {
      if (currentLogLevel <= LogLevel.INFO) {
        const formatted = formatMessage('INFO', moduleName, message, meta);
        log.info(formatted);
        console.log(formatted);
      }
    },

    /**
     * 警告日志
     * @param {string} message - 消息
     * @param {Object} meta - 元数据
     */
    warn(message, meta = {}) {
      if (currentLogLevel <= LogLevel.WARN) {
        const formatted = formatMessage('WARN', moduleName, message, meta);
        log.warn(formatted);
        console.warn(formatted);
      }
    },

    /**
     * 错误日志
     * @param {string} message - 消息
     * @param {Error|Object} error - 错误对象
     * @param {Object} meta - 元数据
     */
    error(message, error = null, meta = {}) {
      if (currentLogLevel <= LogLevel.ERROR) {
        const errorInfo = error ? {
          message: error.message,
          stack: error.stack,
          name: error.name,
          code: error.code
        } : null;
        
        const fullMeta = { ...meta, error: errorInfo };
        const formatted = formatMessage('ERROR', moduleName, message, fullMeta);
        log.error(formatted);
        console.error(formatted);
      }
    },

    /**
     * 致命错误日志
     * @param {string} message - 消息
     * @param {Error|Object} error - 错误对象
     * @param {Object} meta - 元数据
     */
    fatal(message, error = null, meta = {}) {
      const errorInfo = error ? {
        message: error.message,
        stack: error.stack,
        name: error.name,
        code: error.code
      } : null;
      
      const fullMeta = { ...meta, error: errorInfo };
      const formatted = formatMessage('FATAL', moduleName, message, fullMeta);
      log.error(formatted);
      console.error(formatted);
    },

    /**
     * 性能计时器
     * @param {string} operation - 操作名称
     * @returns {Object} 计时器对象
     */
    timer(operation) {
      if (!timingEnabled) {
        return {
          end: () => {},
          checkpoint: () => {}
        };
      }

      const startTime = process.hrtime.bigint();
      const startMemory = process.memoryUsage();
      
      return {
        /**
         * 记录检查点
         * @param {string} label - 检查点标签
         */
        checkpoint(label = '') {
          const currentTime = process.hrtime.bigint();
          const elapsed = Number(currentTime - startTime) / 1000000; // 转换为毫秒
          const currentMemory = process.memoryUsage();
          
          const checkpointMeta = {
            operation,
            checkpoint: label,
            elapsedMs: elapsed.toFixed(2),
            memoryDelta: {
              heapUsed: ((currentMemory.heapUsed - startMemory.heapUsed) / 1024 / 1024).toFixed(2) + 'MB',
              rss: ((currentMemory.rss - startMemory.rss) / 1024 / 1024).toFixed(2) + 'MB'
            }
          };
          
          const formatted = formatMessage('TIMER', moduleName, `Checkpoint: ${operation}${label ? ' - ' + label : ''}`, checkpointMeta);
          log.debug(formatted);
          console.log(formatted);
        },

        /**
         * 结束计时
         * @param {Object} meta - 额外元数据
         */
        end(meta = {}) {
          const endTime = process.hrtime.bigint();
          const elapsed = Number(endTime - startTime) / 1000000; // 转换为毫秒
          const endMemory = process.memoryUsage();
          
          const timerMeta = {
            operation,
            totalMs: elapsed.toFixed(2),
            memoryUsed: {
              heapUsed: ((endMemory.heapUsed - startMemory.heapUsed) / 1024 / 1024).toFixed(2) + 'MB',
              heapTotal: ((endMemory.heapTotal - startMemory.heapTotal) / 1024 / 1024).toFixed(2) + 'MB',
              rss: ((endMemory.rss - startMemory.rss) / 1024 / 1024).toFixed(2) + 'MB'
            },
            ...meta
          };
          
          const formatted = formatMessage('TIMER', moduleName, `Completed: ${operation}`, timerMeta);
          log.debug(formatted);
          console.log(formatted);
        }
      };
    },

    /**
     * 内存监控
     * @param {string} label - 监控点标签
     */
    memory(label = '') {
      if (!memoryTrackingEnabled) return;
      
      const memory = process.memoryUsage();
      const meta = {
        label,
        heapUsed: (memory.heapUsed / 1024 / 1024).toFixed(2) + 'MB',
        heapTotal: (memory.heapTotal / 1024 / 1024).toFixed(2) + 'MB',
        rss: (memory.rss / 1024 / 1024).toFixed(2) + 'MB',
        external: (memory.external / 1024 / 1024).toFixed(2) + 'MB',
        arrayBuffers: (memory.arrayBuffers / 1024 / 1024).toFixed(2) + 'MB'
      };
      
      const formatted = formatMessage('MEMORY', moduleName, `Memory checkpoint${label ? ': ' + label : ''}`, meta);
      log.debug(formatted);
      console.log(formatted);
    },

    /**
     * 追踪函数调用
     * @param {string} functionName - 函数名
     * @param {Array} args - 参数列表
     * @param {Object} meta - 元数据
     */
    trace(functionName, args = [], meta = {}) {
      if (currentLogLevel <= LogLevel.DEBUG) {
        const traceMeta = {
          function: functionName,
          args: args.map(arg => {
            if (typeof arg === 'object') {
              try {
                return JSON.stringify(arg).substring(0, 200);
              } catch {
                return '[Object]';
              }
            }
            return String(arg).substring(0, 100);
          }),
          ...meta
        };
        
        const formatted = formatMessage('TRACE', moduleName, `Function call: ${functionName}`, traceMeta);
        log.debug(formatted);
        console.log(formatted);
      }
    },

    /**
     * 状态变更日志
     * @param {string} entity - 实体名称
     * @param {string} property - 属性名
     * @param {*} oldValue - 旧值
     * @param {*} newValue - 新值
     * @param {Object} meta - 元数据
     */
    stateChange(entity, property, oldValue, newValue, meta = {}) {
      const stateMeta = {
        entity,
        property,
        oldValue: String(oldValue).substring(0, 100),
        newValue: String(newValue).substring(0, 100),
        ...meta
      };
      
      const formatted = formatMessage('STATE', moduleName, `State change: ${entity}.${property}`, stateMeta);
      log.debug(formatted);
      console.log(formatted);
    },

    /**
     * 数据流日志
     * @param {string} direction - 流向 (in/out)
     * @param {string} type - 数据类型
     * @param {Object} data - 数据内容
     * @param {Object} meta - 元数据
     */
    dataFlow(direction, type, data = {}, meta = {}) {
      const flowMeta = {
        direction,
        type,
        dataSize: JSON.stringify(data).length,
        dataPreview: JSON.stringify(data).substring(0, 200),
        ...meta
      };
      
      const formatted = formatMessage('DATA', moduleName, `Data flow: ${direction} - ${type}`, flowMeta);
      log.debug(formatted);
      console.log(formatted);
    }
  };
}

/**
 * 设置日志级别
 * @param {number} level - 日志级别
 */
function setLogLevel(level) {
  currentLogLevel = level;
}

/**
 * 设置详细模式
 * @param {boolean} enabled - 是否启用
 */
function setVerboseMode(enabled) {
  verboseMode = enabled;
}

/**
 * 设置性能计时
 * @param {boolean} enabled - 是否启用
 */
function setTimingEnabled(enabled) {
  timingEnabled = enabled;
}

/**
 * 设置内存监控
 * @param {boolean} enabled - 是否启用
 */
function setMemoryTrackingEnabled(enabled) {
  memoryTrackingEnabled = enabled;
}

module.exports = {
  create,
  LogLevel,
  setLogLevel,
  setVerboseMode,
  setTimingEnabled,
  setMemoryTrackingEnabled
};
