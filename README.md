# MAGA — Make Antigravity Great Again

一套面向 **Google Antigravity Desktop 2.0**（macOS / Node.js >= 22）的独立模块化增强方案：在不修改原生应用签名文件的前提下，通过单一轻量 CDP 守护进程，提供统一克制的视觉排版、增强型模型与思考强度选择器、自适应底栏三胶囊状态栏，以及内化至右侧 `Overview` 面板的本机 Token 用量分析。

## 核心特性

- **统一底栏三胶囊（宽窄屏自适应）**
  - **模型与思考强度胶囊**：按当前模型家族自动着色（圆点 + 同色系浅底色 + 思考强度微标签），支持自定义隐藏模型、18px 动效思考强度滑块与 Orchestrator 切换。
  - **上下文窗口胶囊**：实时显示 `已用 / 上限`（如 `178.4k / 512k`），内置三档高辨识阈值提示（`<60%` 静谧、`60%–74%` 橙黄、`≥75%` 醒红呼吸提示），点击查看精简 296px 双层配额弹层与一键压缩。
  - **速率与工作态胶囊**：自带实时工作呼吸指示点（运行中呼吸、完成后 15s 冷却、闲置静谧）与三档生成速率配色（`≥25 tok/s` 绿、`10–24.9` 琥珀、`<10` 红），保留完整悬浮性能详情卡。
  - **窄屏对称双行布局**：当侧栏或内置浏览器展开、输入区变窄（`<550px`）时，自动切换为「上行交互操作 + 细分割线 + 下行左右对齐遥测栏」，零截断、零挤压。
- **右侧 `Overview` 内化用量统计卡片**
  - 复用单一守护进程增量扫描本机对话 SQLite（基于文件/WAL 指纹缓存与闲置库 `immutable=1` 只读，无额外 sidecar 进程）。
  - 提供 **今日 / 本周 / 本月** KPI、`日 / 周 / 月` 纤细堆叠柱状图与翻页、按模型家族统计与占比进度条，全区域支持零延迟自定义悬浮详情卡（含非缓存/缓存读写/输出及思考强度明细）。
- **专注阅读与交互打磨**
  - Regular `400` 正常字重 + `100%` 中英文比例 + 平衡中高对比度（明/暗色自适应）。
  - 隐藏冗长的英文 Thinking 正文与展开箭头，仅保留干净的 `Thought for Xs` / `Thinking...` 状态行；工具操作分组默认折叠、按需点击展开；自动消除原生与注入计时器重复。
  - 内置精简版 `fast-io` 全局效率规则（仅优化代码检索、读写与命令批处理，不限制回复深度与内容完整性）。

## 目录结构

```text
.
├── core/                  # CDP 守护进程与基础注入运行时
├── user/                  # 基础主题与交互层模板
├── vendor/agy-capsule/    # 内化的零依赖模型选择器与统计基础模块
├── studio/
│   ├── cli.mjs            # 统一命令行入口（install / deploy / doctor / rollback）
│   ├── build.mjs          # 模块打包器与语法校验部署脚本
│   ├── daemon/            # 本机 SQLite 用量读取与增量聚合服务
│   ├── modules/           # 前端模块化运行时（模型胶囊、底栏同步、Overview 用量卡）
│   ├── styles/            # 分职责样式表（排版、底栏胶囊、配额弹层、用量卡片）
│   └── rules/             # 精简版 fast-io 规则模板
└── install.mjs            # 守护进程与 LaunchAgent 安装管理器
```

## 快速开始

环境要求：macOS + Node.js `>= 22` + Google Antigravity Desktop 2.0。

```bash
# 1. 完整安装（配置本机 LaunchAgent 守护进程 + 部署前端增强 + 同步 fast-io 规则）
npm run install-all

# 2. 修改 studio/ 下任意代码后热重载部署（无需重启 Antigravity）
npm run deploy

# 3. 全面体检（检查守护进程、CDP 连接、注入标记、用量扫描与关键配置）
npm run doctor

# 4. 仅同步精简版 fast-io 规则到 ~/.gemini/AGENTS.md
npm run sync-rules

# 5. 回滚 studio 增强层，恢复基础状态
npm run rollback
```

## 致谢（Acknowledgements）

本项目的设计灵感与部分底层实现受益于以下优秀的开源项目，在此向原作者致以诚挚感谢：

- [**hongqi7/Anti-Claude**](https://github.com/hongqi7/Anti-Claude) — 提供了稳定零依赖的 Antigravity CDP 守护进程架构、Claude 风格界面体系与右侧 Overview 面板基础。
- [**Lumidarin/agy-capsule**](https://github.com/Lumidarin/agy-capsule) — 提供了极具质感的模型与思考强度动效选择器、速率状态指示设计以及本机 SQLite 对话用量统计思路。
- [**oil-oil/agy-fast-io**](https://github.com/oil-oil/agy-fast-io) — 启发了 `studio/rules/fast-io.md` 中的快速检索与白名单命令批处理效率规则。
