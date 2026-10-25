const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 10e6
});

app.use(express.static('public'));

const USERS_DB_FILE = path.join(__dirname, 'users-db.json');
const FRIENDS_FILE = path.join(__dirname, 'friends-data.json');

let accounts = {}; // usernameLower -> { username, passwordHash, uid, avatar }
let profiles = {};
const friendsMap = {};
const requestsMap = {};
const onlineByUid = {};
const activeSockets = {}; // socket.id -> user session

function loadDatabase() {
    try {
        if (fs.existsSync(USERS_DB_FILE)) {
            accounts = JSON.parse(fs.readFileSync(USERS_DB_FILE, 'utf8'));
        }
    } catch (e) { accounts = {}; }

    try {
        if (fs.existsSync(FRIENDS_FILE)) {
            const raw = JSON.parse(fs.readFileSync(FRIENDS_FILE, 'utf8'));
            profiles = raw.profiles || {};
            Object.entries(raw.friends || {}).forEach(([k, v]) => { friendsMap[k] = new Set(v); });
            Object.entries(raw.requests || {}).forEach(([k, v]) => { requestsMap[k] = new Set(v); });
        }
    } catch (e) {}
}
loadDatabase();

function saveDatabase() {
    try {
        fs.writeFileSync(USERS_DB_FILE, JSON.stringify(accounts, null, 2));
    } catch (e) {}
}

function saveFriendsData() {
    try {
        const friends = {};
        const requests = {};
        Object.entries(friendsMap).forEach(([k, set]) => { if (set.size) friends[k] = [...set]; });
        Object.entries(requestsMap).forEach(([k, set]) => { if (set.size) requests[k] = [...set]; });
        fs.writeFileSync(FRIENDS_FILE, JSON.stringify({ profiles, friends, requests }, null, 2));
    } catch (e) {}
}

function hashPassword(password) {
    return crypto.createHash('sha256').update('salt_chat_' + password).digest('hex');
}

const privateMessagesStore = {}; // roomId -> Array de mensajes

function getDmRoomId(uid1, uid2) {
    return [String(uid1), String(uid2)].sort().join('__');
}

function buildFriendsState(uid) {
    return {
        me: uid,
        friends: [...(friendsMap[uid] || [])].map(id => {
            const acc = Object.values(accounts).find(a => a.uid === id);
            const sid = onlineByUid[id];
            return {
                uid: id,
                nickname: acc ? acc.username : 'Usuario',
                avatar: acc ? acc.avatar : null,
                status: sid ? 'online' : 'offline',
                color: '#007bff'
            };
        }),
        incoming: [...(requestsMap[uid] || [])].map(id => {
            const acc = Object.values(accounts).find(a => a.uid === id);
            return { uid: id, nickname: acc ? acc.username : 'Usuario', avatar: acc ? acc.avatar : null };
        }),
        outgoing: Object.keys(requestsMap).filter(to => requestsMap[to].has(uid))
    };
}

function pushFriendsState(uid) {
    const sid = onlineByUid[uid];
    if (sid) io.to(sid).emit('friends state', buildFriendsState(uid));
}

io.on('connection', (socket) => {

    // INICIO DE SESIÓN / REGISTRO
    socket.on('auth request', ({ mode, username, password, avatar }) => {
        const userKey = username.toLowerCase().trim();

        if (mode === 'register') {
            if (accounts[userKey]) {
                return socket.emit('auth response', { success: false, message: 'El nombre de usuario ya está registrado.' });
            }
            const uid = crypto.randomBytes(8).toString('hex');
            const token = crypto.randomBytes(16).toString('hex');
            accounts[userKey] = {
                username: username.trim(),
                passwordHash: hashPassword(password),
                uid: uid,
                avatar: avatar || null,
                token: token
            };
            saveDatabase();

            onlineByUid[uid] = socket.id;
            activeSockets[socket.id] = accounts[userKey];
            socket.uid = uid;

            socket.emit('auth response', { success: true, username: accounts[userKey].username, avatar: accounts[userKey].avatar, uid, token });
            pushFriendsState(uid);
        } else {
            const acc = accounts[userKey];
            if (!acc || acc.passwordHash !== hashPassword(password)) {
                return socket.emit('auth response', { success: false, message: 'Usuario o contraseña incorrectos.' });
            }

            onlineByUid[acc.uid] = socket.id;
            activeSockets[socket.id] = acc;
            socket.uid = acc.uid;

            socket.emit('auth response', { success: true, username: acc.username, avatar: acc.avatar, uid: acc.uid, token: acc.token });
            pushFriendsState(acc.uid);
        }
    });

    socket.on('auth token login', ({ token }) => {
        const acc = Object.values(accounts).find(a => a.token === token);
        if (acc) {
            onlineByUid[acc.uid] = socket.id;
            activeSockets[socket.id] = acc;
            socket.uid = acc.uid;
            socket.emit('auth response', { success: true, username: acc.username, avatar: acc.avatar, uid: acc.uid, token: acc.token });
            pushFriendsState(acc.uid);
        }
    });

    // CHAT EN VIVO Y MARCADORES DE LECTURA (VISTO)
    socket.on('private message', (data) => {
        const sender = activeSockets[socket.id];
        if (!sender || !data.targetUid) return;

        const roomId = getDmRoomId(sender.uid, data.targetUid);
        if (!privateMessagesStore[roomId]) privateMessagesStore[roomId] = [];

        const msgData = {
            id: 'dm_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
            senderUid: sender.uid,
            targetUid: data.targetUid,
            user: sender.username,
            avatar: sender.avatar,
            color: '#007bff',
            text: data.text || '',
            image: data.image || null,
            time: data.time,
            read: false
        };

        privateMessagesStore[roomId].push(msgData);

        // Enviar a emisor y receptor
        socket.emit('private message', msgData);
        const targetSocketId = onlineByUid[data.targetUid];
        if (targetSocketId) {
            io.to(targetSocketId).emit('private message', msgData);
        }
    });

    socket.on('mark as read', ({ msgId, targetUid }) => {
        const me = socket.uid;
        if (!me || !targetUid) return;
        const roomId = getDmRoomId(me, targetUid);
        const msgs = privateMessagesStore[roomId] || [];
        const msg = msgs.find(m => m.id === msgId);
        if (msg) {
            msg.read = true;
            const targetSocketId = onlineByUid[targetUid];
            if (targetSocketId) {
                io.to(targetSocketId).emit('messages read', { msgIds: [msgId] });
            }
        }
    });

    socket.on('mark as read batch', ({ msgIds, targetUid }) => {
        const me = socket.uid;
        if (!me || !targetUid || !msgIds) return;
        const roomId = getDmRoomId(me, targetUid);
        const msgs = privateMessagesStore[roomId] || [];
        msgIds.forEach(id => {
            const m = msgs.find(x => x.id === id);
            if (m) m.read = true;
        });

        const targetSocketId = onlineByUid[targetUid];
        if (targetSocketId) {
            io.to(targetSocketId).emit('messages read', { msgIds });
        }
    });

    socket.on('get private history', ({ targetUid }) => {
        const me = socket.uid;
        if (!me || !targetUid) return;
        const roomId = getDmRoomId(me, targetUid);
        socket.emit('private history', { targetUid, messages: privateMessagesStore[roomId] || [] });
    });

    socket.on('private typing', ({ targetUid, isTyping }) => {
        const targetSocketId = onlineByUid[targetUid];
        if (targetSocketId && socket.uid) {
            io.to(targetSocketId).emit('private typing update', { fromUid: socket.uid, isTyping });
        }
    });

    socket.on('disconnect', () => {
        if (socket.uid) {
            delete onlineByUid[socket.uid];
            delete activeSockets[socket.id];
            pushFriendsState(socket.uid);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor iniciado en puerto ${PORT}`));
