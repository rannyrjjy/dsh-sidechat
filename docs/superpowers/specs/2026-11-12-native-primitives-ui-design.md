# 侧栏对话 UI 对齐原生 —— 路线 A：复用官方 primitives + 分层兜底

日期：2026-11-12 · 状态：待批准

## 意图与动机

`dsh-sidechat` 面板当前是自绘 UI：助手输出按裸文本 `pre-wrap` 展示（markdown 源码直接可见，无代码块、表格、列表渲染），外壳样式与原生 DSH 脱节。用户反馈两点：**UI 与原生不一致**、**Agent 输出渲染一塌糊涂**。

## 目标 / 非目标 / 反目标

- **目标**
  1. 助手输出用原生聊天的同一渲染组件（`MarkdownText`）渲染：代码块（带复制/换行工具条）、表格、列表、行内代码、流式感知；
  2. 面板外壳（按钮、折叠、思考指示、字号排版）改用原生 primitives 与主题 token，深浅色、主题字号缩放自动跟随；
  3. primitives 不可用或行为异常时**分层兜底**，内容永不丢失、面板永不白屏。
- **非目标**：不改发送/绑定/上下文逻辑（`send`、`buildDigest`、绑定表全部不动）；不做附件缩略图；不重写 composer 为原生 lexical 输入器（太重，仅对齐样式）。
- **反目标**：面板出现空白屏或丢消息；引入构建步骤或第三方依赖；把 fallback 做成静默吞错（fallback 时必须 console.warn 一条，方便诊断）。

## 约束

- 零构建、零依赖、手写 ModuleLoader bundle（`window.__ModuleLoader__.load`）不变；
- `test/smoke.mjs`（58 项断言）必须继续通过并覆盖新增路径；
- 生效方式：改 `lib/client.js` 后重启宿主（`link:` 安装）；
- primitives 属应用内注册表模块，非公开插件 API —— 这是路线 A 的核心代价，兜底即为对此的回应。

## 方案取舍（已选 A）

| 路线 | 做法 | 结果 |
| --- | --- | --- |
| **A（选定）** | `require('@deepseek-ai/dsh-client-ui-primitives')` 复用官方原语 | 渲染即原生；代价是依赖内部 API，靠分层兜底控制风险 |
| B（否决） | 自写轻量 markdown 渲染器 + 手工仿原生样式 | 完全可控但工作量大、永远差一点原味，代码块工具条/表格/流式全要自己造 |

选 A 的依据：primitives 与 `react` 同在 boot 的 `staticModules` 注册表（已核实主 bundle 源码），是加载器的公开机制；官方各包（message-quotes、cot-translation 等）同样以 `require` 该模块的方式复用。

## 兜底设计（核心）

**已核实的接口事实**（2026-11-12，本机 DSH 安装，包版本 0.2.2-rc.1）：

- `MarkdownText({ text, streaming=false, labels, fileMentions, pathImages, variant="body", omitHtml, textInteractionSource })`
- `Button({ variant="ghost", size="md", icon, className, ...buttonProps })`（forwardRef）
- `DisclosureRow({ icon, title, open, expandable, onToggle, running, collapsedContent, children, ... })`
- `TextShimmer({ children, active=false, className, contentClassName })`
- `labels` 形状：`{ code: { copyLabel, copiedLabel, toolbarLabels: { codeLabel, wrapLabel, unwrapLabel } }, footnotes }`（chat 包由其 locale 构造；我们自产）

**四层兜底**：

1. **获取层**：模块初始化时 `try { require('@deepseek-ai/dsh-client-ui-primitives') } catch`，并逐一校验所需导出 `typeof === 'function'`。**按 key 独立判空**（markdown / button / disclosure / shimmer 各自独立），缺一个不至于全灭。结果缓存到模块级 `P` 对象，缺失即 `null`。每次 acquire 失败 `console.warn('[dsh-sidechat] primitives 不可用，回退纯文本渲染')`。
2. **渲染层**：每条助手消息的 markdown 块外包一个**极小 React 错误边界**（class 组件，React 18 仍支持）。`componentDidCatch` 后本条消息降级为纯文本渲染并 `console.warn`，其余消息不受影响 —— 挡住「props 变了导致渲染中崩溃」这类行为漂移，不只是模块缺失。
3. **内容层**：降级路径就是现版渲染器（pre-wrap 文本 + 工具一行提示），已实测稳定 —— 降级只损失排版，不损失内容。
4. **兼容声明层**：`package.json` 的 `dsh.compatibility.dshReleases` 补上实际运行版本 `0.2.2-rc.1`；README「兼容性」一节同步改写（明确写出依赖 primitives 的四个导出与兜底行为）。

## 已定的实现映射

| 面板部位 | 现在 | 改为 |
| --- | --- | --- |
| 助手正文 | 裸文本 pre-wrap | `MarkdownText`（`streaming` 跟随流式行；`labels` 自产） |
| 推理过程 | 「思考中… · 已思考 N 字」 | `DisclosureRow`（标题含字数，展开显示推理原文）+ 进行中 `TextShimmer` |
| 思考中占位 | 斜体文本 | `TextShimmer`（缺导出则回退现文本） |
| 停止 / 新对话 / 发送 | 自绘 `.sc-btn` | `Button`（variant/size 对齐原生；缺导出回退 `.sc-btn`） |
| 工具调用 | 一行截断 `⚙ 名字` | `DisclosureRow` 折叠行（默认收起，标题=工具名），展开留空内容（本轮不做参数展示，非目标） |
| 用户消息 | 左对齐浅色气泡 | 右对齐气泡，样式对齐原生参数（`max-width: min(calc(var(--dsh-chat-content-width,748px)*.702), 82%)`） |
| 全局字号 | 写死 13px | `var(--dsh-content-font-size,14px)` / 行高 `calc(24px + var(--dsh-content-font-delta,0px))`，次级文字用 `-secondary` 变体 |
| labels 文案 | 无 | 优先 `ctx.locale`（chat 命名空间的 copy/copied 等，实现时确认键名可达性），不可达则按当前 locale 硬编码中英文 |
| 滚动 | 贴底 80px 内跟随 | 保持，另加「回到底部」悬浮按钮（离开底部且流式进行中时显示） |

`buildRows()` 的折叠/顶替逻辑保持不变，只改**渲染**层：行数据新增 `reasoningText`（推理块原文，现在只累计字数后丢弃）以供折叠展开。

## 交给实现者（builder）定夺

- locale 键名可达性（`ctx.locale.bind('chat')` 是否拿得到 copy/copied）；不可达时的硬编码字典；
- 错误边界的粒度（每条消息 vs 每个块）—— 倾向每条消息；
- `DisclosureRow` 展开动画/细节的微调；
- 烟测断言的具体拆分（建议：primitives 缺失 → 纯文本路径；存在 → markdown 路径；labels 形状校验；错误边界触发降级）。
