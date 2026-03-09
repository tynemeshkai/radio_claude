import { state, DOM } from './store.js';
import { isGenericTrackTitle } from './utils.js';

// ─── Конфигурация сервисов ───
const SERVICES = {
    apple:   (q) => `https://music.apple.com/search?term=${q}`,
    spotify: (q) => `https://open.spotify.com/search/${q}`,
    yandex:  (q) => `https://music.yandex.ru/search?text=${q}`,
    youtube: (q) => `https://music.youtube.com/search?q=${q}`
};

// ─── Состояние попапа ───
let popup = null;
let searchBtn = null;
let isOpen = false;
let hideTimer = null;

// ─── Построение поискового запроса из текущего трека ───
function getSearchQuery() {
    // Проверяем через state — не через захардкоженные строки из DOM
    if (!state.currentDisplayedTrack || isGenericTrackTitle(state.currentDisplayedTrack)) return null;

    const artist = DOM.artistEl.innerText.trim();
    const title  = DOM.titleEl.innerText.trim();
    if (!artist || !title) return null;

    // Для поиска берем "Artist Title" (без тире — сервисы лучше находят)
    return encodeURIComponent(`${artist} ${title}`);
}

// ─── Открытие / закрытие попапа ───
export function toggleSearchPopup(e) {
    if (e) e.stopPropagation();
    if (!popup) return;

    if (isOpen) {
        closeSearchPopup();
        return;
    }

    // Нечего искать — не открываем
    if (!getSearchQuery()) return;

    if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
    }

    popup.classList.remove('noop', 'sp-disappear');
    popup.classList.add('sp-appear');
    isOpen = true;
}

export function closeSearchPopup() {
    if (!popup || !isOpen) return;

    popup.classList.remove('sp-appear');
    popup.classList.add('sp-disappear');
    isOpen = false;

    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
        popup.classList.remove('sp-disappear');
        popup.classList.add('noop');
        hideTimer = null;
    }, 300);
}

// ─── Переход в музыкальный сервис ───
function openService(serviceKey) {
    const query = getSearchQuery();
    if (!query) return;

    const buildUrl = SERVICES[serviceKey];
    if (!buildUrl) return;

    window.open(buildUrl(query), '_blank');
    closeSearchPopup();
}

// ─── Инициализация ───
export function initSearch() {
    popup     = document.getElementById('search-popup');
    searchBtn = document.getElementById('search-btn');
    if (!popup || !searchBtn) return;

    // Кнопка в статус-баре
    searchBtn.addEventListener('click', toggleSearchPopup);

    // Кнопки сервисов внутри попапа
    popup.querySelectorAll('[data-service]').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            openService(el.dataset.service);
        });
    });

    // Закрытие по тапу на бэкдроп (за пределами карточки)
    popup.addEventListener('click', (e) => {
        // Клик именно по оверлею, не по карточке
        if (e.target === popup) closeSearchPopup();
    });

    // Закрытие по тапу вне попапа и кнопки
    document.addEventListener('click', (e) => {
        if (isOpen && !popup.contains(e.target) && !searchBtn.contains(e.target)) {
            closeSearchPopup();
        }
    });

    document.addEventListener('touchstart', (e) => {
        if (isOpen && !popup.contains(e.target) && !searchBtn.contains(e.target)) {
            closeSearchPopup();
        }
    }, { passive: true });

    // Закрытие по Escape (десктоп)
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isOpen) closeSearchPopup();
    });
}