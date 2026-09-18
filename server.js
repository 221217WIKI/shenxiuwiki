/**
 * 神修维基 社区聊天后端服务器 v2
 * Node.js + ws
 *
 * 功能：
 *  - 托管神修wiki全部静态网页
 *  - 账号注册 / 登录（12位数字ID）
 *  - 群聊实时收发：文字、表情、图片、视频
 *  - 个人主页：修改头像 / 昵称 / 备注（签名）
 *  - 成员列表 / 在线列表
 *  - 表情库（图片表情 + 30秒内视频表情）
 *  - 聊天记录持久化
 *
 * 启动：node server.js
 * 访问：http://localhost:3000
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MSGS_FILE = path.join(DATA_DIR, 'messages.json');
const EMOJIS_FILE = path.join(DATA_DIR, 'emojis.json');
const PORT = process.env.PORT || 3000;
const MAX_MSGS = 500;      // 最多保留的聊天记录条数
const MAX_FILE = 20 * 1024 * 1024;  // 上传文件上限 20MB
const MAX_EMOJI_VIDEO = 15 * 1024 * 1024; // 视频表情上限 15MB

// ---------- 初始化目录 ----------
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]', 'utf8');
if (!fs.existsSync(MSGS_FILE)) fs.writeFileSync(MSGS_FILE, '[]', 'utf8');
if (!fs.existsSync(EMOJIS_FILE)) fs.writeFileSync(EMOJIS_FILE, '[]', 'utf8');

// ---------- 数据读写 ----------
function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function getUsers() { return readJSON(USERS_FILE, []); }
function saveUsers(users) { writeJSON(USERS_FILE, users); }
function getMsgs() { return readJSON(MSGS_FILE, []); }
function saveMsgs(msgs) { writeJSON(MSGS_FILE, msgs.slice(-MAX_MSGS)); }
function getEmojis() { return readJSON(EMOJIS_FILE, []); }
function saveEmojis(list) { writeJSON(EMOJIS_FILE, list.slice(-200)); }

// ---------- 密码哈希 ----------
function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(salt + ':' + password).digest('hex');
}

// ---------- MIME 类型 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

// 允许上传的类型
const ALLOWED_UPLOAD = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
};

// ---------- HTTP 服务器 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch (e) { pathname = url.pathname; }

  // 通用：读取JSON body
  async function readBody() {
    let body = '';
    for await (const chunk of req) body += chunk;
    return JSON.parse(body);
  }

  // ===== API：注册 =====
  if (pathname === '/api/register' && req.method === 'POST') {
    let data;
    try { data = await readBody(); } catch (e) { return json(res, 400, { ok: false, msg: '请求格式错误' }); }

    const uid = String(data.uid || '').trim();
    const nick = String(data.nick || '').trim();
    const pwd = String(data.password || '');

    if (!/^\d{12}$/.test(uid)) return json(res, 400, { ok: false, msg: 'ID必须为12位纯数字' });
    if (!nick || nick.length > 20) return json(res, 400, { ok: false, msg: '昵称不能为空且不超过20字' });
    if (pwd.length < 4) return json(res, 400, { ok: false, msg: '密码长度至少4位' });

    const users = getUsers();
    if (users.find(u => u.uid === uid)) return json(res, 400, { ok: false, msg: '该ID已被占用，请更换' });

    const salt = crypto.randomBytes(8).toString('hex');
    users.push({ uid, nick, bio: '', password: hashPassword(pwd, salt), salt, avatar: '' });
    saveUsers(users);
    return json(res, 200, { ok: true, msg: '注册成功', user: { uid, nick, bio: '', avatar: '' } });
  }

  // ===== API：登录 =====
  if (pathname === '/api/login' && req.method === 'POST') {
    let data;
    try { data = await readBody(); } catch (e) { return json(res, 400, { ok: false, msg: '请求格式错误' }); }

    const uid = String(data.uid || '').trim();
    const pwd = String(data.password || '');
    const users = getUsers();
    const user = users.find(u => u.uid === uid);
    if (!user) return json(res, 400, { ok: false, msg: 'ID或密码错误' });
    if (user.password !== hashPassword(pwd, user.salt)) return json(res, 400, { ok: false, msg: 'ID或密码错误' });

    // 生成自动登录token
    user.token = crypto.randomBytes(24).toString('hex');
    saveUsers(users);
    return json(res, 200, { ok: true, msg: '登录成功', user: { uid: user.uid, nick: user.nick, bio: user.bio || '', avatar: user.avatar || '', token: user.token } });
  }

  // ===== API：自动登录（token） =====
  if (pathname === '/api/autologin' && req.method === 'POST') {
    let data;
    try { data = await readBody(); } catch (e) { return json(res, 400, { ok: false, msg: '请求格式错误' }); }

    const uid = String(data.uid || '').trim();
    const token = String(data.token || '');
    const users = getUsers();
    const user = users.find(u => u.uid === uid && u.token === token);
    if (!user) return json(res, 401, { ok: false, msg: '登录已过期，请重新登录' });

    return json(res, 200, { ok: true, msg: '登录成功', user: { uid: user.uid, nick: user.nick, bio: user.bio || '', avatar: user.avatar || '', token: user.token } });
  }

  // ===== API：更新头像 =====
  if (pathname === '/api/avatar' && req.method === 'POST') {
    let data;
    try { data = await readBody(); } catch (e) { return json(res, 400, { ok: false, msg: '请求格式错误' }); }

    const uid = String(data.uid || '').trim();
    const avatar = String(data.avatar || '');
    const users = getUsers();
    const user = users.find(u => u.uid === uid);
    if (!user) return json(res, 400, { ok: false, msg: '用户不存在' });
    if (avatar.length > 1024 * 1024 * 2) return json(res, 400, { ok: false, msg: '头像文件过大' });

    user.avatar = avatar;
    saveUsers(users);

    // 通知所有在线客户端资料已更新
    broadcast({ type: 'profile-updated', data: { uid, nick: user.nick, avatar: user.avatar, bio: user.bio || '' } });
    return json(res, 200, { ok: true, msg: '头像已更新' });
  }

  // ===== API：更新个人资料（昵称/备注签名） =====
  if (pathname === '/api/profile' && req.method === 'POST') {
    let data;
    try { data = await readBody(); } catch (e) { return json(res, 400, { ok: false, msg: '请求格式错误' }); }

    const uid = String(data.uid || '').trim();
    const users = getUsers();
    const user = users.find(u => u.uid === uid);
    if (!user) return json(res, 400, { ok: false, msg: '用户不存在' });

    if (data.nick !== undefined) {
      const nick = String(data.nick).trim();
      if (!nick || nick.length > 20) return json(res, 400, { ok: false, msg: '昵称不能为空且不超过20字' });
      user.nick = nick;
    }
    if (data.bio !== undefined) {
      const bio = String(data.bio).trim();
      if (bio.length > 50) return json(res, 400, { ok: false, msg: '备注不能超过50字' });
      user.bio = bio;
    }

    saveUsers(users);
    broadcast({ type: 'profile-updated', data: { uid, nick: user.nick, avatar: user.avatar || '', bio: user.bio || '' } });
    return json(res, 200, { ok: true, msg: '资料已更新', user: { uid, nick: user.nick, bio: user.bio || '', avatar: user.avatar || '' } });
  }

  // ===== API：成员列表 =====
  if (pathname === '/api/users' && req.method === 'GET') {
    const users = getUsers();
    const list = users.map(u => ({ uid: u.uid, nick: u.nick, bio: u.bio || '', avatar: u.avatar || '' }));
    return json(res, 200, { ok: true, list });
  }

  // ===== API：单个用户资料 =====
  if (pathname.startsWith('/api/user/') && req.method === 'GET') {
    const uid = pathname.slice('/api/user/'.length);
    const users = getUsers();
    const user = users.find(u => u.uid === uid);
    if (!user) return json(res, 404, { ok: false, msg: '用户不存在' });
    return json(res, 200, { ok: true, user: { uid: user.uid, nick: user.nick, bio: user.bio || '', avatar: user.avatar || '' } });
  }

  // ===== API：上传文件（图片/视频） =====
  if (pathname === '/api/upload' && req.method === 'POST') {
    let data;
    try { data = await readBody(); } catch (e) { return json(res, 400, { ok: false, msg: '请求格式错误' }); }

    const base64 = String(data.data || '');
    const mime = String(data.mime || '');
    if (!base64) return json(res, 400, { ok: false, msg: '缺少文件数据' });

    const ext = ALLOWED_UPLOAD[mime.toLowerCase()];
    if (!ext) return json(res, 400, { ok: false, msg: '仅支持png/jpg/gif/webp图片与mp4/webm视频' });

    // 解析 dataURL 或 纯base64
    let buf;
    const m = base64.match(/^data:[a-z/]+;base64,(.+)$/i);
    if (m) {
      buf = Buffer.from(m[1], 'base64');
    } else {
      buf = Buffer.from(base64, 'base64');
    }
    if (buf.length > MAX_FILE) return json(res, 400, { ok: false, msg: '文件不能超过20MB' });

    const filename = Date.now() + '-' + crypto.randomBytes(6).toString('hex') + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);
    return json(res, 200, { ok: true, url: '/uploads/' + filename, mime });
  }

  // ===== API：表情库列表 =====
  if (pathname === '/api/emojis' && req.method === 'GET') {
    return json(res, 200, { ok: true, list: getEmojis() });
  }

  // ===== API：上传表情（图片表情 / 30秒内视频表情） =====
  if (pathname === '/api/emoji' && req.method === 'POST') {
    let data;
    try { data = await readBody(); } catch (e) { return json(res, 400, { ok: false, msg: '请求格式错误' }); }

    const base64 = String(data.data || '');
    const mime = String(data.mime || '');
    const uid = String(data.uid || '').trim();
    if (!base64) return json(res, 400, { ok: false, msg: '缺少表情数据' });

    const ext = ALLOWED_UPLOAD[mime.toLowerCase()];
    if (!ext) return json(res, 400, { ok: false, msg: '仅支持png/jpg/gif/webp图片与mp4/webm视频表情' });

    let buf;
    const m = base64.match(/^data:[a-z/]+;base64,(.+)$/i);
    if (m) {
      buf = Buffer.from(m[1], 'base64');
    } else {
      buf = Buffer.from(base64, 'base64');
    }

    const isVideo = mime.toLowerCase().startsWith('video/');
    if (isVideo && buf.length > MAX_EMOJI_VIDEO) return json(res, 400, { ok: false, msg: '视频表情不能超过15MB' });
    if (!isVideo && buf.length > 5 * 1024 * 1024) return json(res, 400, { ok: false, msg: '图片表情不能超过5MB' });

    const filename = Date.now() + '-' + crypto.randomBytes(6).toString('hex') + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);

    const users = getUsers();
    const by = (users.find(u => u.uid === uid) || {}).nick || '未知';
    const emoji = { id: Date.now() + '-' + Math.floor(Math.random() * 10000), type: isVideo ? 'video' : 'image', url: '/uploads/' + filename, by, time: Date.now() };
    const list = getEmojis();
    list.push(emoji);
    saveEmojis(list);
    return json(res, 200, { ok: true, emoji });
  }

  // ===== API：删除表情 =====
  if (pathname === '/api/emoji' && req.method === 'DELETE') {
    const id = String(url.searchParams.get('id') || '');
    let list = getEmojis();
    const target = list.find(e => e.id === id);
    if (!target) return json(res, 404, { ok: false, msg: '表情不存在' });
    list = list.filter(e => e.id !== id);
    saveEmojis(list);
    // 尝试删除文件
    try { fs.unlinkSync(path.join(ROOT, target.url)); } catch (e) { /* 忽略 */ }
    return json(res, 200, { ok: true, msg: '已删除' });
  }

  // ===== 静态文件服务 =====
  if (req.method === 'GET' || req.method === 'HEAD') {
    let filePath;
    if (pathname === '/' || pathname === '/index.html') {
      filePath = path.join(ROOT, 'index.html');
    } else {
      filePath = path.join(ROOT, pathname);
    }

    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(ROOT))) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Forbidden');
    }

    fs.stat(resolved, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('404 Not Found');
      }
      const ext = path.extname(resolved).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(resolved).pipe(res);
    });
    return;
  }

  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Method Not Allowed');
});

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ---------- WebSocket 聊天 ----------
const wss = new WebSocketServer({ server, path: '/ws' });

// 在线客户端: { uid, nick, avatar, bio, ws, joinedAt }
const online = new Map();

function broadcast(obj, exceptUid) {
  const payload = JSON.stringify(obj);
  for (const [uid, client] of online) {
    if (uid === exceptUid) continue;
    if (client.ws.readyState === 1) {
      try { client.ws.send(payload); } catch (e) { /* 忽略单客户端错误 */ }
    }
  }
}

function onlineList() {
  return Array.from(online.values()).map(c => ({ uid: c.uid, nick: c.nick, avatar: c.avatar || '' }));
}

function systemMessage(text) {
  return {
    id: 'sys-' + Date.now() + '-' + Math.floor(Math.random() * 10000),
    senderId: 'system',
    sender: '系统',
    avatar: '',
    type: 'text',
    content: text,
    time: Date.now()
  };
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const uid = url.searchParams.get('uid') || '';
  let client = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

    if (msg.type === 'auth') {
      // 用服务器端用户数据校准身份
      const users = getUsers();
      const user = users.find(u => u.uid === msg.uid && u.nick === msg.nick);
      if (!user) {
        ws.send(JSON.stringify({ type: 'error', data: { msg: '身份校验失败，请重新登录' } }));
        return;
      }
      client = { uid: user.uid, nick: user.nick, avatar: user.avatar || '', bio: user.bio || '', ws, joinedAt: Date.now() };
      // 同一账号重复连接时踢掉旧的
      const old = online.get(user.uid);
      if (old && old.ws !== ws) {
        try { old.ws.send(JSON.stringify({ type: 'error', data: { msg: '账号已在其他窗口登录' } })); old.ws.close(); } catch (e) { /* 忽略 */ }
      }
      online.set(user.uid, client);

      ws.send(JSON.stringify({ type: 'history', data: getMsgs() }));
      ws.send(JSON.stringify({ type: 'online', data: onlineList() }));
      broadcast({ type: 'system', data: systemMessage(`${user.nick} 加入了社区`) }, user.uid);
      broadcast({ type: 'online', data: onlineList() });
      return;
    }

    if (msg.type === 'chat') {
      if (!client) return;
      const content = String(msg.data && msg.data.content || '').trim();
      const msgType = msg.data && msg.data.type === 'image' ? 'image'
                    : msg.data && msg.data.type === 'video' ? 'video' : 'text';

      // 图片/视频消息必须指向服务器上传目录
      if ((msgType === 'image' || msgType === 'video') && !/^\/uploads\/[a-zA-Z0-9\-_.]+\.(png|jpg|jpeg|gif|webp|mp4|webm|mov)$/i.test(content)) {
        ws.send(JSON.stringify({ type: 'error', data: { msg: '文件地址无效' } }));
        return;
      }
      if (msgType === 'text' && content.length > 2000) {
        ws.send(JSON.stringify({ type: 'error', data: { msg: '消息过长（最多2000字）' } }));
        return;
      }

      // 从用户表实时取最新昵称/头像
      const users = getUsers();
      const u = users.find(x => x.uid === client.uid);
      const chatMsg = {
        id: Date.now() + '-' + Math.floor(Math.random() * 10000),
        senderId: client.uid,
        sender: u ? u.nick : client.nick,
        avatar: u && u.avatar ? u.avatar : '',
        type: msgType,
        content: content,
        time: Date.now(),
        replyTo: msg.data.replyTo || null
      };

      const msgs = getMsgs();
      msgs.push(chatMsg);
      saveMsgs(msgs);
      broadcast({ type: 'chat', data: chatMsg });
      return;
    }

    // ===== 撤回/删除自己的消息 =====
    if (msg.type === 'delete') {
      if (!client) return;
      const msgId = String(msg.data && msg.data.id || '');
      if (!msgId) { ws.send(JSON.stringify({ type: 'error', data: { msg: '缺少消息ID' } })); return; }
      const msgs = getMsgs();
      const idx = msgs.findIndex(m => m.id === msgId);
      if (idx < 0) { ws.send(JSON.stringify({ type: 'error', data: { msg: '消息不存在或已删除' } })); return; }
      if (msgs[idx].senderId !== client.uid) {
        ws.send(JSON.stringify({ type: 'error', data: { msg: '只能撤回自己发送的消息' } }));
        return;
      }
      msgs.splice(idx, 1);
      saveMsgs(msgs);
      broadcast({ type: 'delete', data: { id: msgId } });
      return;
    }
  });

  ws.on('close', () => {
    if (client) {
      online.delete(client.uid);
      broadcast({ type: 'system', data: systemMessage(`${client.nick} 离开了社区`) });
      broadcast({ type: 'online', data: onlineList() });
    }
  });

  ws.on('error', () => { /* 忽略 */ });
});

// ---------- 启动 ----------
server.listen(PORT, '0.0.0.0', () => {
  console.log('==============================================');
  console.log('  神修维基 社区聊天服务器 v2 已启动');
  console.log('  本机访问:   http://localhost:' + PORT);
  const os = require('os');
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log('  局域网访问: http://' + net.address + ':' + PORT);
      }
    }
  }
  console.log('  聊天入口:   /community.html');
  console.log('==============================================');
});
