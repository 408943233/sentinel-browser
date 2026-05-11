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

// 检查每个事件的时间窗口
console.log('Checking event windows:\n');

for (let i = 0; i < events.length; i++) {
  const event = events[i];
  const prevEvent = events[i - 1];
  const nextEvent = events[i + 1];
  
  const eventType = event.event_details?.action || '';
  const eventTimestamp = event.timestamp;
  const eventUrl = event.window_context?.url || '';
  
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
  
  // 检查资源 1778032850866 是否在这个窗口内
  const targetInWindow = 1778032850866 >= windowStart && 1778032850866 < windowEnd;
  
  if (targetInWindow) {
    console.log(`Event ${i+1}: ${eventType}`);
    console.log(`  Timestamp: ${eventTimestamp}`);
    console.log(`  URL: ${eventUrl}`);
    console.log(`  Window: [${windowStart}, ${windowEnd})`);
    console.log(`  Target in window: YES`);
    console.log();
  }
}

// 模拟关联过程
console.log('\n=== Simulating correlation ===\n');
const usedStaticResources = new Set();

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
  
  // 检查资源 118
  const targetRes = staticResources.find(r => r.timestamp === 1778032850866);
  if (targetRes) {
    const inWindow = targetRes.timestamp >= windowStart && targetRes.timestamp < windowEnd;
    const alreadyUsed = usedStaticResources.has(targetRes.idx);
    
    if (inWindow) {
      console.log(`Event ${i+1} (${eventType}):`);
      console.log(`  Target in window: ${inWindow}`);
      console.log(`  Already used: ${alreadyUsed}`);
      
      if (inWindow && !alreadyUsed) {
        console.log(`  -> ASSOCIATING to event ${i+1}`);
        usedStaticResources.add(targetRes.idx);
      } else if (alreadyUsed) {
        console.log(`  -> SKIPPED (already used)`);
      }
    }
  }
}
