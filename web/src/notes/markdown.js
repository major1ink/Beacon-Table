// Рендер заметок ДМ: обычный markdown (через marked) + вики-ссылки [[...]] —
// общий модуль для боковой панели (pages/dm.js) и отдельного окна заметки
// (pages/note-window.js), чтобы обе поверхности вели себя одинаково.
import { marked } from "marked";

// wikiLinkRe — [[Заголовок]] или [[Заголовок|Текст ссылки]]. Не жадный (.+?),
// чтобы "[[A]] и [[B]]" на одной строке не схлопнулись в одну ссылку.
// Цель НЕ должна начинаться с "/": наш заголовок/путь заметки никогда не
// начинается со слэша, а вот макрос Foundry — почти всегда (инлайн-бросок
// "[[/r 2d6]]", проверка "[[/check ...]]" и т.п., см. internal/foundry/
// rolls.go). Без этого условия текст импортированной карточки/заметки, где
// такой макрос не был (или не мог быть) разобран сервером заранее — например,
// одиночный JSON-импорт карточки предмета/заклинания в обход пакетного
// импорта модуля, см. web/src/foundry-text.js — ломался на кликабельную
// ссылку в никуда вида "[r 2d6](wikilink:%2Fr%202d6)".
const wikiLinkRe = /\[\[(?!\/)([^\]|]+?)(?:\|([^\]]+?))?\]\]/g;

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

// splitWikiTarget — разбор цели ссылки на папку и заголовок. У заметок есть
// папки (domain.Note.Folder), и одноимённые «Обзор» в разных главах — норма,
// поэтому ссылка умеет адресовать путём: [[Глава 1/Таверна]]. Всё до
// ПОСЛЕДНЕГО слэша — путь папки, остаток — заголовок.
export function splitWikiTarget(target) {
  const clean = (target || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");
  const cut = clean.lastIndexOf("/");
  if (cut === -1) return { folder: "", title: clean };
  return { folder: clean.slice(0, cut), title: clean.slice(cut + 1) };
}

const lower = (s) => (s || "").trim().toLowerCase();

// commonPrefixLen — сколько сегментов пути совпадает у двух папок. Нужен,
// чтобы из нескольких одноимённых заметок выбрать ближайшую к той, из
// которой кликнули: сосед по главе ближе, чем тёзка в другом модуле.
function commonPrefixLen(a, b) {
  const x = lower(a).split("/");
  const y = lower(b).split("/");
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n] && x[n] !== "") n++;
  return n;
}

// resolveWikiTarget — найти заметку по цели ссылки. fromFolder — папка
// заметки, ИЗ которой кликнули (для относительных ссылок). Порядок поиска —
// от самого точного к самому терпимому:
//
//  1. путь указан и совпал целиком (абсолютный: [[Модуль/Глава 1/Таверна]]);
//  2. путь указан и совпал ОТНОСИТЕЛЬНО текущей папки ([[NPC/Марго]] из
//     заметки в «Глава 1» найдёт «Глава 1/NPC/Марго»);
//  3. путь указан и совпал ХВОСТОМ ([[Глава 1/Таверна]] найдёт
//     «Модуль/Rules/Глава 1/Таверна») — иначе на импортированное дерево
//     пришлось бы писать полный путь из четырёх уровней;
//  4. пути нет — заметка с таким заголовком в ТЕКУЩЕЙ папке;
//  5. пути нет — любая заметка с таким заголовком, ближайшая по дереву.
//
// Возвращает найденную заметку или null.
export function resolveWikiTarget(target, notes, fromFolder = "") {
  const { folder, title } = splitWikiTarget(target);
  const list = (notes || []).filter((n) => lower(n.title) === lower(title));
  if (!list.length) return null;

  if (folder) {
    const want = lower(folder);
    const exact = list.find((n) => lower(n.folder) === want);
    if (exact) return exact;

    if (fromFolder) {
      const relative = lower(fromFolder) + "/" + want;
      const nested = list.find((n) => lower(n.folder) === relative);
      if (nested) return nested;
    }

    const bySuffix = list.filter((n) => lower(n.folder).endsWith("/" + want));
    if (bySuffix.length) return closestTo(bySuffix, fromFolder);
    return null; // путь указан, но такого нет — не подсовываем тёзку из чужой папки
  }

  const here = list.find((n) => lower(n.folder) === lower(fromFolder));
  if (here) return here;
  return closestTo(list, fromFolder);
}

// closestTo — из нескольких кандидатов берём того, чья папка ближе к
// fromFolder по общему префиксу пути; при равенстве — первого по порядку
// списка (он отсортирован сервером по папке и заголовку).
function closestTo(list, fromFolder) {
  let best = list[0];
  let bestScore = commonPrefixLen(best.folder, fromFolder);
  for (const n of list.slice(1)) {
    const score = commonPrefixLen(n.folder, fromFolder);
    if (score > bestScore) {
      best = n;
      bestScore = score;
    }
  }
  return best;
}

// wikiCreateTarget — куда создавать заметку, которой не нашлось: заголовок и
// папка. Без пути в ссылке — рядом с текущей заметкой (в дереве это то, чего
// ждёшь); с путём — по нему, относительно текущей папки, если такая ветка
// существует, иначе как абсолютный путь.
export function wikiCreateTarget(target, notes, fromFolder = "") {
  const { folder, title } = splitWikiTarget(target);
  if (!folder) return { title, folder: fromFolder };
  if (fromFolder) {
    const relative = fromFolder + "/" + folder;
    const exists = (notes || []).some((n) => lower(n.folder) === lower(relative) || lower(n.folder).startsWith(lower(relative) + "/"));
    if (exists) return { title, folder: relative };
  }
  return { title, folder };
}

// renderNoteHtml — markdown -> HTML. [[Вики-ссылки]] превращаются в обычные
// markdown-ссылки на псевдо-схему "wikilink:", ДО прогона через marked — так
// marked сам их рендерит как обычные <a>, эскейпинг/остальной markdown вокруг
// них не ломается. Резолвинг цели -> заметка и сама навигация — на клиенте,
// см. wireWikiLinks ниже (marked ничего не знает про список заметок).
export function renderNoteHtml(rawMarkdown) {
  const withLinks = (rawMarkdown || "").replace(wikiLinkRe, (_, target, display) => {
    const t = target.trim();
    // Подпись по умолчанию — только заголовок: путь в тексте заметки был бы
    // шумом, он остаётся в подсказке при наведении.
    const { folder, title } = splitWikiTarget(t);
    const label = (display || title || t).trim();
    // markdown-ссылка: [Текст](wikilink:Цель "Путь"). Цель ОБЯЗАТЕЛЬНО
    // percent-encoded (encodeURIComponent) — по CommonMark адрес ссылки без
    // угловых скобок не может содержать пробелы, а заголовки заметок почти
    // всегда многословные ("Марго Хозяйка"); без кодирования marked не
    // распознаёт такую конструкцию как ссылку вообще и печатает её как
    // текст. Обратное декодирование — в wireWikiLinks ниже.
    const hint = folder ? ` "${t.replace(/"/g, "'")}"` : "";
    return `[${label}](wikilink:${encodeURIComponent(t)}${hint})`;
  });
  return marked.parse(withLinks, { breaks: true });
}

// wireWikiLinks — делегированный клик по ссылкам wikilink: внутри уже
// вставленного в DOM HTML (см. renderNoteHtml). getNotesList — функция,
// возвращающая АКТУАЛЬНЫЙ на момент клика список заметок [{id,title,folder}]
// (не сам массив — он в вызывающем коде переприсваивается при каждом refresh,
// и захваченная на момент wireWikiLinks() ссылка иначе быстро устарела бы).
// getFolder — папка ОТКРЫТОЙ сейчас заметки, от неё считаются относительные
// ссылки (см. resolveWikiTarget); можно не передавать — тогда всё
// резолвится от корня. onOpen(id) — нашли существующую заметку;
// onCreateMissing(title, folder) — не нашли, вызывающий сам решает,
// создавать ли (обычно после подтверждения, см. modal.js: showConfirm).
export function wireWikiLinks(containerEl, getNotesList, { onOpen, onCreateMissing, getFolder }) {
  containerEl.addEventListener("click", (e) => {
    const a = e.target.closest('a[href^="wikilink:"]');
    if (!a || !containerEl.contains(a)) return;
    e.preventDefault();
    const target = decodeURIComponent(a.getAttribute("href").slice("wikilink:".length));
    const notes = getNotesList() || [];
    const from = (getFolder && getFolder()) || "";
    const found = resolveWikiTarget(target, notes, from);
    if (found) {
      onOpen(found.id);
      return;
    }
    const create = wikiCreateTarget(target, notes, from);
    onCreateMissing(create.title, create.folder);
  });
}
