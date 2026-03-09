import Hls from 'hls.js';
import { DEBUG, CONFIG } from './config.js';
import { state, DOM, DEBUG_STATE } from './store.js';

// --- ОПРЕДЕЛЕНИЕ УСТРОЙСТВ И ПОДДЕРЖКИ ---
export const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const supportsHlsJs = () => !!(Hls && typeof Hls.isSupported === 'function' && Hls.isSupported());
export const supportsMediaSession = 'mediaSession' in navigator;
export const supportsMediaMetadata = typeof window.MediaMetadata === 'function';

// --- ДЕБАГГЕР ---
export function debugSnapshot() {
    return {
        hidden: document.hidden,
        paused: DOM.audio.paused,
        ct: Number(DOM.audio.currentTime || 0).toFixed(2),
        isPlaying: state.isPlaying,
        isBusy: state.isBusy,
        track: state.currentDisplayedTrack,
        serverClockOffsetMs: state.serverClockOffsetMs
    };
}

export function debugLine(msg, data) {
    if (!DEBUG) return;
    const ts = new Date().toISOString().split('T')[1].replace('Z', '');
    const payload = data ? ` ${JSON.stringify(data)}` : '';
    const line = `${ts} ${msg}${payload}`;
    DEBUG_STATE.lines.push(line);
    if (DEBUG_STATE.lines.length > DEBUG_STATE.max) DEBUG_STATE.lines.shift();
    if (DEBUG_STATE.panel) DEBUG_STATE.panel.textContent = DEBUG_STATE.lines.join('\n');
    try { console.log('[DBG]', line); } catch (e) {}
}

export function initDebugPanel() {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;max-height:35vh;overflow:auto;background:rgba(0,0,0,0.75);color:#9efb9e;font:11px/1.3 ui-monospace, monospace;padding:8px;border-radius:8px;z-index:99999;white-space:pre-wrap;word-break:break-word';
    const title = document.createElement('div');
    title.textContent = 'DEBUG LOG';
    title.style.cssText = 'font-weight:700;margin-bottom:4px;color:#b7ffb7';
    const pre = document.createElement('div');
    wrap.appendChild(title);
    wrap.appendChild(pre);
    document.body.appendChild(wrap);
    DEBUG_STATE.panel = pre;
    debugLine('debug enabled', { ua: navigator.userAgent, ios: isIOS });
}

// --- ОЧИСТКА И ПАРСИНГ СТРОК ---
const _decodeTextArea = document.createElement("textarea");

export function cleanString(str) {
    if (!str) return "";
    _decodeTextArea.innerHTML = str;
    let text = _decodeTextArea.value;
    text = text.replace(/[‘’`´\x91\x92]/g, "'");
    text = text.replace(/[“”«»\x93\x94]/g, '"');
    text = text.replace(/\x96/g, "-");
    text = text.replace(/\x97/g, "—");
    text = text.replace(/([a-zA-Zа-яА-ЯёЁ])[\x00-\x1F\x7F-\x9F\uFFFD\u200B-\u200D\uFEFF]+([a-zA-Zа-яА-ЯёЁ])/g, "$1'$2");
    text = text.replace(/[\x00-\x1F\x7F-\x9F\uFFFD\u200B-\u200D\uFEFF]/g, "");
    text = text.replace(/^['"]+|['"]+$/g, '');
    return text.replace(/\s+/g, ' ').trim();
}

export const GENERIC_TRACK_TITLES = new Set(["", "radio local farts", "радио локал фартс", "local farts", "unknown", "unknown track"]);

export function coerceTrackText(value) {
    if (!value) return "";
    if (typeof value === "string" || typeof value === "number") return String(value);
    const directKeys = ["text", "title", "song", "track", "rawString", "name", "full_title", "now_playing"];
    for (const key of directKeys) {
        if (typeof value[key] === "string" || typeof value[key] === "number") return String(value[key]);
    }
    const artist = value.artist ? String(value.artist).trim() : "";
    const title = value.title ? String(value.title).trim() : "";
    if (artist && title) return `${artist} - ${title}`;
    return "";
}

export function normalizeTrackTitle(value) {
    return cleanString(coerceTrackText(value)).replace(/\s+/g, " ").trim();
}

export function isGenericTrackTitle(value) {
    const low = normalizeTrackTitle(value).toLowerCase();
    return !low || GENERIC_TRACK_TITLES.has(low) || low === "-" || low === "--";
}

// --- ФУНКЦИИ ВРЕМЕНИ И СИНХРОНИЗАЦИИ ---
export function getAlignedNowMs() {
    return Date.now() + state.serverClockOffsetMs;
}

export function getMetaDelayMs() {
    if (state.hls && typeof state.hls.latency === "number" && 
        Number.isFinite(state.hls.latency) && state.hls.latency > 0) {
        const cappedLatency = Math.min(state.hls.latency, 26) * 1000; // кэп 26 сек
        const withSafety = cappedLatency + CONFIG.metaSafetyMs + (state.userSyncOffsetMs || 0);
        return Math.max(CONFIG.metaMinDelayMs, Math.min(CONFIG.metaMaxDelayMs, withSafety));
    }
    const withSafety = CONFIG.delayMs + CONFIG.metaSafetyMs + (state.userSyncOffsetMs || 0);
    return Math.max(CONFIG.metaMinDelayMs, Math.min(CONFIG.metaMaxDelayMs, withSafety));
}

export function estimateClientPlayoutMs() {
    if (state.hls && state.hls.playingDate) {
        return state.hls.playingDate.getTime() + (state.userSyncOffsetMs || 0);
    }
    if (typeof DOM.audio.getStartDate === 'function') {
        const startDate = DOM.audio.getStartDate();
        if (startDate && !isNaN(startDate.getTime())) {
            return startDate.getTime() + (DOM.audio.currentTime * 1000) + (state.userSyncOffsetMs || 0);
        }
    }
    return getAlignedNowMs() - getMetaDelayMs();
}

// Устанавливаем глобальную функцию
window.setRadioSyncOffsetSec = function (sec) {
    const value = Math.max(-15000, Math.min(15000, Math.round(Number(sec * 1000) || 0)));
    state.userSyncOffsetMs = value;
    try { if (window.localStorage) window.localStorage.setItem("radio_sync_offset_ms", String(value)); } catch (e) {}
};

// Выравнивание Viewport для iOS
export function initViewportVars() {
    let rafId = 0;
    const setVars = () => {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
            rafId = 0;
            const vv = window.visualViewport;
            const h = (vv ? vv.height : window.innerHeight) * 0.01;
            const w = (vv ? vv.width : window.innerWidth) * 0.01;
            document.documentElement.style.setProperty('--vh', `${h}px`);
            document.documentElement.style.setProperty('--vw', `${w}px`);
        });
    };
    setVars();
    window.addEventListener('resize', setVars, { passive: true });
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', setVars, { passive: true });
        window.visualViewport.addEventListener('scroll', setVars, { passive: true });
    }
}
