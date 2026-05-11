const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const log = require('electron-log');
const { execSync } = require('child_process');

/**
 * FFmpeg 管理器 - 视频转换功能
 * 主进程只负责视频格式转换，录制在 renderer 进程中完成
 */
class FFmpegManager {
  constructor() {
    this.ffmpegPath = this.getFFmpegPath();
  }

  /**
   * 获取 FFmpeg 可执行文件路径
   */
  getFFmpegPath() {
    // 检查本地 FFmpeg
    const localFFmpeg = path.join(__dirname, '..', '..', 'bin', 'ffmpeg');
    const localFFmpegExe = path.join(__dirname, '..', '..', 'bin', 'ffmpeg.exe');

    if (fs.existsSync(localFFmpeg)) {
      log.info('Using local FFmpeg:', localFFmpeg);
      return localFFmpeg;
    }

    if (fs.existsSync(localFFmpegExe)) {
      log.info('Using local FFmpeg (Windows):', localFFmpegExe);
      return localFFmpegExe;
    }

    // 检查系统 FFmpeg
    try {
      if (process.platform === 'win32') {
        execSync('where ffmpeg', { stdio: 'ignore' });
      } else {
        execSync('which ffmpeg', { stdio: 'ignore' });
      }
      log.info('Using system FFmpeg');
      return 'ffmpeg';
    } catch {
      log.warn('FFmpeg not found in PATH');
      return null;
    }
  }

  /**
   * 检测可用的硬件加速编码器
   */
  detectHardwareEncoder() {
    const platform = process.platform;

    if (platform === 'darwin') {
      // macOS - 使用 VideoToolbox (Apple Silicon/Intel 都支持)
      return 'h264_videotoolbox';
    } else if (platform === 'win32') {
      // Windows - 尝试使用 NVENC 或 QuickSync
      try {
        const result = execSync('nvidia-smi', { encoding: 'utf-8' });
        if (result.includes('NVIDIA')) {
          return 'h264_nvenc';
        }
      } catch {
        // 没有 NVIDIA 显卡
      }
      return 'libx264';
    } else {
      // Linux - 使用软件编码
      return 'libx264';
    }
  }

  /**
   * 将 WebM 转换为 MP4
   * @param {string} webmPath - WebM 文件路径
   * @param {string} mp4Path - 输出的 MP4 文件路径
   * @returns {Promise<boolean>}
   */
  async convertWebMToMP4(webmPath, mp4Path) {
    if (!this.ffmpegPath) {
      log.error('FFmpeg is not available');
      return false;
    }

    if (!fs.existsSync(webmPath)) {
      log.error('WebM file not found:', webmPath);
      return false;
    }

    return new Promise((resolve, reject) => {
      const encoder = this.detectHardwareEncoder();
      log.info('Converting video to MP4 using encoder:', encoder);

      const args = [
        '-i', webmPath,
        '-c:v', encoder,
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-y'
      ];

      if (encoder === 'libx264') {
        args.push('-preset', 'fast');
        args.push('-crf', '23');
      } else if (encoder === 'h264_videotoolbox') {
        args.push('-b:v', '5000k');
        args.push('-allow_sw', '1');
      }

      args.push(mp4Path);

      log.info('FFmpeg command:', this.ffmpegPath, args.join(' '));

      const ffmpeg = spawn(this.ffmpegPath, args);

      let stderr = '';
      ffmpeg.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          log.info('Video conversion completed:', mp4Path);
          // 删除临时的 webm 文件
          try {
            fs.unlinkSync(webmPath);
            log.info('Cleaned up temporary webm file');
          } catch (err) {
            log.warn('Failed to cleanup webm file:', err);
          }
          resolve(true);
        } else {
          log.error('FFmpeg conversion failed:', stderr);
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });

      ffmpeg.on('error', (error) => {
        log.error('FFmpeg process error:', error);
        reject(error);
      });
    });
  }

  /**
   * 从视频中截取指定时间的帧
   * @param {string} videoPath - 视频文件路径
   * @param {number} timeInSeconds - 时间（秒）
   * @param {string} outputPath - 输出图片路径
   * @param {Object} options - 可选参数
   * @param {number} options.quality - 图片质量 1-31（越小越好，默认 2）
   * @param {string} options.format - 图片格式（默认 'png'）
   * @returns {Promise<string>} - 返回输出文件路径
   */
  async extractFrame(videoPath, timeInSeconds, outputPath, options = {}) {
    if (!this.ffmpegPath) {
      log.error('FFmpeg is not available');
      throw new Error('FFmpeg is not available');
    }

    if (!fs.existsSync(videoPath)) {
      log.error('Video file not found:', videoPath);
      throw new Error('Video file not found');
    }

    const quality = options.quality || 2;
    const format = options.format || 'png';

    // 确保输出目录存在
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    return new Promise((resolve, reject) => {
      // 格式化时间为 HH:MM:SS.mmm
      const hours = Math.floor(timeInSeconds / 3600);
      const minutes = Math.floor((timeInSeconds % 3600) / 60);
      const seconds = Math.floor(timeInSeconds % 60);
      const milliseconds = Math.floor((timeInSeconds % 1) * 1000);
      const timeStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(3, '0')}`;

      const args = [
        '-ss', timeStr,           // 定位到指定时间
        '-i', videoPath,          // 输入视频
        '-vframes', '1',          // 只截取一帧
        '-q:v', quality.toString(), // 图片质量
        '-y',                     // 覆盖已存在文件
        outputPath
      ];

      log.info(`Extracting frame at ${timeStr} from video:`, videoPath);
      log.debug('FFmpeg command:', this.ffmpegPath, args.join(' '));

      const ffmpeg = spawn(this.ffmpegPath, args);

      let stderr = '';
      ffmpeg.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          log.info('Frame extracted successfully:', outputPath);
          resolve(outputPath);
        } else {
          log.error('FFmpeg frame extraction failed:', stderr);
          reject(new Error(`FFmpeg exited with code ${code}: ${stderr}`));
        }
      });

      ffmpeg.on('error', (error) => {
        log.error('FFmpeg process error:', error);
        reject(error);
      });
    });
  }

  /**
   * 批量从视频中截取多个时间点的帧
   * @param {string} videoPath - 视频文件路径
   * @param {Array<{time: number, outputPath: string}>} frames - 帧信息数组
   * @param {Object} options - 可选参数
   * @returns {Promise<Array<{time: number, outputPath: string, success: boolean, error?: string}>>}
   */
  async extractFramesBatch(videoPath, frames, options = {}) {
    const results = [];

    for (const frame of frames) {
      try {
        await this.extractFrame(videoPath, frame.time, frame.outputPath, options);
        results.push({
          time: frame.time,
          outputPath: frame.outputPath,
          success: true
        });
      } catch (error) {
        log.error(`Failed to extract frame at ${frame.time}s:`, error.message);
        results.push({
          time: frame.time,
          outputPath: frame.outputPath,
          success: false,
          error: error.message
        });
      }
    }

    return results;
  }

  /**
   * 获取视频信息（时长、分辨率等）
   * @param {string} videoPath - 视频文件路径
   * @returns {Promise<Object>} - 视频信息
   */
  async getVideoInfo(videoPath) {
    if (!this.ffmpegPath) {
      throw new Error('FFmpeg is not available');
    }

    if (!fs.existsSync(videoPath)) {
      throw new Error('Video file not found');
    }

    return new Promise((resolve, reject) => {
      const args = [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=duration,width,height,r_frame_rate',
        '-show_entries', 'format=duration',
        '-of', 'json',
        videoPath
      ];

      // 使用 ffprobe 获取视频信息
      const ffprobePath = this.ffmpegPath.replace('ffmpeg', 'ffprobe');

      const ffprobe = spawn(ffprobePath, args);

      let stdout = '';
      let stderr = '';

      ffprobe.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      ffprobe.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      ffprobe.on('close', (code) => {
        if (code === 0) {
          try {
            const info = JSON.parse(stdout);
            resolve({
              duration: parseFloat(info.format?.duration || info.streams?.[0]?.duration || 0),
              width: info.streams?.[0]?.width || 0,
              height: info.streams?.[0]?.height || 0,
              frameRate: info.streams?.[0]?.r_frame_rate || '0/0'
            });
          } catch (error) {
            reject(new Error('Failed to parse video info'));
          }
        } else {
          reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
        }
      });

      ffprobe.on('error', (error) => {
        reject(error);
      });
    });
  }
}

module.exports = FFmpegManager;
