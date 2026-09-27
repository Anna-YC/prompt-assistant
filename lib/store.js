'use strict';
// 本地存储：配置(config.json) + 数据缓存(cache.json)，位于 userData 目录。
const fs = require('fs');
const path = require('path');
const { defaultConfig } = require('./config');

class Store {
  constructor(userDataPath) {
    this.dir = userDataPath;
    this.imgDir = path.join(this.dir, 'images');
    this.configPath = path.join(this.dir, 'config.json');
    this.cachePath = path.join(this.dir, 'cache.json');
    this.statsPath = path.join(this.dir, 'stats.json');
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.imgDir, { recursive: true });
    this.config = this._load(this.configPath, {});
    this.cache = this._load(this.cachePath, { prompts: [], phrases: [], tables: [], lastSyncAt: 0 });
    this.stats = this._load(this.statsPath, {}); // { [itemId]: { count, lastAt } }
    // 合并默认配置（深度），保证新增字段有默认值
    this.config = this._merge(defaultConfig(), this.config);
    // 迁移旧结构 phrases.local -> local.phrase
    if (this.config.phrases && this.config.phrases.local && !this.config.local) {
      this.config.local = { prompt: [], phrase: this.config.phrases.local };
      delete this.config.phrases.local;
      this.saveConfig();
    }
    if (!this.config.local) this.config.local = { prompt: [], phrase: [] };
    // 归一化：清掉历史遗留的复数空键
    if (this.config.local.prompts || this.config.local.phrases) {
      delete this.config.local.prompts;
      delete this.config.local.phrases;
      this.saveConfig();
    }
  }

  _load(p, fallback) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return fallback;
    }
  }

  _merge(base, over) {
    if (Array.isArray(base) || Array.isArray(over)) return over === undefined ? base : over;
    if (typeof base !== 'object' || base === null) return over === undefined ? base : over;
    const out = { ...base };
    for (const k of Object.keys(over || {})) out[k] = this._merge(base[k], over[k]);
    return out;
  }

  saveConfig() {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
  }
  saveCache() {
    fs.writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2), 'utf8');
  }
  updateConfig(patch) {
    this.config = this._merge(this.config, patch);
    this.saveConfig();
    return this.config;
  }

  // —— 本地条目（提示词 / 常用句）CRUD ——
  listLocal(kind) {
    return (this.config.local && this.config.local[kind]) || [];
  }
  upsertLocal(item) {
    const kind = item.kind === 'phrase' ? 'phrase' : 'prompt';
    const list = this.listLocal(kind);
    if (!item.id) item.id = 'loc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const clean = {
      id: item.id,
      kind,
      title: String(item.title || item.name || '').trim(),
      content: String(item.content || '').trim(),
      tags: Array.isArray(item.tags) ? item.tags : String(item.tags || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      pinned: !!item.pinned,
      origin: 'local',
    };
    const i = list.findIndex((x) => x.id === clean.id);
    if (i >= 0) list[i] = clean;
    else list.push(clean);
    this.config.local[kind] = list;
    this.saveConfig();
    return clean;
  }
  deleteLocal(id) {
    for (const kind of ['prompt', 'phrase']) {
      this.config.local[kind] = this.listLocal(kind).filter((x) => x.id !== id);
    }
    this.saveConfig();
  }

  // —— UI 合并视图 ——
  getView() {
    const pinnedIds = this.config.tray.pinnedIds || [];
    const localPrompts = this.listLocal('prompt');
    const prompts = [
      ...localPrompts.map((p) => ({ ...p })),
      ...(this.cache.prompts || []).map((p) => ({ ...p, origin: p.origin || 'feishu' })),
    ].map((p) => ({ ...p, pinned: pinnedIds.includes(p.id) || !!p.pinned }))
      .map((p) => {
        // 两级分类：大类（常用词/生图词/视频词）+ 细分（人物/环境/… 或标签）
        const tn = p.tableName || '';
        let group, sub;
        if (tn.startsWith('生图提示词')) { group = '生图词'; sub = tn.replace('生图提示词-', '') || '其他'; }
        else if (tn.startsWith('视频提示词')) { group = '视频词'; sub = tn.replace('视频提示词-', '') || '其他'; }
        else { group = '常用词'; sub = (p.tags && p.tags[0]) || '未分类'; }
        if (p.pinned) group = '常用词'; // 加星 = 加入常用词模块
        return { ...p, group, sub, copyCount: this.copyCountOf(p.id) };
      });

    // 常用句模块 = 本地常用句 + 加星提示词（同步进来）+ 飞书常用句源
    const phrases = [
      ...this.listLocal('phrase').map((p) => ({ ...p, name: p.title })),
      ...prompts.filter((p) => p.pinned).map((p) => ({ ...p, name: p.title, fromPrompt: true })),
      ...(this.cache.phrases || []).map((p) => ({ ...p, origin: p.origin || 'feishu' })),
      // 与 prompts 同一规则应用 pinnedIds：飞书来源的常用句自身没有 pinned 字段，
      // 不合并的话 ★ 点了无反馈、托盘菜单也不收录
    ].map((p) => ({ ...p, pinned: pinnedIds.includes(p.id) || !!p.pinned, copyCount: this.copyCountOf(p.id) }));

    const tagCount = {};
    for (const p of prompts) for (const t of p.tags || []) tagCount[t] = (tagCount[t] || 0) + 1;
    const tags = Object.keys(tagCount).sort((a, b) => tagCount[b] - tagCount[a]);

    // 复制统计汇总（底部状态栏用）
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    let todayCount = 0, totalCount = 0;
    for (const id of Object.keys(this.stats)) {
      const s = this.stats[id];
      totalCount += s.count || 0;
      if ((s.lastAt || 0) >= t0.getTime()) todayCount += s.count || 0;
    }

    return { prompts, phrases, tags, tagCount, todayCount, totalCount };
  }

  // 托盘右键菜单的“常用”条目
  getTrayItems() {
    const view = this.getView();
    const pinnedIds = this.config.tray.pinnedIds || [];
    const max = this.config.tray.maxItems || 14;
    let prompts = view.prompts.filter((p) => p.pinned);
    if (prompts.length === 0) prompts = view.prompts.slice(0, max);
    prompts = prompts.slice(0, max);
    // 加星提示词已在 prompts 区出现，常用句子菜单不再重复收录
    const phrases = view.phrases.filter((p) => p.pinned && !p.fromPrompt).slice(0, max);
    return { prompts, phrases };
  }

  // —— 复制统计（高频使用词库） ——
  recordCopy(id) {
    if (!id) return;
    const s = this.stats[id] || { count: 0, lastAt: 0 };
    s.count += 1;
    s.lastAt = Date.now();
    this.stats[id] = s;
    try { fs.writeFileSync(this.statsPath, JSON.stringify(this.stats), 'utf8'); } catch {}
  }
  clearStats() {
    this.stats = {};
    try { fs.writeFileSync(this.statsPath, '{}', 'utf8'); } catch {}
  }
  copyCountOf(id) {
    return (this.stats[id] && this.stats[id].count) || 0;
  }

  togglePin(id) {
    const list = this.config.tray.pinnedIds || [];
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1);
    else list.push(id);
    this.config.tray.pinnedIds = list;
    // 本地条目同步 pinned 标记
    for (const kind of ['prompt', 'phrase']) {
      const it = this.listLocal(kind).find((x) => x.id === id);
      if (it) it.pinned = i < 0;
    }
    this.saveConfig();
    return list;
  }
}

module.exports = { Store };
