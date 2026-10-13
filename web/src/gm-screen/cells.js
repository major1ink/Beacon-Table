// Содержимое ячеек ширмы — общее для готовых вкладок и своей сетки.
import { fetchJournalEntry } from "../api.js";
import { icon } from "../icons.js";
import { renderNoteHtml } from "../notes/markdown.js";
import { enhanceRolls } from "../inline-rolls.js";
import { glyphNode } from "../condition-glyphs.js";
import { initDiceRoller, formatRolls } from "../dice.js";
import { showPrompt } from "../modal.js";
import { tablesIn, rowFor } from "../random-table.js";
import { ctx, el, openInHost, sendRoll, serverNow, shortName, sourceLine } from "./shared.js";

export function conditionsList(conds) {
  const list = el("div");
  for (const c of conds) {
    const effect = (c.mechanics || c.description || "").replace(/[#*_>`[\]]/g, "").split(/\n|(?<=\.)\s/)[0];
    const row = el("button", { class: "cond-row", type: "button", title: c.name });
    const glyph = glyphNode(c.icon, c.name);
    glyph.style.color = c.color || "";
    row.append(glyph, el("b", { text: c.name }), el("span", { class: "dim", text: effect }));
    row.onclick = () => openInHost("condition-" + c.id, c.name, `/conditions.html?id=${c.id}`);
    list.append(row);
  }
  return list;
}

export function openReferenceButton(card) {
  const b = el("button", { class: "icon-btn", type: "button", title: "Открыть в справочнике", html: icon("external-link", { size: 14 }) });
  b.onclick = () => openInHost("reference-" + card.id, card.name, `/referencebook.html?id=${card.id}`);
  return b;
}

export function referenceBody(card) {
  const body = el("div", { class: "note-render", html: renderNoteHtml(card.description || "") });
  enhanceRolls(body, (formula, label) => sendRoll(formula, `${shortName(card.name)} — ${label}`));
  wireTableRolls(body, shortName(card.name));
  return [body, sourceLine(card)];
}

export function openJournalButton(id) {
  const b = el("button", { class: "icon-btn", type: "button", title: "Открыть в журнале", html: icon("external-link", { size: 14 }) });
  b.onclick = () => openInHost("journal", "Журнал стола", `/journal.html?id=${id}`, true);
  return b;
}

// journalBody — текст записи без первого заголовка: он уже в шапке.
export async function journalBody(id) {
  let entry;
  try {
    entry = await fetchJournalEntry(id);
  } catch {
    return { entry: null, body: el("p", { class: "dim", text: "Запись недоступна." }) };
  }
  const md = (entry.content || "").replace(/^\s*#\s+[^\n]*\n?/, "");
  const body = el("div", { class: "note-render", html: renderNoteHtml(md) });
  enhanceRolls(body, (formula, label) => sendRoll(formula, `${entry.title} — ${label}`));
  wireTableRolls(body, entry.title || "Таблица");
  return { entry, body };
}

// ---- бросок ----

// Свой режим скрытности у ширмы, по умолчанию скрыто: общий режим стола не трогаем.
const screenHidden = {
  get: () => {
    try {
      return localStorage.getItem("beacon:screenRollOpen") !== "1";
    } catch {
      return true;
    }
  },
  set: (on) => {
    try {
      if (on) localStorage.removeItem("beacon:screenRollOpen");
      else localStorage.setItem("beacon:screenRollOpen", "1");
    } catch {
      /* приватный режим */
    }
  },
};

// Броски, отправленные с ширмы: показываем результат только их.
const pendingRolls = [];
const rolls = [];
const rollViews = new Set();
let rollLabel = "";

export function rollWidget() {
  const label = el("input", { class: "field", placeholder: "Что бросаем: Скрытность гоблинов", autocomplete: "off", "aria-label": "Что бросаем", style: "font-size:13px" });
  label.value = rollLabel;
  label.oninput = () => (rollLabel = label.value);
  const tray = el("div");
  initDiceRoller(
    tray,
    (msg) => {
      pendingRolls.push(msg.formula + "|" + msg.label);
      if (pendingRolls.length > 20) pendingRolls.shift();
      if (ctx.socket) ctx.socket.send(msg);
    },
    {
      hiddenToggle: true,
      role: ctx.gm ? "dm" : "player",
      hiddenState: screenHidden,
      decorate: (msg) => ({ ...msg, label: Array.from(rollLabel.trim() || "Бросок с ширмы").slice(0, 80).join("") }),
    }
  );
  tray.querySelector("[data-hidden]")?.append(" Скрытно");
  const view = el("div", { class: "roll-view" });
  rollViews.add(view);
  drawRolls(view);
  return el("div", { class: "roll-widget" }, [label, tray, view]);
}

function drawRolls(view) {
  view.textContent = "";
  const last = rolls[0];
  if (!last) {
    view.append(el("p", { class: "dim", style: "margin:0", text: "Клик по кубу — добавить, правый клик — убрать. Скрытый бросок видите только вы." }));
    return;
  }
  const mod = last.modifier ? ` ${last.modifier > 0 ? "+" : "−"} ${Math.abs(last.modifier)}` : "";
  view.append(
    el("div", { class: "roll-result" }, [
      el("div", { class: "total", text: String(last.total) }),
      el("div", {}, [el("div", { text: last.label || last.formula }), el("div", { class: "dim", style: "font-size:12px", text: formatRolls(last.formula, last.rolls) + mod + (last.hidden ? " · скрыто" : "") })]),
    ])
  );
  for (const r of rolls.slice(1, 6)) {
    view.append(
      el("div", { class: "roll-row" }, [
        el("span", { style: "flex:1", text: r.label || "Бросок" }),
        r.hidden ? el("span", { class: "dim", title: "Скрытый", html: icon("eye-off", { size: 12 }) }) : null,
        el("span", { class: "dim", text: r.formula }),
        el("b", { text: String(r.total) }),
      ])
    );
  }
}

// ---- случайные таблицы ----

// Ждущие результата броски по таблицам: «формула|подпись» → что сделать с итогом.
const tableRolls = new Map();

// wireTableRolls — кнопка «Бросить» у каждой случайной таблицы в тексте и
// переключатель «скрытно/открыто»; открытый результат уходит в чат.
function wireTableRolls(body, title) {
  const tables = tablesIn(body);
  if (!tables.length) return;
  const mode = el("button", { class: "table-mode", type: "button" });
  const drawMode = () => {
    const hidden = screenHidden.get();
    mode.innerHTML = icon(hidden ? "eye-off" : "eye", { size: 12 }) + (hidden ? " Скрытно" : " Открыто, в чат");
    mode.classList.toggle("open", !hidden);
  };
  mode.onclick = () => {
    screenHidden.set(!screenHidden.get());
    drawMode();
  };
  drawMode();
  tables[0].el.before(mode);
  tables.forEach((t, i) => {
    const label = tables.length > 1 ? `${title}, таблица ${i + 1}` : title;
    const result = el("div", { class: "table-result", hidden: true });
    const btn = el("button", { class: "table-roll", type: "button", title: `Бросить ${t.formula}`, html: icon("dice", { size: 13 }) });
    btn.onclick = () => {
      const hidden = screenHidden.get();
      const key = t.formula + "|" + label;
      tableRolls.set(key, (msg) => {
        const row = rowFor(t, msg.total);
        const text = row ? row.text : "нет такой строки";
        result.hidden = false;
        result.textContent = `${msg.total} → ${text}`;
        for (const tr of t.el.querySelectorAll("tr.hit")) tr.classList.remove("hit");
        const idx = row ? t.rows.indexOf(row) : -1;
        const trs = [...t.el.querySelectorAll("tr")].slice(1).filter((tr) => /^\s*\d/.test(tr.children[0]?.textContent || ""));
        if (trs[idx]) {
          trs[idx].classList.add("hit");
          trs[idx].scrollIntoView({ block: "nearest" });
        }
        result.scrollIntoView({ block: "nearest" });
        if (!hidden && ctx.socket) ctx.socket.send({ type: "chat_send", text: `${label}: ${msg.total} — ${text}` });
      });
      const msg = { type: "roll_dice", formula: t.formula, label };
      if (ctx.socket) ctx.socket.send(hidden ? { ...msg, hidden: true } : msg);
    };
    const th = t.el.querySelector("tr")?.children[0];
    if (th) {
      // Кость в заголовке — не отдельный бросок, а кнопка таблицы.
      th.textContent = th.textContent.trim();
      th.append(" ", btn);
    }
    t.el.before(result);
  });
}

export function onRoll(msg) {
  const tableDone = tableRolls.get(msg.formula + "|" + msg.label);
  if (tableDone) {
    tableRolls.delete(msg.formula + "|" + msg.label);
    tableDone(msg);
    return;
  }
  const i = pendingRolls.indexOf(msg.formula + "|" + msg.label);
  if (i < 0) return;
  pendingRolls.splice(i, 1);
  rolls.unshift(msg);
  rolls.length = Math.min(rolls.length, 20);
  for (const v of rollViews) {
    if (v.isConnected) drawRolls(v);
    else rollViews.delete(v);
  }
}

// ---- таймер ----

const timers = new Set();

function timerLeft(cell) {
  if (cell.endsAt) return Math.max(0, cell.endsAt - serverNow());
  if (cell.left) return cell.left;
  return (cell.seconds || 0) * 1000;
}

function fmtTime(ms) {
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

// parseDuration — «5», «2:30», «1:00:00» → секунды.
function parseDuration(text) {
  const parts = String(text || "").trim().split(":").map((p) => Number(p.trim()));
  if (!parts.length || parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (parts.length === 1) return Math.round(parts[0] * 60);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export function timerWidget(cell) {
  const display = el("button", { class: "timer-display serif", type: "button", disabled: !ctx.gm, title: ctx.gm ? "Задать время" : "" });
  const play = el("button", { class: "icon-btn", type: "button" });
  const reset = el("button", { class: "icon-btn", type: "button", title: "Сбросить", html: icon("repeat", { size: 15 }) });
  const shown = el("button", { class: "icon-btn", type: "button" });
  const drawShown = () => {
    shown.innerHTML = icon(cell.public ? "eye" : "eye-off", { size: 15 });
    shown.title = cell.public ? "Видят игроки и трансляция — скрыть" : "Показать игрокам и на трансляции";
    shown.classList.toggle("on", !!cell.public);
  };
  drawShown();
  shown.onclick = () => {
    cell.public = !cell.public;
    drawShown();
    ctx.saveQuiet();
  };
  const view = { cell, display, play };
  const draw = () => {
    const left = timerLeft(cell);
    display.textContent = left > 0 || !cell.endsAt ? fmtTime(left) : "Время!";
    display.classList.toggle("done", !!cell.endsAt && left <= 0);
    display.classList.toggle("running", !!cell.endsAt && left > 0);
    play.innerHTML = icon(cell.endsAt ? "pause" : "play", { size: 15 });
    play.title = cell.endsAt ? "Пауза" : "Пуск";
  };
  view.draw = draw;
  timers.add(view);
  play.onclick = () => {
    if (cell.endsAt) {
      cell.left = Math.max(0, cell.endsAt - serverNow());
      cell.endsAt = 0;
    } else {
      const left = cell.left || (cell.seconds || 0) * 1000;
      if (!left) return;
      cell.endsAt = serverNow() + left;
      cell.left = 0;
    }
    draw();
    ctx.saveQuiet();
  };
  reset.onclick = () => {
    cell.endsAt = 0;
    cell.left = 0;
    draw();
    ctx.saveQuiet();
  };
  display.onclick = async () => {
    const text = await showPrompt("Минуты или мм:сс", { title: cell.title || "Таймер", value: fmtTime((cell.seconds || 0) * 1000), okLabel: "Задать" });
    const sec = parseDuration(text);
    if (sec === null) return;
    cell.seconds = sec;
    cell.endsAt = 0;
    cell.left = 0;
    draw();
    ctx.saveQuiet();
  };
  draw();
  return el("div", { class: "timer" }, [display, ctx.gm ? el("div", { class: "timer-controls" }, [play, reset, shown]) : null]);
}

setInterval(() => {
  for (const t of timers) {
    if (!t.display.isConnected) timers.delete(t);
    else if (t.cell.endsAt) t.draw();
  }
}, 250);

// ---- счётчик ----

export function counterWidget(cell) {
  const value = el("div", { class: "counter-value serif", text: String(cell.value || 0) });
  const step = (d) => () => {
    cell.value = (cell.value || 0) + d;
    value.textContent = String(cell.value);
    ctx.saveQuiet();
  };
  if (!ctx.gm) return el("div", { class: "counter" }, [value]);
  return el("div", { class: "counter" }, [
    el("button", { class: "counter-btn", type: "button", text: "−", "aria-label": "Меньше", onclick: step(-1) }),
    value,
    el("button", { class: "counter-btn", type: "button", text: "+", "aria-label": "Больше", onclick: step(1) }),
  ]);
}
