# 安装 / 卸载

适用于任何平台的 DSH（Windows / macOS / Linux）。文中 `<profile>`、`<源码目录>` 这类
尖括号占位符都要换成你自己的实际值。

## 前提

1. **DSH 已安装并能正常启动。**
2. **`dsh` CLI 可用。** 在终端里跑 `dsh --version` 能出版本号就行。出不来说明它不在
   `PATH` 上，见下面「找不到 dsh 命令」。
3. 用**与宿主同版本**的 CLI。如果你的 `dsh` 是从 npm 全局装的旧版本，可能与桌面端不匹配 ——
   优先用 DSH 安装目录里自带的那份。

## 第一步：确认你用的是哪个 profile

DSH 把配置按 **profile** 分开存放，目录在：

| 平台 | 路径 |
| --- | --- |
| Windows | `%USERPROFILE%\.dsh\profiles\` |
| macOS / Linux | `~/.dsh/profiles/` |

进去看一眼有哪些子目录，名字就是 profile 名：

```bash
ls ~/.dsh/profiles/          # macOS / Linux
dir %USERPROFILE%\.dsh\profiles\   # Windows
```

常见的两个：

- **`desktop`** —— 桌面端 App 用的，大多数人装这个。
- **`web`** —— 用 `dsh web` 起的网页版用的。

不确定就两个都装上；装错了只是多一条不生效的依赖，用 `remove` 删掉即可。

## 第二步：装

```bash
# link: 指向源码目录（推荐，改代码重启即生效）
dsh plugin --profile <profile> add link:<源码目录绝对路径>

# 或 file: 指向 tgz（固定副本，不跟随源码改动）
dsh plugin --profile <profile> add file:<tgz 绝对路径>
```

路径建议用**正斜杠**，Windows 上也一样（`C:/code/dsh-sidechat` 比 `C:\code\dsh-sidechat` 少踩坑）。

这条命令会做三件事（`dsh plugin` 是 pnpm 的薄封装）：

1. 在 profile 的 `package.json` 里加 `dependencies["dsh-sidechat"]`；
2. 因为本包的 `package.json` 声明了 `dsh.bundle.patch`，DSH 自动把它追加进
   `dsh.profile.bundles`；
3. 在 `profiles/<profile>/node_modules/` 下建 junction / symlink 指向包目录。

## 第三步：重启 DSH

**必须重启，不是刷新页面。** 浏览器侧 bundle 由宿主启动时组装，`dsh-sidechat` 是全新条目，
页面刷新拿不到。

## 验证装上了

重启后打开任意会话，在输入框敲 `/` —— 命令列表里应该出现：

```
旁侧对话   side   在右侧边栏打开一个能对话的旁侧面板
```

左侧导航栏也应该多一项「旁侧对话」。

想从命令行确认配置树里有这条 bundle：

```bash
dsh --profile <profile> --dump-config
```

输出里应能找到一条 `id: dsh-sidechat` 的 insert 记录。

> 桌面端的 `desktop` profile 有时会拒绝 CLI 读配置（提示 profile 由 Electron 应用独占管理），
> 这是正常的，不影响安装 —— 以上面的 UI 检查为准。

## 找不到 dsh 命令

DSH 安装目录里带了一份 CLID，直接用它：

| 平台 | 位置 |
| --- | --- |
| Windows | `<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd` |
| macOS | `/Applications/DSH.app/Contents/Resources/runtime/cli/bin/dsh` |
| Linux | `<DSH 安装目录>/resources/runtime/cli/bin/dsh` |

把它加到 `PATH`，或者直接用全路径调用（Windows 上记得加引号，安装目录名里可能有空格）。

## 手工安装（CLI 不可用时）

手工装就是模拟上面那三步。

1. **建软链**，让 profile 的 `node_modules` 能找到这个包：

   ```powershell
   # Windows（PowerShell）
   New-Item -ItemType Junction `
     -Path "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\dsh-sidechat" `
     -Target "<源码目录>"
   ```

   ```bash
   # macOS / Linux
   ln -s "<源码目录>" ~/.dsh/profiles/<profile>/node_modules/dsh-sidechat
   ```

2. **编辑 profile 的 `package.json`**（`profiles/<profile>/package.json`）：

   ```jsonc
   {
     "dependencies": {
       "dsh-sidechat": "link:<源码目录>"     // 正斜杠
     },
     "dsh": {
       "profile": {
         "bundles": [
           // ...原有条目
           "dsh-sidechat"                     // 加在最后
         ]
       }
     }
   }
   ```

3. **重启 DSH。**

> 只把包拷进 `node_modules` 而不改这两处是**不生效**的：DSH 只认 bundle 列表里的条目。

## 卸载

```bash
dsh plugin --profile <profile> remove dsh-sidechat
```

手工装的：删掉 `node_modules` 里的软链，再从 `package.json` 的 `dependencies` 和
`dsh.profile.bundles` 两处删掉 `dsh-sidechat`，重启。

## 出问题时

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 左侧栏没有「旁侧对话」 | bundle 没进配置树 | 跑 `--dump-config` 看有没有 `dsh-sidechat`；确认重启过 |
| `/` 列表里没有 side | 客户端 bundle 没加载 | 开发者工具 Console 搜 `dsh-sidechat`；确认 `lib/client.js` 没语法错误 |
| 面板提示「先在主区打开一个会话」 | 强绑定要求有主会话 | 正常行为：先打开一个会话，面板自动跟它绑上 |
| 面板报「创建旁侧会话失败」 | 宿主会话服务不可用 | 看宿主日志；通常是 workspace 配置问题 |
| 旁侧没带上主会话上下文 | 主会话读取超时（5s） | Console 里会有一条 `[dsh-sidechat] 读取主会话上下文失败`；不影响提问本身 |
| 点发送没反应且无报错 | 会话引用没拿到 | Console 里应有一条 `[dsh-sidechat]` 报错；把 `lib/client.js` 报错行提 issue |

### 想彻底重置

绑定表按主会话 id 索引。换 profile 后旧的 id 都不存在了，面板会提示「已不存在」并自动重建，
一般不用手工干预。真要清零，开发者工具里执行：

```js
localStorage.removeItem('dsh-sidechat:bindings:v2')
```

然后刷新页面。

## 改完代码之后

- 只改了 `lib/client.js`：重启宿主（`link:` 安装时生效）；
- 改了 `cordis.patch.yml` / `package.json`：必须重启宿主；
- CI（`.github/workflows/test.yml`）跑的是 `node test/smoke.mjs`，纯 Node 无需 DSH。
