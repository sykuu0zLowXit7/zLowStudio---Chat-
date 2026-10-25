'use strict';
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 10e6 });

app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
});
app.use(express.json({ limit: '1mb' }));

// ============================================================
// Configuracion
// ============================================================
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1509';
if (!process.env.ADMIN_PASSWORD) {
    console.warn('[aviso] Usando la clave de admin por defecto. Define la variable ADMIN_PASSWORD para cambiarla.');
}
const GIF_API_KEY = process.env.GIF_API_KEY || 'EqKveKya673SGDNK1vWqZlqCeczfAYPbRC3KDD9WDW8cVMQKPG6wTnMWcEoqOglk';
const GIF_PROVIDER = (process.env.GIF_PROVIDER || 'klipy').toLowerCase();
const GIF_PAGE_SIZE = 24;
const GIF_CACHE_TTL = 5 * 60 * 1000;
const gifCache = new Map();

// ============================================================
// Utilidades
// ============================================================
const room = (uid) => 'u:' + uid;
const RANK = { user: 0, admin: 1, owner: 2 };
const STATUSES = ['online', 'dnd', 'idle', 'offline'];

const buckets = new Map();
function allow(key, max, windowMs) {
    const t = Date.now();
    let b = buckets.get(key);
    if (!b || t > b.reset) { b = { count: 0, reset: t + windowMs }; buckets.set(key, b); }
    b.count++;
    return b.count <= max;
}
setInterval(() => {
    const t = Date.now();
    buckets.forEach((b, k) => { if (t > b.reset) buckets.delete(k); });
    db.purgeSessions();
}, 10 * 60 * 1000).unref();

const cleanText = (s, max) => String(s == null ? '' : s).replace(/\u0000/g, '').slice(0, max);
const cleanBio = (b) => cleanText(b, 200).replace(/[<>]/g, '').trim();
const isHexColor = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);

function cleanReply(r) {
    if (!r || typeof r !== 'object') return null;
    return {
        user: cleanText(r.user, 24),
        text: cleanText(r.text, 200),
        color: isHexColor(r.color) ? r.color : '#888888'
    };
}

// --- media: se guarda en disco y la base solo guarda la URL (historial liviano y rapido)
const IMAGE_MIMES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const AUDIO_MIMES = { 'audio/webm': 'weba', 'video/webm': 'weba', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };

function saveMedia(dataUrl, table, maxBytes) {
    const parsed = db.parseDataUrl(dataUrl, Object.keys(table), maxBytes);
    if (!parsed) return null;
    const name = crypto.randomBytes(12).toString('hex') + '.' + table[parsed.mime];
    fs.writeFileSync(path.join(db.MEDIA_DIR, name), parsed.buf);
    return '/media/' + name;
}
function removeMedia(url) {
    const m = typeof url === 'string' && /^\/media\/([a-f0-9]{24}\.[a-z0-9]{2,4})$/.exec(url);
    if (m) fs.unlink(path.join(db.MEDIA_DIR, m[1]), () => {});
}
function readImage(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    if (/^https:\/\//i.test(raw) && raw.length < 600) return raw;
    if (raw.startsWith('data:image/')) return saveMedia(raw, IMAGE_MIMES, 6 * 1024 * 1024);
    return null;
}
function readAudio(raw) {
    if (typeof raw !== 'string' || !raw.startsWith('data:')) return null;
    return saveMedia(raw, AUDIO_MIMES, 8 * 1024 * 1024);
}
function readWave(arr) {
    if (!Array.isArray(arr) || !arr.length || arr.length > 100) return null;
    return arr.map(n => Math.min(100, Math.max(0, Math.round(Number(n) || 0))));
}
function readDuration(v) {
    const n = Number(v);
    return (isFinite(n) && n > 0 && n < 3600) ? Math.round(n * 10) / 10 : 0;
}

// ============================================================
// Archivos estaticos, avatares y media
// ============================================================
app.use('/media', express.static(db.MEDIA_DIR, { maxAge: '365d', immutable: true, index: false, fallthrough: false }));

app.get('/avatar/:id', (req, res) => {
    const id = db.toId(req.params.id);
    const a = id && db.getAvatar(id);
    if (!a) return res.status(404).end();
    res.setHeader('Content-Type', a.mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.end(a.buf);
});

app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// Cuentas (registro, login, logout)
// ============================================================
function authError(res, status, error) { return res.status(status).json({ ok: false, error }); }

app.post('/api/register', async (req, res) => {
    if (!allow('reg:' + req.ip, 10, 60 * 60 * 1000)) return authError(res, 429, 'Demasiados registros desde esta conexion. Intenta mas tarde.');
    try {
        const body = req.body || {};
        const user = await db.createUser({ username: String(body.username || '').trim(), password: body.password, avatar: body.avatar });
        const token = db.createSession(user.id);
        res.json({ ok: true, token });
    } catch (e) {
        if (e.code) return authError(res, 400, e.message);
        console.error('register:', e);
        authError(res, 500, 'Error del servidor.');
    }
});

app.post('/api/login', async (req, res) => {
    const body = req.body || {};
    const name = String(body.username || '').trim().toLowerCase().slice(0, 40);
    if (!allow('login-ip:' + req.ip, 30, 10 * 60 * 1000) || !allow('login-name:' + name, 8, 10 * 60 * 1000)) {
        return authError(res, 429, 'Demasiados intentos. Espera unos minutos.');
    }
    try {
        const user = await db.checkLogin(name, body.password);
        if (!user) return authError(res, 401, 'Usuario o contraseña incorrectos.');
        res.json({ ok: true, token: db.createSession(user.id) });
    } catch (e) {
        console.error('login:', e);
        authError(res, 500, 'Error del servidor.');
    }
});

app.post('/api/logout', (req, res) => {
    const h = String(req.headers.authorization || '');
    db.destroySession(h.startsWith('Bearer ') ? h.slice(7) : (req.body && req.body.token));
    res.json({ ok: true });
});

// ============================================================
// GIFs: proxy en el servidor
// ============================================================
const isHttps = (u) => typeof u === 'string' && /^https:\/\//i.test(u);

function normalizeKlipy(json) {
    const dd = json && json.data;
    const list = dd && Array.isArray(dd.data) ? dd.data : (Array.isArray(dd) ? dd : []);
    const items = list.map(g => {
        if (!g || g.type === 'ad' || g.kind === 'ad' || !g.file) return null;
        const fl = g.file;
        const small = (fl.sm || fl.xs || fl.md || fl.hd || {}).gif;
        const medium = (fl.md || fl.sm || fl.hd || fl.xs || {}).gif;
        if (!small || !medium || !isHttps(small.url) || !isHttps(medium.url)) return null;
        return { id: String(g.slug || g.id), title: g.title || 'GIF', preview: small.url, url: medium.url, w: small.width || 0, h: small.height || 0 };
    }).filter(Boolean);
    return { items, hasNext: !!(dd && (dd.has_next || dd.hasNext)) };
}

function normalizeGiphy(json, offset) {
    const list = Array.isArray(json && json.data) ? json.data : [];
    const items = list.map(g => {
        const img = g && g.images;
        if (!img) return null;
        const small = img.fixed_height_small || img.fixed_height;
        const medium = img.fixed_height || img.original;
        if (!small || !medium || !isHttps(small.url) || !isHttps(medium.url)) return null;
        return { id: String(g.id), title: g.title || 'GIF', preview: small.url, url: medium.url, w: Number(small.width) || 0, h: Number(small.height) || 0 };
    }).filter(Boolean);
    const p = json && json.pagination;
    return { items, hasNext: !!(p && p.total_count > offset + (p.count || list.length)) };
}

app.get('/api/gifs', async (req, res) => {
    if (!GIF_API_KEY) return res.status(503).json({ error: 'no-key' });
    if (typeof fetch !== 'function') return res.status(500).json({ error: 'node-too-old' });

    const qs = String(req.query.q || '').trim().slice(0, 80);
    const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), 50);
    const cid = /^[\w-]{1,64}$/.test(String(req.query.cid || '')) ? String(req.query.cid) : 'anon';

    const cacheKey = `${GIF_PROVIDER}|${qs.toLowerCase()}|${page}`;
    const cached = gifCache.get(cacheKey);
    if (cached && Date.now() - cached.t < GIF_CACHE_TTL) return res.json(cached.data);

    let url;
    if (GIF_PROVIDER === 'giphy') {
        const params = new URLSearchParams({ api_key: GIF_API_KEY, limit: GIF_PAGE_SIZE, offset: (page - 1) * GIF_PAGE_SIZE, rating: 'g' });
        if (qs) params.set('q', qs);
        url = `https://api.giphy.com/v1/gifs/${qs ? 'search' : 'trending'}?${params}`;
    } else {
        const params = new URLSearchParams({ page, per_page: GIF_PAGE_SIZE, customer_id: cid });
        if (qs) params.set('q', qs);
        url = `https://api.klipy.com/api/v1/${encodeURIComponent(GIF_API_KEY)}/gifs/${qs ? 'search' : 'trending'}?${params}`;
    }

    try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!resp.ok) return res.status(502).json({ error: 'provider-' + resp.status });
        const json = await resp.json();
        const parsed = GIF_PROVIDER === 'giphy' ? normalizeGiphy(json, (page - 1) * GIF_PAGE_SIZE) : normalizeKlipy(json);
        const data = { ...parsed, provider: GIF_PROVIDER === 'giphy' ? 'GIPHY' : 'KLIPY' };
        if (gifCache.size > 300) gifCache.clear();
        gifCache.set(cacheKey, { t: Date.now(), data });
        res.json(data);
    } catch (err) {
        res.status(502).json({ error: 'fetch-failed' });
    }
});

// Errores de JSON invalido o demasiado grande
app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') return authError(res, 413, 'La imagen es demasiado grande.');
    if (err && err.type === 'entity.parse.failed') return authError(res, 400, 'Solicitud no valida.');
    if (err && err.status === 404) return res.status(404).end();
    console.error(err);
    res.status(500).end();
});

// ============================================================
// Estado en memoria: presencia y chat publico
// ============================================================
const presence = new Map();           // uid -> { status, connectedAt, sockets:Set }
const typingUsers = new Set();        // uid
const recordingUsers = new Set();     // uid
const publicLog = [];                 // ultimos mensajes publicos
const publicIndex = new Map();        // id -> registro
const PUBLIC_LOG_MAX = 200;

const userCache = new Map();
function pu(uid) {
    uid = String(uid);
    if (userCache.has(uid)) return userCache.get(uid);
    const row = db.getUser(Number(uid));
    const v = row ? db.publicUser(row) : null;
    if (v) userCache.set(uid, v);
    return v;
}
const invalidate = (uid) => userCache.delete(String(uid));
const statusOf = (uid) => { const p = presence.get(String(uid)); return p ? p.status : 'offline'; };
const rankOf = (uid) => { const u = pu(uid); return u ? RANK[u.role] || 0 : -1; };
const isAdminUid = (uid) => rankOf(uid) >= 1;

function hydrateUser(uid) {
    const u = pu(uid);
    return u ? { id: String(uid), uid: String(uid), nickname: u.nickname, avatar: u.avatar, color: u.color } : null;
}

function meView(uid) {
    const u = pu(uid);
    return u ? { uid: u.uid, nickname: u.nickname, avatar: u.avatar, color: u.color, bio: u.bio, role: u.role, memberSince: u.memberSince } : null;
}

function usersPayload() {
    const out = {};
    presence.forEach((p, uid) => {
        const u = pu(uid);
        if (!u) return;
        out[uid] = Object.assign({}, u, { isFirst: u.role === 'owner', status: p.status, connectedAt: p.connectedAt });
    });
    return out;
}
const broadcastUsers = () => io.emit('update-users', usersPayload());

const names = (set) => Array.from(set).map(uid => { const u = pu(uid); return u ? u.nickname : null; }).filter(Boolean);
const broadcastTyping = () => io.emit('typing update', names(typingUsers));
const broadcastRecording = () => io.emit('recording update', names(recordingUsers));

// ============================================================
// Amigos
// ============================================================
function friendEntry(viewer, fid, unreadMap) {
    const u = pu(fid);
    if (!u) return null;
    return Object.assign({}, u, {
        status: statusOf(fid),
        unread: unreadMap[fid] || 0,
        last: db.lastDm(Number(viewer), Number(fid))
    });
}

function buildFriendsState(uid) {
    const me = Number(uid);
    const unread = db.unreadMap(me);
    return {
        me: String(uid),
        friends: db.friendIds(me).map(id => friendEntry(me, id, unread)).filter(Boolean),
        incoming: db.incomingIds(me).map(id => { const u = pu(id); return u ? { uid: u.uid, nickname: u.nickname, avatar: u.avatar, color: u.color } : null; }).filter(Boolean),
        outgoing: db.outgoingIds(me).map(String)
    };
}

function pushFriendsState(uid) {
    if (presence.has(String(uid))) io.to(room(uid)).emit('friends state', buildFriendsState(uid));
}
function notifyFriendsOf(uid) {
    pushFriendsState(uid);
    db.friendIds(Number(uid)).forEach(pushFriendsState);
}
function notifyUid(uid, text) {
    io.to(room(uid)).emit('friend notice', { text });
}

function sendUnread(viewer, other, withCount) {
    const payload = { uid: String(other), last: db.lastDm(Number(viewer), Number(other)) };
    if (withCount) payload.unread = db.unreadFrom(Number(viewer), Number(other));
    io.to(room(viewer)).emit('unread update', payload);
}

// ============================================================
// Sockets
// ============================================================
io.on('connection', (socket) => {
    const me = () => socket.uid || null;
    const meNum = () => (socket.uid ? Number(socket.uid) : null);

    socket.on('join', (data) => {
        if (socket.uid) return;
        const row = db.userFromSession(data && data.session);
        if (!row) return socket.emit('join error', 'session');

        const uid = String(row.id);
        socket.uid = uid;
        socket.join(room(uid));

        let p = presence.get(uid);
        const firstSocket = !p;
        if (!p) { p = { status: 'online', connectedAt: Date.now(), sockets: new Set() }; presence.set(uid, p); }
        p.sockets.add(socket.id);
        invalidate(uid);

        socket.emit('joined', { me: meView(uid) });
        socket.emit('public history', publicLog.slice(-60).map(publicView));
        socket.emit('friends state', buildFriendsState(uid));
        if (firstSocket) {
            io.emit('system-message', `${pu(uid).nickname} ha entrado al chat.`);
            notifyFriendsOf(uid);
        }
        broadcastUsers();
    });

    // ---------------- Perfil
    socket.on('update profile', (d) => {
        const id = meNum();
        if (!id || !d || typeof d !== 'object') return;
        const row = db.getUser(id);
        if (!row) return;

        const wanted = typeof d.nickname === 'string' ? d.nickname.trim() : row.username;
        if (wanted !== row.username) {
            if (!db.validateUsername(wanted)) return socket.emit('profile result', { ok: false, error: 'El nombre debe tener 3 a 20 caracteres (letras, numeros, _ . -).' });
            if (db.isNameTaken(wanted, id)) return socket.emit('profile result', { ok: false, error: 'Ese nombre de usuario ya esta en uso.' });
        }
        if (typeof d.avatar === 'string' && d.avatar.startsWith('data:')) {
            if (!db.setAvatar(id, d.avatar)) return socket.emit('profile result', { ok: false, error: 'La imagen no es valida o es muy pesada.' });
        } else if (d.avatar === null) {
            db.setAvatar(id, null);
        }
        if (typeof d.bio === 'string') db.setBio(id, cleanBio(d.bio));
        if (wanted !== row.username) {
            db.setUsername(id, wanted);
            io.emit('system-message', `${row.username} ahora se llama ${wanted}.`);
        }
        invalidate(id);
        socket.emit('profile result', { ok: true });
        io.to(room(id)).emit('me update', meView(id));
        broadcastUsers();
        notifyFriendsOf(id);
    });

    socket.on('change status', (status) => {
        const p = presence.get(me());
        if (!p || !STATUSES.includes(status)) return;
        p.status = status;
        broadcastUsers();
        notifyFriendsOf(me());
    });

    // ---------------- Amigos
    socket.on('friend request', (d) => {
        const a = meNum(), b = db.toId(d && d.toUid);
        if (!a || !b || a === b || !db.getUser(b) || db.areFriends(a, b)) return;
        if (db.hasRequest(b, a)) { db.addFriendship(a, b); pushFriendsState(a); pushFriendsState(b); return notifyUid(b, `${pu(a).nickname} aceptó tu solicitud de amistad`); }
        if (db.hasRequest(a, b) || db.countIncoming(b) >= 50) return;
        if (!allow('freq:' + a, 20, 60 * 1000)) return;
        db.addRequest(a, b);
        pushFriendsState(a); pushFriendsState(b);
        notifyUid(b, `${pu(a).nickname} te envió una solicitud de amistad`);
    });

    socket.on('friend accept', (d) => {
        const a = meNum(), from = db.toId(d && d.fromUid);
        if (!a || !from || !db.hasRequest(from, a)) return;
        db.addFriendship(a, from);
        pushFriendsState(a); pushFriendsState(from);
        notifyUid(from, `${pu(a).nickname} aceptó tu solicitud de amistad`);
    });

    socket.on('friend decline', (d) => {
        const a = meNum(), from = db.toId(d && d.fromUid);
        if (!a || !from) return;
        db.delRequest(from, a);
        pushFriendsState(a); pushFriendsState(from);
    });

    socket.on('friend cancel', (d) => {
        const a = meNum(), to = db.toId(d && d.toUid);
        if (!a || !to) return;
        db.delRequest(a, to);
        pushFriendsState(a); pushFriendsState(to);
    });

    // Quitar a un amigo NO borra el historial: si se vuelven a agregar, la conversacion sigue ahi.
    socket.on('friend remove', (d) => {
        const a = meNum(), other = db.toId(d && d.uid);
        if (!a || !other) return;
        db.removeFriendship(a, other);
        pushFriendsState(a); pushFriendsState(other);
    });

    // ---------------- Chat publico
    function publicView(rec) {
        const reactions = {};
        Object.entries(rec.raw).forEach(([emoji, uids]) => {
            const list = uids.map(hydrateUser).filter(Boolean);
            if (list.length) reactions[emoji] = list;
        });
        const v = Object.assign({}, rec.msg);
        v.reactions = reactions;
        return v;
    }

    socket.on('chat message', (data) => {
        const uid = me(), u = uid && pu(uid);
        if (!u || !data || typeof data !== 'object') return;
        if (!allow('msg:' + uid, 12, 5000)) return;

        const text = cleanText(data.text, 2000);
        const image = readImage(data.image);
        const audio = readAudio(data.audio);
        if (!text.trim() && !image && !audio) return;

        typingUsers.delete(uid); broadcastTyping();
        if (recordingUsers.delete(uid)) broadcastRecording();

        const msg = {
            id: 'msg_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex'),
            senderId: uid, senderUid: uid,
            user: u.nickname, avatar: u.avatar, color: u.color,
            text, image, audio,
            waveform: audio ? readWave(data.waveform) : null,
            duration: audio ? readDuration(data.duration) : 0,
            time: cleanText(data.time, 14) || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            ts: Date.now(),
            replyTo: cleanReply(data.replyTo)
        };
        const rec = { msg, raw: {} };
        publicLog.push(rec);
        publicIndex.set(msg.id, rec);
        while (publicLog.length > PUBLIC_LOG_MAX) { const old = publicLog.shift(); publicIndex.delete(old.msg.id); }
        io.emit('chat message', publicView(rec));
    });

    function toggleReaction(raw, uid, emoji) {
        let already = false;
        Object.keys(raw).forEach(e => {
            raw[e] = raw[e].filter(x => {
                if (x === uid && e === emoji) already = true;
                return x !== uid;
            });
            if (!raw[e].length) delete raw[e];
        });
        if (!already) { if (!raw[emoji]) raw[emoji] = []; raw[emoji].push(uid); }
    }
    const validEmoji = (e) => typeof e === 'string' && [...e].length <= 8 && /\p{Extended_Pictographic}/u.test(e);

    socket.on('add reaction', (d) => {
        const uid = me();
        const rec = uid && d && publicIndex.get(d.msgId);
        if (!rec || !validEmoji(d.emoji)) return;
        toggleReaction(rec.raw, uid, d.emoji);
        io.emit('update reactions', { msgId: d.msgId, reactions: publicView(rec).reactions });
    });

    socket.on('edit message', (d) => {
        const uid = me();
        const rec = uid && d && publicIndex.get(d.msgId);
        if (!rec || !(rec.msg.senderUid === uid || isAdminUid(uid))) return;
        const text = cleanText(d.newText, 2000).trim();
        if (!text) return;
        rec.msg.text = text;
        io.emit('message edited', { msgId: d.msgId, newText: text });
    });

    socket.on('delete message', (msgId) => {
        const uid = me();
        const rec = uid && publicIndex.get(msgId);
        if (!rec || !(rec.msg.senderUid === uid || isAdminUid(uid))) return;
        publicIndex.delete(msgId);
        const i = publicLog.indexOf(rec);
        if (i >= 0) publicLog.splice(i, 1);
        removeMedia(rec.msg.image); removeMedia(rec.msg.audio);
        io.emit('message deleted', msgId);
    });

    socket.on('typing', (isTyping) => {
        const uid = me();
        if (!uid || statusOf(uid) === 'offline') return;
        if (isTyping) typingUsers.add(uid); else typingUsers.delete(uid);
        broadcastTyping();
    });

    socket.on('recording', (isRec) => {
        const uid = me();
        if (!uid || statusOf(uid) === 'offline') return;
        if (isRec) recordingUsers.add(uid); else recordingUsers.delete(uid);
        broadcastRecording();
    });

    // ---------------- Chats privados (permanentes en SQLite)
    const friendOnly = (to) => { const a = meNum(); return a && to && db.areFriends(a, to); };

    socket.on('get private history', (d) => {
        const to = db.toId(d && d.targetUid);
        if (!friendOnly(to)) return;
        const before = db.toId(d.before);
        const page = db.dmPage(meNum(), to, before);
        socket.emit('private history', {
            uid: String(to),
            before: before || null,
            hasMore: page.hasMore,
            messages: page.rows.map(r => db.rowToMessage(r, hydrateUser))
        });
    });

    socket.on('mark read', (d) => {
        const to = db.toId(d && d.targetUid);
        if (!meNum() || !to) return;
        db.markRead(meNum(), to);
        sendUnread(meNum(), to, true);
    });

    socket.on('private message', (data) => {
        const a = meNum(), to = db.toId(data && data.targetUid);
        if (!friendOnly(to)) return socket.emit('friend notice', { text: 'Solo puedes escribir a tus amigos.' });
        if (!allow('dm:' + a, 15, 5000)) return;

        const text = cleanText(data.text, 4000);
        const image = readImage(data.image);
        const audio = readAudio(data.audio);
        if (!text.trim() && !image && !audio) return;

        const row = db.insertDm({
            senderId: a, targetId: to, text, image, audio,
            waveform: audio ? readWave(data.waveform) : null,
            duration: audio ? readDuration(data.duration) : 0,
            time: cleanText(data.time, 14) || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            replyTo: cleanReply(data.replyTo)
        });
        const payload = db.rowToMessage(row, hydrateUser);
        io.to(room(a)).to(room(to)).emit('private message', payload);
        sendUnread(to, a, true);
        sendUnread(a, to, false);
    });

    function relay(event, to, extra) {
        const uid = me(), u = uid && pu(uid);
        if (!u || !friendOnly(to) || statusOf(uid) === 'offline') return;
        io.to(room(to)).emit(event, Object.assign({ fromUid: uid, fromName: u.nickname, status: statusOf(uid) }, extra));
    }
    socket.on('private typing', (d) => relay('private typing update', db.toId(d && d.targetUid), { isTyping: !!(d && d.isTyping) }));
    socket.on('private recording', (d) => relay('private recording update', db.toId(d && d.targetUid), { isRecording: !!(d && d.isRecording) }));

    function ownDm(d) {
        const a = meNum(), to = db.toId(d && d.targetUid);
        const row = a && to && typeof d.msgId === 'string' ? db.getDm(d.msgId) : null;
        if (!row) return null;
        const inRoom = (row.sender_id === a && row.target_id === to) || (row.sender_id === to && row.target_id === a);
        return inRoom ? { a, to, row } : null;
    }

    socket.on('add private reaction', (d) => {
        const ctx = ownDm(d);
        if (!ctx || !validEmoji(d.emoji)) return;
        const raw = db.rawReactions(ctx.row);
        toggleReaction(raw, String(ctx.a), d.emoji);
        db.setDmReactions(ctx.row.id, raw);
        const reactions = db.rowToMessage(db.getDm(ctx.row.id), hydrateUser).reactions;
        io.to(room(ctx.a)).emit('update private reactions', { uid: String(ctx.to), msgId: ctx.row.id, reactions });
        io.to(room(ctx.to)).emit('update private reactions', { uid: String(ctx.a), msgId: ctx.row.id, reactions });
    });

    socket.on('edit private message', (d) => {
        const ctx = ownDm(d);
        if (!ctx || ctx.row.sender_id !== ctx.a || !ctx.row.text) return;
        const text = cleanText(d.newText, 4000).trim();
        if (!text) return;
        db.setDmText(ctx.row.id, text);
        io.to(room(ctx.a)).emit('private message edited', { uid: String(ctx.to), msgId: ctx.row.id, newText: text });
        io.to(room(ctx.to)).emit('private message edited', { uid: String(ctx.a), msgId: ctx.row.id, newText: text });
        sendUnread(ctx.a, ctx.to, false); sendUnread(ctx.to, ctx.a, false);
    });

    // Cada usuario puede borrar sus propios mensajes; el resto del historial nunca se elimina solo.
    socket.on('delete private message', (d) => {
        const ctx = ownDm(d);
        if (!ctx || ctx.row.sender_id !== ctx.a) return;
        removeMedia(ctx.row.image); removeMedia(ctx.row.audio);
        db.deleteDm(ctx.row.id);
        io.to(room(ctx.a)).emit('private message deleted', { uid: String(ctx.to), msgId: ctx.row.id });
        io.to(room(ctx.to)).emit('private message deleted', { uid: String(ctx.a), msgId: ctx.row.id });
        sendUnread(ctx.a, ctx.to, true); sendUnread(ctx.to, ctx.a, true);
    });

    // ---------------- Administracion (verificada en el servidor)
    socket.on('admin login', (d) => {
        const uid = me();
        if (!uid) return;
        if (!allow('admin:' + uid, 5, 5 * 60 * 1000)) return socket.emit('admin result', { ok: false, error: 'Demasiados intentos. Espera unos minutos.' });
        const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
        const ok = crypto.timingSafeEqual(h(d && d.password), h(ADMIN_PASSWORD));
        if (!ok) return socket.emit('admin result', { ok: false, error: 'Clave incorrecta.' });
        if (pu(uid).role === 'user') { db.setRole(Number(uid), 'admin'); invalidate(uid); }
        io.to(room(uid)).emit('role update', { role: pu(uid).role });
        socket.emit('admin result', { ok: true });
        broadcastUsers();
    });

    // El actor debe superar en rango al objetivo (el dueño nunca puede ser tocado por otros).
    function adminTarget(d, { allowSelf = false } = {}) {
        const actor = me(), t = d && db.toId(d.targetUid);
        if (!actor || !t || !isAdminUid(actor) || !pu(t)) return null;
        const self = String(t) === actor;
        if (self ? !allowSelf : rankOf(actor) <= rankOf(t)) return null;
        return String(t);
    }

    socket.on('admin update user', (d) => {
        const t = adminTarget(d, { allowSelf: true });
        if (!t) return;
        const u = pu(t);
        const newName = typeof d.newName === 'string' ? d.newName.trim() : '';
        if (newName && newName !== u.nickname) {
            if (!db.validateUsername(newName)) return socket.emit('admin result', { ok: false, error: 'Nombre no valido (3 a 20 caracteres: letras, numeros, _ . -).' });
            if (db.isNameTaken(newName, Number(t))) return socket.emit('admin result', { ok: false, error: 'Ese nombre ya esta en uso.' });
            db.setUsername(Number(t), newName);
            io.emit('system-message', `${u.nickname} ahora se llama ${newName}.`);
        }
        if (isHexColor(d.newColor)) db.setColor(Number(t), d.newColor.toLowerCase());
        invalidate(t);
        socket.emit('admin result', { ok: true, done: 'update' });
        io.to(room(t)).emit('me update', meView(t));
        broadcastUsers();
        notifyFriendsOf(t);
    });

    socket.on('admin set role', (d) => {
        const t = adminTarget(d);
        if (!t || rankOf(me()) < 2 || !['user', 'admin'].includes(d.role)) return;
        db.setRole(Number(t), d.role);
        invalidate(t);
        io.to(room(t)).emit('role update', { role: d.role });
        socket.emit('admin result', { ok: true, done: 'role' });
        broadcastUsers();
    });

    socket.on('kick user', (d) => {
        const t = adminTarget(d);
        if (!t) return;
        io.to(room(t)).emit('kicked', pu(me()).nickname);
        io.in(room(t)).disconnectSockets(true);
    });

    socket.on('admin delete user', (d) => {
        const t = adminTarget(d);
        if (!t) return;
        const name = pu(t).nickname;
        const friends = db.friendIds(Number(t));
        io.to(room(t)).emit('account deleted');
        io.in(room(t)).disconnectSockets(true);
        db.deleteUser(Number(t));
        invalidate(t);
        presence.delete(t); typingUsers.delete(t); recordingUsers.delete(t);
        friends.forEach(pushFriendsState);
        io.emit('system-message', `La cuenta de ${name} fue eliminada.`);
        socket.emit('admin result', { ok: true, done: 'delete' });
        broadcastUsers(); broadcastTyping(); broadcastRecording();
    });

    // ---------------- Desconexion
    socket.on('disconnect', () => {
        const uid = me();
        if (!uid) return;
        const p = presence.get(uid);
        if (!p) return;
        p.sockets.delete(socket.id);
        if (p.sockets.size) return;

        const u = pu(uid);
        presence.delete(uid);
        typingUsers.delete(uid); recordingUsers.delete(uid);
        broadcastTyping(); broadcastRecording();
        if (u) {
            db.touchSeen(Number(uid));
            invalidate(uid);
            notifyFriendsOf(uid);
            io.emit('system-message', `${u.nickname} ha salido del chat.`);
        }
        broadcastUsers();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}  (base de datos: ${db.engine})`);
});'use strict';
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 10e6 });

app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
});
app.use(express.json({ limit: '1mb' }));

// ============================================================
// Configuracion
// ============================================================
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1509';
if (!process.env.ADMIN_PASSWORD) {
    console.warn('[aviso] Usando la clave de admin por defecto. Define la variable ADMIN_PASSWORD para cambiarla.');
}
const GIF_API_KEY = process.env.GIF_API_KEY || 'EqKveKya673SGDNK1vWqZlqCeczfAYPbRC3KDD9WDW8cVMQKPG6wTnMWcEoqOglk';
const GIF_PROVIDER = (process.env.GIF_PROVIDER || 'klipy').toLowerCase();
const GIF_PAGE_SIZE = 24;
const GIF_CACHE_TTL = 5 * 60 * 1000;
const gifCache = new Map();

// ============================================================
// Utilidades
// ============================================================
const room = (uid) => 'u:' + uid;
const RANK = { user: 0, admin: 1, owner: 2 };
const STATUSES = ['online', 'dnd', 'idle', 'offline'];

const buckets = new Map();
function allow(key, max, windowMs) {
    const t = Date.now();
    let b = buckets.get(key);
    if (!b || t > b.reset) { b = { count: 0, reset: t + windowMs }; buckets.set(key, b); }
    b.count++;
    return b.count <= max;
}
setInterval(() => {
    const t = Date.now();
    buckets.forEach((b, k) => { if (t > b.reset) buckets.delete(k); });
    db.purgeSessions();
}, 10 * 60 * 1000).unref();

const cleanText = (s, max) => String(s == null ? '' : s).replace(/\u0000/g, '').slice(0, max);
const cleanBio = (b) => cleanText(b, 200).replace(/[<>]/g, '').trim();
const isHexColor = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);

function cleanReply(r) {
    if (!r || typeof r !== 'object') return null;
    return {
        user: cleanText(r.user, 24),
        text: cleanText(r.text, 200),
        color: isHexColor(r.color) ? r.color : '#888888'
    };
}

// --- media: se guarda en disco y la base solo guarda la URL (historial liviano y rapido)
const IMAGE_MIMES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const AUDIO_MIMES = { 'audio/webm': 'weba', 'video/webm': 'weba', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };

function saveMedia(dataUrl, table, maxBytes) {
    const parsed = db.parseDataUrl(dataUrl, Object.keys(table), maxBytes);
    if (!parsed) return null;
    const name = crypto.randomBytes(12).toString('hex') + '.' + table[parsed.mime];
    fs.writeFileSync(path.join(db.MEDIA_DIR, name), parsed.buf);
    return '/media/' + name;
}
function removeMedia(url) {
    const m = typeof url === 'string' && /^\/media\/([a-f0-9]{24}\.[a-z0-9]{2,4})$/.exec(url);
    if (m) fs.unlink(path.join(db.MEDIA_DIR, m[1]), () => {});
}
function readImage(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    if (/^https:\/\//i.test(raw) && raw.length < 600) return raw;
    if (raw.startsWith('data:image/')) return saveMedia(raw, IMAGE_MIMES, 6 * 1024 * 1024);
    return null;
}
function readAudio(raw) {
    if (typeof raw !== 'string' || !raw.startsWith('data:')) return null;
    return saveMedia(raw, AUDIO_MIMES, 8 * 1024 * 1024);
}
function readWave(arr) {
    if (!Array.isArray(arr) || !arr.length || arr.length > 100) return null;
    return arr.map(n => Math.min(100, Math.max(0, Math.round(Number(n) || 0))));
}
function readDuration(v) {
    const n = Number(v);
    return (isFinite(n) && n > 0 && n < 3600) ? Math.round(n * 10) / 10 : 0;
}

// ============================================================
// Archivos estaticos, avatares y media
// ============================================================
app.use('/media', express.static(db.MEDIA_DIR, { maxAge: '365d', immutable: true, index: false, fallthrough: false }));

app.get('/avatar/:id', (req, res) => {
    const id = db.toId(req.params.id);
    const a = id && db.getAvatar(id);
    if (!a) return res.status(404).end();
    res.setHeader('Content-Type', a.mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.end(a.buf);
});

app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// Cuentas (registro, login, logout)
// ============================================================
function authError(res, status, error) { return res.status(status).json({ ok: false, error }); }

app.post('/api/register', async (req, res) => {
    if (!allow('reg:' + req.ip, 10, 60 * 60 * 1000)) return authError(res, 429, 'Demasiados registros desde esta conexion. Intenta mas tarde.');
    try {
        const body = req.body || {};
        const user = await db.createUser({ username: String(body.username || '').trim(), password: body.password, avatar: body.avatar });
        const token = db.createSession(user.id);
        res.json({ ok: true, token });
    } catch (e) {
        if (e.code) return authError(res, 400, e.message);
        console.error('register:', e);
        authError(res, 500, 'Error del servidor.');
    }
});

app.post('/api/login', async (req, res) => {
    const body = req.body || {};
    const name = String(body.username || '').trim().toLowerCase().slice(0, 40);
    if (!allow('login-ip:' + req.ip, 30, 10 * 60 * 1000) || !allow('login-name:' + name, 8, 10 * 60 * 1000)) {
        return authError(res, 429, 'Demasiados intentos. Espera unos minutos.');
    }
    try {
        const user = await db.checkLogin(name, body.password);
        if (!user) return authError(res, 401, 'Usuario o contraseña incorrectos.');
        res.json({ ok: true, token: db.createSession(user.id) });
    } catch (e) {
        console.error('login:', e);
        authError(res, 500, 'Error del servidor.');
    }
});

app.post('/api/logout', (req, res) => {
    const h = String(req.headers.authorization || '');
    db.destroySession(h.startsWith('Bearer ') ? h.slice(7) : (req.body && req.body.token));
    res.json({ ok: true });
});

// ============================================================
// GIFs: proxy en el servidor
// ============================================================
const isHttps = (u) => typeof u === 'string' && /^https:\/\//i.test(u);

function normalizeKlipy(json) {
    const dd = json && json.data;
    const list = dd && Array.isArray(dd.data) ? dd.data : (Array.isArray(dd) ? dd : []);
    const items = list.map(g => {
        if (!g || g.type === 'ad' || g.kind === 'ad' || !g.file) return null;
        const fl = g.file;
        const small = (fl.sm || fl.xs || fl.md || fl.hd || {}).gif;
        const medium = (fl.md || fl.sm || fl.hd || fl.xs || {}).gif;
        if (!small || !medium || !isHttps(small.url) || !isHttps(medium.url)) return null;
        return { id: String(g.slug || g.id), title: g.title || 'GIF', preview: small.url, url: medium.url, w: small.width || 0, h: small.height || 0 };
    }).filter(Boolean);
    return { items, hasNext: !!(dd && (dd.has_next || dd.hasNext)) };
}

function normalizeGiphy(json, offset) {
    const list = Array.isArray(json && json.data) ? json.data : [];
    const items = list.map(g => {
        const img = g && g.images;
        if (!img) return null;
        const small = img.fixed_height_small || img.fixed_height;
        const medium = img.fixed_height || img.original;
        if (!small || !medium || !isHttps(small.url) || !isHttps(medium.url)) return null;
        return { id: String(g.id), title: g.title || 'GIF', preview: small.url, url: medium.url, w: Number(small.width) || 0, h: Number(small.height) || 0 };
    }).filter(Boolean);
    const p = json && json.pagination;
    return { items, hasNext: !!(p && p.total_count > offset + (p.count || list.length)) };
}

app.get('/api/gifs', async (req, res) => {
    if (!GIF_API_KEY) return res.status(503).json({ error: 'no-key' });
    if (typeof fetch !== 'function') return res.status(500).json({ error: 'node-too-old' });

    const qs = String(req.query.q || '').trim().slice(0, 80);
    const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), 50);
    const cid = /^[\w-]{1,64}$/.test(String(req.query.cid || '')) ? String(req.query.cid) : 'anon';

    const cacheKey = `${GIF_PROVIDER}|${qs.toLowerCase()}|${page}`;
    const cached = gifCache.get(cacheKey);
    if (cached && Date.now() - cached.t < GIF_CACHE_TTL) return res.json(cached.data);

    let url;
    if (GIF_PROVIDER === 'giphy') {
        const params = new URLSearchParams({ api_key: GIF_API_KEY, limit: GIF_PAGE_SIZE, offset: (page - 1) * GIF_PAGE_SIZE, rating: 'g' });
        if (qs) params.set('q', qs);
        url = `https://api.giphy.com/v1/gifs/${qs ? 'search' : 'trending'}?${params}`;
    } else {
        const params = new URLSearchParams({ page, per_page: GIF_PAGE_SIZE, customer_id: cid });
        if (qs) params.set('q', qs);
        url = `https://api.klipy.com/api/v1/${encodeURIComponent(GIF_API_KEY)}/gifs/${qs ? 'search' : 'trending'}?${params}`;
    }

    try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!resp.ok) return res.status(502).json({ error: 'provider-' + resp.status });
        const json = await resp.json();
        const parsed = GIF_PROVIDER === 'giphy' ? normalizeGiphy(json, (page - 1) * GIF_PAGE_SIZE) : normalizeKlipy(json);
        const data = { ...parsed, provider: GIF_PROVIDER === 'giphy' ? 'GIPHY' : 'KLIPY' };
        if (gifCache.size > 300) gifCache.clear();
        gifCache.set(cacheKey, { t: Date.now(), data });
        res.json(data);
    } catch (err) {
        res.status(502).json({ error: 'fetch-failed' });
    }
});

// Errores de JSON invalido o demasiado grande
app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') return authError(res, 413, 'La imagen es demasiado grande.');
    if (err && err.type === 'entity.parse.failed') return authError(res, 400, 'Solicitud no valida.');
    if (err && err.status === 404) return res.status(404).end();
    console.error(err);
    res.status(500).end();
});

// ============================================================
// Estado en memoria: presencia y chat publico
// ============================================================
const presence = new Map();           // uid -> { status, connectedAt, sockets:Set }
const typingUsers = new Set();        // uid
const recordingUsers = new Set();     // uid
const publicLog = [];                 // ultimos mensajes publicos
const publicIndex = new Map();        // id -> registro
const PUBLIC_LOG_MAX = 200;

const userCache = new Map();
function pu(uid) {
    uid = String(uid);
    if (userCache.has(uid)) return userCache.get(uid);
    const row = db.getUser(Number(uid));
    const v = row ? db.publicUser(row) : null;
    if (v) userCache.set(uid, v);
    return v;
}
const invalidate = (uid) => userCache.delete(String(uid));
const statusOf = (uid) => { const p = presence.get(String(uid)); return p ? p.status : 'offline'; };
const rankOf = (uid) => { const u = pu(uid); return u ? RANK[u.role] || 0 : -1; };
const isAdminUid = (uid) => rankOf(uid) >= 1;

function hydrateUser(uid) {
    const u = pu(uid);
    return u ? { id: String(uid), uid: String(uid), nickname: u.nickname, avatar: u.avatar, color: u.color } : null;
}

function meView(uid) {
    const u = pu(uid);
    return u ? { uid: u.uid, nickname: u.nickname, avatar: u.avatar, color: u.color, bio: u.bio, role: u.role, memberSince: u.memberSince } : null;
}

function usersPayload() {
    const out = {};
    presence.forEach((p, uid) => {
        const u = pu(uid);
        if (!u) return;
        out[uid] = Object.assign({}, u, { isFirst: u.role === 'owner', status: p.status, connectedAt: p.connectedAt });
    });
    return out;
}
const broadcastUsers = () => io.emit('update-users', usersPayload());

const names = (set) => Array.from(set).map(uid => { const u = pu(uid); return u ? u.nickname : null; }).filter(Boolean);
const broadcastTyping = () => io.emit('typing update', names(typingUsers));
const broadcastRecording = () => io.emit('recording update', names(recordingUsers));

// ============================================================
// Amigos
// ============================================================
function friendEntry(viewer, fid, unreadMap) {
    const u = pu(fid);
    if (!u) return null;
    return Object.assign({}, u, {
        status: statusOf(fid),
        unread: unreadMap[fid] || 0,
        last: db.lastDm(Number(viewer), Number(fid))
    });
}

function buildFriendsState(uid) {
    const me = Number(uid);
    const unread = db.unreadMap(me);
    return {
        me: String(uid),
        friends: db.friendIds(me).map(id => friendEntry(me, id, unread)).filter(Boolean),
        incoming: db.incomingIds(me).map(id => { const u = pu(id); return u ? { uid: u.uid, nickname: u.nickname, avatar: u.avatar, color: u.color } : null; }).filter(Boolean),
        outgoing: db.outgoingIds(me).map(String)
    };
}

function pushFriendsState(uid) {
    if (presence.has(String(uid))) io.to(room(uid)).emit('friends state', buildFriendsState(uid));
}
function notifyFriendsOf(uid) {
    pushFriendsState(uid);
    db.friendIds(Number(uid)).forEach(pushFriendsState);
}
function notifyUid(uid, text) {
    io.to(room(uid)).emit('friend notice', { text });
}

function sendUnread(viewer, other, withCount) {
    const payload = { uid: String(other), last: db.lastDm(Number(viewer), Number(other)) };
    if (withCount) payload.unread = db.unreadFrom(Number(viewer), Number(other));
    io.to(room(viewer)).emit('unread update', payload);
}

// ============================================================
// Sockets
// ============================================================
io.on('connection', (socket) => {
    const me = () => socket.uid || null;
    const meNum = () => (socket.uid ? Number(socket.uid) : null);

    socket.on('join', (data) => {
        if (socket.uid) return;
        const row = db.userFromSession(data && data.session);
        if (!row) return socket.emit('join error', 'session');

        const uid = String(row.id);
        socket.uid = uid;
        socket.join(room(uid));

        let p = presence.get(uid);
        const firstSocket = !p;
        if (!p) { p = { status: 'online', connectedAt: Date.now(), sockets: new Set() }; presence.set(uid, p); }
        p.sockets.add(socket.id);
        invalidate(uid);

        socket.emit('joined', { me: meView(uid) });
        socket.emit('public history', publicLog.slice(-60).map(publicView));
        socket.emit('friends state', buildFriendsState(uid));
        if (firstSocket) {
            io.emit('system-message', `${pu(uid).nickname} ha entrado al chat.`);
            notifyFriendsOf(uid);
        }
        broadcastUsers();
    });

    // ---------------- Perfil
    socket.on('update profile', (d) => {
        const id = meNum();
        if (!id || !d || typeof d !== 'object') return;
        const row = db.getUser(id);
        if (!row) return;

        const wanted = typeof d.nickname === 'string' ? d.nickname.trim() : row.username;
        if (wanted !== row.username) {
            if (!db.validateUsername(wanted)) return socket.emit('profile result', { ok: false, error: 'El nombre debe tener 3 a 20 caracteres (letras, numeros, _ . -).' });
            if (db.isNameTaken(wanted, id)) return socket.emit('profile result', { ok: false, error: 'Ese nombre de usuario ya esta en uso.' });
        }
        if (typeof d.avatar === 'string' && d.avatar.startsWith('data:')) {
            if (!db.setAvatar(id, d.avatar)) return socket.emit('profile result', { ok: false, error: 'La imagen no es valida o es muy pesada.' });
        } else if (d.avatar === null) {
            db.setAvatar(id, null);
        }
        if (typeof d.bio === 'string') db.setBio(id, cleanBio(d.bio));
        if (wanted !== row.username) {
            db.setUsername(id, wanted);
            io.emit('system-message', `${row.username} ahora se llama ${wanted}.`);
        }
        invalidate(id);
        socket.emit('profile result', { ok: true });
        io.to(room(id)).emit('me update', meView(id));
        broadcastUsers();
        notifyFriendsOf(id);
    });

    socket.on('change status', (status) => {
        const p = presence.get(me());
        if (!p || !STATUSES.includes(status)) return;
        p.status = status;
        broadcastUsers();
        notifyFriendsOf(me());
    });

    // ---------------- Amigos
    socket.on('friend request', (d) => {
        const a = meNum(), b = db.toId(d && d.toUid);
        if (!a || !b || a === b || !db.getUser(b) || db.areFriends(a, b)) return;
        if (db.hasRequest(b, a)) { db.addFriendship(a, b); pushFriendsState(a); pushFriendsState(b); return notifyUid(b, `${pu(a).nickname} aceptó tu solicitud de amistad`); }
        if (db.hasRequest(a, b) || db.countIncoming(b) >= 50) return;
        if (!allow('freq:' + a, 20, 60 * 1000)) return;
        db.addRequest(a, b);
        pushFriendsState(a); pushFriendsState(b);
        notifyUid(b, `${pu(a).nickname} te envió una solicitud de amistad`);
    });

    socket.on('friend accept', (d) => {
        const a = meNum(), from = db.toId(d && d.fromUid);
        if (!a || !from || !db.hasRequest(from, a)) return;
        db.addFriendship(a, from);
        pushFriendsState(a); pushFriendsState(from);
        notifyUid(from, `${pu(a).nickname} aceptó tu solicitud de amistad`);
    });

    socket.on('friend decline', (d) => {
        const a = meNum(), from = db.toId(d && d.fromUid);
        if (!a || !from) return;
        db.delRequest(from, a);
        pushFriendsState(a); pushFriendsState(from);
    });

    socket.on('friend cancel', (d) => {
        const a = meNum(), to = db.toId(d && d.toUid);
        if (!a || !to) return;
        db.delRequest(a, to);
        pushFriendsState(a); pushFriendsState(to);
    });

    // Quitar a un amigo NO borra el historial: si se vuelven a agregar, la conversacion sigue ahi.
    socket.on('friend remove', (d) => {
        const a = meNum(), other = db.toId(d && d.uid);
        if (!a || !other) return;
        db.removeFriendship(a, other);
        pushFriendsState(a); pushFriendsState(other);
    });

    // ---------------- Chat publico
    function publicView(rec) {
        const reactions = {};
        Object.entries(rec.raw).forEach(([emoji, uids]) => {
            const list = uids.map(hydrateUser).filter(Boolean);
            if (list.length) reactions[emoji] = list;
        });
        const v = Object.assign({}, rec.msg);
        v.reactions = reactions;
        return v;
    }

    socket.on('chat message', (data) => {
        const uid = me(), u = uid && pu(uid);
        if (!u || !data || typeof data !== 'object') return;
        if (!allow('msg:' + uid, 12, 5000)) return;

        const text = cleanText(data.text, 2000);
        const image = readImage(data.image);
        const audio = readAudio(data.audio);
        if (!text.trim() && !image && !audio) return;

        typingUsers.delete(uid); broadcastTyping();
        if (recordingUsers.delete(uid)) broadcastRecording();

        const msg = {
            id: 'msg_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex'),
            senderId: uid, senderUid: uid,
            user: u.nickname, avatar: u.avatar, color: u.color,
            text, image, audio,
            waveform: audio ? readWave(data.waveform) : null,
            duration: audio ? readDuration(data.duration) : 0,
            time: cleanText(data.time, 14) || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            ts: Date.now(),
            replyTo: cleanReply(data.replyTo)
        };
        const rec = { msg, raw: {} };
        publicLog.push(rec);
        publicIndex.set(msg.id, rec);
        while (publicLog.length > PUBLIC_LOG_MAX) { const old = publicLog.shift(); publicIndex.delete(old.msg.id); }
        io.emit('chat message', publicView(rec));
    });

    function toggleReaction(raw, uid, emoji) {
        let already = false;
        Object.keys(raw).forEach(e => {
            raw[e] = raw[e].filter(x => {
                if (x === uid && e === emoji) already = true;
                return x !== uid;
            });
            if (!raw[e].length) delete raw[e];
        });
        if (!already) { if (!raw[emoji]) raw[emoji] = []; raw[emoji].push(uid); }
    }
    const validEmoji = (e) => typeof e === 'string' && [...e].length <= 8 && /\p{Extended_Pictographic}/u.test(e);

    socket.on('add reaction', (d) => {
        const uid = me();
        const rec = uid && d && publicIndex.get(d.msgId);
        if (!rec || !validEmoji(d.emoji)) return;
        toggleReaction(rec.raw, uid, d.emoji);
        io.emit('update reactions', { msgId: d.msgId, reactions: publicView(rec).reactions });
    });

    socket.on('edit message', (d) => {
        const uid = me();
        const rec = uid && d && publicIndex.get(d.msgId);
        if (!rec || !(rec.msg.senderUid === uid || isAdminUid(uid))) return;
        const text = cleanText(d.newText, 2000).trim();
        if (!text) return;
        rec.msg.text = text;
        io.emit('message edited', { msgId: d.msgId, newText: text });
    });

    socket.on('delete message', (msgId) => {
        const uid = me();
        const rec = uid && publicIndex.get(msgId);
        if (!rec || !(rec.msg.senderUid === uid || isAdminUid(uid))) return;
        publicIndex.delete(msgId);
        const i = publicLog.indexOf(rec);
        if (i >= 0) publicLog.splice(i, 1);
        removeMedia(rec.msg.image); removeMedia(rec.msg.audio);
        io.emit('message deleted', msgId);
    });

    socket.on('typing', (isTyping) => {
        const uid = me();
        if (!uid || statusOf(uid) === 'offline') return;
        if (isTyping) typingUsers.add(uid); else typingUsers.delete(uid);
        broadcastTyping();
    });

    socket.on('recording', (isRec) => {
        const uid = me();
        if (!uid || statusOf(uid) === 'offline') return;
        if (isRec) recordingUsers.add(uid); else recordingUsers.delete(uid);
        broadcastRecording();
    });

    // ---------------- Chats privados (permanentes en SQLite)
    const friendOnly = (to) => { const a = meNum(); return a && to && db.areFriends(a, to); };

    socket.on('get private history', (d) => {
        const to = db.toId(d && d.targetUid);
        if (!friendOnly(to)) return;
        const before = db.toId(d.before);
        const page = db.dmPage(meNum(), to, before);
        socket.emit('private history', {
            uid: String(to),
            before: before || null,
            hasMore: page.hasMore,
            messages: page.rows.map(r => db.rowToMessage(r, hydrateUser))
        });
    });

    socket.on('mark read', (d) => {
        const to = db.toId(d && d.targetUid);
        if (!meNum() || !to) return;
        db.markRead(meNum(), to);
        sendUnread(meNum(), to, true);
    });

    socket.on('private message', (data) => {
        const a = meNum(), to = db.toId(data && data.targetUid);
        if (!friendOnly(to)) return socket.emit('friend notice', { text: 'Solo puedes escribir a tus amigos.' });
        if (!allow('dm:' + a, 15, 5000)) return;

        const text = cleanText(data.text, 4000);
        const image = readImage(data.image);
        const audio = readAudio(data.audio);
        if (!text.trim() && !image && !audio) return;

        const row = db.insertDm({
            senderId: a, targetId: to, text, image, audio,
            waveform: audio ? readWave(data.waveform) : null,
            duration: audio ? readDuration(data.duration) : 0,
            time: cleanText(data.time, 14) || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            replyTo: cleanReply(data.replyTo)
        });
        const payload = db.rowToMessage(row, hydrateUser);
        io.to(room(a)).to(room(to)).emit('private message', payload);
        sendUnread(to, a, true);
        sendUnread(a, to, false);
    });

    function relay(event, to, extra) {
        const uid = me(), u = uid && pu(uid);
        if (!u || !friendOnly(to) || statusOf(uid) === 'offline') return;
        io.to(room(to)).emit(event, Object.assign({ fromUid: uid, fromName: u.nickname, status: statusOf(uid) }, extra));
    }
    socket.on('private typing', (d) => relay('private typing update', db.toId(d && d.targetUid), { isTyping: !!(d && d.isTyping) }));
    socket.on('private recording', (d) => relay('private recording update', db.toId(d && d.targetUid), { isRecording: !!(d && d.isRecording) }));

    function ownDm(d) {
        const a = meNum(), to = db.toId(d && d.targetUid);
        const row = a && to && typeof d.msgId === 'string' ? db.getDm(d.msgId) : null;
        if (!row) return null;
        const inRoom = (row.sender_id === a && row.target_id === to) || (row.sender_id === to && row.target_id === a);
        return inRoom ? { a, to, row } : null;
    }

    socket.on('add private reaction', (d) => {
        const ctx = ownDm(d);
        if (!ctx || !validEmoji(d.emoji)) return;
        const raw = db.rawReactions(ctx.row);
        toggleReaction(raw, String(ctx.a), d.emoji);
        db.setDmReactions(ctx.row.id, raw);
        const reactions = db.rowToMessage(db.getDm(ctx.row.id), hydrateUser).reactions;
        io.to(room(ctx.a)).emit('update private reactions', { uid: String(ctx.to), msgId: ctx.row.id, reactions });
        io.to(room(ctx.to)).emit('update private reactions', { uid: String(ctx.a), msgId: ctx.row.id, reactions });
    });

    socket.on('edit private message', (d) => {
        const ctx = ownDm(d);
        if (!ctx || ctx.row.sender_id !== ctx.a || !ctx.row.text) return;
        const text = cleanText(d.newText, 4000).trim();
        if (!text) return;
        db.setDmText(ctx.row.id, text);
        io.to(room(ctx.a)).emit('private message edited', { uid: String(ctx.to), msgId: ctx.row.id, newText: text });
        io.to(room(ctx.to)).emit('private message edited', { uid: String(ctx.a), msgId: ctx.row.id, newText: text });
        sendUnread(ctx.a, ctx.to, false); sendUnread(ctx.to, ctx.a, false);
    });

    // Cada usuario puede borrar sus propios mensajes; el resto del historial nunca se elimina solo.
    socket.on('delete private message', (d) => {
        const ctx = ownDm(d);
        if (!ctx || ctx.row.sender_id !== ctx.a) return;
        removeMedia(ctx.row.image); removeMedia(ctx.row.audio);
        db.deleteDm(ctx.row.id);
        io.to(room(ctx.a)).emit('private message deleted', { uid: String(ctx.to), msgId: ctx.row.id });
        io.to(room(ctx.to)).emit('private message deleted', { uid: String(ctx.a), msgId: ctx.row.id });
        sendUnread(ctx.a, ctx.to, true); sendUnread(ctx.to, ctx.a, true);
    });

    // ---------------- Administracion (verificada en el servidor)
    socket.on('admin login', (d) => {
        const uid = me();
        if (!uid) return;
        if (!allow('admin:' + uid, 5, 5 * 60 * 1000)) return socket.emit('admin result', { ok: false, error: 'Demasiados intentos. Espera unos minutos.' });
        const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
        const ok = crypto.timingSafeEqual(h(d && d.password), h(ADMIN_PASSWORD));
        if (!ok) return socket.emit('admin result', { ok: false, error: 'Clave incorrecta.' });
        if (pu(uid).role === 'user') { db.setRole(Number(uid), 'admin'); invalidate(uid); }
        io.to(room(uid)).emit('role update', { role: pu(uid).role });
        socket.emit('admin result', { ok: true });
        broadcastUsers();
    });

    // El actor debe superar en rango al objetivo (el dueño nunca puede ser tocado por otros).
    function adminTarget(d, { allowSelf = false } = {}) {
        const actor = me(), t = d && db.toId(d.targetUid);
        if (!actor || !t || !isAdminUid(actor) || !pu(t)) return null;
        const self = String(t) === actor;
        if (self ? !allowSelf : rankOf(actor) <= rankOf(t)) return null;
        return String(t);
    }

    socket.on('admin update user', (d) => {
        const t = adminTarget(d, { allowSelf: true });
        if (!t) return;
        const u = pu(t);
        const newName = typeof d.newName === 'string' ? d.newName.trim() : '';
        if (newName && newName !== u.nickname) {
            if (!db.validateUsername(newName)) return socket.emit('admin result', { ok: false, error: 'Nombre no valido (3 a 20 caracteres: letras, numeros, _ . -).' });
            if (db.isNameTaken(newName, Number(t))) return socket.emit('admin result', { ok: false, error: 'Ese nombre ya esta en uso.' });
            db.setUsername(Number(t), newName);
            io.emit('system-message', `${u.nickname} ahora se llama ${newName}.`);
        }
        if (isHexColor(d.newColor)) db.setColor(Number(t), d.newColor.toLowerCase());
        invalidate(t);
        socket.emit('admin result', { ok: true, done: 'update' });
        io.to(room(t)).emit('me update', meView(t));
        broadcastUsers();
        notifyFriendsOf(t);
    });

    socket.on('admin set role', (d) => {
        const t = adminTarget(d);
        if (!t || rankOf(me()) < 2 || !['user', 'admin'].includes(d.role)) return;
        db.setRole(Number(t), d.role);
        invalidate(t);
        io.to(room(t)).emit('role update', { role: d.role });
        socket.emit('admin result', { ok: true, done: 'role' });
        broadcastUsers();
    });

    socket.on('kick user', (d) => {
        const t = adminTarget(d);
        if (!t) return;
        io.to(room(t)).emit('kicked', pu(me()).nickname);
        io.in(room(t)).disconnectSockets(true);
    });

    socket.on('admin delete user', (d) => {
        const t = adminTarget(d);
        if (!t) return;
        const name = pu(t).nickname;
        const friends = db.friendIds(Number(t));
        io.to(room(t)).emit('account deleted');
        io.in(room(t)).disconnectSockets(true);
        db.deleteUser(Number(t));
        invalidate(t);
        presence.delete(t); typingUsers.delete(t); recordingUsers.delete(t);
        friends.forEach(pushFriendsState);
        io.emit('system-message', `La cuenta de ${name} fue eliminada.`);
        socket.emit('admin result', { ok: true, done: 'delete' });
        broadcastUsers(); broadcastTyping(); broadcastRecording();
    });

    // ---------------- Desconexion
    socket.on('disconnect', () => {
        const uid = me();
        if (!uid) return;
        const p = presence.get(uid);
        if (!p) return;
        p.sockets.delete(socket.id);
        if (p.sockets.size) return;

        const u = pu(uid);
        presence.delete(uid);
        typingUsers.delete(uid); recordingUsers.delete(uid);
        broadcastTyping(); broadcastRecording();
        if (u) {
            db.touchSeen(Number(uid));
            invalidate(uid);
            notifyFriendsOf(uid);
            io.emit('system-message', `${u.nickname} ha salido del chat.`);
        }
        broadcastUsers();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}  (base de datos: ${db.engine})`);
});
