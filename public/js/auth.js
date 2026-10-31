// ========================================================
// Web Chat Global - Autenticación y Gestión de Sesión
// ========================================================

const AUTH_TOKEN_KEY = 'chat_auth_token';
const AUTH_USER_KEY = 'chat_auth_user';

export function getAuthToken() {
    return localStorage.getItem(AUTH_TOKEN_KEY) || null;
}

export function getCachedUser() {
    try {
        const u = localStorage.getItem(AUTH_USER_KEY);
        return u ? JSON.parse(u) : null;
    } catch {
        return null;
    }
}

export function setSession(token, user) {
    if (token) localStorage.setItem(AUTH_TOKEN_KEY, token);
    if (user) {
        localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
        localStorage.setItem('chat_nickname', user.nickname || user.username || '');
        if (user.avatar) localStorage.setItem('chat_avatar', user.avatar);
        else localStorage.removeItem('chat_avatar');
        if (user.bio) localStorage.setItem('chat_bio', user.bio);
        if (user.bannerImage) localStorage.setItem('chat_banner_image', user.bannerImage);
        if (user.bannerColor) localStorage.setItem('chat_banner_color', user.bannerColor);
        if (user.mascotStatus) localStorage.setItem('chat_mascot_status', user.mascotStatus);
        if (user.memberSince) localStorage.setItem('chat_member_since', String(user.memberSince));
        localStorage.setItem('chat_token', token);
    }
}

export function clearSession() {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_USER_KEY);
    localStorage.removeItem('chat_token');
    localStorage.removeItem('chat_nickname');
    window.location.href = '/login.html';
}

export async function fetchCurrentUser() {
    const token = getAuthToken();
    if (!token) return null;

    try {
        const res = await fetch('/api/auth/me', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) {
            localStorage.removeItem(AUTH_TOKEN_KEY);
            return null;
        }
        const data = await res.json();
        if (data && data.user) {
            setSession(token, data.user);
            return data.user;
        }
        return null;
    } catch (err) {
        console.warn('[Auth] Error validando sesión:', err);
        return getCachedUser();
    }
}

export async function login(username, password) {
    const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) {
        throw new Error(data.error || 'Error al iniciar sesión.');
    }
    setSession(data.token, data.user);
    return data;
}

export async function register(userData) {
    const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(userData)
    });
    const data = await res.json();
    if (!res.ok) {
        throw new Error(data.error || 'Error al registrar cuenta.');
    }
    setSession(data.token, data.user);
    return data;
}

// Guardia de Navegación
export async function requireAuth() {
    const token = getAuthToken();
    if (!token) {
        window.location.replace('/login.html');
        return null;
    }
    const user = await fetchCurrentUser();
    if (!user) {
        window.location.replace('/login.html');
        return null;
    }
    return user;
}

export function redirectIfAuthenticated() {
    const token = getAuthToken();
    if (token) {
        window.location.replace('/main.html');
    }
}
