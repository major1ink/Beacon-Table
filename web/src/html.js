// html.js — вставка чужого текста в разметку. Имена придумывают игроки,
// тексты карточек приезжают из чужих модулей Foundry: "<img onerror=…>" в
// имени иначе выполнится у ДМ с его правами.
//
// escapeHtml — для текста (имена, ошибки), sanitizeHtml — для разметки,
// которая должна остаться разметкой (тексты приключений).

// ---- экранирование текста ----

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---- адреса ----

// Схемы, которые не должны попадать в href/src: "javascript:" выполняет код
// по клику, "data:text/html" открывает подделанную страницу нашего же origin.
const SAFE_SCHEME = /^(?:https?|mailto|tel|wikilink):/;
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=\s]*$/i;

// decodeEntities — браузер раскроет "jav&#x61;script:" уже после нашей
// проверки схемы, поэтому раскрываем сами, до неё.
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&(tab|newline);?/gi, " ")
    .replace(/&colon;?/gi, ":")
    .replace(/&amp;?/gi, "&");
}

// safeUrl — адрес для href/src или "" при опасной схеме. Свои адреса
// относительные ("/uploads/...", "#якорь") — проходят всегда.
export function safeUrl(url) {
  const raw = String(url ?? "").trim();
  if (!raw) return "";
  // Браузер игнорирует пробелы внутри схемы ("java\nscript:").
  const probe = [...decodeEntities(raw)]
    .filter((ch) => ch.charCodeAt(0) > 32 && ch.charCodeAt(0) !== 127)
    .join("")
    .toLowerCase();
  if (SAFE_SCHEME.test(probe)) return raw;
  if (probe.startsWith("data:")) return SAFE_DATA_IMAGE.test(probe) ? raw : "";
  // Нет "имя:" в начале — адрес относительный, а значит наш.
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(probe);
  return scheme ? "" : raw;
}

// cssUrl — значение для background-image. Кавычка в адресе иначе рвёт
// значение свойства, и вместо картинки получается мусор.
export function cssUrl(url) {
  const safe = safeUrl(url);
  if (!safe) return "none";
  return `url("${safe.replace(/[\\"]/g, "\\$&")}")`;
}

// ---- очистка разметки ----

// Теги, которые остаются: всё, чем размечен текст приключения (заголовки,
// таблицы, картинки, врезки Foundry), и ничего, что умеет исполняться.
const ALLOWED_TAGS = new Set([
  "p", "br", "hr", "div", "span", "section", "aside", "article", "figure", "figcaption",
  "strong", "b", "em", "i", "u", "s", "del", "ins", "mark", "small", "sub", "sup", "abbr", "cite", "q",
  "code", "pre", "kbd", "samp", "var", "blockquote",
  "ul", "ol", "li", "dl", "dt", "dd",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
  "a", "img", "details", "summary",
]);

// Теги, у которых выкидывается и содержимое: внутри <script> не текст, а код.
const DROP_WITH_CONTENT = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet",
  "template", "noscript", "svg", "math", "xmp",
]);

const VOID_TAGS = new Set(["br", "hr", "img", "col"]);

// Атрибуты по тегам. data-* разрешены всем: на них держатся ссылки на
// карточки компендиума из импорта (см. catalog-links.js).
const GLOBAL_ATTRS = new Set(["class", "title", "lang", "dir"]);
const TAG_ATTRS = {
  a: new Set(["href", "target", "rel", "name"]),
  img: new Set(["src", "alt", "width", "height", "loading"]),
  td: new Set(["colspan", "rowspan", "align", "valign"]),
  th: new Set(["colspan", "rowspan", "align", "valign", "scope"]),
  col: new Set(["span", "width"]),
  colgroup: new Set(["span"]),
  ol: new Set(["start", "type", "reversed"]),
  li: new Set(["value"]),
  details: new Set(["open"]),
};
const URL_ATTRS = new Set(["href", "src"]);

// findTagEnd — ">" внутри значения атрибута (title="1 > 2") не закрывает тег,
// поэтому ищем с оглядкой на кавычки.
function findTagEnd(input, start) {
  let quote = "";
  for (let i = start + 1; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]*)))?/g;

function parseAttrs(raw) {
  const attrs = new Map();
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(raw))) {
    const name = m[1].toLowerCase();
    attrs.set(name, m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

// buildOpenTag — тег собирается заново, а не копируется из исходника: что не
// попало в список разрешённого, в вывод не попадает физически.
function buildOpenTag(name, attrs, selfClosing) {
  const allowed = TAG_ATTRS[name];
  let out = "<" + name;
  let blank = false;
  for (const [attr, value] of attrs) {
    if (attr.startsWith("on")) continue;
    if (!(attr.startsWith("data-") || GLOBAL_ATTRS.has(attr) || (allowed && allowed.has(attr)))) continue;
    let v = value;
    if (URL_ATTRS.has(attr)) {
      v = safeUrl(v);
      // Картинка без адреса — пустая рамка, ссылка — путь в никуда.
      if (!v) {
        if (name === "img") return "";
        blank = true;
        continue;
      }
    }
    out += ` ${attr}="${escapeHtml(v)}"`;
  }
  // Без rel открытая страница дотянется до нашей через window.opener.
  if (name === "a" && attrs.get("target")) out += ' rel="noopener noreferrer"';
  if (blank && name === "a") out = out.replace("<a", '<a href="#"');
  return out + (selfClosing || VOID_TAGS.has(name) ? " />" : ">");
}

// sanitizeHtml — неизвестный тег выкидывается, а его текст остаётся: у чужого
// приключения пропадёт вёрстка, но не содержание.
export function sanitizeHtml(html) {
  const input = String(html ?? "");
  let out = "";
  let i = 0;
  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      out += input.slice(i);
      break;
    }
    out += input.slice(i, lt);

    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4);
      i = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith("<!", lt) || input.startsWith("<?", lt)) {
      const end = input.indexOf(">", lt);
      i = end === -1 ? input.length : end + 1;
      continue;
    }

    const head = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(input.slice(lt, lt + 40));
    if (!head) {
      // "<" не открывает тег (математика "a < b") — остаётся текстом.
      out += "&lt;";
      i = lt + 1;
      continue;
    }
    const tagEnd = findTagEnd(input, lt);
    if (tagEnd === -1) {
      // Незакрытый тег в конце: браузер дособерёт из него что угодно.
      break;
    }
    const raw = input.slice(lt, tagEnd + 1);
    const closing = head[1] === "/";
    const name = head[2].toLowerCase();
    i = tagEnd + 1;

    if (DROP_WITH_CONTENT.has(name)) {
      if (!closing) {
        const close = new RegExp("</\\s*" + name + "[^>]*>", "i").exec(input.slice(i));
        i = close ? i + close.index + close[0].length : input.length;
      }
      continue;
    }
    if (!ALLOWED_TAGS.has(name)) continue;
    if (closing) {
      out += "</" + name + ">";
      continue;
    }
    const inner = raw.slice(1 + head[2].length + 1, raw.endsWith("/>") ? -2 : -1);
    out += buildOpenTag(name, parseAttrs(inner), raw.endsWith("/>"));
  }
  return out;
}
