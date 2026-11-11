# @mindlink-ai/wechat-bot

个人微信 bot 的 DSH 插件：把「微信官方 iLink（ClawBot）通道」封装成

- **左侧边栏入口「微信bot」**：点开主面板即可看到连接状态、账号信息、扫码登录入口、最近推送与最近消息；
- **Agent 工具**：`wechat_status` / `wechat_login` / `wechat_send` / `wechat_recent`，供定时任务调用把日报推送到你的微信；
- **同源调试接口**：`/wechat-bot/state`、`/wechat-bot/login`、`/wechat-bot/send`（与 GUI 同端口，无独立端口暴露）。

## 安装（给其他 DSH 用户）

在 DSH 的插件管理器（左侧边栏「插件」→ 安装插件）里输入以下任一目标：

| 方式 | 输入 |
|---|---|
| npm 包名（推荐，发布后） | `@mindlink-ai/wechat-bot` |
| GitHub 仓库地址 | `https://github.com/<org>/wechat-bot-plugin` |
| 本地目录 | 插件目录绝对路径 |

安装后左侧边栏出现「微信bot」，工具列表出现 `wechat_*` 工具。

**运行要求**：DSH Web/桌面 profile（需要 `webServer`、`tools`、`sessionController` 服务）；手机微信需支持 ClawBot 插件；Node ≥ 20（由 DSH 自带，无需另装）。

## 发布到 npm（维护者）

```bash
cd wechat-bot-plugin

# 1) 登录 npm（@mindlink-ai scope 需属于你的 npm 账号或组织）
npm login

# 2) 发布（包已声明 publishConfig.access=public，scoped 包必须 public）
npm publish --access public

# 3) 验证
npm view @mindlink-ai/wechat-bot version
```

> 本机 npm 默认源可能指向失效镜像（如旧淘宝源）。发布前确认：
> `npm config get registry`，必要时 `npm config set registry https://registry.npmjs.org`。
> 若遇到 `EPERM` 缓存目录错误，可临时指定可写缓存：`npm publish --cache /tmp/npm-cache`。

升级流程：改代码 → `npm version patch`（或 minor/major）→ `git push --follow-tags` → `npm publish`。

## 首次使用

> 数据与配置目录：`~/.dsh/wechat-bot/`（`credentials.json` / `state.json` / `settings.json` / `push.log`），可用环境变量 `DSH_WECHAT_BOT_DIR` 覆盖。
> 会话转发的默认工作目录是用户主目录（`os.homedir()`）；如需指定，编辑 `settings.json` 的 `workspaceCwd`，例如 `"workspaceCwd": "D:\\\\projects\\\\wechat-chat"`。

1. 打开左侧边栏「微信bot」→ 点「开始 / 刷新登录」；
2. 面板出现二维码链接 → 复制到手机微信打开并确认；
3. 登录成功后，**在微信里给机器人发一条任意消息**（让 bot 记录 `context_token`）；
4. 回到面板点「发送到微信」验证链路；
5. 定时任务里调用 `wechat_send`（可传日报文件绝对路径）。

## 数据与凭证

- 状态与凭证目录：`~/.dsh/wechat-bot/`（`credentials.json` / `state.json` / `settings.json` / `push.log`）
- 可用环境变量 `DSH_WECHAT_BOT_DIR` 覆盖；
- 首次启动会尝试从旧版桥接目录 `E:\Administrator\Documents\daily-news\wechat` 迁移凭证与上下文，无需重复扫码（若旧凭证仍有效）。

## 作者信息

- 作者：思链科技（MindLink）
- 插件：`@mindlink-ai/wechat-bot` v1.0.0
- 通道：微信官方 iLink（ClawBot）；本地优先，聊天数据只留在本机
- 许可：MIT

## 页面与路径

- 侧边栏入口：`sidebar.panellist` 注册项 `id = wechat-bot`（不是独立 URL 路由，点击切换主面板）
- 主面板：`main` keyed slot，`key = wechat-bot`（渲染文件 `client.js`）
- Host 同源调试页：`http://127.0.0.1:<GUI端口>/wechat-bot/`
- 状态接口：`/wechat-bot/state`

## 其他插件如何调用

### 方式 1：Host 服务 `wechatBot`（推荐，同进程零网络）

其他 Host 插件声明依赖后直接调用：

```js
// 你的插件 index.js
export const inject = ['wechatBot']

export function apply(ctx) {
  const bot = ctx.get('wechatBot')

  // 1) 推送一段文本
  await bot.send('日报已生成，请查收')

  // 2) 推送日报文件：自动压缩成群发版短消息 + 1900 字节分片
  await bot.sendFile('E:\\Administrator\\Documents\\daily-news\\2026-11-11-应急行业日报.md')

  // 3) 查状态 / 最近消息
  const state = bot.status()   // { connection, account, lastPush, counters, ... }
  const msgs = bot.recent(20)  // 最近收到的入站消息（仅元数据）

  // 4) 登录控制（一般交给面板，脚本化时才用）
  await bot.login('start')     // start | refresh | logout
}
```

返回值约定：`{ ok, chunks, chars, target }`；失败为 `{ ok:false, error, message }`，`error` 取值：
`not_logged_in`（未扫码）、`not_online`（连接失效/异常）、`no_context`（需要先给机器人发一条消息）、`read_failed`、`send_failed`。

服务方法：

| 方法 | 说明 |
|---|---|
| `status()` | 连接状态 + 账号 + 计数 + 最近推送 |
| `send(text, opts?)` | 推送文本，`opts.source` 仅用于审计 |
| `sendFile(path)` | 读取日报 Markdown → 压缩 → 分片推送 |
| `sendDigest(path)` | `sendFile` 的别名 |
| `login(action)` | `start` / `refresh` / `logout` |
| `recent(limit)` | 最近入站消息（≤100） |

> 服务在插件激活时通过 `ctx.provide('wechatBot', api)` 注册；依赖方 `inject: ['wechatBot']` 后 Cordis 会自动等待该服务可用。

### 方式 2：同源 HTTP（跨进程 / Client 插件可用）

与 DSH Web GUI 同端口，仅同源请求通过：

```
GET  /wechat-bot/state        → 连接/账号/计数状态
GET  /wechat-bot/qr.png       → 当前登录二维码 PNG（登录中才有）
POST /wechat-bot/login        → { "action": "start" | "cancel" | "logout" }
POST /wechat-bot/send         → { "text": "要推送的文本" }
```

Host 插件里拿端口：`ctx.get('webServer')?.getOrigin()`。

### 方式 3：Agent 工具（给模型用，不是给插件用）

`wechat_status` / `wechat_login` / `wechat_send` / `wechat_recent` 由 Agent 在会话中调用（定时任务走这条）；插件代码不要依赖工具，直接走方式 1。

### 示例

见 [examples/consumer-plugin](E:\Administrator\Documents\wechat-bot-plugin\examples\consumer-plugin)：一个最小插件，`inject: ['wechatBot']` 后调用 `sendFile` 推送日报。

## 微信侧指令与消息路由

微信发给机器人的消息按规则分流：

- **以 `/` 开头的消息 = 指令**，直接由插件处理并回复，不进入 DSH 会话：
  | 指令 | 作用 |
  |---|---|
  | `/help` | 指令列表 |
  | `/status` | 连接、账号、计数、最近推送 |
  | `/login` | 扫码登录，回复二维码链接 |
  | `/logout` | 退出登录 |
  | `/recent` | 最近收到的消息 |
  | `/news` | 让 DSH 跑今天的新闻简报（转交会话，结果回传） |
  | `/new` | 重置对话会话，下一条消息新建 DSH 会话 |
- **其余消息全部转交给 DSH 会话**：插件通过 `sessionController.prompt()` 把文本作为用户消息注入 `chatSessionId` 对应的会话（未设置时自动新建，cwd 默认 `E:\Administrator\Documents`），Agent 处理完后，插件在 `turn/end` 时把本轮助手文本回传微信。

实现位置：`index.js` 的「微信 ⇄ DSH 会话转发」段（`forwardToChat` / `flushChatTurn` / `session/event` 监听）。会话转发可通过 `settings.chatForward` 关闭。

## 已知限制

- **二维码渲染为纯 JS**：登录二维码由随插件打包的 `vendor/qrcode.cjs`（qrcode-generator，MIT，© Kazuhiko Arase）在 Host 进程内生成 GIF data URL，然后在面板中以 `<img>` 直接显示；不依赖 Python、不访问网络。

- iLink 会话约 24 小时过期，过期后需要重新扫码（面板会提示「连接失效」）；
- 个人微信群无法加入官方机器人，因此推送目标是**你与机器人的 1:1 会话**，群里需要手动转发一次；
- 推送依赖最近一次入站消息带来的 `context_token`：长时间没人给机器人发消息时，可能需要先发一句任意内容。
