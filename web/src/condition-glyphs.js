// condition-glyphs.js — набор монохромных SVG-глифов состояний (см.
// domain.Condition.Icon). Глиф хранится именем («eye-off»), рисуется в
// цвет карточки везде, где виден значок: медальон конструктора, палитра,
// чип трекера, бейдж на токене в WebGL-сцене (там — через data-URI, см.
// glyphDataURL). Эмодзи в старых карточках остаются валидным значением:
// glyphNode для незнакомого имени рисует его текстом.
//
// Контуры — 24×24, stroke currentColor, как в icons.js; тот же стиль
// линии, чтобы значок состояния не выглядел чужим рядом с иконками UI.
const STROKE = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

export const GLYPHS = {
  question: '<path d="M9 9.5a3 3 0 1 1 4.5 2.6c-1 .6-1.5 1.3-1.5 2.4"/><circle cx="12" cy="18" r=".6" fill="currentColor"/>',
  "eye-off": '<path d="M3 3l18 18"/><path d="M10.6 5.2A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1"/><path d="M6.6 6.6A16 16 0 0 0 2 12s3.5 7 10 7c1.6 0 3-.4 4.3-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  heart: '<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z"/>',
  "ear-off": '<path d="M3 3l18 18"/><path d="M6 10a6 6 0 0 1 10.5-4"/><path d="M18 10c0 3-1.5 4-2.5 5.5S14 20 11 20a3 3 0 0 1-3-3"/><path d="M9 10a3 3 0 0 1 3-3"/>',
  "battery-low": '<rect x="3" y="8" width="16" height="8" rx="2"/><path d="M21 11v2"/><path d="M6 11v2"/>',
  scream: '<circle cx="12" cy="12" r="9"/><circle cx="9" cy="10" r=".8" fill="currentColor"/><circle cx="15" cy="10" r=".8" fill="currentColor"/><ellipse cx="12" cy="15.5" rx="2" ry="2.5"/>',
  grip: '<path d="M8 12V6a2 2 0 0 1 4 0v5"/><path d="M12 11V5a2 2 0 0 1 4 0v6"/><path d="M16 11V7a2 2 0 0 1 4 0v6a7 7 0 0 1-7 7h-1a7 7 0 0 1-7-7v-2a2 2 0 0 1 3-1.7"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  ghost: '<path d="M5 20v-9a7 7 0 0 1 14 0v9l-2.3-2-2.4 2-2.3-2-2.3 2-2.4-2z"/><circle cx="9.5" cy="11" r=".8" fill="currentColor"/><circle cx="14.5" cy="11" r=".8" fill="currentColor"/>',
  zap: '<path d="M13 2L5 14h6l-1 8 9-13h-6z"/>',
  stone: '<path d="M8 4h7l5 5v7l-5 4H8l-4-4V9z"/><path d="M8 4l4 5 3-1"/><path d="M12 9v11"/>',
  flask: '<path d="M9 3h6"/><path d="M10 3v6L4.5 18.5A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-2.5L14 9V3"/><path d="M7 15h10"/>',
  prone: '<circle cx="5" cy="12" r="2"/><path d="M8 12h13"/><path d="M13 12l3 5"/><path d="M13 12l3-5"/>',
  web: '<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="8"/>',
  sparkle: '<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/><path d="M19 17l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  dizzy: '<circle cx="12" cy="12" r="9"/><path d="M7.5 8.5l3 3M10.5 8.5l-3 3M13.5 8.5l3 3M16.5 8.5l-3 3"/><path d="M9 16h6"/>',
  alert: '<path d="M12 4v10"/><circle cx="12" cy="18.5" r=".8" fill="currentColor"/>',
  brain: '<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 3 3h1V4z"/><path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-3 3h-1V4z"/>',
  wind: '<path d="M3 8h9a2.5 2.5 0 1 0-2.5-2.5"/><path d="M3 13h13a3 3 0 1 1-3 3"/><path d="M3 18h6"/>',
  hood: '<path d="M12 3C7 3 5 8 5 12v6h14v-6c0-4-2-9-7-9z"/><path d="M8.5 15c1-2 2-3 3.5-3s2.5 1 3.5 3"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  skull: '<path d="M12 3a8 8 0 0 0-8 8c0 3 1.5 5 3 6v3h10v-3c1.5-1 3-3 3-6a8 8 0 0 0-8-8z"/><circle cx="9" cy="11" r="1.5"/><circle cx="15" cy="11" r="1.5"/><path d="M10 17v3M14 17v3"/>',
  bandage: '<rect x="2" y="9" width="20" height="6" rx="3" transform="rotate(-45 12 12)"/><path d="M11 11l2 2M13 11l-2 2"/>',
  drop: '<path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z"/>',
  flame: '<path d="M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3 0-6 1-9z"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  virus: '<circle cx="12" cy="12" r="5"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>',
  mute: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9l4 6M21 9l-4 6"/>',
  swap: '<path d="M4 8h13l-3-3"/><path d="M20 16H7l3 3"/>',
  mist: '<path d="M4 9h12M6 13h14M4 17h10"/>',
  feather: '<path d="M20 4c-6 0-11 4-13 10l-3 6"/><path d="M20 4c0 6-4 11-10 12"/><path d="M8 14h6"/>',
  balloon: '<ellipse cx="12" cy="9" rx="5" ry="6"/><path d="M12 15l-1 2h2z"/><path d="M12 17c0 2-2 3-2 4"/>',
  pickaxe: '<path d="M3 21L14 10"/><path d="M11 7c3-2 7-2 10 1-2-1-5-1-7 1"/><path d="M11 7c-2 3-2 7 1 10-1-2-1-5 1-7"/>',
  zzz: '<path d="M4 15h5l-5 5h5"/><path d="M11 8h5l-5 5h5"/><path d="M16 3h4l-4 4h4"/>',
  wound: '<path d="M5 19L19 5"/><path d="M8 8l2 2M12 12l2 2M16 16l2 2"/><path d="M10 10l-2 2M14 14l-2 2"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  sword: '<path d="M4 20l10-10"/><path d="M14 10l6-6v4l-4 4"/><path d="M7 17l-3 3M9 15l2 2"/>',
  snowflake: '<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4"/><path d="M12 3l-2 2M12 3l2 2M12 21l-2-2M12 21l2-2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>',
  lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  hourglass: '<path d="M6 3h12M6 21h12"/><path d="M8 3c0 5 4 6 4 9s-4 4-4 9"/><path d="M16 3c0 5-4 6-4 9s4 4 4 9"/>',
  chain: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  // предметы без арта (см. item-glyph.js)
  box: '<path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  bow: '<path d="M4 4c8 2 14 8 16 16"/><path d="M4 4l16 16"/><path d="M14 6l4-2-2 4"/>',
  wand: '<path d="M4 20L16 8"/><path d="M15 3l1 2 2 1-2 1-1 2-1-2-2-1 2-1z"/><path d="M19 11l.5 1 1 .5-1 .5-.5 1-.5-1-1-.5 1-.5z"/>',
  scroll: '<path d="M6 4h11a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H8"/><path d="M6 4a2 2 0 0 0-2 2v2h4V6a2 2 0 0 0-2-2z"/><path d="M8 20a2 2 0 0 1-2-2v-2h12v2a2 2 0 0 1-2 2"/><path d="M10 9h6M10 13h6"/>',
  ring: '<circle cx="12" cy="14" r="6"/><path d="M9 6l3-3 3 3-3 2z"/>',
  coin: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.5h4a1.5 1.5 0 0 1 0 3h-3a1.5 1.5 0 0 0 0 3h4"/>',
};

// GLYPH_FOR_SLUG — глиф по умолчанию для состояния каталога «из коробки» и
// для импортированного из Foundry (см. condition-import.js: defaultIcon).
export const GLYPH_FOR_SLUG = {
  blinded: "eye-off",
  charmed: "heart",
  deafened: "ear-off",
  exhaustion: "battery-low",
  frightened: "scream",
  grappled: "grip",
  incapacitated: "ban",
  invisible: "ghost",
  paralyzed: "zap",
  petrified: "stone",
  poisoned: "flask",
  prone: "prone",
  restrained: "web",
  stunned: "sparkle",
  unconscious: "dizzy",
  surprised: "alert",
  concentrating: "brain",
  dodging: "wind",
  hiding: "hood",
  marked: "target",
  dead: "skull",
  stable: "bandage",
  bleeding: "drop",
  burning: "flame",
  cursed: "moon",
  diseased: "virus",
  silenced: "mute",
  transformed: "swap",
  ethereal: "mist",
  flying: "feather",
  hovering: "balloon",
  burrowing: "pickaxe",
  sleeping: "zzz",
};

export function isGlyph(icon) {
  return typeof icon === "string" && Object.prototype.hasOwnProperty.call(GLYPHS, icon);
}

export function glyphSVG(name, { size = 24, cls = "" } = {}) {
  const body = GLYPHS[name];
  if (!body) return "";
  return `<svg${cls ? ` class="${cls}"` : ""} width="${size}" height="${size}" viewBox="0 0 24 24" ${STROKE} aria-hidden="true" focusable="false">${body}</svg>`;
}

// glyphNode — «глиф или эмодзи» для HTML: SVG для известного имени, иначе
// текст как есть. alt — для скринридера (имя состояния).
export function glyphNode(icon, alt) {
  const span = document.createElement("span");
  span.className = "cond-glyph";
  if (alt) {
    span.setAttribute("role", "img");
    span.setAttribute("aria-label", alt);
  }
  if (isGlyph(icon)) span.innerHTML = glyphSVG(icon);
  else span.textContent = icon || "❔";
  return span;
}

// glyphDataURL — тот же SVG для текстуры Pixi (см. vtt/layers/tokens.js:
// statusVisualNode). Цвет вшит в файл: currentColor в data-URI не работает.
export function glyphDataURL(name, color) {
  const body = GLYPHS[name];
  if (!body) return "";
  const c = /^#[0-9a-f]{6}$/i.test(String(color || "")) ? color : "#eeeeee";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body.replace(/currentColor/g, c)}</svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}
