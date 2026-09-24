'use strict';
// 主进程：托盘、右侧吸附面板窗口、设置窗口、飞书同步、IPC。
const { app, BrowserWindow, Tray, Menu, MenuItem, ipcMain, clipboard, screen, shell, nativeImage, protocol, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Readable } = require('stream');
const { pathToFileURL } = require('url');
const { Store } = require('./lib/store');
const feishu = require('./lib/feishu');

let store;
let tray = null;
let panelWin = null;
let settingsWin = null;
let syncTimer = null;
let syncing = false;
let panelExpanded = false;
let panelSticky = false; // 托盘左键打开时为“固定展开”，不随鼠标离开收回

const isDev = !app.isPackaged;

function log(...a) {
  const line = '[prompt-assistant] ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log(line);
  // 日志写入用户数据目录（AppData），安装目录不留任何个人痕迹
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'app.log'), new Date().toISOString() + ' ' + line + '\n');
  } catch {}
}

// ---------------- 面板窗口 ----------------
function panelBounds() {
  const cfg = store.config.panel;
  const wa = screen.getPrimaryDisplay().workArea;
  if (cfg.edge === 'top') {
    const w = Math.min(cfg.width + 140, wa.width);
    return { x: wa.x + Math.round((wa.width - w) / 2), y: wa.y, width: w, height: Math.round(wa.height * 0.86) };
  }
  return { x: wa.x + wa.width - cfg.width, y: wa.y, width: cfg.width, height: wa.height };
}

let panelEdgeCreated = null;
function createPanel() {
  panelEdgeCreated = store.config.panel.edge;
  panelWin = new BrowserWindow({
    ...panelBounds(),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  panelWin.setAlwaysOnTop(true, 'screen-saver'); // 高于普通置顶窗口
  panelWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panelWin.loadFile(path.join(__dirname, 'src', 'panel.html'));
  panelWin.on('closed', () => (panelWin = null));
  // 收起态窗口缩为把手大小（真实接收鼠标事件）；展开/拖动态为面板全尺寸
  panelWin.once('ready-to-show', () => {
    panelWin.showInactive();
    setWinMode(panelExpanded ? 'expanded' : 'collapsed');
    setTimeout(() => {
      try {
        const pt = screen.getCursorScreenPoint();
        const hr = handleRect();
        if (pt.x >= hr.x && pt.x < hr.x + hr.width && pt.y >= hr.y && pt.y < hr.y + hr.height) {
          sendPanel('panel:handle-enter');
        }
      } catch {}
    }, 600);
  });
}

// ---------------- 窗口模式：无穿透架构 ----------------
// collapsed: 窗口=把手大小（天然不遮挡，真实鼠标事件）
// dragging:  窗口=全列（跟踪拖动），面板滑出态不接收点击
// expanded:  窗口=全列，面板滑入
// 全程不使用 setIgnoreMouseEvents（Windows 下其反向调用不可靠）
let panelMode = 'collapsed';
let handleDragging = false;
let dragFrac = null;
function setWinMode(m, force) {
  if (panelMode === m && !force) return;
  log('setWinMode', m, force ? '(forced)' : '');
  panelMode = m;
  if (!panelWin || panelWin.isDestroyed()) return;
  panelWin.setBounds(m === 'collapsed' ? handleRect() : panelBounds());
}

function sendPanel(channel, payload) {
  if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send(channel, payload);
}

function setPanelInteractive(_on) { /* 不再需要 */ }

function repositionPanel() {
  if (!panelWin || panelWin.isDestroyed()) return;
  setWinMode(panelMode === 'expanded' || panelMode === 'dragging' ? panelMode : 'collapsed');
  sendPanel('panel:layout', { edge: store.config.panel.edge });
}

function recreatePanelWindow() {
  panelExpanded = false;
  panelSticky = false;
  handleDragging = false;
  if (panelWin && !panelWin.isDestroyed()) panelWin.destroy();
  panelWin = null;
  createPanel();
}

let collapseTimer = null;
function expandPanel(sticky) {
  if (!panelWin || panelWin.isDestroyed()) createPanel();
  if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
  panelSticky = !!sticky;
  panelExpanded = true;
  setWinMode('expanded');
  sendPanel('panel:expand', { sticky: panelSticky });
  if (panelWin) panelWin.showInactive();
}

function collapsePanel() {
  if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
  panelSticky = false;
  panelExpanded = false;
  sendPanel('panel:collapse', {}); // 渲染进程开始滑出（.22s）
  collapseTimer = setTimeout(() => {
    collapseTimer = null;
    if (panelExpanded || handleDragging) return;
    setWinMode('collapsed'); // 滑出完成后缩窗
    sendPanel('panel:handle-on');
  }, 240);
}

function togglePanel() {
  if (panelExpanded && panelSticky) collapsePanel();
  else expandPanel(true);
}

function handleRect() {
  const wa = screen.getPrimaryDisplay().workArea;
  const cfg = store.config.panel;
  const pos = cfg.handlePos || {};
  if (cfg.edge === 'top') {
    const f = typeof pos.top === 'number' ? pos.top : 0.5;
    const b = panelBounds();
    return { x: b.x + Math.round(b.width * f) - 42, y: wa.y, width: 84, height: 24 };
  }
  const f = typeof pos.right === 'number' ? pos.right : 0.5;
  return { x: wa.x + wa.width - 24, y: wa.y + Math.round(wa.height * f) - 42, width: 24, height: 84 };
}

// ---------------- 托盘 ----------------
function buildTrayMenu() {
  const menu = new Menu();
  const { prompts, phrases } = store.getTrayItems();

  menu.append(new MenuItem({ label: panelExpanded ? '收起面板' : '打开面板', click: () => togglePanel() }));
  menu.append(new MenuItem({ label: '设置…', click: () => openSettings() }));
  menu.append(new MenuItem({ label: '立即同步', enabled: !syncing, click: () => { syncAll().catch(() => {}); } }));
  menu.append(new MenuItem({ type: 'separator' }));

  const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  // 常用句（平铺，短文本）
  if (phrases.length) {
    const sub = new Menu();
    for (const p of phrases) {
      sub.append(new MenuItem({ label: trunc(p.name || p.title || '常用句', 22), click: () => copyText(p.content, p.name, p.id) }));
    }
    menu.append(new MenuItem({ label: `常用句 (${phrases.length})`, submenu: sub }));
  }

  // 提示词：条目少时平铺，多时按标签分组，控制菜单密度
  if (prompts.length) {
    if (prompts.length <= 9) {
      for (const p of prompts) {
        menu.append(new MenuItem({ label: trunc(p.title, 22), click: () => copyText(p.content, p.title, p.id) }));
      }
    } else {
      const groups = new Map();
      for (const p of prompts) {
        const key = (p.tags && p.tags[0]) || '未分类';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(p);
      }
      for (const [tag, list] of groups) {
        const sub = new Menu();
        for (const p of list) sub.append(new MenuItem({ label: trunc(p.title, 20), click: () => copyText(p.content, p.title, p.id) }));
        menu.append(new MenuItem({ label: `${tag} (${list.length})`, submenu: sub }));
      }
    }
  }

  menu.append(new MenuItem({ type: 'separator' }));
  menu.append(new MenuItem({ label: '退出', click: () => app.quit() }));
  return menu;
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray.png');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip(`提示词助手 v${app.getVersion()}`);
  tray.on('click', (e) => {
    log('tray click button=', e.button);
    // 左键：打开/收起面板（Windows 下部分版本 button 为 undefined，仅排除右键）
    if (e.button === 2) return;
    togglePanel();
  });
  tray.on('right-click', () => {
    if (tray) tray.popUpContextMenu(buildTrayMenu());
  });
  tray.on('mouse-move', () => {}); // keep event loop warm on some platforms
}

function refreshTray() {
  if (tray) tray.setContextMenu(null); // 使用动态 popUp，避免静态菜单抢占右键事件
}

// ---------------- 设置窗口 ----------------
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 900,
    height: 660,
    minWidth: 760,
    minHeight: 520,
    title: '提示词助手 · 设置',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    backgroundColor: '#f6f7fb',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.loadFile(path.join(__dirname, 'src', 'settings.html'));
  settingsWin.on('closed', () => (settingsWin = null));
}

// ---------------- 复制 ----------------
function copyText(text, label, id) {
  clipboard.writeText(String(text == null ? '' : text));
  if (id) {
    // 复制统计：高频使用词库；增量推送，避免整表重渲染丢滚动位置
    store.recordCopy(id);
    const payload = { id, count: store.copyCountOf(id) };
    sendPanel('stats:updated', payload);
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('stats:updated', payload);
  }
  if (store.config.behavior.copyToast !== false) {
    sendPanel('panel:toast', { text: `已复制：${(label || '').slice(0, 18) || '内容'}` });
  }
  return true;
}

// 开机自启：路径/参数必须自带引号（Electron 写注册表不加引号，含空格路径会被截断导致开机启动失败）
function applyLoginItem() {
  const on = !!(store.config.behavior && store.config.behavior.launchAtLogin);
  const q = (p) => `"${p}"`;
  app.setLoginItemSettings({
    openAtLogin: on,
    path: q(process.execPath),
    args: isDev ? [q(path.resolve(__dirname))] : [],
  });
}

// ---------------- 同步 ----------------
async function syncAll() {
  if (syncing) return { ok: false, error: '正在同步中' };
  log('syncAll start, sources =', (store.config.sources || []).length);
  syncing = true;
  notifySyncState();
  const cfg = store.config;
  const errors = [];
  try {
    const prompts = [];
    const phrases = [];
    if (!cfg.baseToken) throw new Error('尚未配置多维表：设置 → 数据源 → 粘贴多维表链接并解析');
    const tables = await feishu.listTables(cfg);
    store.cache.tables = tables;
    // 按表名自动接入数据源（表名含「提示词」），不内置任何个人表 ID；用户手动移除过的不再加回
    const removed = new Set(cfg.removedTableIds || []);
    const have = new Set((cfg.sources || []).map((s) => s.tableId));
    let addedSrc = false;
    for (const t of tables) {
      if (/提示词/.test(t.name) && !have.has(t.id) && !removed.has(t.id)) {
        cfg.sources.push({ id: 'src_' + t.id, kind: 'prompt', name: t.name, tableId: t.id, enabled: true, mapping: {}, downloadImages: false });
        have.add(t.id);
        addedSrc = true;
      }
    }
    if (addedSrc) {
      store.saveConfig();
      log('auto-added sources by table name:', cfg.sources.length);
    }
    for (const src of cfg.sources || []) {
      if (!src.enabled) continue;
      try {
        const items = await feishu.syncSource(cfg, src, mediaBaseDir(), () => {});
        log('sync source', src.name, '->', items.length, 'items');
        // 磁盘已有的媒体直接挂本地路径：重启后首屏即显，不必重新解析
        for (const it of items) {
          for (const [role, key] of [['img', 'image'], ['vid', 'video']]) {
            const m = it[key];
            if (m && m.fileToken && !m.localPath) {
              const ext = path.extname(m.name || '') || (role === 'vid' ? '.mp4' : '.png');
              const f = resolveMediaFile(`${it.tableId}_${it.recordId}_${role}${ext}`);
              if (f && fs.statSync(f).size > 0) m.localPath = f;
            }
          }
        }
        if (src.kind === 'phrase') {
          for (const it of items) phrases.push({ id: it.id, name: it.title, content: it.content || it.title, origin: 'feishu' });
        } else {
          prompts.push(...items);
        }
      } catch (e) {
        log('sync source FAILED', src.name, ':', e.message);
        errors.push(`${src.name}: ${e.message}`);
      }
    }
    store.cache.prompts = prompts;
    store.cache.phrases = phrases;
    store.cache.lastSyncAt = Date.now();
    store.config.sync.lastSyncAt = Date.now();
    store.config.sync.lastError = errors.join(' | ');
    store.saveCache();
    store.saveConfig();
  } catch (e) {
    store.config.sync.lastError = String(e.message || e);
    store.saveConfig();
    errors.push(String(e.message || e));
  } finally {
    syncing = false;
    notifySyncState();
  }
  broadcastData();
  return { ok: errors.length === 0, errors };
}

function notifySyncState() {
  sendPanel('sync:state', { syncing });
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('sync:state', { syncing });
}

function broadcastData() {
  const view = store.getView();
  const meta = {
    lastSyncAt: store.cache.lastSyncAt,
    lastError: store.config.sync.lastError,
    syncing,
  };
  sendPanel('data:updated', { view, meta });
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('data:updated', { view, meta });
}

function scheduleAutoSync() {
  if (syncTimer) clearInterval(syncTimer);
  const m = store.config.sync.autoMinutes || 0;
  if (m > 0) {
    syncTimer = setInterval(() => { syncAll().catch(() => {}); }, m * 60 * 1000);
  }
}

// ---------------- 本地媒体协议（支持 Range，视频可拖动进度） ----------------
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };
function registerLocalProtocol() {
  protocol.handle('localimg', (req) => {
    try {
      const u = new URL(req.url);
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      const file = resolveMediaFile(rel);
      if (!file) return new Response('', { status: 404 });
      const stat = fs.statSync(file);
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const range = req.headers.get('range');
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        const start = m && m[1] ? parseInt(m[1], 10) : 0;
        const end = m && m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
        if (!m || start > end || start >= stat.size) {
          return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
        }
        return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
          status: 206,
          headers: {
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(end - start + 1),
            'Content-Type': type,
          },
        });
      }
      return new Response(Readable.toWeb(fs.createReadStream(file)), {
        headers: { 'Content-Length': String(stat.size), 'Content-Type': type, 'Accept-Ranges': 'bytes' },
      });
    } catch {
      return new Response('', { status: 500 });
    }
  });
}

// ---------------- 媒体按需下载（封面图 / 视频），并发 2 ----------------
// 缓存目录：默认在安装目录 cache/media（不占 C 盘）；可自定义；无痕模式用系统临时目录且退出清空
function mediaTmpDir() {
  return path.join(os.tmpdir(), 'prompt-assistant-media');
}
function defaultMediaDir() {
  if (process.platform === 'win32') {
    // Windows：安装目录\cache\media（exe 所在目录）；打包后 __dirname 在 asar 内不可写
    const base = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
    return path.join(base, 'cache', 'media');
  }
  // mac/Linux：.app 包体只读且写入会破坏签名，放应用数据目录
  return path.join(app.getPath('userData'), 'media');
}
function mediaBaseDir() {
  const custom = store && store.config.storage && store.config.storage.mediaDir;
  return custom && custom.trim() ? custom.trim() : defaultMediaDir();
}
function mediaDirs() {
  const dirs = [];
  if (store && store.config.behavior.mediaPersist === false) dirs.push(mediaTmpDir());
  dirs.push(mediaBaseDir());
  if (store) dirs.push(store.imgDir); // 兼容旧缓存位置
  return Array.from(new Set(dirs));
}
function resolveMediaFile(name) {
  for (const d of mediaDirs()) {
    const f = path.join(d, path.basename(name));
    if (fs.existsSync(f)) return f;
  }
  return null;
}
function ensureMediaDir() {
  const d = store.config.behavior.mediaPersist === false ? mediaTmpDir() : mediaBaseDir();
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const mediaQueue = [];
let mediaActive = 0;
let cacheSaveTimer = null;
// 把“文件已在磁盘”的信息写进 cache.json：重启后无需重新解析/下载，直接秒显
function rememberMediaPath(tableId, recordId, role, localPath) {
  const list = store.cache.prompts || [];
  const it = list.find((x) => x.tableId === tableId && x.recordId === recordId);
  if (!it) return;
  if (role === 'video') { it.video = it.video || {}; it.video.localPath = localPath; }
  else { it.image = it.image || {}; it.image.localPath = localPath; }
  if (cacheSaveTimer) clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(() => { cacheSaveTimer = null; try { store.saveCache(); } catch {} }, 1500);
}
function pumpMedia() {
  while (mediaActive < 2 && mediaQueue.length) {
    const job = mediaQueue.shift();
    mediaActive++;
    job.run()
      .then(() => { log('media ok ->', path.basename(job.dest)); rememberMediaPath(job.tableId, job.recordId, job.role, job.dest); job.res({ localPath: job.dest }); })
      .catch((e) => { log('media FAIL', path.basename(job.dest), ':', String(e.message || e).slice(0, 200)); job.res({ error: String(e.message || e) }); })
      .finally(() => { mediaActive--; pumpMedia(); });
  }
}
function ensureMedia({ tableId, recordId, fileToken, name, role }) {
  const ext = path.extname(name || '') || (role === 'video' ? '.mp4' : '.png');
  const fname = `${tableId}_${recordId}_${role === 'video' ? 'vid' : 'img'}${ext}`;
  const existing = resolveMediaFile(fname);
  if (existing && fs.statSync(existing).size > 0) {
    rememberMediaPath(tableId, recordId, role === 'video' ? 'video' : 'image', existing);
    return Promise.resolve({ localPath: existing });
  }
  const dest = path.join(ensureMediaDir(), fname);
  log('media ensure queued:', role, path.basename(dest));
  return new Promise((res) => {
    mediaQueue.push({
      dest,
      tableId,
      recordId,
      role: role === 'video' ? 'video' : 'image',
      res,
      run: () => feishu.downloadAttachment(store.config, { tableId, recordId, fileToken, destPath: dest }),
    });
    pumpMedia();
  });
}

// ---------------- IPC ----------------
function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, async (ev, ...args) => fn(...args));

  h('data:get', () => ({ view: store.getView(), config: store.config, meta: { lastSyncAt: store.cache.lastSyncAt, lastError: store.config.sync.lastError, syncing, version: app.getVersion() } }));
  h('config:get', () => store.config);
  h('config:set', (patch) => {
    store.updateConfig(patch);
    applyConfigSideEffects(patch);
    return store.config;
  });
  h('sync:now', () => syncAll());
  h('copy:text', (text, label, id) => copyText(text, label, id));
  h('stats:clear', () => { store.clearStats(); broadcastData(); return true; });
  h('dialog:pickDir', async () => {
    const win = settingsWin && !settingsWin.isDestroyed() ? settingsWin : null;
    const r = await dialog.showOpenDialog(win, { title: '选择媒体缓存目录', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });

  // ---------------- 环境自检 / 一键安装 ----------------
  h('env:check', async () => {
    const cfg = store.config;
    const out = {
      node: { ok: true, detail: `内置 Node ${process.versions.node}（运行 lark-cli 无需另装 Node）` },
      cli: { ok: false, detail: '检测中…' },
      auth: { ok: false, detail: '检测中…' },
      base: { ok: false, detail: '检测中…' },
      mediaDir: { ok: false, detail: '' },
    };
    // lark-cli + 登录态
    try {
      const st = await feishu.runCli(cfg, ['auth', 'status'], { timeout: 30000 });
      out.cli = { ok: true, detail: 'lark-cli 已安装' };
      const u = st && st.identities && st.identities[cfg.identity || 'user'];
      if (u && u.status === 'ready') out.auth = { ok: true, detail: `已登录：${u.userName || cfg.identity}` };
      else out.auth = { ok: false, detail: '未登录或登录已过期', action: 'login' };
    } catch (e) {
      const msg = String(e.message || e);
      if (/不是内部或外部命令|not recognized|ENOENT|找不到/i.test(msg)) {
        out.cli = { ok: false, detail: '未安装 lark-cli', action: 'install' };
        out.auth = { ok: false, detail: '需先安装 lark-cli' };
      } else {
        out.cli = { ok: true, detail: 'lark-cli 已安装' };
        out.auth = { ok: false, detail: '登录态异常：' + msg.slice(0, 80), action: 'login' };
      }
    }
    // 多维表可达
    if (!cfg.baseToken) {
      out.base = { ok: false, detail: '未配置多维表链接', action: 'config' };
    } else {
      try {
        const ts = await feishu.listTables(cfg);
        out.base = { ok: true, detail: `多维表可读，共 ${ts.length} 张表` };
      } catch (e) {
        out.base = { ok: false, detail: '多维表读取失败：' + String(e.message || e).slice(0, 80) };
      }
    }
    // 缓存目录可写
    try {
      const d = ensureMediaDir();
      const probe = path.join(d, '.write-test');
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe, { force: true });
      out.mediaDir = { ok: true, detail: d };
    } catch (e) {
      out.mediaDir = { ok: false, detail: '缓存目录不可写：' + String(e.message || e).slice(0, 60) };
    }
    return out;
  });

  h('env:installCli', () => new Promise((resolve) => {
    const { execFile } = require('child_process');
    const cmd = process.platform === 'win32' ? 'npm install -g @larksuite/cli' : 'npm install -g @larksuite/cli';
    execFile(
      process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      process.platform === 'win32' ? ['/d', '/c', cmd] : ['-c', cmd],
      { windowsHide: true, timeout: 600000, maxBuffer: 1024 * 1024 * 32 },
      (err, stdout, stderr) => resolve({ ok: !err, detail: (stdout || '').slice(-300) + (err ? '\n' + String(stderr || err.message).slice(-300) : '') })
    );
  }));

  h('env:login', () => {
    const { spawn } = require('child_process');
    const cli = store.config.larkCliPath || (process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli');
    const child = process.platform === 'win32'
      ? spawn('cmd.exe', ['/c', `"${cli}" auth login`], { detached: true, stdio: 'inherit', windowsHide: false })
      : spawn(cli, ['auth', 'login'], { detached: true, stdio: 'inherit' });
    child.unref();
    return { ok: true, detail: '已打开登录窗口，请在浏览器/终端完成授权后重新检查' };
  });

  h('cache:clearMedia', () => {
    let n = 0;
    for (const d of new Set([mediaBaseDir(), store.imgDir])) {
      try {
        for (const f of fs.readdirSync(d)) {
          if (f === '.write-test') continue;
          fs.rmSync(path.join(d, f), { recursive: true, force: true });
          n++;
        }
      } catch {}
    }
    return { ok: true, count: n };
  });
  h('pin:toggle', (id) => { const r = store.togglePin(id); broadcastData(); return r; });
  h('local:save', (item) => { const r = store.upsertLocal(item); broadcastData(); return r; });
  h('local:delete', (id) => { store.deleteLocal(id); broadcastData(); return true; });
  h('panel:interactive', (on) => setPanelInteractive(!!on));
  h('panel:state', (st) => {
    // 兼容恢复场景：路由到统一入口
    if (st && st.expanded) expandPanel(!!st.sticky);
    else collapsePanel();
  });
  h('panel:getstate', () => ({ expanded: panelExpanded, sticky: panelSticky }));
  h('panel:setHandlePos', (p) => {
    store.updateConfig({ panel: { handlePos: { ...(store.config.panel.handlePos || {}), ...(p || {}) } } });
    if (!panelExpanded && !handleDragging) setWinMode('collapsed');
    const pos = store.config.panel.handlePos || {};
    sendPanel('panel:handle-pos', { frac: typeof pos.right === 'number' ? pos.right : (typeof pos.top === 'number' ? pos.top : 0.5) });
    return store.config.panel.handlePos;
  });
  h('panel:requestExpand', (sticky) => { expandPanel(!!sticky); return true; });
  h('panel:requestCollapse', () => { collapsePanel(); return true; });
  h('panel:dragging', (on) => {
    handleDragging = !!on;
    if (on) {
      setWinMode('dragging');
      sendPanel('panel:drag-on');
    }
    return true;
  });
  h('panel:dragMove', (x, y) => {
    const wa = screen.getPrimaryDisplay().workArea;
    const cfgp = store.config.panel;
    const f = cfgp.edge === 'top' ? (x - wa.x) / wa.width : (y - wa.y) / wa.height;
    dragFrac = Math.min(0.94, Math.max(0.06, f));
    sendPanel('panel:drag-pos', { frac: dragFrac });
    return true;
  });
  h('panel:dragEnd', (moved) => {
    handleDragging = false;
    const key = store.config.panel.edge === 'top' ? 'top' : 'right';
    if (moved && dragFrac != null) {
      store.updateConfig({ panel: { handlePos: { ...(store.config.panel.handlePos || {}), [key]: dragFrac } } });
    }
    dragFrac = null;
    // 拖拽结束：强制回到收起态 + 通知渲染进程重置视觉，杜绝把手缺块/残留态
    panelExpanded = false;
    panelSticky = false;
    setWinMode('collapsed', true);
    sendPanel('panel:force-collapsed');
    return true;
  });
  h('panel:ctrlHover', (on) => { ctrlHover = !!on; return true; });
  h('settings:open', () => openSettings());
  h('app:quit', () => app.quit());
  h('shell:open', (url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return true; });
  h('media:ensure', (req) => ensureMedia(req || {}));
  h('feishu:tables', () => feishu.listTables(store.config));
  h('feishu:fields', (tableId) => feishu.listFields(store.config, tableId));
  h('feishu:guess', (tableId) => feishu.listFields(store.config, tableId).then((f) => feishu.guessMapping(f)));
}

function applyConfigSideEffects(patch) {
  if (patch.panel) {
    if (patch.panel.edge !== undefined && patch.panel.edge !== panelEdgeCreated) recreatePanelWindow();
    else repositionPanel();
  }
  if (patch.sync && patch.sync.autoMinutes !== undefined) scheduleAutoSync();
  if (patch.behavior && patch.behavior.launchAtLogin !== undefined) applyLoginItem();
  if (patch.appearance) {
    sendPanel('appearance:updated', store.config.appearance);
  }
  broadcastData();
}

// ---------------- 启动 ----------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => togglePanel());
  app.whenReady().then(async () => {
    store = new Store(app.getPath('userData'));
    registerLocalProtocol();
    registerIpc();
    feishu.probeSystemNode(); // 预热：后续 lark-cli 子进程优先用系统 node，避免任何弹窗
    // 启动预解析：磁盘已有媒体直接挂本地路径（修复重启后图片需重新加载）
    try {
      let n = 0;
      for (const it of (store.cache.prompts || [])) {
        for (const [role, key] of [['img', 'image'], ['vid', 'video']]) {
          const m = it[key];
          if (m && m.fileToken && !m.localPath) {
            const ext = path.extname(m.name || '') || (role === 'vid' ? '.mp4' : '.png');
            const f = resolveMediaFile(`${it.tableId}_${it.recordId}_${role}${ext}`);
            if (f && fs.statSync(f).size > 0) { m.localPath = f; n++; }
          }
        }
      }
      if (n) { store.saveCache(); log('startup media relink:', n); }
    } catch {}

    if (store.config.behavior && store.config.behavior.launchAtLogin) applyLoginItem(); // 自愈历史坏条目（未加引号）
    createTray();
    refreshTray();
    createPanel();
    scheduleAutoSync();
    screen.on('display-metrics-changed', repositionPanel);

    // 首次运行（无缓存）自动同步一次
    if (!store.cache.lastSyncAt) {
      setTimeout(() => syncAll().catch(() => {}), 800);
    } else {
      broadcastData();
    }
  });

  app.on('window-all-closed', (e) => {
    // 常驻托盘，不退出
  });
  app.on('before-quit', () => {
    if (tray) tray.destroy();
    // 无痕模式：退出时清空临时媒体目录，不留痕迹
    if (store && store.config.behavior.mediaPersist === false) {
      try { fs.rmSync(mediaTmpDir(), { recursive: true, force: true }); } catch {}
    }
  });
}
