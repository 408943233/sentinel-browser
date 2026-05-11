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

// 读取资源（模拟 readResourcesDir）
const files = fs.readdirSync(resourcesDir);
let staticResources = files.map(file => {
  const filePath = path.join(resourcesDir, file);
  const stats = fs.statSync(filePath);
  const timestamp = parseInt(file.split('_')[0]) || 0;
  return {
    filename: file,
    path: path.join('network', 'resources', file),
    timestamp: timestamp,
    size: stats.size
  };
});

console.log('Before sort, total resources:', staticResources.length);

// 排序（模拟主逻辑中的排序）
staticResources.sort((a, b) => a.timestamp - b.timestamp);

console.log('After sort, first 5 resources:');
staticResources.slice(0, 5).forEach((r, i) => {
  console.log(`  [${i}] ${r.timestamp} - ${r.filename}`);
});

// 查找目标资源的索引
const targetIdx = staticResources.findIndex(r => r.timestamp === 1778032850866);
console.log('\nTarget resource index after sort:', targetIdx);
console.log('Target resource:', staticResources[targetIdx]);

// 模拟关联过程
const usedStaticResources = new Set();
let targetAssociated = false;
let targetSkippedReason = '';

for (let i = 0; i < events.length; i++) {
  const event = events[i];
  const prevEvent = events[i - 1];
  const nextEvent = events[i + 1];
  
  const eventType = event.event_details?.action || '';
  const eventTimestamp = event.timestamp;
  const eventUrl = event.window_context?.url || '';
  
  if (!eventUrl) continue;
  
  let windowStart, windowEnd;
  
  if (eventType === 'page-load') {
    windowStart = prevEvent ? prevEvent.timestamp : eventTimestamp - 10000;
    windowEnd = nextEvent ? nextEvent.timestamp : Infinity;
  } else if (eventType === 'click') {
    windowStart = eventTimestamp;
    windowEnd = nextEvent ? nextEvent.timestamp : eventTimestamp + 5000;
  } else {
    windowStart = eventTimestamp;
    windowEnd = nextEvent ? nextEvent.timestamp : eventTimestamp + 2000;
  }
  
  // 检查目标资源
  const targetRes = staticResources[targetIdx];
  const inWindow = targetRes.timestamp >= windowStart && targetRes.timestamp < windowEnd;
  const alreadyUsed = usedStaticResources.has(targetIdx);
  
  if (i === 10) { // Event 11
    console.log(`\n=== Event 11 (index 10) ===`);
    console.log(`Event timestamp: ${eventTimestamp}`);
    console.log(`Window: [${windowStart}, ${windowEnd})`);
    console.log(`Target timestamp: ${targetRes.timestamp}`);
    console.log(`Target in window: ${inWindow}`);
    console.log(`Target already used: ${alreadyUsed}`);
    console.log(`Used indices before this event:`, Array.from(usedStaticResources));
  }
  
  // 模拟 filter 过程
  const associatedResources = staticResources.filter((res, idx) => {
    const resInWindow = res.timestamp >= windowStart && res.timestamp < windowEnd;
    const resAlreadyUsed = usedStaticResources.has(idx);
    
    if (idx === targetIdx && i === 10) {
      console.log(`\nFilter check for target (idx=${idx}):`);
      console.log(`  res.timestamp: ${res.timestamp}`);
      console.log(`  windowStart: ${windowStart}, windowEnd: ${windowEnd}`);
      console.log(`  resInWindow: ${resInWindow}`);
      console.log(`  resAlreadyUsed: ${resAlreadyUsed}`);
    }
    
    if (resAlreadyUsed) return false;
    if (!resInWindow) return false;
    
    // 标记为已使用
    usedStaticResources.add(idx);
    
    if (idx === targetIdx) {
      targetAssociated = true;
    }
    
    return true;
  });
  
  if (i === 10) {
    console.log(`\nEvent 11 associated ${associatedResources.length} resources`);
    console.log(`Target associated: ${targetAssociated}`);
  }
}

console.log('\n=== Final result ===');
console.log('Target associated:', targetAssociated);
console.log('Used indices count:', usedStaticResources.size);
console.log('Has target index:', usedStaticResources.has(targetIdx));
