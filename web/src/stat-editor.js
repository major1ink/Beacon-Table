// stat-editor.js — редактор модификаторов (domain.Modifier) в виде
// статблока: «Показатель · База · Изменение · Итог» для КД, скорости, хитов
// и инициативы (цели ядра), ниже — цели системы мира (у D&D — шесть
// характеристик) и свободные характеристики листа (stat.<ключ>), которые ДМ
// заводит по названию. Изменение пишется формулой в ячейку:
// «10» — поставить, «−2»/«+2» — прибавить, «>=10» — не ниже, «<=5» — не
// выше, «/2» — вдвое (округление вниз); несколько через «;». Кубы («−1к6») — только в строке «Хиты в ход»,
// это периодический модификатор по текущим хитам. База берётся со стенда
// (stand.js), итог считает applyModifiers — то же, что видит трекер.
//
// Массив list мутируется на месте (push/splice/Object.assign): страница
// держит его по ссылке и сливает ответ автосейва туда же (см.
// pages/conditions.js: mergeArrayInPlace).
import { el, labeled } from "./card-shell.js";
import { applyModifiers, parseValue, MODE_ADD, MODE_SET, MODE_MIN, MODE_MAX, MODE_DIV, PERIOD_NONE, PERIOD_TURN_START, PERIOD_TURN_END, TARGET_HP_CURRENT, isStatTarget, statLabel, statTarget } from "./modifiers.js";
import { fetchModifierTargets } from "./api.js";

const ROWS = [
  ["ac", "КД"],
  ["speed", "Скорость"],
  ["hp.max", "Макс. хиты"],
  ["initiative", "Инициатива"],
];
const PERIODS = [
  [PERIOD_TURN_START, "в начале хода"],
  [PERIOD_TURN_END, "в конце хода"],
];

// Цели и подписи — с сервера (см. GET /api/modifier-targets): цели ядра и
// цели системы мира (system: true), чтобы список и подписи не разъезжались с
// domain.CoreModifierTargets и module.json системы.
let targetsCache = null;
export async function loadTargets() {
  if (targetsCache) return targetsCache;
  try {
    targetsCache = await fetchModifierTargets();
  } catch {
    targetsCache = [];
  }
  return targetsCache;
}
export function targetLabel(target) {
  const t = (targetsCache || []).find((x) => x.target === target);
  if (t) return t.label;
  if (isStatTarget(target)) return statLabel(target);
  const row = ROWS.find((r) => r[0] === target);
  return row ? row[1] : target;
}
const systemTargets = () => (targetsCache || []).filter((t) => t.system);

// parseCell — одна запись формулы. null — пусто; {bad, why} — не понял;
// иначе {mode, value, perLevel}. Кубы разрешены только при opts.dice;
// суффикс «/ур» — за каждый уровень метки (см. domain.Modifier.PerLevel).
export function parseCell(raw, opts = {}) {
  let s = String(raw ?? "")
    .trim()
    .replace(/−/g, "-")
    .replace(/\s+/g, "");
  if (!s) return null;
  let perLevel = false;
  if (/\/(ур|уровень|lvl)$/i.test(s)) {
    perLevel = true;
    s = s.replace(/\/(ур|уровень|lvl)$/i, "");
  }
  let mode = null;
  // «/2», «×½», «½» — разделить; «×¼» — на четыре.
  const m = /^(?:\/|÷|[x×]1\/)(\d+)$/.exec(s) || (/^[x×]?½$/.test(s) ? [s, "2"] : null) || (/^[x×]?¼$/.test(s) ? [s, "4"] : null);
  if (m) return parseInt(m[1], 10) > 1 ? { mode: MODE_DIV, value: m[1], perLevel: false } : { bad: true, why: "Делитель — целое от 2: /2 вдвое, /4 вчетверо." };
  if (s.startsWith("=")) {
    mode = MODE_SET;
    s = s.slice(1);
  } else if (s.startsWith(">=") || s.startsWith("≥")) {
    mode = MODE_MIN;
    s = s.replace(/^(>=|≥)/, "");
  } else if (s.startsWith("<=") || s.startsWith("≤")) {
    mode = MODE_MAX;
    s = s.replace(/^(<=|≤)/, "");
  } else if (s.startsWith("+") || s.startsWith("-")) {
    mode = MODE_ADD;
  }
  if (/^[+-]?\d*[кkd]\d+([+-]\d+)?$/i.test(s)) {
    if (!opts.dice) return { bad: true, why: "Кубы — только в «Хиты в ход». Тут нужно число: −2, 10, >=10." };
    if (mode !== MODE_ADD) return { bad: true, why: "Кубы — со знаком: −1к6 урон, +1к6 лечение." };
    return { mode: MODE_ADD, value: s.replace(/k/i, "к").replace(/d/i, "к") };
  }
  if (/^[+-]?\d+$/.test(s)) {
    if (perLevel && mode !== MODE_ADD) return { bad: true, why: "«/ур» — только с прибавкой: −5/ур." };
    return { mode: mode || MODE_SET, value: String(parseInt(s, 10)), perLevel };
  }
  return { bad: true, why: "Не понял. Примеры: −2 прибавить, 10 поставить, >=10 не ниже, −5/ур за уровень." };
}

// parseCells — ячейка целиком: несколько записей через «;».
function parseCells(raw, opts) {
  const parts = String(raw ?? "")
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return [];
  const out = [];
  for (const p of parts) {
    const r = parseCell(p, opts);
    if (r && r.bad) return r;
    if (r) out.push(r);
  }
  return out;
}

export function cellText(m) {
  if (!m) return "";
  const v = String(m.value ?? "").replace(/-/g, "−");
  if (m.mode === MODE_SET) return "=" + v;
  if (m.mode === MODE_MIN) return "≥" + v;
  if (m.mode === MODE_MAX) return "≤" + v;
  if (m.mode === MODE_DIV) return v === "2" ? "×½" : v === "4" ? "×¼" : "/" + v;
  return (v.startsWith("−") || v.startsWith("+") ? v : "+" + v) + (m.perLevel ? "/ур" : "");
}
const cellsText = (mods) => mods.map(cellText).join("; ");

// renderStatEditor — list: массив модификаторов; onChange — автосейв;
// opts.stand — select из stand.js (current() → запись с stats);
// opts.periodic — показывать строку «Хиты в ход» (у предметов её нет);
// opts.readOnly — режим чтения: формула текстом, только тронутые строки.
export function renderStatEditor(list, onChange, { stand, periodic = true, readOnly = false } = {}) {
  const permanent = (target) => list.filter((m) => m.target === target && !m.period);
  // База свободной характеристики — только если она есть у записи на
  // стенде; иначе null, и итог показывает одно изменение. У цели другой
  // системы базы нет вовсе: стенд этого мира её не считает.
  const coreOrSystem = new Set([...ROWS.map(([t]) => t), ...systemTargets().map((t) => t.target)]);
  const base = (target) => {
    if (!coreOrSystem.has(target) && !isStatTarget(target)) return null;
    const v = stand && stand.current() ? stand.current().stats[target] : undefined;
    return v ?? (isStatTarget(target) ? null : 0);
  };
  const bad = new Set();
  const results = new Map();

  function paintResult(target) {
    const node = results.get(target);
    if (!node) return;
    node.innerHTML = "";
    const b = base(target);
    if (bad.has(target)) {
      node.className = node.className.replace(/ (down|up|same|bad)/g, "") + " bad";
      node.appendChild(el("b", { text: "?" }));
      return;
    }
    const mods = permanent(target).filter((m) => parseValue(m.value) !== null);
    if (b === null) {
      // Без базы итог — само изменение; в режиме чтения оно уже написано
      // формулой рядом, второй раз не повторяем.
      node.className = node.className.replace(/ (down|up|same|bad)/g, "") + " same";
      if (!readOnly) node.appendChild(el("b", { text: mods.length ? cellsText(mods) : "—" }));
      return;
    }
    const a = applyModifiers(b, target, list);
    const cls = mods.length === 0 ? "same" : a < b ? "down" : a > b ? "up" : "same";
    node.className = node.className.replace(/ (down|up|same|bad)/g, "") + " " + cls;
    node.appendChild(el("b", { text: a, "data-base": mods.length ? b : null }));
  }

  function cellInput(target, plain) {
    if (readOnly) return el("span", { class: "stat-formula", text: cellsText(permanent(target)) });
    const inp = el("input", { type: "text", value: cellsText(permanent(target)), placeholder: plain ? "—" : "−2 · 10", "aria-label": "Изменение: " + targetLabel(target), autocomplete: "off" });
    const err = el("small", { class: "stat-err", hidden: true, "aria-live": "polite" });
    const commit = () => {
      const parsed = parseCells(inp.value);
      const isBad = parsed && parsed.bad;
      inp.classList.toggle("bad", !!isBad);
      err.hidden = !isBad;
      err.textContent = isBad ? parsed.why : "";
      if (isBad) {
        bad.add(target);
        paintResult(target);
        return;
      }
      bad.delete(target);
      // Заменяем постоянные модификаторы цели на разобранные; подписи
      // (note) сохраняем по позиции — импорт из Foundry их приносит.
      const old = permanent(target);
      const next = parsed.map((p, i) => Object.assign(old[i] || { target, period: PERIOD_NONE, note: "" }, { target, mode: p.mode, value: p.value, period: PERIOD_NONE, perLevel: !!p.perLevel }));
      for (let i = list.length - 1; i >= 0; i--) if (list[i].target === target && !list[i].period) list.splice(i, 1);
      list.push(...next);
      onChange();
      paintResult(target);
    };
    inp.addEventListener("input", commit);
    // На blur — каноничная запись (>=10 → ≥10), чтобы ячейка не держала два
    // написания за сессию.
    inp.addEventListener("blur", () => {
      if (!bad.has(target)) inp.value = cellsText(permanent(target));
    });
    // −/+ меняют число, не трогая режим: «=0» → «=1»; пустая ячейка → «+1»/«−1».
    const step = (d) => {
      if (bad.has(target)) {
        inp.value = "";
        commit();
      }
      const cur = permanent(target);
      if (cur.length === 0) inp.value = d > 0 ? "+1" : "−1";
      else {
        const m = cur[0];
        const nv = (parseValue(m.value) || 0) + d;
        cur[0] = Object.assign(m, { value: String(nv) });
        inp.value = m.mode === MODE_ADD && nv === 0 && cur.length === 1 ? "" : cellsText(cur);
      }
      commit();
    };
    if (plain) return el("div", { class: "stat-cell" }, [inp, err]);
    return el("div", { class: "stat-cell" }, [
      el("div", { class: "stat-w" }, [
        el("button", { type: "button", class: "stat-step", text: "−", "aria-label": "Уменьшить: " + targetLabel(target), onclick: () => step(-1) }),
        inp,
        el("button", { type: "button", class: "stat-step", text: "+", "aria-label": "Увеличить: " + targetLabel(target), onclick: () => step(1) }),
      ]),
      err,
    ]);
  }

  function resCell(target, tag) {
    const node = el(tag, { class: "stat-res" });
    results.set(target, node);
    paintResult(target);
    return node;
  }

  // ---- строка «Хиты в ход»: один периодический модификатор ----
  function hpRow() {
    const cur = () => list.find((m) => m.target === TARGET_HP_CURRENT && m.period);
    const m0 = cur();
    if (readOnly) {
      if (!m0) return null;
      const per = PERIODS.find((p) => p[0] === m0.period);
      return el("tr", { class: "stat-hp" }, [
        el("th", { scope: "row", class: "stat-n", text: "Хиты в ход" }),
        el("td", { class: "stat-base", text: "—" }),
        el("td", { class: "stat-ch" }, [el("span", { class: "stat-formula", text: cellText(m0) + " " + (per ? per[1] : "") + (m0.note ? " · " + m0.note : "") })]),
        el("td", { class: "stat-res " + (String(m0.value).trim().startsWith("-") ? "down" : "up") }, [el("b", { text: cellText(m0) + "/ход" })]),
      ]);
    }
    const inp = el("input", { type: "text", value: m0 ? String(m0.value).replace(/-/g, "−") : "", placeholder: "−1к6 · +5", "aria-label": "Хиты в ход: число или кубы со знаком", autocomplete: "off" });
    const note = el("input", { type: "text", value: m0 ? m0.note || "" : "", placeholder: "подпись: огонь, яд…", "aria-label": "Подпись в логе", autocomplete: "off" });
    const err = el("small", { class: "stat-err", hidden: true, "aria-live": "polite" });
    const res = el("td", { class: "stat-res" });
    let period = m0 ? m0.period : PERIOD_TURN_START;
    const seg = el("div", { class: "stat-seg", role: "group", "aria-label": "Когда" });
    const paintSeg = () => [...seg.children].forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === period)));
    const paintRes = () => {
      const m = cur();
      res.innerHTML = "";
      res.className = "stat-res " + (bad.has("hp.periodic") ? "bad" : m ? (String(m.value).trim().startsWith("-") ? "down" : "up") : "same");
      if (bad.has("hp.periodic")) res.appendChild(el("b", { text: "?" }));
      else res.appendChild(el("b", { text: m ? cellText(m) + "/ход" : "—" }));
    };
    const commit = () => {
      const p = parseCell(inp.value, { dice: true });
      const isBad = !!(p && (p.bad || p.mode !== MODE_ADD));
      inp.classList.toggle("bad", isBad);
      err.hidden = !isBad;
      err.textContent = isBad ? (p.why || "Нужен знак: −1к6 урон, +5 лечение.") : "";
      if (isBad) bad.add("hp.periodic");
      else bad.delete("hp.periodic");
      if (!isBad) {
        const idx = list.findIndex((m) => m.target === TARGET_HP_CURRENT && m.period);
        if (!p) {
          if (idx >= 0) list.splice(idx, 1);
        } else if (idx >= 0) Object.assign(list[idx], { value: p.value, period, note: note.value });
        else list.push({ target: TARGET_HP_CURRENT, mode: MODE_ADD, value: p.value, period, note: note.value });
        onChange();
      }
      paintRes();
    };
    inp.addEventListener("input", commit);
    note.addEventListener("input", () => {
      const m = cur();
      if (m) {
        m.note = note.value;
        onChange();
      }
    });
    for (const [v, l] of PERIODS)
      seg.appendChild(
        el("button", {
          type: "button",
          "data-v": v,
          text: l,
          onclick: () => {
            period = v;
            paintSeg();
            commit();
          },
        })
      );
    paintSeg();
    paintRes();
    return el("tr", { class: "stat-hp" }, [
      el("th", { scope: "row", class: "stat-n", text: "Хиты в ход" }),
      el("td", { class: "stat-base", text: "—" }),
      el("td", { class: "stat-ch" }, [el("div", { class: "stat-cell" }, [el("div", { class: "stat-w wrap" }, [inp, seg, note]), err])]),
      res,
    ]);
  }

  // В чтении показываем только то, что состояние трогает.
  const shown = (target) => !readOnly || permanent(target).length > 0;
  const rows = ROWS.filter(([t]) => shown(t)).map(([target, label]) =>
    el("tr", {}, [el("th", { scope: "row", class: "stat-n", text: label }), el("td", { class: "stat-base num", text: base(target) }), el("td", { class: "stat-ch" }, [cellInput(target)]), resCell(target, "td")])
  );
  if (periodic) {
    const hp = hpRow();
    if (hp) rows.push(hp);
  }
  // Компактные сетки под таблицей: цели системы мира, свободные
  // характеристики и цели, которых этот мир не знает (карточку клонировали
  // из мира на другой системе) — их тоже видно и можно поправить.
  const known = new Set([...ROWS.map(([t]) => t), TARGET_HP_CURRENT, ...systemTargets().map((t) => t.target)]);
  const listed = (pred) => [...new Set(list.filter((m) => !m.period && pred(m.target)).map((m) => m.target))];
  const gridCell = (target, label) => el("div", {}, [el("span", { class: "card-lbl", text: label }), cellInput(target, true), resCell(target, "div")]);
  const systemGrid = el(
    "div",
    { class: "stat-ab" },
    systemTargets()
      .filter((t) => shown(t.target))
      .map((t) => gridCell(t.target, t.label))
  );
  const statsGrid = el("div", { class: "stat-ab" }, listed(isStatTarget).map((t) => gridCell(t, statLabel(t))));
  const otherGrid = el(
    "div",
    { class: "stat-ab" },
    listed((t) => !known.has(t) && !isStatTarget(t)).map((t) => gridCell(t, t))
  );
  const statsBlock = el("div", { class: "stat-free" }, [el("span", { class: "card-lbl", text: "Характеристики" }), statsGrid]);
  if (!readOnly) {
    // Свободная характеристика заводится по названию — тем же, что на листе.
    const name = el("input", { type: "text", placeholder: "Название, как на листе: Сила, Удача…", "aria-label": "Новая характеристика", autocomplete: "off" });
    const add = () => {
      const target = statTarget(name.value);
      if (!target) return;
      name.value = "";
      if (results.has(target)) {
        results.get(target).parentElement.querySelector("input")?.focus();
        return;
      }
      const cell = gridCell(target, statLabel(target));
      statsGrid.appendChild(cell);
      cell.querySelector("input")?.focus();
    };
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        add();
      }
    });
    statsBlock.appendChild(el("div", { class: "stat-free-add" }, [name, el("button", { type: "button", class: "btn", text: "Добавить", onclick: add })]));
  }
  const otherBlock = otherGrid.children.length ? el("div", { class: "stat-free" }, [el("span", { class: "card-lbl", text: "Цели другой системы" }), otherGrid]) : null;
  const hasGrids = systemGrid.children.length || statsGrid.children.length || otherGrid.children.length;

  if (readOnly && rows.length === 0 && !hasGrids) {
    return el("div", { class: "stat-editor readonly" }, [el("p", { class: "card-note stat-none", text: "Ничего не меняет в числах — только значок на токене и правила." })]);
  }
  const table = el("table", { class: "stat-table" }, [
    el("caption", { class: "sr-only", text: "Что меняет: показатель, база на стенде, изменение, итог" }),
    el("thead", {}, [el("tr", {}, ["Показатель", "База", "Изменение", "Итог"].map((t) => el("th", { scope: "col", text: t })))]),
    el("tbody", {}, rows),
  ]);

  const legend = el("p", {
    class: "card-note stat-legend",
    html:
      "В ячейку: <code>10</code> поставить · <code>−2</code> / <code>+2</code> прибавить · <code>/2</code> вдвое · <code>&gt;=10</code> не ниже · <code>&lt;=5</code> не выше · <code>−5/ур</code> за каждый уровень — действует, пока метка висит; несколько — через «;»." +
      (periodic ? " «Хиты в ход» — раз в ход: <code>−1к6</code> урон, <code>+5</code> лечение." : "") +
      " Характеристика попадёт в ту, что называется так же на листе." +
      " Пусто — не меняет.",
  });

  const head = stand ? el("div", { class: "stat-stand" }, [labeled("Примерить на", stand)]) : null;
  const root = el("div", { class: "stat-editor" + (readOnly ? " readonly" : "") }, [
    head,
    rows.length ? el("div", { class: "stat-sb" }, [table]) : null,
    systemGrid.children.length ? systemGrid : null,
    !readOnly || statsGrid.children.length ? statsBlock : null,
    otherBlock,
    readOnly ? null : legend,
  ]);

  // refresh — база сменилась (другое существо на стенде): перекрасить итоги.
  root.refresh = () => {
    const visible = ROWS.filter(([t]) => shown(t));
    table.querySelectorAll("td.stat-base.num").forEach((td, i) => (td.textContent = base(visible[i][0])));
    for (const target of results.keys()) paintResult(target);
  };
  if (stand) stand.addEventListener("change", root.refresh);
  return root;
}

// describeModifiers — список записей словами для режима чтения и палитры.
export function describeModifier(m) {
  const label = targetLabel(m.target);
  const per = m.period === PERIOD_TURN_START ? " в начале хода" : m.period === PERIOD_TURN_END ? " в конце хода" : "";
  const body = m.mode === MODE_SET ? "→ " + m.value : m.mode === MODE_MIN ? "не ниже " + m.value : m.mode === MODE_MAX ? "не выше " + m.value : m.mode === MODE_DIV ? (m.value === "2" ? "вдвое" : "÷" + m.value) : cellText(m);
  return `${label} ${body}${per}${m.note ? ` (${m.note})` : ""}`;
}

