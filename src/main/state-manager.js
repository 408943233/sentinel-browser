const fs = require('fs');
const path = require('path');
const log = require('electron-log');

/**
 * 状态管理器
 * 负责捕获、保存和恢复浏览器状态（localStorage, sessionStorage, cookies, IndexedDB）
 */
class StateManager {
  constructor(storagePath) {
    this.storagePath = storagePath;
    this.statesDir = path.join(storagePath, 'states');
    
    if (!fs.existsSync(this.statesDir)) {
      fs.mkdirSync(this.statesDir, { recursive: true });
    }
  }

  /**
   * 捕获完整的浏览器状态
   */
  async captureState(webContents) {
    try {
      const state = {
        timestamp: Date.now(),
        url: webContents.getURL(),
        title: webContents.getTitle(),
        localStorage: await this.captureLocalStorage(webContents),
        sessionStorage: await this.captureSessionStorage(webContents),
        cookies: await this.captureCookies(webContents),
        indexedDB: await this.captureIndexedDB(webContents)
      };
      
      return state;
    } catch (error) {
      log.error('Failed to capture state:', error);
      return null;
    }
  }

  /**
   * 捕获localStorage
   */
  async captureLocalStorage(webContents) {
    try {
      const result = await webContents.executeJavaScript(`
        (function() {
          const data = {};
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            data[key] = localStorage.getItem(key);
          }
          return data;
        })()
      `);
      
      return result;
    } catch (error) {
      log.error('Failed to capture localStorage:', error);
      return {};
    }
  }

  /**
   * 捕获sessionStorage
   */
  async captureSessionStorage(webContents) {
    try {
      const result = await webContents.executeJavaScript(`
        (function() {
          const data = {};
          for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            data[key] = sessionStorage.getItem(key);
          }
          return data;
        })()
      `);
      
      return result;
    } catch (error) {
      log.error('Failed to capture sessionStorage:', error);
      return {};
    }
  }

  /**
   * 捕获cookies
   */
  async captureCookies(webContents) {
    try {
      const { session } = webContents;
      const cookies = await session.cookies.get({});
      return cookies;
    } catch (error) {
      log.error('Failed to capture cookies:', error);
      return [];
    }
  }

  /**
   * 捕获IndexedDB
   */
  async captureIndexedDB(webContents) {
    try {
      const result = await webContents.executeJavaScript(`
        (async function() {
          const databases = await window.indexedDB.databases();
          const result = {};
          
          for (const dbInfo of databases) {
            try {
              const db = await new Promise((resolve, reject) => {
                const request = indexedDB.open(dbInfo.name);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
              });
              
              const dbData = {};
              const objectStoreNames = Array.from(db.objectStoreNames);
              
              for (const storeName of objectStoreNames) {
                const transaction = db.transaction(storeName, 'readonly');
                const store = transaction.objectStore(storeName);
                const data = await new Promise((resolve, reject) => {
                  const request = store.getAll();
                  request.onsuccess = () => resolve(request.result);
                  request.onerror = () => reject(request.error);
                });
                
                dbData[storeName] = data;
              }
              
              result[dbInfo.name] = {
                version: db.version,
                objectStores: objectStoreNames,
                data: dbData
              };
              
              db.close();
            } catch (err) {
              console.error('Failed to export IndexedDB ' + dbInfo.name + ':', err);
            }
          }
          
          return result;
        })()
      `);
      
      return result;
    } catch (error) {
      log.error('Failed to capture IndexedDB:', error);
      return {};
    }
  }

  /**
   * 保存状态到任务目录的 sandbox 文件夹
   */
  saveStateToTask(taskDir, state) {
    try {
      // 创建 sandbox 目录
      const sandboxDir = path.join(taskDir, 'sandbox');
      if (!fs.existsSync(sandboxDir)) {
        fs.mkdirSync(sandboxDir, { recursive: true });
      }

      // 保存 browser_state.json
      const statePath = path.join(sandboxDir, 'browser_state.json');
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      log.info(`State saved to sandbox: ${statePath}`);
      return statePath;
    } catch (error) {
      log.error('Failed to save state:', error);
      return null;
    }
  }

  /**
   * 保存状态到文件（兼容旧版本）
   */
  saveState(taskId, state) {
    try {
      const statePath = path.join(this.statesDir, `${taskId}_state.json`);
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      log.info(`State saved for task ${taskId}`);
      return statePath;
    } catch (error) {
      log.error('Failed to save state:', error);
      return null;
    }
  }

  /**
   * 从文件加载状态
   */
  loadState(taskId) {
    try {
      const statePath = path.join(this.statesDir, `${taskId}_state.json`);
      
      if (!fs.existsSync(statePath)) {
        return null;
      }
      
      const data = fs.readFileSync(statePath, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      log.error('Failed to load state:', error);
      return null;
    }
  }

  /**
   * 恢复localStorage
   */
  async restoreLocalStorage(webContents, data) {
    try {
      await webContents.executeJavaScript(`
        (function() {
          localStorage.clear();
          const data = ${JSON.stringify(data)};
          for (const [key, value] of Object.entries(data)) {
            localStorage.setItem(key, value);
          }
          return true;
        })()
      `);
      
      log.info('localStorage restored');
      return true;
    } catch (error) {
      log.error('Failed to restore localStorage:', error);
      return false;
    }
  }

  /**
   * 恢复sessionStorage
   */
  async restoreSessionStorage(webContents, data) {
    try {
      await webContents.executeJavaScript(`
        (function() {
          sessionStorage.clear();
          const data = ${JSON.stringify(data)};
          for (const [key, value] of Object.entries(data)) {
            sessionStorage.setItem(key, value);
          }
          return true;
        })()
      `);
      
      log.info('sessionStorage restored');
      return true;
    } catch (error) {
      log.error('Failed to restore sessionStorage:', error);
      return false;
    }
  }

  /**
   * 恢复cookies
   */
  async restoreCookies(webContents, cookies) {
    try {
      const { session } = webContents;
      
      for (const cookie of cookies) {
        await session.cookies.set({
          url: cookie.url || webContents.getURL(),
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          expirationDate: cookie.expirationDate
        });
      }
      
      log.info('Cookies restored');
      return true;
    } catch (error) {
      log.error('Failed to restore cookies:', error);
      return false;
    }
  }

  /**
   * 恢复IndexedDB
   */
  async restoreIndexedDB(webContents, databases) {
    try {
      await webContents.executeJavaScript(`
        (async function() {
          const databases = ${JSON.stringify(databases)};
          
          for (const [dbName, dbInfo] of Object.entries(databases)) {
            try {
              // 删除现有数据库
              await new Promise((resolve, reject) => {
                const request = indexedDB.deleteDatabase(dbName);
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
              });
              
              // 重新创建数据库
              const db = await new Promise((resolve, reject) => {
                const request = indexedDB.open(dbName, dbInfo.version);
                request.onupgradeneeded = (event) => {
                  const database = event.target.result;
                  
                  // 创建对象存储
                  for (const storeName of dbInfo.objectStores) {
                    if (!database.objectStoreNames.contains(storeName)) {
                      database.createObjectStore(storeName, { autoIncrement: true });
                    }
                  }
                };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
              });
              
              // 恢复数据
              for (const [storeName, data] of Object.entries(dbInfo.data)) {
                const transaction = db.transaction(storeName, 'readwrite');
                const store = transaction.objectStore(storeName);
                
                for (const item of data) {
                  store.put(item);
                }
              }
              
              db.close();
            } catch (err) {
              console.error('Failed to restore IndexedDB ' + dbName + ':', err);
            }
          }
          
          return true;
        })()
      `);
      
      log.info('IndexedDB restored');
      return true;
    } catch (error) {
      log.error('Failed to restore IndexedDB:', error);
      return false;
    }
  }

  /**
   * 生成状态注入脚本
   * 用于在页面加载前注入状态恢复脚本
   */
  generateStateInjectionScript(state) {
    return `
      <script>
        (function() {
          // 恢复localStorage
          const localStorageData = ${JSON.stringify(state.localStorage || {})};
          for (const [key, value] of Object.entries(localStorageData)) {
            localStorage.setItem(key, value);
          }
          
          // 恢复sessionStorage
          const sessionStorageData = ${JSON.stringify(state.sessionStorage || {})};
          for (const [key, value] of Object.entries(sessionStorageData)) {
            sessionStorage.setItem(key, value);
          }
          
          console.log('[Sentinel] State restored successfully');
        })();
      </script>
    `;
  }

  /**
   * 清理旧的状态文件
   */
  cleanupOldStates(maxAge = 7 * 24 * 60 * 60 * 1000) { // 默认7天
    try {
      const files = fs.readdirSync(this.statesDir);
      const now = Date.now();
      
      for (const file of files) {
        const filePath = path.join(this.statesDir, file);
        const stats = fs.statSync(filePath);
        
        if (now - stats.mtime.getTime() > maxAge) {
          fs.unlinkSync(filePath);
          log.info(`Cleaned up old state file: ${file}`);
        }
      }
    } catch (error) {
      log.error('Failed to cleanup old states:', error);
    }
  }
}

module.exports = StateManager;
