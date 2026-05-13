const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const log = require('electron-log');
const { app } = require('electron');

/**
 * Watchdog 守护进程
 * 监控主进程和FFmpeg健康状态
 */
class WatchdogManager {
  constructor() {
    this.watchdogProcess = null;
    this.isRunning = false;
    this.heartbeatFile = path.join(app.getPath('temp'), 'sentinel_heartbeat.json');
    // 使用 temp 目录存放日志，避免 logs 目录不存在的问题
    this.logFile = path.join(app.getPath('temp'), 'sentinel_watchdog.log');
  }

  /**
   * 启动Watchdog
   */
  start() {
    if (this.isRunning) {
      log.warn('Watchdog already running');
      return;
    }

    const parentPid = process.pid;
    
    // 创建Watchdog脚本
    const watchdogScript = `
      const fs = require('fs');
      const path = require('path');
      const { spawn } = require('child_process');
      
      const PARENT_PID = ${parentPid};
      const HEARTBEAT_FILE = '${this.heartbeatFile.replace(/\\/g, '\\\\')}';
      const LOG_FILE = '${this.logFile.replace(/\\/g, '\\\\')}';
      
      let lastHeartbeat = Date.now();
      let restartCount = 0;
      const MAX_RESTARTS = 3;
      
      function log(message) {
        const ts = new Date().toISOString();
        const logLine = '[' + ts + '] ' + message + '\n';
        fs.appendFileSync(LOG_FILE, logLine);
        console.log(logLine);
      }
      
      function checkParent() {
        try {
          process.kill(PARENT_PID, 0);
          return true;
        } catch (e) {
          return false;
        }
      }
      
      function checkHeartbeat() {
        try {
          if (fs.existsSync(HEARTBEAT_FILE)) {
            const data = JSON.parse(fs.readFileSync(HEARTBEAT_FILE, 'utf-8'));
            lastHeartbeat = data.timestamp;
            return Date.now() - lastHeartbeat < 30000; // 30秒超时
          }
          return false;
        } catch (e) {
          return false;
        }
      }
      
      log('Watchdog started, monitoring parent PID: ' + PARENT_PID);
      
      const interval = setInterval(() => {
        if (!checkParent()) {
          log('Parent process died, exiting watchdog');
          clearInterval(interval);
          process.exit(1);
        }
        
        if (!checkHeartbeat()) {
          log('Heartbeat timeout detected');
          restartCount++;
          
          if (restartCount > MAX_RESTARTS) {
            log('Max restarts reached, giving up');
            clearInterval(interval);
            process.exit(1);
          }
        } else {
          restartCount = 0;
        }
      }, 5000);
      
      // 处理信号
      process.on('SIGTERM', () => {
        log('Received SIGTERM, exiting');
        clearInterval(interval);
        process.exit(0);
      });
      
      process.on('SIGINT', () => {
        log('Received SIGINT, exiting');
        clearInterval(interval);
        process.exit(0);
      });
    `;

    // 启动Watchdog进程
    this.watchdogProcess = spawn(process.execPath, ['-e', watchdogScript], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore']
    });

    this.watchdogProcess.unref();
    this.isRunning = true;
    
    log.info('Watchdog started with PID:', this.watchdogProcess.pid);
    
    // 开始发送心跳
    this.startHeartbeat();
  }

  /**
   * 开始发送心跳
   */
  startHeartbeat() {
    const heartbeatInterval = setInterval(() => {
      if (!this.isRunning) {
        clearInterval(heartbeatInterval);
        return;
      }

      try {
        const heartbeat = {
          timestamp: Date.now(),
          pid: process.pid,
          memory: process.memoryUsage(),
          uptime: process.uptime()
        };
        
        fs.writeFileSync(this.heartbeatFile, JSON.stringify(heartbeat));
      } catch (error) {
        log.error('Failed to write heartbeat:', error);
      }
    }, 10000); // 每10秒发送一次心跳
  }

  /**
   * 停止Watchdog
   */
  stop() {
    if (!this.isRunning || !this.watchdogProcess) {
      return;
    }

    log.info('Stopping watchdog...');
    
    // 发送 SIGTERM 信号
    this.watchdogProcess.kill('SIGTERM');
    
    // 设置超时，如果进程不响应则强制终止
    const forceKillTimeout = setTimeout(() => {
      if (this.watchdogProcess && !this.watchdogProcess.killed) {
        log.warn('Watchdog did not respond to SIGTERM, forcing kill...');
        this.watchdogProcess.kill('SIGKILL');
      }
    }, 5000); // 5秒超时
    
    // 监听进程退出
    this.watchdogProcess.on('exit', (code, signal) => {
      clearTimeout(forceKillTimeout);
      log.info('Watchdog stopped with code:', code, 'signal:', signal);
    });
    
    this.isRunning = false;
    
    // 清理心跳文件
    try {
      if (fs.existsSync(this.heartbeatFile)) {
        fs.unlinkSync(this.heartbeatFile);
      }
    } catch (error) {
      log.error('Failed to cleanup heartbeat file:', error);
    }
  }

  /**
   * 获取Watchdog日志
   */
  getLogs() {
    try {
      if (fs.existsSync(this.logFile)) {
        return fs.readFileSync(this.logFile, 'utf-8');
      }
      return '';
    } catch (error) {
      log.error('Failed to read watchdog logs:', error);
      return '';
    }
  }

  /**
   * 清理Watchdog日志
   */
  clearLogs() {
    try {
      if (fs.existsSync(this.logFile)) {
        fs.unlinkSync(this.logFile);
      }
    } catch (error) {
      log.error('Failed to clear watchdog logs:', error);
    }
  }
}

module.exports = WatchdogManager;
