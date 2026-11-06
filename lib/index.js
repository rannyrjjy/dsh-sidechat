/**
 * dsh-sidechat — Host 半侧
 * ----------------------------------------------------------------------------
 * 本插件的能力全在浏览器半侧（侧边栏 tab、/side 命令、旁侧会话的收发），
 * 这里只保留一个最小可挂载的 Host 条目：cordis loader 需要一个能被解析的
 * 包入口，浏览器 bundle 才会随包一起被组装出来。
 *
 * 刻意不做的事（与 dsh-startup-screen 同款取舍）：
 *   1) 不导出 default —— cordis-plugin-loader 的 unwrapExports 是
 *      `exports.default ?? exports`，写了 default 就只认 default；
 *   2) 不导出 Config —— 本插件不吃 profile 配置。
 */

/** 稳定的 loader 身份（与 package.json 的 name 一致）。 */
export const name = 'dsh-sidechat'

/** 本插件不依赖任何 Host 服务。 */
export const inject = []

/**
 * Host 半侧什么都不做：侧边栏对话完全由浏览器半侧实现，
 * 不需要额外路由、不需要模型工具、不写入会话日志。
 */
export function apply() {}
