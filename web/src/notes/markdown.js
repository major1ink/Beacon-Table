// Рендер заметок ДМ: обычный markdown (через marked) + вики-ссылки [[...]] —
// общий модуль для боковой панели (pages/dm.js) и отдельного окна заметки
// (pages/note-window.js), чтобы обе поверхности вели себя одинаково.
import { marked } from "marked";

// wikiLinkRe — [[Заголовок]] или [[Заголовок|Текст ссылки]]. Не жадный (.+?),
// чтобы "[[A]] и [[B]]" на одной строке не схлопнулись в одну ссылку.
const wikiLinkRe = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g;

// noteTitleFromContent — первая непустая строка вида "# Заголовок" (без "# "),
// иначе "Без названия". Та же логика, что и на сервере
// (internal/repository/notefile/notefile.go:deriveTitle) — здесь нужна для
// мгновенного локального предпросмотра заголовка при вводе, до сохранения.
export function noteTitleFromContent(content) {
  for (const raw of (content || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const t = line.replace(/^#+/, "").trim();
      if (t) return t;
    }
    break;
  }
  return "Без названия";
}

// renderNoteHtml — markdown -> HTML. [[Вики-ссылки]] превращаются в обычные
// markdown-ссылки на псевдо-схему "wikilink:", ДО прогона через marked — так
// marked сам их рендерит как обычные <a>, эскейпинг/остальной markdown вокруг
// них не ломается. Резолвинг заголовка -> id и сама навигация — на клиенте,
// см. wireWikiLinks ниже (marked ничего не знает про список заметок).
export function renderNoteHtml(rawMarkdown) {
  const withLinks = (rawMarkdown || "").replace(wikiLinkRe, (_, title, display) => {
    const t = title.trim();
    const label = (display || t).trim();
    // markdown-ссылка: [Текст](wikilink:Заголовок). Заголовок ОБЯЗАТЕЛЬНО
    // percent-encoded (encodeURIComponent) — по CommonMark адрес ссылки без
    // угловых скобок не может содержать пробелы, а заголовки заметок почти
    // всегда многословные ("Марго Хозяйка"); без кодирования marked не
    // распознаёт такую конструкцию как ссылку вообще и печатает её как
    // текст. Обратное декодирование — в wireWikiLinks ниже.
    return `[${label}](wikilink:${encodeURIComponent(t)})`;
  });
  return marked.parse(withLinks, { breaks: true });
}

// wireWikiLinks — делегированный клик по ссылкам wikilink: внутри уже
// вставленного в DOM HTML (см. renderNoteHtml). getNotesList — функция,
// возвращающая АКТУАЛЬНЫЙ на момент клика список заметок [{id,title,...}] (не
// сам массив — он в вызывающем коде переприсваивается при каждом refresh, и
// захваченная на момент wireWikiLinks() ссылка иначе быстро устарела бы) —
// для резолва "заголовок -> id" (регистронезависимо). onOpen(id) — нашли
// существующую заметку; onCreateMissing(title) — не нашли, вызывающий сам
// решает, создавать ли (обычно после confirm()).
export function wireWikiLinks(containerEl, getNotesList, { onOpen, onCreateMissing }) {
  containerEl.addEventListener("click", (e) => {
    const a = e.target.closest('a[href^="wikilink:"]');
    if (!a || !containerEl.contains(a)) return;
    e.preventDefault();
    const title = decodeURIComponent(a.getAttribute("href").slice("wikilink:".length));
    const found = (getNotesList() || []).find((n) => n.title.toLowerCase() === title.toLowerCase());
    if (found) onOpen(found.id);
    else onCreateMissing(title);
  });
}
