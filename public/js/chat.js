// ========================================================
// Web Chat Global - Módulo de Mensajería y Chat (chat.js)
// ========================================================

export function formatTime(ts) {
    const d = ts ? new Date(ts) : new Date();
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

export class ChatManager {
    constructor(socket, currentUser, options = {}) {
        this.socket = socket;
        this.currentUser = currentUser;
        this.options = options;
        this.messages = new Map(); // id -> msgData
        this.replyingTo = null;
        this.currentRoom = 'general'; // 'general' | 'dm_<targetUid>'
        this.currentDmTarget = null;
        this.slowmodeTimer = null;
        this.slowmodeRemaining = 0;
        this.pinnedMessages = new Map();

        // Elementos DOM
        this.messagesContainer = document.getElementById('messages');
        this.chatInput = document.getElementById('chat-input');
        this.sendBtn = document.getElementById('send-btn');
        this.replyBar = document.getElementById('reply-preview-bar');
        this.replyText = document.getElementById('reply-preview-text');
        this.replyCancelBtn = document.getElementById('reply-cancel-btn');
        this.typingIndicator = document.getElementById('typing-indicator');

        this.initEventListeners();
        this.initSocketEvents();
    }

    setRoom(room, targetUser = null) {
        this.currentRoom = room;
        this.currentDmTarget = targetUser;
        if (this.messagesContainer) {
            this.messagesContainer.innerHTML = '';
        }
        this.cancelReply();

        if (room === 'general') {
            document.getElementById('current-channel-title').textContent = 'canal-general';
            document.getElementById('channel-hash-icon').textContent = '#';
            if (this.chatInput) this.chatInput.placeholder = 'Enviar mensaje a #canal-general';
        } else if (targetUser) {
            document.getElementById('current-channel-title').textContent = targetUser.nickname || 'Amigo';
            document.getElementById('channel-hash-icon').textContent = '@';
            if (this.chatInput) this.chatInput.placeholder = `Enviar mensaje a @${targetUser.nickname}`;
            this.socket.emit('get private history', { targetUid: targetUser.uid });
        }
    }

    initEventListeners() {
        if (this.sendBtn) {
            this.sendBtn.addEventListener('click', () => this.handleSendMessage());
        }

        if (this.chatInput) {
            this.chatInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.handleSendMessage();
                }
            });

            let typingTimeout = null;
            this.chatInput.addEventListener('input', () => {
                this.socket.emit('typing');
                if (typingTimeout) clearTimeout(typingTimeout);
                typingTimeout = setTimeout(() => {
                    this.socket.emit('stop typing');
                }, 1500);
            });
        }

        if (this.replyCancelBtn) {
            this.replyCancelBtn.addEventListener('click', () => this.cancelReply());
        }
    }

    initSocketEvents() {
        this.socket.on('chat message', (msg) => {
            if (this.currentRoom === 'general') {
                this.appendMessage(msg);
            }
        });

        this.socket.on('private message', (msg) => {
            if (this.currentRoom !== 'general' && this.currentDmTarget && 
               (msg.senderUid === this.currentDmTarget.uid || msg.targetUid === this.currentDmTarget.uid)) {
                this.appendMessage(msg);
            }
        });

        this.socket.on('private history', ({ targetUid, messages }) => {
            if (this.currentDmTarget && this.currentDmTarget.uid === targetUid) {
                if (this.messagesContainer) this.messagesContainer.innerHTML = '';
                (messages || []).forEach(m => this.appendMessage(m));
            }
        });

        this.socket.on('typing update', (names) => {
            if (!this.typingIndicator) return;
            const others = (names || []).filter(n => n !== this.currentUser?.nickname);
            if (others.length === 0) {
                this.typingIndicator.textContent = '';
                this.typingIndicator.style.display = 'none';
            } else if (others.length === 1) {
                this.typingIndicator.textContent = `${others[0]} está escribiendo...`;
                this.typingIndicator.style.display = 'block';
            } else {
                this.typingIndicator.textContent = `${others.slice(0, 2).join(', ')} y otros están escribiendo...`;
                this.typingIndicator.style.display = 'block';
            }
        });

        this.socket.on('system-message', (text) => {
            this.appendSystemMessage(text);
        });

        this.socket.on('action error', ({ message }) => {
            this.showNotification(message, 'error');
        });
    }

    handleSendMessage() {
        if (!this.chatInput) return;
        const text = this.chatInput.value.trim();
        if (!text) return;

        const payload = {
            text,
            replyTo: this.replyingTo ? {
                id: this.replyingTo.id,
                user: this.replyingTo.user,
                text: this.replyingTo.text,
                color: this.replyingTo.color,
            } : null
        };

        if (this.currentRoom === 'general') {
            this.socket.emit('chat message', payload);
        } else if (this.currentDmTarget) {
            payload.targetUid = this.currentDmTarget.uid;
            this.socket.emit('private message', payload);
        }

        this.chatInput.value = '';
        this.cancelReply();
    }

    replyTo(msg) {
        this.replyingTo = msg;
        if (this.replyBar && this.replyText) {
            this.replyBar.style.display = 'flex';
            this.replyText.textContent = `Respondiendo a ${msg.user}: "${(msg.text || '').slice(0, 40)}..."`;
        }
        if (this.chatInput) this.chatInput.focus();
    }

    cancelReply() {
        this.replyingTo = null;
        if (this.replyBar) {
            this.replyBar.style.display = 'none';
        }
    }

    appendSystemMessage(text) {
        if (!this.messagesContainer) return;
        const div = document.createElement('div');
        div.className = 'chat-system-message';
        div.innerHTML = `<span>⚡</span> <span>${escapeHtml(text)}</span>`;
        this.messagesContainer.appendChild(div);
        this.scrollToBottom();
    }

    appendMessage(msg) {
        if (!this.messagesContainer || !msg) return;
        this.messages.set(msg.id, msg);

        const isMe = msg.senderUid === this.currentUser?.uid;
        const msgEl = document.createElement('div');
        msgEl.className = `message-item ${isMe ? 'message-own' : ''}`;
        msgEl.id = `msg-${msg.id}`;

        const avatarMarkup = msg.avatar
            ? `<img src="${escapeHtml(msg.avatar)}" class="msg-avatar-img" alt="${escapeHtml(msg.user)}">`
            : `<div class="msg-avatar-placeholder" style="background:${escapeHtml(msg.color || '#5865f2')}">${(msg.user || 'U')[0].toUpperCase()}</div>`;

        let replyMarkup = '';
        if (msg.replyTo) {
            replyMarkup = `
                <div class="msg-reply-quote" onclick="document.getElementById('msg-${escapeHtml(msg.replyTo.id)}')?.scrollIntoView({ behavior: 'smooth', block: 'center' })">
                    <span class="reply-arrow">↳</span>
                    <span class="reply-user" style="color: ${escapeHtml(msg.replyTo.color || '#faa61a')}">@${escapeHtml(msg.replyTo.user)}</span>
                    <span class="reply-snippet">${escapeHtml(msg.replyTo.text || '')}</span>
                </div>
            `;
        }

        let mediaMarkup = '';
        if (msg.image) {
            mediaMarkup += `
                <div class="msg-image-wrap">
                    <img src="${escapeHtml(msg.image)}" class="msg-attached-image" alt="Imagen adjunta" onclick="window.openImageViewer?.('${escapeHtml(msg.image)}')">
                </div>
            `;
        }

        if (msg.audio) {
            mediaMarkup += `
                <div class="msg-audio-wrap">
                    <audio controls src="${escapeHtml(msg.audio)}" class="msg-audio-player"></audio>
                </div>
            `;
        }

        // Formato de menciones y enlaces
        let formattedText = escapeHtml(msg.text || '');
        formattedText = formattedText.replace(/@([a-zA-Z0-9_\-\.]+)/g, '<span class="mention-tag">@$1</span>');

        msgEl.innerHTML = `
            ${replyMarkup}
            <div class="msg-content-row">
                <div class="msg-avatar-box" data-uid="${escapeHtml(msg.senderUid)}">
                    ${avatarMarkup}
                </div>
                <div class="msg-body">
                    <div class="msg-header">
                        <span class="msg-username clickable-user" data-uid="${escapeHtml(msg.senderUid)}" style="color: ${escapeHtml(msg.color || '#fff')}">${escapeHtml(msg.user || 'Usuario')}</span>
                        <span class="msg-usercode">${escapeHtml(msg.senderUserCode || '')}</span>
                        <span class="msg-timestamp">${escapeHtml(msg.time || formatTime())}</span>
                    </div>
                    <div class="msg-text">${formattedText}</div>
                    ${mediaMarkup}
                </div>
                <div class="msg-actions-hover">
                    <button type="button" class="msg-action-btn reply-btn" title="Responder">💬</button>
                    <button type="button" class="msg-action-btn react-btn" title="Reaccionar">😀</button>
                    <button type="button" class="msg-action-btn pin-btn" title="Fijar">📌</button>
                </div>
            </div>
        `;

        // Acciones
        const replyBtn = msgEl.querySelector('.reply-btn');
        if (replyBtn) replyBtn.addEventListener('click', () => this.replyTo(msg));

        // Click en perfil
        const userTriggers = msgEl.querySelectorAll('.clickable-user, .msg-avatar-box');
        userTriggers.forEach(el => {
            el.addEventListener('click', () => {
                if (this.options.onOpenProfile && msg.senderUid) {
                    this.options.onOpenProfile(msg.senderUid, {
                        nickname: msg.user,
                        avatar: msg.avatar,
                        color: msg.color,
                        userCode: msg.senderUserCode,
                    });
                }
            });
        });

        this.messagesContainer.appendChild(msgEl);
        this.scrollToBottom();
    }

    scrollToBottom() {
        if (!this.messagesContainer) return;
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    }

    showNotification(text, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `discord-toast toast-${type}`;
        toast.textContent = text;
        document.body.appendChild(toast);
        setTimeout(() => toast.classList.add('visible'), 20);
        setTimeout(() => {
            toast.classList.remove('visible');
            setTimeout(() => toast.remove(), 300);
        }, 3500);
    }
}
