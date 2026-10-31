// ========================================================
// zLowStudio Chat - Entrada Principal del Cliente (main.js)
// ========================================================

import { getAuthToken, fetchCurrentUser, clearSession, requireAuth } from '/js/auth.js';
import { ChatManager, escapeHtml } from '/js/chat.js';
import { playDiscordSound, SVG_CALL_ICONS, makeDraggable, getWebRtcIceServers, SfuAudioEngine } from '/js/voice.js';

let currentUser = null;
let socket = null;
let chatManager = null;
let currentVoiceChannel = null;
let localMediaStream = null;
let isMicMuted = false;
let isDeafened = false;

// Estado global de amigos y usuarios conectados
let onlineUsersMap = new Map(); // uid -> userData
let friendsState = { friends: [], incoming: [], outgoing: [] };

async function bootstrap() {
    currentUser = await requireAuth();
    if (!currentUser) return;

    setupUserInfoBar();
    setupTopControls();
    setupSocketConnection();
    setupFriendsHub();
    setupVoiceChannels();
    setupMiniProfile();
    setupProfileModal();
}

// Configurar barra inferior de estado del usuario
function setupUserInfoBar() {
    const nameEl = document.getElementById('user-status-name');
    const tagEl = document.getElementById('user-status-tag');
    const avatarEl = document.getElementById('user-status-avatar');
    const avatarImg = document.getElementById('user-status-avatar-img');
    const avatarLetter = document.getElementById('user-status-avatar-letter');

    if (nameEl) nameEl.textContent = currentUser.nickname || currentUser.username || 'Usuario';
    if (tagEl) tagEl.textContent = currentUser.userCode || '#0000';

    if (currentUser.avatar && avatarImg) {
        avatarImg.src = currentUser.avatar;
        avatarImg.style.display = 'block';
        if (avatarLetter) avatarLetter.style.display = 'none';
    } else if (avatarLetter) {
        avatarLetter.textContent = (currentUser.nickname || 'U')[0].toUpperCase();
        avatarLetter.style.display = 'flex';
        if (avatarImg) avatarImg.style.display = 'none';
    }

    // Botón de silenciar micrófono
    const micBtn = document.getElementById('btn-toggle-mic');
    if (micBtn) {
        micBtn.innerHTML = SVG_CALL_ICONS.micOn;
        micBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            isMicMuted = !isMicMuted;
            micBtn.innerHTML = isMicMuted ? SVG_CALL_ICONS.micOff : SVG_CALL_ICONS.micOn;
            micBtn.classList.toggle('muted', isMicMuted);
            playDiscordSound(isMicMuted ? 'mute' : 'unmute');
            if (localMediaStream) {
                localMediaStream.getAudioTracks().forEach(t => t.enabled = !isMicMuted);
            }
            if (currentVoiceChannel && socket) {
                socket.emit('voice-channel:toggle-mute', { channelId: currentVoiceChannel, isMuted });
            }
        });
    }

    // Botón ensordecer
    const deafenBtn = document.getElementById('btn-toggle-deafen');
    if (deafenBtn) {
        deafenBtn.innerHTML = SVG_CALL_ICONS.deafenOn;
        deafenBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            isDeafened = !isDeafened;
            deafenBtn.innerHTML = isDeafened ? SVG_CALL_ICONS.deafenOff : SVG_CALL_ICONS.deafenOn;
            deafenBtn.classList.toggle('muted', isDeafened);
            playDiscordSound(isDeafened ? 'mute' : 'unmute');
        });
    }

    // Botón de ajustes (abre modal de perfil)
    const settingsBtn = document.getElementById('btn-settings');
    if (settingsBtn) {
        settingsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openEditProfileModal();
        });
    }

    // Clic en la barra o nombre abre el mini perfil popout
    const userBar = document.getElementById('current-user-status-bar');
    if (userBar) {
        userBar.addEventListener('click', () => {
            openMiniProfile(currentUser.uid, currentUser);
        });
    }
}

// Controles superiores (Admin y Cerrar Sesión)
function setupTopControls() {
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.style.display = 'inline-flex';
        logoutBtn.addEventListener('click', () => {
            if (confirm('¿Deseas cerrar tu sesión?')) {
                clearSession();
            }
        });
    }

    const adminTrigger = document.getElementById('admin-trigger');
    const adminModal = document.getElementById('admin-modal');
    const adminPassInput = document.getElementById('admin-pass-input');
    const adminLoginBtn = document.getElementById('admin-login-btn');
    const adminCloseBtn = document.getElementById('admin-close-btn');

    if (adminTrigger && adminModal) {
        adminTrigger.addEventListener('click', () => {
            adminModal.style.display = 'flex';
            if (adminPassInput) {
                adminPassInput.value = '';
                adminPassInput.focus();
            }
        });
    }

    if (adminCloseBtn && adminModal) {
        adminCloseBtn.addEventListener('click', () => {
            adminModal.style.display = 'none';
        });
    }

    if (adminLoginBtn && adminPassInput && socket) {
        adminLoginBtn.addEventListener('click', () => {
            const pass = adminPassInput.value;
            if (pass) {
                socket.emit('admin auth', { password: pass });
            }
        });
    }
}

// Conexión Socket.IO
function setupSocketConnection() {
    const token = getAuthToken();
    socket = io({
        auth: { token },
        transports: ['websocket', 'polling']
    });

    socket.on('connect', () => {
        socket.emit('join', {
            token,
            nickname: currentUser.nickname,
            avatar: currentUser.avatar,
            bio: currentUser.bio,
            bannerImage: currentUser.bannerImage,
            bannerColor: currentUser.bannerColor,
            memberSince: currentUser.memberSince,
        });
    });

    socket.on('session', (sessionData) => {
        if (sessionData && sessionData.userCode) {
            currentUser.userCode = sessionData.userCode;
            const tagEl = document.getElementById('user-status-tag');
            if (tagEl) tagEl.textContent = sessionData.userCode;
        }
    });

    socket.on('update-users', (usersList) => {
        onlineUsersMap.clear();
        const usersArray = Object.values(usersList || {});
        usersArray.forEach(u => onlineUsersMap.set(u.uid, u));

        renderOnlineUsersSidebar(usersArray);
        renderFriendsHub();
        renderActiveNow(usersArray);
    });

    socket.on('friends state', (state) => {
        friendsState = state || { friends: [], incoming: [], outgoing: [] };
        renderFriendsHub();
    });

    socket.on('voice-channels:state', ({ channels }) => {
        renderVoiceChannels(channels);
    });

    socket.on('banned', ({ reason }) => {
        alert(`Has sido baneado del servidor.\nMotivo: ${reason}`);
        clearSession();
    });

    socket.on('duplicate-session', ({ message }) => {
        alert(message || 'Se ha detectado otra sesión abierta con tu cuenta.');
        clearSession();
    });

    socket.on('admin auth result', (res) => {
        if (res.success) {
            const adminModal = document.getElementById('admin-modal');
            const dashModal = document.getElementById('admin-dashboard-modal');
            if (adminModal) adminModal.style.display = 'none';
            if (dashModal) dashModal.style.display = 'flex';
        } else {
            alert(res.message || 'Contraseña incorrecta');
        }
    });

    // Iniciar el gestor de chat
    chatManager = new ChatManager(socket, currentUser, {
        onOpenProfile: (uid, userFallback) => openMiniProfile(uid, userFallback)
    });
}

// Renderizar lista lateral de usuarios conectados
function renderOnlineUsersSidebar(usersList) {
    const usersListEl = document.getElementById('users-list');
    const userCountEl = document.getElementById('user-count');
    if (!usersListEl) return;

    usersListEl.innerHTML = '';
    if (userCountEl) userCountEl.textContent = usersList.length;

    usersList.forEach(u => {
        const li = document.createElement('li');
        li.className = 'user-item';

        const avatarMarkup = u.avatar
            ? `<img src="${escapeHtml(u.avatar)}" class="user-avatar-small" alt="${escapeHtml(u.nickname)}">`
            : `<div class="user-avatar-small placeholder" style="background:${escapeHtml(u.color || '#5865f2')}">${(u.nickname || 'U')[0].toUpperCase()}</div>`;

        let activityBadge = '';
        if (u.currentVoiceChannelName) {
            activityBadge = `<span class="user-sidebar-voice-activity">🔊 En ${escapeHtml(u.currentVoiceChannelName)}</span>`;
        } else if (u.activity) {
            activityBadge = `<span class="user-sidebar-custom-activity">${escapeHtml(u.activity)}</span>`;
        }

        li.innerHTML = `
            <div class="user-avatar-wrap">
                ${avatarMarkup}
                <span class="user-status-dot status-${escapeHtml(u.status || 'online')}"></span>
            </div>
            <div class="user-details">
                <span class="user-nickname" style="color:${escapeHtml(u.color || '#fff')}">${escapeHtml(u.nickname)}</span>
                ${activityBadge}
            </div>
        `;

        li.addEventListener('click', () => openMiniProfile(u.uid, u));
        usersListEl.appendChild(li);
    });
}

// Renderizar panel "Activo ahora"
function renderActiveNow(usersList) {
    const container = document.getElementById('active-now-cards-container');
    if (!container) return;

    const activeUsers = usersList.filter(u => u.uid !== currentUser.uid && (u.currentVoiceChannelName || u.activity));
    if (activeUsers.length === 0) {
        container.innerHTML = `
            <div style="padding: 24px 16px; text-align: center; color: var(--text-sub); font-size: 0.85rem;">
                <p>Por ahora todo está tranquilo...</p>
                <span style="font-size: 0.75rem;">Cuando tus amigos estén jugando o hablando en salas de voz, aparecerán aquí.</span>
            </div>
        `;
        return;
    }

    container.innerHTML = '';
    activeUsers.forEach(u => {
        const card = document.createElement('div');
        card.className = 'active-now-card';
        card.innerHTML = `
            <div class="active-card-top">
                <div class="user-avatar-wrap">
                    ${u.avatar ? `<img src="${escapeHtml(u.avatar)}" class="user-avatar-small">` : `<div class="user-avatar-small placeholder">${(u.nickname || 'U')[0]}</div>`}
                    <span class="user-status-dot status-online"></span>
                </div>
                <div style="flex: 1; min-width: 0;">
                    <div style="font-weight: 700; font-size: 0.9rem; color: #fff;">${escapeHtml(u.nickname)}</div>
                    <div style="font-size: 0.75rem; color: #57f287;">${u.currentVoiceChannelName ? `En ${escapeHtml(u.currentVoiceChannelName)}` : escapeHtml(u.activity)}</div>
                </div>
            </div>
        `;
        card.addEventListener('click', () => openMiniProfile(u.uid, u));
        container.appendChild(card);
    });
}

// Centro de amigos (Friends Hub)
function setupFriendsHub() {
    const dmBtn = document.getElementById('sidebar-dm-btn');
    const generalChannel = document.getElementById('channel-item-general');
    const friendsHubView = document.getElementById('friends-hub-view');
    const chatPanel = document.getElementById('chat-panel');
    const sidebar = document.getElementById('sidebar');

    if (dmBtn) {
        dmBtn.addEventListener('click', () => {
            dmBtn.classList.add('active');
            if (generalChannel) generalChannel.classList.remove('active');
            if (friendsHubView) friendsHubView.style.display = 'flex';
            if (chatPanel) chatPanel.style.display = 'none';
            if (sidebar) sidebar.style.display = 'none';
        });
    }

    if (generalChannel) {
        generalChannel.addEventListener('click', () => {
            generalChannel.classList.add('active');
            if (dmBtn) dmBtn.classList.remove('active');
            if (friendsHubView) friendsHubView.style.display = 'none';
            if (chatPanel) chatPanel.style.display = 'flex';
            if (sidebar) sidebar.style.display = 'flex';
            if (chatManager) chatManager.setRoom('general');
        });
    }

    // Pestañas del Hub (En línea, Todos, etc.)
    const tabOnline = document.getElementById('hub-tab-online');
    if (tabOnline) {
        tabOnline.addEventListener('click', () => {
            tabOnline.classList.add('active');
        });
    }

    // Píldoras en nube deshabilitadas (Aviso emergente tipo tooltip)
    const disabledPills = document.querySelectorAll('.cloud-disabled-pill');
    disabledPills.forEach(pill => {
        pill.addEventListener('click', (e) => {
            e.preventDefault();
            alert('☁️ Esta función está en mantenimiento temporal en la nube.');
        });
    });
}

function renderFriendsHub() {
    const listEl = document.getElementById('hub-friends-list');
    const countBadge = document.getElementById('hub-badge-online');
    const counterText = document.getElementById('hub-section-counter');
    if (!listEl) return;

    const friends = friendsState.friends || [];
    const onlineFriends = friends.filter(f => onlineUsersMap.has(f.uid));

    if (countBadge) countBadge.textContent = onlineFriends.length;
    if (counterText) counterText.textContent = `EN LÍNEA — ${onlineFriends.length}`;

    if (onlineFriends.length === 0) {
        listEl.innerHTML = `
            <div style="padding: 40px 20px; text-align: center; color: var(--text-sub);">
                <div style="font-size: 2.5rem; margin-bottom: 10px;">👥</div>
                <p>Nadie está conectado ahora mismo.</p>
            </div>
        `;
        return;
    }

    listEl.innerHTML = '';
    onlineFriends.forEach(f => {
        const item = document.createElement('div');
        item.className = 'hub-friend-item';
        item.innerHTML = `
            <div class="user-avatar-wrap">
                ${f.avatar ? `<img src="${escapeHtml(f.avatar)}" class="user-avatar-small">` : `<div class="user-avatar-small placeholder">${(f.nickname || 'U')[0]}</div>`}
                <span class="user-status-dot status-online"></span>
            </div>
            <div class="hub-friend-info">
                <span class="hub-friend-name">${escapeHtml(f.nickname)}</span>
                <span class="hub-friend-tag">${escapeHtml(f.userCode || '#0000')}</span>
            </div>
            <div class="hub-friend-actions">
                <button type="button" class="hub-btn-action open-dm-btn" title="Mensaje Directo">💬</button>
                <button type="button" class="hub-btn-action call-btn" title="Iniciar Llamada">📞</button>
            </div>
        `;

        item.querySelector('.open-dm-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            openDirectMessage(f);
        });

        item.addEventListener('click', () => openMiniProfile(f.uid, f));
        listEl.appendChild(item);
    });
}

function openDirectMessage(targetUser) {
    const friendsHubView = document.getElementById('friends-hub-view');
    const chatPanel = document.getElementById('chat-panel');
    const sidebar = document.getElementById('sidebar');

    if (friendsHubView) friendsHubView.style.display = 'none';
    if (chatPanel) chatPanel.style.display = 'flex';
    if (sidebar) sidebar.style.display = 'flex';

    if (chatManager) {
        chatManager.setRoom(`dm_${targetUser.uid}`, targetUser);
    }
}

// Canales de Voz Discord (3 Salas Compactas)
function setupVoiceChannels() {
    const voiceChannels = ['voice-1', 'voice-2', 'voice-3'];
    voiceChannels.forEach(chId => {
        const el = document.getElementById(`voice-ch-${chId}`);
        if (el) {
            el.addEventListener('click', () => {
                if (currentVoiceChannel === chId) {
                    leaveVoiceChannel();
                } else {
                    joinVoiceChannel(chId);
                }
            });
        }
    });
}

async function joinVoiceChannel(channelId) {
    if (currentVoiceChannel) {
        leaveVoiceChannel();
    }
    currentVoiceChannel = channelId;
    playDiscordSound('join');

    try {
        localMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        if (socket) {
            socket.emit('group-voice:join', { channelId });
        }
    } catch (err) {
        console.warn('[Voice] No se pudo acceder al micrófono:', err);
        if (socket) {
            socket.emit('group-voice:join', { channelId });
        }
    }
}

function leaveVoiceChannel() {
    if (!currentVoiceChannel) return;
    playDiscordSound('leave');
    if (socket) {
        socket.emit('group-voice:leave', { channelId: currentVoiceChannel });
    }
    if (localMediaStream) {
        localMediaStream.getTracks().forEach(t => t.stop());
        localMediaStream = null;
    }
    currentVoiceChannel = null;
}

function renderVoiceChannels(channels) {
    if (!channels) return;
    Object.values(channels).forEach(ch => {
        const chEl = document.getElementById(`voice-ch-${ch.id}`);
        if (!chEl) return;

        const countEl = chEl.querySelector('.voice-ch-count');
        if (countEl) countEl.textContent = `${ch.participants.length}/${ch.max || 10}`;

        const isHere = currentVoiceChannel === ch.id;
        chEl.classList.toggle('active', isHere);

        // Actualizar lista de participantes
        let listContainer = chEl.nextElementSibling;
        if (!listContainer || !listContainer.classList.contains('voice-participants-list')) {
            listContainer = document.createElement('div');
            listContainer.className = 'voice-participants-list';
            chEl.after(listContainer);
        }

        listContainer.innerHTML = '';
        ch.participants.forEach(p => {
            const pItem = document.createElement('div');
            pItem.className = 'voice-participant-item';
            pItem.innerHTML = `
                <div class="voice-p-avatar-wrap ${p.isSpeaking ? 'speaking-ring' : ''}">
                    ${p.avatar ? `<img src="${escapeHtml(p.avatar)}" class="voice-p-avatar">` : `<div class="voice-p-avatar placeholder">${(p.name || 'U')[0]}</div>`}
                </div>
                <span class="voice-p-name">${escapeHtml(p.name)}</span>
            `;
            listContainer.appendChild(pItem);
        });
    });
}

// Mini Perfil Popout (Con Banner, Lápiz, Selector de Estado y Mascota Mitológica)
function setupMiniProfile() {
    const popout = document.getElementById('mini-profile-popout');
    const closeBtn = document.getElementById('close-mini-profile-btn');
    if (closeBtn && popout) {
        closeBtn.addEventListener('click', () => popout.style.display = 'none');
    }

    // Selector de estado interactivo
    const statusRow = document.getElementById('mini-profile-status-row');
    const statusPicker = document.getElementById('mini-profile-status-picker');
    if (statusRow && statusPicker) {
        statusRow.addEventListener('click', (e) => {
            e.stopPropagation();
            statusPicker.style.display = statusPicker.style.display === 'none' ? 'block' : 'none';
        });

        statusPicker.querySelectorAll('.status-opt-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const st = btn.dataset.status;
                if (socket) socket.emit('change status', st);
                statusPicker.style.display = 'none';
            });
        });
    }

    // Selector de criatura mitológica
    const petBtn = document.getElementById('mini-profile-pet-btn');
    if (petBtn) {
        petBtn.addEventListener('click', () => {
            const pets = ['🐉 Dragón Celestial', '🦅 Fénix de Fuego', '🐺 Lobo Lunar', '🦁 Grifo Real', '🐍 Basilisco Oscuro'];
            const chosen = prompt(`Elige tu mascota mitológica:\n\n${pets.map((p, i) => `${i + 1}. ${p}`).join('\n')}`);
            const idx = parseInt(chosen, 10) - 1;
            if (pets[idx]) {
                currentUser.mascotStatus = pets[idx];
                petBtn.textContent = `🐾 ${pets[idx]}`;
                if (socket) socket.emit('update profile', { mascotStatus: pets[idx] });
            }
        });
    }

    // Lápiz de cambio de banner
    const bannerPencil = document.getElementById('mini-profile-banner-pencil');
    if (bannerPencil) {
        bannerPencil.addEventListener('click', (e) => {
            e.stopPropagation();
            const action = prompt('¿Qué deseas hacer con el banner?\n1. Elegir color hexadecimal (ej: #5865f2)\n2. Subir imagen (URL o archivo en edición)');
            if (action === '1') {
                const col = prompt('Ingresa el código hexadecimal del banner (ej: #ff0055 o #0284c7):');
                if (col && /^#[0-9a-fA-F]{6}$/.test(col)) {
                    currentUser.bannerColor = col;
                    const bannerEl = document.getElementById('mini-profile-banner');
                    if (bannerEl) bannerEl.style.backgroundColor = col;
                    if (socket) socket.emit('update profile', { bannerColor: col });
                }
            } else if (action === '2') {
                openEditProfileModal();
            }
        });
    }
}

function openMiniProfile(uid, userFallback) {
    const popout = document.getElementById('mini-profile-popout');
    if (!popout) return;

    const u = onlineUsersMap.get(uid) || userFallback || currentUser;
    const isMe = uid === currentUser.uid;

    const nameEl = document.getElementById('mini-profile-name');
    const userCodeEl = document.getElementById('mini-profile-usercode');
    const bioEl = document.getElementById('mini-profile-bio');
    const bannerEl = document.getElementById('mini-profile-banner');
    const avatarEl = document.getElementById('mini-profile-avatar-container');
    const pencilEl = document.getElementById('mini-profile-banner-pencil');
    const statusRow = document.getElementById('mini-profile-status-row');
    const petBtn = document.getElementById('mini-profile-pet-btn');

    if (nameEl) nameEl.textContent = u.nickname || u.username || 'Usuario';
    if (userCodeEl) userCodeEl.textContent = u.userCode || '#0000';
    if (bioEl) bioEl.textContent = u.bio || 'Sin descripción todavía.';

    if (bannerEl) {
        if (u.bannerImage) {
            bannerEl.style.backgroundImage = `url(${u.bannerImage})`;
            bannerEl.style.backgroundColor = 'transparent';
        } else if (u.bannerColor) {
            bannerEl.style.backgroundImage = 'none';
            bannerEl.style.backgroundColor = u.bannerColor;
        } else {
            bannerEl.style.backgroundImage = 'none';
            bannerEl.style.backgroundColor = '#5865f2';
        }
    }

    if (avatarEl) {
        avatarEl.innerHTML = u.avatar
            ? `<img src="${escapeHtml(u.avatar)}" class="mini-profile-avatar-img">`
            : `<div class="mini-profile-avatar-placeholder" style="background:${escapeHtml(u.color || '#5865f2')}">${(u.nickname || 'U')[0].toUpperCase()}</div>`;
    }

    if (pencilEl) pencilEl.style.display = isMe ? 'flex' : 'none';
    if (statusRow) statusRow.style.cursor = isMe ? 'pointer' : 'default';
    if (petBtn) petBtn.textContent = u.mascotStatus ? `🐾 ${u.mascotStatus}` : (isMe ? '➕ Elige una criatura mitológica' : 'Sin mascota asignada');

    popout.style.display = 'block';
}

// Modal de edición de perfil completo
function setupProfileModal() {
    const modal = document.getElementById('profile-modal');
    const closeBtn = document.getElementById('close-profile-btn');
    const saveBtn = document.getElementById('save-profile-btn');
    const nickInput = document.getElementById('profile-nickname');
    const bioInput = document.getElementById('profile-bio');
    const bannerColorInput = document.getElementById('profile-banner-color');

    if (closeBtn && modal) {
        closeBtn.addEventListener('click', () => modal.style.display = 'none');
    }

    if (saveBtn && modal) {
        saveBtn.addEventListener('click', async () => {
            const nickname = nickInput.value.trim();
            const bio = bioInput.value.trim();
            const bannerColor = bannerColorInput.value;

            const payload = {
                nickname: nickname || currentUser.nickname,
                bio,
                bannerColor
            };

            currentUser = { ...currentUser, ...payload };
            setupUserInfoBar();
            if (socket) socket.emit('update profile', payload);
            modal.style.display = 'none';
        });
    }
}

function openEditProfileModal() {
    const modal = document.getElementById('profile-modal');
    const nickInput = document.getElementById('profile-nickname');
    const bioInput = document.getElementById('profile-bio');
    const bannerColorInput = document.getElementById('profile-banner-color');

    if (nickInput) nickInput.value = currentUser.nickname || '';
    if (bioInput) bioInput.value = currentUser.bio || '';
    if (bannerColorInput) bannerColorInput.value = currentUser.bannerColor || '#5865f2';
    if (modal) modal.style.display = 'flex';
}

// Iniciar aplicación al cargar el DOM
window.addEventListener('DOMContentLoaded', bootstrap);
