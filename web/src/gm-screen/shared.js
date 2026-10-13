// Общее для страницы ширмы: состояние, данные мира, мелкие помощники.
import { fetchConditions, fetchReferences, fetchJournal } from "../api.js";
import { openFloatingWindow } from "../floating-window.js";
import { withRollMode } from "../roll-mode.js";
import { moduleTitle, moduleAttribution } from "../system-profile.js";

// Правило для ширмы — карточка справочника с этим тегом.
export const RULE_TAG = "ширма";

export const ctx = {
  gm: false,
  screen: { tabs: [] },
  socket: null,
  editing: false,
  render: () => {},
  persist: async () => {},
  // saveQuiet — сохранить без перерисовки (счётчик, таймер).
  saveQuiet: () => {},
};

export const el = (tag, attrs = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n[k] = v;
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of [].concat(kids)) if (kid) n.append(kid);
  return n;
};

const hostWindow = () => (window.opener && window.opener !== window ? window.opener : window.parent);

// Окно десктопа живёт без стола — карточки открываем прямо в нём.
export function openInHost(key, title, url, navigate = false) {
  const host = hostWindow();
  if (host === window) openFloatingWindow({ key, title, url, navigate, width: 900, height: 640 });
  else host.postMessage({ type: "beacon:openFloatingWindow", key, title, url, navigate }, location.origin);
}

export function sendRoll(formula, label) {
  if (ctx.socket) ctx.socket.send(withRollMode({ type: "roll_dice", formula, label }));
}

// Английское название в скобках, как в карточках модулей, на ширме лишнее.
export const shortName = (name) => String(name || "").replace(/\s*\[[^\]]*\]\s*$/, "");

export function sourceLine(card) {
  if (!card.system) return el("div", { class: "attribution", text: "Библиотека мира" });
  const attribution = moduleAttribution(card.module);
  return el("div", { class: "attribution", text: moduleTitle(card.module), title: attribution ? "Источник: " + attribution : "" });
}

export const isRule = (card) => (card.tags || []).some((tag) => tag.trim().toLowerCase() === RULE_TAG);

// ---- данные мира, по запросу и с кешем до сигнала об изменении ----

const cache = {};
const load = (key, fetcher) => (cache[key] ||= fetcher().catch(() => []));

export const data = {
  conditions: () => load("conditions", () => fetchConditions().then((list) => list.sort((a, b) => a.name.localeCompare(b.name, "ru")))),
  references: () => load("references", fetchReferences),
  journal: () => load("journal", fetchJournal),
  forget(...keys) {
    for (const k of keys) delete cache[k];
  },
};

export function newCellId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
