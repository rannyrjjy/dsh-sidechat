/**
 * dsh-sidechat — 浏览器半侧（手写 ModuleLoader bundle，无需构建）
 * ----------------------------------------------------------------------------
 * 三件事：
 *   1) 右侧栏 tab 类型 `side-chat`：一列能和 AI 对话的旁侧面板，与主对话并存；
 *   2) 左侧栏全局入口（sidebar.panellist）+ 主区全局面板（main keyed slot）：
 *      没有会话时也能一键打开同一个旁侧对话；
 *   3) `/side` 客户端命令（ctx.commandUi action）：在输入框敲 /side 直接把侧栏打开。
 *
 * 对话本身跑在真实的 DSH 会话上（ctx.sessions），因此侧栏里的助手带工具、
 * 带工作区、和主对话用同一套模型配置；不是另起一套 HTTP 客户端。
 *
 * 关键约定（对着 @deepseek-ai 的官方包核对过）：
 *   - bundle 入口：window.__ModuleLoader__.load({ id, factory })，id 必须等于 loader 条目名；
 *   - 导出形状：{ apply, inject }，inject 里写 Cordis 服务名（不是包名）；
 *   - slot 注册：ctx.slots.register({ name, key|id, ... }, Component)，
 *     先 ctx.slots.inject(name, fn) 等席位就位；
 *   - 右侧栏 tab：ctx.sidebarRightTabs.register({ id, kind, title, priority }) +
 *     ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id }, Body)，
 *     打开用 ctx.sidebarRight.openTab(kind)；
 *   - 会话数据面：session.getSnapshot()/subscribe() 是状态，session.eventSource 是
 *     { entries } 条目窗口，发送用 session.prompt([{type:'text',text}], 'queue')。
 */

window.__ModuleLoader__.load({
  id: 'dsh-sidechat',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')
    var h = react.createElement

    /* ── 常量 ─────────────────────────────────────────────────────────────── */
    var TAB_ID = 'dsh-sidechat/chat'             // tab 类型 id，同时是正文席位 key
    var TAB_KIND = 'side-chat'                   // 打开 tab 时传的 kind
    var PANEL_ID = 'dsh-sidechat'                // 左侧栏入口 id，同时是 main 面板 key
    var BINDING_KEY = 'dsh-sidechat:bindings:v2' // 主会话 → 旁侧会话 的绑定表
    var LEGACY_KEY = 'dsh-sidechat:session:v1'   // 旧版单会话键，启动时清掉
    var TITLE = '旁侧对话'

    /**
     * 上下文块标记。
     *
     * 每次提问都会把主会话的**增量**转录作为背景塞进旁侧会话（只进旁侧，主线一点
     * 都不受影响）。它在旁侧转录里是一段 user 消息，靠这两行标记在渲染时剥掉，
     * 否则面板里会堆满看不见尽头的历史。
     */
    var CONTEXT_OPEN = '<!-- dsh-sidechat:main-context -->'
    var CONTEXT_CLOSE = '<!-- /dsh-sidechat:main-context -->'

    /** 增量上下文的上限：行数、单行字数、总字数。 */
    var DIGEST_MAX_ROWS = 24
    var DIGEST_ROW_CHARS = 900
    var DIGEST_MAX_CHARS = 8000

    /* ── 样式（用主题 token，深浅色都跟得上） ─────────────────────────────── */
    var CSS = [
      '.sc-root{display:flex;flex-direction:column;height:100%;min-height:320px;width:100%;max-width:900px;margin:0 auto;font-size:13px;color:var(--dsw-alias-label-primary,inherit);box-sizing:border-box}',
      '.sc-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));flex:0 0 auto}',
      '.sc-title{font-weight:600;font-size:13px;letter-spacing:.02em}',
      '.sc-badge{font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.75));font-family:ui-monospace,Consolas,monospace}',
      '.sc-actions{margin-left:auto;display:flex;align-items:center;gap:6px}',
      '.sc-btn{font:inherit;font-size:12px;line-height:1;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.08));color:var(--dsw-alias-label-secondary,rgba(127,127,127,.95));cursor:pointer;white-space:nowrap}',
      '.sc-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary,inherit);border-color:var(--dsw-alias-state-business-primary,#4d6bfe)}',
      '.sc-btn:disabled{opacity:.45;cursor:default}',
      '.sc-body{flex:1 1 auto;min-height:0;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:12px;scrollbar-width:thin}',
      '.sc-empty{margin:auto;text-align:center;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.8));font-size:12px;line-height:1.7}',
      '.sc-row{display:flex;flex-direction:column;gap:4px;max-width:100%}',
      '.sc-who{font-size:11px;font-weight:600;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.8))}',
      '.sc-text{white-space:pre-wrap;word-break:break-word;line-height:1.65;font-size:13px}',
      '.sc-user .sc-text{padding:8px 11px;border-radius:10px;background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.1));align-self:flex-start;max-width:92%}',
      '.sc-typing{color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.8));font-size:12px;font-style:italic}',
      '.sc-tool{align-self:flex-start;font-size:11.5px;line-height:1.5;padding:2px 8px;border-radius:6px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.9));background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.08));max-width:92%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sc-streaming .sc-text::after{content:"";display:inline-block;width:6px;height:13px;margin-left:2px;vertical-align:-2px;background:currentColor;opacity:.5;animation:dsh-sidechat-caret 1s steps(2,start) infinite}',
      '@keyframes dsh-sidechat-caret{50%{opacity:0}}',
      '.sc-err{flex:0 0 auto;margin:8px 14px 0;padding:6px 10px;border-radius:8px;font-size:12px;color:var(--dsw-alias-state-error-primary,#e5484d);background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.08))}',
      '.sc-composer{flex:0 0 auto;display:flex;align-items:flex-end;gap:8px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22))}',
      '.sc-input{flex:1 1 auto;min-height:38px;max-height:180px;resize:none;font:inherit;font-size:13px;line-height:1.5;padding:9px 11px;border-radius:10px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.06));color:var(--dsw-alias-label-primary,inherit);outline:none}',
      '.sc-input:focus{border-color:var(--dsw-alias-state-business-primary,#4d6bfe)}'
    ].join('\n')

    /** 样式只注入一次；插件重载时按 id 复用。 */
    function ensureCss() {
      if (!document.getElementById('dsh-sidechat-css')) {
        var el = document.createElement('style')
        el.id = 'dsh-sidechat-css'
        el.textContent = CSS
        document.head.appendChild(el)
      }
    }

    /* ── 小工具 ───────────────────────────────────────────────────────────── */

    /** 内容块数组 → 纯文本（只取 text 块；图片/文件/推理块不进旁侧转录）。 */
    function contentText(content) {
      if (typeof content === 'string') return content
      if (!Array.isArray(content)) return ''
      var parts = []
      for (var i = 0; i < content.length; i++) {
        var block = content[i]
        if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text)
        }
      }
      return parts.join('\n').trim()
    }

    /**
     * 一条会话事件 → 转录行。
     * user/message 的 data 本身就是消息；assistant/message 的消息在 data.message。
     *
     * 过滤：只认 `source.kind === 'user'` 的用户消息。DSH 会以 user 角色的消息
     * 注入运行时上下文、技能清单、system-reminder 等背景内容，它们同样以
     * user/message 事件落盘，但不是「你说的话」（官方 session-title 也是按
     * 这个 kind 判定真实人类输入的）。
     */
    function entryRow(entry) {
      var event = entry && entry.event
      if (!event) return null
      if (event.type === 'user/message') {
        var message = event.data
        if (!message || typeof message !== 'object') return null
        if (!message.source || message.source.kind !== 'user') return null
        var userText = stripContextBlock(contentText(message.content))
        return userText ? { key: 'u' + event.seq, role: 'user', text: userText } : null
      }
      if (event.type === 'assistant/message') {
        var assistant = event.data && event.data.message
        if (!assistant) return null
        var assistantText = contentText(assistant.content)
        return assistantText ? { key: 'a' + event.seq, role: 'assistant', text: assistantText } : null
      }
      return null
    }

    /**
     * 事件窗口 → 转录行。
     *
     * 关键点：DSH 的回答是**流式**的。模型一开口，宿主就连续追加
     * `assistant/live-chunk` 事件（text-delta / reasoning-delta / block-start…），
     * 等整段说完了才落一条 `assistant/message`。只渲染后者的话，面板会一直空着
     * 直到回答全部生成完 —— 用户看到的就是「侧栏好慢」，而实际上首字早在
     * 几百毫秒就到了。
     *
     * 所以这里把 live-chunk 折叠成一朵「正在长出来的」助手行：每个 turn/step 一行，
     * 按 chunk.index 分块拼文本；durable 的 assistant/message 到达时顶掉对应行，
     * 不会重复也不会闪烁。
     */
    function buildRows(entries) {
      var rows = []
      var live = Object.create(null)
      var liveOrder = []

      for (var i = 0; i < entries.length; i++) {
        var event = entries[i] && entries[i].event
        if (!event) continue
        var data = event.data || {}

        if (event.type === 'user/message') {
          var message = data
          if (!message || typeof message !== 'object') continue
          if (!message.source || message.source.kind !== 'user') continue
          var userText = stripContextBlock(contentText(message.content))
          if (userText) rows.push({ key: 'u' + event.seq, role: 'user', text: userText })
          continue
        }

        if (event.type === 'assistant/live-chunk') {
          var chunk = data.chunk || {}
          var key = 'live:' + data.turn + ':' + data.step
          var slot = live[key]
          if (!slot) {
            slot = { key: key, role: 'assistant', blocks: [], reasoning: 0, streaming: true }
            live[key] = slot
            liveOrder.push(key)
          }
          var index = typeof chunk.index === 'number' ? chunk.index : 0
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
            slot.blocks[index] = (slot.blocks[index] || '') + chunk.text
          } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
            // 推理阶段不显示原文（太吵），但要知道它在动 —— 否则高推理等级下
            // 那几秒是完全静默的，用户只会觉得「卡住了」。
            slot.reasoning += chunk.text.length
          }
          continue
        }

        if (event.type === 'assistant/message') {
          var assistant = data.message
          if (!assistant) continue
          // durable 到了：同一条 turn/step 的流式行退休，改由它出场。
          var doneKey = 'live:' + data.turn + ':' + data.step
          if (live[doneKey]) delete live[doneKey]
          var assistantText = contentText(assistant.content)
          if (assistantText) rows.push({ key: 'a' + event.seq, role: 'assistant', text: assistantText })
          continue
        }

        if (event.type === 'tool/call') {
          var label = toolLabel(data)
          if (label) rows.push({ key: 't' + event.seq, role: 'tool', text: label })
          continue
        }
      }

      for (var j = 0; j < liveOrder.length; j++) {
        var pending = live[liveOrder[j]]
        if (!pending) continue
        var text = ''
        for (var b = 0; b < pending.blocks.length; b++) {
          if (pending.blocks[b]) text += pending.blocks[b]
        }
        if (text.trim() === '' && pending.reasoning === 0) continue
        rows.push({
          key: pending.key,
          role: 'assistant',
          text: text,
          streaming: true,
          thinking: pending.reasoning
        })
      }

      return rows
    }

    /** 工具调用的可读名字（不同来源字段名不一定一致，挨个试）。 */
    function toolLabel(data) {
      if (!data || typeof data !== 'object') return ''
      var candidates = [data.name, data.toolName, data.title]
      if (data.call && typeof data.call === 'object') candidates.push(data.call.name, data.call.toolName)
      for (var i = 0; i < candidates.length; i++) {
        if (typeof candidates[i] === 'string' && candidates[i] !== '') return candidates[i]
      }
      return ''
    }

    /**
     * 去掉藏在提问前面的主会话上下文块，只留用户真正打的那句话。
     *
     * 上下文块是本插件自己拼上去的（见 {@link buildDigest}），它跟提问在同一条
     * user 消息里，所以显示前必须剥掉，否则旁侧转录会退化成一大坨历史。
     */
    function stripContextBlock(text) {
      if (typeof text !== 'string' || text === '') return ''
      if (text.indexOf(CONTEXT_OPEN) !== 0) return text
      var end = text.indexOf(CONTEXT_CLOSE)
      if (end < 0) return ''            // 半截上下文：整条都不是用户写的
      return text.slice(end + CONTEXT_CLOSE.length).trim()
    }

    /** Remote 失败 / 异常 → 一行可读错误。 */
    function describeError(error) {
      if (!error) return '未知错误'
      if (typeof error === 'string') return error
      if (error.error && (error.error.code || error.error.message)) {
        return String(error.error.code || '') + ' ' + String(error.error.message || '')
      }
      if (error.message) return String(error.message)
      try { return JSON.stringify(error) } catch (e) { return String(error) }
    }

    /** 会话 id 的短标识（`session-<uuid>` 取尾 8 位，前缀对所有人一样没信息量）。 */
    function shortId(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return ''
      return sessionId.length <= 12 ? sessionId : '…' + sessionId.slice(-8)
    }

    /* ── 绑定表（主会话 → 旁侧会话，一个主会话一条） ───────────────────────── */
    /**
     * 读整张绑定表。
     *
     * 键是**主会话 id**，值 `{ sideId, seq }`：
     *   - sideId：这个主会话专属的旁侧会话；
     *   - seq：上次把主会话喂到哪里（事件序号），下次只喂增量。
     *
     * 强绑定就靠这张表：面板永远先问「当前主会话是哪个」，再去表里取它那一条，
     * 于是切换主会话 = 换一套旁侧对话，天然跟着走。
     */
    function readBindings() {
      try {
        var raw = window.localStorage.getItem(BINDING_KEY)
        if (!raw) return {}
        var parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? parsed : {}
      } catch (err) {
        return {}
      }
    }

    function writeBindings(map) {
      try {
        window.localStorage.setItem(BINDING_KEY, JSON.stringify(map))
      } catch (err) {
        // 隐私模式 / 配额满：无非是重启后绑定丢了，不影响本次使用。
      }
    }

    /** 取某个主会话的绑定（没有则返回空绑定）。 */
    function readBinding(mainSessionId) {
      if (!mainSessionId) return { sideId: '', seq: 0 }
      var record = readBindings()[mainSessionId]
      if (!record || typeof record !== 'object') return { sideId: '', seq: 0 }
      return {
        sideId: typeof record.sideId === 'string' ? record.sideId : '',
        seq: typeof record.seq === 'number' && record.seq >= 0 ? record.seq : 0
      }
    }

    /** 合并写入一条绑定。 */
    function patchBinding(mainSessionId, patch) {
      if (!mainSessionId) return
      var map = readBindings()
      map[mainSessionId] = Object.assign({ sideId: '', seq: 0 }, map[mainSessionId], patch)
      writeBindings(map)
    }

    /** 解绑（「新对话」用）。 */
    function dropBinding(mainSessionId) {
      if (!mainSessionId) return
      var map = readBindings()
      delete map[mainSessionId]
      writeBindings(map)
    }

    /* ── 会话引用 ─────────────────────────────────────────────────────────── */
    /**
     * 借一个 Session 引用。
     *
     * DSH 的会话不是「取对象」，而是「借引用」：`ctx.sessions.retain(id, { source })`
     * 会顺带触发 open（拉历史尾巴），`reference.ready` resolve 出 binding，
     * `binding.session` 才是那个带 prompt / eventSource 的会话。引用计数归零时
     * 会话作用域被回收，所以用完必须 release。
     *
     * @param ctx - 客户端根上下文。
     * @param sessionId - 要借的会话。
     * @returns { retain 的引用 }
     */
    var REFERENCE_SOURCE = 'sidechat'

    function takeReference(ctx, sessionId) {
      return ctx.sessions.retain(sessionId, { source: REFERENCE_SOURCE })
    }

    function releaseReference(reference) {
      if (!reference) return
      try {
        reference.release()
      } catch (err) {
        // 已释放或已被回收：没有需要补救的东西。
      }
    }

    /* ── 计时埋点 ─────────────────────────────────────────────────────────── */
    /**
     * 轻量计时环。`localStorage['dsh-sidechat:debug'] = '1'` 后每步都会往
     * console 打一行；不管开不开，最近 200 条都挂在 `window.__sidechatTimings`
     * 上，可以随时在控制台里看哪一段慢。
     */
    var TIMINGS = []

    function nowMs() {
      return (typeof performance !== 'undefined' && performance.now)
        ? performance.now()
        : Date.now()
    }

    function debugEnabled() {
      try {
        return localStorage.getItem('dsh-sidechat:debug') === '1'
      } catch (err) {
        return false
      }
    }

    function mark(name, extra) {
      var entry = { name: name, t: Math.round(nowMs()) }
      if (extra !== undefined) entry.extra = extra
      TIMINGS.push(entry)
      if (TIMINGS.length > 200) TIMINGS.splice(0, TIMINGS.length - 200)
      try {
        window.__sidechatTimings = TIMINGS
      } catch (err) {
        // 没有 window（测试环境）就只留内存。
      }
      if (debugEnabled()) console.log('[dsh-sidechat] ' + name, entry.t, extra === undefined ? '' : extra)
    }

    /**
     * 等这条会话下一次「说出话」的时刻，用来量「按回车到看见回答」的真实延迟。
     *
     * 只认 assistant/message，所以量到的是回答落地的时间，不含我们自己那几段等待。
     * 返回一个退订函数，调用方负责收尾。
     */
    function watchFirstAnswer(session, t0) {
      try {
        var source = session.eventSource
        var seen = 0
        var sawChunk = false
        try {
          var initial = source.getSnapshot()
          var seed = (initial && initial.entries) || []
          for (var i = 0; i < seed.length; i += 1) {
            var ev = seed[i] && seed[i].event
            if (ev && typeof ev.seq === 'number' && ev.seq > seen) seen = ev.seq
          }
        } catch (err) {
          seen = 0
        }
        var stop = source.subscribe(function () {
          var snap
          try {
            snap = source.getSnapshot()
          } catch (err) {
            return
          }
          var entries = (snap && snap.entries) || []
          for (var j = 0; j < entries.length; j += 1) {
            var item = entries[j] && entries[j].event
            if (!item || typeof item.seq !== 'number' || item.seq <= seen) continue
            if (!sawChunk && item.type === 'assistant/live-chunk') {
              var chunk = item.data && item.data.chunk
              var kind = chunk && chunk.type
              if (kind === 'text-delta' || kind === 'reasoning-delta' || kind === 'block-start') {
                sawChunk = true
                mark('send:first-chunk', Math.round(nowMs() - t0))
              }
            }
            if (item.type === 'assistant/message') {
              mark('send:first-answer', Math.round(nowMs() - t0))
              try { stop() } catch (err) { /* 已退订 */ }
              return
            }
          }
        })
        return stop
      } catch (err) {
        return null
      }
    }

    /**
     * 这个失败是否表示「该会话已经不在了」。
     *
     * 持久化的会话 id 会变成孤儿：换 profile、删掉会话、从别处导入配置，都会让
     * localStorage 里那个 id 指向不存在的会话。这类错误必须让状态自己复位，
     * 否则面板会永久卡在一个打不开的会话上。
     */
    function isGoneSession(error) {
      if (!error) return false
      var text = String(error.message || error) + ' ' + String((error.rpcError && error.rpcError.code) || '')
      return /unknown session|not found|no such session/i.test(text)
    }

    /* ── 当前主会话 ───────────────────────────────────────────────────────── */
    /** 空 binding 快照：来源缺失时给 useSyncExternalStore 一个稳定对象。 */
    var EMPTY_BINDING = {}

    /**
     * 主区此刻显示的是哪个会话。
     *
     * `uiSession.adapter.current` 是一个 binding source（有 getSnapshot/subscribe，
     * 快照对象在重新发布前保持不变），正好满足 useSyncExternalStore 的约定。
     * 这个 id 是整套强绑定的锚点：它一变，面板就整个换到那个会话的旁侧对话上。
     *
     * @param ctx - 客户端根上下文。
     * @returns 主会话 id；没有会话（如停在空白页）时返回空串。
     */
    function useCurrentSessionId(ctx) {
      var source = ctx.uiSession && ctx.uiSession.adapter && ctx.uiSession.adapter.current
      var subscribe = react.useCallback(function (callback) {
        if (!source) return function () {}
        return source.subscribe(callback)
      }, [source])
      var read = react.useCallback(function () {
        if (!source) return EMPTY_BINDING
        return source.getSnapshot() || EMPTY_BINDING
      }, [source])
      var snapshot = react.useSyncExternalStore(subscribe, read)
      return snapshot && typeof snapshot.key === 'string' ? snapshot.key : ''
    }

    /* ── 主会话上下文摘要 ─────────────────────────────────────────────────── */
    /**
     * 把主会话的（增量）转录拼成一段背景说明，随提问一起发给旁侧会话。
     *
     * 设计取舍：
     *   - **只进旁侧**：这段文本发到旁侧会话，主会话一个字都不加，主线上下文不受污染；
     *   - **只发增量**：`sinceSeq` 之后的事件才发，聊到第十轮也只带最后一轮的变化；
     *   - **有上限**：行数 / 单行字数 / 总字数三层截断，防止长对话把旁侧会话撑爆。
     *
     * @param entries - 主会话 eventSource 的快照条目。
     * @param sinceSeq - 上次喂到的事件序号；0 表示这是这个旁侧会话的第一次。
     * @returns { text, seq } —— text 为空串表示没有可发的内容。
     */
    function buildDigest(entries, sinceSeq) {
      var list = Array.isArray(entries) ? entries : []
      var since = typeof sinceSeq === 'number' && sinceSeq > 0 ? sinceSeq : 0

      // 水位线高于当前最大序号，说明会话被压缩/重建过（序号回落）：
      // 这时按「第一次」处理，整份重发，否则会一直以为「没有新内容」。
      if (since > 0) {
        var head = 0
        for (var k = 0; k < list.length; k++) {
          var s = list[k] && list[k].event && typeof list[k].event.seq === 'number' ? list[k].event.seq : 0
          if (s > head) head = s
        }
        if (head < since) since = 0
      }

      var maxSeq = since
      var rows = []
      for (var i = 0; i < list.length; i++) {
        var entry = list[i]
        var seq = entry && entry.event && typeof entry.event.seq === 'number' ? entry.event.seq : 0
        if (seq > maxSeq) maxSeq = seq
        if (since > 0 && seq <= since) continue
        var row = entryRow(entry)
        if (row) rows.push(row)
      }
      if (rows.length === 0) return { text: '', seq: maxSeq }

      if (rows.length > DIGEST_MAX_ROWS) rows = rows.slice(rows.length - DIGEST_MAX_ROWS)

      var lines = []
      for (var j = 0; j < rows.length; j++) {
        var body = rows[j].text
        if (body.length > DIGEST_ROW_CHARS) body = body.slice(0, DIGEST_ROW_CHARS) + '…（截断）'
        lines.push((rows[j].role === 'user' ? '我' : '助手') + '：' + body)
      }
      var intro = since > 0
        ? '主会话在我上次提问之后新产生的内容：'
        : '主会话到目前为止的内容：'
      var text = CONTEXT_OPEN + '\n' +
        intro + '\n\n' + lines.join('\n\n') + '\n' + CONTEXT_CLOSE

      if (text.length > DIGEST_MAX_CHARS) {
        var keep = text.slice(text.length - DIGEST_MAX_CHARS)
        var firstBreak = keep.indexOf('\n\n')
        if (firstBreak > 0 && firstBreak < 400) keep = keep.slice(firstBreak + 2)
        text = CONTEXT_OPEN + '\n' + intro + '（更早内容已省略）\n\n' + keep
      }
      return { text: text, seq: maxSeq }
    }

    /**
     * 借主会话读一次转录快照，返回增量摘要。
     *
     * 读完立刻释放引用（引用计数语义：多借一份会让会话作用域多活一会儿）。
     * 读失败不阻断发送 —— 上下文少了就少了，别把提问也一起丢掉。
     *
     * @param ctx - 客户端根上下文。
     * @param mainSessionId - 主会话 id。
     * @param sinceSeq - 上次喂到的事件序号。
     * @returns {Promise<{ text, seq }>}
     */
    async function captureMainContext(ctx, mainSessionId, sinceSeq) {
      var reference
      var t0 = nowMs()
      mark('context:start')
      try {
        reference = takeReference(ctx, mainSessionId)
        var binding = await withTimeout(reference.ready, 5000)
        mark('context:ready', Math.round(nowMs() - t0))
        var snapshot = binding.session.eventSource.getSnapshot()
        var digest = buildDigest(snapshot && snapshot.entries, sinceSeq)
        mark('context:digest', Math.round(nowMs() - t0))
        return digest
      } catch (err) {
        console.warn('[dsh-sidechat] 读取主会话上下文失败，本次不带背景:', err)
        mark('context:failed', Math.round(nowMs() - t0))
        return { text: '', seq: sinceSeq || 0 }
      } finally {
        releaseReference(reference)
      }
    }

    /** 给 promise 套一个超时；超时按失败处理（宁可少带背景也别卡住发送）。 */
    function withTimeout(promise, ms) {
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
          reject(new Error('超时：' + ms + 'ms'))
        }, ms)
        Promise.resolve(promise).then(function (value) {
          clearTimeout(timer)
          resolve(value)
        }, function (err) {
          clearTimeout(timer)
          reject(err)
        })
      })
    }

    /* ── 图标（装饰性；侧栏/菜单自带可访问名称） ───────────────────────────── */
    function ChatGlyph(props) {
      var size = props && typeof props.size === 'number' ? props.size : 16
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false'
      }, [
        h('path', {
          key: 'bubble',
          d: 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z'
        }),
        h('path', { key: 'l1', d: 'M8.5 11.5h7' }),
        h('path', { key: 'l2', d: 'M8.5 14.8h4.2' })
      ])
    }

    /* ── 转录 ─────────────────────────────────────────────────────────────── */
    /**
     * 会话事件窗口的订阅视图。
     * eventSource.getSnapshot() 返回稳定缓存对象，满足 useSyncExternalStore 的约定。
     */
    function Transcript(props) {
      var session = props.session
      var subscribeEntries = react.useCallback(function (callback) {
        return session.eventSource.subscribe(callback)
      }, [session])
      var readEntries = react.useCallback(function () {
        return session.eventSource.getSnapshot()
      }, [session])
      var entriesSnapshot = react.useSyncExternalStore(subscribeEntries, readEntries)

      var subscribeState = react.useCallback(function (callback) {
        return session.subscribe(callback)
      }, [session])
      var readState = react.useCallback(function () {
        return session.getSnapshot()
      }, [session])
      var state = react.useSyncExternalStore(subscribeState, readState)

      var rows = buildRows(entriesSnapshot.entries || [])

      var bodyRef = react.useRef(null)
      react.useEffect(function () {
        var el = bodyRef.current
        if (!el) return
        // 用户往上翻着看历史时别抢滚动条；贴着底部才跟。
        var gap = el.scrollHeight - el.scrollTop - el.clientHeight
        if (gap < 80) el.scrollTop = el.scrollHeight
      }, [rows.length, entriesSnapshot.revision, state.running])

      var children = rows.map(function (row) {
        if (row.role === 'tool') {
          return h('div', { key: row.key, className: 'sc-tool' }, '⚙ ' + row.text)
        }
        // 只有推理、还没有正文：给个会跳字的进度，别让面板看着像死机。
        if (row.streaming === true && row.text.trim() === '') {
          return h('div', { key: row.key, className: 'sc-row sc-typing' }, '思考中… · 已思考 ' + row.thinking + ' 字')
        }
        var streaming = row.streaming === true
        return h('div', {
          key: row.key,
          className: 'sc-row sc-' + row.role + (streaming ? ' sc-streaming' : '')
        }, [
          h('div', { key: 'w', className: 'sc-who' }, row.role === 'user' ? '你' : '助手'),
          h('div', { key: 't', className: 'sc-text' }, row.text)
        ])
      })
      if (state.running && !rows.some(function (row) { return row.streaming === true })) {
        children.push(h('div', { key: 'sc-typing', className: 'sc-row sc-typing' }, '思考中…'))
      }
      if (children.length === 0) {
        children.push(h('div', { key: 'sc-empty', className: 'sc-empty' }, '旁侧对话还空着。直接说点什么。'))
      }

      return h('div', { className: 'sc-body', ref: bodyRef }, children)
    }

    /* ── 侧栏面板本体 ─────────────────────────────────────────────────────── */
    /**
     * 旁侧对话面板：左侧栏全局面板与右侧栏 tab 共用同一个组件。
     *
     * **强绑定**：面板不持有自己的会话 id，而是先问「主区现在是哪个会话」，
     * 再去绑定表里取那一条。所以切换主会话 = 换一套旁侧对话（右侧栏本来也是
     * 按会话停靠的，切走就没了）。没有主会话时面板只给提示，不允许凭空发消息。
     */
    function SideChat(props) {
      var ctx = props.ctx

      var mainSessionId = useCurrentSessionId(ctx)

      // 绑定：{ sideId, seq }。主会话一变就整条换掉。
      var bindingState = react.useState({ sideId: '', seq: 0 })
      var binding = bindingState[0]
      var setBinding = bindingState[1]
      var sessionId = binding.sideId
      var watermark = binding.seq

      var sessionState = react.useState(null)
      var session = sessionState[0]
      var setSession = sessionState[1]

      var errorState = react.useState('')
      var error = errorState[0]
      var setError = errorState[1]

      var busyState = react.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]

      var draftState = react.useState('')
      var draft = draftState[0]
      var setDraft = draftState[1]

      // 主会话换了 → 换成它那一条绑定，并丢掉上一个会话的对象/错误/草稿。
      react.useEffect(function () {
        setBinding(readBinding(mainSessionId))
        setSession(null)
        setError('')
        setDraft('')
      }, [mainSessionId])

      // 绑定里的旁侧会话变了 → 借引用、订阅；卸载/换会话时释放。
      react.useEffect(function () {
        if (!sessionId) {
          setSession(null)
          return
        }
        var alive = true
        var reference
        try {
          reference = takeReference(ctx, sessionId)
        } catch (err) {
          setSession(null)
          if (isGoneSession(err)) {
            dropBinding(mainSessionId)
            setBinding({ sideId: '', seq: 0 })
            setError('这个主会话的旁侧对话已不存在，说句话会新建一个。')
          } else {
            setError('旁侧会话打不开：' + describeError(err))
          }
          return
        }
        reference.ready.then(function (ready) {
          if (!alive) return
          setSession(ready.session)
          setError('')
        }, function (err) {
          if (!alive) return
          setSession(null)
          if (isGoneSession(err)) {
            // 让 state 回到「无会话」，下次发送自动新建（不要卡在孤儿 id 上）。
            dropBinding(mainSessionId)
            setBinding({ sideId: '', seq: 0 })
            setError('这个主会话的旁侧对话已不存在，说句话会新建一个。')
          } else {
            setError('旁侧会话打不开：' + describeError(err))
          }
        })
        return function () {
          alive = false
          releaseReference(reference)
        }
      }, [sessionId, mainSessionId])

      /** 「新对话」：只解绑当前主会话这一条，别人那条不动。 */
      var newChat = react.useCallback(function () {
        dropBinding(mainSessionId)
        setBinding({ sideId: '', seq: 0 })
        setSession(null)
        setError('')
        setDraft('')
      }, [mainSessionId])

      /**
       * 发一问题。
       *
       * 三步：① 借主会话读一次转录，拼出增量背景；② 确保这个主会话有旁侧会话
       * （没有就 create）；③ 把「背景 + 我的问题」一起发到旁侧会话。
       *
       * 背景只进旁侧，主会话不收到任何东西 —— 这就是「不污染主线上下文」。
       * 发完把水位线推到主会话的最新事件序号，下一问只带增量。
       */
      var send = react.useCallback(async function () {
        var text = draft.trim()
        if (!text || busy) return
        if (!mainSessionId) {
          setError('旁侧对话跟着当前会话走：先在主区打开一个会话。')
          return
        }
        setDraft('')
        setBusy(true)
        setError('')
        mark('send:enter', 0, { queued: busy })

        /** 走一遍 create（可选）→ retain → open → prompt，返回用到的旁侧会话 id。 */
        var attempt = async function (createFresh, digest) {
          var t0 = nowMs()
          var id = createFresh ? '' : sessionId
          if (!id) {
            mark('send:create-start')
            id = await ctx.sessions.create({})
            mark('send:created', Math.round(nowMs() - t0))
            if (typeof id !== 'string' || id === '') throw new Error('创建旁侧会话失败：Host 没有返回会话 id')
            patchBinding(mainSessionId, { sideId: id })
            setBinding({ sideId: id, seq: watermark })
          }
          var reference = takeReference(ctx, id)
          try {
            var tReady = nowMs()
            var ready = await withTimeout(reference.ready, 10000)
            mark('send:open', Math.round(nowMs() - tReady))
            var payload = digest.text ? digest.text + '\n\n' + text : text
            var tPrompt = nowMs()
            mark('send:prompt-submitted', 0, { payloadChars: payload.length })
            var unwatch = watchFirstAnswer(ready.session, tPrompt)
            var result = await ready.session.prompt([{ type: 'text', text: payload }], 'queue')
            mark('send:prompt-accepted', Math.round(nowMs() - tPrompt))
            if (!result || result.ok !== true) {
              if (unwatch) unwatch()
              throw new Error('发送失败：' + describeError(result))
            }
          } finally {
            releaseReference(reference)
          }
          // 水位线只在确实发出去之后推进（失败时下次还要补上这段）。
          patchBinding(mainSessionId, { sideId: id, seq: digest.seq })
          setBinding({ sideId: id, seq: digest.seq })
        }

        try {
          var digest = await captureMainContext(ctx, mainSessionId, watermark)
          try {
            await attempt(false, digest)
          } catch (err) {
            if (!sessionId || !isGoneSession(err)) throw err
            // 旁侧会话没了：解绑，用新会话把这句补发出去（不丢用户输入）。
            dropBinding(mainSessionId)
            setBinding({ sideId: '', seq: 0 })
            await attempt(true, digest)
          }
        } catch (err) {
          setError(describeError(err))
          setDraft(text)
        } finally {
          setBusy(false)
        }
      }, [draft, busy, mainSessionId, sessionId, watermark])

      var stop = react.useCallback(function () {
        if (!session) return
        try {
          var pending = session.cancel()
          if (pending && typeof pending.catch === 'function') pending.catch(function () {})
        } catch (err) {
          setError('停止失败：' + describeError(err))
        }
      }, [session])

      var onKeyDown = function (event) {
        var composing = event.nativeEvent && event.nativeEvent.isComposing
        if (event.key === 'Enter' && !event.shiftKey && !composing) {
          event.preventDefault()
          send()
        }
      }

      var running = false
      if (session) {
        try { running = session.getSnapshot().running === true } catch (err) { running = false }
      }

      var bindText = mainSessionId
        ? (sessionId ? shortId(mainSessionId) + ' · ' + shortId(sessionId) : shortId(mainSessionId))
        : '未绑定'

      var emptyHint = !mainSessionId
        ? '旁侧对话跟着当前会话走。先在主区打开一个会话，再回到这里提问。'
        : '将围绕这个会话新建一个旁侧对话。随便问 —— 主线上下文会自动带过来，而你说的话不会进主线。'

      var placeholder = mainSessionId
        ? '问点旁支的…（Enter 发送，Shift+Enter 换行）'
        : '先打开一个会话'

      return h('div', { className: 'sc-root' }, [
        h('div', { key: 'head', className: 'sc-head' }, [
          h('div', { key: 'title', className: 'sc-title' }, TITLE),
          h('div', {
            key: 'badge',
            className: 'sc-badge',
            title: mainSessionId + (sessionId ? ' → ' + sessionId : '')
          }, bindText),
          h('div', { key: 'actions', className: 'sc-actions' }, [
            running
              ? h('button', { key: 'stop', type: 'button', className: 'sc-btn', onClick: stop }, '停止')
              : null,
            sessionId
              ? h('button', { key: 'new', type: 'button', className: 'sc-btn', onClick: newChat }, '新对话')
              : null
          ])
        ]),
        error ? h('div', { key: 'err', className: 'sc-err' }, error) : null,
        session
          ? h(Transcript, { key: 'body', session: session })
          : h('div', { key: 'empty', className: 'sc-body' }, [
              h('div', { key: 'hint', className: 'sc-empty' }, emptyHint)
            ]),
        h('div', { key: 'composer', className: 'sc-composer' }, [
          h('textarea', {
            key: 'input',
            className: 'sc-input',
            rows: 2,
            placeholder: placeholder,
            value: draft,
            disabled: busy || !mainSessionId,
            autoFocus: true,
            onChange: function (event) { setDraft(event.target.value) },
            onKeyDown: onKeyDown
          }),
          h('button', {
            key: 'send',
            type: 'button',
            className: 'sc-btn',
            disabled: busy || !mainSessionId || draft.trim() === '',
            onClick: send
          }, busy ? '…' : '发送')
        ])
      ])
    }

    /* ── 注册 ─────────────────────────────────────────────────────────────── */

    /**
     * 打开旁侧对话。
     *
     * 右侧栏是**按会话**停靠的：没有会话就没有停靠面。所以有会话时开 dock tab
     * （跟主对话并排，这是 /side 的常态），没有会话时退到全局主面板
     * （左侧栏那个入口的同一块面板），保证 /side 在哪儿按都有反应。
     *
     * @param ctx - 客户端根上下文。
     */
    function openSideChat(ctx) {
      var hasSession = false
      try {
        var current = ctx.uiSession && ctx.uiSession.adapter && ctx.uiSession.adapter.current
        var snapshot = current && current.getSnapshot && current.getSnapshot()
        hasSession = !!(snapshot && snapshot.key)
      } catch (err) {
        hasSession = false
      }
      if (hasSession) {
        try {
          ctx.sidebarRight.openTab(TAB_KIND)
          return
        } catch (err) {
          console.error('[dsh-sidechat] 右侧栏打不开，退回主面板:', err)
        }
      }
      try {
        ctx.layout.selectPanel(PANEL_ID)
      } catch (err) {
        console.error('[dsh-sidechat] 主面板打不开:', err)
      }
    }

    function apply(ctx) {
      ensureCss()

      // 旧版把单个旁侧会话 id 存在 session:v1 里；那套没有绑定关系，
      // 留着只会让人误以为还在用，直接清掉。
      try { window.localStorage.removeItem(LEGACY_KEY) } catch (err) { /* 忽略 */ }

      // 右侧栏：注册 tab 类型。标题在 tab 铸造时捕获，因此给一个函数即可。
      ctx.effect(function () {
        return ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          priority: 'extension',
          title: function () { return TITLE }
        })
      }, 'dsh-sidechat: tab type')

      // 右侧栏：tab 正文席位。
      ctx.slots.inject('sidebar.right.pane.tab', function () {
        return ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: TAB_ID },
          function TabBody() { return h(SideChat, { ctx: ctx }) }
        )
      })

      // 左侧栏：全局入口（没有会话也能打开）。
      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: function () { return TITLE } },
          ChatGlyph
        )
      })

      // 主区：全局面板，key 与左侧栏入口 id 一致。
      ctx.slots.inject('main', function () {
        return ctx.slots.register(
          { name: 'main', key: PANEL_ID },
          function PanelBody() { return h(SideChat, { ctx: ctx }) }
        )
      })

      // /side：客户端命令动作，裸调用即打开侧栏（不产生模型消息）。
      ctx.effect(function () {
        return ctx.commandUi.register({
          name: 'side',
          label: function () { return TITLE },
          description: function () { return '在右侧边栏打开一个能对话的旁侧面板' },
          icon: ChatGlyph,
          available: function () { return true },
          ui: {
            kind: 'action',
            run: function () { openSideChat(ctx) }
          }
        })
      }, 'dsh-sidechat: /side command')
    }

    /** Cordis 服务名（不是包名）：等这些服务就位后再 apply。 */
    var inject = [
      'slots',
      'layout',
      'sessions',
      'uiSession',
      'sidebarRight',
      'sidebarRightTabs',
      'commandUi'
    ]

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
