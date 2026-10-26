import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const FRIENDS_FILE = path.join(DATA_DIR, 'friends-data.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages-data.json');

// GIFs Configuration
const GIF_API_KEY = process.env.GIF_API_KEY || 'EqKveKya673SGDNK1vWqZlqCeczfAYPbRC3KDD9WDW8cVMQKPG6wTnMWcEoqOglk';
const GIF_PROVIDER = (process.env.GIF_PROVIDER || 'klipy').toLowerCase();
const GIF_PAGE_SIZE = 24;
const GIF_CACHE_TTL = 5 * 60 * 1000;
const gifCache = new Map<string, { t: number; data: unknown }>();

function isHttps(u: unknown): boolean {
  return typeof u === 'string' && /^https:\/\//i.test(u);
}

interface GifItem {
  id: string;
  title: string;
  preview: string;
  url: string;
  w: number;
  h: number;
}

function normalizeKlipy(json: any): { items: GifItem[]; hasNext: boolean } {
  const d = json && json.data;
  const list = d && Array.isArray(d.data) ? d.data : Array.isArray(d) ? d : [];
  const items: GifItem[] = list
    .map((g: any) => {
      if (!g || g.type === 'ad' || g.kind === 'ad' || !g.file) return null;
      const f = g.file;
      const small = (f.sm || f.xs || f.md || f.hd || {}).gif;
      const medium = (f.md || f.sm || f.hd || f.xs || {}).gif;
      if (!small || !medium || !isHttps(small.url) || !isHttps(medium.url)) return null;
      return {
        id: String(g.slug || g.id),
        title: g.title || 'GIF',
        preview: small.url,
        url: medium.url,
        w: small.width || 0,
        h: small.height || 0,
      };
    })
    .filter((x: any): x is GifItem => x !== null);
  return { items, hasNext: !!(d && (d.has_next || d.hasNext)) };
}

function normalizeGiphy(json: any, offset: number): { items: GifItem[]; hasNext: boolean } {
  const list = Array.isArray(json && json.data) ? json.data : [];
  const items: GifItem[] = list
    .map((g: any) => {
      const img = g && g.images;
      if (!img) return null;
      const small = img.fixed_height_small || img.fixed_height;
      const medium = img.fixed_height || img.original;
      if (!small || !medium || !isHttps(small.url) || !isHttps(medium.url)) return null;
      return {
        id: String(g.id),
        title: g.title || 'GIF',
        preview: small.url,
        url: medium.url,
        w: Number(small.width) || 0,
        h: Number(small.height) || 0,
      };
    })
    .filter((x: any): x is GifItem => x !== null);
  const p = json && json.pagination;
  const hasNext = !!(p && p.total_count > offset + (p.count || list.length));
  return { items, hasNext };
}

const AVAILABLE_COLORS = [
  '#ff4757', '#2ed573', '#1e90ff', '#ffa502', '#eccc68',
  '#ff6b81', '#70a1ff', '#7bed9f', '#ff7f50', '#a29bfe',
  '#fd79a8', '#00cec9', '#00b894', '#e84393', '#6c5ce7',
  '#fdcb6e', '#d63031', '#e17055', '#0026ca', '#fab1a0',
];

let colorIndex = 0;
function getUniqueColor(): string {
  const color = AVAILABLE_COLORS[colorIndex % AVAILABLE_COLORS.length];
  colorIndex++;
  return color;
}

interface UserSession {
  nickname: string;
  avatar: string | null;
  color: string;
  isFirst: boolean;
  status: string;
  bio: string;
  memberSince: number;
  connectedAt: number;
  uid: string;
  userCode: string;
}

interface UserProfile {
  nickname: string;
  avatar: string | null;
  color: string;
  bio: string;
  memberSince: number;
  lastSeen: number;
  userCode: string;
}

interface ChatMessage {
  id: string;
  senderId: string;
  senderUid: string | null;
  senderUserCode?: string;
  targetUid?: string;
  user: string;
  avatar: string | null;
  color: string;
  text: string;
  image: string | null;
  audio: string | null;
  waveform: number[] | null;
  duration: number;
  time: string;
  replyTo: any;
  reactions: Record<string, any[]>;
}

const users: Record<string, UserSession> = {};
const typingUsers = new Set<string>();
const recordingUsers = new Set<string>();

let profiles: Record<string, UserProfile> = {};
const friendsMap: Record<string, Set<string>> = {};
const requestsMap: Record<string, Set<string>> = {};
const onlineByUid: Record<string, string> = {};

let messageIdCounter = 0;
let messagesStore: Record<string, ChatMessage> = {};
const privateMessagesStore: Record<string, ChatMessage[]> = {};

function getDmRoomId(uid1: string, uid2: string): string {
  return [String(uid1), String(uid2)].sort().join('__');
}

function uidFromToken(token: string): string {
  return crypto.createHash('sha256').update('chat-uid:' + token).digest('hex').slice(0, 16);
}

function cleanName(n: any): string {
  return String(n || '').replace(/[<>]/g, '').trim().slice(0, 24);
}

function cleanBio(b: any): string {
  return String(b || '').replace(/[<>]/g, '').trim().slice(0, 200);
}

function cleanAvatar(a: any): string | null {
  return (typeof a === 'string' && a.startsWith('data:image/') && a.length <= 8000000) ? a : null;
}

// Persist & Load
function loadData() {
  try {
    if (fs.existsSync(FRIENDS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(FRIENDS_FILE, 'utf8'));
      profiles = raw.profiles || {};
      Object.entries(raw.friends || {}).forEach(([k, v]) => {
        friendsMap[k] = new Set(v as string[]);
      });
      Object.entries(raw.requests || {}).forEach(([k, v]) => {
        requestsMap[k] = new Set(v as string[]);
      });
    }
  } catch (e) {
    console.warn('Error reading friends file:', e);
  }

  try {
    if (fs.existsSync(MESSAGES_FILE)) {
      const raw = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
      messagesStore = raw.messagesStore || {};
      Object.entries(raw.privateMessagesStore || {}).forEach(([k, v]) => {
        privateMessagesStore[k] = v as ChatMessage[];
      });
      messageIdCounter = Number(raw.messageIdCounter) || Object.keys(messagesStore).length;
    }
  } catch (e) {
    console.warn('Error reading messages file:', e);
  }
}
loadData();

let saveFriendsTimer: NodeJS.Timeout | null = null;
function saveFriendsData() {
  if (saveFriendsTimer) clearTimeout(saveFriendsTimer);
  saveFriendsTimer = setTimeout(() => {
    const keep = new Set<string>();
    const friends: Record<string, string[]> = {};
    const requests: Record<string, string[]> = {};
    Object.entries(friendsMap).forEach(([k, set]) => {
      if (set.size) {
        friends[k] = [...set];
        keep.add(k);
        set.forEach((x) => keep.add(x));
      }
    });
    Object.entries(requestsMap).forEach(([k, set]) => {
      if (set.size) {
        requests[k] = [...set];
        keep.add(k);
        set.forEach((x) => keep.add(x));
      }
    });
    const outProfiles: Record<string, UserProfile> = {};
    keep.forEach((id) => {
      const p = profiles[id];
      if (p) {
        outProfiles[id] = {
          ...p,
          avatar: p.avatar && p.avatar.length <= 300000 ? p.avatar : null,
        };
      }
    });
    fs.writeFile(
      FRIENDS_FILE,
      JSON.stringify({ profiles: outProfiles, friends, requests }, null, 2),
      (err) => {
        if (err) console.error('Error saving friends data:', err.message);
      }
    );
  }, 600);
}

let saveMessagesTimer: NodeJS.Timeout | null = null;
function saveMessagesData() {
  if (saveMessagesTimer) clearTimeout(saveMessagesTimer);
  saveMessagesTimer = setTimeout(() => {
    // Keep last 250 public messages
    const entries = Object.entries(messagesStore);
    if (entries.length > 250) {
      messagesStore = Object.fromEntries(entries.slice(entries.length - 250));
    }
    fs.writeFile(
      MESSAGES_FILE,
      JSON.stringify(
        {
          messageIdCounter,
          messagesStore,
          privateMessagesStore,
        },
        null,
        2
      ),
      (err) => {
        if (err) console.error('Error saving messages data:', err.message);
      }
    );
  }, 1000);
}

function hasRelations(id: string): boolean {
  if (friendsMap[id] && friendsMap[id].size) return true;
  if (requestsMap[id] && requestsMap[id].size) return true;
  return Object.values(requestsMap).some((set) => set.has(id));
}

function friendStatus(id: string): string {
  const sid = onlineByUid[id];
  const u = sid && users[sid];
  return u ? u.status || 'online' : 'offline';
}

function getOrGenerateUserCode(uid: string): string {
  if (profiles[uid] && (profiles[uid] as any).userCode) {
    return (profiles[uid] as any).userCode;
  }
  let hash = 0;
  for (let i = 0; i < uid.length; i++) {
    hash = (hash * 37 + uid.charCodeAt(i)) >>> 0;
  }
  const code = `#${1000 + (hash % 9000)}`;
  if (profiles[uid]) {
    (profiles[uid] as any).userCode = code;
  }
  return code;
}

function friendEntry(id: string) {
  const p = profiles[id] || { nickname: 'Usuario' };
  const sid = onlineByUid[id];
  const src = (sid && users[sid]) || p;
  const userCode = (src as any).userCode || (p as any).userCode || getOrGenerateUserCode(id);
  return {
    uid: id,
    userCode,
    nickname: src.nickname || 'Usuario',
    avatar: src.avatar || null,
    color: src.color || '#888888',
    bio: src.bio || '',
    memberSince: (src as any).memberSince || 0,
    lastSeen: p.lastSeen || 0,
    status: friendStatus(id),
  };
}

function buildFriendsState(id: string) {
  return {
    me: id,
    friends: [...(friendsMap[id] || [])].map(friendEntry),
    incoming: [...(requestsMap[id] || [])].map((f) => {
      const e = friendEntry(f);
      return { uid: e.uid, userCode: (e as any).userCode, nickname: e.nickname, avatar: e.avatar, color: e.color };
    }),
    outgoing: Object.keys(requestsMap).filter((to) => requestsMap[to].has(id)),
  };
}

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    maxHttpBufferSize: 10e6, // 10 MB for voice notes and images
    cors: { origin: '*' },
  });

  app.use(express.json({ limit: '10mb' }));

  // GIFs API proxy
  app.get('/api/gifs', async (req, res) => {
    if (!GIF_API_KEY) return res.status(503).json({ error: 'no-key' });

    const q = String(req.query.q || '').trim().slice(0, 80);
    const page = Math.min(Math.max(parseInt(req.query.page as string, 10) || 1, 1), 50);
    const cid = /^[\w-]{1,64}$/.test(String(req.query.cid || '')) ? String(req.query.cid) : 'anon';

    const cacheKey = `${GIF_PROVIDER}|${q.toLowerCase()}|${page}`;
    const cached = gifCache.get(cacheKey);
    if (cached && Date.now() - cached.t < GIF_CACHE_TTL) {
      return res.json(cached.data);
    }

    let url: string;
    if (GIF_PROVIDER === 'giphy') {
      const params = new URLSearchParams({
        api_key: GIF_API_KEY,
        limit: String(GIF_PAGE_SIZE),
        offset: String((page - 1) * GIF_PAGE_SIZE),
        rating: 'g',
      });
      if (q) params.set('q', q);
      url = `https://api.giphy.com/v1/gifs/${q ? 'search' : 'trending'}?${params}`;
    } else {
      const params = new URLSearchParams({
        page: String(page),
        per_page: String(GIF_PAGE_SIZE),
        customer_id: cid,
      });
      if (q) params.set('q', q);
      url = `https://api.klipy.com/api/v1/${encodeURIComponent(GIF_API_KEY)}/gifs/${q ? 'search' : 'trending'}?${params}`;
    }

    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!resp.ok) return res.status(502).json({ error: 'provider-' + resp.status });
      const json = await resp.json();

      const parsed =
        GIF_PROVIDER === 'giphy'
          ? normalizeGiphy(json, (page - 1) * GIF_PAGE_SIZE)
          : normalizeKlipy(json);

      const data = { ...parsed, provider: GIF_PROVIDER === 'giphy' ? 'GIPHY' : 'KLIPY' };

      if (gifCache.size > 300) gifCache.clear();
      gifCache.set(cacheKey, { t: Date.now(), data });
      res.json(data);
    } catch {
      res.status(502).json({ error: 'fetch-failed' });
    }
  });

  function broadcastTypingStatus() {
    const names = Array.from(typingUsers)
      .map((id) => (users[id] ? users[id].nickname : null))
      .filter(Boolean);
    io.emit('typing update', names);
  }

  function broadcastRecordingStatus() {
    const names = Array.from(recordingUsers)
      .map((id) => (users[id] ? users[id].nickname : null))
      .filter(Boolean);
    io.emit('recording update', names);
  }

  function pushFriendsState(id: string) {
    const sid = onlineByUid[id];
    if (sid) io.to(sid).emit('friends state', buildFriendsState(id));
  }

  function notifyFriendsOf(id: string) {
    pushFriendsState(id);
    (friendsMap[id] || []).forEach(pushFriendsState);
  }

  function notifyUid(id: string, text: string) {
    const sid = onlineByUid[id];
    if (sid) io.to(sid).emit('friend notice', { text });
  }

  function acceptFriendship(me: string, other: string) {
    if (requestsMap[me]) requestsMap[me].delete(other);
    if (requestsMap[other]) requestsMap[other].delete(me);
    if (!friendsMap[me]) friendsMap[me] = new Set();
    if (!friendsMap[other]) friendsMap[other] = new Set();
    friendsMap[me].add(other);
    friendsMap[other].add(me);
    saveFriendsData();
    pushFriendsState(me);
    pushFriendsState(other);
    const myName = (profiles[me] && profiles[me].nickname) || 'Alguien';
    notifyUid(other, `${myName} aceptó tu solicitud de amistad`);
  }

  function syncProfileFromSocket(socketId: string) {
    const u = users[socketId];
    if (!u || !u.uid) return;
    profiles[u.uid] = {
      nickname: u.nickname,
      avatar: u.avatar,
      color: u.color,
      bio: u.bio,
      memberSince: u.memberSince,
      lastSeen: Date.now(),
      userCode: u.userCode || getOrGenerateUserCode(u.uid),
    };
    if (hasRelations(u.uid)) saveFriendsData();
    notifyFriendsOf(u.uid);
  }

  // Socket.IO Events
  io.on('connection', (socket: Socket) => {
    socket.on('join', (userData: any) => {
      const nickname = userData && userData.nickname ? cleanName(userData.nickname) || 'Anónimo' : 'Anónimo';
      const avatar = userData && userData.avatar ? cleanAvatar(userData.avatar) : null;
      const bio = userData && userData.bio ? cleanBio(userData.bio) : '';

      let token = userData && typeof userData.token === 'string' && userData.token.length >= 8 ? userData.token : null;
      if (!token) {
        token = crypto.randomBytes(16).toString('hex');
      }
      const uid = uidFromToken(token);
      const userCode = getOrGenerateUserCode(uid);
      (socket as any).uid = uid;
      (socket as any).userCode = userCode;

      // 1. Detección de cuenta duplicada: misma cuenta (mismo UID / token) abierta en otra pestaña
      const existingSocketIdByUid = onlineByUid[uid];
      if (existingSocketIdByUid && existingSocketIdByUid !== socket.id) {
        const oldSocket = io.sockets.sockets.get(existingSocketIdByUid);
        if (oldSocket) {
          oldSocket.emit('duplicate-session', {
            title: 'Sesión Duplicada Detectada',
            message: 'Has iniciado sesión con tu cuenta desde otra pestaña o dispositivo. Por seguridad, esta sesión ha sido cerrada.',
            reason: 'same_account',
            userCode,
          });
          oldSocket.disconnect(true);
        }
      }

      // 2. Detección de nombre duplicado: otro usuario conectado con el mismo apodo exacto
      const duplicateNickEntry = Object.entries(users).find(
        ([sid, u]) => sid !== socket.id && u.uid !== uid && u.nickname.toLowerCase() === nickname.toLowerCase()
      );
      if (duplicateNickEntry) {
        socket.emit('duplicate-session', {
          title: 'Nombre de Cuenta en Uso',
          message: `El apodo "${nickname}" ya está siendo utilizado por un usuario activo en el chat. Por favor, elige otro apodo para ingresar.`,
          reason: 'nickname_taken',
          userCode,
        });
        socket.disconnect(true);
        return;
      }

      socket.emit('session', { uid, userCode });

      let memberSince = Number(userData && userData.memberSince);
      if (!isFinite(memberSince) || memberSince < 1577836800000 || memberSince > Date.now()) {
        memberSince = Date.now();
      }

      (socket as any).nickname = nickname;
      const isFirst = Object.keys(users).length === 0;
      (socket as any).userColor = isFirst ? '#ffcc00' : getUniqueColor();

      users[socket.id] = {
        nickname: (socket as any).nickname,
        avatar,
        color: (socket as any).userColor,
        isFirst,
        status: 'online',
        bio,
        memberSince,
        connectedAt: Date.now(),
        uid,
        userCode,
      };

      onlineByUid[uid] = socket.id;
      syncProfileFromSocket(socket.id);

      io.emit('system-message', `${(socket as any).nickname} (${userCode}) ha entrado al chat.`);
      io.emit('update-users', users);

      // Replay existing recent messages to the newcomer
      Object.values(messagesStore).forEach((msg) => {
        socket.emit('chat message', msg);
      });
    });

    socket.on('friend request', (d: any) => {
      const me = (socket as any).uid;
      const to = d && d.toUid;
      if (!me || typeof to !== 'string' || to === me || !profiles[to]) return;
      if (friendsMap[me] && friendsMap[me].has(to)) return;

      if (requestsMap[me] && requestsMap[me].has(to)) {
        acceptFriendship(me, to);
        return;
      }

      if (!requestsMap[to]) requestsMap[to] = new Set();
      if (requestsMap[to].has(me) || requestsMap[to].size >= 50) return;
      requestsMap[to].add(me);

      saveFriendsData();
      pushFriendsState(me);
      pushFriendsState(to);
      const myName = (users[socket.id] && users[socket.id].nickname) || 'Alguien';
      notifyUid(to, `${myName} te envió una solicitud de amistad`);
    });

    socket.on('friend accept', (d: any) => {
      const me = (socket as any).uid;
      const from = d && d.fromUid;
      if (!me || typeof from !== 'string') return;
      if (!requestsMap[me] || !requestsMap[me].has(from)) return;
      acceptFriendship(me, from);
    });

    socket.on('friend decline', (d: any) => {
      const me = (socket as any).uid;
      const from = d && d.fromUid;
      if (!me || typeof from !== 'string' || !requestsMap[me]) return;
      requestsMap[me].delete(from);
      saveFriendsData();
      pushFriendsState(me);
      pushFriendsState(from);
    });

    socket.on('friend cancel', (d: any) => {
      const me = (socket as any).uid;
      const to = d && d.toUid;
      if (!me || typeof to !== 'string' || !requestsMap[to]) return;
      requestsMap[to].delete(me);
      saveFriendsData();
      pushFriendsState(me);
      pushFriendsState(to);
    });

    socket.on('friend remove', (d: any) => {
      const me = (socket as any).uid;
      const other = d && d.uid;
      if (!me || typeof other !== 'string') return;
      if (friendsMap[me]) friendsMap[me].delete(other);
      if (friendsMap[other]) friendsMap[other].delete(me);
      saveFriendsData();
      pushFriendsState(me);
      pushFriendsState(other);
    });

    socket.on('update profile', (p: any) => {
      const u = users[socket.id];
      if (!u || !p) return;

      const oldName = u.nickname;
      const newName = cleanName(p.nickname);
      if (newName) {
        u.nickname = newName;
        (socket as any).nickname = newName;
      }
      if (p.avatar === null) {
        u.avatar = null;
      } else if (typeof p.avatar === 'string') {
        const a = cleanAvatar(p.avatar);
        if (a) u.avatar = a;
      }
      if (typeof p.bio === 'string') u.bio = cleanBio(p.bio);

      if (newName && newName !== oldName) {
        io.emit('system-message', `${oldName} ahora se llama ${newName}.`);
      }
      io.emit('update-users', users);
      syncProfileFromSocket(socket.id);
    });

    socket.on('change status', (status: string) => {
      if (users[socket.id]) {
        users[socket.id].status = status;
        io.emit('update-users', users);
        if (users[socket.id].uid) notifyFriendsOf(users[socket.id].uid);
      }
    });

    // --- Public Messages ---
    socket.on('chat message', (data: any) => {
      if (users[socket.id]) {
        messageIdCounter++;
        const msgId = 'msg_' + messageIdCounter + '_' + Date.now();

        typingUsers.delete(socket.id);
        broadcastTypingStatus();
        if (recordingUsers.delete(socket.id)) broadcastRecordingStatus();

        let image = data.image || null;
        if (typeof image !== 'string' || !(image.startsWith('data:image/') || /^https:\/\//i.test(image))) {
          image = null;
        }

        let audio = data.audio || null;
        if (typeof audio !== 'string' || !audio.startsWith('data:audio/')) audio = null;

        let waveform: number[] | null = null;
        if (Array.isArray(data.waveform) && data.waveform.length > 0 && data.waveform.length <= 100) {
          waveform = data.waveform.map((n: any) => Math.min(100, Math.max(0, Math.round(Number(n) || 0))));
        }
        let duration = Number(data.duration);
        duration = isFinite(duration) && duration > 0 && duration < 3600 ? Math.round(duration * 10) / 10 : 0;

        const msgData: ChatMessage = {
          id: msgId,
          senderId: socket.id,
          senderUid: users[socket.id].uid || null,
          user: users[socket.id].nickname,
          avatar: users[socket.id].avatar,
          color: users[socket.id].color,
          text: data.text || '',
          image,
          audio,
          waveform: audio ? waveform : null,
          duration: audio ? duration : 0,
          time: data.time,
          replyTo: data.replyTo || null,
          reactions: {},
        };

        messagesStore[msgId] = msgData;
        saveMessagesData();
        io.emit('chat message', msgData);
      }
    });

    // --- Private DMs ---
    socket.on('get private history', ({ targetUid }: { targetUid: string }) => {
      const me = (socket as any).uid;
      if (!me || !targetUid) return;
      const roomId = getDmRoomId(me, targetUid);
      const history = privateMessagesStore[roomId] || [];
      socket.emit('private history', { targetUid, messages: history });
    });

    socket.on('private message', (data: any) => {
      const me = (socket as any).uid;
      const toUid = data && data.targetUid;
      const u = users[socket.id];
      if (!me || !toUid || !u) return;

      messageIdCounter++;
      const msgId = 'dm_' + messageIdCounter + '_' + Date.now();
      const roomId = getDmRoomId(me, toUid);

      let image = data.image || null;
      if (typeof image !== 'string' || !(image.startsWith('data:image/') || /^https:\/\//i.test(image))) {
        image = null;
      }

      let audio = data.audio || null;
      if (typeof audio !== 'string' || !audio.startsWith('data:audio/')) audio = null;

      let waveform: number[] | null = null;
      if (Array.isArray(data.waveform) && data.waveform.length > 0 && data.waveform.length <= 100) {
        waveform = data.waveform.map((n: any) => Math.min(100, Math.max(0, Math.round(Number(n) || 0))));
      }
      let duration = Number(data.duration);
      duration = isFinite(duration) && duration > 0 && duration < 3600 ? Math.round(duration * 10) / 10 : 0;

      const msgData: ChatMessage = {
        id: msgId,
        senderId: socket.id,
        senderUid: me,
        senderUserCode: u.userCode || (socket as any).userCode || getOrGenerateUserCode(me),
        targetUid: toUid,
        user: u.nickname,
        avatar: u.avatar,
        color: u.color,
        text: data.text || '',
        image,
        audio,
        waveform: audio ? waveform : null,
        duration: audio ? duration : 0,
        time: data.time,
        replyTo: data.replyTo || null,
        reactions: {},
      };

      if (!privateMessagesStore[roomId]) privateMessagesStore[roomId] = [];
      privateMessagesStore[roomId].push(msgData);
      if (privateMessagesStore[roomId].length > 150) privateMessagesStore[roomId].shift();
      saveMessagesData();

      socket.emit('private message', msgData);

      const destSocketId = onlineByUid[toUid];
      if (destSocketId && destSocketId !== socket.id) {
        io.to(destSocketId).emit('private message', msgData);
        // Clear sender private typing indicator on message arrival
        io.to(destSocketId).emit('private typing update', {
          fromUid: me,
          fromName: u.nickname,
          isTyping: false,
        });
      }
    });

    socket.on('private typing', ({ targetUid, isTyping }: any) => {
      const destSocketId = onlineByUid[targetUid];
      if (destSocketId && users[socket.id]) {
        io.to(destSocketId).emit('private typing update', {
          fromUid: (socket as any).uid,
          fromName: users[socket.id].nickname,
          isTyping: !!isTyping,
        });
      }
    });

    socket.on('private recording', ({ targetUid, isRecording }: any) => {
      const destSocketId = onlineByUid[targetUid];
      if (destSocketId && users[socket.id]) {
        io.to(destSocketId).emit('private recording update', {
          fromUid: (socket as any).uid,
          fromName: users[socket.id].nickname,
          isRecording: !!isRecording,
        });
      }
    });

    socket.on('add private reaction', ({ targetUid, msgId, emoji }: any) => {
      const me = (socket as any).uid;
      if (!me || !targetUid || !users[socket.id]) return;
      const roomId = getDmRoomId(me, targetUid);
      const list = privateMessagesStore[roomId] || [];
      const msg = list.find((m) => m.id === msgId);
      if (!msg) return;

      if (!msg.reactions) msg.reactions = {};
      let alreadyReacted = false;

      Object.keys(msg.reactions).forEach((e) => {
        msg.reactions[e] = msg.reactions[e].filter((item) => {
          if (item.uid === me && e === emoji) {
            alreadyReacted = true;
            return false;
          }
          return item.uid !== me;
        });
        if (msg.reactions[e].length === 0) delete msg.reactions[e];
      });

      if (!alreadyReacted) {
        if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
        msg.reactions[emoji].push({
          id: socket.id,
          uid: me,
          nickname: users[socket.id].nickname,
          avatar: users[socket.id].avatar,
          color: users[socket.id].color,
        });
      }

      saveMessagesData();
      const payload = { targetUid, msgId, reactions: msg.reactions };
      socket.emit('update private reactions', payload);
      const destSocketId = onlineByUid[targetUid];
      if (destSocketId && destSocketId !== socket.id) {
        io.to(destSocketId).emit('update private reactions', { targetUid: me, msgId, reactions: msg.reactions });
      }
    });

    socket.on('delete private message', ({ targetUid, msgId }: any) => {
      const me = (socket as any).uid;
      if (!me || !targetUid) return;
      const roomId = getDmRoomId(me, targetUid);
      if (privateMessagesStore[roomId]) {
        privateMessagesStore[roomId] = privateMessagesStore[roomId].filter((m) => m.id !== msgId);
        saveMessagesData();
      }
      socket.emit('private message deleted', { targetUid, msgId });
      const destSocketId = onlineByUid[targetUid];
      if (destSocketId) {
        io.to(destSocketId).emit('private message deleted', { targetUid: me, msgId });
      }
    });

    socket.on('edit private message', ({ targetUid, msgId, newText }: any) => {
      const me = (socket as any).uid;
      if (!me || !targetUid) return;
      const roomId = getDmRoomId(me, targetUid);
      const msg = (privateMessagesStore[roomId] || []).find((m) => m.id === msgId);
      if (msg) {
        msg.text = newText;
        saveMessagesData();
      }

      socket.emit('private message edited', { targetUid, msgId, newText });
      const destSocketId = onlineByUid[targetUid];
      if (destSocketId) {
        io.to(destSocketId).emit('private message edited', { targetUid: me, msgId, newText });
      }
    });

    // --- Public reactions & edits ---
    socket.on('add reaction', ({ msgId, emoji }: any) => {
      const user = users[socket.id];
      const msg = messagesStore[msgId];
      if (user && msg) {
        if (!msg.reactions) msg.reactions = {};

        let alreadyReacted = false;
        Object.keys(msg.reactions).forEach((e) => {
          msg.reactions[e] = msg.reactions[e].filter((item) => {
            if (item.id === socket.id && e === emoji) {
              alreadyReacted = true;
              return false;
            }
            if (item.id === socket.id) return false;
            return true;
          });
          if (msg.reactions[e].length === 0) delete msg.reactions[e];
        });

        if (!alreadyReacted) {
          if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
          msg.reactions[emoji].push({
            id: socket.id,
            nickname: user.nickname,
            avatar: user.avatar,
            color: user.color,
          });
        }

        saveMessagesData();
        io.emit('update reactions', { msgId, reactions: msg.reactions });
      }
    });

    socket.on('typing', (isTyping: boolean) => {
      if (users[socket.id]) {
        if (isTyping) typingUsers.add(socket.id);
        else typingUsers.delete(socket.id);
        broadcastTypingStatus();
      }
    });

    socket.on('recording', (isRecording: boolean) => {
      if (!users[socket.id]) return;
      if (isRecording) recordingUsers.add(socket.id);
      else recordingUsers.delete(socket.id);
      broadcastRecordingStatus();
    });

    socket.on('delete message', (msgId: string) => {
      delete messagesStore[msgId];
      saveMessagesData();
      io.emit('message deleted', msgId);
    });

    socket.on('edit message', ({ msgId, newText }: any) => {
      if (messagesStore[msgId]) {
        messagesStore[msgId].text = newText;
        saveMessagesData();
      }
      io.emit('message edited', { msgId, newText });
    });

    socket.on('admin update user', ({ targetId, newName, newColor }: any) => {
      if (users[targetId]) {
        if (newName && newName.trim() !== '') {
          users[targetId].nickname = newName.trim();
          const targetSocket = io.sockets.sockets.get(targetId);
          if (targetSocket) (targetSocket as any).nickname = newName.trim();
        }
        if (newColor) {
          users[targetId].color = newColor;
          const targetSocket = io.sockets.sockets.get(targetId);
          if (targetSocket) (targetSocket as any).userColor = newColor;
        }
        io.emit('update-users', users);
        syncProfileFromSocket(targetId);
      }
    });

    socket.on('kick user', ({ targetId, adminName }: any) => {
      if (users[targetId]) {
        const targetSocket = io.sockets.sockets.get(targetId);
        if (targetSocket) {
          targetSocket.emit('kicked', adminName);
          targetSocket.disconnect(true);
        }
      }
    });

    socket.on('disconnect', () => {
      if (users[socket.id]) {
        const name = users[socket.id].nickname;
        typingUsers.delete(socket.id);
        broadcastTypingStatus();
        recordingUsers.delete(socket.id);

        const leavingUid = users[socket.id].uid;
        delete users[socket.id];
        broadcastRecordingStatus();

        if (leavingUid && onlineByUid[leavingUid] === socket.id) {
          delete onlineByUid[leavingUid];
          if (profiles[leavingUid]) profiles[leavingUid].lastSeen = Date.now();
          if (hasRelations(leavingUid)) saveFriendsData();
          notifyFriendsOf(leavingUid);
        }
        io.emit('system-message', `${name} ha salido del chat.`);
        io.emit('update-users', users);
      }
    });
  });

  const isProduction = process.env.NODE_ENV === 'production';
  const PORT = process.env.PORT || 3000;

  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  server.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`zLowStudio Chat Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
