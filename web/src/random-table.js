// random-table.js — случайные таблицы в тексте карточек: таблица, у которой
// первый столбец озаглавлен костью (d8, к12, 1d100), а в строках числа или
// диапазоны (3, 1–2, 01-05, 00). Markdown и HTML (карточки модулей, импорт).

const dieRe = /^(\d*)[dкД](\d+)$/i;
const rangeRe = /^(\d+)\s*(?:[-–—]\s*(\d+))?$/;

// fromCells — таблица из заголовка и строк ячеек; null — не случайная таблица.
function fromCells(head, body) {
  const die = dieRe.exec((head[0] || "").replace(/\s+/g, ""));
  if (!die) return null;
  const count = Number(die[1] || 1);
  const sides = Number(die[2]);
  // «00» в таблице d100 — это 100.
  const fix = (v) => (sides === 100 && Number(v) === 0 ? 100 : Number(v));
  const rows = [];
  for (const row of body) {
    const range = rangeRe.exec((row[0] || "").trim());
    if (!range) continue;
    const from = fix(range[1]);
    const to = range[2] === undefined ? from : fix(range[2]);
    rows.push({ from: Math.min(from, to), to: Math.max(from, to), text: row.slice(1).filter(Boolean).join(" · ") });
  }
  return rows.length ? { formula: `${count}d${sides}`, columns: head.slice(1), rows } : null;
}

const mdCells = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => strip(c));

const isDivider = (line) => /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(line.trim());

// strip — markdown-разметку ячейки в простой текст.
const strip = (s) =>
  s
    .replace(/\*\*|__|\*|`/g, "")
    .replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_, a, b) => b || a)
    .trim();

// parseRollTables — все случайные таблицы в markdown-тексте.
export function parseRollTables(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const out = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i].includes("|") || !isDivider(lines[i + 1])) continue;
    let j = i + 2;
    const body = [];
    for (; j < lines.length && lines[j].includes("|"); j++) body.push(mdCells(lines[j]));
    const table = fromCells(mdCells(lines[i]), body);
    if (table) out.push(table);
    i = j - 1;
  }
  return out;
}

// tablesIn — случайные таблицы в уже отрисованном тексте (подходит и для HTML).
export function tablesIn(container) {
  const out = [];
  for (const t of container.querySelectorAll("table")) {
    const rows = [...t.querySelectorAll("tr")].map((tr) => [...tr.children].map((c) => c.textContent.trim()));
    if (rows.length < 2) continue;
    const table = fromCells(rows[0], rows.slice(1));
    if (table) out.push({ ...table, el: t });
  }
  return out;
}

// rowFor — строка таблицы для выпавшего числа; null — число вне диапазонов.
export function rowFor(table, total) {
  return table.rows.find((r) => total >= r.from && total <= r.to) || null;
}

const htmlDieHead = /<t[hd][^>]*>\s*\d*\s*[dкД]\d+\s*<\/t[hd]>/i;

// hasRollTable — быстрая проверка без отрисовки: есть ли в тексте случайная таблица.
export const hasRollTable = (text) => htmlDieHead.test(String(text || "")) || parseRollTables(text).length > 0;
