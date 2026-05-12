#!/usr/bin/env node

/**
 * 后处理关联脚本
 * 在录制结束后，将所有 network 数据关联到事件
 * 
 * 关联的数据包括：
 * 1. API 请求（api_traffic.jsonl）
 * 2. API 响应（api_responses.json）
 * 3. 静态资源（resources/ 目录）
 * 4. 动态资源（dynamic_resources.json）
 * 5. API 响应体（api_bodies/ 目录）
 * 
 * 支持进度报告：通过 stdout 输出 JSON 格式的进度信息
 */

const fs = require('fs');
const path = require('path');

// 读取命令行参数
const taskDir = process.argv[2];
if (!taskDir) {
  console.error('Usage: node post-process-correlation.js <task-dir>');
  process.exit(1);
}

// 文件路径
const manifestPath = path.join(taskDir, 'training_manifest.jsonl');
const apiTrafficPath = path.join(taskDir, 'network', 'api_traffic.jsonl');
const apiResponsesPath = path.join(taskDir, 'network', 'api_responses.json');
const dynamicResourcesPath = path.join(taskDir, 'network', 'dynamic_resources.json');
const resourcesDir = path.join(taskDir, 'network', 'resources');
const apiBodiesDir = path.join(taskDir, 'network', 'api_bodies');

// 检查文件是否存在
if (!fs.existsSync(manifestPath)) {
  console.error('training_manifest.jsonl not found:', manifestPath);
  process.exit(1);
}

// 发送进度报告
function reportProgress(stage, current, total, message) {
  const progress = {
    type: 'progress',
    stage,
    current,
    total,
    percent: total > 0 ? Math.round((current / total) * 100) : 0,
    message
  };
  console.log(JSON.stringify(progress));
}

// 发送完成报告
function reportComplete(success, stats) {
  const result = {
    type: 'complete',
    success,
    stats
  };
  console.log(JSON.stringify(result));
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
        console.warn('Failed to parse line:', line);
        return null;
      }
    })
    .filter(item => item !== null);
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    console.warn('Failed to parse JSON:', filePath);
    return {};
  }
}

// 写入文件
function writeJsonl(filePath, data) {
  const lines = data.map(item => JSON.stringify(item)).join('\n') + '\n';
  fs.writeFileSync(filePath, lines);
}

// 获取 URL 的主机名
function getHostname(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return '';
  }
}

// 获取 URL 的基础域名（用于匹配子域名）
function getBaseDomain(hostname) {
  const parts = hostname.split('.');
  if (parts.length >= 2) {
    return parts.slice(-2).join('.');
  }
  return hostname;
}

// 检查两个 URL 是否属于同一站点
function isSameSite(url1, url2) {
  const host1 = getHostname(url1);
  const host2 = getHostname(url2);
  const domain1 = getBaseDomain(host1);
  const domain2 = getBaseDomain(host2);
  return domain1 === domain2;
}

// 读取资源目录
function readResourcesDir(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const files = fs.readdirSync(dirPath);
  return files.map(file => {
    const filePath = path.join(dirPath, file);
    const stats = fs.statSync(filePath);
    // 从文件名提取时间戳（格式：timestamp_filename.ext）
    const timestamp = parseInt(file.split('_')[0]) || 0;
    return {
      filename: file,
      path: path.join('network', 'resources', file),
      timestamp: timestamp,
      size: stats.size
    };
  });
}

// 读取 API 响应体目录
function readApiBodiesDir(dirPath) {
  if (!fs.existsSync(dirPath)) return {};
  const files = fs.readdirSync(dirPath);
  const bodies = {};
  files.forEach(file => {
    const filePath = path.join(dirPath, file);
    // 从文件名提取时间戳（格式：timestamp_filename）
    const timestamp = parseInt(file.split('_')[0]) || 0;
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      bodies[timestamp] = {
        filename: file,
        path: path.join('network', 'api_bodies', file),
        content: content,
        timestamp: timestamp
      };
    } catch (e) {
      console.warn('Failed to read API body:', file);
    }
  });
  return bodies;
}

// 主处理逻辑
async function processCorrelation() {
  reportProgress('reading', 0, 6, '开始读取数据文件...');
  
  // 读取数据
  reportProgress('reading', 1, 6, '读取 training_manifest.jsonl...');
  const events = readJsonl(manifestPath);
  
  reportProgress('reading', 2, 6, '读取 api_traffic.jsonl...');
  const apiRequests = readJsonl(apiTrafficPath);
  
  reportProgress('reading', 3, 6, '读取 api_responses.json...');
  const apiResponses = readJson(apiResponsesPath);
  
  reportProgress('reading', 4, 6, '读取 dynamic_resources.json...');
  const dynamicResources = readJson(dynamicResourcesPath);
  const dynamicResourcesList = Array.isArray(dynamicResources) ? dynamicResources : [];
  
  reportProgress('reading', 5, 6, '读取 resources 目录...');
  const staticResources = readResourcesDir(resourcesDir);
  
  reportProgress('reading', 6, 6, '读取 api_bodies 目录...');
  const apiBodies = readApiBodiesDir(apiBodiesDir);

  // 按时间戳排序
  events.sort((a, b) => a.timestamp - b.timestamp);
  apiRequests.sort((a, b) => a.timestamp - b.timestamp);
  staticResources.sort((a, b) => a.timestamp - b.timestamp);
  dynamicResourcesList.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  // 找到第一个事件的时间戳（用于关联初始资源）
  const firstEventTimestamp = events.length > 0 ? events[0].timestamp : 0;
  
  // 找到最早的 API 请求时间戳
  const earliestApiTimestamp = apiRequests.length > 0 ? Math.min(...apiRequests.map(r => r.timestamp)) : firstEventTimestamp;
  const earliestResourceTimestamp = staticResources.length > 0 ? Math.min(...staticResources.map(r => r.timestamp)) : firstEventTimestamp;
  const earliestTimestamp = Math.min(earliestApiTimestamp, earliestResourceTimestamp);
  
  // 录制开始时间：取最早的网络请求时间或第一个事件前30秒（取更早的）
  // 这样可以确保捕获页面加载时的所有请求
  const recordingStartTime = Math.min(earliestTimestamp, firstEventTimestamp - 30000);
  
  console.log(`Recording start time: ${recordingStartTime}`);
  console.log(`First event time: ${firstEventTimestamp}`);
  console.log(`Earliest API request: ${earliestApiTimestamp}`);
  console.log(`Time difference: ${firstEventTimestamp - earliestTimestamp}ms`);

  // 为每个事件关联网络数据
  // 基于因果关系：事件触发网络请求，请求可能跨事件延续
  let associatedCount = 0;
  const usedApiRequests = new Set();
  const usedStaticResources = new Set();
  const usedDynamicResources = new Set();
  
  const totalEvents = events.length;

  // 初始化每个事件的关联数据
  const eventAssociations = events.map(() => ({
    apiRequests: [],
    staticResources: [],
    dynamicResources: []
  }));

  // 辅助函数：确定事件的影响时间窗口（请求可能被该事件触发的时间范围）
  function getEventInfluenceWindow(eventIndex) {
    const event = events[eventIndex];
    const eventTimestamp = event.timestamp;
    const eventType = event.event_details?.action || '';
    const nextEvent = events[eventIndex + 1];
    
    // 确定事件的影响结束时间
    let influenceEnd;
    if (eventType === 'click') {
      // click 事件：影响从事件开始到下一个事件，或5秒（取较长的）
      // 因为 JS 触发的请求链可能持续一段时间
      const nextEventTime = nextEvent ? nextEvent.timestamp : Infinity;
      influenceEnd = Math.max(nextEventTime, eventTimestamp + 5000);
    } else if (eventType === 'page-load') {
      // page-load 事件：影响从事件开始到下一个事件
      // 页面加载时的请求应该都归到 page-load
      influenceEnd = nextEvent ? nextEvent.timestamp : Infinity;
    } else if (eventType === 'scroll' || eventType === 'scroll-start' || eventType === 'scroll-end') {
      // 滚动事件：影响较短，通常不会触发复杂的请求链
      influenceEnd = nextEvent ? Math.min(nextEvent.timestamp, eventTimestamp + 2000) : eventTimestamp + 2000;
    } else {
      // 其他事件（user_context等）：影响到下一个事件
      influenceEnd = nextEvent ? nextEvent.timestamp : eventTimestamp + 2000;
    }
    
    return {
      start: eventTimestamp,
      end: influenceEnd,
      type: eventType
    };
  }

  // 第一步：为每个事件计算其影响窗口
  const eventInfluenceWindows = events.map((_, index) => getEventInfluenceWindow(index));

  // 第二步：关联 API 请求
  // 对于每个请求，找到可能触发它的所有事件，然后选择最可能的一个
  reportProgress('associating', 1, 3, '关联 API 请求...');
  
  for (const req of apiRequests) {
    const reqId = `${req.timestamp}_${req.url}`;
    if (usedApiRequests.has(reqId)) continue;
    
    // 找到所有可能影响该请求的事件（请求时间在事件影响窗口内）
    const candidateEvents = [];
    
    for (let i = 0; i < events.length; i++) {
      const window = eventInfluenceWindows[i];
      const event = events[i];
      const eventUrl = event.window_context?.url || '';
      
      // 检查请求是否在事件的影响窗口内
      if (req.timestamp >= window.start && req.timestamp < window.end) {
        // 对于非 page-load 事件，检查是否同一站点
        if (window.type !== 'page-load' && !isSameSite(req.url, eventUrl)) {
          continue;
        }
        
        // 计算优先级：click 和 page-load 优先级较高
        let priority = 0;
        if (window.type === 'click') priority = 3;
        else if (window.type === 'page-load') priority = 2;
        else if (window.type === 'scroll-start' || window.type === 'scroll-end') priority = 1;
        else priority = 0;
        
        // 计算时间差（越小越好）
        const timeDiff = req.timestamp - window.start;
        
        candidateEvents.push({
          index: i,
          priority: priority,
          timeDiff: timeDiff,
          window: window
        });
      }
    }
    
    if (candidateEvents.length > 0) {
      // 选择最佳事件：优先级高 -> 时间差小
      candidateEvents.sort((a, b) => {
        if (b.priority !== a.priority) {
          return b.priority - a.priority; // 优先级高的在前
        }
        return a.timeDiff - b.timeDiff; // 时间差小的在前
      });
      
      const bestEvent = candidateEvents[0];
      const eventIndex = bestEvent.index;
      const event = events[eventIndex];
      const response = apiResponses[req.url];
      const bodyInfo = apiBodies[req.timestamp];
      
      eventAssociations[eventIndex].apiRequests.push({
        url: req.url,
        method: req.method,
        status: req.status,
        timestamp: req.timestamp,
        resourceType: req.resourceType,
        response: response ? {
          headers: response.headers,
          body: response.body,
          bodyPath: response.bodyPath,
          bodyFile: bodyInfo ? {
            filename: bodyInfo.filename,
            path: bodyInfo.path,
            size: bodyInfo.content.length
          } : null
        } : null
      });
      usedApiRequests.add(reqId);
    }
  }

  // 第三步：关联静态资源（按时间戳最接近）
  reportProgress('associating', 2, 3, '关联静态资源...');
  for (const res of staticResources) {
    if (usedStaticResources.has(res.filename)) continue;
    
    // 找到时间戳最接近的事件
    let closestIndex = -1;
    let minDiff = Infinity;
    
    for (let i = 0; i < events.length; i++) {
      const diff = Math.abs(events[i].timestamp - res.timestamp);
      if (diff < minDiff) {
        minDiff = diff;
        closestIndex = i;
      }
    }
    
    if (closestIndex >= 0) {
      eventAssociations[closestIndex].staticResources.push({
        filename: res.filename,
        path: res.path,
        timestamp: res.timestamp,
        size: res.size
      });
      usedStaticResources.add(res.filename);
    }
  }

  // 第四步：关联动态资源（按时间戳最接近）
  reportProgress('associating', 3, 3, '关联动态资源...');
  for (const res of dynamicResourcesList) {
    const resId = `${res.timestamp || 0}_${res.url}`;
    if (usedDynamicResources.has(resId)) continue;
    
    // 找到时间戳最接近的事件
    let closestIndex = -1;
    let minDiff = Infinity;
    
    for (let i = 0; i < events.length; i++) {
      const diff = Math.abs(events[i].timestamp - (res.timestamp || 0));
      if (diff < minDiff) {
        minDiff = diff;
        closestIndex = i;
      }
    }
    
    if (closestIndex >= 0) {
      eventAssociations[closestIndex].dynamicResources.push({
        url: res.url,
        type: res.type,
        status: res.status,
        timestamp: res.timestamp,
        path: res.path
      });
      usedDynamicResources.add(resId);
    }
  }

  // 将关联数据应用到事件
  for (let i = 0; i < events.length; i++) {
    const assoc = eventAssociations[i];
    if (assoc.apiRequests.length > 0 || 
        assoc.staticResources.length > 0 || 
        assoc.dynamicResources.length > 0) {
      
      events[i].network_correlation = {
        api_requests: assoc.apiRequests,
        static_resources: assoc.staticResources,
        dynamic_resources: assoc.dynamicResources,
        response_status: assoc.apiRequests.length > 0 ? 'completed' : null
      };
      
      associatedCount++;
    }
  }

  // 处理未被关联的数据 - 将它们关联到最后一个 page-load 事件
  reportProgress('finalizing', 0, 2, '处理未被关联的数据...');
  const lastPageLoadEvent = events.slice().reverse().find(e => e.event_details?.action === 'page-load');
  
  if (lastPageLoadEvent) {
    const unassociatedApiRequests = apiRequests.filter((req) => !usedApiRequests.has(`${req.timestamp}_${req.url}`));
    const unassociatedStaticResources = staticResources.filter((res) => !usedStaticResources.has(res.filename));
    const unassociatedDynamicResources = dynamicResourcesList.filter((res) => !usedDynamicResources.has(`${res.timestamp || 0}_${res.url}`));
    
    if (unassociatedApiRequests.length > 0 || 
        unassociatedStaticResources.length > 0 || 
        unassociatedDynamicResources.length > 0) {
      
      // 初始化 network_correlation（如果不存在）
      if (!lastPageLoadEvent.network_correlation) {
        lastPageLoadEvent.network_correlation = {
          api_requests: [],
          static_resources: [],
          dynamic_resources: [],
          response_status: null
        };
      }
      
      // 添加未被关联的数据
      const apiRequestsWithDetails = unassociatedApiRequests.map(req => {
        const response = apiResponses[req.url];
        const bodyInfo = apiBodies[req.timestamp];
        return {
          url: req.url,
          method: req.method,
          status: req.status,
          timestamp: req.timestamp,
          resourceType: req.resourceType,
          response: response ? {
            headers: response.headers,
            body: response.body,
            bodyPath: response.bodyPath,
            bodyFile: bodyInfo ? {
              filename: bodyInfo.filename,
              path: bodyInfo.path,
              size: bodyInfo.content.length
            } : null
          } : null
        };
      });
      
      lastPageLoadEvent.network_correlation.api_requests.push(...apiRequestsWithDetails);
      lastPageLoadEvent.network_correlation.static_resources.push(...unassociatedStaticResources.map(res => ({
        filename: res.filename,
        path: res.path,
        timestamp: res.timestamp,
        size: res.size
      })));
      lastPageLoadEvent.network_correlation.dynamic_resources.push(...unassociatedDynamicResources.map(res => ({
        url: res.url,
        type: res.type,
        status: res.status,
        timestamp: res.timestamp,
        path: res.path
      })));
      
      unassociatedApiRequests.forEach((_, idx) => usedApiRequests.add(idx));
      unassociatedStaticResources.forEach((_, idx) => usedStaticResources.add(idx));
      unassociatedDynamicResources.forEach((_, idx) => usedDynamicResources.add(idx));
    }
  }

  // 写入更新后的 manifest 文件
  reportProgress('finalizing', 1, 2, '保存更新后的 manifest 文件...');
  writeJsonl(manifestPath, events);
  
  reportProgress('finalizing', 2, 2, '完成！');

  // 检查是否所有数据都被关联
  const unassociatedApiCount = apiRequests.length - usedApiRequests.size;
  const unassociatedStaticCount = staticResources.length - usedStaticResources.size;
  const unassociatedDynamicCount = dynamicResourcesList.length - usedDynamicResources.size;
  
  const success = unassociatedApiCount === 0 && unassociatedStaticCount === 0 && unassociatedDynamicCount === 0;
  
  reportComplete(success, {
    events: events.length,
    apiRequests: apiRequests.length,
    apiRequestsAssociated: usedApiRequests.size,
    staticResources: staticResources.length,
    staticResourcesAssociated: usedStaticResources.size,
    dynamicResources: dynamicResourcesList.length,
    dynamicResourcesAssociated: usedDynamicResources.size,
    associatedEvents: associatedCount
  });
}

processCorrelation().catch(err => {
  console.error('Error:', err);
  reportComplete(false, { error: err.message });
  process.exit(1);
});
