#!/usr/bin/env node
/**
 * Task Data Validator
 * 验证 task 文件夹的完整性，确保所有文件都被正确关联
 */

const fs = require('fs');
const path = require('path');

class TaskValidator {
  constructor(taskDir) {
    this.taskDir = taskDir;
    this.errors = [];
    this.warnings = [];
    this.stats = {
      totalEvents: 0,
      eventsWithSnapshots: 0,
      eventsWithDomSnapshots: 0,
      eventsWithApiRequests: 0,
      eventsWithResources: 0,
      totalResources: 0,
      referencedFiles: new Set(),
      existingFiles: new Set(),
      missingFiles: [],
      unreferencedFiles: []
    };
  }

  validate() {
    console.log(`🔍 开始验证任务目录: ${this.taskDir}\n`);

    // 1. 检查基本文件结构
    this.validateBasicStructure();

    // 2. 解析 training_manifest.jsonl
    const manifestPath = path.join(this.taskDir, 'training_manifest.jsonl');
    if (!fs.existsSync(manifestPath)) {
      this.errors.push('❌ 缺少 training_manifest.jsonl 文件');
      return this.generateReport();
    }

    // 3. 验证 manifest 中的文件引用
    this.validateManifestReferences(manifestPath);

    // 4. 验证动态资源
    this.validateDynamicResources();

    // 5. 扫描所有实际存在的文件
    this.scanExistingFiles();

    // 6. 检查文件关联完整性
    this.checkFileAssociations();

    // 6. 验证 metadata.json
    this.validateMetadata();

    // 7. 验证 api_responses.json
    this.validateApiResponses();

    return this.generateReport();
  }

  validateBasicStructure() {
    const requiredDirs = ['dom', 'network', 'logs'];
    const requiredFiles = ['training_manifest.jsonl', 'metadata.json'];

    for (const dir of requiredDirs) {
      const dirPath = path.join(this.taskDir, dir);
      if (!fs.existsSync(dirPath)) {
        this.errors.push(`❌ 缺少必需目录: ${dir}`);
      }
    }

    for (const file of requiredFiles) {
      const filePath = path.join(this.taskDir, file);
      if (!fs.existsSync(filePath)) {
        this.errors.push(`❌ 缺少必需文件: ${file}`);
      }
    }
  }

  validateManifestReferences(manifestPath) {
    const content = fs.readFileSync(manifestPath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());

    console.log(`📄 解析 training_manifest.jsonl，共 ${lines.length} 个事件\n`);

    for (let i = 0; i < lines.length; i++) {
      try {
        const event = JSON.parse(lines[i]);
        this.stats.totalEvents++;

        // 检查 _metadata 中的文件引用
        if (event._metadata) {
          // 截图文件
          if (event._metadata.snapshotFileName) {
            this.stats.eventsWithSnapshots++;
            this.stats.referencedFiles.add(
              path.join('previews', 'snapshots', event._metadata.snapshotFileName)
            );
          }

          // DOM snapshot 文件
          if (event._metadata.domSnapshotFileName) {
            this.stats.eventsWithDomSnapshots++;
            this.stats.referencedFiles.add(
              path.join('dom', event._metadata.domSnapshotFileName)
            );
          }
        }

        // 检查 network_correlation 中的 API 请求
        if (event.network_correlation?.api_requests?.length > 0) {
          this.stats.eventsWithApiRequests++;

          for (const apiReq of event.network_correlation.api_requests) {
            // 检查 resourcePath
            if (apiReq.references?.resourcePath) {
              this.stats.referencedFiles.add(apiReq.references.resourcePath);
            }

            // 检查 responseBodyPath
            if (apiReq.references?.responseBodyPath) {
              this.stats.referencedFiles.add(apiReq.references.responseBodyPath);
            }
          }
        }

        // 检查 network_correlation 中的 resources
        if (event.network_correlation?.resources?.length > 0) {
          this.stats.eventsWithResources++;
          this.stats.totalResources += event.network_correlation.resources.length;
          
          for (const resource of event.network_correlation.resources) {
            if (resource.path) {
              this.stats.referencedFiles.add(resource.path);
            }
          }
        }

        // 检查 file_io
        if (event.file_io?.local_path) {
          this.stats.referencedFiles.add(event.file_io.local_path);
        }

      } catch (error) {
        this.errors.push(`❌ 解析第 ${i + 1} 行失败: ${error.message}`);
      }
    }
  }

  scanExistingFiles() {
    const scanDir = (dir, relativePath = '') => {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const relPath = path.join(relativePath, item);

        if (fs.statSync(fullPath).isDirectory()) {
          scanDir(fullPath, relPath);
        } else {
          this.stats.existingFiles.add(relPath);
        }
      }
    };

    if (fs.existsSync(this.taskDir)) {
      scanDir(this.taskDir);
    }
  }

  checkFileAssociations() {
    // 检查被引用的文件是否存在
    for (const refFile of this.stats.referencedFiles) {
      if (!this.stats.existingFiles.has(refFile)) {
        this.stats.missingFiles.push(refFile);
      }
    }

    // 检查未被引用的文件（排除核心文件和资源文件）
    const coreFiles = [
      'training_manifest.jsonl',
      'metadata.json',
      'task_config.json',
      'network/api_responses.json',
      'network/api_traffic.jsonl',
      'logs/console_errors.jsonl',
      'logs/errors.json',
      'sandbox/lineage.json',
      'sandbox/browser_state.json',
      'dom/rrweb_events.json'
    ];

    const resourceExtensions = ['.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.woff', '.woff2', '.ttf', '.mp4', '.webm', '.mp3', '.wav', '.html'];

    for (const existingFile of this.stats.existingFiles) {
      const isCoreFile = coreFiles.includes(existingFile);
      const isResourceFile = resourceExtensions.some(ext => existingFile.endsWith(ext));
      const isInResourcesDir = existingFile.startsWith('network/resources/');
      const isInApiBodiesDir = existingFile.startsWith('network/api_bodies/');
      const isSystemFile = existingFile === '.DS_Store' || existingFile.endsWith('/.DS_Store');
      
      if (!this.stats.referencedFiles.has(existingFile) && 
          !isCoreFile && 
          !isResourceFile && 
          !isInResourcesDir && 
          !isInApiBodiesDir &&
          !isSystemFile) {
        this.stats.unreferencedFiles.push(existingFile);
      }
    }
  }

  validateDynamicResources() {
    const dynamicResourcesPath = path.join(this.taskDir, 'network', 'dynamic_resources.json');
    if (!fs.existsSync(dynamicResourcesPath)) {
      console.log('📡 动态资源: 无\n');
      return;
    }

    try {
      const dynamicResources = JSON.parse(fs.readFileSync(dynamicResourcesPath, 'utf-8'));
      console.log(`📡 动态资源数量: ${dynamicResources.length}\n`);

      // 检查动态资源引用的文件是否存在
      for (const resource of dynamicResources) {
        if (resource.path) {
          this.stats.referencedFiles.add(resource.path);
        }
      }
    } catch (error) {
      this.warnings.push(`⚠️ dynamic_resources.json 解析失败: ${error.message}`);
    }
  }

  validateMetadata() {
    const metadataPath = path.join(this.taskDir, 'metadata.json');
    if (!fs.existsSync(metadataPath)) return;

    try {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
      
      if (!metadata.task_id) {
        this.warnings.push('⚠️ metadata.json 缺少 task_id');
      }
      if (!metadata.timestamp) {
        this.warnings.push('⚠️ metadata.json 缺少 timestamp');
      }
      if (!metadata.start_url) {
        this.warnings.push('⚠️ metadata.json 缺少 start_url');
      }
    } catch (error) {
      this.errors.push(`❌ metadata.json 解析失败: ${error.message}`);
    }
  }

  validateApiResponses() {
    const apiResponsesPath = path.join(this.taskDir, 'network', 'api_responses.json');
    if (!fs.existsSync(apiResponsesPath)) {
      this.warnings.push('⚠️ 缺少 api_responses.json');
      return;
    }

    try {
      const apiResponses = JSON.parse(fs.readFileSync(apiResponsesPath, 'utf-8'));
      const apiCount = Object.keys(apiResponses).length;
      
      console.log(`📡 API 响应数量: ${apiCount}\n`);

      // 检查每个 API 响应是否有 body
      let withBody = 0;
      let withoutBody = 0;

      for (const [url, data] of Object.entries(apiResponses)) {
        if (data.body || data.bodyPath) {
          withBody++;
        } else {
          withoutBody++;
        }
      }

      console.log(`   - 包含响应体: ${withBody}`);
      console.log(`   - 缺少响应体: ${withoutBody}\n`);

      if (withoutBody > 0) {
        this.warnings.push(`⚠️ ${withoutBody} 个 API 响应缺少 body`);
      }
    } catch (error) {
      this.errors.push(`❌ api_responses.json 解析失败: ${error.message}`);
    }
  }

  generateReport() {
    console.log('═'.repeat(60));
    console.log('📊 验证报告');
    console.log('═'.repeat(60) + '\n');

    // 统计信息
    console.log('📈 统计信息:');
    console.log(`   总事件数: ${this.stats.totalEvents}`);
    console.log(`   包含截图的事件: ${this.stats.eventsWithSnapshots}`);
    console.log(`   包含 DOM 快照的事件: ${this.stats.eventsWithDomSnapshots}`);
    console.log(`   包含 API 请求的事件: ${this.stats.eventsWithApiRequests}`);
    console.log(`   包含资源的事件: ${this.stats.eventsWithResources}`);
    console.log(`   总资源数: ${this.stats.totalResources}`);
    console.log(`   被引用的文件数: ${this.stats.referencedFiles.size}`);
    console.log(`   实际存在的文件数: ${this.stats.existingFiles.size}`);
    console.log();

    // 错误
    if (this.errors.length > 0) {
      console.log('❌ 错误 (' + this.errors.length + '):');
      this.errors.forEach(err => console.log('   ' + err));
      console.log();
    }

    // 警告
    if (this.warnings.length > 0) {
      console.log('⚠️ 警告 (' + this.warnings.length + '):');
      this.warnings.forEach(warn => console.log('   ' + warn));
      console.log();
    }

    // 缺失文件
    if (this.stats.missingFiles.length > 0) {
      console.log('🚫 缺失的文件 (' + this.stats.missingFiles.length + '):');
      this.stats.missingFiles.forEach(file => console.log('   - ' + file));
      console.log();
    }

    // 未引用的文件
    if (this.stats.unreferencedFiles.length > 0) {
      console.log('🔍 未被引用的文件 (' + this.stats.unreferencedFiles.length + '):');
      this.stats.unreferencedFiles.forEach(file => console.log('   - ' + file));
      console.log();
    }

    // 总结
    console.log('═'.repeat(60));
    if (this.errors.length === 0 && this.stats.missingFiles.length === 0) {
      console.log('✅ 验证通过！所有文件完整且正确关联。');
    } else {
      console.log(`❌ 验证失败！发现 ${this.errors.length} 个错误, ${this.stats.missingFiles.length} 个缺失文件。`);
    }
    console.log('═'.repeat(60));

    return {
      success: this.errors.length === 0 && this.stats.missingFiles.length === 0,
      errors: this.errors,
      warnings: this.warnings,
      stats: this.stats
    };
  }
}

// 主函数
function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    // 如果没有提供参数，查找最新的 task 目录
    const collectionsDir = path.join(__dirname, '..', '..', '..', '..', 'output', 'collections');
    if (!fs.existsSync(collectionsDir)) {
      console.error('❌ 找不到 collections 目录');
      process.exit(1);
    }

    const tasks = fs.readdirSync(collectionsDir)
      .filter(dir => dir.startsWith('task_'))
      .map(dir => ({
        name: dir,
        path: path.join(collectionsDir, dir),
        mtime: fs.statSync(path.join(collectionsDir, dir)).mtime
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (tasks.length === 0) {
      console.error('❌ 找不到任何 task 目录');
      process.exit(1);
    }

    console.log(`📁 找到 ${tasks.length} 个任务，验证最新的: ${tasks[0].name}\n`);
    args.push(tasks[0].path);
  }

  for (const taskDir of args) {
    if (!fs.existsSync(taskDir)) {
      console.error(`❌ 目录不存在: ${taskDir}`);
      continue;
    }

    const validator = new TaskValidator(taskDir);
    const result = validator.validate();

    if (!result.success) {
      process.exitCode = 1;
    }
  }
}

main();
