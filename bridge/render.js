// 把《应急行业日报》Markdown 压缩成适合微信单聊的短消息，并按字节分片。
// 纯函数，便于工具与面板复用。

/** 提取速览 + 每主题第一条（标题/日期/链接） */
export function renderDigest(md) {
  const lines = String(md || '').split(/\r?\n/);
  const out = [];
  let title = '应急行业日报';
  for (const line of lines) {
    const m = line.match(/^#\s+(.+)$/);
    if (m) {
      title = m[1].trim();
      break;
    }
  }
  out.push(`【${title}】`, '');
  const bullets = lines.filter((l) => /^-\s*【/.test(l)).map((l) => l.replace(/^-\s*/, '').trim());
  if (bullets.length) {
    out.push('今日速览');
    bullets.slice(0, 6).forEach((b, i) => out.push(`${i + 1}. ${b}`));
    out.push('');
  }
  let section = '';
  const perSection = new Map();
  for (let i = 0; i < lines.length; i++) {
    const h2 = lines[i].match(/^##\s+(.+)$/);
    if (h2) {
      section = h2[1].trim();
      continue;
    }
    const h3 = lines[i].match(/^###\s+(.+)$/);
    if (h3 && section && !/速览|持续跟踪|启示|数据说明/.test(section)) {
      const item = { title: h3[1].replace(/^\d+\.\s*/, '').trim(), date: '', link: '' };
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        if (/^###|^##\s/.test(lines[j])) break;
        const d = lines[j].match(/\*\*日期\*\*[：:]\s*([^｜|]+)/);
        if (d && !item.date) item.date = d[1].trim();
        const l = lines[j].match(/(https?:\/\/[^\s)>]+)/);
        if (l && !item.link) item.link = l[1];
      }
      if (!perSection.has(section)) perSection.set(section, []);
      if (perSection.get(section).length < 1) perSection.get(section).push(item);
    }
  }
  for (const [name, items] of perSection) {
    out.push(`▎${name}`);
    for (const it of items) {
      out.push(`· ${it.title}${it.date ? `（${it.date}）` : ''}`);
      if (it.link) out.push(`  ${it.link}`);
    }
    out.push('');
  }
  out.push('完整版见 DSH 工作区 daily-news 目录。');
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 按 UTF-8 字节上限切片，优先在换行处断开 */
export function chunkByBytes(text, maxBytes = 1900) {
  const chunks = [];
  let rest = String(text || '');
  while (Buffer.byteLength(rest, 'utf8') > maxBytes) {
    let cut = rest.length;
    while (Buffer.byteLength(rest.slice(0, cut), 'utf8') > maxBytes) cut = Math.max(1, Math.floor(cut * 0.9));
    const nl = rest.lastIndexOf('\n', cut);
    if (nl > cut * 0.5) cut = nl + 1;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.trim()) chunks.push(rest.trim());
  return chunks.length ? chunks : [''];
}
