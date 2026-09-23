// dice-3d.js — объёмные кубы (режим «3D» в dice-fx.js) на
// @3d-dice/dice-box-threejs: физика бросает, потом библиотека поворачивает
// грани на заданные значения («2d6@4,1»). Библиотека с three.js внутри весит
// ~700 КБ — грузится отдельным чанком, только когда 3D включён.

import { rollGroups } from "./dice.js";
import { preloadDiceSound, sample } from "./dice-sound.js";

const SIDES = new Set([4, 6, 8, 10, 12, 20, 100]);
const MAX_DICE = 20;
// Физика иногда не засыпает — не держим очередь дольше этого.
const ROLL_TIMEOUT = 6000;

// notation3d — «2d6+1d100» + [4, 1, 47] → «2d6+1d100+1d10@4,1,40,7». d100 —
// кубы десятков и единиц; одинаковые типы библиотека сливает в один набор,
// поэтому значения раскладываем в том же порядке. null — 3D не справится.
export function notation3d(formula, rolls) {
  const groups = rollGroups(formula, rolls);
  if (!groups || !groups.length) return null;
  const byType = new Map();
  const put = (type, v) => {
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(v);
  };
  let count = 0;
  for (const g of groups) {
    if (!SIDES.has(g.sides)) return null;
    for (const v of g.values) {
      if (g.sides === 100) {
        const tens = Math.floor((v % 100) / 10) * 10;
        put("d100", tens || 100);
        put("d10", v % 10 || 10);
        count += 2;
      } else {
        put("d" + g.sides, v);
        count += 1;
      }
    }
  }
  if (count > MAX_DICE) return null;
  const types = [...byType.keys()];
  return (
    types.map((t) => `${byType.get(t).length}${t}`).join("+") +
    "@" +
    types.flatMap((t) => byType.get(t)).join(",")
  );
}

// webglAvailable — даст ли браузер WebGL (без него 3D молча уходит в 2D).
export function webglAvailable() {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") || c.getContext("webgl");
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

let seq = 0;

// createDice3d(layer) → { roll(notation) → Promise, clear() }; null-промис,
// если WebGL/чанк недоступны — тогда dice-fx откатывается на 2D.
export async function createDice3d(layer) {
  const el = document.createElement("div");
  el.className = "dfx-box";
  el.id = "dfx-box-" + ++seq;
  el.hidden = true;
  layer.appendChild(el);
  try {
    const { default: DiceBox } = await import("@3d-dice/dice-box-threejs");
    el.hidden = false; // библиотека меряет контейнер при создании
    const box = new DiceBox("#" + el.id, {
      sounds: false,
      shadows: true,
      theme_surface: "green-felt",
      theme_customColorset: {
        name: "beacon",
        foreground: "#ffffff",
        background: "#7c6cf0",
        outline: "#2b2360",
        texture: "none",
        material: "plastic",
      },
      light_intensity: 0.9,
      gravity_multiplier: 400,
      strength: 1.2,
    });
    await box.initialize();
    // Свой звук вместо встроенного: см. dice-sound.js.
    box.sounds_table = { [box.surface]: [sample("table"), sample("table")] };
    box.sounds_dice = {
      plastic: [sample("hit"), sample("hit"), sample("hit")],
      coin: [],
    };
    box.sound_dieMaterial = "plastic";
    box.sounds = true;
    preloadDiceSound();
    el.hidden = true;

    return {
      async roll(notation) {
        el.hidden = false;
        el.classList.remove("is-out");
        const w = el.clientWidth;
        const h = el.clientHeight;
        const c = box.renderer.domElement;
        if (c.width !== w || c.height !== h) box.setDimensions({ x: w, y: h });
        await Promise.race([
          box.roll(notation),
          new Promise((r) => setTimeout(r, ROLL_TIMEOUT)),
        ]);
      },
      fadeOut() {
        el.classList.add("is-out");
      },
      clear() {
        box.clearDice();
        el.hidden = true;
      },
    };
  } catch (e) {
    console.warn("3D-кубы недоступны, остаёмся на 2D:", e);
    el.remove();
    return null;
  }
}
