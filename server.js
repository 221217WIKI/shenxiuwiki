/**
 * 神修维基 社区聊天后端服务器 v3
 * 功能：群聊(文字/图片/视频/语音/表情)、私聊、动态(点赞/留言)、个人主页
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
const POSTS_FILE = path.join(DATA_DIR, 'posts.json');
const DMS_FILE = path.join(DATA_DIR, 'dms.json');
const PORT = process.env.PORT || 3000;
const MAX_MSGS = 500;
const MAX_FILE = 20 * 1024 * 1024;
const MAX_EMOJI_VIDEO = 15 * 1024 * 1024;
const MAX_AUDIO = 5 * 1024 * 1024;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]', 'utf8');
if (!fs.existsSync(MSGS_FILE)) fs.writeFileSync(MSGS_FILE, '[]', 'utf8');
if (!fs.existsSync(EMOJIS_FILE)) fs.writeFileSync(EMOJIS_FILE, '[]', 'utf8');
if (!fs.existsSync(POSTS_FILE)) fs.writeFileSync(POSTS_FILE, '[]', 'utf8');
if (!fs.existsSync(DMS_FILE)) fs.writeFileSync(DMS_FILE, '{}', 'utf8');

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); }
function getUsers() { return readJSON(USERS_FILE, []); }
function saveUsers(users) { writeJSON(USERS_FILE, users); }
function getMsgs() { return readJSON(MSGS_FILE, []); }
function saveMsgs(msgs) { writeJSON(MSGS_FILE, msgs.slice(-MAX_MSGS)); }
function getEmojis() { return readJSON(EMOJIS_FILE, []); }
function saveEmojis(list) { writeJSON(EMOJIS_FILE, list.slice(-200)); }
function getPosts() { return readJSON(POSTS_FILE, []); }
function savePosts(p) { writeJSON(POSTS_FILE, p.slice(-500)); }
function getDMs() { return readJSON(DMS_FILE, {}); }
function saveDMs(d) { writeJSON(DMS_FILE, d); }

function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(salt + ':' + password).digest('hex');
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime'
};
const ALLOWED_UPLOAD = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg',
  'image/gif': '.gif', 'image/webp': '.webp',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/mp4': '.m4a', 'audio/ogg': '.ogg', 'audio/webm': '.mp3'
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch (e) { pathname = url.pathname; }

  async function readBody() {
    let body = '';
    for await (const chunk of req) body += chunk;
    return JSON.parse(body);
  }

  // ===== 注册 =====
  if (pathname === '/api/register' && req.method === 'POST') {
    let data; try { data = await readBody(); } catch (e) { return json(res, 400, { ok: false, msg: '请求格式错误' }); }
    const uid = String(data.uid || '').trim();
    const nick = String(data.nick || '').trim();
    const pwd = String(data.password || '');
    if (!/^\d{12}$/.test(uid)) return json(res, 400, { ok: false, msg: 'ID必须为12位纯数字' });
    if (!nick || nick.length > 20) return json(res, 400, { ok: false, msg: '昵称不能为空且不超过20字' });
    if (pwd.length < 4) return json(res, 400, { ok: false, msg: '密码长度至少4位' });
    const users = getUsers();
    if (users.find(u => u.uid === uid)) return json(res, 400, { ok: false, msg: '该ID已被占用，请更换' });
    const salt = crypto.randomBytes(8).toString('hex');
    users.push({ uid, nick, bio: '', password: hashPassword(pwd, salt), salt, avatar: '', friends: [] });
    saveUsers(users);
    return json(res, 200, { ok: true, user: { uid, nick, bio: '', avatar: '', friends: [] } });
  }

  // ===== 登录 =====
  if (pathname === '/api/login' && req.method === 'POST') {
    let data; try { data = await readBody(); } catch (e) { return json(res, 400, { ok: false, msg: '请求格式错误' }); }
    const uid = String(data.uid || '').trim();
    const pwd = String(data.password || '');
    const users = getUsers();
    const user = users.find(u => u.uid === uid);
    if (!user || user.password !== hashPassword(pwd, user.salt)) return json(res, 400, { ok: false, msg: 'ID或密码错误' });
    user.token = crypto.randomBytes(24).toString('hex');
    saveUsers(users);
    return json(res, 200, { ok: true, user: { uid: user.uid, nick: user.nick, bio: user.bio || '', avatar: user.avatar || '', token: user.token, friends: user.friends || [] } });
  }

  // ===== 自动登录 =====
  if (pathname === '/api/autologin' && req.method === 'POST') {
    let data; try { data = await readBody(); } catch (e) { return json(res, 400, { ok: false, msg: '请求格式错误' }); }
    const uid = String(data.uid || '').trim();
    const token = String(data.token || '');
    const users = getUsers();
    const user = users.find(u => u.uid === uid && u.token === token);
    if (!user) return json(res, 401, { ok: false, msg: '登录已过期，请重新登录' });
    return json(res, 200, { ok: true, user: { uid: user.uid, nick: user.nick, bio: user.bio || '', avatar: user.avatar || '', token: user.token, friends: user.friends || [] } });
  }

  // ===== 头像 =====
  if (pathname === '/api/avatar' && req.method === 'POST') {
    let data; try { data = await readBody(); } catch (e) { return json(res, 400, { ok: false, msg: '请求格式错误' }); }
    const uid = String(data.uid || '').trim();
    const avatar = String(data.avatar || '');
    const users = getUsers();
    const user = users.find(u => u.uid === uid);
    if (!user) return json(res, 400, { ok: false, msg: '用户不存在' });
    if (avatar.length > 1024 * 1024 * 2) return json(res, 400, { ok: false, msg: '头像文件过大' });
    user.avatar = avatar;
    saveUsers(users);
    broadcast({ type: 'profile-updated', data: { uid, nick: user.nick, avatar: user.avatar, bio: user.bio || '' } });
    return json(res, 200, { ok: true, msg: '头像已更新' });
  }

  // ===== 资料 =====
  if (pathname === '/api/profile' && req.method === 'POST') {
    let data; try { data = await readBody(); } catch (e) { return json(res, 400, { ok: false, msg: '请求格式错误' }); }
    const uid = String(data.uid || '').trim();
    const users = getUsers();
    const user = users.find(u => u.uid === uid);
    if (!user) return json(res, 400, { ok: false, msg: '用户不存在' });
    if (data.nick !== undefined) {
      const nick = String(data.nick).trim();
      if (!nick || nick.length > 20) return json(res, 400, { ok: false, msg: '昵称不能为空' });
      user.nick = nick;
    }
    if (data.bio !== undefined) {
      const bio = String(data.bio).trim();
      if (bio.length > 50) return json(res, 400, { ok: false, msg: '备注不能超过50字' });
      user.bio = bio;
    }
    saveUsers(users);
    broadcast({ type: 'profile-updated', data: { uid, nick: user.nick, avatar: user.avatar || '', bio: user.bio || '' } });
    return json(res, 200, { ok: true, user: { uid, nick: user.nick, bio: user.bio || '', avatar: user.avatar || '' } });
  }

  // ===== 成员列表 =====
  if (pathname === '/api/users' && req.method === 'GET') {
    const users = getUsers();
    const list = users.map(u => ({ uid: u.uid, nick: u.nick, bio: u.bio || '', avatar: u.avatar || '' }));
    return json(res, 200, { ok: true, list });
  }

  // ===== 加好友 =====
  if (pathname === '/api/friend' && req.method === 'POST') {
    let data; try { data = await readBody(); } catch (e) { return json(res, 400, { ok: false, msg: '请求格式错误' }); }
    const me = String(data.uid || '').trim();
    const friendUid = String(data.friendUid || '').trim();
    const users = getUsers();
    const meObj = users.find(u => u.uid === me);
    const friendObj = users.find(u => u.uid === friendUid);
    if (!meObj || !friendObj) return json(res, 404, { ok: false, msg: '用户不存在' });
    meObj.friends = meObj.friends || [];
    friendObj.friends = friendObj.friends || [];
    if (!meObj.friends.includes(friendUid)) meObj.friends.push(friendUid);
    if (!friendObj.friends.includes(me)) friendObj.friends.push(me);
    saveUsers(users);
    return json(res, 200, { ok: true, msg: '已添加好友' });
  }

  // ===== 上传文件（图片/视频/语音） =====
  if (pathname === '/api/upload' && req.method === 'POST') {
    let data; try { data = await readBody(); } catch (e) { return json(res, 400, { ok: false, msg: '请求格式错误' }); }
    const base64 = String(data.data || '');
    const mime = String(data.mime || '').toLowerCase();
    if (!base64) return json(res, 400, { ok: false, msg: '缺少文件数据' });
    const ext = ALLOWED_UPLOAD[mime];
    if (!ext) return json(res, 400, { ok: false, msg: '不支持的文件类型' });
    let buf;
    const m = base64.match(/^data:[a-z/]+;base64,(.+)$/i);
    buf = m ? Buffer.from(m[1], 'base64') : Buffer.from(base64, 'base64');
    const isAudio = mime.startsWith('audio/');
    if (isAudio && buf.length > MAX_AUDIO) return json(res, 400, { ok: false, msg: '语音不能超过5MB' });
    if (!isAudio && buf.length > MAX_FILE) return json(res, 400, { ok: false, msg: '文件不能超过20MB' });
    const filename = Date.now() + '-' + crypto.randomBytes(6).toString('hex') + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);
    return json(res, 200, { ok: true, url: '/uploads/' + filename, mime });
  }

  // ===== 表情 =====
  if (pathname === '/api/emojis' && req.method === 'GET') return json(res, 200, { ok: true, list: getEmojis() });
  if (pathname === '/api/emoji' && req.method === 'POST') {
    let data; try { data = await readBody(); } catch (e) { return json(res, 400, { ok: false, msg: '请求格式错误' }); }
    const base64 = String(data.data || '');
    const mime = String(data.mime || '');
    const uid = String(data.uid || '').trim();
    if (!base64) return json(res, 400, { ok: false, msg: '缺少表情数据' });
    const ext = ALLOWED_UPLOAD[mime.toLowerCase()];
    if (!ext) return json(res, 400, { ok: false, msg: '不支持的类型' });
    let buf;
    const m = base64.match(/^data:[a-z/]+;base64,(.+)$/i);
    buf = m ? Buffer.from(m[1], 'base64') : Buffer.from(base64, 'base64');
    const isVideo = mime.toLowerCase().startsWith('video/');
    if (isVideo && buf.length > MAX_EMOJI_VIDEO) return json(res, 400, { ok: false, msg: '视频表情不能超过15MB' });
    if (!isVideo && buf.length > 5 * 1024 * 1024) return json(res, 400, { ok: false, msg: '图片表情不能超过5MB' });
    const filename = Date.now() + '-' + crypto.randomBytes(6).toString('hex') + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);
    const users = getUsers();
    const by = (users.find(u => u.uid === uid) || {}).nick || '未知';
    const emoji = { id: Date.now() + '-' + Math.floor(Math.random()*10000), type: isVideo?'video':'image', url: '/uploads/'+filename, by, time: Date.now() };
    const list = getEmojis();
    list.push(emoji);
    saveEmojis(list);
    return json(res, 200, { ok: true, emoji });
  }
  if (pathname === '/api/emoji' && req.method === 'DELETE') {
    const id = String(url.searchParams.get('id') || '');
    let list = getEmojis();
    const target = list.find(e => e.id === id);
    if (!target) return json(res, 404, { ok: false, msg: '表情不存在' });
    list = list.filter(e => e.id !== id);
    saveEmojis(list);
    try { fs.unlinkSync(path.join(ROOT, target.url)); } catch(e){}
    return json(res, 200, { ok: true });
  }

  // ===== 动态：列表 =====
  if (pathname === '/api/posts' && req.method === 'GET') {
    const posts = getPosts().slice(-200).reverse();
    const users = getUsers();
    const enriched = posts.map(p => {
      const author = users.find(u => u.uid === p.authorId) || {};
      return { ...p, authorNick: author.nick || p.authorNick || '?', authorAvatar: author.avatar || '' };
    });
    return json(res, 200, { ok: true, list: enriched });
  }

  // ===== 动态：发布 =====
  if (pathname === '/api/post' && req.method === 'POST') {
    let data; try { data = await readBody(); } catch (e) { return json(res, 400, { ok: false, msg: '请求格式错误' }); }
    const uid = String(data.uid || '').trim();
    const type = data.type === 'image' || data.type === 'video' ? data.type : 'text';
    const content = String(data.content || '').slice(0, 2000);
    const users = getUsers();
    const author = users.find(u => u.uid === uid);
    if (!author) return json(res, 400, { ok: false, msg: '用户不存在' });
    if (type !== 'text' && !/^\/uploads\//.test(content)) return json(res, 400, { ok: false, msg: '文件地址无效' });
    const post = {
      id: 'post-' + Date.now() + '-' + Math.floor(Math.random()*10000),
      authorId: uid, authorNick: author.nick, authorAvatar: author.avatar || '',
      type, content, likes: [], comments: [], time: Date.now()
    };
    const posts = getPosts();
    posts.push(post);
    savePosts(posts);
    broadcast({ type: 'post-new', data: post });
    return json(res, 200, { ok: true, post });
  }

  // ===== 动态：点赞/取消 =====
  if (pathname === '/api/post/like' && req.method === 'POST') {
    let data; try { data = await readBody(); } catch (e) { return json(res, 400, { ok: false, msg: '请求格式错误' }); }
    const pid = String(data.id || '');
    const uid = String(data.uid || '');
    const posts = getPosts();
    const post = posts.find(p => p.id === pid);
    if (!post) return json(res, 404, { ok: false, msg: '动态不存在' });
    post.likes = post.likes || [];
    const idx = post.likes.indexOf(uid);
    let liked;
    if (idx >= 0) { post.likes.splice(idx, 1); liked = false; } else { post.likes.push(uid); liked = true; }
    savePosts(posts);
    broadcast({ type: 'post-like', data: { id: pid, likes: post.likes.length, likedByMe: liked, liker: uid } });
    return json(res, 200, { ok: true, liked, count: post.likes.length });
  }

  // ===== 动态：留言 =====
  if (pathname === '/api/post/comment' && req.method === 'POST') {
    let data; try { data = await readBody(); } catch (e) { return json(res, 400, { ok: false, msg: '请求格式错误' }); }
    const pid = String(data.id || '');
    const uid = String(data.uid || '');
    const text = String(data.text || '').slice(0, 500);
    const replyTo = String(data.replyTo || '');
    if (!text) return json(res, 400, { ok: false, msg: '留言不能为空' });
    const users = getUsers();
    const author = users.find(u => u.uid === uid);
    const posts = getPosts();
    const post = posts.find(p => p.id === pid);
    if (!post) return json(res, 404, { ok: false, msg: '动态不存在' });
    post.comments = post.comments || [];
    const comment = {
      id: 'c-' + Date.now() + '-' + Math.floor(Math.random()*10000),
      authorId: uid, authorNick: author ? author.nick : '?', authorAvatar: author ? author.avatar||'' : '',
      text, replyTo, time: Date.now()
    };
    post.comments.push(comment);
    savePosts(posts);
    broadcast({ type: 'post-comment', data: { id: pid, comment } });
    return json(res, 200, { ok: true, comment });
  }

  // ===== 私聊历史 =====
  if (pathname.startsWith('/api/dm/') && req.method === 'GET') {
    const otherUid = pathname.slice('/api/dm/'.length);
    const me = url.searchParams.get('me') || '';
    if (!me || !otherUid) return json(res, 400, { ok: false, msg: '参数缺失' });
    const dms = getDMs();
    const key = [me, otherUid].sort().join('|');
    const list = dms[key] || [];
    return json(res, 200, { ok: true, list: list.slice(-200) });
  }

  // ===== 静态文件 =====
  if (req.method === 'GET' || req.method === 'HEAD') {
    let filePath;
    if (pathname === '/' || pathname === '/index.html') filePath = path.join(ROOT, 'index.html');
    else filePath = path.join(ROOT, pathname);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(ROOT))) {
      res.writeHead(403, {'Content-Type':'text/plain; charset=utf-8'}); return res.end('Forbidden');
    }
    fs.stat(resolved, (err, stat) => {
      if (err || !stat.isFile()) { res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'}); return res.end('404 Not Found'); }
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
  res.writeHead(405, {'Content-Type':'text/plain; charset=utf-8'});
  res.end('Method Not Allowed');
});

function json(res, code, obj) {
  res.writeHead(code, {'Content-Type':'application/json; charset=utf-8'});
  res.end(JSON.stringify(obj));
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws' });
const online = new Map();

function broadcast(obj, exceptUid) {
  const payload = JSON.stringify(obj);
  for (const [uid, client] of online) {
    if (uid === exceptUid) continue;
    if (client.ws.readyState === 1) { try { client.ws.send(payload); } catch(e){} }
  }
}
function sendTo(uid, obj) {
  const c = online.get(uid);
  if (c && c.ws.readyState === 1) { try { c.ws.send(JSON.stringify(obj)); return true; } catch(e){} }
  return false;
}
function onlineList() {
  return Array.from(online.values()).map(c => ({ uid: c.uid, nick: c.nick, avatar: c.avatar || '' }));
}
function systemMessage(text) {
  return { id: 'sys-'+Date.now()+'-'+Math.floor(Math.random()*10000), senderId: 'system', sender: '系统', avatar: '', type: 'text', content: text, time: Date.now() };
}

wss.on('connection', (ws, req) => {
  let client = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch(e){ return; }

    if (msg.type === 'auth') {
      const users = getUsers();
      const user = users.find(u => u.uid === msg.uid && u.nick === msg.nick);
      if (!user) { ws.send(JSON.stringify({type:'error',data:{msg:'身份校验失败'}})); return; }
      client = { uid: user.uid, nick: user.nick, avatar: user.avatar || '', ws, joinedAt: Date.now() };
      const old = online.get(user.uid);
      if (old && old.ws !== ws) {
        try { old.ws.send(JSON.stringify({type:'error',data:{msg:'账号已在其他窗口登录'}})); old.ws.close(); } catch(e){}
      }
      online.set(user.uid, client);
      ws.send(JSON.stringify({ type: 'history', data: getMsgs() }));
      ws.send(JSON.stringify({ type: 'online', data: onlineList() }));
      broadcast({ type: 'system', data: systemMessage(`${user.nick} 加入了社区`) }, user.uid);
      broadcast({ type: 'online', data: onlineList() });
      return;
    }

    if (!client) return;

    // 群聊
    if (msg.type === 'chat') {
      const content = String(msg.data && msg.data.content || '');
      const t = msg.data && msg.data.type;
      const msgType = t === 'image' ? 'image' : t === 'video' ? 'video' : t === 'audio' ? 'audio' : 'text';
      if ((msgType === 'image' || msgType === 'video' || msgType === 'audio') && !/^\/uploads\//.test(content)) {
        ws.send(JSON.stringify({type:'error',data:{msg:'文件地址无效'}})); return;
      }
      if (msgType === 'text' && content.length > 2000) {
        ws.send(JSON.stringify({type:'error',data:{msg:'消息过长'}})); return;
      }
      const users = getUsers();
      const u = users.find(x => x.uid === client.uid);
      const chatMsg = {
        id: Date.now()+'-'+Math.floor(Math.random()*10000),
        senderId: client.uid, sender: u ? u.nick : client.nick,
        avatar: u && u.avatar ? u.avatar : '',
        type: msgType, content, time: Date.now(),
        replyTo: msg.data.replyTo || null
      };
      const msgs = getMsgs();
      msgs.push(chatMsg);
      saveMsgs(msgs);
      broadcast({ type: 'chat', data: chatMsg });
      return;
    }

    // 私聊
    if (msg.type === 'dm') {
      const toUid = String(msg.data && msg.data.toUid || '');
      const content = String(msg.data && msg.data.content || '');
      const t = msg.data && msg.data.type;
      const msgType = t === 'image' ? 'image' : t === 'video' ? 'video' : t === 'audio' ? 'audio' : 'text';
      if (!toUid) return;
      const dmMsg = {
        id: 'dm-'+Date.now()+'-'+Math.floor(Math.random()*10000),
        from: client.uid, fromNick: client.nick, fromAvatar: client.avatar || '',
        to: toUid, type: msgType, content, time: Date.now()
      };
      const dms = getDMs();
      const key = [client.uid, toUid].sort().join('|');
      if (!dms[key]) dms[key] = [];
      dms[key].push(dmMsg);
      saveDMs(dms);
      sendTo(toUid, { type: 'dm', data: dmMsg });
      sendTo(client.uid, { type: 'dm', data: dmMsg });
      return;
    }

    // 撤回
    if (msg.type === 'delete') {
      const msgId = String(msg.data && msg.data.id || '');
      if (!msgId) return;
      const msgs = getMsgs();
      const idx = msgs.findIndex(m => m.id === msgId);
      if (idx < 0) return;
      if (msgs[idx].senderId !== client.uid) {
        ws.send(JSON.stringify({type:'error',data:{msg:'只能撤回自己的消息'}})); return;
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
  ws.on('error', () => {});
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('神修维基社区服务器 v3 启动于端口', PORT);
});
