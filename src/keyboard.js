// ==============================================================================
// KEYBOARD SHORTCUTS — горячие клавиши для десктопа
// ==============================================================================
import { DOM } from './store.js';
import { togglePlay } from './player.js';

export function initKeyboard() {
    // Не вешаем на мобилки (любое touch-устройство)
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) return;

    document.addEventListener('keydown', (e) => {
        // Игнорируем если фокус в input/textarea (например search popup)
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

        switch (e.code) {
            case 'Space':
                e.preventDefault();
                togglePlay();
                break;

            case 'ArrowUp':
                e.preventDefault();
                DOM.audio.muted = false;
                DOM.audio.volume = Math.min(1, DOM.audio.volume + 0.05);
                break;

            case 'ArrowDown':
                e.preventDefault();
                DOM.audio.muted = false;
                DOM.audio.volume = Math.max(0, DOM.audio.volume + (-0.05));
                break;

            case 'KeyM':
                DOM.audio.muted = !DOM.audio.muted;
                break;
        }
    });
}