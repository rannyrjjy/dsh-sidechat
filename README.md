# dsh-sidechat · 旁侧对话

给 **DSH** 加一个**能对话的全局侧边栏**。模仿 Codex 的 `/side`：在输入框敲 `/side`，右侧就多一个独立的对话面板，跟你主对话互不打扰、同时可见。

对话跑在**真实的 DSH 会话**上 —— 不是另接一个 HTTP 客户端，所以侧栏里同样有工具、工作区、权限预设和模型配置，跟主对话一个待遇。

## 它解决什么问题

干正事的时候总会突然冒出题外话：这个报错是什么意思、那行命令的参数到底是啥、刚才那个结论边界在哪。这些不值得占据主线上下文，也不该打断正在跑的主任务。

旁侧对话就是给这类提问准备的：

- **知道你在干什么** —— 每次提问，它会自动把主会话最近的进展打包带上，所以「刚才那个」它有上下文，不用你复述；
- **不污染主线** —— 那段背景只发给旁侧会话，主会话一个字都不加，主线上下文原封不动；
- **立刻能问** —— 主任务在跑也不影响，旁侧是独立会话，各跑各的；
- **强绑当前会话** —— 切到别的会话，旁侧对话跟着换成那个会话的；切回来，原来那套又回来了。

## 安装

```bash
# 1. 拿源码
git clone https://github.com/rannyrjjy/dsh-sidechat.git

# 2. 装进你的 DSH profile（<profile> 换成你自己的，见下）
dsh plugin --profile <profile> add link:/absolute/path/to/dsh-sidechat

# 3. 重启 DSH
```

`<profile>` 是你自己 DSH 的 profile 名。找法：看 `~/.dsh/profiles/` 下面有哪几个目录
（Windows 是 `%USERPROFILE%\.dsh\profiles\`）。常见的：

- `desktop` —— 桌面端 App（`dsh` 桌面版默认）
- `web` —— 用 `dsh web` 起的网页版

不确定就两个都看一眼，装上你平时用的那个。

不想 clone 源码的话，从 [Releases](https://github.com/rannyrjjy/dsh-sidechat/releases) 下载
`dsh-sidechat-<version>.tgz`，然后：

```bash
dsh plugin --profile <profile> add file:/absolute/path/to/dsh-sidechat-0.1.0.tgz
```

装完**必须重启 DSH**：浏览器侧 bundle 在宿主启动时组装，页面刷新不够。

卸载：

```bash
dsh plugin --profile <profile> remove dsh-sidechat
```

装不上、找不到 `dsh` 命令、想手工装 —— 见 [INSTALL.md](./INSTALL.md)。

## 强绑定：面板跟着会话走

一句实话：侧栏不是「一个全局聊天框」，而是**每个主会话各有自己的一条旁侧对话**。

```
主会话 A ──► 旁侧会话 A'   （绑定表：{ A: {sideId: A', seq: 21} } ）
主会话 B ──► 旁侧会话 B'
```

- 切到 B：面板立刻显示 B'（还没聊过就显示「将围绕这个会话新建」），A 的话不会串过来；
- 切回 A：A' 原样还在，接着问；
- 在 A 里点「新对话」：只解绑 A，B 的旁侧对话不受影响。

绑定关系存在 `localStorage` 的 `dsh-sidechat:bindings:v2` 里，重启浏览器也还在。

右侧栏本来就是按会话停靠的，所以切走会话时那个停靠面自然就没了 —— 这跟绑定是同一件事的两面。

## 上下文怎么带过去（且不污染主线）

每次发送时：

1. 借主会话读一次转录快照；
2. 只挑**上次之后的新增内容**（水位线记在绑定表的 `seq` 里），拼成一段带标记的背景；
3. 把「背景 + 你的问题」一起发到旁侧会话；
4. 主会话**完全不参与** —— 它不收到任何消息，转录不变。

三层截断保证不会撑爆旁侧上下文：最多 24 条消息、单条 900 字、总量 8000 字。聊到第十轮也只带最后一轮的变化。

背景块在旁侧转录里会被剥掉（`<!-- dsh-sidechat:main-context -->` 标记），所以你看到的只有自己打的那句话。

## 三个入口，一个面板

| 入口 | 位置 | 说明 |
| --- | --- | --- |
| `/side` | 任意会话的输入框 | 敲 `/side` 回车，右侧栏打开「旁侧对话」tab（不产生模型消息）；若当前没有会话，则打开主面板 |
| 左侧栏「旁侧对话」 | 全局左侧导航 | 没有会话也能点，主区打开同一个面板 |
| 右侧栏 tab | 会话右侧停靠区 | 开着就跟主对话并排显示 |

三者是同一个面板、同一个旁侧会话，随意切换。

## 用法

1. 在主区打开一个会话（面板必须知道你在哪个会话里，所以没有会话时只会给提示）。
2. 在面板底部说第一句话 —— 自动为这个主会话新建一条旁侧对话。
3. 顶部按钮：
   - **停止** —— 中断当前这轮；
   - **新对话** —— 只丢掉当前会话这一条绑定，下次说话时新建。
4. 头部那行小字就是绑定关系：`主会话尾号 · 旁侧会话尾号`。

## 它显示什么

只渲染 `user/message`、`assistant/message` 和**流式块**，外加工具调用的轻提示。

回答是边生成边显示的：模型一开口就出字，推理阶段显示「思考中… · 已思考 N 字」。
不是等整段说完才一次性贴出来。

**刻意不显示**：DSH 注入的运行时上下文、技能清单、system-reminder 这类以 user 角色落盘的背景消息。判定标准跟官方 `dsh-session-title` 一致 —— 只认 `message.source.kind === 'user'` 的消息，所以侧栏里看到的就是你自己说的话。

## 它为什么快 / 什么时候会慢

实测（DSH 0.2.1-rc.5，DeepSeek-V4.1-Flash）：

| 阶段 | 耗时 |
| --- | --- |
| 读主会话上下文 | ~4 ms |
| 新建旁侧会话（仅第一问） | ~45 ms |
| 打开会话 | ~7 ms |
| 提交 prompt | ~35 ms |
| **模型吐出第一个字** | **~300 ms** |
| 整段回答说完 | 1～8 s（取决于长度） |

插件自身开销在 **100 ms 以内**，不是瓶颈。感觉慢通常来自这三件事：

1. **推理等级**。旁侧会话跟主对话用同一套模型设置。等级为 High 时，简单问题也要先
   生成几百到上千字的思考过程才开口 —— 这段现在会显示成「已思考 N 字」，不再是死的。
2. **新会话没有缓存**。第一问是冷缓存，15K 系统提示词要重新 prefill；同一旁侧会话
   里的后续提问会命中缓存，快很多。
3. **模型通道排队**。主对话正在跑时两边共享同一个通道，偶尔要等一下。

想自己看每一步耗时：

```js
localStorage.setItem('dsh-sidechat:debug', '1')   // 重载页面生效
window.__sidechatTimings                          // 最近 200 条标记
```

## 实现要点

零依赖、零构建 —— **手写 ModuleLoader bundle**，宿主直接吃 `lib/client.js`：

```
lib/index.js     Host 半侧（空实现，只为让 loader 能挂上这条 bundle）
lib/client.js    浏览器半侧（全部逻辑，window.__ModuleLoader__.load）
cordis.patch.yml bundle 补丁层
```

客户端用的是这几套公开面：

- `ctx.slots` —— 左侧栏 `sidebar.panellist` 入口、主区 `main` 面板、右侧栏 `sidebar.right.pane.tab` 正文；
- `ctx.sidebarRightTabs.register()` + `ctx.sidebarRight.openTab()` —— 注册并打开 dock tab；
- `ctx.commandUi.register()` —— 把 `/side` 变成一个**客户端 action 命令**（只吃裸 token，不落模型消息）；
- `ctx.uiSession.adapter.current` —— 当前主会话绑定（binding source，有 `getSnapshot`/`subscribe`，正好喂给 `useSyncExternalStore`）。**强绑定的锚点**；
- `ctx.sessions` —— `create()` 建会话、`retain()` 借引用（顺带拉历史）、`binding.session.prompt()` 发消息、`eventSource` 订阅转录。

会话引用是**计数借用**语义：每次 `retain` 都必须配对 `release`，否则会话作用域一直挂着。所以读主会话上下文那段也是借完立刻还。

### 流式渲染为什么要单独写

DSH 的回答分两步落盘：

1. 生成期间，宿主连续往 `eventSource` 追加 `assistant/live-chunk`，`chunk.type` 是
   `reasoning-delta` / `text-delta` / `block-start` / `block-end` …，按 `chunk.index` 分块；
2. 整段说完了，才追加一条 durable 的 `assistant/message`。

只渲染第 2 步的话，整个生成期间面板是空白的，最后「啪」一下全出来 —— 观感上就是
「侧栏很慢」，而实际上第一个字 300ms 就到了。所以 `buildRows()` 会把 live-chunk 折叠成
一朵按 `turn/step` 分行的、正在生长的助手行；durable 消息到达时同 key 顶掉，既不重复
也不闪烁。`reasoning-delta` 不显示原文（太吵），只累加字数当作进度。

## 已知边界

- `/side` 只识别**裸命令**。写成 `/side 你好` 会被 DSH 的输入机当作普通文本发给当前会话（官方 `commandUi` action 的固有行为，任何客户端命令都一样）。`/side` 打开面板后输入框会自动聚焦，接着说就行。
- 侧栏转录是**轻量视图**：工具调用只显示一行名字（不展开参数和结果），不带图片/附件缩略图，不做 markdown 富渲染。
- 旁侧会话跟主对话共享同一个工作区和权限预设（它就是普通 DSH 会话）。
- 上下文是**发送那一刻**的快照。主会话在你提问之后又跑了几步，要等下一问才会带上（这是刻意的：旁侧是问答，不是实时镜像）。
- 绑定表存在 `localStorage`。换了 profile 或删掉某个会话，那条绑定会失效，面板提示「已不存在」并自动重建，不会卡死。
- 面板必须有主会话才能提问 —— 它没有「脱离会话的全局聊天」模式，这是强绑定的必然代价。

## 开发

改 `lib/client.js` 后重启宿主即可生效（`link:` 安装的情况下）；改 `package.json` / `cordis.patch.yml` 必须重启。

自检（纯 Node，不需要 DSH 运行时，Node >= 20）：

```bash
node test/smoke.mjs   # 58 项断言
# 或
npm test
```

覆盖：bundle 加载 → 四类注册 → `/side` 两条分支 → 面板渲染 → **上下文带入且主线零写入** → **增量只发新增内容** → **切换主会话旁侧跟着换** → **切回恢复原会话** → 无主会话时禁用 → 「新对话」只解绑当前 → 陈旧绑定自愈 → **流式增量显示、推理进度、落定去重、工具提示**。

## 兼容性

在 DSH `0.2.1-rc.5` 上开发并验证。用到的是 `ctx.slots` / `ctx.sidebarRightTabs` /
`ctx.commandUi` / `ctx.uiSession` / `ctx.sessions` 这几个客户端服务，DSH 客户端插件 API
还在快速演化，跨大版本升级时留意一下。

## License

MIT
