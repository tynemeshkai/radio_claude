// --- КЭШИРОВАННЫЕ ДОМ-ЭЛЕМЕНТЫ ---
export const DOM = {
    audio: document.getElementById('audio-stream'),
    playBtn: document.getElementById('play-btn'),
    muteBtn: document.getElementById('mute-btn'),
    artistEl: document.getElementById('artist-name'),
    titleEl: document.getElementById('track-name'),
    historyListEl: document.getElementById('history-list'),
    infoBtn: document.getElementById('info-btn'),
    infoPopup: document.querySelector('.info-popup'),
    // Новые элементы для Canvas:
    eqContainer: document.querySelector('.equaliser'),
    eqCanvas: document.getElementById('eq-canvas')
};

// Чтение настроек пользователя из браузера
let storedSyncOffsetMs = 0;
try {
    const raw = window.localStorage ? window.localStorage.getItem("radio_sync_offset_ms") : null;
    const num = Number(raw);
    if (Number.isFinite(num)) {
        storedSyncOffsetMs = Math.max(-15000, Math.min(15000, Math.round(num)));
    }
} catch (e) {}

// --- ГЛОБАЛЬНОЕ СОСТОЯНИЕ ---
export const state = {
    isPlaying: false,
    hls: null,
    currentDisplayedTrack: "",
    serverTrackTitle: "",
    metaQueue: [],
    lastPauseTime: 0,
    isBusy: false,
    metaFetchInFlight: false,
    metaFetchQueued: false,
    nowPlayingFetchInFlight: false,
    nowPlayingFetchQueued: false,
    historyFetchInFlight: false,
    historyFetchQueued: false,
    userPauseAt: 0,
    userPauseReason: "",
    ignoreNextPause: false,
    shouldAutoResume: false,
    wasInterrupted: false,
    resumeInFlight: false,
    pendingResume: false,
    resumeReason: "",
    pauseIgnoreUntil: 0,
    resumeToken: 0,
    resumeGraceUntil: 0,
    lastStartAt: 0,
    isLive: false,
    lastUserGestureAt: 0,
    lastUiPauseAttemptAt: 0,
    uiPauseLockUntil: 0,
    pauseOverrideUntil: 0,
    currentTrackSource: "",
    currentTrackKey: "",
    lastTrackAppliedAt: 0,
    lastStatusTrack: "",
    lastStatusAt: 0,
    lastNowPlayingTrack: "",
    lastNowPlayingAt: 0,
    lastNowPlayingSeq: 0,
    lastNowPlayingStartedAt: 0,
    latestHistoryTrack: "",
    latestHistoryKey: "",
    latestHistoryAt: 0,
    historyTimeline: [],
    serverClockOffsetMs: 0,
    userSyncOffsetMs: storedSyncOffsetMs
};

// Индикаторы падения сервера
export const flags = {
    serverIsDown: false,
    broken: { icecast: false, hls: false }
};

export const DEBUG_STATE = { lines: [], max: 80, panel: null, lastTimeLog: 0 };
// Глобальный доступ для дебага из консоли браузера
if (typeof window !== 'undefined') window.__radio = { state, flags, DOM };