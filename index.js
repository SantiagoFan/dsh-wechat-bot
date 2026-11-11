/**
 * Host half of @local/wechat-bot.
 *
 * 通过微信官方 iLink（ClawBot）通道把个人微信桥接进 DSH：
 *  - 扫码登录（二维码链接在侧边栏面板里）；长轮询保持会话、刷新 context_token；
 *  - Agent 工具：wechat_status / wechat_login / wechat_send / wechat_recent；
 *  - 同源 HTTP 路由 /wechat-bot/* 供侧边栏面板读取状态、触发登录与测试推送。
 *
 * 状态与凭证保存在 ~/.dsh/wechat-bot/（可用环境变量 DSH_WECHAT_BOT_DIR 覆盖）；
 * 首次启动会尝试从旧版 daily-news/wechat 目录迁移凭证与群/私聊上下文。
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getBotQrcode, pollQrcodeStatus, getUpdates, sendText, ILinkError } from './bridge/ilink.js'
import { renderDigest, chunkByBytes } from './bridge/render.js'

export const name = 'wechat-bot'
export const inject = ['tools']

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.DSH_WECHAT_BOT_DIR || path.join(os.homedir(), '.dsh', 'wechat-bot')
const TEXT_LIMIT = 1900
const RECENT_MAX = 100

export function apply(ctx) {
  const settingsFile = path.join(DATA_DIR, 'settings.json')
  const credFile = path.join(DATA_DIR, 'credentials.json')
  const stateFile = path.join(DATA_DIR, 'state.json')
  const pushLogFile = path.join(DATA_DIR, 'push.log')
  const dirs = [DATA_DIR]

  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })

  const readJson = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  }
  const writeJson = (file, value, mode) => {
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode })
    fs.renameSync(tmp, file)
  }

  // --------------------------------------------------------------- QR 渲染（纯 JS）
  // 登录二维码内容是一个 liteapp 链接；用随插件打包的 qrcode-generator（MIT）在本地生成
  // GIF data URL，不依赖 Python、不访问网络。
  let qrcodeLib = null
  try {
    qrcodeLib = createRequire(import.meta.url)('./vendor/qrcode.cjs')
  } catch (error) {
    qrcodeLib = null
    ctx.logger?.warn?.(`[wechat-bot] qrcode vendor unavailable: ${error?.message ?? error}`)
  }

  /** 返回 data:image/gif;base64,... 或空串 */
  function renderQrDataUrl(text) {
    try {
      if (!qrcodeLib) return ''
      const qr = qrcodeLib(0, 'M')
      qr.addData(String(text))
      qr.make()
      return qr.createDataURL(6, 2)
    } catch (error) {
      ctx.logger?.warn?.(`[wechat-bot] qr render failed: ${error?.message ?? error}`)
      return ''
    }
  }

  // ---------------------------------------------------------------- settings
  const settings = {
    mode: 'direct',
    targetUserId: '',
    maxChars: TEXT_LIMIT,
    autoStart: true,
    legacyDir: '',
    chatForward: true,
    chatSessionId: '',
    workspaceCwd: os.homedir(),
    ...(readJson(settingsFile) || {}),
  }
  const saveSettings = () => {
    try {
      writeJson(settingsFile, settings)
    } catch (error) {
      ctx.logger?.warn?.(`[wechat-bot] cannot save settings: ${error?.message ?? error}`)
    }
  }

  // ---------------------------------------------------------- credentials/state
  const saved = readJson(credFile)
  let creds = saved && saved.token ? saved : null
  const persisted = readJson(stateFile) || {}
  const rt = {
    creds,
    conn: { state: creds ? 'connecting' : 'unpaired', error: '', since: Date.now() },
    account: creds
      ? { botId: creds.accountId || '', userId: creds.userId || '', baseUrl: creds.baseUrl || '', savedAt: creds.savedAt || '' }
      : { botId: '', userId: '', baseUrl: '', savedAt: '' },
    qr: { url: '', ts: 0, active: false, dataUrl: '' },
    cursor: typeof persisted.cursor === 'string' ? persisted.cursor : '',
    directs: persisted.directs && typeof persisted.directs === 'object' ? persisted.directs : {},
    loginGen: 0,
    counters: { received: 0, sent: 0, failed: 0, drops: 0 },
    lastPush: persisted.lastPush || { at: 0, ok: false, error: '', chunks: 0, chars: 0 },
    recent: [],
    pushLog: [],
  }
  let stops = { poll: new AbortController(), login: 0 }
  let disposed = false

  const saveState = () => {
    try {
      writeJson(stateFile, {
        version: 1,
        cursor: rt.cursor,
        directs: rt.directs,
        lastPush: rt.lastPush,
        updatedAt: Date.now(),
      })
    } catch (error) {
      ctx.logger?.warn?.(`[wechat-bot] cannot save state: ${error?.message ?? error}`)
    }
  }

  const pushAudit = (entry) => {
    try {
      fs.appendFileSync(pushLogFile, `${JSON.stringify({ ts: Date.now(), ...entry })}\n`)
    } catch {
      /* 审计写入失败不影响主流程 */
    }
  }

  /** 设置当前登录二维码，并生成 GIF data URL（渲染失败则面板回退为链接） */
  function setQr(qr) {
    rt.qr = { url: qr.url, ts: Date.now(), active: true, base: qr.base, dataUrl: renderQrDataUrl(qr.url) }
    return rt.qr
  }

  // ------------------------------------------------------------- legacy import
  try {
    const legacy = settings.legacyDir
    const legacyCred = legacy ? path.join(legacy, 'secrets', 'credentials.json') : ''
    const legacyState = legacy ? path.join(legacy, 'state.json') : ''
    if (!creds && legacyCred && fs.existsSync(legacyCred)) {
      const value = JSON.parse(fs.readFileSync(legacyCred, 'utf8'))
      if (value?.token) {
        creds = {
          version: 1,
          token: value.token,
          accountId: value.accountId || '',
          userId: value.userId || '',
          baseUrl: value.baseUrl || 'https://ilinkai.weixin.qq.com',
          savedAt: value.savedAt || new Date().toISOString(),
        }
        rt.creds = creds
        rt.account = { botId: creds.accountId, userId: creds.userId, baseUrl: creds.baseUrl, savedAt: creds.savedAt }
        writeJson(credFile, creds, 0o600)
        rt.conn = { state: 'connecting', error: '', since: Date.now() }
        ctx.logger?.info?.('[wechat-bot] imported legacy credentials')
      }
    }
    const legacyCtx = legacyState && fs.existsSync(legacyState) ? JSON.parse(fs.readFileSync(legacyState, 'utf8')) : null
    if (legacyCtx) {
      if (!rt.cursor && typeof legacyCtx.cursor === 'string') rt.cursor = legacyCtx.cursor
      const directs = legacyCtx.directs && typeof legacyCtx.directs === 'object' ? legacyCtx.directs : {}
      for (const [uid, value] of Object.entries(directs)) {
        if (!rt.directs[uid] && value?.contextToken) rt.directs[uid] = value
      }
      if (!settings.targetUserId) {
        const ids = Object.keys(rt.directs)
        if (ids.length) settings.targetUserId = ids[0]
      }
      if (rt.cursor || Object.keys(directs).length) saveState()
      ctx.logger?.info?.('[wechat-bot] imported legacy cursor/context tokens')
    }
  } catch (error) {
    ctx.logger?.warn?.(`[wechat-bot] legacy import skipped: ${error?.message ?? error}`)
  }

  // ------------------------------------------------------------------ runtime
  const setConn = (state, error = '') => {
    if (rt.conn.state !== state) rt.conn = { ...rt.conn, state, error, since: Date.now() }
    else rt.conn.error = error
  }

  let polling = false
  async function pollLoop() {
    if (polling || disposed || !rt.creds) return
    polling = true
    const controller = stops.poll
    let failures = 0
    setConn('online')
    try {
      while (!disposed && !controller.signal.aborted) {
        try {
          const { msgs, cursor } = await getUpdates(rt.creds, rt.cursor, controller.signal, 35000)
          failures = 0
          if (cursor) rt.cursor = cursor
          let changed = Boolean(cursor)
          for (const msg of Array.isArray(msgs) ? msgs : []) {
            rt.counters.received += 1
            rt.recent.push({
              at: Date.now(),
              from: msg?.from_user_id || '',
              group: typeof msg?.group_id === 'string' ? msg.group_id : '',
              text: (msg?.item_list || []).map((i) => i?.text_item?.text).filter(Boolean).join(' ').slice(0, 300),
            })
            if (rt.recent.length > RECENT_MAX) rt.recent.splice(0, rt.recent.length - RECENT_MAX)
            const uid = msg?.from_user_id
            const isGroup = typeof msg?.group_id === 'string' && msg.group_id
            if (isGroup) {
              rt.counters.drops += 1
              continue
            }
            if (msg?.message_type === 2) {
              /* 机器人回显 */
              continue
            }
            const text = (msg?.item_list || []).map((i) => i?.text_item?.text).filter(Boolean).join(' ').trim()
            if (typeof uid === 'string' && uid.endsWith('@im.wechat') && msg?.context_token) {
              const token = String(msg.context_token)
              rt.directs[uid] = { contextToken: token, updatedAt: Date.now(), text: '' }
              changed = true
              if (text.startsWith('/')) void handleCommand(text, uid, token)
              else if (text && settings.chatForward) void forwardToChat(text, uid, token)
            }
          }
          if (changed) saveState()
          if (rt.conn.state !== 'online') setConn('online')
        } catch (error) {
          if (error?.code === 'session-expired') {
            setConn('expired', '微信连接已失效（-14），请重新扫码登录')
            saveState()
            break
          }
          failures += 1
          setConn(failures >= 3 ? 'error' : rt.conn.state, error?.message || String(error))
          await new Promise((resolve) => setTimeout(resolve, failures >= 3 ? 30000 : 2000))
        }
      }
    } finally {
      polling = false
    }
  }

  // 登录：beginLogin 立即返回当前二维码（非阻塞），runLogin 在后台轮询扫码结果
  async function beginLogin() {
    const gen = ++rt.loginGen
    const qr = await getBotQrcode(creds?.baseUrl || undefined)
    await setQr(qr)
    setConn(creds ? 'connecting' : 'unpaired', '等待手机微信扫码确认')
    void runLogin(gen, qr)
    return { ok: true, online: false, url: rt.qr.url, hasQr: Boolean(rt.qr.dataUrl) }
  }

  async function runLogin(gen, qr) {
    try {
      while (!disposed && rt.loginGen === gen) {
        const status = await pollQrcodeStatus(qr.qrcode, qr.base)
        if (rt.loginGen !== gen) return
        if (status.status === 'expired') {
          const next = await getBotQrcode(creds?.baseUrl || undefined)
          qr = next
          await setQr(next)
          setConn(creds ? 'connecting' : 'unpaired', '二维码已刷新，等待手机微信扫码确认')
          continue
        }
        if (status.status === 'scaned') {
          setConn('connecting', '已扫码，等待手机端确认')
          continue
        }
        if (status.status === 'confirmed') {
          if (!status.bot_token || !status.ilink_bot_id) throw new Error('登录确认但未返回完整凭证')
          creds = {
            version: 1,
            token: status.bot_token,
            accountId: status.ilink_bot_id,
            userId: status.ilink_user_id || '',
            baseUrl: status.baseurl || qr.base || 'https://ilinkai.weixin.qq.com',
            savedAt: new Date().toISOString(),
          }
          rt.creds = creds
          rt.account = { botId: creds.accountId, userId: creds.userId, baseUrl: creds.baseUrl, savedAt: creds.savedAt }
          writeJson(credFile, creds, 0o600)
          rt.qr = { url: '', ts: 0, active: false, dataUrl: '' }
          rt.cursor = ''
          rt.directs = {}
          rt.loginGen = 0
          saveState()
          setConn('online')
          pollLoop()
          return
        }
      }
    } catch (error) {
      setConn('error', error?.message || String(error))
      rt.qr = { ...rt.qr, active: false }
    }
  }

  function logout() {
    rt.loginGen = 0
    rt.qr = { url: '', ts: 0, active: false, dataUrl: '' }
    stops.poll.abort()
    stops.poll = new AbortController()
    rt.creds = null
    creds = null
    try {
      fs.rmSync(credFile, { force: true })
    } catch {
      /* ignore */
    }
    rt.cursor = ''
    saveState()
    setConn('unpaired', '')
    return { ok: true, online: false }
  }

  // -------------------------------------------------------------------- push
  function pickTarget() {
    const uid = settings.targetUserId && rt.directs[settings.targetUserId] ? settings.targetUserId : null
    if (uid) return { uid, token: rt.directs[uid]?.contextToken || '' }
    const ids = Object.keys(rt.directs)
    if (!ids.length) return null
    ids.sort((a, b) => (rt.directs[b]?.updatedAt || 0) - (rt.directs[a]?.updatedAt || 0))
    return { uid: ids[0], token: rt.directs[ids[0]]?.contextToken || '' }
  }

  async function pushText(rawText, { source = 'tool' } = {}) {
    if (!rt.creds) return { ok: false, error: 'not_logged_in', message: '微信 bot 尚未登录，请先在面板中扫码登录' }
    if (rt.conn.state !== 'online') return { ok: false, error: 'not_online', message: `连接状态：${rt.conn.state}（${rt.conn.error || '未就绪'}）` }
    const target = pickTarget()
    if (!target?.token) {
      return { ok: false, error: 'no_context', message: '还没有可推送的会话凭证：请在微信里给机器人发一条任意消息，让 bot 记录 context_token' }
    }
    const maxChars = Math.max(200, Number(settings.maxChars) || TEXT_LIMIT)
    const chunks = chunkByBytes(String(rawText || '').trim(), maxChars).slice(0, 3)
    if (!chunks[0]) return { ok: false, error: 'empty', message: '没有可发送的内容' }
    const sent = []
    for (const chunk of chunks) {
      try {
        await sendText(rt.creds, { toUserId: target.uid, contextToken: target.token, text: chunk })
        sent.push(chunk.length)
        rt.counters.sent += 1
      } catch (error) {
        rt.counters.failed += 1
        rt.lastPush = { at: Date.now(), ok: false, error: error?.message || String(error), chunks: sent.length, chars: sent.reduce((a, b) => a + b, 0) }
        if (error?.code === 'session-expired') setConn('expired', '微信连接已失效（-14），请重新扫码登录')
        saveState()
        pushAudit({ ok: false, source, target: target.uid, error: error?.message || String(error) })
        return { ok: false, error: error?.code || 'send_failed', message: error?.message || String(error), chunks: sent.length }
      }
      if (chunk !== chunks[chunks.length - 1]) await new Promise((resolve) => setTimeout(resolve, 1200))
    }
    rt.lastPush = { at: Date.now(), ok: true, error: '', chunks: sent.length, chars: sent.reduce((a, b) => a + b, 0) }
    saveState()
    pushAudit({ ok: true, source, target: target.uid, chunks: sent.length, chars: rt.lastPush.chars })
    return { ok: true, chunks: sent.length, chars: rt.lastPush.chars, target: target.uid }
  }

  // ------------------------------------------------------- 微信 ⇄ DSH 会话转发
  const chatPending = []
  let chatAccum = ''

  /** 直接回复到当前微信会话（使用入站消息带来的最新 context_token） */
  async function sendToWeChat(uid, token, body) {
    if (!rt.creds) return { ok: false, error: 'not_logged_in' }
    const chunks = chunkByBytes(String(body ?? '').trim(), Math.max(200, Number(settings.maxChars) || TEXT_LIMIT)).slice(0, 3)
    if (!chunks[0]) return { ok: false, error: 'empty' }
    for (let i = 0; i < chunks.length; i += 1) {
      await sendText(rt.creds, { toUserId: uid, contextToken: token, text: chunks[i] })
      rt.counters.sent += 1
      if (i < chunks.length - 1) await new Promise((resolve) => setTimeout(resolve, 1200))
    }
    return { ok: true, chunks: chunks.length }
  }

  const helpText = () =>
    [
      '可用指令：',
      '/help    查看指令',
      '/status  连接与账号状态',
      '/login   扫码登录（返回二维码链接）',
      '/logout  退出登录',
      '/recent  最近收到的消息',
      '/news    让 DSH 跑今天的新闻简报',
      '/new     重置对话会话（下一条消息新建 DSH 会话）',
      '',
      '其余消息会转交给 DSH 会话处理，处理结果自动回传到微信。',
    ].join('\n')

  async function ensureChatSession() {
    if (settings.chatSessionId) return settings.chatSessionId
    const sessions = ctx.get('sessionController')
    if (!sessions) return ''
    const created = await sessions.create({ cwd: settings.workspaceCwd })
    settings.chatSessionId = created?.sessionId || ''
    if (settings.chatSessionId) saveSettings()
    return settings.chatSessionId
  }

  /** 把一条微信消息转交给 DSH 会话；回合结束后由 flushChatTurn 回传 */
  async function forwardToChat(text, uid, token) {
    const sessions = ctx.get('sessionController')
    if (!sessions) {
      await sendToWeChat(uid, token, 'DSH 会话服务不可用，消息未转交').catch(() => {})
      return { ok: false, error: 'no_session_service' }
    }
    try {
      const sessionId = await ensureChatSession()
      if (!sessionId) {
        await sendToWeChat(uid, token, '无法创建 DSH 会话，消息未转交').catch(() => {})
        return { ok: false, error: 'no_session' }
      }
      chatPending.push({ uid, token, at: Date.now() })
      if (chatPending.length > 20) chatPending.shift()
      await sessions.prompt(
        { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }] },
        new AbortController().signal,
      )
      return { ok: true, sessionId }
    } catch (error) {
      chatPending.pop()
      await sendToWeChat(uid, token, `转交 DSH 会话失败：${error?.message || error}`).catch(() => {})
      return { ok: false, error: 'prompt_failed', message: error?.message || String(error) }
    }
  }

  /** 一个 DSH 回合结束：把这轮助手文本回传到发起消息的微信会话 */
  function flushChatTurn() {
    if (!chatPending.length) {
      chatAccum = ''
      return
    }
    const pendingTurn = chatPending.shift()
    const text = chatAccum.trim()
    chatAccum = ''
    const body = text || '（本轮没有文本回复，完整过程见 DSH 会话）'
    void sendToWeChat(pendingTurn.uid, pendingTurn.token, body).catch((error) => {
      ctx.logger?.warn?.(`[wechat-bot] chat reply failed: ${error?.message ?? error}`)
    })
  }

  async function handleCommand(text, uid, token) {
    const [cmd] = String(text).split(/\s+/)
    const name = (cmd || '').toLowerCase()
    try {
      if (name === '/help') return await sendToWeChat(uid, token, helpText())
      if (name === '/status') {
        const body = [
          `连接：${rt.conn.state}${rt.conn.error ? `（${rt.conn.error}）` : ''}`,
          `bot：${rt.account.botId || '—'}`,
          `计数：收 ${rt.counters.received} / 发 ${rt.counters.sent} / 失败 ${rt.counters.failed}`,
          `最近推送：${rt.lastPush.at ? `${new Date(rt.lastPush.at).toLocaleString()} ${rt.lastPush.ok ? '成功' : '失败'}` : '无'}`,
        ].join('\n')
        return await sendToWeChat(uid, token, body)
      }
      if (name === '/login') {
        const result = await beginLogin()
        return await sendToWeChat(uid, token, result.url ? `请用手机微信打开链接并确认登录：\n${result.url}` : '二维码获取失败，请稍后重试')
      }
      if (name === '/logout') {
        logout()
        return await sendToWeChat(uid, token, '已退出登录，可在 DSH 侧边栏「微信bot」重新扫码')
      }
      if (name === '/recent') {
        const list = rt.recent.slice(-8).map((item) => `- ${new Date(item.at).toLocaleTimeString()} ${item.text || '[非文本]'}`)
        return await sendToWeChat(uid, token, list.length ? `最近消息：\n${list.join('\n')}` : '暂无消息')
      }
      if (name === '/news') return await forwardToChat('跑今天的新闻简报', uid, token)
      if (name === '/new') {
        settings.chatSessionId = ''
        saveSettings()
        chatAccum = ''
        chatPending.length = 0
        return await sendToWeChat(uid, token, '已重置对话会话，下一条消息将新建 DSH 会话')
      }
      return await sendToWeChat(uid, token, `未知指令：${cmd}\n\n${helpText()}`)
    } catch (error) {
      await sendToWeChat(uid, token, `指令执行失败：${error?.message || error}`).catch(() => {})
      return { ok: false, error: 'command_failed' }
    }
  }

  function buildState() {
    return {
      ok: true,
      connection: { state: rt.conn.state, error: rt.conn.error, since: rt.conn.since },
      account: { ...rt.account, userIdConfigured: settings.targetUserId === rt.account.userId },
      qr: { url: rt.qr.url, ts: rt.qr.ts, active: rt.qr.active, hasQr: Boolean(rt.qr.dataUrl), dataUrl: rt.qr.dataUrl },
      counters: { ...rt.counters },
      lastPush: { ...rt.lastPush },
      recent: rt.recent.slice(-20),
      service: { name: 'wechatBot', methods: ['status', 'send', 'sendFile', 'sendDigest', 'login', 'recent'] },
      settings: {
        mode: settings.mode,
        maxChars: settings.maxChars,
        autoStart: settings.autoStart,
        targetUserId: settings.targetUserId,
        chatForward: Boolean(settings.chatForward),
        chatSessionId: settings.chatSessionId,
      },
      updatedAt: Date.now(),
    }
  }

  function pushFromFile(filePath) {
    try {
      return pushText(renderDigest(fs.readFileSync(String(filePath), 'utf8')), { source: 'file' })
    } catch (error) {
      return Promise.resolve({ ok: false, error: 'read_failed', message: `读取日报失败：${error?.message ?? error}` })
    }
  }

  // -------------------------------------------------------------------- tools
  const textResult = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  const tools = [
    {
      name: 'wechat_status',
      description:
        '查看本机微信 bot 的连接状态与账号信息：是否已登录、在线/失效、bot 与用户 ID、是否有待扫码的二维码、最近一次推送结果。推送前或连接异常时先调用。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => textResult(value) },
      async execute() {
        return buildState()
      },
    },
    {
      name: 'wechat_login',
      description:
        '微信 bot 扫码登录控制。action=start 生成/轮询登录二维码，返回 qrUrl 供用户在手机微信中打开确认；action=refresh 重新生成二维码；action=logout 退出登录并删除本地凭证。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'refresh', 'logout', 'cancel'], description: '登录动作' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => textResult(value) },
      timeoutMs: 30000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const action = String(args?.action ?? 'start')
        if (action === 'logout') return logout()
        if (action === 'cancel') {
          rt.loginGen += 1
          rt.qr = { url: '', ts: 0, active: false, dataUrl: '' }
          setConn(rt.creds ? 'online' : 'unpaired', '')
          return { ok: true, action, online: rt.conn.state === 'online', qrUrl: '' }
        }
        if (action === 'refresh') {
          rt.loginGen += 1
          rt.qr = { url: '', ts: 0, active: false, dataUrl: '' }
        }
        const value = await beginLogin()
        return { ok: value.ok !== false, action, online: rt.conn.state === 'online', qrUrl: rt.qr.url, connection: rt.conn.state, hint: rt.qr.url ? '在手机微信中打开 qrUrl 确认登录' : '' }
      },
    },
    {
      name: 'wechat_send',
      description:
        '把文本推送到你本人的微信（1:1 会话）。text 直接给内容；file 给工作区里日报 Markdown 的绝对路径，会自动压缩成“今日速览 + 每主题 1 条 + 链接”的短消息并按 1900 字节分片。推送前会自动检查登录与最近会话凭证。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要推送的文本（与 file 二选一）' },
          file: { type: 'string', description: '日报 Markdown 绝对路径（与 text 二选一）' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => textResult(value) },
      timeoutMs: 40000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const file = String(args?.file ?? '').trim()
        if (file) return pushFromFile(file)
        return pushText(String(args?.text ?? '').trim(), { source: 'tool' })
      },
    },
    {
      name: 'wechat_recent',
      description: '读取微信 bot 最近收到的消息（仅元数据，最多 100 条），用于确认 context_token 是否新鲜、排查收不到消息的原因。',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: '返回条数，默认 20，最大 100' } },
        additionalProperties: false,
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => textResult(value) },
      async execute(args) {
        const limit = Math.max(1, Math.min(100, Number(args?.limit ?? 20) || 20))
        return { ok: true, count: rt.recent.length, messages: rt.recent.slice(-limit) }
      },
    },
  ]

  for (const tool of tools) ctx.effect(() => ctx.tools.register(tool))

  // ------------------------------------------------- Host service（供其他插件调用）
  // 其他插件声明 inject: ['wechatBot'] 后即可 ctx.get('wechatBot') 使用：
  //   api.status() / api.send(text) / api.sendFile(mdPath) / api.sendDigest(mdPath) / api.login(action) / api.recent(limit)
  const api = {
    version: '1.0.0',
    status: () => buildState(),
    send: (text, options = {}) => pushText(String(text ?? ''), { source: options.source || 'service' }),
    sendFile: (filePath) => pushFromFile(filePath),
    sendDigest: (filePath) => pushFromFile(filePath),
    login: async (action = 'start') => {
      if (action === 'logout') return logout()
      if (action === 'cancel') {
        rt.loginGen += 1
        rt.qr = { url: '', ts: 0, active: false, dataUrl: '' }
        setConn(rt.creds ? 'online' : 'unpaired', '')
        return { ok: true, online: rt.conn.state === 'online' }
      }
      if (action === 'refresh') {
        rt.loginGen += 1
        rt.qr = { url: '', ts: 0, active: false, dataUrl: '' }
      }
      return beginLogin()
    },
    recent: (limit = 20) => rt.recent.slice(-Math.max(1, Math.min(100, Number(limit) || 20))),
  }
  if (typeof ctx.provide === 'function') {
    ctx.effect(() => ctx.provide('wechatBot', api))
  } else {
    ctx.logger?.warn?.('[wechat-bot] ctx.provide unavailable: wechatBot service not exposed')
  }

  // ---------------------------------------------------------------- web routes
  const web = ctx.get('webServer')
  if (web && typeof web.register === 'function') {
    const origin = () => {
      try {
        return web.getOrigin?.() || ''
      } catch {
        return ''
      }
    }
    const sendJson = (res, value, status = 200) => {
      const body = JSON.stringify(value)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
    }
    const readBody = (req) =>
      new Promise((resolve, reject) => {
        let raw = ''
        req.setEncoding('utf8')
        req.on('data', (chunk) => {
          raw += chunk
          if (raw.length > 1024 * 1024) {
            reject(new Error('request body too large'))
            req.destroy()
          }
        })
        req.on('end', () => resolve(raw))
        req.on('error', reject)
      })
    const page = () => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>微信 bot</title>
<style>body{font:14px/1.6 system-ui,sans-serif;max-width:760px;margin:32px auto;padding:0 16px;color:#111}
pre{background:#f5f5f5;padding:10px;border-radius:8px;overflow:auto;max-height:420px}</style></head>
<body><h2>微信 bot（调试页）</h2><p>正式界面在左侧边栏的「微信bot」按钮里。</p><pre id="s">加载中…</pre>
<script>fetch('/wechat-bot/state').then(r=>r.json()).then(s=>{document.getElementById('s').textContent=JSON.stringify(s,null,2)})</script></body></html>`

    // 注意：webServer 的 resource 形式只接受 GET/HEAD；面板需要 POST，必须用 handler 形式。
    ctx.effect(() =>
      web.register({
        kind: 'prefix',
        path: '/wechat-bot',
        handler: async (req, res) => {
          try {
            const url = new URL(req.url || '/', 'http://127.0.0.1')
            const method = (req.method || 'GET').toUpperCase()
            if (method === 'GET' && url.pathname === '/wechat-bot/state') return sendJson(res, buildState())
            if (method === 'GET' && url.pathname === '/wechat-bot/qr.png') {
              if (!rt.qr.dataUrl) {
                res.writeHead(404, { 'cache-control': 'no-store' })
                return res.end('no qr')
              }
              const comma = rt.qr.dataUrl.indexOf(',')
              const meta = rt.qr.dataUrl.slice(5, comma) // e.g. image/gif;base64
              const mime = meta.split(';')[0] || 'image/gif'
              const bytes = Buffer.from(rt.qr.dataUrl.slice(comma + 1), 'base64')
              res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store', 'content-length': bytes.length })
              return res.end(bytes)
            }
            if (method === 'GET' && url.pathname === '/wechat-bot/') {
              const html = page()
              res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
              return res.end(html)
            }
            if (method === 'POST') {
              const originHeader = req.headers.origin || ''
              const own = origin()
              if (originHeader && own && !originHeader.startsWith(own) && !originHeader.startsWith('http://127.0.0.1')) {
                return sendJson(res, { ok: false, error: 'cross-origin request refused' }, 403)
              }
              let body = {}
              try {
                body = JSON.parse((await readBody(req)) || '{}')
              } catch {
                return sendJson(res, { ok: false, error: 'invalid json' }, 400)
              }
              const action = String(body.action || '')
              if (url.pathname === '/wechat-bot/login') {
                if (action === 'logout') {
                  logout()
                  return sendJson(res, { ok: true, state: buildState() })
                }
                if (action === 'cancel') {
                  rt.loginGen += 1
                  rt.qr = { url: '', ts: 0, active: false, dataUrl: '' }
                  setConn(rt.creds ? 'online' : 'unpaired', '')
                  return sendJson(res, { ok: true, state: buildState() })
                }
                const result = await beginLogin()
                return sendJson(res, { ...result, state: buildState() })
              }
              if (url.pathname === '/wechat-bot/send') {
                const text = String(body.text || '').trim()
                if (!text) return sendJson(res, { ok: false, error: 'text required' }, 400)
                return sendJson(res, await pushText(text, { source: 'panel' }))
              }
              return sendJson(res, { ok: false, error: 'unknown route' }, 404)
            }
            res.writeHead(405, { allow: 'GET, POST', 'content-type': 'text/plain; charset=utf-8' })
            res.end('method not allowed')
          } catch (error) {
            ctx.logger?.warn?.(`[wechat-bot] http handler failed: ${error?.message ?? error}`)
            if (res.headersSent) {
              res.destroy()
              return
            }
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('internal error')
          }
        },
      }),
    )
  } else {
    ctx.logger?.warn?.('[wechat-bot] web server unavailable: sidebar panel state endpoint disabled')
  }

  // ------------------------------------------------------------------ lifecycle
  // 会话事件：累积本回合助手文本，turn/end 时把结果回传到微信
  const onSessionEvent = (session, event) => {
    try {
      const sid = typeof session === 'string' ? session : session?.id
      if (!settings.chatSessionId || sid !== settings.chatSessionId) return
      if (event?.type === 'turn/start') {
        chatAccum = ''
        return
      }
      if (event?.type === 'assistant/message') {
        const content = event?.data?.message?.content
        if (Array.isArray(content)) {
          const text = content
            .filter((block) => block?.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('')
          if (text) chatAccum = chatAccum ? `${chatAccum}\n${text}` : text
        }
        return
      }
      if (event?.type === 'turn/end') flushChatTurn()
    } catch (error) {
      ctx.logger?.warn?.(`[wechat-bot] session event handler failed: ${error?.message ?? error}`)
    }
  }
  try {
    ctx.effect(() => ctx.on('session/event', onSessionEvent))
  } catch (error) {
    ctx.logger?.warn?.(`[wechat-bot] session/event subscription unavailable: ${error?.message ?? error}`)
  }

  ctx.effect(() => {
    if (settings.autoStart && rt.creds) pollLoop()
    return () => {
      disposed = true
      rt.loginGen = 0
      stops.poll.abort()
      for (const tool of tools) void tool
      saveState()
    }
  })

  ctx.logger?.info?.(`[wechat-bot] ready (data=${DATA_DIR}, state=${rt.conn.state})`)
}
