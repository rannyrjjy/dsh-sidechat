# 侧栏对话原生渲染改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** sidechat 面板的助手输出与外壳改用 DSH 原生 primitives（`MarkdownText`/`Button`/`DisclosureRow`/`TextShimmer`），不可用时四层兜底退回现版纯文本渲染，内容永不丢失。

**Architecture:** 仍是零构建手写 ModuleLoader bundle，只改 `lib/client.js` 渲染层。模块初始化时按 key 独立获取 primitives（`require('@deepseek-ai/dsh-client-ui-primitives')` + 逐导出 `typeof` 校验），渲染时按可用性选择原生组件或现版回退实现；每条助手消息包一个极小 class 错误边界，单条渲染崩溃只降级那一条。`send`/绑定/上下文逻辑零改动。

**Tech Stack:** 浏览器原生 JS（ES5 风格 + class/async），React 18（`h = createElement`），自写 Node 烟测 harness（React shim）。

**Spec:** `docs/superpowers/specs/2026-11-12-native-primitives-ui-design.md`（同仓库，先读它；接口事实以它为准）。

## Global Constraints

- 零构建、零依赖：不得引入 npm 依赖或打包步骤；仍走 `window.__ModuleLoader__.load`。
- 只改渲染层：`send`、`buildDigest`、绑定表（`readBindings`/`patchBinding`/`dropBinding`）、`captureMainContext`、`watchFirstAnswer` 逻辑不动。
- 现有 58 项烟测断言必须继续全部通过（个别文案断言若被新 UI 保留同文案则不改测试）。
- fallback 时必须 `console.warn`（带 `[dsh-sidechat]` 前缀），不许静默。
- primitives 四个 key **独立**判空：缺一个只回退那一个部位。
- 生效方式为宿主重启（`link:` 安装）；代码里不做任何热重载处理。
- CSS 全部走主题 token：字号 `var(--dsh-content-font-size,14px)`、行高 `calc(24px + var(--dsh-content-font-delta,0px))`、次级 `--dsh-content-font-size-secondary,13px` / `--dsh-content-font-delta-secondary,0px`、圆角 `var(--dsw-radius-sm)`、背景/边框/文字沿用现有 `--dsw-alias-*` 系列。
- 用户气泡对齐原生：`max-width: min(calc(var(--dsh-chat-content-width,748px) * .702), 82%)`、右对齐。

## Review Focus

1. primitives 模块在但**缺单个导出**（如 `TextShimmer` 被改名）→ 只缺的部位回退，其余照常 → 测试见 Task 2 Step 1（env B2 变体）。
2. `MarkdownText` 渲染中途抛错（props 漂移）→ 仅该条消息降级纯文本，其余消息与面板不受影响 → 测试见 Task 2 Step 1（boundary 单元检查 + 现有 58 项回归）。
3. 流式行必须保留 `sc-streaming` 类（光标断言与样式依赖），两个环境都成立 → 测试见 Task 3/4 回归步骤。
4. 纯推理阶段（只有 reasoning-delta）不可白屏，「思考中」与「已思考 N 字」必须可见 → 测试见 Task 3 Step 1。
5. primitives 缺失时工具调用仍显示工具名（回退 chip）→ 测试见 Task 3 回归步骤。

---

### Task 1: 测试 harness 双环境化 + React shim 类组件支持

**Files:**
- Modify: `test/smoke.mjs`

**Interfaces:**
- Consumes: 现有 harness（`mount`/`evaluate`/`makeSession`/`say`/`pushChunk`/`check`）。
- Produces:
  - `makeRequire({ primitives })` → factory 用的 require：`'react'` 返回 ReactShim；`'@deepseek-ai/dsh-client-ui-primitives'` 当 `primitives === true` 返回**整表**透明 stub，当 `primitives` 为对象时只返回该对象里给出的 key（**部分表**，供「缺单导出」变体用），为 false/缺省时**抛错**；其它 id 一律抛 `unexpected require`。
  - `PRIM_STUBS`：透明 stub 组件表 `{ MarkdownText, Button, DisclosureRow, TextShimmer }` —— `MarkdownText` 渲染 `props.text`；`Button` 渲染 `h('button', rest, icon?[icon,children]:children)`；`DisclosureRow` 渲染 `[props.title, props.children, props.collapsedContent]`；`TextShimmer` 渲染 `props.children`。透明是硬要求：现有断言按元素树找 `el.type === 'button'`、按全文匹配文案，stub 必须不改变这些结构。
  - `ReactShim.Component`：class 基类，`prototype.isReactComponent = {}`；`evaluate()` 遇到 `type.prototype && type.prototype.isReactComponent` 时 `new type(props)` 并求值 `inst.render()`。
  - env B 构建：与 env A 相同的假 window/document/localStorage/registrations/ctx，但 factory 用抛错 require。现有单例初始化段（`globalThis.window` 等）与 ctx 构造（现 182-374 行）抽成 `makeEnv({ primitives })`，返回 `{ window, styleEls, ctx, registrations, PanelBody, mainA, mainB, sessions, setCurrentSession, say, makeSession, createdCountRef, goneSessions }`；现有 58 项检查改跑在 env A 上，逻辑与文案断言一字不改。
  - `console.warn` 间谍：env 内可替换 `console.warn` 收集调用（Task 2 用）。

- [ ] **Step 1: 写 shim 类组件支持与 makeEnv 的失败测试**

在文件顶部 harness 区新增检查（临时放主流程最后）：

```js
// shim 支持 class 组件（ReactShim.Component + evaluate 分支）
class Probe extends ReactShim.Component { render() { return ReactShim.createElement('div', null, 'probe-ok') } }
const probeTree = evaluate(ReactShim.createElement(Probe, null), 'probe')
check('shim 支持 class 组件', textOf(probeTree).join('') === 'probe-ok')
```

Run: `node test/smoke.mjs`
Expected: FAIL（`ReactShim.Component` 为 undefined，构造抛错或 evaluate 走函数分支报错）。

- [ ] **Step 2: 实现 shim 支持**

`ReactShim` 加 `Component` 基类（构造器存 `props`，`setState(patch)` 合并 `this.state` 并 `queueRerender()`）；`evaluate()` 在 `typeof type === 'function'` 分支先判 `type.prototype && type.prototype.isReactComponent`，为真则 `const inst = new type(props); return evaluate(inst.render(), instKey)`。

- [ ] **Step 3: 重构出 makeEnv / makeRequire，双环境接入**

按 Interfaces 所列抽取；现有 58 项检查全部移入 env A 执行（断言文案不改）；env B 构建后先只跑一条健全性检查：`mod.apply` 注册了 tab（证明 env B 可用）。`PRIM_STUBS` 就位但 client.js 尚未 require（本任务不改 bundle），env A 行为应与改造前完全一致。

- [ ] **Step 4: 全量跑测试确认零回归**

Run: `node test/smoke.mjs`
Expected: 全部 PASS（58 项 + 新增 2 项健全性）。

- [ ] **Step 5: Commit**

```bash
git add test/smoke.mjs
git commit -m "test: harness 双环境化（primitives 可注入）并支持 class 组件"
```

### Task 2: primitives 获取层 + MarkdownText 接入 + 错误边界

**Files:**
- Modify: `lib/client.js`
- Test: `test/smoke.mjs`

**Interfaces:**
- Consumes: Task 1 的 `makeRequire`/`PRIM_STUBS`/env B。
- Produces（client.js 内，Task 3/4 复用）:
  - `PRIMITIVES = { markdown: Component|null, button: Component|null, disclosure: Component|null, shimmer: Component|null }` —— factory 顶部初始化：`try { var mod = require('@deepseek-ai/dsh-client-ui-primitives') } catch` 后逐 key `typeof mod.X === 'function'`；任一缺失在**一条** warn 里列出缺失名单：`console.warn('[dsh-sidechat] primitives 不可用(MarkdownText/…)，相应部位回退纯文本渲染')`；全可用时不 warn。
  - `markdownLabels()` → 形状固定 `{ code: { copyLabel, copiedLabel, toolbarLabels: { codeLabel, wrapLabel, unwrapLabel } }, footnotes }`；中文 `复制/已复制/代码/换行/不换行/脚注`，英文 `Copy/Copied/Code/Wrap/Unwrap/Footnotes`；按 `(typeof navigator !== 'undefined' && navigator.language || '')` 的 `^zh` 选择；模块级计算一次。
  - `MarkdownBoundary`：`class extends react.Component`；constructor `this.state = { failed: false }`；`static getDerivedStateFromError() { return { failed: true } }`；`componentDidCatch(error) { console.warn('[dsh-sidechat] markdown 渲染失败，本条降级纯文本:', error) }`；`render() { return this.state.failed ? this.props.fallback : this.props.children }`。
  - 助手行渲染约定（Transcript 内）：`PRIMITIVES.markdown` 存在时渲染
    `h(MarkdownBoundary, { key, fallback: 旧纯文本行 }, h(PRIMITIVES.markdown, { text: row.text, streaming: row.streaming === true, labels: markdownLabels() }))`，
    外层 wrapper 仍为 `className: 'sc-row sc-assistant' + (streaming ? ' sc-streaming' : '')`；不存在时维持现版 `sc-text` 纯文本行（逐字节为现实现）。

- [ ] **Step 1: 写失败测试（env A 用 stub、env B 回退、单导出缺失变体、boundary 单元）**

新增检查（env A，env B 各一段）：

```js
// env A：durable 助手行走 stub MarkdownText，props 带 text/streaming/labels
const mdEl = findElement(panelA.tree, (el) => el.type === PRIM_STUBS.MarkdownText)
check('助手输出走原生 MarkdownText', !!mdEl && mdEl.props.text.includes('收到：'))
check('MarkdownText 收到 labels 文案', !!mdEl && mdEl.props.labels.code.copyLabel === '复制' && mdEl.props.labels.code.toolbarLabels.wrapLabel === '换行')
// env A2（缺单导出）：makeRequire({ primitives: { markdown, button, disclosure } }) → shimmer 缺 → 仅一条 warn 且含 TextShimmer
// env B：require 抛错 → 整树无 PRIM_STUBS.* 元素，助手文本仍出现在 .sc-text；console.warn 被调用且含 'primitives 不可用'
// boundary：new MarkdownBoundary({ fallback: 'FB', children: 'OK' }) render() === 'OK'；state.failed = true 后 render() === 'FB'
```

Run: `node test/smoke.mjs`
Expected: 新增 FAIL（client.js 尚无 primitives 逻辑，env A 找不到 stub 元素）。

- [ ] **Step 2: 实现 PRIMITIVES / markdownLabels / MarkdownBoundary / 助手行分流**

按 Interfaces 实现。注意 warn 只在 factory 初始化时发一次（env A2 变体在 shim 场景下按「整表全有」注入即可覆盖；单导出缺失由 `typeof` 校验逻辑保证，测试用 A2 的缺 shimmer 表驱动）。

- [ ] **Step 3: 全量跑测试**

Run: `node test/smoke.mjs`
Expected: 全部 PASS（含 58 项回归 —— env A 透明 stub 保证现有文案断言不受影响）。

- [ ] **Step 4: Commit**

```bash
git add lib/client.js test/smoke.mjs
git commit -m "feat: 接入原生 MarkdownText 渲染助手输出，附获取层兜底与错误边界"
```

### Task 3: 推理折叠（DisclosureRow + TextShimmer）与 reasoningText

**Files:**
- Modify: `lib/client.js`
- Test: `test/smoke.mjs`

**Interfaces:**
- Consumes: Task 2 的 `PRIMITIVES`/`markdownLabels` 不再直接用；`PRIM_STUBS.DisclosureRow/TextShimmer`。
- Produces:
  - `buildRows` 行对象新增字段 `reasoningText?: string`：live 槽从 `reasoning-delta` 累积原文（保留现有 `reasoning` 字数计数）；durable `assistant/message` 从 `message.content` 中 `type === 'reasoning'` 且 `typeof block.text === 'string'` 的块拼接。
  - `ReasoningDisclosure({ label, text, running })`：内部 `useState` 开合；`PRIMITIVES.disclosure` 存在时渲染 `h(disclosure, { expandable: true, open, onToggle, title: label, running }, h('div', { className: 'sc-reasoning' }, text))`（`text` 为空则 children 传 null）；缺失时渲染现版样式的一行 `label`（`.sc-typing`）。`label` 规则：`running && 正文为空` → `'思考中… · 已思考 N 字'`（shimmer 包裹）；否则 → `'已思考 N 字'`。shimmer 可用时 running 态用 `h(PRIMITIVES.shimmer, { active: true }, label)`，不可用直接文本。
  - 流式行渲染顺序：先 `ReasoningDisclosure`（有 reasoningText 或 running 推理计数 > 0 时），后 markdown/纯文本正文；无正文且无推理时维持现版「思考中…」占位逻辑。
  - 工具行改造：`PRIMITIVES.disclosure` 存在时渲染 `h(disclosure, { expandable: false, title: toolLabel(data) })`（原生样式的行，**无 chevron** —— 设计文档写的「展开留空内容」没有可看的东西，这里按更合理的无展开实现，属对设计的小修正）；缺失时维持现版 `.sc-tool` 一行 chip（`⚙ 名字`）。

- [ ] **Step 1: 写失败测试**

```js
// env A：只有 reasoning-delta（沿用现测 pushChunk(sideStream,1,1,{type:'reasoning-delta',...})）
//   → 出现 DisclosureRow stub，title 匹配 /已思考 \d+ 字/ 且含 '思考中'；展开后 children 含推理原文片段
// env A：reasoning + text-delta 同槽 → DisclosureRow 与正文都在，且正文不再重复进 title
// env A：durable assistant/message 带 {type:'reasoning',text:'想想…'} 块 → 落定行仍可展开看到 '想想…'
// env B：同样只有 reasoning-delta → 纯文本 '思考中' + /已思考 \d+ 字/（现断言原样保留，此时跑在 env B 副本上）
// env A：tool/call → DisclosureRow stub 且 expandable === false、title 含工具名
// env B：tool/call → .sc-tool chip 仍显示工具名（Review Focus #5）
```

Run: `node test/smoke.mjs`
Expected: 新增 FAIL（reasoningText 尚未累积，无 DisclosureRow）。

- [ ] **Step 2: 实现 buildRows 累积 + ReasoningDisclosure + 流式行重排**

现有「推理阶段显示已思考字数而不是空白」断言所在段迁到 env B（文案不变）；env A 换用上述新断言。

- [ ] **Step 3: 全量跑测试**

Run: `node test/smoke.mjs`
Expected: 全部 PASS，重点回归：`落定后不重复显示`、`落定后不再有流式光标`、`流式中的行带光标标记`（wrapper 仍带 `sc-streaming`）、`工具调用给出进展提示`。

- [ ] **Step 4: Commit**

```bash
git add lib/client.js test/smoke.mjs
git commit -m "feat: 推理过程可折叠展示，流式思考用原生 shimmer"
```

### Task 4: 原生 Button、CSS token 化、回到底部按钮

**Files:**
- Modify: `lib/client.js`
- Test: `test/smoke.mjs`

**Interfaces:**
- Consumes: Task 2 的 `PRIMITIVES.button`。
- Produces:
  - `ScButton({ children, ...rest })`：`PRIMITIVES.button` 存在 → `h(button, rest, children)`；缺失 → `h('button', { ...rest, className: 'sc-btn' }, children)`。替换三处：发送、停止、新对话。props（disabled/onClick/type）不变，子文案不变（`发送/…/停止/新对话`）。
  - `Transcript` 增加 `pinnedBottom` state（默认 true）+ `onScroll`（gap < 80 视为贴底）+ rows 更新 effect 里贴底时自动滚动（保留现 gap<80 逻辑）；`!pinnedBottom` 时渲染 `ScButton({ className: 'sc-jump', onClick: 回底并置 pinnedBottom }, '回到底部')` 悬浮于 `.sc-body` 容器（body 外包一层 `position:relative`）。
  - CSS 重写（同一 `CSS` 字符串，id 仍 `dsh-sidechat-css`）：根字号/行高换主题变量；删除 `.sc-who` 行（原生靠布局区分角色）与用户行左对齐；用户气泡改 `align-self:flex-end` + 原生 max-width 公式；caret 样式收窄到 `.sc-streaming .sc-text::after`（仅回退路径有 `.sc-text`）；新增 `.sc-reasoning`（次级字号 token、`white-space:pre-wrap`、左侧 2px 边框用 `--dsw-alias-border-l2`）、`.sc-jump`（绝对定位底部居中、`--dsw-radius-sm`、背景 `--dsw-alias-bg-layer-3`）。

- [ ] **Step 1: 写失败测试**

```js
// env A：发送/停止/新对话仍是 el.type==='button' 且文案不变（现有 findSendButton/findButtonByText 全绿）
// 两环境：默认渲染无「回到底部」按钮；ReasoningDisclosure 展开后 .sc-reasoning 元素存在
// env A：durable 助手行 wrapper className 含 'sc-row sc-assistant'，无 'sc-who' 元素
// env B：.sc-text 与光标类行为不变（现断言原样）
```

Run: `node test/smoke.mjs`
Expected: 新增 FAIL（sc-who 仍在、sc-jump 未实现）。

- [ ] **Step 2: 实现 ScButton / pinnedBottom / CSS 重写**

- [ ] **Step 3: 全量跑测试**

Run: `node test/smoke.mjs`
Expected: 全部 PASS。

- [ ] **Step 4: Commit**

```bash
git add lib/client.js test/smoke.mjs
git commit -m "feat: 按钮与排版对齐原生 token，新增回到底部"
```

### Task 5: 兼容声明、版本号与 README

**Files:**
- Modify: `package.json`, `README.md`
- Test: `test/smoke.mjs`

**Interfaces:**
- Produces: `package.json` → `version: "0.2.0"`；`dsh.compatibility.dshReleases` 增加 `"0.2.2-rc.1": "compatible"`（保留 `0.2.1-rc.5` 行）。

- [ ] **Step 1: 写失败测试**

```js
import { readFileSync } from 'node:fs' // 文件顶部已有 fs
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
check('版本升到 0.2.0', pkg.version === '0.2.0')
check('声明 0.2.2-rc.1 兼容', pkg.dsh && pkg.dsh.compatibility && pkg.dsh.compatibility.dshReleases && pkg.dsh.compatibility.dshReleases['0.2.2-rc.1'] === 'compatible')
check('保留 0.2.1-rc.5 兼容', pkg.dsh.compatibility.dshReleases['0.2.1-rc.5'] === 'compatible')
```

Run: `node test/smoke.mjs`
Expected: 新增 FAIL。

- [ ] **Step 2: 改 package.json + README**

README 改四处：「它显示什么」（markdown/代码块工具条/表格、推理可折叠、原生组件渲染）；「实现要点」客户端公开面清单加一行 `require('@deepseek-ai/dsh-client-ui-primitives')` 及四导出；「已知边界」删「不做 markdown 富渲染」改为「markdown 渲染依赖原生 primitives，缺失时自动回退纯文本（console.warn 可见）」；「兼容性」写明依赖的四个导出与 0.2.2-rc.1 验证。

- [ ] **Step 3: 全量跑测试**

Run: `node test/smoke.mjs`
Expected: 全部 PASS。

- [ ] **Step 4: Commit**

```bash
git add package.json README.md test/smoke.mjs
git commit -m "chore: 0.2.0 兼容声明与 README 同步"
```

### Task 6: 宿主重启 + 实机验证（需要用户重启 DSH 桌面端）

**Files:** 无代码改动。

- [ ] **Step 1: 请用户重启 DSH 桌面端**（宿主启动时才组装浏览器 bundle，页面刷新不够）。
- [ ] **Step 2: 用浏览器工具打开 GUI（http://127.0.0.1:54842），`/side` 打开面板，检查**：助手回答 markdown 渲染（代码块带复制按钮）、推理折叠可展开、思考中 shimmer、按钮为原生样式、无 console 中 `[dsh-sidechat] primitives 不可用` warn（出现即说明获取层失败，记录并回退排查）。
- [ ] **Step 3: 深浅色、主题字号缩放各看一眼；切会话验证绑定不回归。**
- [ ] **Step 4: 向用户报告验证结果与截图。**
