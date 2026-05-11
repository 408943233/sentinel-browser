// Sentinel Browser 2.0 - 共享常量

const CONSTANTS = {
  // 应用信息
  APP_NAME: 'Sentinel Browser',
  APP_VERSION: '2.0.0',
  
  // 存储路径
  STORAGE_DIR: 'collections',
  
  // 录制配置
  RECORDING: {
    DEFAULT_VIDEO_CODEC: 'libx264',
    DEFAULT_PRESET: 'ultrafast',
    DEFAULT_FPS: 30,
    INACTIVITY_TIMEOUT: 5 * 60 * 1000, // 5分钟
    DISK_SPACE_THRESHOLD: 2 * 1024 * 1024 * 1024, // 2GB
  },
  
  // 视频编码器
  VIDEO_CODECS: {
    CPU: 'libx264',
    NVIDIA: 'h264_nvenc',
    INTEL: 'h264_qsv',
    MAC: 'h264_videotoolbox'
  },
  
  // 事件类型
  EVENT_TYPES: {
    CLICK: 'click',
    INPUT: 'input',
    SCROLL: 'scroll',
    NAVIGATION: 'navigation',
    API_REQUEST: 'api_request',
    API_RESPONSE: 'api_response',
    ERROR: 'error',
    UI_EVENT: 'ui_event',
    DOM_MUTATION: 'dom_mutation',
    STATE_CHANGE: 'state_change'
  },
  
  // IPC通道
  IPC_CHANNELS: {
    START_RECORDING: 'start-recording',
    STOP_RECORDING: 'stop-recording',
    GET_TASKS: 'get-tasks',
    EXPORT_TASK: 'export-task',
    REPORT_ERROR: 'report-error',
    REPORT_UI_EVENT: 'report-ui-event',
    USER_ACTIVITY: 'user-activity',
    RECORDING_STARTED: 'recording-started',
    RECORDING_STOPPED: 'recording-stopped'
  },
  
  // 文件类型
  FILE_TYPES: {
    VIDEO: 'video',
    PREVIEW: 'preview',
    DOWNLOAD: 'download',
    STATE: 'state',
    MANIFEST: 'manifest'
  },
  
  // Shadow DOM选择器
  SHADOW_DOM_SELECTORS: [
    '*::shadow',
    '::slotted(*)',
    '::part(*)'
  ]
};

module.exports = CONSTANTS;
