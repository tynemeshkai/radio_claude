export const IS_LOCAL_APP = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
export const BASE_URL = IS_LOCAL_APP ? 'https://localfarts.lol' : '';

export const CONFIG = {
    hlsUrl: `${BASE_URL}/hls/master.m3u8`,
    fallbackStreamUrl: `${BASE_URL}/stream_lossless.ogg`,
    nowPlayingUrl: `${BASE_URL}/nowplaying.json`,
    statusUrl: `${BASE_URL}/status-json.xsl`,
    historyJsonUrl: `${BASE_URL}/history.json`,
    historyUrl: `${BASE_URL}/history.txt`,
    
    // 24 секунды (4 чанка по 6 сек)
    delayMs: 24000,
    
    metaMinDelayMs: 4000,
    // Расширили максимальный лимит задержки до 40 сек под новые чанки
    metaMaxDelayMs: 40000, 
    metaSafetyMs: 500,
    
    // Расширили время, после которого данные считаются протухшими
    metaStatusStaleMs: 45000, 
    metaForceSyncAfterMs: 65000,
    
    metaInterval: 10000,
    nowPlayingIntervalMs: 5000,
    nowPlayingStaleMs: 30000,
    historyIntervalMs: 20000,
    reloadCooldownMs: 5000
};

export const HLS_CONFIG = {
    autoStartLoad: true, 
    startPosition: -1, 
    lowLatencyMode: false,
    debug: false, 
    enableWorker: true,
    capLevelToPlayerSize: false,
    startLevel: -1,
    maxBufferLength: 90,
    maxMaxBufferLength: 180,
    backBufferLength: 30,
    liveSyncDurationCount: 4,
    liveMaxLatencyDurationCount: 12,
    maxLiveSyncPlaybackRate: 1.0,
    manifestLoadingTimeOut: 20000, 
    manifestLoadingMaxRetry: 10,
    fragLoadingTimeOut: 25000,
    fragLoadingMaxRetry: 10,
    levelLoadingMaxRetry: 5,
    abrBandWidthFactor: 0.8,
    abrBandWidthUpFactor: 0.6,
    highBufferWatchdogPeriod: 2,
    nudgeOffset: 0.1,
    nudgeMaxRetry: 5,
    maxBufferHole: 1.5,
};

// Проверка включенного дебаггера в URL (?debug=1)
export const DEBUG = /(?:\?|&)debug=1/.test(location.search);