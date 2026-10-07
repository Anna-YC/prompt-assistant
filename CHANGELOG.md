# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [1.8.1] - 2026-09-30

### macOS 适配（本仓库核心增量）

- **菜单栏托盘**：改用 macOS 模板图标（`trayTemplate`），随系统深浅色外观自动反色；应用隐藏 Dock 图标（`LSUIElement` 代理应用 + `app.dock.hide()` 双保险）
- **lark-cli 调用链**：GUI 应用继承的受限 PATH 下自动探测 `/opt/homebrew/bin`、`~/.npm-global/bin` 等常见安装位置；为所有子进程注入增强 PATH，修复 `#!/usr/bin/env node` shebang 脚本在打包版中无法启动的问题；已存在的原生可执行文件直接 `execFile`，不再绕 `/bin/sh`
- **开机自启**：登录项按平台分支（macOS 路径不加引号，Windows 注册表路径保持加引号）
- **AI 助手排查**：环境自检「复制给 AI 助手排查」生成 darwin 版指令（镜像包名、`open` 命令、mac 路径约定）
- **设置页**：`%AppData%` 等 Windows 硬编码文案按平台显示；「开机自动启动」在 mac 上显示为「登录 Mac 时自动启动」
- **打包**：新增 `mac` 目标（dmg + zip / arm64），`npm run dist:mac`；Windows NSIS 打包保留 `npm run dist:win`，且 macOS 上可交叉编译（`npx electron-builder --win nsis --x64`）
- **开发体验**：新增双击启动脚本 `启动提示词助手.command`；应用图标升级为 1024×1024

### 沿用上游（EConG37/prompt-assistant v1.8.1）

- 修复开机双实例自启与面板收起后反复弹出
- 媒体缓存目录、无痕模式、复制统计等既有能力保持不变

### 兼容性说明

- 所有平台分支均以 `process.platform === 'win32'` 显式判断，Windows 侧行为与上游一致，可直接互提 PR

## 剪藏插件（随 Release 分发，版本独立）

### [1.8.3] - 2026-10-06

- 剪藏保存时，新标签自动补进飞书「分类 / 主分类 / 子分类 / 使用模型」单选/多选字段，不再报「选项不存在」
- 「从飞书同步选项」改为合并语义，本地新增、尚未写入飞书的标签不再被远端覆盖
- 需要飞书自建应用补开 `base:field:update` 权限（连同原三个共四个）

### [1.8.2] - 2026-10-02

- 修复 AIFISHER 等网站原生模态弹窗下剪藏浮层不可交互的问题；弹窗内候选限定当前作品

[1.8.1]: https://github.com/Anna-YC/prompt-assistant/releases/tag/v1.8.1-mac
