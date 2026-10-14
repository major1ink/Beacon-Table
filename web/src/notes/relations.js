// Типизированные связи записи — блок кода ```связи:
//
//   ```связи
//   подчинённый: [[Марго Вейл]]
//   враг: [[Звонарь Тобиас]]
//   ```
//
// Разбор — двойник domain.ParseJournalRelations (internal/domain/journal_graph.go):
// граф строит сервер, а здесь блок только показывается панелью в записи.
import { escapeHtml } from "../html.js";

export const RELATIONS_FENCE = "связи";

// reverse — как связь читается со стороны цели: «подчинённый: [[Марго]]» в
// записи Ордена у Марго выглядит как «подчиняется: Орден».
export const RELATION_TYPES = {
  союзник: { color: "#7fd694" },
  враг: { color: "#d9603f" },
  семья: { color: "#c6bdff" },
  подчинённый: { color: "#6fb3d9", reverse: "подчиняется" },
};
export const OTHER_RELATION_COLOR = "#d9b45f";
export const LINK_COLOR = "rgba(238,238,238,.4)";

export function relationColor(type) {
  if (!type) return LINK_COLOR;
  return (RELATION_TYPES[type] || {}).color || OTHER_RELATION_COLOR;
}

// relationLabel — подпись связи со стороны записи: from — объявлена ли она в
// ней самой.
export function relationLabel(type, from) {
  if (!type) return from ? "ссылка на" : "упомянута в";
  return from ? type : (RELATION_TYPES[type] || {}).reverse || type;
}

const fenceRe = new RegExp("^[ \\t]*(```|~~~)[ \\t]*" + RELATIONS_FENCE + "[ \\t]*\\r?\\n([\\s\\S]*?)^[ \\t]*(```|~~~)[ \\t]*$", "gm");
const targetRe = /\[\[(?!\/)([^\]|]+?)(?:\|[^\]]+?)?\]\]/g;

function parseBody(body) {
  const out = [];
  for (const line of body.split("\n")) {
    const cut = line.indexOf(":");
    if (cut < 0) continue;
    const type = line.slice(0, cut).trim().replace(/^[-*\s]+|[-*\s]+$/g, "").toLowerCase();
    if (!type || type === RELATIONS_FENCE) continue;
    for (const m of line.slice(cut + 1).matchAll(targetRe)) {
      const target = m[1].split("#")[0].trim();
      if (target) out.push({ type, target });
    }
  }
  return out;
}

// parseRelations — [{type, target}] из всех блоков записи.
export function parseRelations(content) {
  const out = [];
  for (const m of String(content || "").matchAll(fenceRe)) out.push(...parseBody(m[2]));
  return out;
}

// relationsHtml — панель связей вместо блока кода. Ссылки — те же
// wikilink:, что у [[ссылок]] в тексте, клик ловит wireWikiLinks.
function relationsHtml(list) {
  if (!list.length) return "";
  const rows = list.map(({ type, target }) => {
    const title = target.split("/").pop();
    return (
      `<li><i style="background:${relationColor(type)}"></i><span>${escapeHtml(type)}</span>` +
      `<a href="wikilink:${encodeURIComponent(target)}">${escapeHtml(title)}</a></li>`
    );
  });
  return `<ul class="note-relations">${rows.join("")}</ul>`;
}

// extractRelationBlocks — заменить блоки связей на метки-заглушки до
// marked; restoreRelationBlocks вставит панели после очистки HTML.
export function extractRelationBlocks(markdown) {
  const panels = [];
  const text = String(markdown || "").replace(fenceRe, (_, _a, body) => {
    panels.push(relationsHtml(parseBody(body)));
    return `\n\nBEACONRELATIONS${panels.length - 1}\n\n`;
  });
  return { text, panels };
}

export function restoreRelationBlocks(html, panels) {
  if (!panels.length) return html;
  return html.replace(/(?:<p>)?BEACONRELATIONS(\d+)(?:<\/p>)?/g, (_, i) => panels[+i] || "");
}
