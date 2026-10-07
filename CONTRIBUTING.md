# 贡献指南

感谢关注「提示词助手」！欢迎以任何形式参与贡献：报告问题、提功能建议、改进文档或提交代码。

## 提交 Issue

- **Bug 反馈**请附上：操作系统与版本（macOS / Windows）、应用版本号、复现步骤、
  「设置 → 数据源 → 环境自检」的截图或文字结果；
- 涉及同步失败的问题，可附 `app.log` 尾部若干行（mac：`~/Library/Application Support/提示词助手/app.log`；
  Windows：`%AppData%\提示词助手\app.log`），**贴出前请自行抹掉个人多维表地址**；
- **功能建议**请说明使用场景，最好附上你期望的交互方式。

## 提交 PR

1. Fork 本仓库，基于 `main` 创建功能分支（`feat/xxx` 或 `fix/xxx`）；
2. 开发与调试：

   ```bash
   npm install
   npm start        # 开发运行，加 --enable-logging 可看渲染进程日志
   ```

3. 代码风格与现有代码保持一致：无构建步骤的原生 JS（CommonJS 主进程 + 渲染进程独立脚本）、
   中文注释、注释解释「为什么」而不是「做了什么」；
4. **跨平台是硬约束**：任何平台相关逻辑必须用 `process.platform` 显式分支，
   改动不得破坏另一平台的行为（mac 改动跑一下 Windows 分支路径的推演，反之亦然）；
5. 打包验证：

   ```bash
   npm run dist:mac    # macOS dmg / zip
   npm run dist:win    # Windows NSIS（macOS 上交叉编译需 --x64 指定架构）
   ```

6. 提交信息用中文，一句话说清动机与影响面；PR 描述里写上自测过的平台。

## 项目结构速览

```
main.js            主进程：托盘/菜单栏、吸附面板窗口、设置窗口、同步调度、IPC
preload.js         contextBridge 安全桥（通道白名单）
lib/feishu.js      lark-cli 封装（CLI 探测、平台分支、字段映射、附件下载）
lib/store.js       配置与缓存读写、合并视图、常用标记
lib/config.js      默认配置
src/panel.*        吸附面板 UI（悬停展开/离开收回/两级分类/媒体懒加载）
src/settings.*     设置页 UI
tools/gen-icon.js  图标生成（彩色托盘/应用图标 + mac 模板图标，纯 Node 绘制）
docs/screenshots/  README 展示截图（注意脱敏，勿含真实多维表链接与个人数据）
```

## 数据与隐私约定

- 代码默认值不得包含任何个人多维表地址、表 ID、登录凭据；
- 截图进仓库前必须脱敏（替换/遮盖多维表链接等个人信息）；
- 个人数据只应落在用户数据目录（userData），不得写入安装目录。

## 许可

提交即表示你同意代码以 [MIT](LICENSE) 许可证随本项目分发。
