/**
 * 共享工具函数
 */

// 简单的UUID生成函数（不依赖外部模块）
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// 格式化时间戳
function formatTimestamp(timestamp) {
  return new Date(timestamp).toISOString();
}

// 安全的JSON序列化
function safeJSONStringify(obj, space = 2) {
  try {
    return JSON.stringify(obj, null, space);
  } catch (error) {
    return JSON.stringify({ error: 'Failed to stringify object', message: error.message });
  }
}

// 深度合并对象
function deepMerge(target, source) {
  const result = { ...target };
  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// ==================== 统一错误处理 ====================

/**
 * 错误严重级别
 */
const ErrorSeverity = {
  DEBUG: 'debug',
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
  CRITICAL: 'critical'
};

/**
 * 错误类型
 */
const ErrorType = {
  SYSTEM: 'system',
  NETWORK: 'network',
  FILE_IO: 'file_io',
  VALIDATION: 'validation',
  RUNTIME: 'runtime',
  UNKNOWN: 'unknown'
};

/**
 * 创建标准化的错误对象
 * @param {string} message - 错误消息
 * @param {string} type - 错误类型
 * @param {string} severity - 严重级别
 * @param {Object} metadata - 额外元数据
 * @returns {Object} 标准化的错误对象
 */
function createError(message, type = ErrorType.UNKNOWN, severity = ErrorSeverity.ERROR, metadata = {}) {
  return {
    id: generateUUID(),
    message,
    type,
    severity,
    timestamp: Date.now(),
    stack: new Error().stack,
    metadata
  };
}

/**
 * 安全地执行异步函数，统一错误处理
 * @param {Function} fn - 要执行的函数
 * @param {Object} options - 选项
 * @param {Function} options.onError - 错误回调
 * @param {*} options.defaultValue - 出错时的默认值
 * @returns {*} 函数返回值或默认值
 */
async function safeExecute(fn, options = {}) {
  const { onError, defaultValue = null } = options;
  
  try {
    return await fn();
  } catch (error) {
    const standardizedError = createError(
      error.message,
      ErrorType.RUNTIME,
      ErrorSeverity.ERROR,
      { originalError: error }
    );
    
    if (onError) {
      onError(standardizedError);
    }
    
    return defaultValue;
  }
}

/**
 * 验证必需字段
 * @param {Object} obj - 要验证的对象
 * @param {string[]} requiredFields - 必需字段列表
 * @returns {Object} 验证结果 { valid: boolean, missing: string[] }
 */
function validateRequiredFields(obj, requiredFields) {
  const missing = requiredFields.filter(field => {
    const value = obj[field];
    return value === undefined || value === null || value === '';
  });
  
  return {
    valid: missing.length === 0,
    missing
  };
}

/**
 * 延迟函数
 * @param {number} ms - 延迟毫秒数
 * @returns {Promise} 延迟完成后 resolve
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  // 基础工具
  generateUUID,
  formatTimestamp,
  safeJSONStringify,
  deepMerge,
  delay,
  
  // 错误处理
  ErrorSeverity,
  ErrorType,
  createError,
  safeExecute,
  validateRequiredFields
};
