// dice-sound.js — стук кубов. WebAudio, а не <audio>: загрузка не ждёт
// canplaythrough (на iOS и ТВ без жеста его нет) и один буфер играет сколько
// угодно раз внахлёст. Сэмплы — из @3d-dice/dice-box-threejs (MIT).

const BASE = "/dice/sounds/";
const HITS = Array.from(
  { length: 15 },
  (_, i) => `dicehit_plastic${i + 1}.mp3`,
);
const TABLE = Array.from({ length: 4 }, (_, i) => `surface_felt${i + 1}.mp3`);
const SOUND_KEY = "beacon:diceSound";
// Общий с audio.js ползунок «Эффекты».
const SFX_VOL_KEY = "beacon-vol-sfx";

let ac = null;
let loading = null;
const buffers = { hit: [], table: [] };

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// По умолчанию звук есть везде, кроме телефона: за общим столом щёлкающие
// телефоны — шум, звук даёт трансляция.
export function diceSoundOn() {
  const v = read(SOUND_KEY);
  if (v === "1" || v === "0") return v === "1";
  return !(
    typeof matchMedia === "function" &&
    matchMedia("(pointer: coarse) and (max-width: 860px)").matches
  );
}

export function setDiceSoundOn(on) {
  try {
    localStorage.setItem(SOUND_KEY, on ? "1" : "0");
  } catch {
    /* приватный режим */
  }
}

export function initDiceSoundToggle(input) {
  if (!input) return;
  input.checked = diceSoundOn();
  input.onchange = () => setDiceSoundOn(input.checked);
}

function volume() {
  const v = parseFloat(read(SFX_VOL_KEY));
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
}

function context() {
  if (ac) return ac;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ac = new AC();
  // Браузер пускает звук только после жеста — ловим любой.
  const resume = () => ac.state === "suspended" && ac.resume().catch(() => {});
  for (const ev of ["pointerdown", "keydown", "touchend"])
    document.addEventListener(ev, resume, { capture: true, passive: true });
  return ac;
}

// preloadDiceSound — загрузить сэмплы заранее, чтобы первый бросок не был немым.
export function preloadDiceSound() {
  if (loading) return loading;
  const ctx = context();
  if (!ctx) return (loading = Promise.resolve());
  const load = (name) =>
    fetch(BASE + name)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status)))
      .then((b) => new Promise((ok, fail) => ctx.decodeAudioData(b, ok, fail)))
      .catch(() => null);
  loading = Promise.all([
    Promise.all(HITS.map(load)),
    Promise.all(TABLE.map(load)),
  ]).then(([hit, table]) => {
    buffers.hit = hit.filter(Boolean);
    buffers.table = table.filter(Boolean);
  });
  return loading;
}

function play(kind, gain = 1, at = 0) {
  if (!ac || ac.state !== "running" || !diceSoundOn()) return;
  const list = buffers[kind];
  if (!list.length) return;
  const src = ac.createBufferSource();
  src.buffer = list[Math.floor(Math.random() * list.length)];
  const g = ac.createGain();
  g.gain.value = Math.max(0, Math.min(1, gain)) * volume();
  src.connect(g).connect(ac.destination);
  src.start(ac.currentTime + at);
}

// sample — объект под интерфейс звука dice-box-threejs (volume + play()):
// так 3D-кубы стучат по столкновениям физики, но через наш канал.
export function sample(kind) {
  return {
    volume: 1,
    play() {
      play(kind, this.volume * 1.6);
      return Promise.resolve();
    },
  };
}

// playRollSound — стук для 2D: кубы катятся duration мс и затихают.
export function playRollSound(count, duration) {
  preloadDiceSound();
  const n = Math.min(count, 6);
  play("table", 0.5);
  for (let i = 0; i < n * 3; i++) {
    const t = (Math.random() ** 1.6 * duration) / 1000;
    play("hit", 0.55 * (1 - t / (duration / 1000)) + 0.1, t);
  }
}
