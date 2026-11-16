# Antigravity Claude UX

**Bring the exact macOS Claude Desktop (Code / Cowork) aesthetic, interleaved step narration, animated tool disclosures, and live `TodoWrite` checklist cards to Google Antigravity Desktop 2.0 — 100% via non-invasive CDP runtime injection.**

[中文说明](#-功能亮点) · [Quick Start](#-一键安装-quick-start) · [Architecture](#-工作原理-how-it-works) · [English Summary](#english-summary)

---

## ✨ 为什么做这个项目？

很多同时深度使用 **Claude Desktop（Code / Cowork 模式）** 与 **Google Antigravity 2.0** 的用户都有两个强烈痛点：
1. **视觉噪音与细节割裂**：现有社区美化要么在输入框周围堆满 Emoji 胶囊挂件，要么默认套上泛黄底色、暗红粗框、等宽打字机输入框与红底行内代码，离 macOS 原生 `Claude.app` 干净克制的纯白无衬线质感差了一口气。
2. **“黑盒闷头干活”缺乏过程感**：
   - Antigravity 首次引导若选到默认的「知识工作模式（Knowledge Work）」，底层会强制开启 `ephemeralToolCalls: true`——**工具和 MCP 一跑完就瞬间销毁隐藏**；
   - 即便切回开发者模式，Gemini 模型默认把所有思路憋在隐藏的 `thinking` 里不说话，且回合结束瞬间外层 `已工作 Xm >` 会把整轮步骤二次打包吞没，React 卸载面板时也缺少收起动画，更没有 Claude Code 标志性的**原地打勾刷新任务卡片（`TodoWrite`）**与**陶土橙双点旋转读秒行**。

本项目在不修改 `Antigravity.app` 安装包（零触碰 `app.asar`、不破坏 Apple 签名、零外部网络请求）的前提下，把**视觉层、前端交互层、客户端隐藏配置层与 Agent 协作规则层**一次性打通。

---

## 🎯 功能亮点

### 1. 像素级对齐 `Claude.app` 纯白/暖炭黑界面（`user/custom.css`）
- **纯白通透浅色 + 暖炭黑深色**：浅色采用 `Claude.app` 原版纯白画布 `#FFFFFF` + 极淡中性灰侧栏 `#F9F9F8` + 无边框浅灰用户气泡 `#F3F3F0` + 中性灰行内代码 `#F3F3F1`；切换深色模式时自动进入 Claude 暖炭黑（`#212120` 画布 / `#191918` 侧栏），告别刺眼冷蓝黑。
- **100% 无衬线苹方 + Anthropic Sans 精排**：移除输入框和正文里的等距更纱黑体 Slab 打字机字体，全局 UI、AI 正文、用户气泡、输入框与底栏实时指标统一使用 `Anthropic Sans + PingFang SC`（`14px` / 行高 `1.65`），并将输入框占位符改为 `opacity: 1` 实色渲染，彻底消除 macOS 半透明灰度抗锯齿导致的笔画变细发虚。
- **极简单层输入框**：抹除原版输入框双层套娃灰托盘与高饱和橙红待机语音球，还原单层纯白圆角框与低调浅灰圆钮。

### 2. 解锁完整步骤流 + 190ms 双向丝滑折叠动画（`install.mjs` + `user/custom.js`）
- **自动解锁隐藏步骤引擎**：一键将客户端从 `PRODUCT_SKIN_NON_TECHNICAL` 切至 `PRODUCT_SKIN_DEVELOPER`（`project4kMode = 1`）并开启 `verboseConversationSteps: true`，永久保留所有文件读写、命令执行与 MCP 调用记录。
- **解除外层二次吞没 & 补齐收起动画**：回合结束时自动解封外层 `已工作 Xm` 套娃包裹，保留中间每句进展正文与 `13px` 单行浅灰工具摘要平铺在对话流中；同时通过 `.ag-collapse-ghost` 快照残影补齐 React 卸载节点缺失的 `190ms cubic-bezier(0.16, 1, 0.3, 1)` 平滑高度收拢动画。

### 3. 1:1 复刻 Claude `TodoWrite` 原地刷新任务卡 + 陶土橙实时秒表
- **同轮次就地合并任务卡片**：基于零侵入旁路挂载（绝不改写 React 自有虚拟 DOM 节点，流式输出零冲突），自动识别同一轮回答中的 `- [ ]`（浅灰虚线圈 `pending`）、`- [/]`（旋转实线圈 `in_progress`）、`- [x]`（柔和打勾 `completed`）清单，**把后续所有进度更新静默合并刷新到首张圆角白卡片上**，绝不重复刷屏。
- **运行中陶土橙双点旋转 + 实时秒表**：三重条件精确锁定当前正在跑的最后一步工具行，行首挂载 `#D97757` 双子星旋转点，行尾挂载 `1s / 2s...` 实时读秒计时器；执行完毕立即清理并销毁定时器（空闲 `0%` CPU 占用）。

### 4. Claude 式「边做边汇报」协作规则（`rules/claude-execution-sync.md`）
- 自动在 `~/.gemini/AGENTS.md` 注入幂等规则块：驱动模型在多步排查/开发任务中每次调工具前先输出 1～2 句简短进展同步，使用自然中文 `toolSummary`，并在 3 阶段以上复杂任务中自动维护实时任务清单卡片。

---

## 🚀 一键安装 (Quick Start)

### 方式一：让 AI 自动帮你装（最省心）
直接把本仓库地址发给你的 Antigravity / Claude Code，说一句：
> `帮我安装 https://github.com/hongqi7/antigravity-claude-ux`

内置的 [`SKILL.md`](SKILL.md) 会引导 Agent 自动完成克隆、字体同步、配置备份与热注入。

### 方式二：终端两行命令安装（无需重启客户端）
要求已安装 Node.js `>= 22`：

```bash
git clone https://github.com/hongqi7/antigravity-claude-ux.git ~/Developer/antigravity-claude-ux
node ~/Developer/antigravity-claude-ux/install.mjs install
```

> **提示**：
> - 如果你尚未安装底层 CDP 注入守护（[`Anarcadia/chuanban-antigravity-theme-patch`](https://github.com/Anarcadia/chuanban-antigravity-theme-patch)），`install.mjs` 会自动从上游拉取并完成守护注册（包含 1,740 条母语级界面汉化与 SQLite 实时 `tok/s · Ctx` 指标胶囊）。
> - 如果你的 Mac 上已安装官方 `/Applications/Claude.app`，脚本会自动提取其中的官方 `Anthropic Sans / Serif` 可变字体到 `~/Library/Fonts/`。

### 常用诊断与无损卸载
```bash
# 检查各层健康状态
node ~/Developer/antigravity-claude-ux/install.mjs doctor

# 一键无损还原（恢复原有 user/ 配置并移除 AGENTS.md 规则块，即时热生效）
node ~/Developer/antigravity-claude-ux/install.mjs uninstall
```

---

## 🧩 工作原理 (How It Works)

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                    Google Antigravity Desktop 2.0                       │
│  (app.asar untouched · Apple codesign intact · 127.0.0.1 local CDP)     │
├───────────────────────────────────┬─────────────────────────────────────┤
│ 1. Visual & Typography Layer      │ 2. Runtime Stream & Widget Layer    │
│    theme-patch/user/custom.css    │    theme-patch/user/custom.js       │
│  • Pure #FFFFFF / #212120 palette │  • Unfolds outer "Worked for Xm"    │
│  • Anthropic Sans + PingFang 14px │  • 190ms ghost collapse animation   │
│  • Single-layer clean composer    │  • In-place TodoWrite card merger   │
│  • Opaque crisp placeholder       │  • Terracotta orbit dots + timer    │
├───────────────────────────────────┼─────────────────────────────────────┤
│ 3. Native Step Engine Unlocker    │ 4. Agent Collaboration Rule         │
│    install.mjs (CDP + pbtxt/json) │    ~/.gemini/AGENTS.md              │
│  • PRODUCT_SKIN_DEVELOPER (mode 1)│  • 1-2 sentence mid-turn updates    │
│  • verboseConversationSteps: true │  • Localized toolSummary & 3-state  │
└───────────────────────────────────┴─────────────────────────────────────┘
```

---

## <a id="english-summary"></a>English Summary

**Antigravity Claude UX** is a non-invasive customization and workflow suite for **Google Antigravity Desktop 2.0** (macOS / Windows) built as a pure user-space extension layer on top of [`Anarcadia/chuanban-antigravity-theme-patch`](https://github.com/Anarcadia/chuanban-antigravity-theme-patch):

- **Pixel-Matched `Claude.app` Visuals (`user/custom.css`)**: Pure `#FFFFFF` light canvas & `#212120` warm charcoal dark palette, unified `14px` sans-serif typography (`Anthropic Sans` + `PingFang SC` / `Microsoft YaHei UI`), borderless user bubbles, neutral inline code, and a clean single-layer composer.
- **Unlocked Interleaved Step Stream (`install.mjs` + `user/custom.js`)**: Automatically switches Antigravity out of `PRODUCT_SKIN_NON_TECHNICAL` (`ephemeralToolCalls: true`) into `PRODUCT_SKIN_DEVELOPER` + `verboseConversationSteps: true`, unwraps the end-of-turn `Worked for Xm` outer accordion, and adds smooth `190ms` collapse animations.
- **In-Place Live `TodoWrite` Checklist & Elapsed Timer (`user/custom.js`)**: Non-invasively mounts a reactive Claude-style checklist card (dashed circle `pending`, spinning arc `in_progress`, check `completed`) that merges same-turn `- [ ]` / `- [/]` / `- [x]` updates in-place without chat spam, paired with orbiting terracotta dots and a live `1s / 2s...` timer on active tool rows (`0%` idle CPU).

---

## 🙏 致谢与许可 (Credits & License)

- 底层 CDP 守护与汉化指标内核由 [@Anarcadia](https://github.com/Anarcadia) 的 [`chuanban-antigravity-theme-patch`](https://github.com/Anarcadia/chuanban-antigravity-theme-patch) 提供（本仓库不分发其内核文件，安装时按需引用上游）。
- 部分色彩语义与排查思路参考了 [@AlexByoung](https://github.com/AlexByoung) 的 [`Claudized-Antigravity`](https://github.com/AlexByoung/Claudized-Antigravity)。
- 本仓库内的全部扩展脚本、样式、安装器与规则文档采用 [MIT License](LICENSE) 开源。
