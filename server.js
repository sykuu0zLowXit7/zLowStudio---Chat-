import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

// Buffer de 4MB seguro para adjuntos
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
const ADMIN_DATA_FILE = path.join(DATA_DIR, 'admin-data.json');

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// Clave por defecto de Klipy protegida/obfuscada
const _gk = Buffer.from('RXFLdmVLeWE2NzNTR0ROSzF2V3FabHFDZWN6ZkFZUGJSQzNLREQ5V0RXOGNWTVFLUEc2d1RuTVdjRW9xT2dsaw==', 'base64').toString('utf8');
const GIF_API_KEY = process.env.GIF_API_KEY || _gk;
const GIF_PROVIDER = (process.env.GIF_PROVIDER || 'klipy').toLowerCase();
const GIF_PAGE_SIZE = 24;
const GIF_CACHE_TTL = 5 * 60 * 1000;
const gifCache = new Map();

// Contraseña de administrador
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1509';

// Dominios seguros permitidos para imágenes
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

function isHttps(u) {
  return typeof u === 'string' && /^https:\/\//i.test(u);
}

function isValidImageUrl(url) {
  if (typeof url !== 'string' || !url) return false;
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

function normalizeKlipy(json) {
  const d = json && json.data;
  const list = d && Array.isArray(d.data) ? d.data : Array.isArray(d) ? d : [];
  const items = list
    .map((g) => {
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
    .filter(Boolean);
  return { items, hasNext: !!(d && (d.has_next || d.hasNext)) };
}

function normalizeGiphy(json, offset) {
  const list = Array.isArray(json && json.data) ? json.data : [];
  const items = list
    .map((g) => {
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
    .filter(Boolean);
  const p = json && json.pagination;
  const hasNext = !!(p && p.total_count > offset + (p.count || list.length));
  return { items, hasNext };
}

app.get('/api/gifs', async (req, res) => {
  if (!GIF_API_KEY) {
    return res.json({
      items: [],
      hasNext: false,
      provider: GIF_PROVIDER.toUpperCase(),
      message: 'GIF API key not configured.',
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

// Cache en memoria para credenciales WebRTC TURN de Metered (evita sobrecargar la API en cada conexión)
let cachedMeteredIce = { timestamp: 0, servers: null };

// Endpoint de configuración WebRTC ICE con STUN y TURN de alta disponibilidad
// Diseñado para atravesar NATs simétricos, conexiones 4G/5G y routers entre distintos países
app.get('/api/webrtc-config', async (_req, res) => {
  const envApiKey = (process.env.METERED_API_KEY || '').trim();
  const envDomain = (process.env.METERED_DOMAIN || '').trim();

  // Valores predeterminados o configurados
  const meteredApiKey = envApiKey || 'uNeARrTayh7WjmIgbiHYGBvdjwpClmQL-p2w6MpLcgxWfNSy';
  let meteredDomain = envDomain || 'zlowstudio.metered.live';

  // Normalizar dominio eliminando protocolos y barras finales
  meteredDomain = meteredDomain.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (meteredDomain && !meteredDomain.includes('.')) {
    meteredDomain = `${meteredDomain}.metered.live`;
  }

  // Si tenemos credenciales en caché menores a 10 minutos, responder de inmediato
  const now = Date.now();
  if (cachedMeteredIce.servers && (now - cachedMeteredIce.timestamp < 10 * 60 * 1000)) {
    return res.json({ iceServers: cachedMeteredIce.servers, source: 'metered-cached', domain: meteredDomain });
  }

  // 1. Intentar obtener credenciales dinámicas de Metered TURN API
  if (meteredApiKey && meteredDomain) {
    // Intentar primero con .metered.live y luego con .metered.ca si aplica
    const targetHosts = [meteredDomain];
    if (meteredDomain.endsWith('.metered.live')) {
      targetHosts.push(meteredDomain.replace('.metered.live', '.metered.ca'));
    }

    for (const host of targetHosts) {
      try {
        const meteredUrl = `https://${host}/api/v1/turn/credentials?apiKey=${meteredApiKey}`;
        const response = await fetch(meteredUrl, { signal: AbortSignal.timeout(5000) });
        if (response.ok) {
          const iceServers = await response.json();
          if (Array.isArray(iceServers) && iceServers.length > 0) {
            // Agregar STUNs de Google para máxima resiliencia
            const combinedServers = [
              { urls: 'stun:stun.l.google.com:19302' },
              { urls: 'stun:stun1.l.google.com:19302' },
              { urls: 'stun:stun.cloudflare.com:3478' },
              ...iceServers
            ];
            cachedMeteredIce = { timestamp: now, servers: combinedServers };
            return res.json({ iceServers: combinedServers, source: 'metered-dynamic', domain: host });
          }
        } else {
          const errData = await response.text();
          console.warn(`[WebRTC] Metered API (${host}) respondió ${response.status}:`, errData);
        }
      } catch (e) {
        console.warn(`[WebRTC] Error consultando Metered API (${host}):`, e.message);
      }
    }
  }

  // 2. Soporte para credenciales estáticas de TURN configuradas manualmente en variables de entorno
  const staticTurnUser = (process.env.TURN_USERNAME || process.env.METERED_USERNAME || '').trim();
  const staticTurnPass = (process.env.TURN_PASSWORD || process.env.METERED_PASSWORD || '').trim();
  if (staticTurnUser && staticTurnPass && meteredDomain) {
    const staticIceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: `stun:${meteredDomain}:80` },
      {
        urls: [
          `turn:${meteredDomain}:80`,
          `turn:${meteredDomain}:443`,
          `turn:${meteredDomain}:443?transport=tcp`,
          `turns:${meteredDomain}:443?transport=tcp`
        ],
        username: staticTurnUser,
        credential: staticTurnPass
      }
    ];
    return res.json({ iceServers: staticIceServers, source: 'static-turn', domain: meteredDomain });
  }

  // 3. Fallback a STUN servers globales de baja latencia (Google & Cloudflare)
  const defaultIceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:meet-jit-si-turnrelay.jitsi.net:443' }
  ];

  res.json({
    iceServers: defaultIceServers,
    source: 'public-stun-fallback',
    warning: 'Metered TURN API no disponible o API Key rechazada. Configura un TURN activo o revisa tu clave en metered.ca'
  });
});

const AVAILABLE_COLORS = [
  '#ff4757', '#2ed573', '#1e90ff', '#ffa502', '#eccc68',
  '#ff6b81', '#70a1ff', '#7bed9f', '#ff7f50', '#a29bfe',
  '#fd79a8', '#00cec9', '#00b894', '#e84393', '#6c5ce7',
  '#fdcb6e', '#d63031', '#e17055', '#0026ca', '#fab1a0',
];

let colorIndex = 0;
function getUniqueColor() {
  const color = AVAILABLE_COLORS[colorIndex % AVAILABLE_COLORS.length];
  colorIndex++;
  return color;
}

const users = {};
const typingUsers = new Set();
const recordingUsers = new Set();

let profiles = {};
const friendsMap = {};
const requestsMap = {};

// Sockets activos indexados por UID (soporte multi-pestaña)
const onlineSocketsByUid = new Map();

// --- ESTADOS DE ADMINISTRACIÓN Y MODERACIÓN ---
let mutes = {}; // uid -> { until, minutes, reason, by, mutedAt, nickname }
let bans = {};  // uid -> { reason, by, bannedAt, userCode, nickname }
let warnings = {}; // uid -> Array<{ id, text, time, by }>
let auditLog = []; // [{ id, action, targetName, targetUid, byName, reason, time, details }]
let chatSettings = { slowmode: 0, paused: false }; // slowmode en segundos, paused booleano
const lastMessageTimeByUid = new Map(); // uid -> timestamp para slowmode

// Seguimiento de llamadas WebRTC activas (1-a-1 privadas)
const activeCalls = new Map(); // callKey -> { callerUid, targetUid, startedAt }

// --- SISTEMA DE 3 CANALES DE VOZ ESTILO DISCORD (10 PERSONAS MAX POR CANAL) ---
const VOICE_CHANNELS = {
  'voice-1': { id: 'voice-1', name: 'Sala de Voz 1', max: 10, participants: new Map(), startTime: null },
  'voice-2': { id: 'voice-2', name: 'Sala de Voz 2', max: 10, participants: new Map(), startTime: null },
  'voice-3': { id: 'voice-3', name: 'Sala de Voz 3', max: 10, participants: new Map(), startTime: null },
};

// uid -> channelId
const userCurrentVoiceChannel = new Map();

function getVoiceChannelsPayload() {
  const channels = {};
  for (const [id, ch] of Object.entries(VOICE_CHANNELS)) {
    channels[id] = {
      id: ch.id,
      name: ch.name,
      max: ch.max,
      active: ch.participants.size > 0,
      startTime: ch.startTime,
      participants: Array.from(ch.participants.values()).map((p) => ({
        uid: p.uid,
        socketId: p.socketId,
        name: p.name,
        avatar: p.avatar,
        color: p.color,
        userCode: p.userCode,
        isMuted: Boolean(p.isMuted),
        isDeafened: Boolean(p.isDeafened),
        isSpeaking: Boolean(p.isSpeaking),
        joinedAt: p.joinedAt,
        role: p.role || 'Miembro',
      })),
    };
  }
  return { channels };
}

function broadcastVoiceChannelsState() {
  const payload = getVoiceChannelsPayload();
  io.emit('voice-channels:state', payload);

  // Compatibilidad hacia atrás con clientes que escuchen group-voice:state
  const primary = VOICE_CHANNELS['voice-1'];
  io.emit('group-voice:state', {
    active: primary.participants.size > 0,
    startTime: primary.startTime,
    participants: Array.from(primary.participants.values()).map((p) => ({
      uid: p.uid,
      socketId: p.socketId,
      name: p.name,
      avatar: p.avatar,
      color: p.color,
      userCode: p.userCode,
      isMuted: Boolean(p.isMuted),
      isDeafened: Boolean(p.isDeafened),
      isSpeaking: Boolean(p.isSpeaking),
      joinedAt: p.joinedAt,
      role: p.role || 'Miembro',
    })),
  });
}

function removeUserFromVoiceChannels(uid) {
  const currentChId = userCurrentVoiceChannel.get(uid);
  if (!currentChId || !VOICE_CHANNELS[currentChId]) return null;

  const ch = VOICE_CHANNELS[currentChId];
  const had = ch.participants.delete(uid);
  userCurrentVoiceChannel.delete(uid);

  if (ch.participants.size === 0) {
    ch.startTime = null;
  }
  if (had) {
    io.emit('group-voice:peer-left', { channelId: currentChId, uid });
    broadcastVoiceChannelsState();
  }
  return currentChId;
}


function getSocketsForUid(uid) {
  const s = onlineSocketsByUid.get(uid);
  return s ? Array.from(s) : [];
}

function isUidOnline(uid) {
  const s = onlineSocketsByUid.get(uid);
  return Boolean(s && s.size > 0);
}

function addSocketForUid(uid, socketId) {
  if (!onlineSocketsByUid.has(uid)) {
    onlineSocketsByUid.set(uid, new Set());
  }
  onlineSocketsByUid.get(uid).add(socketId);
}

function removeSocketForUid(uid, socketId) {
  const s = onlineSocketsByUid.get(uid);
  if (s) {
    s.delete(socketId);
    if (s.size === 0) {
      onlineSocketsByUid.delete(uid);
      return true;
    }
  }
  return false;
}

function isUserMuted(uid) {
  if (!uid || !mutes[uid]) return null;
  const info = mutes[uid];
  if (info.until === 0) return info; // Permanente
  if (Date.now() < info.until) return info;
  // Expiró
  delete mutes[uid];
  saveAdminData();
  return null;
}

function isUserBanned(uid) {
  return (uid && bans[uid]) ? bans[uid] : null;
}

function addAuditLog(action, targetName, targetUid, byName, reason = '', details = '') {
  const entry = {
    id: 'log_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    action,
    targetName: cleanName(targetName) || 'Usuario',
    targetUid: String(targetUid || ''),
    byName: cleanName(byName) || 'Admin',
    reason: cleanBio(reason) || 'Sin motivo especificado',
    details: String(details || ''),
    time: Date.now(),
  };
  auditLog.unshift(entry);
  if (auditLog.length > 200) auditLog.pop();
  saveAdminData();
  broadcastAdminUpdate();
}

function getCleanUsersList() {
  const clean = {};
  const seenUids = new Set();
  for (const [sid, u] of Object.entries(users)) {
    if (!u || !u.uid) continue;
    if (seenUids.has(u.uid)) continue;
    seenUids.add(u.uid);
    clean[sid] = u;
  }
  return clean;
}

function broadcastAdminUpdate() {
  io.sockets.sockets.forEach((s) => {
    if (s.isAdmin) {
      s.emit('admin:dashboard_data', buildAdminDashboardPayload());
    }
  });
}

function buildAdminDashboardPayload() {
  const seen = new Set();
  const activeUserList = [];
  for (const [sid, u] of Object.entries(users)) {
    if (!u || !u.uid || seen.has(u.uid)) continue;
    seen.add(u.uid);
    activeUserList.push({
      socketId: sid,
      uid: u.uid,
      userCode: u.userCode,
      nickname: u.nickname,
      avatar: u.avatar,
      color: u.color,
      status: u.status,
      connectedAt: u.connectedAt,
      isMuted: Boolean(isUserMuted(u.uid)),
      muteInfo: isUserMuted(u.uid),
      warningsCount: (warnings[u.uid] || []).length,
    });
  }

  return {
    users: activeUserList,
    mutes: Object.entries(mutes).map(([uid, m]) => ({ uid, ...m })),
    bans: Object.entries(bans).map(([uid, b]) => ({ uid, ...b })),
    auditLog: auditLog.slice(0, 100),
    chatSettings,
    stats: {
      totalOnline: activeUserList.length,
      totalProfiles: Object.keys(profiles).length,
      totalMessages: Object.keys(messagesStore).length,
      uptime: Math.round(process.uptime()),
    },
  };
}

let messageIdCounter = 0;
let messagesStore = {};
const privateMessagesStore = {};

// Rate limiting
const messageTimestampsBySocket = new Map();

function checkRateLimit(socketId) {
  const now = Date.now();
  const timestamps = messageTimestampsBySocket.get(socketId) || [];
  const recent = timestamps.filter((t) => now - t < 3000);
  if (recent.length >= 5) {
    return false;
  }
  recent.push(now);
  messageTimestampsBySocket.set(socketId, recent);
  return true;
}

function getDmRoomId(uid1, uid2) {
  return [String(uid1), String(uid2)].sort().join('__');
}

function uidFromToken(token) {
  return crypto.createHash('sha256').update('chat-uid:' + token).digest('hex').slice(0, 16);
}

function getOrGenerateUserCode(uid) {
  if (profiles[uid] && profiles[uid].userCode) {
    return profiles[uid].userCode;
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

function cleanName(n) {
  return String(n || '')
    .replace(/[<>\u0000-\u001F\u007F-\u009F]/g, '')
    .trim()
    .slice(0, 24);
}

function cleanBio(b) {
  return String(b || '')
    .replace(/[<>\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')
    .trim()
    .slice(0, 200);
}

function cleanAvatar(a) {
  if (typeof a === 'string') {
    if (a.startsWith('data:image/') && a.length <= 300000) return a;
    if (isValidImageUrl(a)) return a;
  }
  return null;
}

function cleanMessageText(text) {
  return String(text || '')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')
    .trim()
    .slice(0, 2000);
}

function formatServerTime(ts) {
  const d = new Date(ts);
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

// Escritura atómica
function atomicWriteFile(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tempPath = filePath + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  fs.writeFileSync(tempPath, data, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function loadData() {
  try {
    if (fs.existsSync(FRIENDS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(FRIENDS_FILE, 'utf8'));
      profiles = raw.profiles || {};
      Object.entries(raw.friends || {}).forEach(([k, v]) => {
        friendsMap[k] = new Set(v);
      });
      Object.entries(raw.requests || {}).forEach(([k, v]) => {
        requestsMap[k] = new Set(v);
      });
    }
  } catch (e) {
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
        privateMessagesStore[k] = v;
      });
      messageIdCounter = Number(raw.messageIdCounter) || Object.keys(messagesStore).length;
    }
  } catch (e) {
    console.error('Error leyendo messages-data:', e.message);
    try {
      const corruptBackup = MESSAGES_FILE + '.corrupt.' + Date.now();
      if (fs.existsSync(MESSAGES_FILE)) fs.copyFileSync(MESSAGES_FILE, corruptBackup);
    } catch {}
  }

  try {
    if (fs.existsSync(ADMIN_DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(ADMIN_DATA_FILE, 'utf8'));
      mutes = raw.mutes || {};
      bans = raw.bans || {};
      warnings = raw.warnings || {};
      auditLog = raw.auditLog || [];
      chatSettings = raw.chatSettings || { slowmode: 0, paused: false };
    }
  } catch (e) {
    console.error('Error leyendo admin-data:', e.message);
  }
}
loadData();

let saveFriendsTimer = null;
function saveFriendsData() {
  if (saveFriendsTimer) clearTimeout(saveFriendsTimer);
  saveFriendsTimer = setTimeout(() => {
    try {
      const keep = new Set();
      const friends = {};
      const requests = {};
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
      const outProfiles = {};
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
    } catch (err) {
      console.error('Error guardando amigos:', err.message);
    }
  }, 600);
}

let saveMessagesTimer = null;
function saveMessagesData() {
  if (saveMessagesTimer) clearTimeout(saveMessagesTimer);
  saveMessagesTimer = setTimeout(() => {
    try {
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
    } catch (err) {
      console.error('Error guardando mensajes:', err.message);
    }
  }, 1000);
}

let saveAdminTimer = null;
function saveAdminData() {
  if (saveAdminTimer) clearTimeout(saveAdminTimer);
  saveAdminTimer = setTimeout(() => {
    try {
      atomicWriteFile(
        ADMIN_DATA_FILE,
        JSON.stringify({ mutes, bans, warnings, auditLog, chatSettings }, null, 2)
      );
    } catch (err) {
      console.error('Error guardando admin data:', err.message);
    }
  }, 600);
}

function hasRelations(id) {
  if (friendsMap[id] && friendsMap[id].size) return true;
  if (requestsMap[id] && requestsMap[id].size) return true;
  return Object.values(requestsMap).some((set) => set.has(id));
}

function friendStatus(id) {
  if (!isUidOnline(id)) return 'offline';
  const sids = getSocketsForUid(id);
  for (const sid of sids) {
    if (users[sid] && users[sid].status) return users[sid].status;
  }
  return 'online';
}

function friendEntry(id) {
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

function buildFriendsState(id) {
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

function pushFriendsState(id) {
  const sids = getSocketsForUid(id);
  sids.forEach((sid) => io.to(sid).emit('friends state', buildFriendsState(id)));
}

function notifyFriendsOf(id) {
  pushFriendsState(id);
  (friendsMap[id] || []).forEach(pushFriendsState);
}

function notifyUid(id, text) {
  const sids = getSocketsForUid(id);
  sids.forEach((sid) => io.to(sid).emit('friend notice', { text }));
}

function acceptFriendship(me, other) {
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

function syncProfileFromSocket(socketId) {
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

const adminAuthAttempts = new Map(); // ip -> { count, lockedUntil }

// Sockets Events
io.on('connection', (socket) => {
  socket.isAdmin = false;

  // Enviar estado actual de canales de voz inmediatamente al conectar
  socket.emit('voice-channels:state', getVoiceChannelsPayload());

  // Autenticación de admin en servidor con protección anti-fuerza bruta
  socket.on('admin auth', ({ password }) => {
    const ip = socket.handshake.address || 'ip_unknown';
    const now = Date.now();
    const attempt = adminAuthAttempts.get(ip) || { count: 0, lockedUntil: 0 };

    if (attempt.lockedUntil > now) {
      const waitMins = Math.ceil((attempt.lockedUntil - now) / 60000);
      socket.emit('admin auth result', {
        success: false,
        message: `Acceso bloqueado por seguridad. Espera ${waitMins} min antes de reintentar.`
      });
      return;
    }

    const inputPass = String(password || '');
    if (inputPass.length > 0 && inputPass === ADMIN_PASSWORD) {
      adminAuthAttempts.delete(ip);
      socket.isAdmin = true;
      socket.emit('admin auth result', { success: true, message: 'Autenticación exitosa' });
      socket.emit('admin:dashboard_data', buildAdminDashboardPayload());
      addAuditLog('admin_login', users[socket.id]?.nickname || 'Admin', socket.uid, users[socket.id]?.nickname || 'Admin', 'Inicio de sesión con clave');
    } else {
      attempt.count = (attempt.count || 0) + 1;
      if (attempt.count >= 5) {
        attempt.lockedUntil = now + 5 * 60 * 1000;
        adminAuthAttempts.set(ip, attempt);
        socket.emit('admin auth result', {
          success: false,
          message: 'Demasiados intentos erróneos. Acceso bloqueado por 5 minutos.'
        });
      } else {
        adminAuthAttempts.set(ip, attempt);
        const rem = 5 - attempt.count;
        socket.emit('admin auth result', {
          success: false,
          message: `Contraseña incorrecta. Te quedan ${rem} intento(s).`
        });
      }
    }
  });

  socket.on('join', (userData) => {
    let token = userData && typeof userData.token === 'string' && userData.token.length >= 8 ? userData.token : null;
    if (!token) {
      token = crypto.randomBytes(16).toString('hex');
    }
    const uid = uidFromToken(token);

    // Comprobar si está baneado
    const banInfo = isUserBanned(uid);
    if (banInfo) {
      socket.emit('banned', {
        reason: banInfo.reason || 'Has sido baneado permanentemente del servidor.',
        by: banInfo.by || 'Administración',
        date: banInfo.bannedAt,
      });
      socket.disconnect(true);
      return;
    }

    const nickname = userData && userData.nickname ? cleanName(userData.nickname) || 'Anónimo' : 'Anónimo';
    const avatar = userData && userData.avatar ? cleanAvatar(userData.avatar) : null;
    const bio = userData && userData.bio ? cleanBio(userData.bio) : '';
    const userCode = getOrGenerateUserCode(uid);

    // EXPULSIÓN DE MULTIPESTAÑAS / DUPLICADOS: Si ya existe una sesión con este mismo ID, desconectar la anterior
    const existingSockets = getSocketsForUid(uid);
    if (existingSockets.length > 0) {
      existingSockets.forEach((oldSid) => {
        if (oldSid !== socket.id) {
          const oldSock = io.sockets.sockets.get(oldSid);
          if (oldSock) {
            oldSock.emit('duplicate-session', {
              title: 'Sesión Cerrada',
              message: 'Has iniciado sesión en otra pestaña o ventana. Solo se permite una sesión activa para evitar duplicados en la lista de conectados.',
              reason: 'multi_tab_kick',
            });
            oldSock.disconnect(true);
          }
          delete users[oldSid];
          messageTimestampsBySocket.delete(oldSid);
        }
      });
      onlineSocketsByUid.delete(uid);
    }

    // Purgar sockets residuales con el mismo UID
    Object.keys(users).forEach((sid) => {
      if (sid !== socket.id && users[sid] && users[sid].uid === uid) {
        delete users[sid];
      }
    });

    socket.uid = uid;
    socket.userCode = userCode;

    const wasAlreadyOnline = isUidOnline(uid);
    addSocketForUid(uid, socket.id);

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
    socket.emit('chat_settings_updated', chatSettings);

    // Notificar si está silenciado
    const muteInfo = isUserMuted(uid);
    if (muteInfo) {
      socket.emit('moderation:mute_status', {
        muted: true,
        until: muteInfo.until,
        reason: muteInfo.reason,
        by: muteInfo.by,
      });
    }

    let memberSince = Number(userData && userData.memberSince);
    if (!isFinite(memberSince) || memberSince < 1577836800000 || memberSince > Date.now()) {
      memberSince = Date.now();
    }

    socket.nickname = nickname;
    const isFirst = Object.keys(users).length === 0;
    socket.userColor = isFirst ? '#ffcc00' : getUniqueColor();

    users[socket.id] = {
      nickname: socket.nickname,
      avatar,
      color: socket.userColor,
      isFirst,
      status: 'online',
      bio,
      memberSince,
      connectedAt: Date.now(),
      uid,
      userCode,
    };

    syncProfileFromSocket(socket.id);

    if (!wasAlreadyOnline) {
      io.emit('system-message', `${socket.nickname} (${userCode}) ha entrado al chat.`);
    }
    io.emit('update-users', getCleanUsersList());
    broadcastAdminUpdate();

    Object.values(messagesStore).forEach((msg) => {
      socket.emit('chat message', msg);
    });

    socket.emit('voice-channels:state', getVoiceChannelsPayload());
    broadcastVoiceChannelsState();
  });

  socket.on('friend request', (d) => {
    const me = socket.uid;
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

  socket.on('friend accept', (d) => {
    const me = socket.uid;
    const from = d && d.fromUid;
    if (!me || typeof from !== 'string') return;
    if (!requestsMap[me] || !requestsMap[me].has(from)) return;
    acceptFriendship(me, from);
  });

  socket.on('friend decline', (d) => {
    const me = socket.uid;
    const from = d && d.fromUid;
    if (!me || typeof from !== 'string' || !requestsMap[me]) return;
    requestsMap[me].delete(from);
    saveFriendsData();
    pushFriendsState(me);
    pushFriendsState(from);
  });

  socket.on('friend cancel', (d) => {
    const me = socket.uid;
    const to = d && d.toUid;
    if (!me || typeof to !== 'string' || !requestsMap[to]) return;
    requestsMap[to].delete(me);
    saveFriendsData();
    pushFriendsState(me);
    pushFriendsState(to);
  });

  socket.on('friend remove', (d) => {
    const me = socket.uid;
    const other = d && d.uid;
    if (!me || typeof other !== 'string') return;
    if (friendsMap[me]) friendsMap[me].delete(other);
    if (friendsMap[other]) friendsMap[other].delete(me);
    saveFriendsData();
    pushFriendsState(me);
    pushFriendsState(other);
  });

  socket.on('update profile', (p) => {
    const u = users[socket.id];
    if (!u || !p) return;

    const oldName = u.nickname;
    const newName = cleanName(p.nickname);
    if (newName) {
      u.nickname = newName;
      socket.nickname = newName;
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
    io.emit('update-users', getCleanUsersList());
    syncProfileFromSocket(socket.id);
    broadcastAdminUpdate();
  });

  socket.on('change status', (status) => {
    if (users[socket.id]) {
      const validStatuses = ['online', 'dnd', 'idle', 'offline'];
      users[socket.id].status = validStatuses.includes(status) ? status : 'online';
      io.emit('update-users', getCleanUsersList());
      if (users[socket.id].uid) notifyFriendsOf(users[socket.id].uid);
      broadcastAdminUpdate();
    }
  });

  // --- MENSAJES PÚBLICOS ---
  socket.on('chat message', (data) => {
    if (!users[socket.id]) return;

    const myUid = users[socket.id].uid;

    // Verificar si está silenciado
    const muteInfo = isUserMuted(myUid);
    if (muteInfo) {
      const timeStr = muteInfo.until === 0 ? 'indefinido' : `hasta las ${new Date(muteInfo.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      socket.emit('action error', { message: `Estás silenciado (${timeStr}). Motivo: ${muteInfo.reason || 'Sin motivo'}` });
      return;
    }

    // Verificar si el chat está pausado
    if (chatSettings.paused && !socket.isAdmin) {
      socket.emit('action error', { message: 'El chat general está pausado por la administración.' });
      return;
    }

    // Verificar Slowmode
    if (chatSettings.slowmode > 0 && !socket.isAdmin) {
      const last = lastMessageTimeByUid.get(myUid) || 0;
      const passed = Math.floor((Date.now() - last) / 1000);
      if (passed < chatSettings.slowmode) {
        const remaining = chatSettings.slowmode - passed;
        socket.emit('action error', { message: `Modo lento activo: espera ${remaining}s para volver a escribir.` });
        return;
      }
      lastMessageTimeByUid.set(myUid, Date.now());
    }

    if (!checkRateLimit(socket.id)) {
      socket.emit('action error', { message: 'Estás enviando mensajes demasiado rápido. Espera un momento.' });
      return;
    }

    messageIdCounter++;
    const msgId = 'msg_' + messageIdCounter + '_' + Date.now();

    typingUsers.delete(socket.id);
    broadcastTypingStatus();
    if (recordingUsers.delete(socket.id)) broadcastRecordingStatus();

    let image = data && data.image;
    if (!isValidImageUrl(image)) {
      image = null;
    }

    let audio = data && data.audio;
    if (typeof audio !== 'string' || !audio.startsWith('data:audio/')) audio = null;

    let waveform = null;
    if (Array.isArray(data && data.waveform) && data.waveform.length > 0 && data.waveform.length <= 100) {
      waveform = data.waveform.map((n) => Math.min(100, Math.max(0, Math.round(Number(n) || 0))));
    }
    let duration = Number(data && data.duration);
    duration = isFinite(duration) && duration > 0 && duration < 3600 ? Math.round(duration * 10) / 10 : 0;

    const cleanedText = cleanMessageText(data && data.text);
    const serverFormattedTime = formatServerTime(Date.now());

    const msgData = {
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

  socket.on('get private history', ({ targetUid }) => {
    const me = socket.uid;
    if (!me || !targetUid) return;
    const roomId = getDmRoomId(me, targetUid);
    const history = privateMessagesStore[roomId] || [];
    socket.emit('private history', { targetUid, messages: history });
  });

  socket.on('private message', (data) => {
    const me = socket.uid;
    const toUid = data && data.targetUid;
    const u = users[socket.id];
    if (!me || !toUid || !u) return;

    // Verificar si está silenciado
    const muteInfo = isUserMuted(me);
    if (muteInfo) {
      const timeStr = muteInfo.until === 0 ? 'indefinido' : `hasta las ${new Date(muteInfo.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      socket.emit('action error', { message: `Estás silenciado (${timeStr}). No puedes enviar mensajes privados.` });
      return;
    }

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

    let waveform = null;
    if (Array.isArray(data && data.waveform) && data.waveform.length > 0 && data.waveform.length <= 100) {
      waveform = data.waveform.map((n) => Math.min(100, Math.max(0, Math.round(Number(n) || 0))));
    }
    let duration = Number(data && data.duration);
    duration = isFinite(duration) && duration > 0 && duration < 3600 ? Math.round(duration * 10) / 10 : 0;

    const cleanedText = cleanMessageText(data && data.text);
    const serverFormattedTime = formatServerTime(Date.now());

    const msgData = {
      id: msgId,
      senderId: socket.id,
      senderUid: me,
      senderUserCode: u.userCode || socket.userCode || getOrGenerateUserCode(me),
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

    const mySockets = getSocketsForUid(me);
    mySockets.forEach((sid) => io.to(sid).emit('private message', msgData));

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

  socket.on('private typing', ({ targetUid, isTyping }) => {
    const destSockets = getSocketsForUid(targetUid);
    if (destSockets.length > 0 && users[socket.id]) {
      destSockets.forEach((destSid) => {
        io.to(destSid).emit('private typing update', {
          fromUid: socket.uid,
          fromName: users[socket.id].nickname,
          isTyping: !!isTyping,
        });
      });
    }
  });

  socket.on('private recording', ({ targetUid, isRecording }) => {
    const destSockets = getSocketsForUid(targetUid);
    if (destSockets.length > 0 && users[socket.id]) {
      destSockets.forEach((destSid) => {
        io.to(destSid).emit('private recording update', {
          fromUid: socket.uid,
          fromName: users[socket.id].nickname,
          isRecording: !!isRecording,
        });
      });
    }
  });

  socket.on('add private reaction', ({ targetUid, msgId, emoji }) => {
    const me = socket.uid;
    if (!me || !targetUid || !users[socket.id] || !emoji) return;
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
    const mySockets = getSocketsForUid(me);
    mySockets.forEach((sid) => io.to(sid).emit('update private reactions', { targetUid, msgId, reactions: msg.reactions }));

    const destSockets = getSocketsForUid(targetUid);
    destSockets.forEach((sid) => io.to(sid).emit('update private reactions', { targetUid: me, msgId, reactions: msg.reactions }));
  });

  socket.on('delete private message', ({ targetUid, msgId }) => {
    const me = socket.uid;
    if (!me || !targetUid || !msgId) return;
    const roomId = getDmRoomId(me, targetUid);
    const list = privateMessagesStore[roomId] || [];
    const msg = list.find((m) => m.id === msgId);
    if (!msg) return;

    if (msg.senderUid !== me && !socket.isAdmin) {
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

  socket.on('edit private message', ({ targetUid, msgId, newText }) => {
    const me = socket.uid;
    if (!me || !targetUid || !msgId) return;
    const roomId = getDmRoomId(me, targetUid);
    const msg = (privateMessagesStore[roomId] || []).find((m) => m.id === msgId);
    if (!msg) return;

    if (msg.senderUid !== me && !socket.isAdmin) {
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

  socket.on('add reaction', ({ msgId, emoji }) => {
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

  socket.on('typing', (isTyping) => {
    if (users[socket.id]) {
      if (isTyping) typingUsers.add(socket.id);
      else typingUsers.delete(socket.id);
      broadcastTypingStatus();
    }
  });

  socket.on('recording', (isRecording) => {
    if (!users[socket.id]) return;
    if (isRecording) recordingUsers.add(socket.id);
    else recordingUsers.delete(socket.id);
    broadcastRecordingStatus();
  });

  socket.on('delete message', (msgId) => {
    const msg = messagesStore[msgId];
    if (!msg) return;

    const myUid = users[socket.id] && users[socket.id].uid;
    const isAuthor = (myUid && msg.senderUid === myUid) || msg.senderId === socket.id;

    if (!isAuthor && !socket.isAdmin) {
      socket.emit('action error', { message: 'No tienes permiso para eliminar este mensaje.' });
      return;
    }

    delete messagesStore[msgId];
    saveMessagesData();
    io.emit('message deleted', msgId);
  });

  socket.on('edit message', ({ msgId, newText }) => {
    const msg = messagesStore[msgId];
    if (!msg) return;

    const myUid = users[socket.id] && users[socket.id].uid;
    const isAuthor = (myUid && msg.senderUid === myUid) || msg.senderId === socket.id;

    if (!isAuthor && !socket.isAdmin) {
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

  // ========================================================
  // --- PANEL DE ADMINISTRACIÓN FULL PROFESIONAL & MODERACIÓN ---
  // ========================================================
  socket.on('admin:get_dashboard', () => {
    if (!socket.isAdmin) {
      socket.emit('action error', { message: 'Se requieren permisos de administrador.' });
      return;
    }
    socket.emit('admin:dashboard_data', buildAdminDashboardPayload());
  });

  // Silenciar usuario por minutos
  socket.on('admin:mute', ({ targetUid, minutes, reason }) => {
    if (!socket.isAdmin) {
      socket.emit('action error', { message: 'Se requieren permisos de administrador.' });
      return;
    }
    if (!targetUid) return;

    const targetUser = Object.values(users).find((u) => u.uid === targetUid);
    const targetNick = targetUser?.nickname || profiles[targetUid]?.nickname || 'Usuario';
    const adminName = users[socket.id]?.nickname || 'Administrador';
    const cleanRsn = cleanBio(reason) || 'Incumplimiento de las normas';
    const mins = Math.max(0, parseInt(minutes, 10) || 0);

    const until = mins === 0 ? 0 : Date.now() + mins * 60 * 1000;
    mutes[targetUid] = {
      until,
      minutes: mins,
      reason: cleanRsn,
      by: adminName,
      mutedAt: Date.now(),
      nickname: targetNick,
    };
    saveAdminData();

    // Notificar al usuario afectado en todos sus sockets
    const targetSockets = getSocketsForUid(targetUid);
    targetSockets.forEach((sid) => {
      io.to(sid).emit('moderation:mute_status', {
        muted: true,
        until,
        reason: cleanRsn,
        by: adminName,
      });
      io.to(sid).emit('action error', {
        message: `Has sido silenciado ${mins > 0 ? 'por ' + mins + ' min' : 'permanentemente'}. Motivo: ${cleanRsn}`,
      });
    });

    const timeLabel = mins > 0 ? `${mins} minuto(s)` : 'tiempo indefinido';
    io.emit('system-message', `[Moderación] ${targetNick} fue silenciado (${timeLabel}). Motivo: ${cleanRsn}`);
    addAuditLog('mute', targetNick, targetUid, adminName, cleanRsn, `Duración: ${timeLabel}`);
    broadcastAdminUpdate();
  });

  // Quitar silencio
  socket.on('admin:unmute', ({ targetUid }) => {
    if (!socket.isAdmin) {
      socket.emit('action error', { message: 'Se requieren permisos de administrador.' });
      return;
    }
    if (!targetUid || !mutes[targetUid]) return;

    const targetNick = mutes[targetUid].nickname || profiles[targetUid]?.nickname || 'Usuario';
    const adminName = users[socket.id]?.nickname || 'Administrador';

    delete mutes[targetUid];
    saveAdminData();

    const targetSockets = getSocketsForUid(targetUid);
    targetSockets.forEach((sid) => {
      io.to(sid).emit('moderation:mute_status', { muted: false });
      io.to(sid).emit('action error', { message: 'Se ha levantado tu sanción de silencio.' });
    });

    io.emit('system-message', `[Moderación] Se ha retirado el silencio a ${targetNick}.`);
    addAuditLog('unmute', targetNick, targetUid, adminName, 'Silencio levantado');
    broadcastAdminUpdate();
  });

  // Expulsar usuario (Kick)
  socket.on('admin:kick', ({ targetUid, reason }) => {
    if (!socket.isAdmin) {
      socket.emit('action error', { message: 'Se requieren permisos de administrador.' });
      return;
    }
    if (!targetUid) return;

    const targetUser = Object.values(users).find((u) => u.uid === targetUid);
    const targetNick = targetUser?.nickname || profiles[targetUid]?.nickname || 'Usuario';
    const adminName = users[socket.id]?.nickname || 'Administrador';
    const cleanRsn = cleanBio(reason) || 'Expulsado por moderación';

    const targetSockets = getSocketsForUid(targetUid);
    targetSockets.forEach((sid) => {
      const targetSocket = io.sockets.sockets.get(sid);
      if (targetSocket) {
        targetSocket.emit('kicked', `${adminName} (Motivo: ${cleanRsn})`);
        targetSocket.disconnect(true);
      }
    });

    io.emit('system-message', `[Moderación] ${targetNick} fue expulsado. Motivo: ${cleanRsn}`);
    addAuditLog('kick', targetNick, targetUid, adminName, cleanRsn);
    broadcastAdminUpdate();
  });

  // Banear usuario
  socket.on('admin:ban', ({ targetUid, reason }) => {
    if (!socket.isAdmin) {
      socket.emit('action error', { message: 'Se requieren permisos de administrador.' });
      return;
    }
    if (!targetUid) return;

    const targetUser = Object.values(users).find((u) => u.uid === targetUid);
    const targetNick = targetUser?.nickname || profiles[targetUid]?.nickname || 'Usuario';
    const adminName = users[socket.id]?.nickname || 'Administrador';
    const cleanRsn = cleanBio(reason) || 'Sanción permanente';

    bans[targetUid] = {
      reason: cleanRsn,
      by: adminName,
      bannedAt: Date.now(),
      userCode: profiles[targetUid]?.userCode || targetUser?.userCode || '',
      nickname: targetNick,
    };
    saveAdminData();

    const targetSockets = getSocketsForUid(targetUid);
    targetSockets.forEach((sid) => {
      const targetSocket = io.sockets.sockets.get(sid);
      if (targetSocket) {
        targetSocket.emit('banned', { reason: cleanRsn, by: adminName, date: Date.now() });
        targetSocket.disconnect(true);
      }
    });

    io.emit('system-message', `[Moderación] ${targetNick} ha sido baneado permanentemente. Motivo: ${cleanRsn}`);
    addAuditLog('ban', targetNick, targetUid, adminName, cleanRsn);
    broadcastAdminUpdate();
  });

  // Desbanear usuario
  socket.on('admin:unban', ({ targetUid }) => {
    if (!socket.isAdmin) {
      socket.emit('action error', { message: 'Se requieren permisos de administrador.' });
      return;
    }
    if (!targetUid || !bans[targetUid]) return;

    const targetNick = bans[targetUid].nickname || 'Usuario';
    const adminName = users[socket.id]?.nickname || 'Administrador';

    delete bans[targetUid];
    saveAdminData();

    addAuditLog('unban', targetNick, targetUid, adminName, 'Desbaneado por el admin');
    broadcastAdminUpdate();
  });

  // Advertir usuario (Warn)
  socket.on('admin:warn', ({ targetUid, reason }) => {
    if (!socket.isAdmin) {
      socket.emit('action error', { message: 'Se requieren permisos de administrador.' });
      return;
    }
    if (!targetUid) return;

    const targetUser = Object.values(users).find((u) => u.uid === targetUid);
    const targetNick = targetUser?.nickname || profiles[targetUid]?.nickname || 'Usuario';
    const adminName = users[socket.id]?.nickname || 'Administrador';
    const cleanRsn = cleanBio(reason) || 'Advertencia de comportamiento';

    if (!warnings[targetUid]) warnings[targetUid] = [];
    warnings[targetUid].push({
      id: 'warn_' + Date.now(),
      text: cleanRsn,
      time: Date.now(),
      by: adminName,
    });
    saveAdminData();

    const targetSockets = getSocketsForUid(targetUid);
    targetSockets.forEach((sid) => {
      io.to(sid).emit('moderation:warned', {
        reason: cleanRsn,
        by: adminName,
        time: Date.now(),
        count: warnings[targetUid].length,
      });
    });

    addAuditLog('warn', targetNick, targetUid, adminName, cleanRsn, `Total advertencias: ${warnings[targetUid].length}`);
    broadcastAdminUpdate();
  });

  // Purgar mensajes de un usuario en el chat general
  socket.on('admin:purge_user_messages', ({ targetUid }) => {
    if (!socket.isAdmin) {
      socket.emit('action error', { message: 'Se requieren permisos de administrador.' });
      return;
    }
    if (!targetUid) return;

    const deletedIds = [];
    Object.entries(messagesStore).forEach(([id, m]) => {
      if (m.senderUid === targetUid) {
        deletedIds.push(id);
        delete messagesStore[id];
      }
    });

    saveMessagesData();
    if (deletedIds.length > 0) {
      io.emit('bulk messages deleted', { msgIds: deletedIds });
    }

    const targetNick = profiles[targetUid]?.nickname || 'Usuario';
    const adminName = users[socket.id]?.nickname || 'Administrador';
    addAuditLog('purge_messages', targetNick, targetUid, adminName, `Se purgaron ${deletedIds.length} mensaje(s)`);
    broadcastAdminUpdate();
  });

  // Vaciar todo el chat
  socket.on('admin:clear_all_chat', () => {
    if (!socket.isAdmin) {
      socket.emit('action error', { message: 'Se requieren permisos de administrador.' });
      return;
    }
    messagesStore = {};
    saveMessagesData();
    io.emit('chat cleared');
    const adminName = users[socket.id]?.nickname || 'Administrador';
    addAuditLog('clear_chat', 'Todos los mensajes', '', adminName, 'Vaciado total del chat');
    io.emit('system-message', `[Moderación] ${adminName} ha vaciado el historial de mensajes de la sala.`);
  });

  // Configurar modo lento
  socket.on('admin:set_slowmode', ({ seconds }) => {
    if (!socket.isAdmin) {
      socket.emit('action error', { message: 'Se requieren permisos de administrador.' });
      return;
    }
    const secs = Math.max(0, Math.min(120, parseInt(seconds, 10) || 0));
    chatSettings.slowmode = secs;
    saveAdminData();
    io.emit('chat_settings_updated', chatSettings);
    const adminName = users[socket.id]?.nickname || 'Administrador';
    addAuditLog('set_slowmode', 'Sala General', '', adminName, secs > 0 ? `${secs}s de espera` : 'Desactivado');
    io.emit('system-message', secs > 0 ? `[Aviso] Modo lento activado: ${secs}s entre mensajes.` : `[Aviso] Modo lento desactivado.`);
    broadcastAdminUpdate();
  });

  // Pausar / Reanudar chat
  socket.on('admin:set_paused', ({ paused }) => {
    if (!socket.isAdmin) {
      socket.emit('action error', { message: 'Se requieren permisos de administrador.' });
      return;
    }
    chatSettings.paused = !!paused;
    saveAdminData();
    io.emit('chat_settings_updated', chatSettings);
    const adminName = users[socket.id]?.nickname || 'Administrador';
    addAuditLog('set_paused', 'Sala General', '', adminName, chatSettings.paused ? 'Chat pausado' : 'Chat reanudado');
    io.emit('system-message', chatSettings.paused ? `[Aviso] ${adminName} ha pausado el chat general (Solo administradores pueden enviar mensajes).` : `[Aviso] ${adminName} ha reanudado el chat general.`);
    broadcastAdminUpdate();
  });

  // Enviar anuncio oficial destacado
  socket.on('admin:broadcast', ({ text, title }) => {
    if (!socket.isAdmin) {
      socket.emit('action error', { message: 'Se requieren permisos de administrador.' });
      return;
    }
    const cleanTxt = cleanMessageText(text);
    if (!cleanTxt) return;
    const cleanTtl = cleanName(title) || 'Anuncio Oficial del Administrador';
    const adminName = users[socket.id]?.nickname || 'Owner';

    io.emit('admin:announcement', {
      title: cleanTtl,
      text: cleanTxt,
      by: adminName,
      time: Date.now(),
    });
    addAuditLog('broadcast', cleanTtl, '', adminName, cleanTxt);
  });

  // Editar usuario por UID (nombre y color)
  socket.on('admin:edit_user', ({ targetUid, newNickname, newColor }) => {
    if (!socket.isAdmin) {
      socket.emit('action error', { message: 'Se requieren permisos de administrador.' });
      return;
    }
    if (!targetUid) return;

    const cleanedNick = newNickname ? cleanName(newNickname) : null;
    const colorStr = newColor ? String(newColor) : null;

    if (profiles[targetUid]) {
      if (cleanedNick) profiles[targetUid].nickname = cleanedNick;
      if (colorStr) profiles[targetUid].color = colorStr;
    }

    // Actualizar sockets activos del usuario
    const sids = getSocketsForUid(targetUid);
    sids.forEach((sid) => {
      if (users[sid]) {
        if (cleanedNick) {
          users[sid].nickname = cleanedNick;
          const s = io.sockets.sockets.get(sid);
          if (s) s.nickname = cleanedNick;
        }
        if (colorStr) {
          users[sid].color = colorStr;
          const s = io.sockets.sockets.get(sid);
          if (s) s.userColor = colorStr;
        }
      }
    });

    saveFriendsData();
    io.emit('update-users', getCleanUsersList());
    notifyFriendsOf(targetUid);
    broadcastAdminUpdate();
    const adminName = users[socket.id]?.nickname || 'Administrador';
    addAuditLog('edit_user', cleanedNick || profiles[targetUid]?.nickname || 'Usuario', targetUid, adminName, 'Nombre o color modificado');
  });

  // ========================================================
  // --- SISTEMA DE LLAMADAS WEBRTC PARA CHATS PRIVADOS ---
  // ========================================================
  socket.on('call:initiate', ({ targetUid }) => {
    const callerUid = socket.uid;
    const callerUser = users[socket.id];
    if (!callerUid || !targetUid || !callerUser) return;

    if (callerUid === targetUid) {
      socket.emit('action error', { message: 'No puedes llamarte a ti mismo.' });
      return;
    }

    const destSockets = getSocketsForUid(targetUid);
    if (!destSockets.length) {
      socket.emit('call:rejected', { targetUid, reason: 'offline', message: 'El usuario no está conectado actualmente.' });
      return;
    }

    const callKey = [callerUid, targetUid].sort().join('__');
    activeCalls.set(callKey, { callerUid, targetUid, startedAt: Date.now() });

    // Enviar evento de llamada entrante a todas las pestañas del receptor
    destSockets.forEach((sid) => {
      io.to(sid).emit('call:incoming', {
        callerUid,
        callerName: callerUser.nickname,
        callerAvatar: callerUser.avatar,
        callerColor: callerUser.color,
        callerCode: callerUser.userCode,
      });
    });
  });

  socket.on('call:accept', (payload) => {
    const myUid = socket.uid;
    const targetUid = payload && (payload.targetUid || payload.callerUid);
    if (!myUid || !targetUid) return;

    const callerSockets = getSocketsForUid(targetUid);
    callerSockets.forEach((sid) => {
      io.to(sid).emit('call:accepted', { targetUid: myUid });
    });
  });

  socket.on('call:reject', (payload) => {
    const myUid = socket.uid;
    const targetUid = payload && (payload.targetUid || payload.callerUid);
    const reason = payload && payload.reason;
    if (!myUid || !targetUid) return;

    const callKey = [targetUid, myUid].sort().join('__');
    activeCalls.delete(callKey);

    const callerSockets = getSocketsForUid(targetUid);
    callerSockets.forEach((sid) => {
      io.to(sid).emit('call:rejected', {
        targetUid: myUid,
        reason: reason || 'declined',
        message: 'Llamada rechazada.',
      });
    });
  });

  socket.on('call:end', ({ targetUid }) => {
    const myUid = socket.uid;
    if (!myUid || !targetUid) return;

    const callKey = [myUid, targetUid].sort().join('__');
    activeCalls.delete(callKey);

    const destSockets = getSocketsForUid(targetUid);
    destSockets.forEach((sid) => {
      io.to(sid).emit('call:ended', { fromUid: myUid });
    });
  });

  // Reenvío de señalización WebRTC (Offer, Answer, ICE Candidates)
  socket.on('call:signal', (payload) => {
    const myUid = socket.uid;
    const targetUid = payload && payload.targetUid;
    if (!myUid || !targetUid) return;

    const signalData = (payload && payload.signal) || {
      offer: payload && payload.offer,
      answer: payload && payload.answer,
      candidate: payload && payload.candidate,
    };

    const destSockets = getSocketsForUid(targetUid);
    destSockets.forEach((sid) => {
      io.to(sid).emit('call:signal', {
        fromUid: myUid,
        signal: signalData,
        offer: signalData.offer,
        answer: signalData.answer,
        candidate: signalData.candidate,
      });
    });
  });

  // ========================================================
  // --- SISTEMA DE 3 CANALES DE VOZ (10/10) ESTILO DISCORD ---
  // ========================================================
  socket.on('group-voice:start', (data) => {
    const chId = typeof data === 'string' ? data : (data && data.channelId) || 'voice-1';
    joinVoiceChannel(chId);
  });

  socket.on('group-voice:join', (data) => {
    const chId = typeof data === 'string' ? data : (data && data.channelId) || 'voice-1';
    joinVoiceChannel(chId);
  });

  socket.on('voice-channel:join', (data) => {
    const chId = typeof data === 'string' ? data : (data && data.channelId) || 'voice-1';
    joinVoiceChannel(chId);
  });

  function joinVoiceChannel(targetChannelId) {
    let myUid = socket.uid;
    let user = users[socket.id];
    if (!myUid && user && user.uid) {
      myUid = user.uid;
    }
    if (myUid && !user) {
      const prof = profiles[myUid] || {};
      user = {
        uid: myUid,
        nickname: prof.nickname || socket.nickname || 'Usuario',
        avatar: prof.avatar || null,
        color: prof.color || socket.userColor || '#38bdf8',
        userCode: prof.userCode || socket.userCode || getOrGenerateUserCode(myUid),
        isAdmin: Boolean(socket.isAdmin),
        isFirst: false,
      };
      users[socket.id] = user;
    }

    if (!myUid || !user) {
      console.warn('joinVoiceChannel: No se pudo resolver UID para el socket', socket.id);
      return;
    }
    if (isUserBanned(myUid)) return;

    const rawChId = typeof targetChannelId === 'string' ? targetChannelId : (targetChannelId && targetChannelId.channelId);
    const chId = VOICE_CHANNELS[rawChId] ? rawChId : 'voice-1';
    const ch = VOICE_CHANNELS[chId];

    // Si ya estaba en otro canal, removerlo primero
    const currentCh = userCurrentVoiceChannel.get(myUid);
    if (currentCh && currentCh !== chId) {
      removeUserFromVoiceChannels(myUid);
    }

    if (ch.participants.size >= ch.max && !ch.participants.has(myUid)) {
      socket.emit('action error', { message: `El canal "${ch.name}" está lleno (${ch.max}/${ch.max} personas).` });
      return;
    }

    const wasEmpty = ch.participants.size === 0;
    if (wasEmpty) {
      ch.startTime = Date.now();
    }

    const role = (socket.isAdmin || user.isAdmin) ? 'Owner' : (user.isFirst ? 'Admin' : 'Miembro');
    const isNew = !ch.participants.has(myUid);

    ch.participants.set(myUid, {
      uid: myUid,
      socketId: socket.id,
      name: user.nickname,
      avatar: user.avatar,
      color: user.color,
      userCode: user.userCode,
      isMuted: false,
      isDeafened: false,
      isSpeaking: false,
      joinedAt: Date.now(),
      role,
    });
    userCurrentVoiceChannel.set(myUid, chId);

    // Enviar confirmación al socket que se unió con la lista de peers existentes en SU canal
    const existingPeers = Array.from(ch.participants.values())
      .filter((p) => p.uid !== myUid)
      .map((p) => ({
        uid: p.uid,
        socketId: p.socketId,
        name: p.name,
        avatar: p.avatar,
        color: p.color,
      }));

    socket.emit('voice:channel-joined', {
      channelId: chId,
      channelName: ch.name,
      peers: existingPeers,
      startTime: ch.startTime,
    });

    // Notificar a todos los que ya estaban en ESE canal de voz para que establezcan WebRTC
    existingPeers.forEach((p) => {
      const destSockets = getSocketsForUid(p.uid);
      destSockets.forEach((sid) => {
        io.to(sid).emit('group-voice:peer-joined', {
          channelId: chId,
          uid: myUid,
          socketId: socket.id,
          name: user.nickname,
          avatar: user.avatar,
          color: user.color,
        });
      });
    });

    if (isNew) {
      // Notificación flotante e interactiva para los demás usuarios en el chat
      socket.broadcast.emit('group-voice:invitation', {
        channelId: chId,
        channelName: ch.name,
        initiatorUid: myUid,
        initiatorName: user.nickname,
        initiatorAvatar: user.avatar,
        initiatorColor: user.color,
        participantCount: ch.participants.size,
        max: ch.max,
        startTime: ch.startTime,
      });

      // Anuncio en el chat global
      io.emit('system-message', `🔊 ${user.nickname} se ha unido a "${ch.name}" (${ch.participants.size}/${ch.max}).`);
    }

    broadcastVoiceChannelsState();
  }

  socket.on('group-voice:leave', () => {
    const myUid = socket.uid;
    if (myUid) {
      removeUserFromVoiceChannels(myUid);
    }
  });

  socket.on('voice-channel:leave', () => {
    const myUid = socket.uid;
    if (myUid) {
      removeUserFromVoiceChannels(myUid);
    }
  });

  socket.on('group-voice:signal', (payload) => {
    const myUid = socket.uid;
    const targetUid = payload && payload.targetUid;
    if (!myUid || !targetUid) return;

    const myCh = userCurrentVoiceChannel.get(myUid);
    const targetCh = userCurrentVoiceChannel.get(targetUid);
    if (!myCh || myCh !== targetCh) return;

    const signalData = (payload && payload.signal) || {
      offer: payload && payload.offer,
      answer: payload && payload.answer,
      candidate: payload && payload.candidate,
    };

    const destSockets = getSocketsForUid(targetUid);
    destSockets.forEach((sid) => {
      io.to(sid).emit('group-voice:signal', {
        channelId: myCh,
        fromUid: myUid,
        signal: signalData,
        offer: signalData.offer,
        answer: signalData.answer,
        candidate: signalData.candidate,
      });
    });
  });

  socket.on('group-voice:update-state', (data) => {
    const myUid = socket.uid;
    if (!myUid) return;
    const chId = userCurrentVoiceChannel.get(myUid);
    if (!chId || !VOICE_CHANNELS[chId]) return;

    const ch = VOICE_CHANNELS[chId];
    const p = ch.participants.get(myUid);
    if (!p) return;

    if (data && typeof data.isMuted === 'boolean') p.isMuted = data.isMuted;
    if (data && typeof data.isDeafened === 'boolean') p.isDeafened = data.isDeafened;
    if (data && typeof data.isSpeaking === 'boolean') p.isSpeaking = data.isSpeaking;

    io.emit('group-voice:participant-updated', {
      channelId: chId,
      uid: myUid,
      isMuted: p.isMuted,
      isDeafened: p.isDeafened,
      isSpeaking: p.isSpeaking,
    });
    broadcastVoiceChannelsState();
  });

  socket.on('group-voice:admin-action', ({ targetUid, action, value }) => {
    const myUser = users[socket.id];
    const isAdmin = socket.isAdmin || (myUser && myUser.isAdmin);
    if (!isAdmin || !targetUid) return;

    const targetChId = userCurrentVoiceChannel.get(targetUid);
    if (!targetChId || !VOICE_CHANNELS[targetChId]) return;
    const ch = VOICE_CHANNELS[targetChId];

    if (action === 'mute') {
      if (ch.participants.has(targetUid)) {
        const p = ch.participants.get(targetUid);
        p.isMuted = Boolean(value);
        const destSockets = getSocketsForUid(targetUid);
        destSockets.forEach((sid) => io.to(sid).emit('group-voice:force-mute', { muted: Boolean(value) }));
        broadcastVoiceChannelsState();
      }
    } else if (action === 'kick') {
      if (ch.participants.has(targetUid)) {
        removeUserFromVoiceChannels(targetUid);
        const destSockets = getSocketsForUid(targetUid);
        destSockets.forEach((sid) => io.to(sid).emit('group-voice:kicked', { reason: 'Has sido desconectado de la llamada por un Administrador.' }));
      }
    }
  });

  socket.on('disconnect', () => {
    if (users[socket.id]) {
      const name = users[socket.id].nickname;
      const leavingUid = users[socket.id].uid;

      // Si estaba en algún canal de voz grupal, desconectarlo
      if (leavingUid) {
        removeUserFromVoiceChannels(leavingUid);
      }

      // Si estaba en una llamada privada, avisar a la contraparte
      activeCalls.forEach((call, key) => {
        if (call.callerUid === leavingUid || call.targetUid === leavingUid) {
          const otherUid = call.callerUid === leavingUid ? call.targetUid : call.callerUid;
          const destSockets = getSocketsForUid(otherUid);
          destSockets.forEach((sid) => io.to(sid).emit('call:ended', { fromUid: leavingUid }));
          activeCalls.delete(key);
        }
      });

      typingUsers.delete(socket.id);
      broadcastTypingStatus();
      recordingUsers.delete(socket.id);
      broadcastRecordingStatus();

      messageTimestampsBySocket.delete(socket.id);
      delete users[socket.id];

      if (leavingUid) {
        const wentOffline = removeSocketForUid(leavingUid, socket.id);
        if (wentOffline) {
          if (profiles[leavingUid]) profiles[leavingUid].lastSeen = Date.now();
          if (hasRelations(leavingUid)) saveFriendsData();
          notifyFriendsOf(leavingUid);
          io.emit('system-message', `${name} ha salido del chat.`);
        }
      }

      io.emit('update-users', getCleanUsersList());
      broadcastAdminUpdate();
    }
  });
});

app.get('*', (_req, res) => {
  const rootIndex = path.join(__dirname, 'index.html');
  if (fs.existsSync(rootIndex)) {
    return res.sendFile(rootIndex);
  }
  const publicIndex = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(publicIndex)) {
    return res.sendFile(publicIndex);
  }
  res.status(404).send('index.html no encontrado');
});

let TARGET_PORT = 3000;
if (process.env.RENDER === 'true' && process.env.PORT) {
  TARGET_PORT = Number(process.env.PORT);
} else if (process.env.PORT && process.env.PORT !== '8080') {
  TARGET_PORT = Number(process.env.PORT);
}

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE' && TARGET_PORT !== 3000) {
    console.warn(`Puerto ${TARGET_PORT} en uso, reintentando en puerto 3000...`);
    TARGET_PORT = 3000;
    server.listen(3000, '0.0.0.0', () => {
      console.log(`zLowStudio Chat Server corriendo en http://0.0.0.0:3000`);
    });
  } else {
    console.error('Error en el servidor:', err);
    process.exit(1);
  }
});

server.listen(TARGET_PORT, '0.0.0.0', () => {
  console.log(`zLowStudio Chat Server corriendo en http://0.0.0.0:${TARGET_PORT}`);
});

