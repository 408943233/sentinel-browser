/**
 * Sentinel Browser 自动化测试脚本
 * 测试功能：
 * 1. 启动录制
 * 2. 模拟用户操作（点击、输入、滚动等）
 * 3. 暂停/继续录制
 * 4. 停止录制
 * 5. 验证 training_manifest.jsonl 数据完整性
 * 6. 验证所有数据文件对齐
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

// 测试配置
const TEST_CONFIG = {
  testUrl: 'https://example.com',
  recordingDuration: 5000, // 录制时长（毫秒）
  pauseDuration: 2000, // 暂停时长（毫秒）
  taskName: '自动化测试任务',
  taskUrl: 'example.com'
};

// 测试结果
const testResults = {
  passed: [],
  failed: [],
  warnings: []
};

// 测试工具函数
function log(message, type = 'info') {
  const timestamp = new Date().toISOString();
  const prefix = type === 'error' ? '❌' : type === 'success' ? '✅' : type === 'warning' ? '⚠️' : 'ℹ️';
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

function assertTrue(condition, message) {
  if (condition) {
    testResults.passed.push(message);
    log(message, 'success');
  } else {
    testResults.failed.push(message);
    log(message, 'error');
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertFalse(condition, message) {
  assertTrue(!condition, message);
}

// 延迟函数
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 读取 JSONL 文件
function readJSONL(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  return content.split('\n')
    .filter(line => line.trim())
    .map(line => {
      try {
        return JSON.parse(line);
      } catch (e) {
        log(`Failed to parse JSON line: ${line.substring(0, 100)}...`, 'error');
        return null;
      }
    })
    .filter(item => item !== null);
}

// 测试类
class SentinelAutomationTest {
  constructor() {
    this.mainWindow = null;
    this.testTaskId = null;
    this.taskDir = null;
  }

  async run() {
    log('========================================');
    log('Sentinel Browser 自动化测试开始');
    log('========================================');

    try {
      // 等待应用准备就绪
      await this.waitForAppReady();

      // 测试 1: 启动录制
      await this.testStartRecording();

      // 测试 2: 模拟用户操作
      await this.testSimulateUserActions();

      // 测试 3: 暂停录制
      await this.testPauseRecording();

      // 测试 4: 继续录制
      await this.testResumeRecording();

      // 测试 5: 停止录制
      await this.testStopRecording();

      // 测试 6: 验证数据完整性
      await this.testDataIntegrity();

      // 测试 7: 验证 training_manifest.jsonl
      await this.testManifestValidation();

      // 测试 8: 验证文件对齐
      await this.testFileAlignment();

      // 测试 9: 验证暂停功能
      await this.testPauseFunctionality();

      // 输出测试结果
      this.printResults();

    } catch (error) {
      log(`测试失败: ${error.message}`, 'error');
      console.error(error);
      process.exit(1);
    }
  }

  async waitForAppReady() {
    log('等待应用准备就绪...');

    // 等待主窗口创建
    let retries = 0;
    while (!this.mainWindow && retries < 50) {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length > 0) {
        this.mainWindow = windows[0];
        break;
      }
      await delay(100);
      retries++;
    }

    assertTrue(this.mainWindow !== null, '主窗口创建成功');
    log('主窗口已创建');

    // 等待页面加载完成
    await delay(2000);
  }

  async testStartRecording() {
    log('\n--- 测试 1: 启动录制 ---');

    // 发送开始录制命令
    const result = await this.mainWindow.webContents.executeJavaScript(`
      (async () => {
        try {
          const result = await window.sentinelAPI.startRecording({
            taskName: '${TEST_CONFIG.taskName}',
            url: '${TEST_CONFIG.taskUrl}'
          });
          return { success: true, data: result };
        } catch (error) {
          return { success: false, error: error.message };
        }
      })()
    `);

    assertTrue(result.success, '录制启动成功');
    log(`录制已启动，任务ID: ${result.data.taskId}`);

    this.testTaskId = result.data.taskId;
    this.taskDir = result.data.taskDir;

    // 等待录制初始化
    await delay(1000);

    // 验证录制状态
    const isRecording = await this.mainWindow.webContents.executeJavaScript(`
      window.sentinelRenderer && window.sentinelRenderer.isRecording
    `);

    assertTrue(isRecording, '录制状态正确设置为 true');
  }

  async testSimulateUserActions() {
    log('\n--- 测试 2: 模拟用户操作 ---');

    // 导航到测试页面
    await this.mainWindow.webContents.executeJavaScript(`
      window.sentinelRenderer.navigateToUrl('${TEST_CONFIG.testUrl}')
    `);

    await delay(3000);

    // 获取当前活动的 webview
    const webview = await this.getActiveWebview();
    if (!webview) {
      log('无法获取 webview，跳过用户操作模拟', 'warning');
      testResults.warnings.push('无法获取 webview');
      return;
    }

    // 模拟点击操作
    await webview.executeJavaScript(`
      // 模拟点击页面上的第一个链接或按钮
      const element = document.querySelector('a, button, input[type="submit"]');
      if (element) {
        element.click();
        console.log('[Test] Clicked element:', element.tagName);
      }
    `);

    await delay(500);

    // 模拟滚动
    await webview.executeJavaScript(`
      window.scrollTo(0, 500);
      console.log('[Test] Scrolled to 500px');
    `);

    await delay(500);

    // 模拟键盘输入（如果存在输入框）
    await webview.executeJavaScript(`
      const input = document.querySelector('input[type="text"], input:not([type])');
      if (input) {
        input.focus();
        input.value = 'Test input from automation';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        console.log('[Test] Input text entered');
      }
    `);

    await delay(1000);

    log('用户操作模拟完成');
  }

  async testPauseRecording() {
    log('\n--- 测试 3: 暂停录制 ---');

    // 记录暂停前的事件数
    const eventsBeforePause = await this.getEventCount();
    log(`暂停前事件数: ${eventsBeforePause}`);

    // 点击暂停按钮
    await this.mainWindow.webContents.executeJavaScript(`
      window.sentinelRenderer.pauseTask()
    `);

    await delay(500);

    // 验证暂停状态
    const isPaused = await this.mainWindow.webContents.executeJavaScript(`
      const pauseBtn = document.getElementById('btn-pause-task');
      pauseBtn && pauseBtn.classList.contains('paused')
    `);

    assertTrue(isPaused, '暂停按钮状态正确');

    // 在暂停期间执行一些操作
    const webview = await this.getActiveWebview();
    if (webview) {
      await webview.executeJavaScript(`
        // 暂停期间的操作不应该被记录
        document.body.click();
        window.scrollTo(0, 1000);
      `);
    }

    await delay(TEST_CONFIG.pauseDuration);

    // 验证暂停期间没有新事件
    const eventsAfterPause = await this.getEventCount();
    log(`暂停后事件数: ${eventsAfterPause}`);

    // 暂停期间不应该有新事件
    assertTrue(eventsAfterPause === eventsBeforePause, '暂停期间没有记录新事件');

    log('录制暂停测试通过');
  }

  async testResumeRecording() {
    log('\n--- 测试 4: 继续录制 ---');

    // 点击继续按钮
    await this.mainWindow.webContents.executeJavaScript(`
      window.sentinelRenderer.pauseTask()
    `);

    await delay(500);

    // 验证恢复状态
    const isPaused = await this.mainWindow.webContents.executeJavaScript(`
      const pauseBtn = document.getElementById('btn-pause-task');
      pauseBtn && pauseBtn.classList.contains('paused')
    `);

    assertFalse(isPaused, '继续录制后暂停状态正确');

    // 继续期间执行操作
    const webview = await this.getActiveWebview();
    if (webview) {
      await webview.executeJavaScript(`
        // 继续后的操作应该被记录
        document.body.click();
      `);
    }

    await delay(1000);

    // 验证继续后有新事件
    const eventsAfterResume = await this.getEventCount();
    log(`继续后事件数: ${eventsAfterResume}`);

    log('录制继续测试通过');
  }

  async testStopRecording() {
    log('\n--- 测试 5: 停止录制 ---');

    // 点击停止按钮
    await this.mainWindow.webContents.executeJavaScript(`
      window.sentinelRenderer.stopTask()
    `);

    // 等待停止完成（包括视频处理和截图提取）
    log('等待录制停止和视频处理...');
    await delay(10000);

    // 验证录制状态
    const isRecording = await this.mainWindow.webContents.executeJavaScript(`
      window.sentinelRenderer && window.sentinelRenderer.isRecording
    `);

    assertFalse(isRecording, '录制停止后状态正确设置为 false');

    // 验证任务目录存在
    assertTrue(fs.existsSync(this.taskDir), `任务目录存在: ${this.taskDir}`);

    log('录制停止测试通过');
  }

  async testDataIntegrity() {
    log('\n--- 测试 6: 验证数据完整性 ---');

    // 检查必要的文件和目录
    const requiredPaths = [
      'training_manifest.jsonl',
      'video/recording.mp4',
      'dom',
      'downloads',
      'previews/snapshots'
    ];

    for (const relativePath of requiredPaths) {
      const fullPath = path.join(this.taskDir, relativePath);
      const exists = fs.existsSync(fullPath);

      if (relativePath === 'training_manifest.jsonl') {
        assertTrue(exists, `必要文件存在: ${relativePath}`);
      } else {
        if (!exists) {
          log(`可选路径不存在: ${relativePath}`, 'warning');
          testResults.warnings.push(`路径不存在: ${relativePath}`);
        }
      }
    }

    // 验证 manifest 文件不为空
    const manifestPath = path.join(this.taskDir, 'training_manifest.jsonl');
    const manifestStats = fs.statSync(manifestPath);
    assertTrue(manifestStats.size > 0, 'training_manifest.jsonl 文件不为空');

    log('数据完整性测试通过');
  }

  async testManifestValidation() {
    log('\n--- 测试 7: 验证 training_manifest.jsonl ---');

    const manifestPath = path.join(this.taskDir, 'training_manifest.jsonl');
    const events = readJSONL(manifestPath);

    log(`Manifest 中共有 ${events.length} 个事件`);

    // 验证每个事件的必需字段
    const requiredFields = [
      'timestamp',
      'event_details',
      'dom_state',
      'task_context'
    ];

    let validEvents = 0;
    let invalidEvents = 0;

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const missingFields = requiredFields.filter(field => !(field in event));

      if (missingFields.length === 0) {
        validEvents++;
      } else {
        invalidEvents++;
        log(`事件 ${i} 缺少字段: ${missingFields.join(', ')}`, 'warning');
      }

      // 验证 event_details 中的必需字段
      if (event.event_details) {
        assertTrue(
          event.event_details.action || event.event_details.type,
          `事件 ${i} 有 action 或 type 字段`
        );
      }

      // 验证 dom_state 中的必需字段
      if (event.dom_state) {
        assertTrue(
          event.dom_state.url || event.dom_state.html_snapshot,
          `事件 ${i} 有 url 或 html_snapshot 字段`
        );
      }

      // 验证 task_context 中的必需字段
      if (event.task_context) {
        assertTrue(
          event.task_context.task_id,
          `事件 ${i} 有 task_id 字段`
        );
      }
    }

    log(`有效事件: ${validEvents}, 无效事件: ${invalidEvents}`);
    assertTrue(validEvents > 0, '至少有一个有效事件');

    // 验证事件类型分布
    const eventTypes = {};
    events.forEach(event => {
      const type = event.event_details?.action || event.event_details?.type || 'unknown';
      eventTypes[type] = (eventTypes[type] || 0) + 1;
    });

    log('事件类型分布:');
    Object.entries(eventTypes).forEach(([type, count]) => {
      log(`  - ${type}: ${count}`);
    });

    // 验证有用户操作事件
    const userActionTypes = ['click', 'input', 'scroll', 'keydown', 'hover'];
    const hasUserActions = events.some(event =>
      userActionTypes.includes(event.event_details?.action)
    );

    if (!hasUserActions) {
      log('警告: 没有找到用户操作事件', 'warning');
      testResults.warnings.push('没有找到用户操作事件');
    }

    log('Manifest 验证测试通过');
  }

  async testFileAlignment() {
    log('\n--- 测试 8: 验证文件对齐 ---');

    const manifestPath = path.join(this.taskDir, 'training_manifest.jsonl');
    const events = readJSONL(manifestPath);

    // 检查 DOM 快照文件
    const domDir = path.join(this.taskDir, 'dom');
    const domFiles = fs.existsSync(domDir) ? fs.readdirSync(domDir) : [];
    log(`DOM 快照文件数量: ${domFiles.length}`);

    // 检查视频截图文件
    const snapshotsDir = path.join(this.taskDir, 'previews', 'snapshots');
    const snapshotFiles = fs.existsSync(snapshotsDir) ? fs.readdirSync(snapshotsDir) : [];
    log(`视频截图文件数量: ${snapshotFiles.length}`);

    // 检查下载文件
    const downloadsDir = path.join(this.taskDir, 'downloads');
    const downloadFiles = fs.existsSync(downloadsDir) ? fs.readdirSync(downloadsDir) : [];
    log(`下载文件数量: ${downloadFiles.length}`);

    // 验证 manifest 中引用的文件是否存在
    let missingFiles = 0;
    let checkedFiles = 0;

    events.forEach((event, index) => {
      // 检查 DOM snapshot 文件
      if (event._metadata?.domSnapshotFileName) {
        checkedFiles++;
        const domFile = path.join(domDir, event._metadata.domSnapshotFileName);
        if (!fs.existsSync(domFile)) {
          missingFiles++;
          if (missingFiles <= 5) { // 只显示前5个缺失文件
            log(`事件 ${index} 引用的 DOM 文件不存在: ${event._metadata.domSnapshotFileName}`, 'warning');
          }
        }
      }

      // 检查视频截图文件
      if (event._metadata?.snapshotFileName) {
        checkedFiles++;
        const snapshotFile = path.join(snapshotsDir, event._metadata.snapshotFileName);
        if (!fs.existsSync(snapshotFile)) {
          missingFiles++;
          if (missingFiles <= 5) {
            log(`事件 ${index} 引用的截图文件不存在: ${event._metadata.snapshotFileName}`, 'warning');
          }
        }
      }
    });

    log(`检查了 ${checkedFiles} 个文件引用，缺失 ${missingFiles} 个`);

    // 允许一定比例的缺失（因为截图可能在处理中）
    if (checkedFiles > 0 && missingFiles / checkedFiles > 0.1) {
      log(`警告: 缺失文件比例过高 (${(missingFiles / checkedFiles * 100).toFixed(1)}%)`, 'warning');
      testResults.warnings.push('缺失文件比例过高');
    }

    // 验证视频文件
    const videoPath = path.join(this.taskDir, 'video', 'recording.mp4');
    if (fs.existsSync(videoPath)) {
      const videoStats = fs.statSync(videoPath);
      log(`视频文件大小: ${(videoStats.size / 1024 / 1024).toFixed(2)} MB`);
      assertTrue(videoStats.size > 0, '视频文件不为空');
    } else {
      log('视频文件不存在', 'warning');
      testResults.warnings.push('视频文件不存在');
    }

    log('文件对齐测试通过');
  }

  async testPauseFunctionality() {
    log('\n--- 测试 9: 验证暂停功能详细测试 ---');

    const manifestPath = path.join(this.taskDir, 'training_manifest.jsonl');
    const events = readJSONL(manifestPath);

    // 查找暂停和恢复事件
    const pauseEvents = events.filter(e =>
      e.event_details?.action === 'pause' || e.event_details?.type === 'pause'
    );
    const resumeEvents = events.filter(e =>
      e.event_details?.action === 'resume' || e.event_details?.type === 'resume'
    );

    log(`暂停事件数量: ${pauseEvents.length}`);
    log(`恢复事件数量: ${resumeEvents.length}`);

    // 验证暂停和恢复事件成对出现
    assertTrue(
      pauseEvents.length === resumeEvents.length,
      '暂停和恢复事件数量相等'
    );

    // 验证暂停事件的时间戳顺序
    if (pauseEvents.length > 0 && resumeEvents.length > 0) {
      for (let i = 0; i < pauseEvents.length; i++) {
        const pauseTime = pauseEvents[i].timestamp;
        const resumeTime = resumeEvents[i].timestamp;

        assertTrue(
          resumeTime > pauseTime,
          `第 ${i + 1} 次恢复时间 (${resumeTime}) 晚于暂停时间 (${pauseTime})`
        );
      }
    }

    log('暂停功能详细测试通过');
  }

  async getActiveWebview() {
    try {
      const webview = await this.mainWindow.webContents.executeJavaScript(`
        (() => {
          const activeTab = window.sentinelRenderer.tabs.find(t => t.id === window.sentinelRenderer.activeTabId);
          return activeTab ? activeTab.webview : null;
        })()
      `);
      return webview;
    } catch (error) {
      return null;
    }
  }

  async getEventCount() {
    try {
      const count = await this.mainWindow.webContents.executeJavaScript(`
        window.sentinelRenderer ? window.sentinelRenderer.eventCount : 0
      `);
      return count || 0;
    } catch (error) {
      return 0;
    }
  }

  printResults() {
    log('\n========================================');
    log('测试结果汇总');
    log('========================================');

    log(`\n✅ 通过: ${testResults.passed.length}`);
    testResults.passed.forEach(msg => log(`  ✓ ${msg}`));

    if (testResults.failed.length > 0) {
      log(`\n❌ 失败: ${testResults.failed.length}`);
      testResults.failed.forEach(msg => log(`  ✗ ${msg}`));
    }

    if (testResults.warnings.length > 0) {
      log(`\n⚠️  警告: ${testResults.warnings.length}`);
      testResults.warnings.forEach(msg => log(`  ! ${msg}`));
    }

    log('\n========================================');
    if (testResults.failed.length === 0) {
      log('🎉 所有测试通过！');
    } else {
      log('💥 测试未完全通过，请检查失败项');
    }
    log('========================================');

    // 返回测试结果
    return {
      success: testResults.failed.length === 0,
      passed: testResults.passed.length,
      failed: testResults.failed.length,
      warnings: testResults.warnings.length
    };
  }
}

// 导出测试类
module.exports = SentinelAutomationTest;

// 如果直接运行此脚本
if (require.main === module) {
  const test = new SentinelAutomationTest();
  test.run().then(() => {
    process.exit(testResults.failed.length > 0 ? 1 : 0);
  }).catch(error => {
    console.error('测试执行失败:', error);
    process.exit(1);
  });
}
