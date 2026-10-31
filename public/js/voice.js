// ========================================================
// zLowStudio Chat - Módulo de Voz y WebRTC (voice.js)
// ========================================================

export const SVG_CALL_ICONS = {
    micOn: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>',
    micOff: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>',
    deafenOn: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>',
    deafenOff: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M3.5 12.5A9 9 0 0 1 12 3a9 9 0 0 1 6.5 2.76"/><path d="M21 12.5v5.5a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z"/><path d="M3 18v-5.5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>'
};

// Sintetizador Web Audio para Efectos de Sonido Discord
export function playDiscordSound(type, getAudioCtxFn) {
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = getAudioCtxFn ? getAudioCtxFn() : new AudioCtx();
        if (!ctx) return;
        const now = ctx.currentTime;
        if (type === 'join') {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(523.25, now);
            osc.frequency.setValueAtTime(783.99, now + 0.08);
            gain.gain.setValueAtTime(0.12, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(now);
            osc.stop(now + 0.3);
        } else if (type === 'leave') {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(783.99, now);
            osc.frequency.setValueAtTime(523.25, now + 0.08);
            gain.gain.setValueAtTime(0.12, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(now);
            osc.stop(now + 0.3);
        } else if (type === 'mute') {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(440, now);
            osc.frequency.setValueAtTime(330, now + 0.06);
            gain.gain.setValueAtTime(0.08, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(now);
            osc.stop(now + 0.2);
        } else if (type === 'unmute') {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(330, now);
            osc.frequency.setValueAtTime(440, now + 0.06);
            gain.gain.setValueAtTime(0.08, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(now);
            osc.stop(now + 0.2);
        }
    } catch {}
}

// Obtener Configuración WebRTC ICE (STUN + Metered TURN)
export async function getWebRtcIceServers() {
    try {
        const resp = await fetch('/api/webrtc-config', { signal: AbortSignal.timeout(4000) });
        if (resp.ok) {
            const json = await resp.json();
            if (Array.isArray(json.iceServers) && json.iceServers.length > 0) {
                return json.iceServers;
            }
        }
    } catch (e) {
        console.warn('[WebRTC] Fallback a STUN público:', e);
    }
    return [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' }
    ];
}

// Ventanas y Pastillas Arrastrables (Draggable)
export function makeDraggable(element, handle) {
    if (!element || !handle) return;
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;

    handle.onmousedown = dragMouseDown;
    handle.ontouchstart = dragTouchStart;

    function dragMouseDown(e) {
        if (e.target.closest('button, input, a, select')) return;
        e.preventDefault();
        pos3 = e.clientX;
        pos4 = e.clientY;
        document.onmouseup = closeDragElement;
        document.onmousemove = elementDrag;
    }

    function elementDrag(e) {
        e.preventDefault();
        pos1 = pos3 - e.clientX;
        pos2 = pos4 - e.clientY;
        pos3 = e.clientX;
        pos4 = e.clientY;
        const newTop = Math.max(10, Math.min(window.innerHeight - 80, element.offsetTop - pos2));
        const newLeft = Math.max(10, Math.min(window.innerWidth - 80, element.offsetLeft - pos1));
        element.style.top = newTop + 'px';
        element.style.left = newLeft + 'px';
        element.style.transform = 'none';
        element.style.right = 'auto';
        element.style.bottom = 'auto';
    }

    function closeDragElement() {
        document.onmouseup = null;
        document.onmousemove = null;
    }

    function dragTouchStart(e) {
        if (e.target.closest('button, input, a, select')) return;
        const touch = e.touches[0];
        pos3 = touch.clientX;
        pos4 = touch.clientY;
        document.ontouchend = closeTouchDrag;
        document.ontouchmove = touchDrag;
    }

    function touchDrag(e) {
        const touch = e.touches[0];
        pos1 = pos3 - touch.clientX;
        pos2 = pos4 - touch.clientY;
        pos3 = touch.clientX;
        pos4 = touch.clientY;
        element.style.top = (element.offsetTop - pos2) + 'px';
        element.style.left = (element.offsetLeft - pos1) + 'px';
        element.style.transform = 'none';
    }

    function closeTouchDrag() {
        document.ontouchend = null;
        document.ontouchmove = null;
    }
}

// Servidor de Medios SFU Audio Engine (WebSockets)
export const SfuAudioEngine = {
    audioContext: null,
    localStream: null,
    sourceNode: null,
    processorNode: null,
    peerGains: new Map(),
    isMuted: false,
    isDeafened: false,

    init(ctx) {
        this.audioContext = ctx || new (window.AudioContext || window.webkitAudioContext)();
    },

    setLocalStream(stream, socket, channelId) {
        this.localStream = stream;
        if (!this.audioContext) this.init();
        try {
            if (this.sourceNode) {
                try { this.sourceNode.disconnect(); } catch {}
            }
            this.sourceNode = this.audioContext.createMediaStreamSource(stream);
            // Analizador ligero para detectar cuando el usuario habla
            const analyser = this.audioContext.createAnalyser();
            analyser.fftSize = 512;
            this.sourceNode.connect(analyser);
        } catch (e) {
            console.warn('[SFU Engine] Audio routing:', e);
        }
    },

    cleanup() {
        if (this.localStream) {
            this.localStream.getTracks().forEach(t => t.stop());
            this.localStream = null;
        }
        this.peerGains.clear();
    }
};
