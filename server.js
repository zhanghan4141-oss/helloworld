// 零依赖 Node 网页服务
//   - /            首页：随机展示一条不同的信息 + 实时时钟（WebSocket 每秒推送）
//   - /api/message 随机信息 JSON 接口（前端"换一条"按钮用）
//   - /time /about 静态信息页
//   - /ws/time     WebSocket 实时时间
// 启动：node server.js  （无任何第三方依赖）

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CN_ZONE = 'Asia/Shanghai';

// RFC 6455 规定的 WebSocket 握手魔术串。
// Sec-WebSocket-Accept = base64(sha1(clientKey + 该串))，漏了或拼错浏览器会直接拒绝握手。
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// 当前连接的 WebSocket 客户端 socket
const wsClients = new Set();

// 连接数上限，防止被机器人连接轰炸拖垮进程
const MAX_WS_CONNECTIONS = 50; // 全局并发上限
const MAX_WS_PER_IP = 5;       // 单 IP 上限
const wsCountByIp = new Map();

// ---------------- 北京时区工具 ----------------
// 无论服务器跑在哪个时区，都以北京时间展示
const CN_INTL = new Intl.DateTimeFormat('en-US', {
  timeZone: CN_ZONE,
  hourCycle: 'h23',
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function cnPart(date, type) {
  return CN_INTL.formatToParts(date).find(p => p.type === type).value;
}

function formatChinaDateTime(date) {
  // 形如 2026-10-20 21:56:44
  return `${cnPart(date, 'year')}-${cnPart(date, 'month')}-${cnPart(date, 'day')} ` +
         `${cnPart(date, 'hour')}:${cnPart(date, 'minute')}:${cnPart(date, 'second')}`;
}

function cnWallDate(date) {
  // 构造一个 getHours() 等取到的就是北京墙钟时间的 Date
  return new Date(
    `${cnPart(date, 'year')}-${cnPart(date, 'month')}-${cnPart(date, 'day')}` +
    `T${cnPart(date, 'hour')}:${cnPart(date, 'minute')}:${cnPart(date, 'second')}`
  );
}

// ---------------- 随机信息池 ----------------
const MESSAGES = [
  '人生得意须尽欢，莫使金樽空对月。',
  '如果你觉得现在很累，说明你在走上坡路。',
  '代码改变世界，而你正在写下它。',
  '早知道读书这么有用，我早就去搬砖了。',
  '今天也要像写代码一样，把问题一个 bug 一个 bug 地解决掉。',
  '最好的时机是十年前，其次是现在。',
  '时间不会等你，但 Node 会一直监听端口 3000。',
  '所有的大人都曾经是小孩，虽然只有少数人记得。',
  '双击永久熬夜，重构终得自由。',
  '别怕失败，反正还有 99 个随机种子可以重试。',
];

// 按北京时间的钟点给不同的问候语
function getGreeting(date) {
  const h = date.getHours();
  if (h < 5) return '夜深了，还没睡吗？';
  if (h < 9) return '早上好，新的一天开始了！';
  if (h < 12) return '上午好，工作顺利！';
  if (h < 14) return '中午好，记得吃饭。';
  if (h < 18) return '下午好，继续加油！';
  if (h < 22) return '晚上好，忙完就休息吧。';
  return '夜深了，注意身体。';
}

// 随机挑一条（抽走刚才那条，避免连刷出现相同内容）
let lastIndex = -1;
function pickMessage() {
  let i;
  do {
    i = Math.floor(Math.random() * MESSAGES.length);
  } while (i === lastIndex && MESSAGES.length > 1);
  lastIndex = i;
  return MESSAGES[i];
}

// ---------------- WebSocket（手工实现，零依赖） ----------------
// 握手：校验请求头里的 sec-websocket-key，按 RFC 6455 计算 Accept 并返回 101
function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  // 连接数保护：达到上限直接拒绝，避免连接轰炸拖垮进程
  const ip = socket.remoteAddress;
  const ipCount = wsCountByIp.get(ip) || 0;
  if (wsClients.size >= MAX_WS_CONNECTIONS || ipCount >= MAX_WS_PER_IP) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash('sha1')
    .update(key + WS_MAGIC)
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      '\r\n'
  );

  wsClients.add(socket);
  wsCountByIp.set(ip, ipCount + 1);
  const remove = () => {
    wsClients.delete(socket);
    const rest = (wsCountByIp.get(ip) || 1) - 1;
    if (rest > 0) wsCountByIp.set(ip, rest);
    else wsCountByIp.delete(ip);
  };
  socket.on('close', remove);
  socket.on('error', remove);
}

// 服务端 -> 客户端文本帧（发送方不需要掩码）
function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const header = [0x81]; // FIN + 文本帧(0x1)
  if (payload.length < 126) {
    header.push(payload.length);
  } else if (payload.length <= 0xffff) {
    header.push(126, (payload.length >> 8) & 0xff, payload.length & 0xff);
  } else {
    header.push(
      127, 0, 0, 0, 0,
      (payload.length >> 24) & 0xff,
      (payload.length >> 16) & 0xff,
      (payload.length >> 8) & 0xff,
      payload.length & 0xff
    );
  }
  return Buffer.concat([Buffer.from(header), payload]);
}

// 每秒给所有已连接客户端推一条实时时间
setInterval(() => {
  const frame = encodeTextFrame(JSON.stringify({
    type: 'time',
    time: formatChinaDateTime(new Date()),
  }));
  for (const socket of wsClients) {
    if (!socket.destroyed) socket.write(frame);
  }
}, 1000);

// ---------------- 静态信息页 ----------------
// 从函数外传入的路径等文本一律先转义，避免反射进 HTML
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PAGES = {
  '/time': {
    title: '当前时间',
    render: (now) => formatChinaDateTime(now),
    note: '这条信息是每次访问时实时生成的，刷新就会变。',
  },
  '/about': {
    title: '关于本站',
    render: () => '一个用 Node 内置 http 模块写的零依赖网页服务。',
    note: '只有 server.js 和 public/ 下几个文件，没有安装任何第三方包。',
  },
};

function sendJson(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendHtml(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function renderPage({ title, body, note }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - 不同信息展示</title>
  <style>
    :root { --bg: #f5f6fa; --card: #ffffff; --text: #333; --muted: #888; --accent: #4f6ef2; }
    @media (prefers-color-scheme: dark) {
      :root { --bg: #17181d; --card: #23252d; --text: #eee; --muted: #999; }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
      font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      background: linear-gradient(135deg, var(--bg), var(--card));
      padding: 16px;
    }
    .card {
      background: var(--card); border-radius: 18px; padding: 36px 40px; max-width: 560px; width: 100%;
      box-shadow: 0 10px 30px rgba(0,0,0,.12); text-align: center;
    }
    h1 { font-size: 20px; color: var(--accent); margin: 0 0 18px; }
    .big { font-size: 28px; line-height: 1.6; margin: 0 0 22px; color: var(--text); }
    .meta { font-size: 14px; color: var(--muted); line-height: 1.9; }
    a { color: var(--accent); }
    a.home { font-size: 14px; display: inline-block; margin-top: 20px; }
  </style>
</head>
<body>
  <main class="card">
    <h1>${title}</h1>
    <p class="big">${body}</p>
    <p class="meta">${note}</p>
    <a class="home" href="/">← 回到首页</a>
  </main>
</body>
</html>`;
}

// ---------------- HTTP 路由 ----------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // API：随机一条信息
  if (pathname === '/api/message') {
    const now = new Date();
    return sendJson(res, {
      message: pickMessage(),
      greeting: getGreeting(cnWallDate(now)),
      date: formatChinaDateTime(now),
      ip: req.socket.remoteAddress,
    });
  }

  // 静态信息页
  if (PAGES[pathname]) {
    const { title, render, note } = PAGES[pathname];
    return sendHtml(res, renderPage({ title, body: render(new Date()), note }));
  }

  // 首页
  if (pathname === '/' || pathname === '/index.html') {
    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    fs.readFile(indexPath, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('读取 index.html 失败');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // 其他路径：提示信息（路径文本已转义，防止反射 XSS）
  sendHtml(res, renderPage({
    title: '网页找到了信息，但没有这个页面',
    body: `路径「${escapeHtml(pathname)}」不存在`,
    note: '试试换一个路径，谁知道会看到什么不同的信息呢。',
  }));
});

// WebSocket 升级请求走这里，不走普通 HTTP 路由
server.on('upgrade', (req, socket) => {
  if (req.url === '/ws/time') handleUpgrade(req, socket);
  else socket.destroy();
});

server.listen(PORT, () => {
  console.log(`服务已启动：http://localhost:${PORT}`);
  console.log('  /            首页（随机信息 + 实时时钟）');
  console.log('  /time        当前时间页');
  console.log('  /about       关于页');
  console.log('  /api/message 随机信息接口');
  console.log('  /ws/time     WebSocket 实时时间');
});