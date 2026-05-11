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

module.exports = {
  generateUUID,
  formatTimestamp,
  safeJSONStringify,
  deepMerge
};
