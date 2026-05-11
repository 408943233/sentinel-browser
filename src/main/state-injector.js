const fs = require('fs');
const path = require('path');
const log = require('electron-log');

/**
 * 同步状态注入器
 * 用于在回放模式下劫持存储 API 并注入静态数据
 */
class StateInjector {
  constructor() {
    this.injectionScript = null;
    this.browserState = null;
  }

  /**
   * 加载 browser_state.json
   */
  loadState(statePath) {
    try {
      if (!fs.existsSync(statePath)) {
        log.warn('Browser state file not found:', statePath);
        return false;
      }

      const data = fs.readFileSync(statePath, 'utf-8');
      this.browserState = JSON.parse(data);
      log.info('Browser state loaded from:', statePath);
      return true;
    } catch (error) {
      log.error('Failed to load browser state:', error);
      return false;
    }
  }

  /**
   * 生成注入脚本
   */
  generateInjectionScript() {
    if (!this.browserState) {
      log.warn('No browser state loaded, cannot generate injection script');
      return null;
    }

    const stateData = JSON.stringify(this.browserState);

    this.injectionScript = `
(function() {
  'use strict';
  
  // 防止重复注入
  if (window.__SENTINEL_STATE_INJECTED__) return;
  window.__SENTINEL_STATE_INJECTED__ = true;
  
  console.log('[Sentinel] State injection starting...');
  
  // 解析状态数据
  const browserState = ${stateData};
  
  // ==================== localStorage 劫持 ====================
  const originalLocalStorage = window.localStorage;
  const localStorageData = browserState.localStorage || {};
  
  // 创建虚拟 localStorage
  const virtualLocalStorage = {
    _data: { ...localStorageData },
    
    getItem(key) {
      return this._data[key] || null;
    },
    
    setItem(key, value) {
      // 在回放模式下，阻止写入，只更新内存
      this._data[key] = String(value);
      console.log('[Sentinel] localStorage.setItem blocked:', key);
    },
    
    removeItem(key) {
      delete this._data[key];
      console.log('[Sentinel] localStorage.removeItem blocked:', key);
    },
    
    clear() {
      this._data = {};
      console.log('[Sentinel] localStorage.clear blocked');
    },
    
    key(index) {
      const keys = Object.keys(this._data);
      return keys[index] || null;
    },
    
    get length() {
      return Object.keys(this._data).length;
    }
  };
  
  // 劫持 localStorage
  try {
    Object.defineProperty(window, 'localStorage', {
      get() {
        return virtualLocalStorage;
      },
      set() {
        console.log('[Sentinel] Attempt to override localStorage blocked');
      },
      configurable: false
    });
    console.log('[Sentinel] localStorage hijacked');
  } catch (e) {
    console.error('[Sentinel] Failed to hijack localStorage:', e);
  }
  
  // ==================== sessionStorage 劫持 ====================
  const sessionStorageData = browserState.sessionStorage || {};
  
  const virtualSessionStorage = {
    _data: { ...sessionStorageData },
    
    getItem(key) {
      return this._data[key] || null;
    },
    
    setItem(key, value) {
      this._data[key] = String(value);
      console.log('[Sentinel] sessionStorage.setItem blocked:', key);
    },
    
    removeItem(key) {
      delete this._data[key];
      console.log('[Sentinel] sessionStorage.removeItem blocked:', key);
    },
    
    clear() {
      this._data = {};
      console.log('[Sentinel] sessionStorage.clear blocked');
    },
    
    key(index) {
      const keys = Object.keys(this._data);
      return keys[index] || null;
    },
    
    get length() {
      return Object.keys(this._data).length;
    }
  };
  
  try {
    Object.defineProperty(window, 'sessionStorage', {
      get() {
        return virtualSessionStorage;
      },
      set() {
        console.log('[Sentinel] Attempt to override sessionStorage blocked');
      },
      configurable: false
    });
    console.log('[Sentinel] sessionStorage hijacked');
  } catch (e) {
    console.error('[Sentinel] Failed to hijack sessionStorage:', e);
  }
  
  // ==================== IndexedDB 劫持 ====================
  const indexedDBData = browserState.indexedDB || {};
  const originalIndexedDB = window.indexedDB;
  
  // 创建虚拟 IndexedDB
  const virtualIndexedDB = {
    // 模拟 open 方法
    open(dbName, version) {
      console.log('[Sentinel] indexedDB.open intercepted:', dbName);
      
      const dbState = indexedDBData[dbName];
      
      return {
        result: null,
        error: null,
        source: null,
        transaction: null,
        readyState: 'pending',
        
        set onsuccess(handler) {
          // 异步模拟成功回调
          setTimeout(() => {
            this.result = createVirtualDatabase(dbName, dbState);
            this.readyState = 'done';
            if (handler) handler({ target: this });
          }, 0);
        },
        
        set onerror(handler) {
          if (!dbState) {
            setTimeout(() => {
              this.error = new Error('Database not found in snapshot');
              if (handler) handler({ target: this });
            }, 0);
          }
        },
        
        set onupgradeneeded(handler) {
          // 在回放模式下不触发升级
          console.log('[Sentinel] onupgradeneeded suppressed');
        },
        
        set onblocked(handler) {
          console.log('[Sentinel] onblocked suppressed');
        }
      };
    },
    
    // 模拟 deleteDatabase
    deleteDatabase(dbName) {
      console.log('[Sentinel] indexedDB.deleteDatabase blocked:', dbName);
      return {
        result: undefined,
        error: null,
        readyState: 'pending',
        
        set onsuccess(handler) {
          setTimeout(() => {
            this.readyState = 'done';
            if (handler) handler({ target: this });
          }, 0);
        },
        
        set onerror(handler) {
          this.error = null;
        }
      };
    },
    
    // 模拟 databases
    databases() {
      console.log('[Sentinel] indexedDB.databases intercepted');
      return Promise.resolve(
        Object.keys(indexedDBData).map(name => ({
          name: name,
          version: indexedDBData[name].version
        }))
      );
    },
    
    // 模拟 cmp
    cmp(first, second) {
      if (first < second) return -1;
      if (first > second) return 1;
      return 0;
    }
  };
  
  // 创建虚拟数据库对象
  function createVirtualDatabase(dbName, dbState) {
    if (!dbState) {
      return null;
    }
    
    const objectStores = {};
    
    // 为每个 ObjectStore 创建虚拟存储
    dbState.objectStores.forEach(storeName => {
      const storeData = dbState.data[storeName] || [];
      
      objectStores[storeName] = {
        _data: [...storeData],
        _name: storeName,
        _keyPath: 'id',
        _autoIncrement: false,
        
        // 模拟 add
        add(value, key) {
          console.log('[Sentinel] IDBObjectStore.add blocked');
          return createVirtualRequest();
        },
        
        // 模拟 put
        put(value, key) {
          console.log('[Sentinel] IDBObjectStore.put blocked');
          return createVirtualRequest();
        },
        
        // 模拟 get
        get(key) {
          console.log('[Sentinel] IDBObjectStore.get:', key);
          const item = this._data.find(item => item.id === key || item._key === key);
          return createVirtualRequest(item);
        },
        
        // 模拟 getAll
        getAll(query, count) {
          console.log('[Sentinel] IDBObjectStore.getAll');
          return createVirtualRequest(this._data);
        },
        
        // 模拟 delete
        delete(key) {
          console.log('[Sentinel] IDBObjectStore.delete blocked');
          return createVirtualRequest();
        },
        
        // 模拟 clear
        clear() {
          console.log('[Sentinel] IDBObjectStore.clear blocked');
          return createVirtualRequest();
        },
        
        // 模拟 openCursor
        openCursor(query, direction) {
          console.log('[Sentinel] IDBObjectStore.openCursor');
          let index = 0;
          const data = this._data;
          
          const cursor = {
            source: this,
            direction: direction || 'next',
            key: null,
            primaryKey: null,
            value: null,
            
            continue() {
              if (index < data.length) {
                this.value = data[index];
                this.key = this.value.id || index;
                this.primaryKey = this.key;
                index++;
                if (this.onsuccess) {
                  this.onsuccess({ target: { result: this } });
                }
              } else {
                if (this.onsuccess) {
                  this.onsuccess({ target: { result: null } });
                }
              }
            },
            
            continuePrimaryKey(key, primaryKey) {
              this.continue();
            },
            
            advance(count) {
              index += count;
              this.continue();
            },
            
            update(value) {
              console.log('[Sentinel] IDBCursor.update blocked');
              return createVirtualRequest();
            },
            
            delete() {
              console.log('[Sentinel] IDBCursor.delete blocked');
              return createVirtualRequest();
            }
          };
          
          // 启动游标
          setTimeout(() => {
            cursor.continue();
          }, 0);
          
          return createVirtualRequest(cursor);
        },
        
        // 属性
        get name() { return this._name; },
        get keyPath() { return this._keyPath; },
        get autoIncrement() { return this._autoIncrement; },
        get transaction() { return null; },
        get indexNames() { return []; }
      };
    });
    
    // 创建虚拟数据库
    const virtualDB = {
      name: dbName,
      version: dbState.version,
      objectStoreNames: {
        _stores: dbState.objectStores,
        length: dbState.objectStores.length,
        item(index) { return this._stores[index]; },
        contains(name) { return this._stores.includes(name); }
      },
      
      // 模拟 transaction
      transaction(storeNames, mode) {
        console.log('[Sentinel] IDBDatabase.transaction:', storeNames, mode);
        
        const stores = Array.isArray(storeNames) ? storeNames : [storeNames];
        
        return {
          db: this,
          mode: mode || 'readonly',
          objectStoreNames: stores,
          
          objectStore(name) {
            return objectStores[name] || null;
          },
          
          abort() {
            console.log('[Sentinel] IDBTransaction.abort blocked');
          },
          
          commit() {
            console.log('[Sentinel] IDBTransaction.commit blocked');
          },
          
          set onabort(handler) {},
          set oncomplete(handler) {
            setTimeout(() => {
              if (handler) handler({ target: this });
            }, 0);
          },
          set onerror(handler) {}
        };
      },
      
      // 模拟 createObjectStore（在回放模式下禁用）
      createObjectStore(name, options) {
        console.log('[Sentinel] IDBDatabase.createObjectStore blocked:', name);
        throw new Error('Cannot create object store in replay mode');
      },
      
      // 模拟 deleteObjectStore
      deleteObjectStore(name) {
        console.log('[Sentinel] IDBDatabase.deleteObjectStore blocked:', name);
        throw new Error('Cannot delete object store in replay mode');
      },
      
      // 模拟 close
      close() {
        console.log('[Sentinel] IDBDatabase.close');
      },
      
      set onabort(handler) {},
      set onclose(handler) {},
      set onerror(handler) {},
      set onversionchange(handler) {}
    };
    
    return virtualDB;
  }
  
  // 创建虚拟请求对象
  function createVirtualRequest(result) {
    return {
      result: result,
      error: null,
      source: null,
      transaction: null,
      readyState: 'done',
      
      set onsuccess(handler) {
        setTimeout(() => {
          if (handler) handler({ target: this });
        }, 0);
      },
      
      set onerror(handler) {}
    };
  }
  
  // 劫持 indexedDB
  try {
    Object.defineProperty(window, 'indexedDB', {
      get() {
        return virtualIndexedDB;
      },
      set() {
        console.log('[Sentinel] Attempt to override indexedDB blocked');
      },
      configurable: false
    });
    console.log('[Sentinel] indexedDB hijacked');
  } catch (e) {
    console.error('[Sentinel] Failed to hijack indexedDB:', e);
  }
  
  // ==================== Cookies 劫持 ====================
  const cookiesData = browserState.cookies || [];
  
  // 劫持 document.cookie
  const virtualCookies = {
    _cookies: cookiesData.map(c => \`\${c.name}=\${c.value}\`).join('; '),
    
    get() {
      return this._cookies;
    },
    
    set(value) {
      console.log('[Sentinel] document.cookie set blocked:', value);
      // 解析并添加到内存中，但不持久化
      const parts = value.split(';');
      const [nameValue] = parts;
      const [name, val] = nameValue.split('=');
      
      // 更新内存中的 cookies 字符串
      const existing = this._cookies.split('; ').filter(c => !c.startsWith(name + '='));
      existing.push(\`\${name.trim()}=\${val ? val.trim() : ''}\`);
      this._cookies = existing.filter(c => c).join('; ');
    }
  };
  
  try {
    Object.defineProperty(document, 'cookie', {
      get() {
        return virtualCookies.get();
      },
      set(value) {
        virtualCookies.set(value);
      },
      configurable: false
    });
    console.log('[Sentinel] document.cookie hijacked');
  } catch (e) {
    console.error('[Sentinel] Failed to hijack document.cookie:', e);
  }
  
  console.log('[Sentinel] State injection completed');
})();
`;

    return this.injectionScript;
  }

  /**
   * 获取注入脚本（用于插入到 HTML 中）
   */
  getInjectionScript() {
    if (!this.injectionScript) {
      this.generateInjectionScript();
    }
    return this.injectionScript;
  }

  /**
   * 将脚本注入到 HTML 中
   */
  injectIntoHTML(htmlContent) {
    const script = this.getInjectionScript();
    if (!script) {
      return htmlContent;
    }

    // 在 <head> 标签最前端注入脚本
    const scriptTag = `<script>${script}</script>`;
    
    // 查找 <head> 标签
    const headMatch = htmlContent.match(/<head[^>]*>/i);
    if (headMatch) {
      const insertPosition = headMatch.index + headMatch[0].length;
      return htmlContent.slice(0, insertPosition) + scriptTag + htmlContent.slice(insertPosition);
    }
    
    // 如果没有 <head>，在 <html> 后添加
    const htmlMatch = htmlContent.match(/<html[^>]*>/i);
    if (htmlMatch) {
      const insertPosition = htmlMatch.index + htmlMatch[0].length;
      return htmlContent.slice(0, insertPosition) + '<head>' + scriptTag + '</head>' + htmlContent.slice(insertPosition);
    }
    
    // 如果都没有，直接在开头添加
    return scriptTag + htmlContent;
  }
}

module.exports = StateInjector;
