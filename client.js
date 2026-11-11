/**
 * Client half of @local/wechat-bot.
 *
 * 在左侧边栏注册「微信bot」入口（sidebar.panellist），并在主面板注册同名页面（main）。
 * 面板通过同源 /wechat-bot/* 路由与 Host 通信，不依赖任何 @deepseek-ai Client 包。
 */
window.__ModuleLoader__.load({
  id: '@mindlink/wechat-bot',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const MUTED = 'var(--dsw-alias-text-secondary, #6b7280)'
    const TEXT = 'var(--dsw-alias-text-primary, #111827)'
    const BORDER = 'var(--dsw-alias-border-1, #e5e7eb)'
    const PANEL = 'var(--dsw-alias-bg-layer-1, #ffffff)'
    const ACCENT = 'var(--dsw-alias-brand-primary, #2563eb)'
    const DANGER = '#b91c1c'

    const card = {
      border: `1px solid ${BORDER}`,
      borderRadius: 10,
      padding: '14px 16px',
      background: PANEL,
      marginBottom: 14,
    }
    const button = {
      cursor: 'pointer',
      border: `1px solid ${BORDER}`,
      background: 'transparent',
      color: TEXT,
      borderRadius: 6,
      padding: '4px 10px',
      fontSize: 13,
      marginRight: 8,
    }
    const primaryButton = { ...button, background: ACCENT, borderColor: ACCENT, color: '#ffffff' }
    const input = {
      width: '100%',
      boxSizing: 'border-box',
      border: `1px solid ${BORDER}`,
      borderRadius: 6,
      padding: '6px 8px',
      fontSize: 13,
      color: TEXT,
      background: 'transparent',
      fontFamily: 'inherit',
    }
    const row = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }
    const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }
    const label = { display: 'block', fontSize: 12, color: MUTED, margin: '10px 0 4px' }

    const STATE_TEXT = {
      online: '在线',
      connecting: '连接中',
      unpaired: '未登录',
      expired: '连接失效',
      error: '连接异常',
    }

    function StatusPill({ ok, children }) {
      return h(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            color: ok ? '#15803d' : MUTED,
            background: ok ? 'rgba(21,128,61,0.10)' : 'transparent',
            border: `1px solid ${ok ? 'rgba(21,128,61,0.35)' : BORDER}`,
            borderRadius: 999,
            padding: '2px 10px',
          },
        },
        h('span', { style: { width: 7, height: 7, borderRadius: '50%', background: ok ? '#16a34a' : '#9ca3af' } }),
        children,
      )
    }

    const fmtTime = (ts) => {
      if (!ts) return '—'
      const d = new Date(ts)
      return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`
    }

    function WeChatBotIcon({ size = 16 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H9l-4 4v-4H6.5A2.5 2.5 0 0 1 4 13.5z' }),
        h('path', { d: 'M8.5 8.5h7M8.5 11.5h4.5' }),
      )
    }

    const get = (url) =>
      fetch(url, { credentials: 'same-origin', cache: 'no-store' }).then((response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
        return response.json()
      })

    const post = (url, body) =>
      fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }).then(async (response) => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || `${response.status} ${response.statusText}`)
        return data
      })

    function WeChatBotPanel() {
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      const [testText, setTestText] = useState('这是一条来自 DSH 微信 bot 的测试消息')
      const [copied, setCopied] = useState(false)

      const refresh = useCallback(async () => {
        try {
          const next = await get('/wechat-bot/state')
          setState(next)
          setError('')
        } catch (cause) {
          setError(String(cause?.message || cause))
        }
      }, [])

      useEffect(() => {
        let alive = true
        const tick = () => {
          if (alive) refresh()
        }
        tick()
        const timer = setInterval(tick, 2000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [refresh])

      const act = (name, fn) => async () => {
        setBusy(name)
        setNotice('')
        try {
          const result = await fn()
          if (result?.state) setState(result.state)
          setNotice(`${name}：完成`)
        } catch (cause) {
          setNotice(`${name}：${String(cause?.message || cause)}`)
        } finally {
          setBusy('')
        }
      }

      const copyQr = async () => {
        try {
          await navigator.clipboard.writeText(state?.qr?.url || '')
          setCopied(true)
          setTimeout(() => setCopied(false), 1800)
        } catch {
          setNotice('复制失败，请手动选中链接复制')
        }
      }

      const sendTest = async () => {
        setBusy('send')
        setNotice('')
        try {
          const result = await post('/wechat-bot/send', { text: testText })
          if (result?.ok) setNotice(`已发送到微信（${result.chunks ?? 1} 条 / ${result.chars ?? 0} 字）`)
          else setNotice(`发送失败：${result?.error || '未知错误'}${result?.message ? ` · ${result.message}` : ''}`)
        } catch (cause) {
          setNotice(`发送失败：${String(cause?.message || cause)}`)
        } finally {
          setBusy('')
        }
      }

      if (!state) {
        return h('div', { style: { padding: 24, color: MUTED } }, error ? `微信 bot 不可用：${error}` : '正在读取微信 bot 状态…')
      }

      const { connection, account, qr, counters, lastPush, recent, settings } = state
      const online = connection.state === 'online'
      const qrUrl = qr?.url || ''

      return h(
        'div',
        { style: { padding: '24px 28px 40px', color: TEXT, maxWidth: 820, boxSizing: 'border-box' } },
        h('div', { style: { ...row, marginBottom: 14 } },
          h('div', { style: { fontSize: 18, fontWeight: 600, marginRight: 6 } }, '微信 bot'),
          h(StatusPill, { ok: online }, STATE_TEXT[connection.state] || connection.state),
          connection.state === 'online' && account?.botId
            ? h('span', { style: { fontSize: 12, color: MUTED } }, `bot ${account.botId}`)
            : null,
          h('span', { style: { fontSize: 12, color: MUTED } }, `收 ${counters.received} · 发 ${counters.sent} · 失败 ${counters.failed}`),
        ),
        error ? h('div', { style: { color: DANGER, fontSize: 12, marginBottom: 8 } }, error) : null,
        notice ? h('div', { style: { color: MUTED, fontSize: 12, marginBottom: 8 } }, notice) : null,

        // 连接状态
        h('div', { style: card },
          h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 6 } }, '连接状态'),
          h('div', { style: { fontSize: 12, color: MUTED, lineHeight: 1.8 } },
            `状态：${STATE_TEXT[connection.state] || connection.state}（${connection.state}）`,
            connection.error ? `｜${connection.error}` : '',
            h('br'),
            `最近推送：${lastPush?.at ? `${fmtTime(lastPush.at)}${lastPush.ok ? ` 成功（${lastPush.chunks} 条 / ${lastPush.chars} 字）` : ` 失败（${lastPush.error || '未知错误'}）`}` : '尚未推送'}`,
            h('br'),
            `会话转发：${settings?.chatForward ? '开启' : '关闭'}${settings?.chatSessionId ? `（${settings.chatSessionId}）` : ''}`,
            h('br'),
            '微信指令：/help /status /login /logout /recent /news /new',
          ),
          h('div', { style: { marginTop: 10 } },
            h('button', { style: primaryButton, disabled: Boolean(busy), onClick: act('开始登录', () => post('/wechat-bot/login', { action: 'start' })) }, '开始 / 刷新登录'),
            qrUrl ? h('button', { style: button, disabled: Boolean(busy), onClick: act('换一个二维码', () => post('/wechat-bot/login', { action: 'start' })) }, '换一个二维码') : null,
            h('button', { style: button, disabled: Boolean(busy) || !account?.botId, onClick: act('退出登录', () => post('/wechat-bot/login', { action: 'logout' })) }, '退出登录'),
          ),
        ),

        // 登录二维码
        qrUrl
          ? h('div', { style: card },
              h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 4 } }, '扫码登录'),
              h('div', { style: { fontSize: 12, color: MUTED, marginBottom: 8 } },
                qr.hasQr
                  ? '用手机微信扫描下方二维码确认登录（二维码约 2 分钟自动更换）。'
                  : '用手机微信打开下方链接并确认登录（二维码约 2 分钟过期）。'),
              qr.hasQr
                ? h('img', {
                    src: qr.dataUrl,
                    alt: '微信登录二维码',
                    style: {
                      width: 220,
                      height: 220,
                      display: 'block',
                      border: `1px solid ${BORDER}`,
                      borderRadius: 8,
                      background: '#fff',
                      marginBottom: 8,
                    },
                  })
                : null,
              h('div', { style: { ...mono, fontSize: 11, color: MUTED, wordBreak: 'break-all', background: '#f7f7f7', padding: '6px 8px', borderRadius: 6, userSelect: 'all' } }, qrUrl),
              h('div', { style: { marginTop: 8 } },
                h('button', { style: primaryButton, onClick: copyQr }, copied ? '已复制' : '复制链接'),
                h('a', { href: qrUrl, target: '_blank', rel: 'noreferrer', style: { ...button, display: 'inline-block', textDecoration: 'none' } }, '在新标签页打开'),
                h('button', { style: button, disabled: Boolean(busy), onClick: act('取消登录', () => post('/wechat-bot/login', { action: 'cancel' })) }, '取消登录'),
              ),
            )
          : null,

        // 作者信息
        h('div', { style: card },
          h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 6 } }, '作者信息'),
          h('div', { style: { fontSize: 12, color: MUTED, lineHeight: 2 } },
            h('div', null,
              '作者：',
              h('span', { style: { color: TEXT, fontWeight: 600 } }, '思链科技（MindLink）'),
            ),
            h('div', null,
              '插件：',
              h('span', { style: mono }, '@mindlink/wechat-bot'),
              ' · v1.0.0',
            ),
            h('div', null, '通道：微信官方 iLink（ClawBot） · 本地优先，聊天数据只留在本机'),
            h('div', null, '许可：MIT · 反馈与定制请联系插件维护者'),
          ),
        ),

        // 账号信息
        h('div', { style: card },
          h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 6 } }, '账号信息'),
          account?.botId
            ? h('div', { style: { ...mono, color: MUTED, lineHeight: 2 } },
                `bot ID：${account.botId}`,
                h('br'),
                `用户 ID：${account.userId || '—'}`,
                h('br'),
                `网关：${account.baseUrl || '—'}`,
                h('br'),
                `登录时间：${account.savedAt ? fmtTime(Date.parse(account.savedAt)) : '—'}`,
              )
            : h('div', { style: { fontSize: 12, color: MUTED } }, '尚未登录。点上面的「开始 / 刷新登录」，然后用手机微信扫码确认。'),
        ),

        // 测试推送
        h('div', { style: card },
          h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 4 } }, '测试推送'),
          h('div', { style: { fontSize: 12, color: MUTED } }, '推送到你本人的微信（1:1 会话）。首次使用前，请在微信里给机器人发一条任意消息，让 bot 记录会话上下文。'),
          h('label', { style: label }, '消息内容'),
          h('textarea', {
            style: { ...input, minHeight: 64, resize: 'vertical' },
            value: testText,
            onChange: (event) => setTestText(event.target.value),
          }),
          h('div', { style: { marginTop: 8 } },
            h('button', {
              style: primaryButton,
              disabled: Boolean(busy) || !testText.trim(),
              onClick: sendTest,
            }, busy === 'send' ? '发送中…' : '发送到微信'),
          ),
        ),

        // 最近消息
        h('div', { style: card },
          h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 8 } }, `最近收到的消息（${recent.length}）`),
          recent.length === 0
            ? h('div', { style: { fontSize: 12, color: MUTED } }, '暂无。给机器人发一条消息后，这里会显示记录并刷新推送上下文。')
            : h('ul', { style: { listStyle: 'none', margin: 0, padding: 0, maxHeight: 240, overflow: 'auto' } },
                recent.slice().reverse().map((item, index) =>
                  h('li', { key: `${item.at}-${index}`, style: { padding: '6px 0', borderBottom: `1px solid ${BORDER}`, fontSize: 12 } },
                    h('span', { style: { color: MUTED } }, `${fmtTime(item.at)} `),
                    h('span', null, item.text || '[非文本]'),
                  ),
                ),
              ),
        ),

      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'wechat-bot', order: 5, label: () => '微信bot' },
            WeChatBotIcon,
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'wechat-bot' }, WeChatBotPanel),
        )
      },
    }
  },
})
