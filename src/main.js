import './style.css';

import { DOM } from './store.js';
import { initViewportVars, initDebugPanel } from './utils.js';
// 1. МЕНЯЕМ ИМПОРТ: загружаем syncAllMarquees
import { toggleInfoPopup, closeInfoPopup, syncAllMarquees } from './ui.js'; 
import { initPlayer, initPlayerEvents } from './player.js';
import { startNetworkLoops, fetchHistory, fetchNowPlaying, fetchServerMeta } from './network.js';
import { initSearch } from './search.js';
import { DEBUG } from './config.js';
import { Visualizer } from './visualizer.js';
import { initKeyboard } from './keyboard.js';

if (DEBUG) console.log('🚀 Local Farts App init...');

initViewportVars();
if (DEBUG) initDebugPanel();

DOM.infoBtn.addEventListener('click', toggleInfoPopup);
document.addEventListener('click', (e) => {
    if (!DOM.infoBtn.contains(e.target) && DOM.infoPopup.classList.contains('p-apear')) closeInfoPopup();
});
document.addEventListener('touchstart', (e) => {
    if (!DOM.infoBtn.contains(e.target) && DOM.infoPopup.classList.contains('p-apear')) closeInfoPopup();
}, { passive: true });

// 2. МЕНЯЕМ RESIZE: Вызываем одну общую функцию синхронизации при повороте экрана
window.addEventListener('resize', () => {
    syncAllMarquees();
    Visualizer.resizeCanvas();
});

// Вызываем один раз при старте, чтобы отрисовать начальные спокойные столбики
Visualizer.resizeCanvas();

initPlayerEvents();
initSearch();
initKeyboard(); // ИНИЦИАЛИЗИРУЕМ ГОРЯЧИЕ КЛАВИШИ
initPlayer();

fetchHistory();
fetchNowPlaying(false);
fetchServerMeta(false);
startNetworkLoops();