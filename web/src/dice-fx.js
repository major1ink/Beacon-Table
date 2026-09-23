// dice-fx.js — анимация броска поверх карты. Значения уже брошены сервером,
// анимация подгоняется под них. По умолчанию 2D на SVG — легко и идёт на
// телевизоре; объёмные кубы (dice-3d.js) — отдельный режим по выбору.

import { rollGroups } from "./dice.js";
import { icon } from "./icons.js";
import { createDice3d, notation3d, webglAvailable } from "./dice-3d.js";
import { diceSoundOn, playRollSound, preloadDiceSound } from "./dice-sound.js";

const MODE_KEY = "beacon:diceFx";
export const DICE_FX_MODES = [
  ["3d", "Объёмная (3D)"],
  ["full", "Полная"],
  ["lite", "Упрощённая"],
  ["off", "Выключена"],
];

export function diceFxMode() {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (DICE_FX_MODES.some(([id]) => id === v)) return v;
  } catch {
    /* приватный режим */
  }
  if (typeof matchMedia !== "function") return "full";
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return "off";
  if (matchMedia("(pointer: coarse) and (max-width: 860px)").matches)
    return "lite";
  return "full";
}

export function setDiceFxMode(mode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* приватный режим */
  }
}

export function initDiceFxSelect(select) {
  if (!select) return;
  select.innerHTML = DICE_FX_MODES.map(
    ([id, label]) => `<option value="${id}">${label}</option>`,
  ).join("");
  select.value = diceFxMode();
  const warn = document.createElement("p");
  warn.className = "hint dfx-warn";
  warn.textContent =
    "Браузер не даёт WebGL — 3D недоступно, кубы будут плоскими. Включите аппаратное ускорение в настройках браузера.";
  select.after(warn);
  const check = () => (warn.hidden = select.value !== "3d" || webglAvailable());
  select.onchange = () => {
    setDiceFxMode(select.value);
    check();
  };
  check();
}

// Анимацию видят все, кому бросок пришёл; броски сервера без fromRole — никто.
export function shouldPlay(data) {
  return !!data && !!data.fromRole && (data.rolls || []).length > 0;
}

const TIMING = {
  full: { settle: 900, hold: 3400, out: 450 },
  lite: { settle: 320, hold: 2200, out: 300 },
  rush: { settle: 320, hold: 1200, out: 200 },
};
// 3D: сколько держать итог после того, как кубы встали.
const HOLD_3D = 3000;
const MAX_DICE = 12;
const MAX_QUEUE = 4;

// d100 — парой d10: десятки и единицы.
export function dieFaces(formula, rolls) {
  const groups = rollGroups(formula, rolls);
  const dice = groups
    ? groups.flatMap((g) => g.values.map((v) => ({ v, sides: g.sides })))
    : (rolls || []).map((v) => ({ v, sides: 0 }));
  const out = [];
  for (const d of dice) {
    if (d.sides === 100) {
      const tens = Math.floor((d.v % 100) / 10) * 10;
      out.push(
        { sides: 10, text: String(tens).padStart(2, "0"), pct: true },
        { sides: 10, text: String(d.v % 10), pct: true },
      );
      continue;
    }
    const face = { sides: d.sides, text: String(d.v) };
    if (d.sides === 20 && d.v === 20) face.crit = true;
    else if (d.sides === 20 && d.v === 1) face.fumble = true;
    out.push(face);
  }
  return out;
}

const SHAPES = {
  4: { outline: "50,6 95,88 5,88", facets: [], ty: 70 },
  6: { rect: true, facets: [], ty: 52 },
  8: { outline: "50,4 95,50 50,96 5,50", facets: ["5,50 95,50"], ty: 52 },
  10: {
    outline: "50,3 95,40 95,60 50,97 5,60 5,40",
    facets: ["5,40 30,64 50,97 70,64 95,40", "30,64 50,3 70,64"],
    ty: 46,
  },
  12: {
    outline: "50,4 96,37 78,94 22,94 4,37",
    facets: ["50,24 73,42 64,72 36,72 27,42 50,24"],
    ty: 56,
  },
  20: {
    outline: "50,3 92,26 92,74 50,97 8,74 8,26",
    facets: ["50,20 80,70 20,70 50,20"],
    ty: 57,
  },
  0: { outline: "50,4 96,50 50,96 4,50", facets: [], ty: 52 },
};

function dieSvg(sides, text) {
  const s = SHAPES[sides] || SHAPES[0];
  const body = s.rect
    ? '<rect class="dfx-body" x="10" y="10" width="80" height="80" rx="14"/>'
    : `<polygon class="dfx-body" points="${s.outline}"/>`;
  const facets = s.facets
    .map((pts) => `<polyline class="dfx-facet" points="${pts}"/>`)
    .join("");
  const size = text.length > 2 ? 30 : 36;
  return `<svg viewBox="0 0 100 100" aria-hidden="true">${body}${facets}<text class="dfx-num" x="50" y="${s.ty}" font-size="${size}">${text}</text></svg>`;
}

// play резолвится, когда кубы встали (или сразу, если не показываем).
// getMode — режим не из настроек устройства (трансляции его задаёт ДМ).
export function createDiceFx(host, { role, getMode } = {}) {
  const layer = document.createElement("div");
  layer.className = "dice-fx" + (role === "tv" ? " dice-fx--tv" : "");
  layer.setAttribute("aria-hidden", "true");
  host.appendChild(layer);

  const queue = [];
  let busy = false;
  let dice3d = null;
  if (diceSoundOn()) preloadDiceSound();

  // warm — собрать 3D-сцену кубов заранее, в простое: сборка — long task
  // ~120 мс, и без прогрева он приходился на первый бросок, когда на кубы
  // смотрят все.
  function warm() {
    if ((getMode ? getMode() : diceFxMode()) !== "3d") return;
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 2000));
    idle(() => (dice3d ??= createDice3d(layer)), { timeout: 5000 });
  }
  warm();

  function play(data) {
    const mode = getMode ? getMode() : diceFxMode();
    if (mode === "off" || !shouldPlay(data)) return Promise.resolve();
    return new Promise((resolve) => {
      queue.push({ data, mode, resolve });
      // Затор — старое сразу в лог.
      while (queue.length > MAX_QUEUE) queue.shift().resolve();
      if (!busy) next();
    });
  }

  function next() {
    const item = queue.shift();
    if (!item) {
      busy = false;
      return;
    }
    busy = true;
    // Догоняем очередь.
    const mode = queue.length ? "rush" : item.mode;
    run(item.data, mode, item.resolve).then(next);
  }

  async function run(data, mode, onSettle) {
    if (mode === "3d") {
      const notation = notation3d(data.formula, data.rolls);
      if (notation) {
        dice3d ??= createDice3d(layer);
        const box = await dice3d;
        if (box) return run3d(box, notation, data, onSettle);
      }
      mode = "full";
    }
    return run2d(data, mode, onSettle);
  }

  // Шапка «кто» и итог — общие для 2D и 3D.
  function makeStage(data, mode) {
    const stage = document.createElement("div");
    stage.className = `dfx-stage dfx-${mode}`;
    const who = document.createElement("div");
    who.className = "dfx-who";
    who.textContent = data.label
      ? `${data.name} — ${data.label}`
      : data.name || "";
    if (data.hidden)
      who.insertAdjacentHTML("afterbegin", icon("eye-off", { size: 14 }));
    stage.appendChild(who);
    const sum = document.createElement("div");
    sum.className = "dfx-sum";
    if (data.modifier) {
      const mod = document.createElement("span");
      mod.className = "dfx-mod";
      mod.textContent =
        (data.modifier > 0 ? "+ " : "− ") + Math.abs(data.modifier);
      sum.appendChild(mod);
    }
    const total = document.createElement("span");
    total.className = "dfx-total";
    total.textContent = "= " + data.total;
    sum.appendChild(total);
    return { stage, sum };
  }

  async function run3d(box, notation, data, onSettle) {
    const t = TIMING.full;
    const { stage, sum } = makeStage(data, "3d");
    stage.style.setProperty("--dfx-out", t.out + "ms");
    stage.appendChild(sum);
    layer.appendChild(stage);
    await box.roll(notation);
    stage.classList.add("is-settled");
    onSettle();
    await wait(HOLD_3D);
    stage.classList.add("is-out");
    box.fadeOut();
    await wait(t.out);
    stage.remove();
    box.clear();
  }

  function run2d(data, mode, onSettle) {
    const t = TIMING[mode];
    const { stage, sum } = makeStage(data, mode);
    stage.style.setProperty("--dfx-out", t.out + "ms");

    const row = document.createElement("div");
    row.className = "dfx-row";
    const faces = dieFaces(data.formula, data.rolls);
    const shown =
      faces.length > MAX_DICE ? faces.slice(0, MAX_DICE - 1) : faces;
    const els = shown.map((f, i) => {
      const el = document.createElement("div");
      el.className =
        "dfx-die" +
        (f.crit ? " is-crit" : f.fumble ? " is-fumble" : "") +
        (f.pct ? " is-pct" : "");
      el.style.setProperty(
        "--dfx-x",
        Math.round((Math.random() - 0.5) * 240) + "px",
      );
      el.style.setProperty(
        "--dfx-r",
        Math.round(360 + Math.random() * 540) * (Math.random() < 0.5 ? -1 : 1) +
          "deg",
      );
      el.style.animationDelay = i * 40 + "ms";
      el.innerHTML = dieSvg(f.sides, spinText(f));
      row.appendChild(el);
      return el;
    });
    if (faces.length > shown.length) {
      const more = document.createElement("span");
      more.className = "dfx-more";
      more.textContent = `+${faces.length - shown.length}`;
      row.appendChild(more);
    }
    row.appendChild(sum);
    stage.appendChild(row);
    layer.appendChild(stage);
    playRollSound(shown.length, t.settle);

    const spin = setInterval(() => {
      els.forEach(
        (el, i) =>
          (el.querySelector(".dfx-num").textContent = spinText(shown[i])),
      );
    }, 70);

    return new Promise((done) => {
      setTimeout(() => {
        clearInterval(spin);
        els.forEach(
          (el, i) => (el.querySelector(".dfx-num").textContent = shown[i].text),
        );
        stage.classList.add("is-settled");
        onSettle();
      }, t.settle);
      setTimeout(() => stage.classList.add("is-out"), t.hold);
      setTimeout(() => {
        stage.remove();
        done();
      }, t.hold + t.out);
    });
  }

  return { play, warm, el: layer };
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function spinText(face) {
  const sides = face.sides || 20;
  if (face.pct)
    return face.text.length === 2
      ? String(Math.floor(Math.random() * 10) * 10).padStart(2, "0")
      : String(Math.floor(Math.random() * 10));
  return String(1 + Math.floor(Math.random() * sides));
}
