'use strict';
// 默认配置。首次运行时写入 userData/config.json，之后以用户配置为准。

const path = require('path');

function defaultLarkCli() {
  return process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli';
}

// 默认数据源：指向用户提供的多维表中的「常用提示词库」表
function defaultConfig() {
  return {
    // 飞书多维表：默认为空，首次使用在设置页粘贴链接解析；
    // 同步时按表名自动识别数据源（表名含「提示词」的表自动接入），不内置任何个人表信息
    baseUrl: '',
    baseToken: '',
    larkCliPath: defaultLarkCli(),
    identity: 'user', // user | bot

    // 数据源（可多个）。kind: prompt=提示词卡片, phrase=常用句
    sources: [],

    sync: {
      autoMinutes: 0, // 0 = 仅手动同步
      lastSyncAt: 0,
      lastError: '',
    },

    tray: {
      // 右键菜单里展示的“常用”条目 id 列表；为空则自动取前 N 条
      pinnedIds: [],
      maxItems: 14,
    },

    panel: {
      edge: 'right', // right | top
      width: 384,
      handleWidth: 26,
      hoverExpand: true,
      autoCollapseMs: 550,
      defaultTab: 'prompt', // prompt | phrase
    },

    // 本地维护的常用句（也可从飞书 phrase 源同步）
    phrases: {
      local: [], // [{id,name,content,pinned}]
    },

    appearance: {
      theme: 'light', // light | dark
      accent: '#4f7cff',
      previewLines: 2,
      cardImage: true,
    },

    behavior: {
      launchAtLogin: false,
      copyToast: true,
      // true=预览媒体缓存到磁盘（二次秒开）；false=无痕：临时目录存放，退出自动清空
      mediaPersist: true,
    },

    // 媒体缓存目录：''=默认（安装目录/cache/media）；可自定义任意盘路径
    storage: {
      mediaDir: '',
    },
  };
}

module.exports = { defaultConfig, defaultLarkCli };
