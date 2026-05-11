const { session } = require('electron');
const log = require('electron-log');

/**
 * Chrome DevTools Protocol 管理器
 * 用于处理Shadow DOM遍历和深度DOM操作
 */
class CDPManager {
  constructor() {
    this.clients = new Map();
  }

  /**
   * 连接到WebContents并启用CDP
   */
  async attach(webContents) {
    try {
      const client = await webContents.debugger.attach('1.3');
      
      // 启用必要的域
      await webContents.debugger.sendCommand('DOM.enable');
      await webContents.debugger.sendCommand('Page.enable');
      await webContents.debugger.sendCommand('Runtime.enable');
      
      this.clients.set(webContents.id, {
        webContents,
        attached: true
      });
      
      log.info(`CDP attached to webContents ${webContents.id}`);
      return true;
    } catch (error) {
      log.error('Failed to attach CDP:', error);
      return false;
    }
  }

  /**
   * 获取完整的DOM树，包括Shadow DOM
   */
  async getFlattenedDOM(webContents) {
    try {
      // 使用DOM.getDocument获取完整文档
      const { root } = await webContents.debugger.sendCommand('DOM.getDocument', {
        depth: -1,
        pierce: true
      });
      
      return this.processDOMNode(root);
    } catch (error) {
      log.error('Failed to get flattened DOM:', error);
      return null;
    }
  }

  /**
   * 处理DOM节点，生成唯一路径
   */
  processDOMNode(node, parentPath = '') {
    const result = {
      nodeId: node.nodeId,
      nodeType: node.nodeType,
      nodeName: node.nodeName,
      localName: node.localName,
      nodeValue: node.nodeValue,
      path: parentPath,
      attributes: {},
      children: []
    };

    // 解析属性
    if (node.attributes) {
      for (let i = 0; i < node.attributes.length; i += 2) {
        result.attributes[node.attributes[i]] = node.attributes[i + 1];
      }
    }

    // 生成唯一路径
    const uniquePath = this.generateUniquePath(node, parentPath);
    result.uniquePath = uniquePath;

    // 处理子节点
    if (node.children) {
      result.children = node.children.map((child, index) => 
        this.processDOMNode(child, `${uniquePath} > ${child.nodeName.toLowerCase()}[${index}]`)
      );
    }

    // 处理Shadow Root
    if (node.shadowRoots && node.shadowRoots.length > 0) {
      result.shadowRoots = node.shadowRoots.map((shadowRoot, index) => ({
        mode: shadowRoot.mode,
        children: shadowRoot.children ? 
          shadowRoot.children.map((child, childIndex) => 
            this.processDOMNode(child, `${uniquePath}::shadow-root > ${child.nodeName.toLowerCase()}[${childIndex}]`)
          ) : []
      }));
    }

    // 处理模板内容
    if (node.templateContent) {
      result.templateContent = this.processDOMNode(
        node.templateContent, 
        `${uniquePath}::template-content`
      );
    }

    // 处理伪元素
    if (node.pseudoElements) {
      result.pseudoElements = node.pseudoElements.map(pseudo => ({
        pseudoType: pseudo.pseudoType,
        children: pseudo.children ? 
          pseudo.children.map((child, index) => 
            this.processDOMNode(child, `${uniquePath}::${pseudo.pseudoType}[${index}]`)
          ) : []
      }));
    }

    return result;
  }

  /**
   * 生成唯一路径
   */
  generateUniquePath(node, parentPath) {
    let path = parentPath;
    
    if (node.nodeName) {
      const tagName = node.nodeName.toLowerCase();
      
      // 如果有ID，使用ID
      if (node.attributes && node.attributes.includes('id')) {
        const idIndex = node.attributes.indexOf('id');
        const id = node.attributes[idIndex + 1];
        path = path ? `${path} > #${id}` : `#${id}`;
      } 
      // 如果有class，使用第一个class
      else if (node.attributes && node.attributes.includes('class')) {
        const classIndex = node.attributes.indexOf('class');
        const className = node.attributes[classIndex + 1].split(' ')[0];
        path = path ? `${path} > ${tagName}.${className}` : `${tagName}.${className}`;
      } 
      // 否则使用标签名
      else {
        path = path ? `${path} > ${tagName}` : tagName;
      }
    }
    
    return path;
  }

  /**
   * 执行JavaScript并获取Shadow DOM信息
   */
  async executeShadowDOMScript(webContents) {
    const script = `
      (function() {
        function getShadowDOMInfo(element, path = '') {
          const info = {
            tagName: element.tagName,
            id: element.id,
            className: element.className,
            path: path,
            hasShadowRoot: !!element.shadowRoot,
            shadowRootMode: element.shadowRoot ? element.shadowRoot.mode : null,
            children: []
          };
          
          if (element.shadowRoot) {
            const shadowChildren = element.shadowRoot.children;
            for (let i = 0; i < shadowChildren.length; i++) {
              info.children.push(
                getShadowDOMInfo(
                  shadowChildren[i], 
                  path + '::shadow-root > ' + shadowChildren[i].tagName.toLowerCase() + '[' + i + ']'
                )
              );
            }
          }
          
          const children = element.children;
          for (let i = 0; i < children.length; i++) {
            if (!children[i].assignedSlot) {
              info.children.push(
                getShadowDOMInfo(
                  children[i], 
                  path + ' > ' + children[i].tagName.toLowerCase() + '[' + i + ']'
                )
              );
            }
          }
          
          return info;
        }
        
        return getShadowDOMInfo(document.body, 'body');
      })()
    `;

    try {
      const result = await webContents.executeJavaScript(script);
      return result;
    } catch (error) {
      log.error('Failed to execute Shadow DOM script:', error);
      return null;
    }
  }

  /**
   * 获取元素的计算样式
   */
  async getComputedStyles(webContents, nodeId) {
    try {
      const styles = await webContents.debugger.sendCommand('CSS.getComputedStyleForNode', {
        nodeId
      });
      return styles.computedStyle;
    } catch (error) {
      log.error('Failed to get computed styles:', error);
      return null;
    }
  }

  /**
   * 高亮元素
   */
  async highlightNode(webContents, nodeId) {
    try {
      await webContents.debugger.sendCommand('DOM.highlightNode', {
        nodeId,
        highlightConfig: {
          showInfo: true,
          showRulers: false,
          showExtensionLines: false,
          displayAsMaterial: true,
          contentColor: { r: 111, g: 168, b: 220, a: 0.66 },
          paddingColor: { r: 147, g: 196, b: 125, a: 0.55 },
          borderColor: { r: 255, g: 229, b: 153, a: 0.66 },
          marginColor: { r: 246, g: 178, b: 107, a: 0.66 }
        }
      });
    } catch (error) {
      log.error('Failed to highlight node:', error);
    }
  }

  /**
   * 取消高亮
   */
  async hideHighlight(webContents) {
    try {
      await webContents.debugger.sendCommand('DOM.hideHighlight');
    } catch (error) {
      log.error('Failed to hide highlight:', error);
    }
  }

  /**
   * 获取节点的盒模型
   */
  async getBoxModel(webContents, nodeId) {
    try {
      const result = await webContents.debugger.sendCommand('DOM.getBoxModel', {
        nodeId
      });
      return result.model;
    } catch (error) {
      log.error('Failed to get box model:', error);
      return null;
    }
  }

  /**
   * 查询选择器对应的节点
   */
  async querySelector(webContents, selector) {
    try {
      // 先获取文档根节点
      const { root } = await webContents.debugger.sendCommand('DOM.getDocument');
      
      // 查询选择器
      const result = await webContents.debugger.sendCommand('DOM.querySelector', {
        nodeId: root.nodeId,
        selector
      });
      
      return result.nodeId;
    } catch (error) {
      log.error('Failed to query selector:', error);
      return null;
    }
  }

  /**
   * 通过坐标获取元素路径（穿透 Shadow DOM）
   */
  async getElementPathAtPoint(webContents, x, y) {
    try {
      // 使用 Runtime.evaluate 执行 JavaScript 获取元素
      const script = `
        (function(x, y) {
          function getElementPath(element) {
            const path = [];
            let current = element;
            
            while (current && current !== document.body) {
              let selector = current.tagName.toLowerCase();
              
              // 添加 ID
              if (current.id) {
                selector += '#' + current.id;
              }
              // 添加 class
              else if (current.className) {
                const classes = current.className.split(' ').filter(c => c).slice(0, 2);
                if (classes.length > 0) {
                  selector += '.' + classes.join('.');
                }
              }
              
              // 添加索引
              if (current.parentElement) {
                const siblings = Array.from(current.parentElement.children).filter(
                  s => s.tagName === current.tagName
                );
                if (siblings.length > 1) {
                  const index = siblings.indexOf(current) + 1;
                  selector += ':nth-of-type(' + index + ')';
                }
              }
              
              path.unshift(selector);
              
              // 检查是否在 Shadow DOM 中
              if (current.parentNode && current.parentNode.host) {
                path.unshift('::shadow-root');
                current = current.parentNode.host;
              } else {
                current = current.parentElement;
              }
            }
            
            return path.join(' > ');
          }
          
          function getShadowDOMPath(element) {
            const shadowPath = [];
            let current = element;
            
            while (current) {
              // 检查是否在 Shadow DOM 中
              const root = current.getRootNode();
              if (root instanceof ShadowRoot) {
                const host = root.host;
                const tagName = host.tagName.toLowerCase();
                
                // 获取在 shadow root 中的位置
                const siblings = Array.from(host.shadowRoot.children).filter(
                  s => s.tagName === current.tagName
                );
                let index = '';
                if (siblings.length > 1) {
                  index = '[' + (siblings.indexOf(current) + 1) + ']';
                }
                
                shadowPath.unshift(tagName + '::shadow-root > ' + current.tagName.toLowerCase() + index);
                current = host;
              } else {
                // 普通 DOM
                const tagName = current.tagName.toLowerCase();
                let selector = tagName;
                
                if (current.id) {
                  selector = tagName + '#' + current.id;
                } else if (current.className) {
                  const classes = current.className.split(' ').filter(c => c).slice(0, 2);
                  if (classes.length > 0) {
                    selector = tagName + '.' + classes.join('.');
                  }
                }
                
                shadowPath.unshift(selector);
                current = current.parentElement;
              }
              
              if (current === document.body) break;
            }
            
            return shadowPath.join(' > ');
          }
          
          // 使用 elementFromPoint 获取元素
          const element = document.elementFromPoint(x, y);
          if (!element) return null;
          
          return {
            tagName: element.tagName,
            id: element.id,
            className: element.className,
            text: element.textContent ? element.textContent.substring(0, 100) : '',
            path: getElementPath(element),
            shadowPath: getShadowDOMPath(element),
            hasShadowRoot: !!element.shadowRoot,
            rect: element.getBoundingClientRect()
          };
        })(${x}, ${y})
      `;
      
      const result = await webContents.executeJavaScript(script);
      return result;
    } catch (error) {
      log.error('Failed to get element path at point:', error);
      return null;
    }
  }

  /**
   * 获取完整的 Shadow DOM 树结构
   */
  async getShadowDOMTree(webContents) {
    try {
      const script = `
        (function() {
          function traverseShadowDOM(node, depth = 0) {
            const result = {
              tagName: node.tagName,
              id: node.id,
              className: node.className,
              hasShadowRoot: !!node.shadowRoot,
              shadowRootMode: node.shadowRoot ? node.shadowRoot.mode : null,
              children: []
            };
            
            // 遍历 Shadow DOM 子元素
            if (node.shadowRoot) {
              const shadowChildren = node.shadowRoot.querySelectorAll(':scope > *');
              shadowChildren.forEach(child => {
                result.children.push(traverseShadowDOM(child, depth + 1));
              });
            }
            
            // 遍历普通子元素
            const children = node.querySelectorAll(':scope > *');
            children.forEach(child => {
              if (!child.assignedSlot) {
                result.children.push(traverseShadowDOM(child, depth + 1));
              }
            });
            
            return result;
          }
          
          // 从 body 开始遍历
          return traverseShadowDOM(document.body);
        })()
      `;
      
      const result = await webContents.executeJavaScript(script);
      return result;
    } catch (error) {
      log.error('Failed to get Shadow DOM tree:', error);
      return null;
    }
  }

  /**
   * 断开CDP连接
   */
  async detach(webContents) {
    try {
      await webContents.debugger.detach();
      this.clients.delete(webContents.id);
      log.info(`CDP detached from webContents ${webContents.id}`);
    } catch (error) {
      log.error('Failed to detach CDP:', error);
    }
  }

  /**
   * 获取所有已连接客户端
   */
  getClients() {
    return Array.from(this.clients.values());
  }
}

module.exports = CDPManager;
