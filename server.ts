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

const app = express();
const server = http.createServer(app);

// Audit #7: Limitar tamaño de buffer a 4MB en lugar de 10MB sin control
const io = new Server(server, {
  maxHttpBufferSize: 4e6,
  cors: { origin: '*' },
});

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const FRIENDS_FILE = path.join(DATA_DIR, 'friends-data.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages-data.json');

// Audit #14: Usar rutas absolutas
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Audit #3: No exponer clave por defecto en el código
const GIF_API_KEY = process.env.GIF_API_KEY || '';
const GIF_PROVIDER = (process.env.GIF_PROVIDER || 'giphy').toLowerCase();
const GIF_PAGE_SIZE = 24;
const GIF_CACHE_TTL = 5 * 60 * 1000;
const gifCache = new Map<string, { t: number; data: unknown }>();

// Audit #1: Contraseña de admin desde variable de entorno
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1509';

// Audit #6: Dominios de imágenes autorizados para prevenir IP logging o SSRF
const ALLOWED_IMAGE_HOSTS = new Set([
  'giphy.com',
  'media.giphy.com',
  'media0.giphy.com',
  'media1.giphy.com',
  'media2.giphy.com',
  'media3.giphy.com',
  'media4.giphy.com',
  'i.giphy.com',
  'klipy.com',
  'api.klipy.com',
  'static.klipy.com',
  'tenor.com',
  'c.tenor.com',
  'media.tenor.com',
  'images.unsplash.com',
  'localhost',
  '127.0.0.1',
]);

function isHttps(u: unknown): boolean {
  return typeof u === 'string' && /^https:\/\//i.test(u);
}

function isValidImageUrl(url: unknown): boolean {
  if (typeof url !== 'string' || !url) return false;
  // Base64 seguro para imágenes locales
  if (/^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(url)) {
    return url.length <= 4 * 1024 * 1024;
  }
  if (!/^https:\/\//i.test(url)) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    for (const allowed of ALLOWED_IMAGE_HOSTS) {
      if (host === allowed || host.endsWith('.' + allowed)) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
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
        title: String(g.title || 'GIF'),
        preview: small.url,
        url: medium.url,
        w: small.width || 0,
        h: small.height || 0,
      };
    })
    .filter((x): x is GifItem => x !== null);
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
        title: String(g.title || 'GIF'),
        preview: small.url,
        url: medium.url,
        w: Number(small.width) || 0,
        h: Number(small.height) || 0,
      };
    })
    .filter((x): x is GifItem => x !== null);
  const p = json && json.pagination;
  const hasNext = !!(p && p.total_count > offset + (p.count || list.length));
  return { items, hasNext };
}

app.get('/api/gifs', async (req, res) => {
  // Audit #3: Si no hay clave, responder con aviso limpio sin error fatal
  if (!GIF_API_KEY) {
    return res.json({
      items: [],
      hasNext: false,
      provider: GIF_PROVIDER.toUpperCase(),
      message: 'GIF API key not configured. Set GIF_API_KEY in environment variables.',
    });
  }

  const q = String(req.query.q || '').trim().slice(0, 80);
  const page = Math.min(Math.max(parseInt(String(req.query.page), 10) || 1, 1), 50);
  const cid = /^[\w-]{1,64}$/.test(String(req.query.cid || '')) ? String(req.query.cid) : 'anon';

  const cacheKey = `${GIF_PROVIDER}|${q.toLowerCase()}|${page}`;
  const cached = gifCache.get(cacheKey);
  if (cached && Date.now() - cached.t < GIF_CACHE_TTL) return res.json(cached.data);

  let url = '';
  if (GIF_PROVIDER === 'giphy') {
    const params = new URLSearchParams({
      api_key: GIF_API_KEY,
      limit: String(GIF_PAGE_SIZE),
      offset: String((page - 1) * GIF_PAGE_SIZE),
      rating: 'g',
    });
    if (q) params.set('q', q);
    url = `https://api.giphy.com/v1/gifs/${q ? 'search' : 'trending'}?${params.toString()}`;
  } else {
    const params = new URLSearchParams({ page: String(page), per_page: String(GIF_PAGE_SIZE), customer_id: cid });
    if (q) params.set('q', q);
    url = `https://api.klipy.com/api/v1/${encodeURIComponent(GIF_API_KEY)}/gifs/${q ? 'search' : 'trending'}?${params.toString()}`;
  }

  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return res.status(502).json({ error: 'provider-' + resp.status, items: [] });
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
    res.status(502).json({ error: 'fetch-failed', items: [] });
  }
});

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
  userCode?: string;
}

interface MessageReactionUser {
  id: string;
  uid: string;
  nickname: string;
  avatar: string | null;
  color: string;
}

interface MessageItem {
  id: string;
  senderId: string;
  senderUid: string;
  senderUserCode: string;
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
  reactions: Record<string, MessageReactionUser[]>;
  editedAt?: number;
}

interface PrivateMessageItem extends MessageItem {
  targetUid: string;
}

const users: Record<string, UserSession> = {};
const typingUsers = new Set<string>();
const recordingUsers = new Set<string>();

let profiles: Record<string, UserProfile> = {};
const friendsMap: Record<string, Set<string>> = {};
const requestsMap: Record<string, Set<string>> = {};

// Audit #11: Map de Sets para múltiples pestañas simultáneas de un mismo UID
const onlineSocketsByUid = new Map<string, Set<string>>();

function getSocketsForUid(uid: string): string[] {
  const s = onlineSocketsByUid.get(uid);
  return s ? Array.from(s) : [];
}

function isUidOnline(uid: string): boolean {
  const s = onlineSocketsByUid.get(uid);
  return Boolean(s && s.size > 0);
}

function addSocketForUid(uid: string, socketId: string): void {
  if (!onlineSocketsByUid.has(uid)) {
    onlineSocketsByUid.set(uid, new Set());
  }
  onlineSocketsByUid.get(uid)!.add(socketId);
}

function removeSocketForUid(uid: string, socketId: string): boolean {
  const s = onlineSocketsByUid.get(uid);
  if (s) {
    s.delete(socketId);
    if (s.size === 0) {
      onlineSocketsByUid.delete(uid);
      return true; // Se quedó sin pestañas activas (ahora offline)
    }
  }
  return false;
}

let messageIdCounter = 0;
let messagesStore: Record<string, MessageItem> = {};
const privateMessagesStore: Record<string, PrivateMessageItem[]> = {};

// Audit #7: Rate limiting en memoria (mensajes por socket)
const messageTimestampsBySocket = new Map<string, number[]>();

function checkRateLimit(socketId: string): boolean {
  const now = Date.now();
  const timestamps = messageTimestampsBySocket.get(socketId) || [];
  const recent = timestamps.filter((t) => now - t < 3000);
  if (recent.length >= 5) {
    return false; // Excede 5 mensajes cada 3 segundos
  }
  recent.push(now);
  messageTimestampsBySocket.set(socketId, recent);
  return true;
}

function getDmRoomId(uid1: string, uid2: string): string {
  return [String(uid1), String(uid2)].sort().join('__');
}

function uidFromToken(token: string): string {
  return crypto.createHash('sha256').update('chat-uid:' + token).digest('hex').slice(0, 16);
}

function getOrGenerateUserCode(uid: string): string {
  if (profiles[uid] && profiles[uid].userCode) {
    return profiles[uid].userCode!;
  }
  let hash = 0;
  for (let i = 0; i < uid.length; i++) {
    hash = (hash * 37 + uid.charCodeAt(i)) >>> 0;
  }
  const code = `#${1000 + (hash % 9000)}`;
  if (profiles[uid]) {
    profiles[uid].userCode = code;
  }
  return code;
}

// Audit #2: Sanitización de entradas
function cleanName(n: unknown): string {
  return String(n || '')
    .replace(/[<>\u0000-\u001F\u007F-\u009F]/g, '')
    .trim()
    .slice(0, 24);
}

function cleanBio(b: unknown): string {
  return String(b || '')
    .replace(/[<>\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')
    .trim()
    .slice(0, 200);
}

function cleanAvatar(a: unknown): string | null {
  if (typeof a === 'string') {
    // Audit #7: Limitar avatares a 300KB
    if (a.startsWith('data:image/') && a.length <= 300000) return a;
    if (isValidImageUrl(a)) return a;
  }
  return null;
}

function cleanMessageText(text: unknown): string {
  return String(text || '')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')
    .trim()
    .slice(0, 2000);
}

function formatServerTime(ts: number): string {
  const d = new Date(ts);
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

// Audit #14: Escritura atómica para evitar corrupción de archivos
function atomicWriteFile(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tempPath = filePath + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  fs.writeFileSync(tempPath, data, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function loadData(): void {
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
  } catch (e: any) {
    console.error('Error leyendo friends-data:', e.message);
    try {
      const corruptBackup = FRIENDS_FILE + '.corrupt.' + Date.now();
      if (fs.existsSync(FRIENDS_FILE)) fs.copyFileSync(FRIENDS_FILE, corruptBackup);
    } catch {}
  }

  try {
    if (fs.existsSync(MESSAGES_FILE)) {
      const raw = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
      messagesStore = raw.messagesStore || {};
      Object.entries(raw.privateMessagesStore || {}).forEach(([k, v]) => {
        privateMessagesStore[k] = v as PrivateMessageItem[];
      });
      messageIdCounter = Number(raw.messageIdCounter) || Object.keys(messagesStore).length;
    }
  } catch (e: any) {
    console.error('Error leyendo messages-data:', e.message);
    try {
      const corruptBackup = MESSAGES_FILE + '.corrupt.' + Date.now();
      if (fs.existsSync(MESSAGES_FILE)) fs.copyFileSync(MESSAGES_FILE, corruptBackup);
    } catch {}
  }
}
loadData();

let saveFriendsTimer: NodeJS.Timeout | null = null;
function saveFriendsData(): void {
  if (saveFriendsTimer) clearTimeout(saveFriendsTimer);
  saveFriendsTimer = setTimeout(() => {
    try {
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
      atomicWriteFile(
        FRIENDS_FILE,
        JSON.stringify({ profiles: outProfiles, friends, requests }, null, 2)
      );
    } catch (err: any) {
      console.error('Error guardando amigos:', err.message);
    }
  }, 600);
}

let saveMessagesTimer: NodeJS.Timeout | null = null;
function saveMessagesData(): void {
  if (saveMessagesTimer) clearTimeout(saveMessagesTimer);
  saveMessagesTimer = setTimeout(() => {
    try {
      // Audit #7: Purgar mensajes antiguos en memoria a max 200
      const entries = Object.entries(messagesStore);
      if (entries.length > 200) {
        messagesStore = Object.fromEntries(entries.slice(entries.length - 200));
      }
      Object.keys(privateMessagesStore).forEach((room) => {
        if (privateMessagesStore[room] && privateMessagesStore[room].length > 100) {
          privateMessagesStore[room] = privateMessagesStore[room].slice(privateMessagesStore[room].length - 100);
        }
      });

      atomicWriteFile(
        MESSAGES_FILE,
        JSON.stringify({ messageIdCounter, messagesStore, privateMessagesStore }, null, 2)
      );
    } catch (err: any) {
      console.error('Error guardando mensajes:', err.message);
    }
  }, 1000);
}

function hasRelations(id: string): boolean {
  if (friendsMap[id] && friendsMap[id].size) return true;
  if (requestsMap[id] && requestsMap[id].size) return true;
  return Object.values(requestsMap).some((set) => set.has(id));
}

function friendStatus(id: string): string {
  if (!isUidOnline(id)) return 'offline';
  const sids = getSocketsForUid(id);
  for (const sid of sids) {
    if (users[sid] && users[sid].status) return users[sid].status;
  }
  return 'online';
}

function friendEntry(id: string) {
  const p = profiles[id] || { nickname: 'Usuario', avatar: null, color: '#888888', bio: '', memberSince: 0, lastSeen: 0 };
  const sids = getSocketsForUid(id);
  const activeUser = sids.length > 0 && users[sids[0]] ? users[sids[0]] : null;
  const src = activeUser || p;
  const userCode = src.userCode || p.userCode || getOrGenerateUserCode(id);
  return {
    uid: id,
    userCode,
    nickname: src.nickname || 'Usuario',
    avatar: src.avatar || null,
    color: src.color || '#888888',
    bio: src.bio || '',
    memberSince: src.memberSince || 0,
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
      return { uid: e.uid, userCode: e.userCode, nickname: e.nickname, avatar: e.avatar, color: e.color };
    }),
    outgoing: Object.keys(requestsMap).filter((to) => requestsMap[to].has(id)),
  };
}

function pushFriendsState(id: string): void {
  const sids = getSocketsForUid(id);
  sids.forEach((sid) => io.to(sid).emit('friends state', buildFriendsState(id)));
}

function notifyFriendsOf(id: string): void {
  pushFriendsState(id);
  (friendsMap[id] || []).forEach(pushFriendsState);
}

function notifyUid(id: string, text: string): void {
  const sids = getSocketsForUid(id);
  sids.forEach((sid) => io.to(sid).emit('friend notice', { text }));
}

function acceptFriendship(me: string, other: string): void {
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

function syncProfileFromSocket(socketId: string): void {
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

function broadcastTypingStatus(): void {
  const names = Array.from(typingUsers)
    .map((id) => (users[id] ? users[id].nickname : null))
    .filter(Boolean);
  io.emit('typing update', names);
}

function broadcastRecordingStatus(): void {
  const names = Array.from(recordingUsers)
    .map((id) => (users[id] ? users[id].nickname : null))
    .filter(Boolean);
  io.emit('recording update', names);
}

// Socket.IO Events
io.on('connection', (socket: Socket) => {
  // Flag admin asociado al socket
  (socket as any).isAdmin = false;

  // Audit #1: Verificación de admin en servidor
  socket.on('admin auth', ({ password }) => {
    const inputPass = String(password || '');
    if (inputPass.length > 0 && inputPass === ADMIN_PASSWORD) {
      (socket as any).isAdmin = true;
      socket.emit('admin auth result', { success: true, message: 'Autenticación exitosa' });
    } else {
      socket.emit('admin auth result', { success: false, message: 'Contraseña de administrador incorrecta' });
    }
  });

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

    // Audit #11: Soporte para múltiples pestañas de la misma cuenta sin desconectar arbitrariamente
    const wasAlreadyOnline = isUidOnline(uid);
    addSocketForUid(uid, socket.id);

    // Detección de apodo duplicado por otro usuario con distinto UID
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
      removeSocketForUid(uid, socket.id);
      socket.disconnect(true);
      return;
    }

    socket.emit('session', { uid, userCode, token });

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

    syncProfileFromSocket(socket.id);

    // Audit #4: Solo enviar aviso de bienvenida a la sala si es nueva conexión y no reconexión de pestaña existente
    if (!wasAlreadyOnline) {
      io.emit('system-message', `${(socket as any).nickname} (${userCode}) ha entrado al chat.`);
    }
    io.emit('update-users', users);

    // Replay recent public messages
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

  socket.on('change status', (status: any) => {
    if (users[socket.id]) {
      const validStatuses = ['online', 'dnd', 'idle', 'offline'];
      users[socket.id].status = validStatuses.includes(status) ? status : 'online';
      io.emit('update-users', users);
      if (users[socket.id].uid) notifyFriendsOf(users[socket.id].uid);
    }
  });

  // --- Mensajes Públicos ---
  socket.on('chat message', (data: any) => {
    if (!users[socket.id]) return;

    // Audit #7: Rate limiting
    if (!checkRateLimit(socket.id)) {
      socket.emit('action error', { message: 'Estás enviando mensajes demasiado rápido. Espera un momento.' });
      return;
    }

    messageIdCounter++;
    const msgId = 'msg_' + messageIdCounter + '_' + Date.now();

    typingUsers.delete(socket.id);
    broadcastTypingStatus();
    if (recordingUsers.delete(socket.id)) broadcastRecordingStatus();

    // Audit #6: Validar imagen contra dominios permitidos o data URL
    let image = data && data.image;
    if (!isValidImageUrl(image)) {
      image = null;
    }

    let audio = data && data.audio;
    if (typeof audio !== 'string' || !audio.startsWith('data:audio/')) audio = null;

    let waveform: number[] | null = null;
    if (Array.isArray(data && data.waveform) && data.waveform.length > 0 && data.waveform.length <= 100) {
      waveform = data.waveform.map((n: any) => Math.min(100, Math.max(0, Math.round(Number(n) || 0))));
    }
    let duration = Number(data && data.duration);
    duration = isFinite(duration) && duration > 0 && duration < 3600 ? Math.round(duration * 10) / 10 : 0;

    // Audit #2 & #7: Limpiar y truncar texto
    const cleanedText = cleanMessageText(data && data.text);

    // Audit #15: Hora consistente generada por el servidor
    const nowTs = Date.now();
    const serverFormattedTime = formatServerTime(nowTs);

    const msgData: MessageItem = {
      id: msgId,
      senderId: socket.id,
      senderUid: users[socket.id].uid,
      senderUserCode: users[socket.id].userCode,
      user: users[socket.id].nickname,
      avatar: users[socket.id].avatar,
      color: users[socket.id].color,
      text: cleanedText,
      image,
      audio,
      waveform: audio ? waveform : null,
      duration: audio ? duration : 0,
      time: serverFormattedTime,
      replyTo: data && data.replyTo ? {
        user: cleanName(data.replyTo.user),
        text: cleanMessageText(data.replyTo.text),
        color: String(data.replyTo.color || '#ffffff'),
      } : null,
      reactions: {},
    };

    messagesStore[msgId] = msgData;
    saveMessagesData();
    io.emit('chat message', msgData);
  });

  // --- Mensajes Privados / DMs ---
  socket.on('get private history', ({ targetUid }: any) => {
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

    if (!checkRateLimit(socket.id)) {
      socket.emit('action error', { message: 'Estás enviando mensajes demasiado rápido. Espera un momento.' });
      return;
    }

    messageIdCounter++;
    const msgId = 'dm_' + messageIdCounter + '_' + Date.now();
    const roomId = getDmRoomId(me, toUid);

    let image = data && data.image;
    if (!isValidImageUrl(image)) {
      image = null;
    }

    let audio = data && data.audio;
    if (typeof audio !== 'string' || !audio.startsWith('data:audio/')) audio = null;

    let waveform: number[] | null = null;
    if (Array.isArray(data && data.waveform) && data.waveform.length > 0 && data.waveform.length <= 100) {
      waveform = data.waveform.map((n: any) => Math.min(100, Math.max(0, Math.round(Number(n) || 0))));
    }
    let duration = Number(data && data.duration);
    duration = isFinite(duration) && duration > 0 && duration < 3600 ? Math.round(duration * 10) / 10 : 0;

    const cleanedText = cleanMessageText(data && data.text);
    const serverFormattedTime = formatServerTime(Date.now());

    const msgData: PrivateMessageItem = {
      id: msgId,
      senderId: socket.id,
      senderUid: me,
      senderUserCode: u.userCode || (socket as any).userCode || getOrGenerateUserCode(me),
      targetUid: toUid,
      user: u.nickname,
      avatar: u.avatar,
      color: u.color,
      text: cleanedText,
      image,
      audio,
      waveform: audio ? waveform : null,
      duration: audio ? duration : 0,
      time: serverFormattedTime,
      replyTo: data && data.replyTo ? {
        user: cleanName(data.replyTo.user),
        text: cleanMessageText(data.replyTo.text),
        color: String(data.replyTo.color || '#ffffff'),
      } : null,
      reactions: {},
    };

    if (!privateMessagesStore[roomId]) privateMessagesStore[roomId] = [];
    privateMessagesStore[roomId].push(msgData);
    if (privateMessagesStore[roomId].length > 100) privateMessagesStore[roomId].shift();
    saveMessagesData();

    // Enviar a todas las pestañas de 'me'
    const mySockets = getSocketsForUid(me);
    mySockets.forEach((sid) => io.to(sid).emit('private message', msgData));

    // Enviar a todas las pestañas de 'toUid'
    const destSockets = getSocketsForUid(toUid);
    destSockets.forEach((destSid) => {
      io.to(destSid).emit('private message', msgData);
      io.to(destSid).emit('private typing update', {
        fromUid: me,
        fromName: u.nickname,
        isTyping: false,
      });
    });
  });

  socket.on('private typing', ({ targetUid, isTyping }: any) => {
    const destSockets = getSocketsForUid(targetUid);
    if (destSockets.length > 0 && users[socket.id]) {
      destSockets.forEach((destSid) => {
        io.to(destSid).emit('private typing update', {
          fromUid: (socket as any).uid,
          fromName: users[socket.id].nickname,
          isTyping: !!isTyping,
        });
      });
    }
  });

  socket.on('private recording', ({ targetUid, isRecording }: any) => {
    const destSockets = getSocketsForUid(targetUid);
    if (destSockets.length > 0 && users[socket.id]) {
      destSockets.forEach((destSid) => {
        io.to(destSid).emit('private recording update', {
          fromUid: (socket as any).uid,
          fromName: users[socket.id].nickname,
          isRecording: !!isRecording,
        });
      });
    }
  });

  socket.on('add private reaction', ({ targetUid, msgId, emoji }: any) => {
    const me = (socket as any).uid;
    if (!me || !targetUid || !users[socket.id] || !emoji) return;
    const roomId = getDmRoomId(me, targetUid);
    const list = privateMessagesStore[roomId] || [];
    const msg = list.find((m) => m.id === msgId);
    if (!msg) return;

    if (!msg.reactions) msg.reactions = {};
    let alreadyReacted = false;

    // Audit #12: Clave por UID
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
    const mySockets = getSocketsForUid(me);
    mySockets.forEach((sid) => io.to(sid).emit('update private reactions', { targetUid, msgId, reactions: msg.reactions }));

    const destSockets = getSocketsForUid(targetUid);
    destSockets.forEach((sid) => io.to(sid).emit('update private reactions', { targetUid: me, msgId, reactions: msg.reactions }));
  });

  // Audit #10: Solo el autor (o admin) puede borrar su mensaje privado
  socket.on('delete private message', ({ targetUid, msgId }: any) => {
    const me = (socket as any).uid;
    if (!me || !targetUid || !msgId) return;
    const roomId = getDmRoomId(me, targetUid);
    const list = privateMessagesStore[roomId] || [];
    const msg = list.find((m) => m.id === msgId);
    if (!msg) return;

    if (msg.senderUid !== me && !(socket as any).isAdmin) {
      socket.emit('action error', { message: 'Solo puedes eliminar tus propios mensajes.' });
      return;
    }

    privateMessagesStore[roomId] = list.filter((m) => m.id !== msgId);
    saveMessagesData();

    const mySockets = getSocketsForUid(me);
    mySockets.forEach((sid) => io.to(sid).emit('private message deleted', { targetUid, msgId }));

    const destSockets = getSocketsForUid(targetUid);
    destSockets.forEach((sid) => io.to(sid).emit('private message deleted', { targetUid: me, msgId }));
  });

  // Audit #10: Solo el autor (o admin) puede editar su mensaje privado
  socket.on('edit private message', ({ targetUid, msgId, newText }: any) => {
    const me = (socket as any).uid;
    if (!me || !targetUid || !msgId) return;
    const roomId = getDmRoomId(me, targetUid);
    const msg = (privateMessagesStore[roomId] || []).find((m) => m.id === msgId);
    if (!msg) return;

    if (msg.senderUid !== me && !(socket as any).isAdmin) {
      socket.emit('action error', { message: 'Solo puedes editar tus propios mensajes.' });
      return;
    }

    const sanitizedText = cleanMessageText(newText);
    if (!sanitizedText) return;

    msg.text = sanitizedText;
    msg.editedAt = Date.now();
    saveMessagesData();

    const mySockets = getSocketsForUid(me);
    mySockets.forEach((sid) => io.to(sid).emit('private message edited', { targetUid, msgId, newText: sanitizedText }));

    const destSockets = getSocketsForUid(targetUid);
    destSockets.forEach((sid) => io.to(sid).emit('private message edited', { targetUid: me, msgId, newText: sanitizedText }));
  });

  // --- Reacciones Públicas ---
  // Audit #12: Registrar reacciones públicas por UID, no solo socket.id
  socket.on('add reaction', ({ msgId, emoji }: any) => {
    const user = users[socket.id];
    const msg = messagesStore[msgId];
    if (!user || !msg || !emoji) return;
    const myUid = user.uid;

    if (!msg.reactions) msg.reactions = {};

    let alreadyReacted = false;
    Object.keys(msg.reactions).forEach((e) => {
      msg.reactions[e] = msg.reactions[e].filter((item) => {
        if (item.uid === myUid && e === emoji) {
          alreadyReacted = true;
          return false;
        }
        return item.uid !== myUid;
      });
      if (msg.reactions[e].length === 0) delete msg.reactions[e];
    });

    if (!alreadyReacted) {
      if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
      msg.reactions[emoji].push({
        id: socket.id,
        uid: myUid,
        nickname: user.nickname,
        avatar: user.avatar,
        color: user.color,
      });
    }

    saveMessagesData();
    io.emit('update reactions', { msgId, reactions: msg.reactions });
  });

  socket.on('typing', (isTyping: any) => {
    if (users[socket.id]) {
      if (isTyping) typingUsers.add(socket.id);
      else typingUsers.delete(socket.id);
      broadcastTypingStatus();
    }
  });

  socket.on('recording', (isRecording: any) => {
    if (!users[socket.id]) return;
    if (isRecording) recordingUsers.add(socket.id);
    else recordingUsers.delete(socket.id);
    broadcastRecordingStatus();
  });

  // Audit #1: Solo autor o admin puede borrar mensajes globales
  socket.on('delete message', (msgId: string) => {
    const msg = messagesStore[msgId];
    if (!msg) return;

    const myUid = users[socket.id] && users[socket.id].uid;
    const isAuthor = (myUid && msg.senderUid === myUid) || msg.senderId === socket.id;

    if (!isAuthor && !(socket as any).isAdmin) {
      socket.emit('action error', { message: 'No tienes permiso para eliminar este mensaje.' });
      return;
    }

    delete messagesStore[msgId];
    saveMessagesData();
    io.emit('message deleted', msgId);
  });

  // Audit #1: Solo autor o admin puede editar mensajes globales
  socket.on('edit message', ({ msgId, newText }: any) => {
    const msg = messagesStore[msgId];
    if (!msg) return;

    const myUid = users[socket.id] && users[socket.id].uid;
    const isAuthor = (myUid && msg.senderUid === myUid) || msg.senderId === socket.id;

    if (!isAuthor && !(socket as any).isAdmin) {
      socket.emit('action error', { message: 'No tienes permiso para editar este mensaje.' });
      return;
    }

    const sanitizedText = cleanMessageText(newText);
    if (!sanitizedText) return;

    msg.text = sanitizedText;
    msg.editedAt = Date.now();
    saveMessagesData();
    io.emit('message edited', { msgId, newText: sanitizedText });
  });

  // Audit #1: Proteger admin update user con verificación de admin
  socket.on('admin update user', ({ targetId, newName, newColor }: any) => {
    if (!(socket as any).isAdmin) {
      socket.emit('action error', { message: 'Se requieren permisos de administrador.' });
      return;
    }

    if (users[targetId]) {
      if (newName && String(newName).trim() !== '') {
        const cleaned = cleanName(newName);
        users[targetId].nickname = cleaned;
        const targetSocket = io.sockets.sockets.get(targetId);
        if (targetSocket) (targetSocket as any).nickname = cleaned;
      }
      if (newColor) {
        users[targetId].color = String(newColor);
        const targetSocket = io.sockets.sockets.get(targetId);
        if (targetSocket) (targetSocket as any).userColor = String(newColor);
      }
      io.emit('update-users', users);
      syncProfileFromSocket(targetId);
    }
  });

  // Audit #1: Proteger kick user con verificación de admin
  socket.on('kick user', ({ targetId, adminName }: any) => {
    if (!(socket as any).isAdmin) {
      socket.emit('action error', { message: 'Se requieren permisos de administrador.' });
      return;
    }

    if (users[targetId]) {
      const targetSocket = io.sockets.sockets.get(targetId);
      if (targetSocket) {
        targetSocket.emit('kicked', adminName || 'Administrador');
        targetSocket.disconnect(true);
      }
    }
  });

  socket.on('disconnect', () => {
    if (users[socket.id]) {
      const name = users[socket.id].nickname;
      const leavingUid = users[socket.id].uid;

      typingUsers.delete(socket.id);
      broadcastTypingStatus();
      recordingUsers.delete(socket.id);
      broadcastRecordingStatus();

      messageTimestampsBySocket.delete(socket.id);
      delete users[socket.id];

      // Audit #11: Solo marcar offline si no quedan otras pestañas del mismo UID
      if (leavingUid) {
        const wentOffline = removeSocketForUid(leavingUid, socket.id);
        if (wentOffline) {
          if (profiles[leavingUid]) profiles[leavingUid].lastSeen = Date.now();
          if (hasRelations(leavingUid)) saveFriendsData();
          notifyFriendsOf(leavingUid);
          io.emit('system-message', `${name} ha salido del chat.`);
        }
      }

      io.emit('update-users', users);
    }
  });
});

async function startServer() {
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
