#!/usr/bin/env node

/**
 * 检查未被关联的数据
 */

const fs = require('fs');
const path = require('path');

const taskDir = process.argv[2];
if (!taskDir) {
  console.error('Usage: node check-unassociated.js <task-dir>');
  process.exit(1);
}

// 读取文件
function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  return content
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      try {
        return JSON.parse(line);
      } catch (e) {
        return null;
      }
    })
    .filter(item => item !== null);
}

// 读取数据
const events = readJsonl(path.join(taskDir, 'training_manifest.jsonl'));
const apiRequests = readJsonl(path.join(taskDir, 'network', 'api_traffic.jsonl'));
const resourcesDir = path.join(taskDir, 'network', 'resources');
const staticResources = fs.existsSync(resourcesDir) ? fs.readdirSync(resourcesDir) : [];

// 统计已关联的数据
const associatedApiIndices = new Set();
const associatedResourceIndices = new Set();

events.forEach(event => {
  if (event.network_correlation) {
    // 统计已关联的 API 请求
    (event.network_correlation.api_requests || []).forEach(req => {
      const idx = apiRequests.findIndex(r => r.timestamp === req.timestamp && r.url === req.url);
      if (idx !== -1) associatedApiIndices.add(idx);
    });
    
    // 统计已关联的静态资源
    (event.network_correlation.static_resources || []).forEach(res => {
      const idx = staticResources.findIndex(r => r === res.filename);
      if (idx !== -1) associatedResourceIndices.add(idx);
    });
  }
});

console.log('=== 关联统计 ===');
console.log('Events:', events.length);
console.log('');
console.log('API requests total:', apiRequests.length);
console.log('API requests associated:', associatedApiIndices.size);
console.log('API requests NOT associated:', apiRequests.length - associatedApiIndices.size);
console.log('');
console.log('Static resources total:', staticResources.length);
console.log('Static resources associated:', associatedResourceIndices.size);
console.log('Static resources NOT associated:', staticResources.length - associatedResourceIndices.size);

// 显示未被关联的 API 请求
if (apiRequests.length > associatedApiIndices.size) {
  console.log('\n=== 未被关联的 API 请求 ===');
  apiRequests.forEach((req, idx) => {
    if (!associatedApiIndices.has(idx)) {
      console.log(`  [${idx}] ${req.timestamp} ${req.method} ${req.url}`);
    }
  });
}

// 显示未被关联的静态资源
if (staticResources.length > associatedResourceIndices.size) {
  console.log('\n=== 未被关联的静态资源 ===');
  staticResources.forEach((res, idx) => {
    if (!associatedResourceIndices.has(idx)) {
      console.log(`  [${idx}] ${res}`);
    }
  });
}
