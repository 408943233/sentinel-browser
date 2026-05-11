const fs = require('fs');

const lines = fs.readFileSync('/Users/gaoyiwei/Documents/trae_projects/openclaw/output/collections/task_77_www.chinastock.com.cn_1778032834207/training_manifest.jsonl', 'utf8').trim().split('\n');
const events = lines.map(l => JSON.parse(l));

// 检查所有事件的资源
console.log('Checking all events for resource 1778032850866:');
for (let i = 0; i < events.length; i++) {
  const event = events[i];
  const resources = event.network_correlation?.static_resources || [];
  const hasTarget = resources.some(r => r.timestamp === 1778032850866);
  if (hasTarget) {
    console.log('Event', i+1, '(timestamp:', event.timestamp, ') has the target resource');
  }
}

// 检查未被关联的资源
const allResources = new Set();
events.forEach(e => {
  (e.network_correlation?.static_resources || []).forEach(r => {
    allResources.add(r.timestamp);
  });
});
console.log('\nTotal unique resource timestamps in events:', allResources.size);
console.log('Has 1778032850866:', allResources.has(1778032850866));

// 列出所有未被关联的资源
const resourcesDir = '/Users/gaoyiwei/Documents/trae_projects/openclaw/output/collections/task_77_www.chinastock.com.cn_1778032834207/network/resources';
const files = fs.readdirSync(resourcesDir);
const allFileTimestamps = files.map(f => parseInt(f.split('_')[0])).filter(t => !isNaN(t));
const unassociated = allFileTimestamps.filter(t => !allResources.has(t));
console.log('\nUnassociated resource timestamps:', unassociated);
