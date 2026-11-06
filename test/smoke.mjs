/**
 * dsh-sidechat 冒烟测试（纯 Node，不需要 DSH 运行时）
 * ----------------------------------------------------------------------------
 *   1) 用假的 window / document / localStorage 在 Node 里加载 lib/client.js；
 *   2) 用极简 React shim 执行 apply(ctx)，检查所有注册都发生了；
 *   3) 渲染面板，走一遍「发第一句话 → 新建旁侧会话 → 发消息 → 转录渲染」。
 *
 * 运行：node test/smoke.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/* ── 1. 极简 React shim ─────────────────────────────────────────────────── */
/* hooks 按「组件实例路径」保存；组件函数渲染完把结果展开成普通元素树，
   于是拿到的事件处理器仍然是组件内部闭包，可以真实驱动状态。 */

const instances = new Map()
const pendingEffects = []
const instanceStack = []

function currentInstance() {
  const inst = instanceStack[instanceStack.length - 1]
  if (!inst) throw new Error('hook called outside a component')
  return inst
}

let scheduleRerender = null
function queueRerender() {
  if (scheduleRerender) scheduleRerender()
}

function useSlot(init) {
  const inst = currentInstance()
  const index = inst.index++
  if (!(index in inst.hooks)) inst.hooks[index] = init()
  return [inst.hooks[index], (next) => {
    inst.hooks[index] = typeof next === 'function' ? next(inst.hooks[index]) : next
    queueRerender()
  }]
}

const ReactShim = {
  createElement(type, props, ...children) {
    const flat = []
    const push = (child) => {
      if (child === null || child === undefined || child === false) return
      if (Array.isArray(child)) { child.forEach(push); return }
      flat.push(child)
    }
    children.forEach(push)
    return { $$el: true, type, props: { ...(props || {}), children: flat } }
  },
  useState(initial) {
    return useSlot(() => (typeof initial === 'function' ? initial() : initial))
  },
  useEffect(fn, deps) {
    const inst = currentInstance()
    const index = inst.index++
    const prev = inst.hooks[index]
    const changed = !prev || !deps || deps.some((dep, i) => dep !== prev.deps[i])
    if (changed) {
      // 上一轮的 cleanup 必须真的跑掉（React 的行为），否则旧订阅不会退订 ——
      // 面板切会话时就会留着上一个会话的对象。
      const oldCleanup = prev && prev.cleanup
      const slot = { deps, cleanup: undefined }
      inst.hooks[index] = slot
      pendingEffects.push(() => {
        if (typeof oldCleanup === 'function') oldCleanup()
        slot.cleanup = fn()
      })
    }
  },
  useRef(initial) {
    return useSlot(() => ({ current: initial }))[0]
  },
  useCallback(fn) {
    currentInstance().index++
    return fn
  },
  useSyncExternalStore(subscribe, getSnapshot) {
    const inst = currentInstance()
    const index = inst.index++
    if (!inst.hooks[index]) {
      inst.hooks[index] = { unsubscribe: subscribe(() => queueRerender()) }
    }
    return getSnapshot()
  }
}

/** 展开组件函数，得到一棵只剩宿主元素的树。 */
function evaluate(node, key) {
  if (node === null || node === undefined || node === false) return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) {
    return node.map((child, i) => evaluate(child, key + '/' + i)).filter((child) => child !== null)
  }
  if (!node.$$el) return null
  const { type, props } = node
  if (typeof type === 'function') {
    const instKey = key + '>' + (type.name || 'anon')
    let inst = instances.get(instKey)
    if (!inst) { inst = { hooks: [], index: 0 }; instances.set(instKey, inst) }
    inst.index = 0
    instanceStack.push(inst)
    let rendered
    try {
      rendered = type(props)
    } finally {
      instanceStack.pop()
    }
    return evaluate(rendered, instKey)
  }
  const copy = { $$el: true, type, props: { ...props } }
  copy.props.children = evaluate(props && props.children, key + '>' + String(type))
  return copy
}

function textOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { node.forEach((child) => textOf(child, out)); return out }
  if (node.$$el) textOf(node.props && node.props.children, out)
  return out
}

function findElement(node, predicate) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, predicate)
      if (hit) return hit
    }
    return null
  }
  if (node.$$el) {
    if (predicate(node)) return node
    return findElement(node.props && node.props.children, predicate)
  }
  return null
}

/**
 * 挂载组件：render() 求值一次并跑 effect，返回元素树。
 * setState 会同步触发重渲染（带重入保护），因此事件处理器驱动的状态变化立即可见。
 */
function mount(Component, props, rootKey = 'root') {
  // 每次 mount 都是一棵新树：组件状态与 effect 全部重来（跟 React 重新挂载一致）。
  instances.clear()
  const runtime = {
    tree: null,
    text: '',
    rendering: false,
    dirty: false,
    render() {
      if (runtime.rendering) { runtime.dirty = true; return runtime.tree }
      runtime.rendering = true
      try {
        do {
          runtime.dirty = false
          instanceStack.length = 0
          pendingEffects.length = 0
          runtime.tree = evaluate(ReactShim.createElement(Component, props), rootKey)
          runtime.text = textOf(runtime.tree).join('')
          const effects = pendingEffects.splice(0)
          effects.forEach((run) => run())
        } while (runtime.dirty)
      } finally {
        runtime.rendering = false
      }
      return runtime.tree
    }
  }
  scheduleRerender = () => runtime.render()
  runtime.render()
  return runtime
}

/* ── 2. 假运行环境 ──────────────────────────────────────────────────────── */

const styleEls = new Map()
globalThis.window = {
  localStorage: {
    store: new Map(),
    getItem(k) { return this.store.has(k) ? this.store.get(k) : null },
    setItem(k, v) { this.store.set(k, String(v)) },
    removeItem(k) { this.store.delete(k) }
  },
  __ModuleLoader__: { load(spec) { window.__loaded = spec } }
}
globalThis.document = {
  head: { appendChild(el) { styleEls.set(el.id, el) } },
  getElementById(id) { return styleEls.get(id) || null },
  createElement() { return { id: '', textContent: '' } }
}

/* ── 3. 加载 bundle ─────────────────────────────────────────────────────── */

const source = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8')
new Function('window', 'document', 'require', 'console', source)(
  globalThis.window,
  globalThis.document,
  (id) => {
    if (id === 'react') return ReactShim
    throw new Error('unexpected require: ' + id)
  },
  console
)

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : ' — ' + detail}`)
}

check('bundle 注册到 ModuleLoader', !!window.__loaded && window.__loaded.id === 'dsh-sidechat')

const mod = window.__loaded.factory((id) => {
  if (id === 'react') return ReactShim
  throw new Error('unexpected require: ' + id)
})

check('导出 apply', typeof mod.apply === 'function')
check('导出 inject 服务名', Array.isArray(mod.inject) && mod.inject.includes('sidebarRight'), JSON.stringify(mod.inject))

/* ── 4. 假 ctx，跑 apply ────────────────────────────────────────────────── */


const registrations = { tabs: [], slots: [], commands: [], openTabs: [], panels: [] }
let createdCount = 0
const sessions = new Map()
const goneSessions = new Set()

/** 当前主会话（uiSession.adapter.current 的快照）。 */
let sessionSnapshot = { key: 'sess-a' }
const sessionListeners = new Set()
function setCurrentSession(key) {
  sessionSnapshot = { key }
  sessionListeners.forEach((fn) => fn())
}

function makeSession(sessionId) {
  return {
    sessionId,
    prompts: [],
    openCalls: 0,
    eventSource: {
      listeners: new Set(),
      state: { entries: [], hasMore: false, revision: 0 },
      getSnapshot() { return this.state },
      subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) },
      push(entry) {
        this.state = { entries: [...this.state.entries, entry], hasMore: false, revision: this.state.revision + 1 }
        this.listeners.forEach((fn) => fn())
      }
    },
    listeners: new Set(),
    snap: { running: false, blank: true, openState: 'open', promptError: null, removed: false },
    getSnapshot() { return this.snap },
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) },
    async open() { this.openCalls += 1 },
    async prompt(content, mode) {
      const raw = content.map((block) => block.text).join('\n')
      const closeAt = raw.indexOf('<!-- /dsh-sidechat:main-context -->')
      const question = closeAt >= 0 ? raw.slice(closeAt + 36).trim() : raw
      this.prompts.push({ content, mode, raw, question })
      const seq = this.eventSource.state.entries.length + 1
      this.eventSource.push({
        event: { seq, type: 'user/message', data: { id: 'm' + seq, role: 'user', source: { kind: 'user' }, content } }
      })
      // DSH 会向会话注入背景上下文（同样是 user/message，但 source.kind 不是 user），
      // 转录必须把它过滤掉。
      this.eventSource.push({
        event: {
          seq: seq + 1,
          type: 'user/message',
          data: { id: 'ctx' + seq, role: 'user', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'INJECTED RUNTIME CONTEXT' }] }
        }
      })
      this.eventSource.push({
        event: {
          seq: seq + 2,
          type: 'assistant/message',
          data: {
            message: {
              id: 'a' + seq,
              role: 'assistant',
              source: { kind: 'model', provider: 'p', model: 'm' },
              content: [{ type: 'text', text: '收到：' + question }]
            }
          }
        }
      })
      return { ok: true, value: { accepted: true } }
    },
    cancel() { return Promise.resolve() }
  }
}

/** 往会话里塞一条真实对话（用来给主会话造历史）。 */
function say(session, who, text) {
  const seq = session.eventSource.state.entries.length + 1
  if (who === 'user') {
    session.eventSource.push({
      event: { seq, type: 'user/message', data: { id: 'u' + seq, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } }
    })
    return
  }
  session.eventSource.push({
    event: {
      seq,
      type: 'assistant/message',
      data: { message: { id: 'a' + seq, role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text }] } }
    }
  })
}

const mainA = makeSession('sess-a')
const mainB = makeSession('sess-b')
sessions.set('sess-a', mainA)
sessions.set('sess-b', mainB)

const ctx = {
  effect(fn) { return fn() },
  slots: {
    inject(_name, fn) { fn() },
    register(spec, Component) { registrations.slots.push({ spec, Component }); return () => {} }
  },
  sidebarRightTabs: { register(def) { registrations.tabs.push(def); return () => {} } },
  sidebarRight: { openTab(kind) { registrations.openTabs.push(kind) } },
  commandUi: { register(contribution) { registrations.commands.push(contribution); return () => {} } },
  // 当前会话绑定：adapter.current 是 binding source（getSnapshot/subscribe）
  uiSession: {
    adapter: {
      current: {
        getSnapshot: () => sessionSnapshot,
        subscribe(fn) { sessionListeners.add(fn); return () => sessionListeners.delete(fn) }
      }
    }
  },
  sessions: {
    // 真实契约：create() 直接返回会话 id 字符串（失败抛错）
    async create() {
      createdCount += 1
      const id = 'sess-new-' + createdCount
      sessions.set(id, makeSession(id))
      return id
    },
    // 真实契约：retain(id, { source }) → { sessionId, ready: Promise<binding>, release() }
    retain(id, options) {
      if (goneSessions.has(id)) {
        const error = new Error(`sessions.retain: unknown session ${id}`)
        return {
          sessionId: id,
          source: options && options.source,
          ready: Promise.reject(error),
          release() {}
        }
      }
      if (!sessions.has(id)) sessions.set(id, makeSession(id))
      const session = sessions.get(id)
      return {
        sessionId: id,
        source: options && options.source,
        ready: session.open().then(() => ({ session })),
        release() {}
      }
    }
  },
  layout: { selectPanel(id) { registrations.panels.push(id) } }
}

mod.apply(ctx)

const tabDef = registrations.tabs[0]
check('注册右侧栏 tab 类型', !!tabDef && tabDef.kind === 'side-chat' && tabDef.id === 'dsh-sidechat/chat', JSON.stringify(tabDef))
check('tab 标题是「旁侧对话」', !!tabDef && tabDef.title() === '旁侧对话')

const bodySlot = registrations.slots.find((s) => s.spec.name === 'sidebar.right.pane.tab')
check('注册右侧栏 tab 正文', !!bodySlot && bodySlot.spec.key === 'dsh-sidechat/chat')

const paneSlot = registrations.slots.find((s) => s.spec.name === 'sidebar.panellist')
check('注册左侧栏全局入口', !!paneSlot && paneSlot.spec.id === 'dsh-sidechat')

const mainSlot = registrations.slots.find((s) => s.spec.name === 'main')
check('注册主区全局面板', !!mainSlot && mainSlot.spec.key === 'dsh-sidechat')

const sideCommand = registrations.commands[0]
check('注册 /side 命令', !!sideCommand && sideCommand.name === 'side')
check('/side 是 action 型（不产生模型消息）', !!sideCommand && sideCommand.ui.kind === 'action')

sideCommand.ui.run()
check('有会话时 /side 打开右侧栏 tab', registrations.openTabs[0] === 'side-chat', JSON.stringify(registrations.openTabs))

// 没有会话（新建的空白会话）时，右侧栏没有停靠面 → 退回全局主面板
setCurrentSession(undefined)
sideCommand.ui.run()
check('无会话时 /side 退回全局主面板', registrations.panels[0] === 'dsh-sidechat', JSON.stringify(registrations.panels))
check('无会话时不强行打开右侧栏', registrations.openTabs.length === 1, JSON.stringify(registrations.openTabs))
setCurrentSession('sess-a')

/* ── 5. 渲染面板 ────────────────────────────────────────────────────────── */

const PanelBody = bodySlot.Component
const panel = mount(PanelBody, {})
check('面板渲染出标题', panel.text.includes('旁侧对话'), panel.text.slice(0, 120))
check('空状态提示绑定到当前会话', panel.text.includes('将围绕这个会话新建'), panel.text.slice(0, 200))
check('头部标出绑定关系', panel.text.includes('sess-a'), panel.text.slice(0, 120))
check('样式已注入', styleEls.has('dsh-sidechat-css'))

/* ── 6. 强绑定：上下文带过去、主线不被污染 ─────────────────────────────── */

function findTextarea(tree) {
  return findElement(tree, (el) => el.type === 'textarea')
}
function findSendButton(tree) {
  // children 恒为数组：['发送'] 或忙碌时的 ['…']
  return findElement(tree, (el) => {
    if (el.type !== 'button') return false
    const kids = el.props.children
    return Array.isArray(kids) ? kids[0] === '发送' : kids === '发送'
  })
}
function findButtonByText(tree, text) {
  return findElement(tree, (el) => {
    if (el.type !== 'button') return false
    const kids = el.props.children
    return Array.isArray(kids) ? kids[0] === text : kids === text
  })
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

// 主会话 A 已经有了真实对话
say(mainA, 'user', '帮我扫一下 example.com 的端口')
say(mainA, 'assistant', '扫完了，开了 22 和 80。')

let textarea = findTextarea(panel.tree)
let sendButton = findSendButton(panel.tree)
check('渲染出输入框', !!textarea)
check('渲染出发送按钮', !!sendButton)
check('空草稿时发送按钮禁用', !!sendButton && sendButton.props.disabled === true, sendButton && String(sendButton.props.disabled))

textarea.props.onChange({ target: { value: '80 端口是什么服务？' } })
sendButton = findSendButton(panel.tree)
check('草稿非空后发送按钮可用', !!sendButton && sendButton.props.disabled === false, sendButton && String(sendButton.props.disabled))

await sendButton.props.onClick()
await tick()
panel.render()

const sideA = sessions.get('sess-new-1')
check('首次发送自动新建旁侧会话', createdCount === 1, 'created=' + createdCount)
check('问题本身发到了旁侧会话', !!sideA && sideA.prompts.length === 1 && sideA.prompts[0].question === '80 端口是什么服务？', JSON.stringify(sideA && sideA.prompts.map((p) => p.question)))
check('旁侧会话收到了主会话上下文', !!sideA && sideA.prompts[0].raw.includes('扫完了，开了 22 和 80。'), sideA && sideA.prompts[0].raw.slice(0, 200))
check('主会话没有被写入任何消息', mainA.prompts.length === 0, 'prompts=' + mainA.prompts.length)
check('发送模式是 queue', !!sideA && sideA.prompts[0].mode === 'queue')
check('绑定表记下了 主会话→旁侧会话', JSON.parse(window.localStorage.getItem('dsh-sidechat:bindings:v2'))['sess-a'].sideId === 'sess-new-1', window.localStorage.getItem('dsh-sidechat:bindings:v2'))
check('旁侧转录里不显示上下文块', !panel.text.includes('主会话到目前为止的内容'), panel.text.slice(0, 400))
check('旁侧转录显示了我的问题和回答', panel.text.includes('80 端口是什么服务？') && panel.text.includes('收到：80 端口是什么服务？'), panel.text.slice(0, 400))

// 主会话又走了两步 → 第二问应该只带增量
say(mainA, 'user', '顺便看下有没有 3306')
say(mainA, 'assistant', '没有 3306，只有 22 和 80。')
findTextarea(panel.tree).props.onChange({ target: { value: '那 SSH 版本是多少？' } })
await findSendButton(panel.tree).props.onClick()
await tick()
panel.render()

const second = sideA.prompts[1]
check('第二问带上了主会话的新内容', !!second && second.raw.includes('没有 3306'), second && second.raw.slice(0, 200))
check('第二问不再重复已经带过的内容', !!second && !second.raw.includes('扫完了，开了 22 和 80。'), second && second.raw.slice(0, 300))
check('第二问没有新建会话', createdCount === 1, 'created=' + createdCount)

/* ── 7. 切换主会话：旁侧对话跟着换 ─────────────────────────────────────── */

setCurrentSession('sess-b')
await tick()
panel.render()
check('切到 B 后不再显示 A 的旁侧对话', !panel.text.includes('80 端口是什么服务？'), panel.text.slice(0, 400))
check('切到 B 后提示要新建', panel.text.includes('将围绕这个会话新建'), panel.text.slice(0, 300))
check('切到 B 后头部绑定跟着换', panel.text.includes('sess-b'), panel.text.slice(0, 160))

say(mainB, 'user', 'B 会话这边在改一份报告')
say(mainB, 'assistant', '好的，报告模板已经就位。')
findTextarea(panel.tree).props.onChange({ target: { value: '模板里有没有风险等级字段？' } })
await findSendButton(panel.tree).props.onClick()
await tick()
panel.render()

const sideB = sessions.get('sess-new-2')
check('B 会话拿到独立的旁侧会话', createdCount === 2 && !!sideB, 'created=' + createdCount)
check('B 的旁侧会话只带 B 的上下文', !!sideB && sideB.prompts[0].raw.includes('报告模板已经就位') && !sideB.prompts[0].raw.includes('扫完了，开了 22 和 80。'), sideB && sideB.prompts[0].raw.slice(0, 300))
check('绑定表里 A 与 B 各一条', (() => {
  const map = JSON.parse(window.localStorage.getItem('dsh-sidechat:bindings:v2'))
  return map['sess-a'].sideId === 'sess-new-1' && map['sess-b'].sideId === 'sess-new-2'
})(), window.localStorage.getItem('dsh-sidechat:bindings:v2'))

// 切回 A：应恢复 A 的旁侧对话
setCurrentSession('sess-a')
await tick()
panel.render()
check('切回 A 恢复 A 的旁侧对话', panel.text.includes('80 端口是什么服务？') && panel.text.includes('那 SSH 版本是多少？'), panel.text.slice(0, 500))
check('切回 A 不新建会话', createdCount === 2, 'created=' + createdCount)

/* ── 8. 没有主会话时不能用 ─────────────────────────────────────────────── */

setCurrentSession(undefined)
await tick()
panel.render()
check('无主会话时提示先开会话', panel.text.includes('先在主区打开一个会话'), panel.text.slice(0, 300))
check('无主会话时输入框禁用', findTextarea(panel.tree).props.disabled === true, String(findTextarea(panel.tree).props.disabled))
setCurrentSession('sess-a')
await tick()
panel.render()

/* ── 9. 「新对话」只解绑当前主会话 ─────────────────────────────────────── */

const newButton = findButtonByText(panel.tree, '新对话')
check('有旁侧会话时出现「新对话」', !!newButton)
newButton.props.onClick()
await tick()
panel.render()
const mapAfter = JSON.parse(window.localStorage.getItem('dsh-sidechat:bindings:v2'))
check('新对话只解绑当前主会话', mapAfter['sess-a'] === undefined, JSON.stringify(mapAfter))
check('新对话不动别的会话的绑定', !!mapAfter['sess-b'], JSON.stringify(mapAfter))

/* ── 10. 陈旧旁侧会话自愈 ──────────────────────────────────────────────── */

goneSessions.add('sess-new-2')
const healed = mount(PanelBody, {})
setCurrentSession('sess-b')
await tick()
healed.render()
check('陈旧旁侧会话给出可读提示', healed.text.includes('已不存在'), healed.text.slice(0, 300))

findTextarea(healed.tree).props.onChange({ target: { value: '这个会话还能接着问' } })
await findSendButton(healed.tree).props.onClick()
await tick()
healed.render()
check('陈旧绑定之后能自动新建接着问', createdCount === 3, 'created=' + createdCount)
check('新旁侧会话收到上下文', !!sessions.get('sess-new-3') && sessions.get('sess-new-3').prompts[0].raw.includes('报告模板已经就位'), JSON.stringify(sessions.get('sess-new-3') && sessions.get('sess-new-3').prompts[0].raw.slice(0, 200)))
const mapHealed = JSON.parse(window.localStorage.getItem('dsh-sidechat:bindings:v2'))
check('绑定表指向新的旁侧会话', mapHealed['sess-b'].sideId === 'sess-new-3', JSON.stringify(mapHealed))
check('旧版单会话键已被清掉', window.localStorage.getItem('dsh-sidechat:session:v1') === null, String(window.localStorage.getItem('dsh-sidechat:session:v1')))

/* ── 11. 流式渲染：回答边生成边显示 ────────────────────────────────────── */

// DSH 的回答不是一次落盘的：宿主先连续追加 assistant/live-chunk
// （reasoning-delta / text-delta），最后才落一条 assistant/message。
// 只认后者的话，面板会在整个生成期间一直空着 —— 这正是「侧栏好慢」的观感来源。

function pushChunk(session, turn, step, chunk) {
  const seq = session.eventSource.state.entries.length + 1
  session.eventSource.push({
    event: { seq, time: Date.now(), type: 'assistant/live-chunk', data: { turn, step, chunk } }
  })
  return seq
}

const streamMain = makeSession('sess-stream')
sessions.set('sess-stream', streamMain)
say(streamMain, 'user', '主会话这边随便在干点活')
say(streamMain, 'assistant', '活儿干完了。')

setCurrentSession('sess-stream')
const streamPanel = mount(PanelBody, {})
await tick()
findTextarea(streamPanel.tree).props.onChange({ target: { value: '流式测一下' } })
await findSendButton(streamPanel.tree).props.onClick()
await tick()
streamPanel.render()

const sideStream = sessions.get('sess-new-4')
check('流式测试拿到旁侧会话', !!sideStream, 'created=' + createdCount)

// 只有推理，还没有正文：应该给出会动的进度，而不是一片空白
pushChunk(sideStream, 1, 1, { type: 'reasoning-delta', index: 0, text: '先想想这个问题该怎么答，'.repeat(3) })
streamPanel.render()
check(
  '推理阶段显示已思考字数而不是空白',
  streamPanel.text.includes('思考中') && /已思考 \d+ 字/.test(streamPanel.text),
  streamPanel.text.slice(-200)
)

// 正文开始流式输出：文本应该逐段长出来
pushChunk(sideStream, 1, 1, { type: 'block-start', index: 1, blockType: 'text' })
pushChunk(sideStream, 1, 1, { type: 'text-delta', index: 1, text: '第一段：' })
streamPanel.render()
const afterFirstDelta = streamPanel.text
check('首个 text-delta 立刻出现在转录里', afterFirstDelta.includes('第一段：'), afterFirstDelta.slice(-200))

pushChunk(sideStream, 1, 1, { type: 'text-delta', index: 1, text: '这里是后面的内容。' })
streamPanel.render()
check('后续 delta 追加而不是替换', streamPanel.text.includes('第一段：这里是后面的内容。'), streamPanel.text.slice(-200))
check('流式中的行带光标标记', !!findElement(streamPanel.tree, (el) => String(el.props.className || '').includes('sc-streaming')), streamPanel.text.slice(-200))

// durable 消息到达：顶掉流式行，不能出现两份
const settleSeq = sideStream.eventSource.state.entries.length + 1
sideStream.eventSource.push({
  event: {
    seq: settleSeq,
    time: Date.now(),
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: { id: 'streamed', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '第一段：这里是后面的内容。' }] }
    }
  }
})
streamPanel.render()
const occurrences = streamPanel.text.split('第一段：这里是后面的内容。').length - 1
check('落定后不重复显示（流式行被 durable 顶掉）', occurrences === 1, 'occurrences=' + occurrences + ' text=' + streamPanel.text.slice(-300))
check('落定后不再有流式光标', !findElement(streamPanel.tree, (el) => String(el.props.className || '').includes('sc-streaming')))

// 工具调用期间要能看到进展
pushChunk(sideStream, 2, 1, { type: 'block-start', index: 0, blockType: 'tool-call' })
sideStream.eventSource.push({
  event: { seq: sideStream.eventSource.state.entries.length + 1, time: Date.now(), type: 'tool/call', data: { name: 'Read' } }
})
streamPanel.render()
check('工具调用给出进展提示', streamPanel.text.includes('Read'), streamPanel.text.slice(-300))

console.log('')
console.log(failures === 0 ? '全部通过 ✓' : failures + ' 项失败 ✗')
process.exit(failures === 0 ? 0 : 1)
