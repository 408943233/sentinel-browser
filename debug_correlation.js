const fs = require('fs');
const path = require('path');

const taskDir = '/Users/gaoyiwei/Documents/trae_projects/openclaw/output/collections/task_77_www.chinastock.com.cn_1778032834207';
const manifestPath = path.join(taskDir, 'training_manifest.jsonl');
const resourcesDir = path.join(taskDir, 'network', 'resources');

// 读取事件
const events = fs.readFileSync(manifestPath, 'utf8')
  .trim()
  .split('\n')
  .filter(line => line.trim())
  .map(line => JSON.parse(line));

// 读取资源
const files = fs.readdirSync(resourcesDir);
const staticResources = files.map((file, idx) => {
  const timestamp = parseInt(file.split('_')[0]) || 0;
  return {
    filename: file,
    timestamp: timestamp,
    idx: idx
  };
}).sort((a, b) => a.timestamp - b.timestamp);

// 查找目标资源
const targetResource = staticResources.find(r => r.timestamp === 1778032850866);
console.log('Target resource:', targetResource);

// 事件 11 和 12
const event11 = events[10];
const event12 = events[11];

console.log('\nEvent 11:', {
  timestamp: event11.timestamp,
  action: event11.event_details?.action,
  url: event11.window_context?.url
});

console.log('Event 12:', {
  timestamp: event12.timestamp,
  action: event12.event_details?.action,
  url: event12.window_context?.url
});

// 时间窗口
const windowStart = event11.timestamp;
const windowEnd = event12.timestamp;

console.log('\nTime window for event 11:', {
  windowStart,
  windowEnd,
  targetTimestamp: targetResource.timestamp,
  inWindow: targetResource.timestamp >= windowStart && targetResource.timestamp < windowEnd
});

// 检查资源索引
const targetIdx = staticResources.findIndex(r => r.timestamp === 1778032850866);
console.log('\nTarget resource index:', targetIdx);

// 检查时间戳在窗口内的资源
const inWindow = staticResources.filter(r => r.timestamp >= windowStart && r.timestamp < windowEnd);
console.log('\nResources in window:', inWindow.length);
console.log('Resource indices in window:', inWindow.map(r => r.idx));
console.log('Has target index?', inWindow.some(r => r.idx === targetIdx));
