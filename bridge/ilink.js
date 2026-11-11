// iLink（微信 ClawBot）协议客户端：扫码登录 / 长轮询收消息 / 发送文本
// 依据公开协议整理：ilinkai.weixin.qq.com
import { randomBytes } from 'node:crypto';

const DEFAULT_BASE = 'https://ilinkai.weixin.qq.com';
const CHANNEL_VERSION = '1.0.2';
const ROUTE_TAG = '1001';

export class ILinkError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ILinkError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const randomUin = () => Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64');

function headers(auth) {
  const h = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomUin(),
    SKRouteTag: ROUTE_TAG,
  };
  if (auth?.token) h.Authorization = `Bearer ${auth.token}`;
  return h;
}

async function post(base, auth, path, body, signal) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: headers(auth),
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* 非 JSON 按失败处理 */
  }
  if (json.ret === -14 || json.errcode === -14) {
    throw new ILinkError('session-expired', '微信连接已失效（-14），需要重新扫码登录', { ret: -14 });
  }
  if (!res.ok || (json.ret !== undefined && json.ret !== 0)) {
    throw new ILinkError('request-failed', `iLink 请求失败: HTTP ${res.status} ${text.slice(0, 200)}`, { httpStatus: res.status });
  }
  return json;
}

export async function getBotQrcode(base = DEFAULT_BASE) {
  const res = await fetch(`${base}/ilink/bot/get_bot_qrcode?bot_type=3`, { headers: { SKRouteTag: ROUTE_TAG } });
  const text = await res.text();
  if (!res.ok) throw new ILinkError('qrcode-failed', `获取二维码失败: HTTP ${res.status} ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  return { qrcode: json.qrcode, url: json.qrcode_img_content, base };
}

export async function pollQrcodeStatus(qrcode, base = DEFAULT_BASE) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 40000);
  try {
    const res = await fetch(`${base}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, {
      headers: { 'iLink-App-ClientVersion': '1', SKRouteTag: ROUTE_TAG },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) return { status: 'wait' };
    return JSON.parse(text);
  } catch {
    return { status: 'wait' };
  } finally {
    clearTimeout(timer);
  }
}

export async function getUpdates(auth, cursor = '', signal, timeoutMs = 35000) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs + 10000);
  try {
    const json = await post(auth.baseUrl || DEFAULT_BASE, auth, '/ilink/bot/getupdates',
      { get_updates_buf: cursor, base_info: { channel_version: CHANNEL_VERSION } }, controller.signal);
    return {
      msgs: Array.isArray(json.msgs) ? json.msgs : [],
      cursor: json.get_updates_buf || cursor,
      timeoutMs: json.longpolling_timeout_ms,
    };
  } catch (error) {
    if (error.code === 'session-expired') throw error;
    if (error.name === 'AbortError' && !signal?.aborted) return { msgs: [], cursor, timeoutMs };
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function sendText(auth, { toUserId, contextToken, text, clientId }) {
  if (!toUserId) throw new ILinkError('bad-argument', '缺少 to_user_id');
  if (!contextToken) throw new ILinkError('missing-context-token', '缺少 context_token（该会话最近没有收到过消息）');
  await post(auth.baseUrl || DEFAULT_BASE, auth, '/ilink/bot/sendmessage', {
    msg: {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: clientId || `dsh-wechat-${Date.now()}-${randomBytes(3).toString('hex')}`,
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: [{ type: 1, text_item: { text } }],
    },
    base_info: { channel_version: CHANNEL_VERSION },
  });
}
