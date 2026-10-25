'use strict';
/**
 * Capa de datos (SQLite).
 * Usa better-sqlite3 si esta instalado; si no, el modulo nativo node:sqlite (Node 22.5+).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ---------------------------------------------------------------- adaptador
function openDatabase(file) {
    try {
        const Better = require('better-sqlite3');
        const d = new Better(file);
        d.pragma('journal_mode = WAL');
        d.pragma('foreign_keys = ON');
        d.pragma('synchronous = NORMAL');
        return { kind: 'better-sqlite3', exec: (s) => d.exec(s), prepare: (s) => d.prepare(s), tx: (fn) => d.transaction(fn) };
    } catch (e) { /* sigue con node:sqlite */ }

    try {
        const { DatabaseSync } = require('node:sqlite');
        const d = new DatabaseSync(file);
        d.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;');
        return {
            kind: 'node:sqlite',
            exec: (s) => d.exec(s),
            prepare: (s) => d.prepare(s),
            tx: (fn) => (...a) => {
                d.exec('BEGIN');
                try { const r = fn(...a); d.exec('COMMIT'); return r; }
                catch (err) { d.exec('ROLLBACK'); throw err; }
            }
        };
    } catch (e) {
        throw new Error('No hay motor SQLite disponible. Ejecuta "npm install" (better-sqlite3) o usa Node 22.5 o superior.');
    }
}

const db = openDatabase(path.join(DATA_DIR, 'chat.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass_hash TEXT NOT NULL,
    pass_salt TEXT NOT NULL,
    color TEXT NOT NULL,
    bio TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'user',
    avatar BLOB,
    avatar_mime TEXT,
    avatar_ver INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS friends (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    friend_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, friend_id)
);
CREATE TABLE IF NOT EXISTS friend_requests (
    from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (from_id, to_id)
);
CREATE TABLE IF NOT EXISTS dm_messages (
    n INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    room TEXT NOT NULL,
    sender_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    image TEXT,
    audio TEXT,
    waveform TEXT,
    duration REAL NOT NULL DEFAULT 0,
    time TEXT NOT NULL DEFAULT '',
    reply_json TEXT,
    reactions_json TEXT NOT NULL DEFAULT '{}',
    edited INTEGER NOT NULL DEFAULT 0,
    read INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dm_room ON dm_messages(room, n);
CREATE INDEX IF NOT EXISTS idx_dm_unread ON dm_messages(target_id, sender_id, read);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);

// ---------------------------------------------------------------- utilidades
const COLORS = [
    '#ff4757', '#2ed573', '#1e90ff', '#ffa502', '#eccc68',
    '#ff6b81', '#70a1ff', '#7bed9f', '#ff7f50', '#a29bfe',
    '#fd79a8', '#00cec9', '#00b894', '#e84393', '#6c5ce7',
    '#fdcb6e', '#d63031', '#e17055', '#0026ca', '#fab1a0'
];
const OWNER_COLOR = '#ffcc00';
const SESSION_TTL = 60 * 24 * 3600 * 1000;
const USERNAME_RE = /^[\p{L}\p{N}_.-]{3,20}$/u;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const now = () => Date.now();
const toId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const dmRoom = (a, b) => [Number(a), Number(b)].sort((x, y) => x - y).join('_');

function parseDataUrl(str, allowed, maxBytes) {
    if (typeof str !== 'string' || str.length > maxBytes * 1.4 + 200) return null;
    const m = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)((?:;[^,;]*)*),/i.exec(str);
    if (!m || !/;base64/i.test(m[2])) return null;
    const mime = m[1].toLowerCase();
    if (!allowed.includes(mime)) return null;
    const buf = Buffer.from(str.slice(m[0].length), 'base64');
    if (!buf.length || buf.length > maxBytes) return null;
    return { mime, buf };
}

function hashPassword(password, salt) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, 64, (err, key) => err ? reject(err) : resolve(key.toString('hex')));
    });
}

// ---------------------------------------------------------------- usuarios
const USER_COLS = `id, username, color, bio, role, avatar_ver, (avatar IS NOT NULL) AS has_avatar, created_at, last_seen`;
const q = {
    userById: db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`),
    userByName: db.prepare(`SELECT ${USER_COLS}, pass_hash, pass_salt FROM users WHERE username = ?`),
    userCount: db.prepare('SELECT COUNT(*) AS c FROM users'),
    insertUser: db.prepare('INSERT INTO users (username, pass_hash, pass_salt, color, role, avatar, avatar_mime, avatar_ver, created_at) VALUES (?,?,?,?,?,?,?,?,?)'),
    avatarById: db.prepare('SELECT avatar, avatar_mime FROM users WHERE id = ?'),
    setAvatar: db.prepare('UPDATE users SET avatar = ?, avatar_mime = ?, avatar_ver = avatar_ver + 1 WHERE id = ?'),
    setName: db.prepare('UPDATE users SET username = ? WHERE id = ?'),
    setBio: db.prepare('UPDATE users SET bio = ? WHERE id = ?'),
    setColor: db.prepare('UPDATE users SET color = ? WHERE id = ?'),
    setRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),
    setSeen: db.prepare('UPDATE users SET last_seen = ? WHERE id = ?'),
    delUser: db.prepare('DELETE FROM users WHERE id = ?'),
    insSession: db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)'),
    sessionUser: db.prepare(`SELECT s.expires_at AS expires_at, u.id AS id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`),
    delSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    delExpired: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
    nameTaken: db.prepare('SELECT id FROM users WHERE username = ?')
};

function publicUser(row) {
    if (!row) return null;
    return {
        uid: String(row.id),
        nickname: row.username,
        avatar: row.has_avatar ? `/avatar/${row.id}?v=${row.avatar_ver}` : null,
        color: row.color,
        bio: row.bio || '',
        role: row.role,
        memberSince: row.created_at,
        lastSeen: row.last_seen || 0
    };
}

const getUser = (id) => q.userById.get(id) || null;
const isNameTaken = (name, exceptId) => {
    const r = q.nameTaken.get(name);
    return !!r && r.id !== exceptId;
};

function validateUsername(name) {
    return typeof name === 'string' && USERNAME_RE.test(name);
}

async function createUser({ username, password, avatar }) {
    if (!validateUsername(username)) throw Object.assign(new Error('El usuario debe tener 3 a 20 caracteres (letras, numeros, _ . -).'), { code: 'BAD_NAME' });
    if (typeof password !== 'string' || password.length < 6 || password.length > 72) throw Object.assign(new Error('La contraseña debe tener entre 6 y 72 caracteres.'), { code: 'BAD_PASS' });
    if (isNameTaken(username, null)) throw Object.assign(new Error('Ese nombre de usuario ya esta en uso.'), { code: 'NAME_TAKEN' });

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await hashPassword(password, salt);
    const img = avatar ? parseDataUrl(avatar, ['image/png', 'image/jpeg', 'image/webp'], 600 * 1024) : null;

    const count = q.userCount.get().c;
    const role = count === 0 ? 'owner' : 'user';
    const color = role === 'owner' ? OWNER_COLOR : COLORS[count % COLORS.length];
    try {
        const info = q.insertUser.run(username, hash, salt, color, role, img ? img.buf : null, img ? img.mime : null, img ? 1 : 0, now());
        return getUser(Number(info.lastInsertRowid));
    } catch (e) {
        if (/UNIQUE/i.test(String(e.message))) throw Object.assign(new Error('Ese nombre de usuario ya esta en uso.'), { code: 'NAME_TAKEN' });
        throw e;
    }
}

async function checkLogin(username, password) {
    if (typeof username !== 'string' || typeof password !== 'string' || password.length > 72) return null;
    const row = q.userByName.get(username.trim());
    if (!row) { await hashPassword(password, 'x'.repeat(32)); return null; } // iguala tiempos
    const hash = await hashPassword(password, row.pass_salt);
    const a = Buffer.from(hash, 'hex'), b = Buffer.from(row.pass_hash, 'hex');
    return (a.length === b.length && crypto.timingSafeEqual(a, b)) ? getUser(row.id) : null;
}

function createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    q.insSession.run(sha256(token), userId, now(), now() + SESSION_TTL);
    return token;
}
function userFromSession(token) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 128) return null;
    const r = q.sessionUser.get(sha256(token));
    if (!r) return null;
    if (r.expires_at < now()) { q.delSession.run(sha256(token)); return null; }
    return getUser(r.id);
}
const destroySession = (token) => { if (typeof token === 'string') q.delSession.run(sha256(token)); };
const purgeSessions = () => q.delExpired.run(now());

function getAvatar(id) {
    const r = q.avatarById.get(id);
    return r && r.avatar ? { buf: Buffer.from(r.avatar), mime: r.avatar_mime || 'image/webp' } : null;
}
function setAvatar(id, dataUrl) {
    if (dataUrl === null) { q.setAvatar.run(null, null, id); return true; }
    const img = parseDataUrl(dataUrl, ['image/png', 'image/jpeg', 'image/webp'], 600 * 1024);
    if (!img) return false;
    q.setAvatar.run(img.buf, img.mime, id);
    return true;
}

const setUsername = (id, name) => q.setName.run(name, id);
const setBio = (id, bio) => q.setBio.run(bio, id);
const setColor = (id, color) => q.setColor.run(color, id);
const setRole = (id, role) => q.setRole.run(role, id);
const touchSeen = (id) => q.setSeen.run(now(), id);
const deleteUser = (id) => q.delUser.run(id);

// ---------------------------------------------------------------- amigos
const f = {
    areFriends: db.prepare('SELECT 1 AS x FROM friends WHERE user_id = ? AND friend_id = ?'),
    list: db.prepare('SELECT friend_id AS id FROM friends WHERE user_id = ?'),
    add: db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)'),
    del: db.prepare('DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)'),
    incoming: db.prepare('SELECT from_id AS id FROM friend_requests WHERE to_id = ? ORDER BY created_at'),
    outgoing: db.prepare('SELECT to_id AS id FROM friend_requests WHERE from_id = ?'),
    hasReq: db.prepare('SELECT 1 AS x FROM friend_requests WHERE from_id = ? AND to_id = ?'),
    addReq: db.prepare('INSERT OR IGNORE INTO friend_requests (from_id, to_id, created_at) VALUES (?,?,?)'),
    delReq: db.prepare('DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?'),
    countIn: db.prepare('SELECT COUNT(*) AS c FROM friend_requests WHERE to_id = ?')
};
const areFriends = (a, b) => !!f.areFriends.get(a, b);
const friendIds = (id) => f.list.all(id).map(r => r.id);
const incomingIds = (id) => f.incoming.all(id).map(r => r.id);
const outgoingIds = (id) => f.outgoing.all(id).map(r => r.id);
const hasRequest = (from, to) => !!f.hasReq.get(from, to);
const countIncoming = (id) => f.countIn.get(id).c;
const addRequest = (from, to) => f.addReq.run(from, to, now());
const delRequest = (from, to) => f.delReq.run(from, to);
const addFriendship = db.tx((a, b) => {
    f.delReq.run(a, b); f.delReq.run(b, a);
    f.add.run(a, b); f.add.run(b, a);
});
const removeFriendship = (a, b) => f.del.run(a, b, b, a);

// ---------------------------------------------------------------- mensajes privados
const DM_PAGE = 50;
const DM_SELECT = `SELECT m.*, u.username AS s_name, u.color AS s_color, u.avatar_ver AS s_ver, (u.avatar IS NOT NULL) AS s_has_avatar
                   FROM dm_messages m LEFT JOIN users u ON u.id = m.sender_id`;
const d = {
    insert: db.prepare(`INSERT INTO dm_messages (id, room, sender_id, target_id, text, image, audio, waveform, duration, time, reply_json, created_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
    page: db.prepare(`${DM_SELECT} WHERE m.room = ? ORDER BY m.n DESC LIMIT ?`),
    pageBefore: db.prepare(`${DM_SELECT} WHERE m.room = ? AND m.n < ? ORDER BY m.n DESC LIMIT ?`),
    byId: db.prepare(`${DM_SELECT} WHERE m.id = ?`),
    setText: db.prepare('UPDATE dm_messages SET text = ?, edited = 1 WHERE id = ?'),
    setReactions: db.prepare('UPDATE dm_messages SET reactions_json = ? WHERE id = ?'),
    del: db.prepare('DELETE FROM dm_messages WHERE id = ?'),
    markRead: db.prepare('UPDATE dm_messages SET read = 1 WHERE target_id = ? AND sender_id = ? AND read = 0'),
    unread: db.prepare('SELECT sender_id AS id, COUNT(*) AS c FROM dm_messages WHERE target_id = ? AND read = 0 GROUP BY sender_id'),
    unreadFrom: db.prepare('SELECT COUNT(*) AS c FROM dm_messages WHERE target_id = ? AND sender_id = ? AND read = 0'),
    last: db.prepare('SELECT sender_id, text, image, audio, created_at FROM dm_messages WHERE room = ? ORDER BY n DESC LIMIT 1')
};

function insertDm(m) {
    const id = 'dm_' + crypto.randomBytes(9).toString('hex');
    d.insert.run(id, dmRoom(m.senderId, m.targetId), m.senderId, m.targetId, m.text || '', m.image || null, m.audio || null,
        m.waveform ? JSON.stringify(m.waveform) : null, m.duration || 0, m.time || '', m.replyTo ? JSON.stringify(m.replyTo) : null, now());
    return getDm(id);
}

function rowToMessage(r, hydrate) {
    let reactions = {};
    try { reactions = JSON.parse(r.reactions_json || '{}'); } catch (e) {}
    const hydrated = {};
    Object.entries(reactions).forEach(([emoji, uids]) => {
        const list = (uids || []).map(hydrate).filter(Boolean);
        if (list.length) hydrated[emoji] = list;
    });
    let reply = null, wave = null;
    try { reply = r.reply_json ? JSON.parse(r.reply_json) : null; } catch (e) {}
    try { wave = r.waveform ? JSON.parse(r.waveform) : null; } catch (e) {}
    return {
        n: r.n,
        id: r.id,
        senderId: String(r.sender_id),
        senderUid: String(r.sender_id),
        targetUid: String(r.target_id),
        user: r.s_name || 'Cuenta eliminada',
        avatar: r.s_has_avatar ? `/avatar/${r.sender_id}?v=${r.s_ver}` : null,
        color: r.s_color || '#888888',
        text: r.text,
        image: r.image,
        audio: r.audio,
        waveform: wave,
        duration: r.duration || 0,
        time: r.time,
        ts: r.created_at,
        edited: !!r.edited,
        replyTo: reply,
        reactions: hydrated
    };
}

const getDm = (id) => d.byId.get(id) || null;
function dmPage(a, b, before) {
    const room = dmRoom(a, b);
    const rows = before ? d.pageBefore.all(room, before, DM_PAGE + 1) : d.page.all(room, DM_PAGE + 1);
    const hasMore = rows.length > DM_PAGE;
    if (hasMore) rows.pop();
    return { rows: rows.reverse(), hasMore };
}
const rawReactions = (row) => { try { return JSON.parse(row.reactions_json || '{}'); } catch (e) { return {}; } };
const setDmText = (id, text) => d.setText.run(text, id);
const setDmReactions = (id, obj) => d.setReactions.run(JSON.stringify(obj), id);
const deleteDm = (id) => d.del.run(id);
const markRead = (me, other) => Number(d.markRead.run(me, other).changes || 0);
const unreadMap = (me) => { const o = {}; d.unread.all(me).forEach(r => { o[r.id] = r.c; }); return o; };
const unreadFrom = (me, other) => d.unreadFrom.get(me, other).c;
function lastDm(me, other) {
    const r = d.last.get(dmRoom(me, other));
    if (!r) return null;
    return {
        kind: r.image ? 'image' : (r.audio ? 'audio' : 'text'),
        text: String(r.text || '').slice(0, 60),
        mine: r.sender_id === me,
        ts: r.created_at
    };
}

module.exports = {
    MEDIA_DIR, COLORS, OWNER_COLOR, DM_PAGE,
    toId, dmRoom, parseDataUrl, validateUsername,
    publicUser, getUser, isNameTaken, createUser, checkLogin,
    createSession, userFromSession, destroySession, purgeSessions,
    getAvatar, setAvatar, setUsername, setBio, setColor, setRole, touchSeen, deleteUser,
    areFriends, friendIds, incomingIds, outgoingIds, hasRequest, countIncoming,
    addRequest, delRequest, addFriendship, removeFriendship,
    insertDm, getDm, dmPage, rowToMessage, rawReactions, setDmText, setDmReactions, deleteDm,
    markRead, unreadMap, unreadFrom, lastDm,
    engine: db.kind
};
