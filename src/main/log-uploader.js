const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const log = require('electron-log');

/**
 * 日志上传器
 * 自动上传日志文件到服务器，支持增量上传
 */
class LogUploader {
  constructor(serverUrl) {
    this.serverUrl = serverUrl || 'http://42.193.126.52:80';
    this.uploadEndpoint = '/api/logs/upload';
    // 存储每个文件已上传的位置 { filePath: lastPosition }
    this.uploadPositions = new Map();
  }

  /**
   * 获取文件的上传位置记录文件路径
   * @param {string} logPath - 日志文件路径
   * @returns {string} 位置记录文件路径
   */
  getPositionFilePath(logPath) {
    return logPath + '.uploadpos';
  }

  /**
   * 读取已上传的位置
   * @param {string} logPath - 日志文件路径
   * @returns {number} 已上传的字节位置
   */
  readUploadPosition(logPath) {
    try {
      const positionFile = this.getPositionFilePath(logPath);
      if (fs.existsSync(positionFile)) {
        const position = parseInt(fs.readFileSync(positionFile, 'utf-8'), 10);
        return isNaN(position) ? 0 : position;
      }
    } catch (e) {
      log.warn('[LogUploader] Failed to read upload position:', e.message);
    }
    return 0;
  }

  /**
   * 保存已上传的位置
   * @param {string} logPath - 日志文件路径
   * @param {number} position - 已上传的字节位置
   */
  saveUploadPosition(logPath, position) {
    try {
      const positionFile = this.getPositionFilePath(logPath);
      fs.writeFileSync(positionFile, position.toString());
    } catch (e) {
      log.warn('[LogUploader] Failed to save upload position:', e.message);
    }
  }

  /**
   * 上传日志文件（支持增量上传）
   * @param {string} logPath - 日志文件路径
   * @param {Object} metadata - 附加元数据
   * @returns {Promise<Object>}
   */
  async uploadLog(logPath, metadata = {}) {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(logPath)) {
        reject(new Error(`Log file not found: ${logPath}`));
        return;
      }

      log.info(`[LogUploader] Starting upload for: ${logPath}`);

      // 获取文件总大小
      const totalSize = fs.statSync(logPath).size;
      
      // 读取已上传的位置
      const lastPosition = this.readUploadPosition(logPath);
      
      // 如果没有新内容，跳过上传
      if (lastPosition >= totalSize) {
        log.info(`[LogUploader] No new content to upload for: ${logPath} (last: ${lastPosition}, total: ${totalSize})`);
        resolve({
          success: true,
          skipped: true,
          message: 'No new content to upload',
          lastPosition,
          totalSize
        });
        return;
      }

      // 读取新增的内容
      const newContentSize = totalSize - lastPosition;
      const buffer = Buffer.alloc(newContentSize);
      const fd = fs.openSync(logPath, 'r');
      fs.readSync(fd, buffer, 0, newContentSize, lastPosition);
      fs.closeSync(fd);

      const logContent = buffer.toString('utf-8');

      log.info(`[LogUploader] Log file total size: ${totalSize} bytes, uploading ${newContentSize} bytes (from position ${lastPosition})`);

      // 构建上传数据
      const uploadData = {
        content: logContent,
        filename: path.basename(logPath),
        size: newContentSize,
        totalSize: totalSize,
        startPosition: lastPosition,
        isIncremental: lastPosition > 0,
        timestamp: Date.now(),
        platform: process.platform,
        arch: process.arch,
        version: process.env.npm_package_version || 'unknown',
        ...metadata
      };

      const postData = JSON.stringify(uploadData);

      log.info(`[LogUploader] Upload data size: ${Buffer.byteLength(postData)} bytes`);

      // 解析服务器URL
      const url = new URL(this.serverUrl + this.uploadEndpoint);
      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;

      log.info(`[LogUploader] Server: ${url.hostname}:${url.port || (isHttps ? 443 : 80)}`);

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'X-Log-Source': 'sentinel-browser',
          'X-Client-Version': process.env.npm_package_version || 'unknown',
          'X-Incremental-Upload': lastPosition > 0 ? 'true' : 'false',
          'X-Start-Position': lastPosition.toString()
        },
        timeout: 30000 // 30秒超时
      };

      log.info(`[LogUploader] Uploading log to ${this.serverUrl}${this.uploadEndpoint}`);

      const req = client.request(options, (res) => {
        let responseData = '';

        res.on('data', (chunk) => {
          responseData += chunk;
        });

        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            log.info('[LogUploader] Log uploaded successfully');
            
            // 保存新的上传位置
            this.saveUploadPosition(logPath, totalSize);
            
            try {
              const result = JSON.parse(responseData);
              resolve({
                success: true,
                statusCode: res.statusCode,
                uploadedBytes: newContentSize,
                totalBytes: totalSize,
                data: result
              });
            } catch (e) {
              resolve({
                success: true,
                statusCode: res.statusCode,
                uploadedBytes: newContentSize,
                totalBytes: totalSize,
                data: responseData
              });
            }
          } else {
            log.error(`[LogUploader] Upload failed with status ${res.statusCode}`);
            reject(new Error(`Upload failed: ${res.statusCode} - ${responseData}`));
          }
        });
      });

      req.on('error', (error) => {
        log.error('[LogUploader] Upload error:', error.message);
        reject(error);
      });

      req.on('timeout', () => {
        log.error('[LogUploader] Upload timeout');
        req.destroy();
        reject(new Error('Upload timeout'));
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * 上传所有日志文件
   * @param {string} logDir - 日志目录
   * @param {Object} metadata - 附加元数据
   * @returns {Promise<Array>}
   */
  async uploadAllLogs(logDir, metadata = {}) {
    const results = [];

    log.info(`[LogUploader] Looking for logs in: ${logDir}`);

    if (!fs.existsSync(logDir)) {
      log.warn(`[LogUploader] Log directory not found: ${logDir}`);
      return results;
    }

    // 列出目录内容（调试用）
    try {
      const allFiles = fs.readdirSync(logDir);
      log.info(`[LogUploader] Directory contents:`, allFiles);
    } catch (e) {
      log.error(`[LogUploader] Failed to read directory:`, e.message);
    }

    const logFiles = fs.readdirSync(logDir).filter(file => file.endsWith('.log'));
    log.info(`[LogUploader] Found ${logFiles.length} log files:`, logFiles);

    for (const logFile of logFiles) {
      const logPath = path.join(logDir, logFile);
      try {
        const result = await this.uploadLog(logPath, metadata);
        results.push({
          file: logFile,
          ...result
        });
      } catch (error) {
        log.error(`[LogUploader] Failed to upload ${logFile}:`, error.message);
        results.push({
          file: logFile,
          success: false,
          error: error.message
        });
      }
    }

    return results;
  }

  /**
   * 自动上传任务相关日志
   * @param {string} logDir - 日志目录
   * @param {Object} taskInfo - 任务信息
   * @returns {Promise<Object>}
   */
  async uploadTaskLogs(logDir, taskInfo = {}) {
    const metadata = {
      type: 'task_logs',
      taskId: taskInfo.id || 'unknown',
      taskName: taskInfo.name || 'unknown',
      taskUrl: taskInfo.url || 'unknown',
      recordingDuration: taskInfo.duration || 0,
      uploadTime: new Date().toISOString()
    };

    return this.uploadAllLogs(logDir, metadata);
  }

  /**
   * 重置上传位置（用于全量重新上传）
   * @param {string} logPath - 日志文件路径
   */
  resetUploadPosition(logPath) {
    try {
      const positionFile = this.getPositionFilePath(logPath);
      if (fs.existsSync(positionFile)) {
        fs.unlinkSync(positionFile);
        log.info(`[LogUploader] Reset upload position for: ${logPath}`);
      }
    } catch (e) {
      log.warn('[LogUploader] Failed to reset upload position:', e.message);
    }
  }
}

module.exports = LogUploader;
