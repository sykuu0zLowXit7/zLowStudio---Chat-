import mongoose from 'mongoose';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

mongoose.set('bufferCommands', false);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_JSON_FILE = path.join(DATA_DIR, 'database-store.json');

// Modos de Base de Datos: 'mongodb' | 'postgres' | 'local'
let activeDbEngine = 'local';
let pgPool = null;

// Esquemas de Mongoose para MongoDB Atlas
let MongoUser = null;
let MongoMessage = null;
let MongoFriendship = null;
let MongoAdminLog = null;

// Almacén en memoria sincronizado para alta velocidad y fallback local
const memoryStore = {
  users: new Map(), // uid -> userDoc
  usersByUsername: new Map(), // username.toLowerCase() -> uid
  usersByToken: new Map(), // token -> uid
  friends: new Map(), // uid -> Set(friendUids)
  requests: new Map(), // uid -> Set(requestFromUids)
  messages: [], // Array de mensajes globales
  privateMessages: new Map(), // roomId -> Array de mensajes privados
  mutes: new Map(),
  bans: new Map(),
  warnings: new Map(),
  auditLog: [],
  chatSettings: { slowmode: 0, paused: false },
};

function atomicWrite(filePath, data) {
  try {
    const tmp = filePath + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    console.error('[DB-Local] Error escribiendo archivo atómico:', err.message);
  }
}

function persistLocalStore() {
  if (activeDbEngine === 'mongodb') return; // En MongoDB se persiste en la nube directamente
  try {
    const dump = {
      users: Array.from(memoryStore.users.values()),
      friends: Object.fromEntries(
        Array.from(memoryStore.friends.entries()).map(([k, s]) => [k, Array.from(s)])
      ),
      requests: Object.fromEntries(
        Array.from(memoryStore.requests.entries()).map(([k, s]) => [k, Array.from(s)])
      ),
      messages: memoryStore.messages.slice(-500),
      privateMessages: Object.fromEntries(memoryStore.privateMessages.entries()),
      mutes: Object.fromEntries(memoryStore.mutes.entries()),
      bans: Object.fromEntries(memoryStore.bans.entries()),
      warnings: Object.fromEntries(memoryStore.warnings.entries()),
      auditLog: memoryStore.auditLog.slice(0, 150),
      chatSettings: memoryStore.chatSettings,
    };
    atomicWrite(DB_JSON_FILE, dump);
  } catch (e) {
    console.error('[DB-Local] Error persistiendo copia local:', e.message);
  }
}

let saveTimer = null;
function schedulePersist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(persistLocalStore, 1000);
}

// Cargar respaldo local previo
function loadLocalStore() {
  try {
    // 1. Intentar cargar database-store.json
    if (fs.existsSync(DB_JSON_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DB_JSON_FILE, 'utf8'));
      if (Array.isArray(parsed.users)) {
        parsed.users.forEach((u) => {
          memoryStore.users.set(u.uid, u);
          if (u.username) memoryStore.usersByUsername.set(u.username.toLowerCase(), u.uid);
          if (u.token) memoryStore.usersByToken.set(u.token, u.uid);
        });
      }
      if (parsed.friends) {
        Object.entries(parsed.friends).forEach(([k, arr]) => {
          memoryStore.friends.set(k, new Set(arr));
        });
      }
      if (parsed.requests) {
        Object.entries(parsed.requests).forEach(([k, arr]) => {
          memoryStore.requests.set(k, new Set(arr));
        });
      }
      if (Array.isArray(parsed.messages)) memoryStore.messages = parsed.messages;
      if (parsed.privateMessages) {
        Object.entries(parsed.privateMessages).forEach(([k, arr]) => {
          memoryStore.privateMessages.set(k, arr);
        });
      }
      if (parsed.mutes) {
        Object.entries(parsed.mutes).forEach(([k, v]) => memoryStore.mutes.set(k, v));
      }
      if (parsed.bans) {
        Object.entries(parsed.bans).forEach(([k, v]) => memoryStore.bans.set(k, v));
      }
      if (parsed.warnings) {
        Object.entries(parsed.warnings).forEach(([k, v]) => memoryStore.warnings.set(k, v));
      }
      if (Array.isArray(parsed.auditLog)) memoryStore.auditLog = parsed.auditLog;
      if (parsed.chatSettings) memoryStore.chatSettings = parsed.chatSettings;
      console.log(`[DB-Local] Cargados ${memoryStore.users.size} usuarios y ${memoryStore.messages.length} mensajes locales.`);
    }

    // 2. Si venía del formato anterior de friends-data.json, migrar perfiles automáticamente
    const OLD_FRIENDS_FILE = path.join(DATA_DIR, 'friends-data.json');
    if (fs.existsSync(OLD_FRIENDS_FILE) && memoryStore.users.size === 0) {
      const old = JSON.parse(fs.readFileSync(OLD_FRIENDS_FILE, 'utf8'));
      if (old.profiles) {
        Object.entries(old.profiles).forEach(([uid, p]) => {
          const uDoc = {
            uid,
            username: (p.nickname || 'usuario_' + uid.slice(0, 5)).toLowerCase().replace(/\s+/g, '_'),
            nickname: p.nickname || 'Usuario',
            passwordHash: '', // Usuario preexistente de sesión rápida
            userCode: p.userCode || `#${Math.floor(1000 + Math.random() * 9000)}`,
            avatar: p.avatar || null,
            bannerImage: p.bannerImage || null,
            bannerColor: p.bannerColor || null,
            mascotStatus: p.mascotStatus || null,
            bio: p.bio || '',
            color: p.color || '#38bdf8',
            memberSince: p.memberSince || Date.now(),
            lastSeen: p.lastSeen || Date.now(),
            token: uid + '_token',
          };
          memoryStore.users.set(uid, uDoc);
          memoryStore.usersByUsername.set(uDoc.username, uid);
          memoryStore.usersByToken.set(uDoc.token, uid);
        });
      }
      if (old.friends) {
        Object.entries(old.friends).forEach(([k, arr]) => {
          memoryStore.friends.set(k, new Set(arr));
        });
      }
      if (old.requests) {
        Object.entries(old.requests).forEach(([k, arr]) => {
          memoryStore.requests.set(k, new Set(arr));
        });
      }
      console.log(`[DB-Local] Migrados ${memoryStore.users.size} perfiles desde formato anterior.`);
      schedulePersist();
    }

    // Asegurar que el usuario principal específico o el primer usuario tenga el rol de Administrador permanente
    let hasAdmin = false;
    for (const u of memoryStore.users.values()) {
      if (isUserAdmin(u)) {
        u.isAdmin = true;
        u.role = 'admin';
        hasAdmin = true;
        break;
      }
    }
    if (!hasAdmin && memoryStore.users.size > 0) {
      const firstUser = memoryStore.users.values().next().value;
      if (firstUser) {
        firstUser.isAdmin = true;
        firstUser.role = 'admin';
        console.log(`[DB] Asignado rol permanente de Administrador al usuario principal: ${firstUser.username}`);
        schedulePersist();
      }
    }
  } catch (err) {
    console.warn('[DB-Local] Advertencia al leer datos locales:', err.message);
  }
}

// Inicialización de conexión a Base de Datos
export async function initDatabase() {
  loadLocalStore();

  const mongoUri = (process.env.MONGODB_URI || process.env.MONGO_URI || '').trim();
  const postgresUrl = (process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim();

  // 1. Probar conexión a MongoDB Atlas si se configuró la variable
  if (mongoUri) {
    try {
      console.log('[DB] Conectando a MongoDB Atlas en la nube...');
      await mongoose.connect(mongoUri, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
      });

      activeDbEngine = 'mongodb';
      console.log('✅ [DB] ¡Conectado exitosamente a MongoDB Atlas! Datos 100% permanentes en la nube.');

      // Definir esquemas
      const userSchema = new mongoose.Schema({
        uid: { type: String, unique: true, required: true },
        username: { type: String, unique: true, required: true, lowercase: true, trim: true },
        passwordHash: { type: String, required: true },
        nickname: { type: String, required: true, trim: true },
        userCode: { type: String, required: true },
        avatar: { type: String, default: null },
        bannerImage: { type: String, default: null },
        bannerColor: { type: String, default: null },
        mascotStatus: { type: String, default: null },
        bio: { type: String, default: '' },
        color: { type: String, default: '#38bdf8' },
        memberSince: { type: Number, default: () => Date.now() },
        lastSeen: { type: Number, default: () => Date.now() },
        token: { type: String, unique: true },
        friends: { type: [String], default: [] },
        requests: { type: [String], default: [] },
      }, { timestamps: true });

      MongoUser = mongoose.models.User || mongoose.model('User', userSchema);

      const msgSchema = new mongoose.Schema({
        id: { type: String, unique: true, required: true },
        user: { type: String, required: true },
        text: { type: String, default: '' },
        image: { type: String, default: null },
        audio: { type: String, default: null },
        color: { type: String, default: '#38bdf8' },
        time: { type: String },
        senderId: { type: String },
        senderUid: { type: String },
        targetUid: { type: String, default: null },
        reactions: { type: Object, default: {} },
        timestamp: { type: Number, default: () => Date.now() },
      });

      MongoMessage = mongoose.models.Message || mongoose.model('Message', msgSchema);

      // Cargar usuarios desde MongoDB a la caché de memoria
      const remoteUsers = await MongoUser.find({}).lean();
      remoteUsers.forEach((u) => {
        memoryStore.users.set(u.uid, u);
        if (u.username) memoryStore.usersByUsername.set(u.username.toLowerCase(), u.uid);
        if (u.token) memoryStore.usersByToken.set(u.token, u.uid);
        if (Array.isArray(u.friends)) memoryStore.friends.set(u.uid, new Set(u.friends));
        if (Array.isArray(u.requests)) memoryStore.requests.set(u.uid, new Set(u.requests));
      });
      console.log(`[DB-Mongo] Sincronizados ${remoteUsers.length} usuarios desde la nube.`);
      return;
    } catch (err) {
      console.warn('⚠️ [DB] No se pudo conectar a MongoDB Atlas:', err.message);
      console.warn('⚠️ [DB] Utilizando modo seguro local/Postgres.');
    }
  }

  // 2. Probar conexión a PostgreSQL (Render PostgreSQL)
  if (postgresUrl) {
    try {
      console.log('[DB] Conectando a PostgreSQL de Render...');
      pgPool = new pg.Pool({
        connectionString: postgresUrl,
        ssl: postgresUrl.includes('localhost') ? false : { rejectUnauthorized: false },
        connectionTimeoutMillis: 5000,
      });

      // Crear tablas necesarias si no existen
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS users (
          uid VARCHAR(64) PRIMARY KEY,
          username VARCHAR(64) UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          nickname VARCHAR(64) NOT NULL,
          user_code VARCHAR(16) NOT NULL,
          avatar TEXT,
          banner_image TEXT,
          banner_color VARCHAR(64),
          mascot_status TEXT,
          bio TEXT,
          color VARCHAR(32),
          member_since BIGINT,
          last_seen BIGINT,
          token TEXT UNIQUE
        );
        CREATE TABLE IF NOT EXISTS friends (
          user_uid VARCHAR(64) NOT NULL,
          friend_uid VARCHAR(64) NOT NULL,
          PRIMARY KEY (user_uid, friend_uid)
        );
        CREATE TABLE IF NOT EXISTS friend_requests (
          from_uid VARCHAR(64) NOT NULL,
          to_uid VARCHAR(64) NOT NULL,
          PRIMARY KEY (from_uid, to_uid)
        );
      `);

      activeDbEngine = 'postgres';
      console.log('✅ [DB] ¡Conectado exitosamente a PostgreSQL! Datos persistentes en Render.');

      // Cargar usuarios de PostgreSQL a caché en memoria
      const resUsers = await pgPool.query('SELECT * FROM users');
      resUsers.rows.forEach((r) => {
        const u = {
          uid: r.uid,
          username: r.username,
          passwordHash: r.password_hash,
          nickname: r.nickname,
          userCode: r.user_code,
          avatar: r.avatar,
          bannerImage: r.banner_image,
          bannerColor: r.banner_color,
          mascotStatus: r.mascot_status,
          bio: r.bio,
          color: r.color,
          memberSince: Number(r.member_since),
          lastSeen: Number(r.last_seen),
          token: r.token,
        };
        memoryStore.users.set(u.uid, u);
        memoryStore.usersByUsername.set(u.username.toLowerCase(), u.uid);
        memoryStore.usersByToken.set(u.token, u.uid);
      });

      const resFriends = await pgPool.query('SELECT * FROM friends');
      resFriends.rows.forEach((r) => {
        if (!memoryStore.friends.has(r.user_uid)) memoryStore.friends.set(r.user_uid, new Set());
        memoryStore.friends.get(r.user_uid).add(r.friend_uid);
      });

      const resReqs = await pgPool.query('SELECT * FROM friend_requests');
      resReqs.rows.forEach((r) => {
        if (!memoryStore.requests.has(r.to_uid)) memoryStore.requests.set(r.to_uid, new Set());
        memoryStore.requests.get(r.to_uid).add(r.from_uid);
      });

      console.log(`[DB-Postgres] Sincronizados ${resUsers.rows.length} usuarios desde PostgreSQL.`);
      return;
    } catch (err) {
      console.warn('⚠️ [DB] Error conectando a PostgreSQL:', err.message);
    }
  }

  // 3. Fallback: Base de datos local atómica persistente
  activeDbEngine = 'local';
  console.log('ℹ️ [DB] Base de datos en modo archivo local (JSON Store persistente).');
  console.log('💡 TIP: Para persistencia permanente en Render ante cualquier git push, agrega MONGODB_URI (MongoDB Atlas) o DATABASE_URL (PostgreSQL) en las Variables de Entorno.');
}

// Helpers de Usuario y Autenticación

export function isUserAdmin(userOrUid) {
  if (!userOrUid) return false;
  const user = typeof userOrUid === 'string' ? memoryStore.users.get(userOrUid) : userOrUid;
  if (!user) return false;
  const adminUsername = (process.env.ADMIN_USER || 'admin').toLowerCase().trim();
  if (user.username && user.username.toLowerCase() === adminUsername) return true;
  if (user.isAdmin === true || user.role === 'admin') return true;
  return false;
}

export function formatSafeUser(user) {
  if (!user) return null;
  const { passwordHash: _, ...safeUser } = user;
  const adminState = isUserAdmin(user);
  return {
    ...safeUser,
    isAdmin: adminState,
    role: adminState ? 'admin' : (user.role || 'user'),
  };
}

export function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function generateUserCode(username, seed = '') {
  let hash = 0;
  const str = (username || 'user') + seed + Date.now().toString(36);
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return `#${1000 + (hash % 9000)}`;
}

export async function hashPassword(plainText) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(plainText, salt);
}

export async function comparePassword(plainText, hash) {
  if (!hash) return false;
  return bcrypt.compare(plainText, hash);
}

// Registro de Usuario
export async function registerUser({
  username,
  password,
  nickname,
  avatar = null,
  bio = '',
  bannerImage = null,
  bannerColor = null,
  mascotStatus = null,
}) {
  const cleanUsername = String(username || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '');

  if (!cleanUsername || cleanUsername.length < 3) {
    throw new Error('El nombre de usuario debe tener al menos 3 caracteres alfanuméricos.');
  }
  if (!password || String(password).length < 5) {
    throw new Error('La contraseña debe tener al menos 5 caracteres.');
  }

  if (memoryStore.usersByUsername.has(cleanUsername)) {
    throw new Error('Ese nombre de usuario ya está registrado. Por favor elige otro o inicia sesión.');
  }

  const isFirstUser = memoryStore.users.size === 0;
  const designatedAdmin = (process.env.ADMIN_USER || 'admin').toLowerCase().trim();
  const shouldBeAdmin = isFirstUser || cleanUsername === 'admin' || cleanUsername === designatedAdmin;
  const role = shouldBeAdmin ? 'admin' : 'user';
  const isAdmin = shouldBeAdmin;

  const uid = crypto.randomBytes(8).toString('hex');
  const userCode = generateUserCode(cleanUsername, uid);
  const passwordHash = await hashPassword(String(password));
  const token = generateToken();
  const cleanNick = String(nickname || cleanUsername).trim().slice(0, 24) || cleanUsername;

  const newUser = {
    uid,
    username: cleanUsername,
    passwordHash,
    nickname: cleanNick,
    userCode,
    avatar: avatar || null,
    bannerImage: bannerImage || null,
    bannerColor: bannerColor || null,
    mascotStatus: mascotStatus || 'Elige una criatura mitológica como mascota',
    bio: String(bio || '').trim().slice(0, 200),
    color: isAdmin ? '#e11d48' : '#38bdf8',
    memberSince: Date.now(),
    lastSeen: Date.now(),
    token,
    role,
    isAdmin,
  };

  // Guardar en memoria
  memoryStore.users.set(uid, newUser);
  memoryStore.usersByUsername.set(cleanUsername, uid);
  memoryStore.usersByToken.set(token, uid);
  memoryStore.friends.set(uid, new Set());
  memoryStore.requests.set(uid, new Set());

  // Guardar en Cloud DB si aplica
  if (activeDbEngine === 'mongodb' && MongoUser) {
    try {
      await MongoUser.create({
        ...newUser,
        friends: [],
        requests: [],
      });
    } catch (e) {
      console.error('[DB-Mongo] Error guardando usuario:', e.message);
    }
  } else if (activeDbEngine === 'postgres' && pgPool) {
    try {
      await pgPool.query(
        `INSERT INTO users (uid, username, password_hash, nickname, user_code, avatar, banner_image, banner_color, mascot_status, bio, color, member_since, last_seen, token)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          newUser.uid,
          newUser.username,
          newUser.passwordHash,
          newUser.nickname,
          newUser.userCode,
          newUser.avatar,
          newUser.bannerImage,
          newUser.bannerColor,
          newUser.mascotStatus,
          newUser.bio,
          newUser.color,
          newUser.memberSince,
          newUser.lastSeen,
          newUser.token,
        ]
      );
    } catch (e) {
      console.error('[DB-Postgres] Error guardando usuario:', e.message);
    }
  }

  schedulePersist();

  return { user: formatSafeUser(newUser), token };
}

// Inicio de Sesión de Usuario
export async function authenticateUser(usernameOrObj, passwordArg) {
  const username = typeof usernameOrObj === 'object' && usernameOrObj !== null ? usernameOrObj.username : usernameOrObj;
  const password = typeof usernameOrObj === 'object' && usernameOrObj !== null ? usernameOrObj.password : passwordArg;
  const cleanUsername = String(username || '').trim().toLowerCase();
  const uid = memoryStore.usersByUsername.get(cleanUsername);

  if (!uid || !memoryStore.users.has(uid)) {
    throw new Error('Usuario no encontrado. Comprueba los datos o crea una cuenta.');
  }

    const user = memoryStore.users.get(uid);

  // Si el usuario se creó en modo legacy sin contraseña, permitir asignarle contraseña en el primer login
  if (!user.passwordHash) {
    user.passwordHash = await hashPassword(password);
    user.token = generateToken();
    memoryStore.usersByToken.set(user.token, uid);
    schedulePersist();
    return { user: formatSafeUser(user), token: user.token };
  }

  const isMatch = await comparePassword(String(password), user.passwordHash);
  if (!isMatch) {
    throw new Error('Contraseña incorrecta. Inténtalo de nuevo.');
  }

  // Refrescar o asegurar token de sesión
  if (!user.token) {
    user.token = generateToken();
    memoryStore.usersByToken.set(user.token, uid);
  }
  user.lastSeen = Date.now();

  schedulePersist();

  return { user: formatSafeUser(user), token: user.token };
}

// Búsqueda de Usuario por Token
export function getUserByToken(token) {
  if (!token) return null;
  const uid = memoryStore.usersByToken.get(token);
  if (!uid || !memoryStore.users.has(uid)) return null;
  const user = memoryStore.users.get(uid);
  return formatSafeUser(user);
}

// Búsqueda de Usuario por UID
export function getUserByUid(uid) {
  if (!uid || !memoryStore.users.has(uid)) return null;
  const user = memoryStore.users.get(uid);
  return formatSafeUser(user);
}

// Búsqueda de Usuario por Username o Tag (#0000)
export function findUsersByQuery(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const results = [];
  for (const u of memoryStore.users.values()) {
    if (
      (u.username && u.username.toLowerCase().includes(q)) ||
      (u.nickname && u.nickname.toLowerCase().includes(q)) ||
      (u.userCode && u.userCode.toLowerCase() === q)
    ) {
      results.push(formatSafeUser(u));
    }
  }
  return results.slice(0, 10);
}

// Actualización de Perfil
export async function updateUserProfile(uid, updates = {}) {
  const user = memoryStore.users.get(uid);
  if (!user) return null;

  if (updates.nickname) user.nickname = String(updates.nickname).trim().slice(0, 24);
  if (updates.bio !== undefined) user.bio = String(updates.bio).trim().slice(0, 200);
  if (updates.avatar !== undefined) user.avatar = updates.avatar;
  if (updates.bannerImage !== undefined) user.bannerImage = updates.bannerImage;
  if (updates.bannerColor !== undefined) user.bannerColor = updates.bannerColor;
  if (updates.mascotStatus !== undefined) user.mascotStatus = updates.mascotStatus;
  if (updates.color) user.color = updates.color;

  user.lastSeen = Date.now();

  if (activeDbEngine === 'mongodb' && MongoUser) {
    try {
      await MongoUser.updateOne({ uid }, { $set: user });
    } catch (e) {
      console.error('[DB-Mongo] Error actualizando perfil:', e.message);
    }
  } else if (activeDbEngine === 'postgres' && pgPool) {
    try {
      await pgPool.query(
        `UPDATE users SET nickname=$1, bio=$2, avatar=$3, banner_image=$4, banner_color=$5, mascot_status=$6, color=$7, last_seen=$8
         WHERE uid=$9`,
        [
          user.nickname,
          user.bio,
          user.avatar,
          user.bannerImage,
          user.bannerColor,
          user.mascotStatus,
          user.color,
          user.lastSeen,
          uid,
        ]
      );
    } catch (e) {
      console.error('[DB-Postgres] Error actualizando perfil:', e.message);
    }
  }

  schedulePersist();
  return formatSafeUser(user);
}

// Gestión de Amistades
export function getFriendsState(uid) {
  const friendUids = memoryStore.friends.get(uid) || new Set();
  const incomingUids = memoryStore.requests.get(uid) || new Set();

  const outgoingUids = new Set();
  for (const [targetUid, reqSet] of memoryStore.requests.entries()) {
    if (reqSet.has(uid)) outgoingUids.add(targetUid);
  }

  const mapToSafeUser = (id) => {
    const u = memoryStore.users.get(id);
    if (!u) return { uid: id, nickname: 'Usuario', userCode: '#0000', status: 'offline', isAdmin: false, role: 'user' };
    return formatSafeUser(u);
  };

  return {
    friends: Array.from(friendUids).map(mapToSafeUser),
    incoming: Array.from(incomingUids).map(mapToSafeUser),
    outgoing: Array.from(outgoingUids),
  };
}

export async function addFriendRequest(fromUid, toUid) {
  if (fromUid === toUid) return false;
  if (!memoryStore.requests.has(toUid)) memoryStore.requests.set(toUid, new Set());
  memoryStore.requests.get(toUid).add(fromUid);

  if (activeDbEngine === 'postgres' && pgPool) {
    try {
      await pgPool.query('INSERT INTO friend_requests (from_uid, to_uid) VALUES ($1, $2) ON CONFLICT DO NOTHING', [fromUid, toUid]);
    } catch {}
  }
  schedulePersist();
  return true;
}

export async function removeFriendRequest(fromUid, toUid) {
  if (memoryStore.requests.has(toUid)) {
    memoryStore.requests.get(toUid).delete(fromUid);
  }
  if (activeDbEngine === 'postgres' && pgPool) {
    try {
      await pgPool.query('DELETE FROM friend_requests WHERE from_uid=$1 AND to_uid=$2', [fromUid, toUid]);
    } catch {}
  }
  schedulePersist();
}

export async function acceptFriendship(uidA, uidB) {
  if (!memoryStore.friends.has(uidA)) memoryStore.friends.set(uidA, new Set());
  if (!memoryStore.friends.has(uidB)) memoryStore.friends.set(uidB, new Set());

  memoryStore.friends.get(uidA).add(uidB);
  memoryStore.friends.get(uidB).add(uidA);

  await removeFriendRequest(uidB, uidA);
  await removeFriendRequest(uidA, uidB);

  if (activeDbEngine === 'mongodb' && MongoUser) {
    try {
      await MongoUser.updateOne({ uid: uidA }, { $addToSet: { friends: uidB }, $pull: { requests: uidB } });
      await MongoUser.updateOne({ uid: uidB }, { $addToSet: { friends: uidA }, $pull: { requests: uidA } });
    } catch {}
  } else if (activeDbEngine === 'postgres' && pgPool) {
    try {
      await pgPool.query('INSERT INTO friends (user_uid, friend_uid) VALUES ($1, $2), ($2, $1) ON CONFLICT DO NOTHING', [uidA, uidB]);
    } catch {}
  }
  schedulePersist();
}

export async function removeFriendship(uidA, uidB) {
  if (memoryStore.friends.has(uidA)) memoryStore.friends.get(uidA).delete(uidB);
  if (memoryStore.friends.has(uidB)) memoryStore.friends.get(uidB).delete(uidA);

  if (activeDbEngine === 'mongodb' && MongoUser) {
    try {
      await MongoUser.updateOne({ uid: uidA }, { $pull: { friends: uidB } });
      await MongoUser.updateOne({ uid: uidB }, { $pull: { friends: uidA } });
    } catch {}
  } else if (activeDbEngine === 'postgres' && pgPool) {
    try {
      await pgPool.query('DELETE FROM friends WHERE (user_uid=$1 AND friend_uid=$2) OR (user_uid=$2 AND friend_uid=$1)', [uidA, uidB]);
    } catch {}
  }
  schedulePersist();
}

export function getAllMemoryStore() {
  return memoryStore;
}
