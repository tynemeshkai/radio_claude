import Hls from 'hls.js';
import { CONFIG, HLS_CONFIG } from './config.js';
import { state, flags, DOM } from './store.js';
import { isIOS, debugLine } from './utils.js';
import { Visualizer } from './visualizer.js';
import { updateUI } from './ui.js';
import { resetMeta, fetchNowPlaying, fetchServerMeta, fetchHistory, checkBrokenState, processMetaQueue } from './network.js';
import { initVolumeControl } from './volume.js';

let RECONNECT = { attempts: 0, timer: null };
let HLS_FATAL = { count: 0, lastAt: 0 };
let lastReloadAt = 0;
let HEALTH = { timer: null, probeInFlight: false, lastProbeAt: 0, lastProgressAt: 0, lastCurrentTime: 0 };
let _interruptedAt = 0;
let _interruptionSafetyTimer = null;
let _bgRecoveryTimer = null;
let _heartbeatLastAt = Date.now();

const SILENT_STALL_MS = 2200;
const PROBE_TIMEOUT_MS = 1800;
const MIN_PROBE_GAP_MS = 1200;

function withCacheBust(url) {
    if (!url) return "";
    return `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`;
}

function canNativeHlsPlayback() {
    const probe = DOM.audio.canPlayType('application/vnd.apple.mpegurl');
    return probe === 'probably' || probe === 'maybe';
}

function isLikelyDesktopSafari() {
    const ua = navigator.userAgent || "";
    const isSafari = /Safari\//.test(ua) &&
        !/Chrome|Chromium|CriOS|Edg|OPR|YaBrowser|YaSearchBrowser|SamsungBrowser|Firefox|FxiOS/i.test(ua);
    return isSafari && /Macintosh|Mac OS X/i.test(ua);
}

function shouldUseNativeHls() {
    // Native HLS оставляем только Apple Safari (iOS/macOS).
    // Chromium-браузеры иногда отдают canPlayType("maybe"), но воспроизведение через native нестабильно.
    return canNativeHlsPlayback() && (isIOS || isLikelyDesktopSafari());
}

function loadStreamSource(streamUrl, reason = "init") {
    const useNative = shouldUseNativeHls();
    if (useNative) {
        destroyHls();
        DOM.audio.preload = "auto";
        DOM.audio.src = streamUrl;
        DOM.audio.load();
        debugLine("stream-engine", { engine: "native-hls", reason });
        return "native-hls";
    }

    if (Hls.isSupported()) {
        destroyHls();
        const hls = createHls();
        if (!hls) throw new Error("Hls init failed");
        hls.attachMedia(DOM.audio);
        hls.loadSource(streamUrl);
        debugLine("stream-engine", { engine: "hls.js", reason });
        return "hls.js";
    }

    // Last-chance fallback for legacy browsers.
    destroyHls();
    DOM.audio.preload = "auto";
    const fallbackUrl = withCacheBust(CONFIG.fallbackStreamUrl) || streamUrl;
    DOM.audio.src = fallbackUrl;
    DOM.audio.load();
    debugLine("stream-engine", { engine: "fallback-native-attempt", reason, fallbackUrl });
    return "fallback-native-attempt";
}

function clearHealthTimer() {
    if (!HEALTH.timer) return;
    clearTimeout(HEALTH.timer);
    HEALTH.timer = null;
}

function markAudioProgress() {
    const ct = Number(DOM.audio.currentTime || 0);
    if (!Number.isFinite(ct)) return;
    if (Math.abs(ct - HEALTH.lastCurrentTime) >= 0.01) {
        HEALTH.lastCurrentTime = ct;
        HEALTH.lastProgressAt = Date.now();
        return;
    }
    if (!HEALTH.lastProgressAt && !DOM.audio.paused) HEALTH.lastProgressAt = Date.now();
}

function hasRecentAudioProgress(maxAgeMs = SILENT_STALL_MS) {
    if (DOM.audio.paused) return false;
    if (!HEALTH.lastProgressAt) return false;
    return (Date.now() - HEALTH.lastProgressAt) <= maxAgeMs;
}

const waitForTimeAdvance = (timeoutMs = PROBE_TIMEOUT_MS, minDelta = 0.04) => new Promise((resolve) => {
    if (DOM.audio.paused) {
        resolve(false);
        return;
    }
    const startCt = Number(DOM.audio.currentTime || 0);
    let done = false;
    const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(to);
        DOM.audio.removeEventListener('timeupdate', onTick);
        resolve(ok);
    };
    const onTick = () => {
        const ct = Number(DOM.audio.currentTime || 0);
        if (!Number.isFinite(ct) || !Number.isFinite(startCt)) return;
        if ((ct - startCt) >= minDelta) {
            HEALTH.lastCurrentTime = ct;
            HEALTH.lastProgressAt = Date.now();
            finish(true);
        }
    };
    const to = setTimeout(() => finish(false), timeoutMs);
    DOM.audio.addEventListener('timeupdate', onTick);
    onTick();
});

function clearReconnectTimer() {
    if (!RECONNECT.timer) return;
    clearTimeout(RECONNECT.timer);
    RECONNECT.timer = null;
}

function isManualPauseActive() {
    return state.userPauseAt > 0 && DOM.audio.paused && !state.shouldAutoResume;
}

function clearStaleInterruption(maxAgeMs = 30000) {
    if (!state.wasInterrupted || !_interruptedAt) return false;
    if ((Date.now() - _interruptedAt) < maxAgeMs) return false;
    debugLine("stale-interrupt-cleared", { ageMs: Date.now() - _interruptedAt });
    state.wasInterrupted = false;
    _interruptedAt = 0;
    return true;
}

async function recoverPlaybackHealth(reason = "ios-health-check") {
    // Это iOS-ветка hardening. На desktop (Windows/Linux/macOS non-Safari)
    // агрессивные health-check перезагрузки чаще вредят (ложные срабатывания на waiting/stalled).
    if (!isIOS) return;
    if (!navigator.onLine) return;
    if (isManualPauseActive()) return;
    // Сброс залипших флагов (iOS мог заморозить JS посреди предыдущей операции)
    if (state.lastPauseTime > 0 && (Date.now() - state.lastPauseTime) > 15000) {
        if (state.isBusy) { state.isBusy = false; debugLine("health-stale-isBusy-cleared"); }
        if (state.resumeInFlight) { state.resumeInFlight = false; debugLine("health-stale-resumeInFlight-cleared"); }
        if (HEALTH.probeInFlight) { HEALTH.probeInFlight = false; debugLine("health-stale-probe-cleared"); }
    }
    if (state.isBusy || state.resumeInFlight || HEALTH.probeInFlight) return;
    const now = Date.now();
    if ((now - HEALTH.lastProbeAt) < MIN_PROBE_GAP_MS) return;
    HEALTH.lastProbeAt = now;
    HEALTH.probeInFlight = true;
    try {
        debugLine("health-check", { reason, paused: DOM.audio.paused, ct: Number(DOM.audio.currentTime || 0).toFixed(2), shouldAutoResume: state.shouldAutoResume, wasInterrupted: state.wasInterrupted });
        if (DOM.audio.paused) {
            state.shouldAutoResume = true;
            await handleResume(reason);
            return;
        }
        if (hasRecentAudioProgress()) return;
        state.shouldAutoResume = true;
        const hasProgress = await waitForTimeAdvance();
        if (hasProgress) return;
        debugLine("health-check reload", { reason });
        await reloadAndPlay({ force: true, reason: `${reason}-stuck` });
    } catch (e) {
        debugLine("health-check failed", { reason, error: e && e.message ? e.message : String(e) });
        scheduleReconnect();
    } finally {
        HEALTH.probeInFlight = false;
    }
}

function scheduleHealthCheck(reason, delayMs = 250) {
    clearHealthTimer();
    HEALTH.timer = setTimeout(() => {
        HEALTH.timer = null;
        recoverPlaybackHealth(reason).catch(() => {});
    }, delayMs);
}

export function destroyHls() {
    if (!state.hls) return;
    try { state.hls.destroy(); } catch (e) {}
    state.hls = null;
}

export function createHls() {
    if (!Hls.isSupported()) return null;
    const hls = new Hls(HLS_CONFIG);
    
    hls.on(Hls.Events.ERROR, function (event, data) {
        if (data.fatal) {
            const now = Date.now();
            if (now - HLS_FATAL.lastAt > 10000) HLS_FATAL.count = 0;
            HLS_FATAL.lastAt = now;
            HLS_FATAL.count += 1;

            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                if (data.response && (data.response.code === 404 || data.response.code >= 500)) {
                    flags.broken.hls = true;
                    checkBrokenState();
                }
                hls.startLoad();
            } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                hls.recoverMediaError();
            } else {
                destroyHls();
            }
            if (HLS_FATAL.count >= 3) destroyHls();
            scheduleReconnect();
        }
    });

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
        HLS_FATAL.count = 0;
        flags.broken.hls = false;
        checkBrokenState();
    });

    hls.on(Hls.Events.LEVEL_LOADED, () => {
        HLS_FATAL.count = 0;
        flags.broken.hls = false;
        checkBrokenState();
    });

    state.hls = hls;
    return hls;
}

export function initPlayer() {
    const streamUrl = withCacheBust(CONFIG.hlsUrl);
    DOM.audio.setAttribute('playsinline', '');
    DOM.audio.setAttribute('webkit-playsinline', '');
    DOM.audio.setAttribute('x-webkit-airplay', 'allow');
    try { loadStreamSource(streamUrl, "init"); } catch (e) { debugLine("initPlayer load failed", { error: e?.message }); }
}

function scheduleReconnect() {
    if (!navigator.onLine) return;
    if (isManualPauseActive()) return;
    clearStaleInterruption(30000);
    if (state.wasInterrupted) return;
    if (RECONNECT.timer) return;
    const delay = Math.min(15000, 1000 * Math.pow(2, RECONNECT.attempts));
    RECONNECT.attempts = Math.min(RECONNECT.attempts + 1, 6);
    RECONNECT.timer = setTimeout(() => {
        RECONNECT.timer = null;
        if (isManualPauseActive()) return;
        clearStaleInterruption(30000);
        reloadAndPlay().catch(() => {});
    }, delay);
}

export async function reloadAndPlay(opts = {}) {
    const force = !!opts.force;
    if (!navigator.onLine) return;
    clearStaleInterruption(30000);
    if (!force && state.wasInterrupted) return;
    if (!force && isManualPauseActive()) return;
    const now = Date.now();
    if (now - lastReloadAt < CONFIG.reloadCooldownMs) {
        scheduleReconnect();
        return;
    }
    lastReloadAt = now;
    // Сброс залипшего isBusy после долгой паузы
    if (state.isBusy && state.lastPauseTime > 0 && (Date.now() - state.lastPauseTime) > 15000) {
        state.isBusy = false;
        debugLine("reload-stale-isBusy-cleared");
    }
    if (state.isBusy) return;
    state.isBusy = true;

    resetMeta();
    const freshUrl = withCacheBust(CONFIG.hlsUrl);

    try {
        loadStreamSource(freshUrl, opts.reason || "reload");
        // Увеличенный таймаут для iOS в фоне: 8 секунд вместо 1.5
        const timeout = document.hidden ? 8000 : (isIOS ? 1500 : 3000);
        await playWithVerify(timeout);
    } catch (e) {
        updateUI(false);
        if (!isManualPauseActive()) scheduleReconnect();
    } finally {
        state.isBusy = false;
    }
}

const waitForStart = (timeoutMs = 2000) => new Promise((resolve, reject) => {
    let settled = false;
    const onOk = () => { if (!settled) { markAudioProgress(); settled = true; cleanup(); resolve(); } };
    const cleanup = () => { clearTimeout(to); DOM.audio.removeEventListener('playing', onOk); DOM.audio.removeEventListener('timeupdate', onOk); };
    const to = setTimeout(() => { if (!settled) { settled = true; cleanup(); reject(new Error("start timeout")); } }, timeoutMs);
    DOM.audio.addEventListener('playing', onOk, { once: true });
    DOM.audio.addEventListener('timeupdate', onOk, { once: true });
});

export async function playWithVerify(timeoutMs = 1500) {
    await DOM.audio.play();
    await waitForStart(timeoutMs);
}

// ==============================================================================
// ЕДИНАЯ ЛОГИКА RESUME / PAUSE
// ==============================================================================
async function handleResume(reason = "resume") {
    // Сброс залипших флагов после долгой паузы (iOS мог заморозить JS посреди операции)
    if (state.lastPauseTime > 0 && (Date.now() - state.lastPauseTime) > 15000) {
        if (state.resumeInFlight) { state.resumeInFlight = false; debugLine("stale-resumeInFlight-cleared"); }
        if (state.isBusy) { state.isBusy = false; debugLine("stale-isBusy-cleared"); }
    }
    if (state.resumeInFlight) return;
    state.resumeInFlight = true;
    state.lastUserGestureAt = Date.now();

    Visualizer.init(DOM.audio);

    const pauseDuration = state.lastPauseTime > 0 ? (Date.now() - state.lastPauseTime) : 0;

    state.userPauseAt = 0;
    state.shouldAutoResume = false;

    try {
        if (state.lastPauseTime > 0 && pauseDuration > 10000) {
            // Долгая пауза — полная перезагрузка потока с ретраями
            await resumeWithRetry(reason, 3);
        } else {
            resetMeta();
            try {
                await playWithVerify(isIOS ? 1500 : 3000);
            } catch (e) {
                await resumeWithRetry(reason, 2);
            }
        }
    } finally {
        state.resumeInFlight = false;
    }
}

// Retry-обёртка для iOS: пробуем reloadAndPlay несколько раз
async function resumeWithRetry(reason, maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            debugLine("resume-retry", { reason, attempt, maxAttempts });
            await reloadAndPlay({ force: true, reason: `${reason}-attempt${attempt}` });
            // Проверяем что звук реально пошёл
            if (!DOM.audio.paused) return; // Успех!
        } catch (e) {
            debugLine("resume-retry-fail", { reason, attempt, error: e?.message });
        }
        // Ждём перед следующей попыткой (iOS может разморозить сеть не сразу)
        if (attempt < maxAttempts) {
            await new Promise(r => setTimeout(r, 1500 * attempt));
        }
    }
    // Все попытки провалились — планируем reconnect как последний шанс
    scheduleReconnect();
}

function handleUserPause() {
    state.userPauseAt = Date.now();
    state.shouldAutoResume = false;
    state.wasInterrupted = false;
    _interruptedAt = 0;
    clearReconnectTimer();
    clearTimeout(_bgRecoveryTimer);
    clearTimeout(_interruptionSafetyTimer);
    _bgRecoveryTimer = null;
    _interruptionSafetyTimer = null;
    RECONNECT.attempts = 0;
    DOM.audio.pause();
}

export async function togglePlay() {
    if (DOM.audio.paused) {
        await handleResume("toggle-play");
    } else {
        handleUserPause();
    }
}

// --- СЛУШАТЕЛИ СОБЫТИЙ AUDIO ---
export function initPlayerEvents() {
    DOM.playBtn.addEventListener('click', togglePlay);
    initVolumeControl();

    DOM.audio.addEventListener('playing', () => {
        markAudioProgress();
        clearTimeout(_bgRecoveryTimer);
        clearTimeout(_interruptionSafetyTimer);
        _bgRecoveryTimer = null;
        _interruptionSafetyTimer = null;
        flags.broken.hls = false;
        checkBrokenState();
        state.isPlaying = true;
        state.isBusy = false;
        state.wasInterrupted = false;
        _interruptedAt = 0;
        updateUI(true);
        resetMeta();
        fetchNowPlaying(true);
        fetchServerMeta(true);
        fetchHistory();
        RECONNECT.attempts = 0;
        clearReconnectTimer();
        state.shouldAutoResume = false;
        state.userPauseAt = 0;
        state.wasInterrupted = false;
        state.resumeInFlight = false;

        if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = 'playing';
        }
    });

    DOM.audio.addEventListener('pause', () => {
        const wasPlaying = state.isPlaying;
        state.lastPauseTime = Date.now();
        state.isPlaying = false;
        updateUI(false);

        if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = 'paused';
        }

        if (state.userPauseAt > 0) {
            state.shouldAutoResume = false;
            clearReconnectTimer();
            RECONNECT.attempts = 0;
            return;
        } else if (state.wasInterrupted) {
            state.shouldAutoResume = true;
            return;
        } else if (wasPlaying) {
            state.shouldAutoResume = true;
            if (!document.hidden) {
                setTimeout(() => {
                    if (state.shouldAutoResume && !state.wasInterrupted && !isManualPauseActive()) {
                        playWithVerify().catch(() => reloadAndPlay({ force: true, reason: "pause-recover" }));
                    }
                }, 250);
            } else {
                // iOS: system paused us while in background (timer, alarm, voice message)
                clearTimeout(_bgRecoveryTimer);
                _bgRecoveryTimer = setTimeout(function bgRetry() {
                    _bgRecoveryTimer = null;
                    if (isManualPauseActive() || !DOM.audio.paused) return;
                    if (state.shouldAutoResume || state.wasInterrupted) {
                        state.wasInterrupted = false;
                        _interruptedAt = 0;
                        recoverPlaybackHealth("bg-auto-resume").catch(() => {
                            _bgRecoveryTimer = setTimeout(bgRetry, 5000);
                        });
                    }
                }, 3000);
            }
        }
    });

    DOM.audio.addEventListener('error', () => {
        if (isManualPauseActive()) return;
        if (DOM.audio.error && (DOM.audio.error.code === 3 || DOM.audio.error.code === 4)) {
            flags.broken.hls = true;
            checkBrokenState();
        }
        if (state.isPlaying || state.isBusy || state.shouldAutoResume) scheduleReconnect();
    });

    DOM.audio.addEventListener('ended', () => {
        if (isManualPauseActive()) return;
        state.shouldAutoResume = true;
        reloadAndPlay({ force: true, reason: "ended" }).catch(() => scheduleReconnect());
    });

    DOM.audio.addEventListener('stalled', () => {
        if (isManualPauseActive()) return;
        debugLine("audio-stalled");
        if (isIOS && (state.isPlaying || state.shouldAutoResume)) {
            scheduleHealthCheck("stalled", 2500);
        }
    });

    DOM.audio.addEventListener('waiting', () => {
        if (isManualPauseActive()) return;
        debugLine("audio-waiting");
        if (isIOS && (state.isPlaying || state.shouldAutoResume)) {
            scheduleHealthCheck("waiting", 3000);
        }
    });

    // Watchdog
    let _wdLastCT = 0;
    let _wdStuckMs = 0;
    setInterval(() => {
        if (!state.isPlaying || DOM.audio.paused || state.wasInterrupted) return;
        const ct = DOM.audio.currentTime || 0;
        if (Math.abs(ct - _wdLastCT) < 0.01) _wdStuckMs += 1000;
        else { _wdStuckMs = 0; _wdLastCT = ct; }

        if (_wdStuckMs >= 15000) {
            _wdStuckMs = 0;
            if (!navigator.onLine) return;
            if (state.hls) { try { state.hls.recoverMediaError(); } catch (e) {} }
            reloadAndPlay({ force: true, reason: "watchdog" }).catch(() => {});
        }
    }, 1000);

// === ФОНОВЫЙ ПУЛЬС ДЛЯ iOS ===
    let lastBackgroundFetch = 0;
    DOM.audio.addEventListener('timeupdate', () => {
        markAudioProgress();
        if (!document.hidden) return; 

        const now = Date.now();
        
        processMetaQueue();
        
        if (now - lastBackgroundFetch > 10000) {
            lastBackgroundFetch = now;
            fetchNowPlaying(false);
            fetchHistory();
        }
    });

    // ==============================================================================
    // MEDIAESSION API: Управление с экрана блокировки и наушников
    // ==============================================================================
    if ('mediaSession' in navigator) {
        // Прямой обработчик play для экрана блокировки iOS.
        // Известный баг Safari: после паузы простой .play() не работает —
        // нужно перезагрузить src. Обходим все сложные цепочки (handleResume/
        // reloadAndPlay), потому что iOS может заморозить JS до их завершения,
        // а залипшие флаги (resumeInFlight, isBusy) заблокируют следующие попытки.
        navigator.mediaSession.setActionHandler('play', async () => {
            debugLine("media-session-play", {
                paused: DOM.audio.paused,
                isBusy: state.isBusy,
                resumeInFlight: state.resumeInFlight,
                hidden: document.hidden
            });

            // Сброс ВСЕХ залипших флагов — iOS мог заморозить JS посреди операции
            state.userPauseAt = 0;
            state.shouldAutoResume = false;
            state.wasInterrupted = false;
            _interruptedAt = 0;
            state.resumeInFlight = false;
            state.isBusy = false;
            RECONNECT.attempts = 0;
            clearReconnectTimer();
            clearTimeout(_bgRecoveryTimer);
            clearTimeout(_interruptionSafetyTimer);
            _bgRecoveryTimer = null;
            _interruptionSafetyTimer = null;

            // Прямая перезагрузка источника — минимальный путь до play()
            const freshUrl = withCacheBust(CONFIG.hlsUrl);
            loadStreamSource(freshUrl, "media-session-play");

            try {
                await DOM.audio.play();
                // Событие 'playing' обновит state, UI, метаданные
            } catch (e) {
                debugLine("media-session-play-fail", { error: e?.message });
                // Повторная попытка через health check
                state.shouldAutoResume = true;
                scheduleHealthCheck("media-session-retry", 1000);
            }
        });

        navigator.mediaSession.setActionHandler('pause', () => handleUserPause());
        try { navigator.mediaSession.setActionHandler('stop', () => handleUserPause()); } catch (e) {}
        try { navigator.mediaSession.setActionHandler('seekbackward', null); } catch (e) {}
        try { navigator.mediaSession.setActionHandler('seekforward', null); } catch (e) {}
        try { navigator.mediaSession.setActionHandler('previoustrack', null); } catch (e) {}
        try { navigator.mediaSession.setActionHandler('nexttrack', null); } catch (e) {}
    }

    // ==============================================================================
    // iOS SYSTEM INTERRUPTIONS
    // ==============================================================================
    DOM.audio.addEventListener('webkitaudiointerruptionbegin', () => {
        if (state.userPauseAt > 0) return;
        debugLine("ios interruption begin");
        state.wasInterrupted = true;
        state.shouldAutoResume = true;
        _interruptedAt = Date.now();
        clearReconnectTimer();
        // Safety valve: if webkitaudiointerruptionend never fires, force recovery
        clearTimeout(_interruptionSafetyTimer);
        _interruptionSafetyTimer = setTimeout(() => {
            _interruptionSafetyTimer = null;
            if (state.wasInterrupted && !isManualPauseActive()) {
                debugLine("interruption-safety-valve");
                state.wasInterrupted = false;
                _interruptedAt = 0;
                state.shouldAutoResume = true;
                scheduleHealthCheck("interruption-safety", 0);
            }
        }, 30000);
    });

    DOM.audio.addEventListener('webkitaudiointerruptionend', () => {
        if (state.userPauseAt > 0) return;
        debugLine("ios interruption end");
        state.wasInterrupted = false;
        _interruptedAt = 0;
        state.shouldAutoResume = true;
        clearTimeout(_interruptionSafetyTimer);
        _interruptionSafetyTimer = null;
        scheduleHealthCheck("ios-interruption-end", 120);
        setTimeout(() => scheduleHealthCheck("ios-interruption-end-late", 0), 900);
        setTimeout(() => scheduleHealthCheck("ios-interruption-end-verify", 0), 3000);
    });

    // ==============================================================================
    // СТРАХОВКА: авто-resume при возврате в приложение
    // ==============================================================================
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            _heartbeatLastAt = Date.now();
            clearStaleInterruption(15000);
            if (!isManualPauseActive() && (state.shouldAutoResume || state.wasInterrupted || state.isPlaying)) {
                scheduleHealthCheck("visibility-resume", 220);
            }
        }
    });

    window.addEventListener('online', () => {
        if (isManualPauseActive()) return;
        if (state.shouldAutoResume || state.wasInterrupted) {
            scheduleHealthCheck("online-resume", 200);
            return;
        }
        if (state.isPlaying) scheduleReconnect();
    });

    window.addEventListener('offline', () => {
        clearReconnectTimer();
    });

    window.addEventListener('pageshow', (e) => {
        _heartbeatLastAt = Date.now();
        if (e.persisted) {
            // Restored from bfcache — audio element may be in stale state
            debugLine("bfcache-restore");
            state.wasInterrupted = false;
            _interruptedAt = 0;
        }
        if (!document.hidden && !isManualPauseActive() && (state.shouldAutoResume || state.wasInterrupted || state.isPlaying)) {
            scheduleHealthCheck("pageshow", e.persisted ? 100 : 250);
        }
    });

    window.addEventListener('focus', () => {
        if (!document.hidden && !isManualPauseActive() && (state.shouldAutoResume || state.wasInterrupted || state.isPlaying)) {
            scheduleHealthCheck("focus-resume", 200);
        }
    });

    // iOS heartbeat: detect JS freeze/unfreeze via time jumps
    // When iOS freezes JS (lock screen, background), setInterval stops.
    // When unfrozen, elapsed time >> interval — we detect this and trigger recovery.
    setInterval(() => {
        const now = Date.now();
        const elapsed = now - _heartbeatLastAt;
        _heartbeatLastAt = now;

        if (elapsed > 5000 && !isManualPauseActive()) {
            debugLine("heartbeat-wake", { elapsedMs: elapsed, paused: DOM.audio.paused });
            state.wasInterrupted = false;
            _interruptedAt = 0;
            clearTimeout(_interruptionSafetyTimer);
            _interruptionSafetyTimer = null;
            if (state.shouldAutoResume || (state.isPlaying && DOM.audio.paused)) {
                scheduleHealthCheck("heartbeat-wake", 100);
            }
        }
    }, 2000);
}