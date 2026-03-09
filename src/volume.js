// ==============================================================================
// VOLUME CONTROL — ползунок громкости для десктопа, mute для мобилок
// ==============================================================================
import { DOM } from './store.js';

const IS_MOBILE = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

let slider = null;
let sliderWrap = null;
let isOpen = false;
let hideTimer = null;
let isDragging = false;

// --- Сохранение/загрузка громкости ---
function loadVolume() {
    try {
        const v = parseFloat(localStorage.getItem('radio_volume'));
        if (Number.isFinite(v)) return Math.max(0, Math.min(1, v));
    } catch (e) {}
    return 1;
}

function saveVolume(v) {
    try { localStorage.setItem('radio_volume', String(v)); } catch (e) {}
}

// --- Обновление иконки ---
function updateIcon() {
    if (DOM.audio.muted || DOM.audio.volume === 0) {
        DOM.muteBtn.classList.add('muted');
    } else {
        DOM.muteBtn.classList.remove('muted');
    }
}

// --- Установка громкости ---
function setVolume(v) {
    v = Math.max(0, Math.min(1, v));
    DOM.audio.volume = v;
    DOM.audio.muted = v === 0;
    saveVolume(v);
    updateIcon();
    if (slider) {
        slider.value = v;
        updateSliderTrack(v);
    }
}

// --- Визуальное заполнение трека слайдера ---
function updateSliderTrack(v) {
    if (!slider) return;
    const pct = v * 100;
    slider.style.setProperty('--vol-pct', `${pct}%`);
}

// --- Создание DOM слайдера (один раз) ---
function createSlider() {
    if (sliderWrap) return;

    sliderWrap = document.createElement('div');
    sliderWrap.className = 'volume-popup';

    slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '1';
    slider.step = '0.01';
    slider.value = DOM.audio.muted ? 0 : DOM.audio.volume;
    slider.className = 'volume-slider';
    updateSliderTrack(DOM.audio.muted ? 0 : DOM.audio.volume);

    // --- Events ---
    slider.addEventListener('input', (e) => {
        setVolume(parseFloat(e.target.value));
    });

    // Блокируем всплытие кликов на кнопку (иначе mute toggle срабатывает)
    slider.addEventListener('click', (e) => { e.stopPropagation(); });
    slider.addEventListener('mousedown', (e) => { e.stopPropagation(); isDragging = true; });
    slider.addEventListener('mouseup', () => { isDragging = false; });

    sliderWrap.addEventListener('click', (e) => { e.stopPropagation(); });

    // Колёсико мыши по слайдеру
    sliderWrap.addEventListener('wheel', (e) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.05 : 0.05;
        setVolume(DOM.audio.volume + delta);
    }, { passive: false });

    sliderWrap.appendChild(slider);

    // Вставляем popup внутрь кнопки (она position:relative)
    DOM.muteBtn.appendChild(sliderWrap);
}

// --- Показать/скрыть ползунок ---
function showSlider() {
    if (isOpen) return;
    createSlider();

    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }

    slider.value = DOM.audio.muted ? 0 : DOM.audio.volume;
    updateSliderTrack(parseFloat(slider.value));

    sliderWrap.classList.remove('vol-hide');
    sliderWrap.classList.add('vol-show');
    isOpen = true;
}

function hideSlider() {
    if (!isOpen || !sliderWrap) return;
    if (isDragging) return;

    sliderWrap.classList.remove('vol-show');
    sliderWrap.classList.add('vol-hide');
    isOpen = false;

    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
        hideTimer = null;
    }, 300);
}

// ==============================================================================
// EXPORT: Единая точка входа
// ==============================================================================
export function initVolumeControl() {
    // Восстанавливаем громкость
    const saved = loadVolume();
    DOM.audio.volume = saved;
    updateIcon();

    if (IS_MOBILE) {
        // ─── Мобилки: просто mute/unmute ───
        DOM.muteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            DOM.audio.muted = !DOM.audio.muted;
            updateIcon();
        });
    } else {
        // ─── Десктоп: hover = ползунок, клик = mute toggle ───
        let hoverTimer = null;

        DOM.muteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (DOM.audio.muted) {
                DOM.audio.muted = false;
                setVolume(loadVolume() || 0.5);
            } else {
                DOM.audio.muted = true;
                updateIcon();
                if (slider) { slider.value = 0; updateSliderTrack(0); }
            }
        });

        DOM.muteBtn.addEventListener('mouseenter', () => {
            if (hoverTimer) clearTimeout(hoverTimer);
            showSlider();
        });

        DOM.muteBtn.addEventListener('mouseleave', (e) => {
            // Не прятать если курсор ушёл на popup (он внутри кнопки)
            if (sliderWrap && sliderWrap.contains(e.relatedTarget)) return;
            hoverTimer = setTimeout(() => {
                if (!isDragging) hideSlider();
            }, 400);
        });

        // Колёсико мыши по кнопке звука
        DOM.muteBtn.addEventListener('wheel', (e) => {
            e.preventDefault();
            const delta = e.deltaY > 0 ? -0.05 : 0.05;
            setVolume(DOM.audio.volume + delta);
            showSlider();
        }, { passive: false });
    }

    // Закрытие по клику вне
    document.addEventListener('click', (e) => {
        if (!isOpen) return;
        if (DOM.muteBtn.contains(e.target)) return;
        hideSlider();
    });
}