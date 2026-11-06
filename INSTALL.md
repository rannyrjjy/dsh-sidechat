# 安装 / 卸载

## 前提

- [DSH] 桌面端已在跑，profile 是 `desktop`（即 `%USERPROFILE%\.dsh\profiles\desktop`）。
- 用**与宿主同版本**的 CLI。桌面端自带一份，版本一定对得上：

  ```
  "%LOCALAPPDATA%\Programs\[DSH]\resources\runtime\cli\bin\dsh.cmd"
  ```

  全局 `dsh` 可能是更老的版本（0.1.x），别用它装。

## 推荐：一条命令

先拿到源码目录的绝对路径，然后：

```bash
dsh plugin --profile desktop add link:<源码目录绝对路径>
```

例如 Windows 上克隆到 `D:\code\dsh-sidechat`：

```bash
dsh plugin --profile desktop add link:D:/code/dsh-sidechat
```

`link:` 表示软链到源码目录 —— 改 `lib/client.js` 后只要重启宿主就生效，不用重新安装。
不想改源码的话，用 `file:` 指向 tgz 也行（装的是固定副本）。

这条命令会做三件事（`dsh plugin` 是 pnpm 的薄封装）：

1. 在 profile 的 `package.json` 里加 `dependencies["dsh-sidechat"]`；
2. 因为本包的 `package.json` 声明了 `dsh.bundle.patch`，DSH 自动把它追加进
   `dsh.profile.bundles`；
3. 建 junction/symlink：`profiles/desktop/node_modules/dsh-sidechat` → 源码目录。

**然后重启 [DSH]**：浏览器侧 bundle 由宿主启动时组装，`dsh-sidechat` 是全新条目，
页面刷新不够。

## 验证装上了

重启后打开任意会话，在输入框敲 `/` —— 命令列表里应该出现：

```
旁侧对话   side   在右侧边栏打开一个能对话的旁侧面板
```

左侧导航栏也应该多一项「旁侧对话」。

命令行侧可以这样确认配置树里有这条 bundle：

```bash
dsh.cmd --profile desktop --dump-config
```

输出里应能找到 `dsh-sidechat` 这条 insert 记录。

## 手工安装（命令不可用时）

1. 建 junction（把 `<源码目录>` 换成实际路径）：

   ```powershell
   New-Item -ItemType Junction `
     -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-sidechat" `
     -Target "<源码目录>"
   ```

2. 编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json`：
   - `dependencies` 加 `"dsh-sidechat": "link:<源码目录>"`（正斜杠）；
   - `dsh.profile.bundles` 数组末尾加 `"dsh-sidechat"`。

3. 重启 [DSH]。

> 只把包拷进 `node_modules` 而不改这两处是**不生效**的：DSH 只认 bundle 列表里的条目。

## 卸载

```bash
dsh.cmd plugin --profile desktop remove dsh-sidechat
```

手工装的把 junction 删掉、再从 `package.json` 的两处删掉 `dsh-sidechat`，重启即可。

## 出问题时

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 左侧栏没有「旁侧对话」 | bundle 没进配置树 | 跑 `--dump-config` 看有没有 `dsh-sidechat`；确认重启过 |
| `/` 列表里没有 side | 客户端 bundle 没加载 | 开发者工具 Console 搜 `dsh-sidechat`；确认 `lib/client.js` 没语法错误 |
| 面板提示「先在主区打开一个会话」 | 强绑定要求有主会话 | 正常行为：先打开一个会话，面板自动跟它绑上 |
| 面板报「创建旁侧会话失败」 | 宿主会话服务不可用 | 看宿主日志；通常是 workspace 配置问题 |
| 旁侧没带上主会话上下文 | 主会话读取超时（5s） | Console 里会有一条 `[dsh-sidechat] 读取主会话上下文失败`；不影响提问本身 |
| 点发送没反应且无报错 | 会话引用没拿到 | Console 里应有一条 `[dsh-sidechat]` 报错；把 `lib/client.js` 报错行贴出来 |

### 想彻底重置

绑定表按主会话 id 索引。换 profile 后旧的 id 都不存在了，面板会提示「已不存在」并自动重建，
一般不用手工干预。真要清零，开发者工具里执行：

```js
localStorage.removeItem('dsh-sidechat:bindings:v2')
```

然后刷新页面。

改完 `lib/client.js` 后：

- 只改了客户端：重启宿主（或 `pnpm run dev:web` 起着的 HMR 环境里直接刷新）；
- 改了 `cordis.patch.yml` / `package.json`：必须重启宿主。
