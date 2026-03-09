import { DOM, state, flags } from './store.js';
import { normalizeTrackTitle, getAlignedNowMs, debugLine, supportsMediaMetadata } from './utils.js';
import { Visualizer } from './visualizer.js';

// --- ЕДИНЫЙ ДИРИЖЕР БЕГУЩИХ СТРОК (СИНХРОННЫЙ) ---
export function syncAllMarquees() {
    const els = Array.from(document.querySelectorAll('#artist-name, #track-name, .history-track-name'));

    els.forEach(el => {
        el.classList.remove('is-scrolling');
        el.style.transform = 'translateX(0)';
    });

    requestAnimationFrame(() => {
        let maxDuration = 0;
        const scrollingEls = [];

        els.forEach(el => {
            const container = el.closest('.song, .history li') || el.parentElement;
            if (!container) return;

            if (el.scrollWidth > container.clientWidth + 2) {
                const scrollDistance = container.clientWidth - el.scrollWidth - 15;
                const neededDuration = Math.max(6, Math.abs(scrollDistance) / 25);
                maxDuration = Math.max(maxDuration, neededDuration);
                scrollingEls.push({ el, dist: scrollDistance });
            }
        });

        if (scrollingEls.length === 0) return;

        void document.body.offsetWidth;

        scrollingEls.forEach(item => {
            item.el.style.setProperty('--scroll-dist', `${item.dist}px`);
            item.el.style.setProperty('--scroll-duration', `${maxDuration}s`);
            item.el.classList.add('is-scrolling');
        });
    });
}

// --- МЕТАДАННЫЕ ЭКРАНА БЛОКИРОВКИ ---
export function setMediaSessionMetadata(artist, title) {
    if (!supportsMediaMetadata) return;
    try {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: title,
            artist: artist,
            artwork: [{ src: '/album-cover.png', sizes: '512x512', type: 'image/png' }]
        });
    } catch (e) {}
}

// --- СМЕНА КНОПКИ PLAY/PAUSE И ВИЗУАЛИЗАТОРА ---
export function updateUI(active) {
    if (active) {
        DOM.playBtn.classList.add('playing');
        Visualizer.start();
    } else {
        DOM.playBtn.classList.remove('playing');
        Visualizer.stop();
    }
}

// --- ОБНОВЛЕНИЕ ТЕКСТА ТРЕКА ---
export function applyTrackChange(fullTitle, source = "unknown", trackKey = "") {
    if (flags.serverIsDown && source !== "system-error") return;

    const clean = normalizeTrackTitle(fullTitle);
    if (!clean) return;

    // Если тот же трек уже отображается — обновляем только внутреннее состояние,
    // НЕ трогаем DOM и MediaSession (убирает мерцание на экране блокировки)
    if (clean === state.currentDisplayedTrack) {
        if (trackKey) state.currentTrackKey = trackKey;
        state.currentTrackSource = source;
        state.lastTrackAppliedAt = getAlignedNowMs();
        return;
    }

    state.currentDisplayedTrack = clean;
    state.currentTrackSource = source;
    state.currentTrackKey = trackKey || clean;
    state.lastTrackAppliedAt = getAlignedNowMs();

    let artist = "", title = clean;
    if (clean.includes(" - ")) {
        const parts = clean.split(" - ");
        artist = parts[0].trim();
        title = parts.slice(1).join(" - ").trim();
    } else {
        artist = "LIVE";
    }

    DOM.artistEl.innerText = artist;
    DOM.titleEl.innerText = title;
    setMediaSessionMetadata(artist, title);
    debugLine("track applied", { title: clean, source, trackKey: state.currentTrackKey });
    
    // Синхронизируем анимации после смены названия
    requestAnimationFrame(() => syncAllMarquees());
    
    window.dispatchEvent(new CustomEvent('track-changed'));
}

// --- ОТРИСОВКА ИСТОРИИ ---
export function renderHistory(items) {
    DOM.historyListEl.textContent = '';
    const frag = document.createDocumentFragment();
    items.forEach(t => {
        const li = document.createElement('li');
        const span = document.createElement('span');
        span.textContent = t;
        span.className = 'history-track-name selectable-text';
        li.appendChild(span);
        frag.appendChild(li);
    });
    DOM.historyListEl.appendChild(frag);

    // Синхронизируем анимации после рендера истории
    requestAnimationFrame(() => syncAllMarquees());
}

// --- ЛОГИКА ПОПАПА ИНФО ---
let infoHideTimer = null;

export function closeInfoPopup() {
    if (!DOM.infoPopup.classList.contains('p-apear')) return; 
    DOM.infoPopup.classList.remove('p-apear');
    DOM.infoPopup.classList.add('p-disapear');
    
    if (infoHideTimer) clearTimeout(infoHideTimer);
    infoHideTimer = setTimeout(() => {
        DOM.infoPopup.classList.remove('p-disapear');
        DOM.infoPopup.classList.add('noop');
        infoHideTimer = null;
    }, 300);
}

export function toggleInfoPopup(e) {
    if (e) e.stopPropagation(); 
    if (DOM.infoPopup.classList.contains('p-apear')) {
        closeInfoPopup();
    } else {
        if (infoHideTimer) {
            clearTimeout(infoHideTimer);
            infoHideTimer = null;
        }
        DOM.infoPopup.classList.remove('noop');
        DOM.infoPopup.classList.remove('p-disapear');
        DOM.infoPopup.classList.add('p-apear');
    }
}