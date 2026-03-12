import { CONFIG, BASE_URL } from './config.js';
import { state, flags, DOM } from './store.js';
import { getAlignedNowMs, getMetaDelayMs, estimateClientPlayoutMs, normalizeTrackTitle, isGenericTrackTitle } from './utils.js';
import { applyTrackChange, renderHistory } from './ui.js';

const FETCH_TIMEOUT_MS = 8000;
const SSE_STALE_MS = 45000;
let sseSource = null;
let sseReopenTimer = null;

export const fetchNoStore = (url, timeoutMs = FETCH_TIMEOUT_MS) => {
    if (!('AbortController' in window)) return fetch(url, { cache: 'no-store' });
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { cache: 'no-store', signal: controller.signal }).finally(() => clearTimeout(to));
};

export function checkBrokenState() {
    const isBroken = flags.broken.icecast || flags.broken.hls;
    if (isBroken && !flags.serverIsDown) {
        flags.serverIsDown = true;
        if (navigator.onLine) {
            state.metaQueue = [];
            applyTrackChange("МЫ ЧЁ-ТО ПОЛОМАЛИ - СКОРО ПОЧИНИМ", "system-error", "system-error");
        }
    } else if (!isBroken && flags.serverIsDown) {
        flags.serverIsDown = false;
        fetchNowPlaying(true); 
        fetchServerMeta(true);
    }
}

function parseNowPlayingTimestamp(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
        const asNum = Number(value);
        if (Number.isFinite(asNum) && asNum > 0) return asNum;
        const asDate = Date.parse(value);
        if (Number.isFinite(asDate) && asDate > 0) return asDate;
    }
    return 0;
}

function parseNowPlayingPayload(payload) {
    if (!payload || typeof payload !== "object") return null;
    const artist = normalizeTrackTitle(payload.artist || "");
    const title = normalizeTrackTitle(payload.title || "");
    const song = normalizeTrackTitle(payload.song || "");
    const directTrack = normalizeTrackTitle(payload.track || payload.full_title || payload.now_playing || "");
    const isLive = payload.is_live === true;

    let track = "";
    if (artist && title && !isGenericTrackTitle(title)) track = `${artist} - ${title}`;
    else if (song && !isGenericTrackTitle(song)) track = song;
    else if (directTrack && !isGenericTrackTitle(directTrack)) track = directTrack;
    else if (title && !isGenericTrackTitle(title)) track = title;

    if (!track) return null;

    const startedAtMs = parseNowPlayingTimestamp(payload.started_at_unix_ms || payload.started_at_ms || payload.started_ms || payload.started_at || payload.started_at_utc);
    const sequence = Number.isFinite(Number(payload.sequence)) ? Number(payload.sequence) : 0;
    return { track, startedAtMs, sequence, isLive };
}

function makeTrackKey(trackTitle, startedAtMs = 0, sequence = 0) {
    return `${normalizeTrackTitle(trackTitle)}::${startedAtMs}::${sequence}`;
}

function makeHistoryTrackKey(item) {
    if (!item || !item.track) return "";
    return makeTrackKey(item.track, Number(item.startedAtMs || 0), 0);
}

function enqueueTrack(trackTitle, source, opts = {}) {
    const clean = normalizeTrackTitle(trackTitle);
    if (!clean) return;

    const trackKey = opts.trackKey || makeTrackKey(clean, opts.startedAtMs || 0, opts.sequence || 0);
    const now = getAlignedNowMs();
    const computedShowAt = Number.isFinite(Number(opts.showAtMs)) ? Number(opts.showAtMs) : (now + getMetaDelayMs());
    const showAt = Math.max(now - 1000, computedShowAt);

    if (trackKey && trackKey === state.currentTrackKey) return;
    if (!trackKey && clean === state.currentDisplayedTrack) return;

    if (showAt <= now + 250) {
        state.metaQueue = [];
        applyTrackChange(clean, source, trackKey);
        return;
    }
    if (state.metaQueue.some(x => x.trackKey === trackKey)) return;

    state.metaQueue.push({ title: clean, source, showAt, trackKey });
    if (state.metaQueue.length > 8) state.metaQueue = state.metaQueue.slice(-4);
}

export async function fetchNowPlaying(force = false) {
    if (state.nowPlayingFetchInFlight) {
        if (force) state.nowPlayingFetchQueued = true;
        return;
    }
    state.nowPlayingFetchInFlight = true;
    try {
        const res = await fetchNoStore(CONFIG.nowPlayingUrl + "?t=" + Date.now());
        if (!res.ok) return;
        
        const serverDate = res.headers?.get("date");
        if (serverDate) {
            const serverNow = Date.parse(serverDate);
            if (Number.isFinite(serverNow) && serverNow > 0) state.serverClockOffsetMs = serverNow - Date.now();
        }

        const data = await res.json();
        const parsed = parseNowPlayingPayload(data);
        if (!parsed || !parsed.track) return;

        const now = getAlignedNowMs();
        state.lastNowPlayingAt = now;
        state.lastNowPlayingTrack = parsed.track;
        state.isLive = parsed.isLive === true;
        if (parsed.sequence > 0) state.lastNowPlayingSeq = parsed.sequence;
        if (parsed.startedAtMs > 0) state.lastNowPlayingStartedAt = parsed.startedAtMs;

        const showAtMs = parsed.startedAtMs > 0 ? (parsed.startedAtMs + getMetaDelayMs()) : (now + getMetaDelayMs());
        enqueueTrack(parsed.track, "nowplaying", { showAtMs, trackKey: makeTrackKey(parsed.track, parsed.startedAtMs, parsed.sequence) });
    } catch (e) {} finally {
        state.nowPlayingFetchInFlight = false;
        if (state.nowPlayingFetchQueued) {
            state.nowPlayingFetchQueued = false;
            fetchNowPlaying(true);
        }
    }
}

export async function fetchServerMeta(force = false) {
    if (!force && state.lastNowPlayingAt > 0 && (getAlignedNowMs() - state.lastNowPlayingAt) < CONFIG.nowPlayingStaleMs) return;
    if (state.metaFetchInFlight) {
        if (force) state.metaFetchQueued = true;
        return;
    }
    state.metaFetchInFlight = true;
    try {
        const res = await fetchNoStore(CONFIG.statusUrl + "?t=" + Date.now());
        if (!res.ok) {
            if (res.status >= 500 || res.status === 404) {
                flags.broken.icecast = true;
                checkBrokenState();
            }
            return;
        }
        const data = await res.json();
        let src = data?.icestats?.source;
        if (!src) return;
        if (!Array.isArray(src)) src = [src];
        const mount = src.find(s => s && s.listenurl && s.listenurl.includes("/stream")) || src[0] || null;

        if (!mount) {
            flags.broken.icecast = true;
            checkBrokenState();
            return;
        }

        flags.broken.icecast = false;
        checkBrokenState();

        const track = extractTrackFromMount(mount);
        if (!track) return;

        state.serverTrackTitle = track;
        state.lastStatusTrack = track;
        state.lastStatusAt = getAlignedNowMs();

        // nowplaying.json авторитетнее Icecast статуса — не перезаписываем если он свежий
        const nowPlayingAge = getAlignedNowMs() - state.lastNowPlayingAt;
        if (state.lastNowPlayingAt > 0 && nowPlayingAge < 60000) return;

        enqueueTrack(track, "status", { trackKey: `status:${track}` });

    } catch (e) {} finally {
        state.metaFetchInFlight = false;
        if (state.metaFetchQueued) {
            state.metaFetchQueued = false;
            fetchServerMeta(true);
        }
    }
}

function extractTrackFromMount(mount) {
    if (!mount) return "";
    const artist = normalizeTrackTitle(mount.artist || "");
    const title = normalizeTrackTitle(mount.title || "");
    const song = normalizeTrackTitle(mount.song || "");
    if (artist && title && !isGenericTrackTitle(title)) return `${artist} - ${title}`;
    if (song && !isGenericTrackTitle(song)) return song;
    if (title && !isGenericTrackTitle(title)) return title;
    return "";
}

export async function fetchHistory() {
    if (state.historyFetchInFlight) {
        if (state.historyFetchQueued) return;
        state.historyFetchQueued = true;
        return;
    }
    state.historyFetchInFlight = true;
    try {
        let tracks = [];
        let timeline = [];
        try {
            const jsonRes = await fetchNoStore(CONFIG.historyJsonUrl + "?t=" + Date.now());
            if (jsonRes.ok) {
                const payload = await jsonRes.json();
                timeline = (payload.items || []).map(item => {
                    const trackRaw = normalizeTrackTitle(item.track || item.title || "");
                    return { track: trackRaw, startedAtMs: parseNowPlayingTimestamp(item.started_at_unix_ms) };
                }).filter(x => x.track);
            }
        } catch (e) {}

        if (timeline.length === 0) {
            const textRes = await fetchNoStore(CONFIG.historyUrl + "?t=" + Date.now());
            if (textRes.ok) {
                const text = await textRes.text();
                timeline = text.split('\n').map(line => {
                    const parts = line.split(' || ');
                    if (parts.length < 2) return null;
                    return { track: normalizeTrackTitle(parts.slice(1).join(' || ')), startedAtMs: parseNowPlayingTimestamp(parts[0]) };
                }).filter(x => x && x.track);
            }
        }

        timeline.sort((a, b) => (Number(b.startedAtMs || 0) - Number(a.startedAtMs || 0)));
        state.historyTimeline = timeline;
        tracks = timeline.map(x => x.track);

        const latestItem = timeline[0] || null;
        const latestKey = makeHistoryTrackKey(latestItem);
        if (latestItem && latestKey && latestKey !== state.latestHistoryKey) {
            state.latestHistoryTrack = latestItem.track;
            state.latestHistoryKey = latestKey;
            state.latestHistoryAt = getAlignedNowMs();
        }

        syncTrackToHistoryTimeline();
        maybeForceTrackSyncFromHistory();

        const visible = tracks.filter((t, idx) => !(idx === 0 && t === state.currentDisplayedTrack));
        renderHistory(visible.length === 0 ? ["История пуста..."] : visible.slice(0, 3));
    } catch (e) {} finally {
        state.historyFetchInFlight = false;
        if (state.historyFetchQueued) {
            state.historyFetchQueued = false;
            fetchHistory();
        }
    }
}

function syncTrackToHistoryTimeline(force = false) {
    if (!force && document.hidden) return;
    if (state.historyFetchInFlight) return;
    if (state.isLive) return;
    if (!force && (!state.isPlaying || DOM.audio.paused)) return;
    if (!state.historyTimeline.length) return;

    // SSE/nowplaying.json — авторитетный источник текущего трека.
    // Если отображаемый трек совпадает с тем, что подтвердил сервер, не даём
    // устаревшему historyTimeline откатить его назад (race condition: history
    // обновляется раз в 20с, а SSE приходит немедленно).
    if (!force && state.lastNowPlayingTrack && state.currentDisplayedTrack === state.lastNowPlayingTrack) return;

    const playheadMs = estimateClientPlayoutMs();

    let candidate = state.historyTimeline.find(item => item.startedAtMs > 0 && item.startedAtMs <= playheadMs) || state.historyTimeline[state.historyTimeline.length - 1];
    if (!candidate || !candidate.track) return;

    const key = makeHistoryTrackKey(candidate);
    if (!force && key === state.currentTrackKey) return;

    // Если трек был выставлен авторитетным источником (SSE/nowplaying) менее 5 секунд назад,
    // не даём historyTimeline перебить его — защита от snap-back в момент смены трека.
    if (!force) {
        const authSources = new Set(['sse', 'nowplaying']);
        if (authSources.has(state.currentTrackSource) && state.lastTrackAppliedAt &&
            (getAlignedNowMs() - state.lastTrackAppliedAt) < 5000) return;
    }

    state.metaQueue = [];
    applyTrackChange(candidate.track, "history-timeline", key);
}

function maybeForceTrackSyncFromHistory() {
    if (state.historyFetchInFlight) return;
    if (document.hidden) return;
    if (state.isLive) return;

    if (!state.latestHistoryTrack || !state.latestHistoryKey) return;
    if (state.latestHistoryKey === state.currentTrackKey) return;
    const now = getAlignedNowMs();
    const displayAge = state.lastTrackAppliedAt ? (now - state.lastTrackAppliedAt) : Number.POSITIVE_INFINITY;
    
    if (state.lastNowPlayingTrack === state.currentDisplayedTrack && displayAge >= CONFIG.metaForceSyncAfterMs) {
        if (state.historyTimeline.length > 0) syncTrackToHistoryTimeline(true);
        else {
            state.metaQueue = [];
            applyTrackChange(state.latestHistoryTrack, "history-fallback", state.latestHistoryKey);
        }
    }
}

export function resetMeta() {
    state.metaQueue = [];
    fetchHistory();
    fetchNowPlaying(false);
    fetchServerMeta(false);
}

function closeSSE() {
    if (sseReopenTimer) {
        clearTimeout(sseReopenTimer);
        sseReopenTimer = null;
    }
    if (!sseSource) return;
    try { sseSource.close(); } catch (e) {}
    sseSource = null;
}

function scheduleSSEReopen(delayMs = 3000) {
    if (sseReopenTimer) return;
    sseReopenTimer = setTimeout(() => {
        sseReopenTimer = null;
        closeSSE();
        initSSE();
    }, delayMs);
}

export function initSSE() {
    if (!window.EventSource || sseSource) return;
    sseSource = new EventSource(BASE_URL + '/events');
    sseSource.onopen = () => {
        // Сразу запрашиваем актуальный трек — не помечаем данные свежими до получения реального ответа
        fetchNowPlaying(true);
    };
    sseSource.onmessage = function(event) {
        if (!event.data || event.data === 'connected') return;
        try {
            const payload = JSON.parse(event.data);
            const parsed = parseNowPlayingPayload(payload);
            if (!parsed || !parsed.track) return;

            const now = getAlignedNowMs();
            state.lastNowPlayingAt = now;
            state.lastNowPlayingTrack = parsed.track;
            if (parsed.sequence > 0) state.lastNowPlayingSeq = parsed.sequence;
            if (parsed.startedAtMs > 0) state.lastNowPlayingStartedAt = parsed.startedAtMs;
            
            const showAtMs = parsed.startedAtMs > 0 ? (parsed.startedAtMs + getMetaDelayMs()) : (now + getMetaDelayMs());
            enqueueTrack(parsed.track, "sse", { showAtMs, trackKey: makeTrackKey(parsed.track, parsed.startedAtMs, parsed.sequence) });
        } catch (e) {}
    };
    sseSource.onerror = () => {
        // EventSource сам переподключается, но на ошибке сразу дергаем poll как страховку
        fetchNowPlaying(false);
        if (!document.hidden) scheduleSSEReopen(4000);
    };
}

// Выносим логику обновления UI в отдельную функцию, чтобы её мог дергать плеер в фоне
export function processMetaQueue() {
    if (state.metaQueue.length > 0) {
        state.metaQueue.sort((a, b) => a.showAt - b.showAt);
        if (getAlignedNowMs() >= state.metaQueue[0].showAt) {
            const next = state.metaQueue.shift();
            // applyTrackChange автоматически обновляет и сайт, и экран блокировки (MediaSession)
            applyTrackChange(next.title, next.source, next.trackKey);
            // Сразу обновляем historyTimeline — иначе stale-данные (обновление раз в 20с)
            // могут подставить в renderHistory предыдущий трек вместо нового.
            fetchHistory();
        }
    }
    syncTrackToHistoryTimeline(false);
    maybeForceTrackSyncFromHistory();
}

export function startNetworkLoops() {
    initSSE();
    setInterval(() => {
        if (document.hidden) {
            if (state.isPlaying) fetchNowPlaying(false);
            return;
        }

        // На видимом экране не дергаем лишний polling,
        // если SSE живой и дает свежие данные.
        const sseLooksHealthy = !!(
            window.EventSource &&
            sseSource &&
            state.lastNowPlayingAt > 0 &&
            (getAlignedNowMs() - state.lastNowPlayingAt) <= SSE_STALE_MS
        );
        if (!sseLooksHealthy) fetchNowPlaying(false);
    }, CONFIG.nowPlayingIntervalMs);
    setInterval(() => { if (!document.hidden || state.isPlaying) fetchServerMeta(false); }, CONFIG.metaInterval);
    setInterval(() => {
        if (!window.EventSource || document.hidden) return;
        if (!sseSource) {
            initSSE();
            return;
        }
        if (state.lastNowPlayingAt > 0 && (getAlignedNowMs() - state.lastNowPlayingAt) > SSE_STALE_MS) {
            fetchNowPlaying(false);
            scheduleSSEReopen(1000);
        }
    }, 15000);
    
    // ГЛАВНЫЙ ИНТЕРВАЛ UI (1 секунда)
    setInterval(() => {
        // Если телефон заблокирован, этот интервал засыпает. 
        // Вместо него processMetaQueue() будет вызывать timeupdate в player.js
        if (document.hidden) return; 
        processMetaQueue();
    }, 1000);
    
    setInterval(() => { if (!document.hidden) fetchHistory(); }, CONFIG.historyIntervalMs);

    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            closeSSE();
        } else {
            initSSE();
            state.metaQueue = [];
            fetchNowPlaying(true);
            fetchHistory(); 
        }
    });

    window.addEventListener("pagehide", () => {
        closeSSE();
    });

    window.addEventListener("pageshow", () => {
        initSSE();
        fetchNowPlaying(true);
        fetchHistory();
    });

    // Немедленно обновляем историю когда трек сменяется,
    // не дожидаясь следующего цикла fetchHistory (до 20 сек).
    window.addEventListener('track-changed', () => {
        if (!state.historyTimeline.length) return;
        const tracks = state.historyTimeline.map(x => x.track);
        const visible = tracks.filter((t, idx) => !(idx === 0 && t === state.currentDisplayedTrack));
        renderHistory(visible.length === 0 ? ["История пуста..."] : visible.slice(0, 3));
    });
}
