/**
 * 示例：其他插件如何调用 @mindlink-ai/wechat-bot 发消息。
 *
 * 关键点只有两个：
 *   1. 声明 inject: ['wechatBot']，Cordis 会等待该服务可用；
 *   2. 用 ctx.get('wechatBot') 调用服务方法（不要自己去 spawn 进程或调 HTTP）。
 *
 * 安装方式（与 wechat-bot 相同）：
 *   plugin_manager install_bundle  target = <本目录绝对路径>
 */
export const name = 'example-wechat-consumer'
export const inject = ['wechatBot']

export function apply(ctx, config) {
  const bot = ctx.get('wechatBot')

  // 场景 A：插件激活时推一条就绪通知（仅演示，生产环境建议按需触发）
  bot.send('【示例插件】example-wechat-consumer 已加载，wechatBot 服务可用').catch((error) => {
    ctx.logger?.warn?.(`[example-wechat-consumer] send failed: ${error?.message ?? error}`)
  })

  // 场景 B：把某个业务结果推送给用户——注册成服务方法供本插件其他模块调用
  const api = {
    /** 推送任意文本；返回 { ok, chunks, chars } 或 { ok:false, error, message } */
    notify: (text) => bot.send(text, { source: 'example-consumer' }),

    /** 推送日报文件（自动压缩 + 分片） */
    notifyDigest: (filePath) => bot.sendFile(filePath),

    /** 组合：先确认连接状态，再决定是否推送 */
    notifyIfOnline: async (text) => {
      const state = bot.status()
      if (state.connection?.state !== 'online') {
        return { ok: false, error: 'not_online', message: `当前连接状态：${state.connection?.state}` }
      }
      return bot.send(text, { source: 'example-consumer' })
    },
  }

  ctx.effect(() => ctx.provide('exampleWechatConsumer', api))
  ctx.logger?.info?.('[example-wechat-consumer] ready; wechatBot service injected')
}
