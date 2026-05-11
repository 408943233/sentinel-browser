/**
 * training_manifest.jsonl 验证脚本
 * 用于验证生成的数据文件是否完整和对齐
 */

const fs = require('fs');
const path = require('path');

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

// 读取 JSONL 文件
function readJSONL(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim());
  const events = [];
  const errors = [];

  lines.forEach((line, index) => {
    try {
      const event = JSON.parse(line);
      events.push(event);
    } catch (e) {
      errors.push({ line: index + 1, error: e.message, content: line.substring(0, 100) });
    }
  });

  return { events, errors };
}

// 验证单个任务目录
function validateTask(taskDir) {
  log(`\n${'='.repeat(60)}`, 'cyan');
  log(`验证任务目录: ${taskDir}`, 'cyan');
  log(`${'='.repeat(60)}`, 'cyan');

  if (!fs.existsSync(taskDir)) {
    log(`❌ 任务目录不存在: ${taskDir}`, 'red');
    return false;
  }

  const results = {
    valid: true,
    warnings: [],
    errors: []
  };

  // 1. 验证 training_manifest.jsonl
  const manifestPath = path.join(taskDir, 'training_manifest.jsonl');
  log(`\n📄 检查 manifest 文件...`, 'blue');

  if (!fs.existsSync(manifestPath)) {
    log(`❌ training_manifest.jsonl 不存在`, 'red');
    results.valid = false;
    results.errors.push('training_manifest.jsonl 不存在');
    return results;
  }

  const manifestData = readJSONL(manifestPath);
  if (!manifestData) {
    log(`❌ 无法读取 training_manifest.jsonl`, 'red');
    results.valid = false;
    results.errors.push('无法读取 training_manifest.jsonl');
    return results;
  }

  const { events, errors } = manifestData;
  log(`✅ Manifest 文件可读`, 'green');
  log(`📊 事件总数: ${events.length}`, 'blue');

  if (errors.length > 0) {
    log(`⚠️  解析错误: ${errors.length} 行`, 'yellow');
    errors.slice(0, 5).forEach(err => {
      log(`   行 ${err.line}: ${err.error}`, 'yellow');
    });
    results.warnings.push(`${errors.length} 行 JSON 解析错误`);
  }

  // 2. 验证事件结构
  log(`\n🔍 验证事件结构...`, 'blue');

  // 根据实际数据结构定义必需字段
  const requiredFields = ['timestamp', 'video_time', 'task_id', 'event_details'];
  const recommendedFields = ['window_context', 'user_context', 'page_state', 'file_io', 'network_correlation'];

  let validEvents = 0;
  let invalidEvents = 0;
  const eventTypes = {};
  const actionTypes = {};

  events.forEach((event, index) => {
    // 检查必需字段
    const missingFields = requiredFields.filter(field => !(field in event));
    if (missingFields.length > 0) {
      invalidEvents++;
      if (invalidEvents <= 3) {
        log(`❌ 事件 ${index} 缺少必需字段: ${missingFields.join(', ')}`, 'red');
      }
    } else {
      validEvents++;
    }

    // 检查推荐字段（警告但不标记为无效）
    const missingRecommended = recommendedFields.filter(field => !(field in event));
    if (missingRecommended.length > 0 && index < 3) {
      log(`⚠️  事件 ${index} 缺少推荐字段: ${missingRecommended.join(', ')}`, 'yellow');
    }

    // 统计事件类型
    const eventType = event.event_details?.action || event.event_details?.type || 'unknown';
    eventTypes[eventType] = (eventTypes[eventType] || 0) + 1;

    // 统计 action 类型
    if (event.event_details?.action) {
      actionTypes[event.event_details.action] = (actionTypes[event.event_details.action] || 0) + 1;
    }

    // 验证时间戳
    if (!event.timestamp || typeof event.timestamp !== 'number') {
      if (index < 3) {
        log(`⚠️  事件 ${index} 时间戳无效`, 'yellow');
      }
    }

    // 验证 task_id（现在直接在事件根级别）
    if (!event.task_id) {
      if (index < 3) {
        log(`⚠️  事件 ${index} 缺少 task_id`, 'yellow');
      }
    }

    // 验证 video_time
    if (!event.video_time) {
      if (index < 3) {
        log(`⚠️  事件 ${index} 缺少 video_time`, 'yellow');
      }
    }
  });

  log(`✅ 有效事件: ${validEvents}`, 'green');
  if (invalidEvents > 0) {
    log(`⚠️  无效事件: ${invalidEvents}`, 'yellow');
    results.warnings.push(`${invalidEvents} 个事件结构不完整`);
  }

  // 显示事件类型分布
  log(`\n📈 事件类型分布:`, 'blue');
  Object.entries(eventTypes)
    .sort((a, b) => b[1] - a[1])
    .forEach(([type, count]) => {
      log(`   ${type}: ${count}`, 'cyan');
    });

  // 3. 验证文件引用
  log(`\n📁 验证文件引用...`, 'blue');

  const domDir = path.join(taskDir, 'dom');
  const snapshotsDir = path.join(taskDir, 'previews', 'snapshots');
  const downloadsDir = path.join(taskDir, 'downloads');
  const uploadsDir = path.join(taskDir, 'uploads');
  const videoDir = path.join(taskDir, 'video');

  // 统计引用的文件
  let domRefs = 0;
  let snapshotRefs = 0;
  let missingDomFiles = 0;
  let missingSnapshotFiles = 0;

  events.forEach(event => {
    if (event._metadata?.domSnapshotFileName) {
      domRefs++;
      const domFile = path.join(domDir, event._metadata.domSnapshotFileName);
      if (!fs.existsSync(domFile)) {
        missingDomFiles++;
      }
    }

    if (event._metadata?.snapshotFileName) {
      snapshotRefs++;
      const snapshotFile = path.join(snapshotsDir, event._metadata.snapshotFileName);
      if (!fs.existsSync(snapshotFile)) {
        missingSnapshotFiles++;
      }
    }
  });

  log(`📄 DOM 快照引用: ${domRefs}`, 'blue');
  log(`📷 视频截图引用: ${snapshotRefs}`, 'blue');

  if (missingDomFiles > 0) {
    log(`❌ 缺失的 DOM 文件: ${missingDomFiles}`, 'red');
    results.warnings.push(`${missingDomFiles} 个 DOM 快照文件缺失`);
  }
  if (missingSnapshotFiles > 0) {
    log(`❌ 缺失的视频截图: ${missingSnapshotFiles}`, 'red');
    results.warnings.push(`${missingSnapshotFiles} 个视频截图文件缺失`);
  }

  // 检查实际文件（只统计 snapshot_*.json 文件，不包括 rrweb_events.json）
  const domFiles = fs.existsSync(domDir) ? fs.readdirSync(domDir).filter(f => f.startsWith('snapshot_') && f.endsWith('.json')) : [];
  const snapshotFiles = fs.existsSync(snapshotsDir) ? fs.readdirSync(snapshotsDir).filter(f => f.endsWith('.png')) : [];
  const downloadFiles = fs.existsSync(downloadsDir) ? fs.readdirSync(downloadsDir) : [];
  const uploadFiles = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : [];
  const videoFiles = fs.existsSync(videoDir) ? fs.readdirSync(videoDir).filter(f => f.endsWith('.mp4')) : [];

  log(`\n📂 实际文件数量:`, 'blue');
  log(`   DOM 快照: ${domFiles.length}`, 'cyan');
  log(`   视频截图: ${snapshotFiles.length}`, 'cyan');
  log(`   下载文件: ${downloadFiles.length}`, 'cyan');
  log(`   上传文件: ${uploadFiles.length}`, 'cyan');
  log(`   视频文件: ${videoFiles.length}`, 'cyan');

  // 验证对齐
  if (domRefs > 0 && domFiles.length < domRefs * 0.9) {
    log(`⚠️  DOM 文件数量 (${domFiles.length}) 明显少于引用数量 (${domRefs})`, 'yellow');
    results.warnings.push('DOM 文件数量与引用不匹配');
  }

  if (snapshotRefs > 0 && snapshotFiles.length < snapshotRefs * 0.9) {
    log(`⚠️  视频截图数量 (${snapshotFiles.length}) 明显少于引用数量 (${snapshotRefs})`, 'yellow');
    results.warnings.push('视频截图数量与引用不匹配');
  }

  // 4. 验证视频文件
  log(`\n🎥 验证视频文件...`, 'blue');
  // 检查可能的视频文件名
  const possibleVideoNames = ['recording.mp4', 'raw_record.mp4', 'video.mp4'];
  let videoPath = null;
  let videoFound = false;

  for (const name of possibleVideoNames) {
    const testPath = path.join(videoDir, name);
    if (fs.existsSync(testPath)) {
      videoPath = testPath;
      videoFound = true;
      break;
    }
  }

  if (videoFound && videoPath) {
    const stats = fs.statSync(videoPath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
    log(`✅ 视频文件存在 (${path.basename(videoPath)}): ${sizeMB} MB`, 'green');

    // 检查文件大小是否合理（至少 1KB）
    if (stats.size < 1024) {
      log(`⚠️  视频文件过小`, 'yellow');
      results.warnings.push('视频文件过小');
    }
  } else {
    log(`❌ 视频文件不存在`, 'red');
    results.warnings.push('视频文件不存在');
  }

  // 5. 验证暂停/恢复事件
  log(`\n⏸️  验证暂停/恢复功能...`, 'blue');
  // 暂停/恢复事件通过 _metadata.contextType 或 semantic_label 判断
  const pauseEvents = events.filter(e =>
    e._metadata?.contextType === 'pause' ||
    e.event_details?.semantic_label?.includes('paused') ||
    e.event_details?.action === 'pause'
  );
  const resumeEvents = events.filter(e =>
    e._metadata?.contextType === 'resume' ||
    e.event_details?.semantic_label?.includes('resumed') ||
    e.event_details?.action === 'resume'
  );

  log(`   暂停事件: ${pauseEvents.length}`, 'cyan');
  log(`   恢复事件: ${resumeEvents.length}`, 'cyan');

  if (pauseEvents.length !== resumeEvents.length) {
    log(`⚠️  暂停和恢复事件数量不匹配`, 'yellow');
    results.warnings.push('暂停/恢复事件数量不匹配');
  }

  // 验证时间顺序
  let timeOrderValid = true;
  for (let i = 0; i < pauseEvents.length && i < resumeEvents.length; i++) {
    if (resumeEvents[i].timestamp <= pauseEvents[i].timestamp) {
      timeOrderValid = false;
      log(`❌ 第 ${i + 1} 次恢复时间早于暂停时间`, 'red');
    }
  }

  if (timeOrderValid && pauseEvents.length > 0) {
    log(`✅ 暂停/恢复时间顺序正确`, 'green');
  }

  // 6. 验证时间连续性
  log(`\n⏱️  验证时间连续性...`, 'blue');
  const timestamps = events.map(e => e.timestamp).filter(t => typeof t === 'number');
  if (timestamps.length > 1) {
    const sortedTimestamps = [...timestamps].sort((a, b) => a - b);
    const duration = sortedTimestamps[sortedTimestamps.length - 1] - sortedTimestamps[0];
    const durationSec = (duration / 1000).toFixed(1);
    log(`   录制时长: ${durationSec} 秒`, 'cyan');

    // 检查时间倒退
    let timeReversals = 0;
    for (let i = 1; i < sortedTimestamps.length; i++) {
      if (sortedTimestamps[i] < sortedTimestamps[i - 1]) {
        timeReversals++;
      }
    }

    if (timeReversals > 0) {
      log(`⚠️  发现 ${timeReversals} 处时间倒退`, 'yellow');
      results.warnings.push('时间戳存在倒退');
    } else {
      log(`✅ 时间顺序正确`, 'green');
    }
  }

  // 总结
  log(`\n${'='.repeat(60)}`, 'cyan');
  if (results.errors.length === 0) {
    log(`✅ 验证通过`, 'green');
  } else {
    log(`❌ 验证失败`, 'red');
    results.valid = false;
  }

  if (results.warnings.length > 0) {
    log(`⚠️  警告: ${results.warnings.length} 个`, 'yellow');
  }
  log(`${'='.repeat(60)}\n`, 'cyan');

  return results;
}

// 查找所有任务目录
function findAllTasks(storagePath) {
  if (!fs.existsSync(storagePath)) {
    return [];
  }

  const entries = fs.readdirSync(storagePath, { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith('task_'))
    .map(entry => path.join(storagePath, entry.name));
}

// 主函数
function main() {
  log('\n');
  log('╔══════════════════════════════════════════════════════════╗', 'cyan');
  log('║     Sentinel Browser Manifest 验证工具                   ║', 'cyan');
  log('╚══════════════════════════════════════════════════════════╝', 'cyan');
  log('\n');

  // 获取存储路径
  const storagePath = path.join(__dirname, '..', 'userdata', 'storage');

  // 检查命令行参数
  const args = process.argv.slice(2);
  let taskDir = null;

  if (args.length > 0) {
    // 验证指定的任务目录
    taskDir = args[0];
    if (!path.isAbsolute(taskDir)) {
      taskDir = path.resolve(taskDir);
    }
  } else {
    // 查找所有任务并验证最新的一个
    const tasks = findAllTasks(storagePath);
    if (tasks.length === 0) {
      log(`❌ 未找到任何任务目录`, 'red');
      log(`   存储路径: ${storagePath}`, 'yellow');
      process.exit(1);
    }

    // 按修改时间排序，取最新的
    tasks.sort((a, b) => {
      const statA = fs.statSync(a);
      const statB = fs.statSync(b);
      return statB.mtime - statA.mtime;
    });

    taskDir = tasks[0];
    log(`找到 ${tasks.length} 个任务，验证最新的一个...`, 'blue');
  }

  // 执行验证
  const results = validateTask(taskDir);

  // 退出码
  process.exit(results.valid ? 0 : 1);
}

// 运行
main();
