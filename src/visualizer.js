import { DOM, state } from './store.js';
import { isIOS, debugLine } from './utils.js';

// ==============================================================================
// VISUALIZER v2 — 3 режима: bars / waveform / mirror
// Переключение по клику на канвас. Чёрный цвет. Safari = фейк-данные.
// ==============================================================================

const MIN = 0.08;
const MAX = 0.75;
const BARS_COUNT = 11;
const MODES = ['bars', 'waveform', 'mirror'];

let audioCtx = null;
let analyser = null;
let sourceNode = null;
let dataArray = null;       // frequency data (bars, mirror)
let timeDomainData = null;  // waveform data
let rafId = 0;
let isRunning = false;
let isInitialized = false;
let _modeSwitchInited = false;

// Canvas
let ctx = null;
let canvasW = 0;
let canvasH = 0;

// Режим визуализации
let currentMode = 0; // индекс в MODES

// 🚀 РЕШЕНИЕ: Детектим ЛЮБОЙ Safari (iOS + macOS)
// Регулярка проверяет наличие "safari", но исключает Chrome и Android (которые тоже пишут safari в UserAgent)
const isSafariBrowser = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

// Apple WebKit блокирует AnalyserNode для HLS-потоков (отдает нули). 
// Поэтому для всех яблочных браузеров включаем генеративную анимацию.
const useFakeVisualizer = isIOS || isSafariBrowser;

const currentNoises = new Array(BARS_COUNT).fill(0);
const targetNoises = new Array(BARS_COUNT).fill(0);

// Gravity: текущие высоты столбиков для плавного падения
const currentHeights = new Array(BARS_COUNT).fill(MIN);
const velocities = new Array(BARS_COUNT).fill(0);
const GRAVITY = 0.003;   // ускорение падения
const ATTACK = 0.35;     // скорость подъёма (0-1, чем больше тем резче)

// Загрузка сохранённого режима
try {
    const saved = localStorage.getItem('radio_viz_mode');
    if (saved && MODES.includes(saved)) {
        currentMode = MODES.indexOf(saved);
    }
} catch (e) {}

// ==============================================================================
// CANVAS INIT
// ==============================================================================
export function resizeCanvas() {
    if (!DOM.eqCanvas || !DOM.eqContainer) return;

    const rect = DOM.eqContainer.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    DOM.eqCanvas.width = rect.width * dpr;
    DOM.eqCanvas.height = rect.height * dpr;
    canvasW = rect.width;
    canvasH = rect.height;

    ctx = DOM.eqCanvas.getContext('2d');
    ctx.scale(dpr, dpr);

    if (!isRunning) {
        drawIdle();
    }
}

// ==============================================================================
// CLICK TO SWITCH MODE
// ==============================================================================
function initModeSwitch() {
    if (_modeSwitchInited || !DOM.eqCanvas) return;
    _modeSwitchInited = true;
    DOM.eqCanvas.addEventListener('click', () => {
        currentMode = (currentMode + 1) % MODES.length;
        try {
            localStorage.setItem('radio_viz_mode', MODES[currentMode]);
        } catch (e) {}
        // Сбрасываем gravity при смене режима
        currentHeights.fill(MIN);
        velocities.fill(0);
    });
    // Курсор pointer чтобы юзер понимал что кликабельно
    DOM.eqCanvas.style.cursor = 'pointer';
}

// ==============================================================================
// DATA: получение значений для bars (frequency)
// ==============================================================================
function getBarTargets() {
    const targets = new Array(BARS_COUNT).fill(MIN);

    if (!state.isPlaying || DOM.audio.paused) return targets;

    if (useFakeVisualizer) {
        const time = Date.now();
        for (let i = 0; i < BARS_COUNT; i++) {
            if (Math.random() < 0.08) targetNoises[i] = Math.random() * 0.15;
            currentNoises[i] += (targetNoises[i] - currentNoises[i]) * 0.15;

            const speed = 150 - (i * 5);
            const wave = (Math.sin(time / speed + i * 0.5) + 1) / 2;
            let value = wave * 0.7 + currentNoises[i];
            if (i > BARS_COUNT / 2) value *= 0.8;

            targets[i] = Math.max(MIN, Math.min(MAX, MIN + value * (MAX - MIN)));
        }
    } else if (analyser && dataArray) {
        analyser.getByteFrequencyData(dataArray);
        const minBin = 1;
        const maxBin = 370;

        for (let i = 0; i < BARS_COUNT; i++) {
            const startX = i / BARS_COUNT;
            const endX = (i + 1) / BARS_COUNT;
            const startIndex = Math.floor(minBin * Math.pow(maxBin / minBin, startX));
            const endIndex = Math.floor(minBin * Math.pow(maxBin / minBin, endX));

            let maxVal = 0;
            for (let b = startIndex; b <= Math.max(startIndex, endIndex); b++) {
                if (dataArray[b] > maxVal) maxVal = dataArray[b];
            }

            let value = maxVal / 255;
            value *= 1 + (i / BARS_COUNT) * 1.4; // treble boost
            value = Math.pow(value, 1.4);         // power curve

            targets[i] = Math.max(MIN, Math.min(MAX, MIN + value * (MAX - MIN)));
        }
    }

    return targets;
}

// ==============================================================================
// DATA: получение waveform
// ==============================================================================
function getWaveformData() {
    // Возвращает массив нормализованных значений 0..1 (0.5 = тишина)
    const points = 64; // сколько точек рисуем
    const result = new Float32Array(points);

    if (!state.isPlaying || DOM.audio.paused) {
        result.fill(0.5);
        return result;
    }

    if (useFakeVisualizer) {
        const time = Date.now();
        for (let i = 0; i < points; i++) {
            const x = i / points;
            const wave1 = Math.sin(time / 200 + x * Math.PI * 4) * 0.15;
            const wave2 = Math.sin(time / 350 + x * Math.PI * 7) * 0.08;
            const wave3 = Math.sin(time / 500 + x * Math.PI * 2) * 0.05;
            result[i] = 0.5 + wave1 + wave2 + wave3;
        }
    } else if (analyser && timeDomainData) {
        analyser.getByteTimeDomainData(timeDomainData);
        const step = Math.floor(timeDomainData.length / points);
        for (let i = 0; i < points; i++) {
            result[i] = timeDomainData[i * step] / 255;
        }
    } else {
        result.fill(0.5);
    }

    return result;
}

// ==============================================================================
// GRAVITY: плавное падение столбиков
// ==============================================================================
function applyGravity(targets) {
    for (let i = 0; i < BARS_COUNT; i++) {
        const target = targets[i];

        if (target > currentHeights[i]) {
            // Подъём — быстрый attack
            currentHeights[i] += (target - currentHeights[i]) * ATTACK;
            velocities[i] = 0;
        } else {
            // Падение — gravity
            velocities[i] += GRAVITY;
            currentHeights[i] -= velocities[i];
        }

        // Clamp
        if (currentHeights[i] < MIN) {
            currentHeights[i] = MIN;
            velocities[i] = 0;
        }
        if (currentHeights[i] > MAX) {
            currentHeights[i] = MAX;
        }
    }

    return currentHeights;
}

// ==============================================================================
// DRAW: Bars (улучшенные с gravity)
// ==============================================================================
function drawBars(heights) {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvasW, canvasH);
    ctx.fillStyle = '#000000';

    const step = canvasW / BARS_COUNT;
    const barWidth = Math.ceil(step);

    for (let i = 0; i < BARS_COUNT; i++) {
        const barHeight = heights[i] * canvasH;
        const x = Math.floor(i * step);
        const y = canvasH - barHeight;
        ctx.fillRect(x, y, barWidth, barHeight);
    }
}

// ==============================================================================
// DRAW: Waveform (осциллограмма)
// ==============================================================================
function drawWaveform(waveData) {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvasW, canvasH);

    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 4;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();

    const points = waveData.length;
    const sliceWidth = canvasW / (points - 1);

    for (let i = 0; i < points; i++) {
        const x = i * sliceWidth;
        // Центрируем и масштабируем: 0.5 = центр, амплитуду усиливаем для визуального эффекта
        const deviation = (waveData[i] - 0.5) * 2.5;
        const y = canvasH * 0.5 - deviation * canvasH * 0.4;

        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }

    ctx.stroke();

    // Рисуем тонкую центральную линию (нулевой уровень)
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, canvasH * 0.5);
    ctx.lineTo(canvasW, canvasH * 0.5);
    ctx.stroke();
}

// ==============================================================================
// DRAW: Mirror bars (от центра вверх и вниз)
// ==============================================================================
function drawMirrorBars(heights) {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvasW, canvasH);
    ctx.fillStyle = '#000000';

    const step = canvasW / BARS_COUNT;
    const barWidth = Math.ceil(step);
    const centerY = canvasH * 0.5;

    for (let i = 0; i < BARS_COUNT; i++) {
        // Половина высоты — вверх от центра, половина — вниз
        const halfHeight = (heights[i] * canvasH) * 0.5;
        const x = Math.floor(i * step);

        // Верхняя часть
        ctx.fillRect(x, centerY - halfHeight, barWidth, halfHeight);
        // Нижняя часть
        ctx.fillRect(x, centerY, barWidth, halfHeight);
    }
}

// ==============================================================================
// IDLE: рисуем спокойное состояние при паузе
// ==============================================================================
function drawIdle() {
    const mode = MODES[currentMode];
    if (mode === 'waveform') {
        const idle = new Float32Array(64).fill(0.5);
        drawWaveform(idle);
    } else if (mode === 'mirror') {
        drawMirrorBars(new Array(BARS_COUNT).fill(MIN));
    } else {
        drawBars(new Array(BARS_COUNT).fill(MIN));
    }
}

// ==============================================================================
// MAIN LOOP
// ==============================================================================
function tick() {
    if (!isRunning) return;

    const mode = MODES[currentMode];

    if (mode === 'waveform') {
        const waveData = getWaveformData();
        drawWaveform(waveData);
    } else {
        // bars и mirror используют одни и те же frequency-данные + gravity
        const rawTargets = getBarTargets();
        const smoothed = applyGravity(rawTargets);

        if (mode === 'mirror') {
            drawMirrorBars(smoothed);
        } else {
            drawBars(smoothed);
        }
    }

    rafId = requestAnimationFrame(tick);
}

// ==============================================================================
// INIT
// ==============================================================================
function init(audioElement) {
    if (!ctx) resizeCanvas();
    initModeSwitch();

    if (useFakeVisualizer) {
        isInitialized = true;
        return;
    }
    if (isInitialized) {
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        return;
    }
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContext();

        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.minDecibels = -85;
        analyser.maxDecibels = -10;
        analyser.smoothingTimeConstant = 0.85;

        sourceNode = audioCtx.createMediaElementSource(audioElement);
        sourceNode.connect(analyser);
        analyser.connect(audioCtx.destination);

        dataArray = new Uint8Array(analyser.frequencyBinCount);
        timeDomainData = new Uint8Array(analyser.fftSize);
        isInitialized = true;
        debugLine('Web Audio API Initialized (Canvas Mode)');
    } catch (e) {
        console.error("Web Audio API Error:", e);
        debugLine('Web Audio API Failed', { error: e.message });
    }
}

// ==============================================================================
// EXPORT
// ==============================================================================
export const Visualizer = {
    init,
    resizeCanvas,
    start: () => {
        if (!isRunning) {
            isRunning = true;
            if (!ctx) resizeCanvas();
            if (!useFakeVisualizer && audioCtx && audioCtx.state === 'suspended') {
                audioCtx.resume();
            }
            rafId = requestAnimationFrame(tick);
        }
    },
    stop: () => {
        isRunning = false;
        if (rafId) cancelAnimationFrame(rafId);
        // Сбрасываем gravity
        currentHeights.fill(MIN);
        velocities.fill(0);
        drawIdle();
    }
};