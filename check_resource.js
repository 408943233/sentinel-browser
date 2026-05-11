const fs = require('fs');
const path = require('path');

const resourcesDir = '/Users/gaoyiwei/Documents/trae_projects/openclaw/output/collections/task_77_www.chinastock.com.cn_1778032834207/network/resources';
const files = fs.readdirSync(resourcesDir);
console.log('Total files:', files.length);

const resources = files.map(file => {
  const filePath = path.join(resourcesDir, file);
  const stats = fs.statSync(filePath);
  const timestamp = parseInt(file.split('_')[0]) || 0;
  return {
    filename: file,
    timestamp: timestamp,
    size: stats.size
  };
});

resources.sort((a, b) => a.timestamp - b.timestamp);

// 查找目标资源
const target = resources.find(r => r.timestamp === 1778032850866);
console.log('Target resource:', target);

// 查找时间戳在事件11和事件12之间的资源
const event11Time = 1778032850771;
const event12Time = 1778032852129;
const between = resources.filter(r => r.timestamp >= event11Time && r.timestamp < event12Time);
console.log('Resources between event 11 and 12:', between.length);
console.log('Resources:', between.map(r => ({ ts: r.timestamp, fn: r.filename })));
