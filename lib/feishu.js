'use strict';
// 飞书多维表数据层：通过本机已认证的 lark-cli 读取数据（零配置），
// 负责分页拉取、字段映射、附件（效果预览图）下载。
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const TOKEN_RE = /^[A-Za-z0-9_-]+$/;

function safeArg(v) {
  const s = String(v == null ? '' : v);
  if (/[&|<>^";`$*?]/.test(s)) throw new Error('参数含非法字符: ' + s.slice(0, 40));
  return s.includes(' ') ? `"${s}"` : s;
}

// 解析 lark-cli 的真实 JS 入口（npm 全局安装的 shim 指向 run.js），
// 以便用 Node 直接执行，彻底避开 Windows cmd 引号转义问题。
const targetCache = new Map();
function resolveCliTarget(cfg) {
  const cli = cfg.larkCliPath || (process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli');
  if (targetCache.has(cli)) return targetCache.get(cli);
  const candidates = [];
  // 1) 显式配置的 js 入口
  if (/\.js$/i.test(cli)) candidates.push(cli);
  // 2) 从 .cmd/.bat shim 内容解析 js 路径
  if (/\.(cmd|bat)$/i.test(cli) || fs.existsSync(cli)) {
    const shimPaths = [cli];
    // 由命令名推导全局 shim 路径
    const npmGlobal = path.join(process.env.APPDATA || '', 'npm');
    shimPaths.push(path.join(npmGlobal, 'lark-cli.cmd'));
    for (const sp of shimPaths) {
      try {
        const txt = fs.readFileSync(sp, 'utf8');
        const m = txt.match(/"([^"]*?node_modules[^"]*?\.js)"/i) || txt.match(/(%dp0%[^"\s]*?\.js)/i);
        if (m) {
          let p = m[1].replace(/%dp0%/gi, path.dirname(sp) + path.sep);
          p = path.resolve(p);
          if (fs.existsSync(p)) candidates.push(p);
        }
      } catch {}
    }
    // 3) 常见全局安装位置
    candidates.push(path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js'));
  }
  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      const t = { mode: 'node', js: c };
      targetCache.set(cli, t);
      return t;
    }
  }
  const t = { mode: 'cmd', cli };
  targetCache.set(cli, t);
  return t;
}

// 优先用系统 node 执行 CLI（杜绝任何 Electron 子进程窗口）；不可用时回退 Electron 内置 Node
let systemNodeOk = null;
function probeSystemNode() {
  return new Promise((res) => {
    execFile('node', ['-v'], { windowsHide: true }, (err) => {
      systemNodeOk = !err;
      res(systemNodeOk);
    });
  });
}

function runCli(cfg, args, { timeout = 90000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const target = resolveCliTarget(cfg);
    let child;
    if (target.mode === 'node') {
      const useSystemNode = systemNodeOk === true;
      child = execFile(
        useSystemNode ? 'node' : process.execPath,
        [target.js, ...args],
        {
          windowsHide: true, timeout, maxBuffer: 1024 * 1024 * 128,
          cwd: cwd || process.env.USERPROFILE || '/',
          env: useSystemNode ? { ...process.env } : { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        },
        (err, stdout, stderr) => {
          // 系统 node 不存在（ENOENT）时回退内置 Node 重试一次
          if (err && err.code === 'ENOENT' && useSystemNode) {
            systemNodeOk = false;
            runCli(cfg, args, { timeout, cwd }).then(resolve, reject);
            return;
          }
          done(err, stdout, stderr);
        }
      );
    } else {
      const cmd = `${target.cli} ${args.map(safeArg).join(' ')}`;
      child = execFile(
        process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
        process.platform === 'win32' ? ['/d', '/c', cmd] : ['-c', cmd],
        { windowsHide: true, timeout, maxBuffer: 1024 * 1024 * 128, cwd: cwd || process.env.USERPROFILE || '/' },
        done
      );
    }
    function done(err, stdout, stderr) {
        if (err && !stdout) {
          return reject(new Error((stderr || err.message || '').toString().slice(0, 500)));
        }
        let j;
        try {
          j = JSON.parse(stdout);
        } catch {
          return reject(new Error('lark-cli 输出无法解析: ' + stdout.slice(0, 200)));
        }
        if (j && j.ok === false) {
          const e = j.error || {};
          return reject(new Error(e.message || JSON.stringify(e).slice(0, 300)));
        }
      resolve(j && j.data !== undefined ? j.data : j);
    }
  });
}

async function listTables(cfg) {
  const d = await runCli(cfg, ['base', '+table-list', '--base-token', cfg.baseToken, '--as', cfg.identity || 'user']);
  return (d.tables || []).map((t) => ({ id: t.id, name: t.name, count: t.records_count }));
}

async function listFields(cfg, tableId) {
  const d = await runCli(cfg, ['base', '+field-list', '--base-token', cfg.baseToken, '--table-id', tableId, '--as', cfg.identity || 'user']);
  return (d.fields || []).map((f) => ({ id: f.id, name: f.name, type: f.type }));
}

// 分页拉取全部记录，返回 [{recordId, cells: {字段名: 归一化值}}]
async function fetchAllRecords(cfg, tableId) {
  const out = [];
  let offset = 0;
  const limit = 200;
  for (let guard = 0; guard < 50; guard++) {
    const d = await runCli(cfg, [
      'base', '+record-list',
      '--base-token', cfg.baseToken,
      '--table-id', tableId,
      '--limit', String(limit),
      '--offset', String(offset),
      '--json',
      '--as', cfg.identity || 'user',
    ]);
    const fields = d.fields || [];
    const rows = d.data || [];
    const ids = d.record_id_list || [];
    rows.forEach((row, i) => {
      const cells = {};
      fields.forEach((f, j) => (cells[f] = row[j]));
      out.push({ recordId: ids[i] || `r${offset + i}`, cells });
    });
    if (!d.has_more || rows.length === 0) break;
    offset += rows.length;
  }
  return out;
}

function asText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join(' / ');
  if (typeof v === 'object') return v.text || v.name || JSON.stringify(v);
  return String(v);
}

function asTags(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(asText).filter(Boolean);
  const s = asText(v).trim();
  return s ? [s] : [];
}

// 依据字段名猜测映射（用于设置页“自动识别”）
function guessMapping(fields) {
  const names = fields.map((f) => f.name);
  const pick = (cands, typeFilter) => {
    for (const c of cands) {
      const hit = names.find((n) => n === c && (!typeFilter || typeFilter(fields.find((f) => f.name === n))));
      if (hit) return hit;
    }
    for (const c of cands) {
      const hit = names.find((n) => n.includes(c) && (!typeFilter || typeFilter(fields.find((f) => f.name === n))));
      if (hit) return hit;
    }
    return '';
  };
  const isText = (f) => f && (f.type === 'text' || f.type === 'markdown' || f.type === 'number');
  const isSelect = (f) => f && (f.type === 'select' || f.type === 'text');
  const isAttach = (f) => f && f.type === 'attachment';

  const content = pick(['提示词', '可直接复制提示词', '内容', '正文', 'content', 'prompt'], isText);
  const title = pick(['提示词用途', '标题', '页面标题', '名称', 'title', 'name'], isText) ||
    names.find((n) => n !== content && isText(fields.find((f) => f.name === n))) || '';
  const tags = names.filter((n) => {
    const f = fields.find((x) => x.name === n);
    return f && f.type === 'select' && !/模型|状态|来源|泛用/.test(n);
  });
  const video = names.find((n) => {
    const f = fields.find((x) => x.name === n);
    return f && f.type === 'attachment' && /视频|video/i.test(n);
  }) || '';
  const image = names.find((n) => {
    const f = fields.find((x) => x.name === n);
    return f && f.type === 'attachment' && n !== video && /效果|封面|图片|图例|image|cover/i.test(n);
  }) || '';
  const note = pick(['用途', '备注', '适合场景', 'note'], (f) => f && f.type === 'text' && f.name !== title && f.name !== content);
  const link = pick(['链接', '来源URL', 'link', 'url'], isText);
  return { title, content, tags, image, video, note, link };
}

// 校验/补全映射：映射中缺失或表里不存在的字段角色，用自动识别结果兜底
function effectiveMapping(fields, mapping) {
  const guess = guessMapping(fields);
  const names = new Set(fields.map((f) => f.name));
  const m = mapping || {};
  const ok = (v) => (Array.isArray(v) ? v.length > 0 && v.every((x) => names.has(x)) : !!v && names.has(v));
  const out = {};
  for (const role of ['title', 'content', 'image', 'video', 'note', 'link']) {
    out[role] = ok(m[role]) ? m[role] : guess[role];
  }
  out.tags = ok(m.tags) ? m.tags : guess.tags;
  return out;
}

function mapRecord(rec, mapping, srcId, tableName, tableId) {
  const c = rec.cells;
  const tagFields = Array.isArray(mapping.tags) ? mapping.tags : mapping.tags ? [mapping.tags] : [];
  const tags = [];
  for (const tf of tagFields) for (const t of asTags(c[tf])) if (t && !tags.includes(t)) tags.push(t);
  const atts = c[mapping.image];
  const image = Array.isArray(atts) && atts.length ? { fileToken: atts[0].file_token, name: atts[0].name, size: atts[0].size } : null;
  const vatts = c[mapping.video];
  const video = Array.isArray(vatts) && vatts.length ? { fileToken: vatts[0].file_token, name: vatts[0].name, size: vatts[0].size } : null;
  return {
    id: `${srcId}:${rec.recordId}`,
    recordId: rec.recordId,
    sourceId: srcId,
    tableId: tableId || '',
    tableName,
    title: asText(c[mapping.title]).trim() || asText(c[mapping.content]).slice(0, 24) || '(无标题)',
    content: asText(c[mapping.content]).trim(),
    tags,
    note: mapping.note ? asText(c[mapping.note]).trim() : '',
    link: mapping.link ? asText(c[mapping.link]).replace(/^\[|\]\(.*\)$/g, '').trim() : '',
    image,
    video,
  };
}

function downloadAttachment(cfg, { tableId, recordId, fileToken, destPath }) {
  // lark-cli 的 --output 只接受相对路径：以目标目录为 cwd，仅传文件名
  return runCli(cfg, [
    'base', '+record-download-attachment',
    '--base-token', cfg.baseToken,
    '--table-id', tableId,
    '--record-id', recordId,
    '--file-token', fileToken,
    '--output', path.basename(destPath),
    '--overwrite',
    '--as', cfg.identity || 'user',
  ], { timeout: 180000, cwd: path.dirname(destPath) });
}

async function syncSource(cfg, source, imgDir, onProgress) {
  const records = await fetchAllRecords(cfg, source.tableId);
  const fields = await listFields(cfg, source.tableId);
  const mapping = effectiveMapping(fields, source.mapping);
  const items = records
    .map((r) => mapRecord(r, mapping, source.id, source.name, source.tableId))
    .filter((it) => it.content || it.title !== '(无标题)');

  // 下载效果预览图（可选，只处理图片附件，带缓存跳过）
  if (source.downloadImages) {
    let done = 0;
    const queue = items.filter((it) => it.image);
    const worker = async () => {
      while (queue.length) {
        const it = queue.shift();
        const ext = path.extname(it.image.name || '') || '.png';
        const fname = `${source.tableId}_${it.recordId}${ext}`;
        const dest = path.join(imgDir, fname);
        if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) {
          try {
            await downloadAttachment(cfg, { tableId: source.tableId, recordId: it.recordId, fileToken: it.image.fileToken, destPath: dest });
          } catch (e) {
            it.image.error = String(e.message || e).slice(0, 120);
          }
        }
        if (fs.existsSync(dest)) it.image.localPath = dest;
        done++;
        if (onProgress) onProgress(done, items.length);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }
  return items;
}

module.exports = { runCli, listTables, listFields, fetchAllRecords, guessMapping, syncSource, downloadAttachment, probeSystemNode };
