#!/usr/bin/env node

// 数据收集工具模块 - 共享给所有Hook版本使用
// 避免代码重复，遵循DRY原则

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import process from 'node:process';
import { homedir } from 'node:os';
import crypto from 'node:crypto';

// 获取用户主目录和 Claude 配置目录
const USER_HOME_DIR = homedir();
const XDG_CONFIG_DIR = process.env.XDG_CONFIG_HOME ?? `${USER_HOME_DIR}/.config`;
const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';
const CLAUDE_PROJECTS_DIR = 'projects';

// 获取 Claude 配置路径
function getClaudePaths() {
  const envPaths = process.env[CLAUDE_CONFIG_DIR_ENV];
  const paths = envPaths 
    ? envPaths.split(',')
    : [`${XDG_CONFIG_DIR}/claude`, `${USER_HOME_DIR}/.claude`];
  
  return paths.filter(p => existsSync(path.join(p, CLAUDE_PROJECTS_DIR)));
}

// 递归查找 JSONL 文件
async function findJsonlFiles(dir) {
  const files = [];
  
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        files.push(...await findJsonlFiles(fullPath));
      } else if (entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  } catch {
    // 静默忽略错误
  }
  
  return files;
}

// 解析使用数据
function parseUsageFromLine(line) {
  try {
    const data = JSON.parse(line.trim());
    
    // 验证必需字段
    if (!data?.timestamp || !data?.message?.usage) return null;
    
    const usage = data.message.usage;
    if (typeof usage.input_tokens !== 'number' || 
        typeof usage.output_tokens !== 'number') return null;
    
    // 生成交互哈希用于去重
    const hashInput = `${data.timestamp}${data.message?.id || ''}${data.requestId || ''}`;
    const interactionHash = crypto.createHash('sha256').update(hashInput).digest('hex');
    
    return {
      timestamp: data.timestamp,
      tokens: {
        input: usage.input_tokens,
        output: usage.output_tokens,
        cache_creation: usage.cache_creation_input_tokens || 0,
        cache_read: usage.cache_read_input_tokens || 0
      },
      model: data.message.model || 'unknown',
      session_id: data.sessionId || null,
      interaction_hash: interactionHash
    };
  } catch {
    return null;
  }
}

// 解析单个JSONL文件
async function parseJsonlFile(filePath, state, logger) {
  const entries = [];
  
  try {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.length > 0);
    
    for (const line of lines) {
      const entry = parseUsageFromLine(line);
      if (!entry) continue;
      
      // 检查是否已处理过（基于哈希去重）
      const dayKey = entry.timestamp.split('T')[0]; // YYYY-MM-DD
      if (state.recentHashes[dayKey]?.includes(entry.interaction_hash)) {
        continue; // 跳过已处理的记录
      }
      
      entries.push(entry);
    }
    
    if (entries.length > 0 && logger) {
      await logger.log('debug', 'Parsed JSONL file', {
        file: path.basename(filePath),
        totalLines: lines.length,
        validEntries: entries.length
      });
    }
  } catch (error) {
    if (logger) {
      await logger.log('warn', 'Failed to parse JSONL file', {
        file: filePath,
        error: error.message
      });
    }
  }
  
  return entries;
}

// 收集新的使用数据
async function collectNewUsageData(state, logger) {
  const claudePaths = getClaudePaths();
  if (claudePaths.length === 0) {
    if (logger) await logger.log('warn', 'No Claude config directories found');
    return [];
  }
  
  const allEntries = [];
  
  if (logger) await logger.log('info', 'Starting data collection', {
    claudePaths: claudePaths.length
  });
  
  for (const claudePath of claudePaths) {
    const projectsDir = path.join(claudePath, CLAUDE_PROJECTS_DIR);
    
    try {
      const jsonlFiles = await findJsonlFiles(projectsDir);
      if (logger) await logger.log('debug', 'Found JSONL files', {
        path: projectsDir,
        count: jsonlFiles.length
      });
      
      for (const file of jsonlFiles) {
        const entries = await parseJsonlFile(file, state, logger);
        allEntries.push(...entries);
      }
    } catch (error) {
      if (logger) await logger.log('warn', 'Failed to scan directory', {
        directory: projectsDir,
        error: error.message
      });
    }
  }
  
  if (logger) {
    if (allEntries.length > 0) {
      await logger.log('info', 'Data collection completed', {
        newEntries: allEntries.length
      });
    } else {
      await logger.log('info', 'No new entries found');
    }
  }
  
  return allEntries;
}

// ============ V4 增量扫描函数 ============

// 将 { dayKey: string[] } 转为 { dayKey: Set<string> }，供 O(1) 查找
function buildHashSets(recentHashes) {
  const sets = {};
  for (const [dayKey, hashes] of Object.entries(recentHashes)) {
    sets[dayKey] = new Set(hashes);
  }
  return sets;
}

// 基于 byte offset 只读新增内容
async function readFileIncremental(filePath, offsets, hashSets, logger) {
  const entries = [];

  try {
    const fileStat = await stat(filePath);
    const currentSize = fileStat.size;
    const currentMtime = fileStat.mtimeMs;

    const saved = offsets[filePath];

    // 文件未变（size + mtime 相同）→ 跳过
    if (saved && saved.size === currentSize && saved.mtime === currentMtime) {
      return entries;
    }

    // 确定读取起始位置
    let startOffset = 0;
    if (saved) {
      if (currentSize < saved.size) {
        // 文件缩小（truncated/rotated）→ 从头扫描
        if (logger) {
          await logger.log('debug', 'File truncated, rescanning from start', {
            file: path.basename(filePath)
          });
        }
      } else {
        // 文件变大 → 从上次位置继续
        startOffset = saved.offset;
      }
    }

    // 无新内容
    if (startOffset >= currentSize) {
      offsets[filePath] = { offset: currentSize, size: currentSize, mtime: currentMtime };
      return entries;
    }

    // 流式逐行解析新增部分
    const stream = createReadStream(filePath, {
      start: startOffset,
      encoding: 'utf-8'
    });

    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;

      const entry = parseUsageFromLine(line);
      if (!entry) continue;

      // O(1) Set 去重
      const dayKey = entry.timestamp.split('T')[0];
      if (hashSets[dayKey]?.has(entry.interaction_hash)) continue;

      entries.push(entry);
    }

    // 更新 offset
    offsets[filePath] = { offset: currentSize, size: currentSize, mtime: currentMtime };

    if (entries.length > 0 && logger) {
      await logger.log('debug', 'Incremental read', {
        file: path.basename(filePath),
        startOffset,
        endOffset: currentSize,
        newEntries: entries.length
      });
    }
  } catch (error) {
    if (logger) {
      await logger.log('warn', 'Failed to read file incrementally', {
        file: filePath,
        error: error.message
      });
    }
  }

  return entries;
}

// 增量收集新的使用数据（v4 专用）
async function collectNewUsageDataIncremental(state, logger) {
  const claudePaths = getClaudePaths();
  if (claudePaths.length === 0) {
    if (logger) await logger.log('warn', 'No Claude config directories found');
    return [];
  }

  // 初始化 fileOffsets
  if (!state.fileOffsets) state.fileOffsets = {};

  // 构建 O(1) 去重 Set
  const hashSets = buildHashSets(state.recentHashes || {});

  const allEntries = [];
  const seenFiles = new Set();

  if (logger) await logger.log('info', 'Starting incremental data collection', {
    claudePaths: claudePaths.length,
    trackedFiles: Object.keys(state.fileOffsets).length
  });

  for (const claudePath of claudePaths) {
    const projectsDir = path.join(claudePath, CLAUDE_PROJECTS_DIR);

    try {
      const jsonlFiles = await findJsonlFiles(projectsDir);

      for (const file of jsonlFiles) {
        seenFiles.add(file);
        const entries = await readFileIncremental(file, state.fileOffsets, hashSets, logger);
        allEntries.push(...entries);
      }
    } catch (error) {
      if (logger) await logger.log('warn', 'Failed to scan directory', {
        directory: projectsDir,
        error: error.message
      });
    }
  }

  // 清理已删除文件的 offset 记录
  for (const trackedFile of Object.keys(state.fileOffsets)) {
    if (!seenFiles.has(trackedFile)) {
      delete state.fileOffsets[trackedFile];
    }
  }

  if (logger) {
    await logger.log('info', 'Incremental collection completed', {
      newEntries: allEntries.length,
      trackedFiles: Object.keys(state.fileOffsets).length
    });
  }

  return allEntries;
}

export {
  getClaudePaths,
  findJsonlFiles,
  parseUsageFromLine,
  parseJsonlFile,
  collectNewUsageData,
  buildHashSets,
  readFileIncremental,
  collectNewUsageDataIncremental
};