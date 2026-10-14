// rolltable-import.js — RollTable из Foundry в карточку справочника: описание
// и markdown-таблица «кость | результат», которую ширма умеет бросать.

const simpleDie = /^\d*d\d+$/i;

function plain(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// cell — текст в ячейку markdown-таблицы: без переводов строк и «|».
const cell = (s) => plain(s).replace(/\|/g, "/");

export function mapFoundryRollTable(doc) {
  const results = [...(doc.results || [])].filter((r) => Array.isArray(r.range)).sort((a, b) => a.range[0] - b.range[0]);
  const max = results.reduce((m, r) => Math.max(m, Number(r.range[1]) || 0), 0);
  let formula = String(doc.formula || "").replace(/\s+/g, "");
  if (!simpleDie.test(formula)) formula = max ? `1d${max}` : formula;
  const head = formula.replace(/^1d/i, "d");
  const rows = results.map((r) => {
    const [from, to] = r.range.map(Number);
    const text = cell(r.text || r.name || r.description || r.documentId || "");
    return `| ${from === to ? from : `${from}–${to}`} | ${text} |`;
  });
  const intro = plain(doc.description);
  const table = rows.length ? `| ${head} | Результат |\n|---|---|\n${rows.join("\n")}` : "";
  return { name: String(doc.name || "Таблица").trim(), kind: "таблица", description: [intro, table].filter(Boolean).join("\n\n"), tags: ["таблица"] };
}
