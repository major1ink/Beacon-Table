// Подсказка записей при наборе [[ в редакторе: список по мере ввода, выбор
// стрелками, вставка по Enter/Tab.
//
// Стиль модуль вносит сам (как modal.js/floating-window.js), чтобы работать
// на любой странице с textarea.

const maxItems = 8;

let styleInjected = false;
function injectStyle() {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .bt-wiki-pop {
      position: absolute; z-index: 60; display: none; min-width: 200px; max-width: 320px;
      max-height: 216px; overflow-y: auto; padding: 4px;
      background: var(--panel-bg, #1c1c25); color: var(--text, #eee);
      border: 1px solid var(--border, rgba(255,255,255,0.08)); border-radius: 10px;
      box-shadow: var(--shadow-float, 0 16px 40px rgba(0,0,0,0.45)); font-size: 12.5px;
    }
    .bt-wiki-pop.open { display: block; }
    .bt-wiki-item {
      display: flex; align-items: baseline; gap: 8px; padding: 5px 8px;
      border-radius: 6px; cursor: pointer; white-space: nowrap;
    }
    .bt-wiki-item.active { background: var(--surface, #26262f); }
    .bt-wiki-item b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
    .bt-wiki-item span {
      margin-left: auto; font-size: 10.5px; color: var(--text-dim, rgba(238,238,238,0.55));
      overflow: hidden; text-overflow: ellipsis; direction: rtl;
    }
  `;
  document.head.appendChild(style);
}

// caretPoint — координаты курсора внутри textarea и высота строки. Считаются
// на скрытой копии-«зеркале» с теми же шрифтом, полями и шириной: она
// переносит текст так же, как сама textarea.
function caretPoint(ta) {
  const cs = getComputedStyle(ta);
  const mirror = document.createElement("div");
  for (const prop of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "textIndent", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderLeftWidth", "width"]) {
    mirror.style[prop] = cs[prop];
  }
  mirror.style.cssText += ";position:absolute;visibility:hidden;white-space:pre-wrap;overflow-wrap:break-word;box-sizing:border-box;";
  mirror.textContent = ta.value.slice(0, ta.selectionStart);
  const marker = document.createElement("span");
  marker.textContent = "​";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const line = parseFloat(cs.lineHeight) || 16;
  const x = marker.offsetLeft;
  const y = marker.offsetTop;
  mirror.remove();
  return { x: x - ta.scrollLeft, y: y - ta.scrollTop, line };
}

// openQuery — если курсор стоит внутри незакрытой [[…, вернуть набранное
// после скобок. Перенос строки и вложенная «[» обрывают набор.
function openQuery(ta) {
  const caret = ta.selectionStart;
  if (caret !== ta.selectionEnd) return null;
  const open = ta.value.lastIndexOf("[[", caret - 1);
  if (open < 0) return null;
  const query = ta.value.slice(open + 2, caret);
  if (query.length > 60 || /[[\]\n]/.test(query)) return null;
  return { start: open + 2, query };
}

function score(note, q) {
  const title = (note.title || "").toLowerCase();
  if (!q) return 1;
  if (title.startsWith(q)) return 0;
  if (title.includes(q)) return 1;
  return 2; // совпало только по папке
}

// targetFor — что писать в ссылку: заголовок, а если в журнале есть тёзки —
// заголовок с путём (см. markdown.js: resolveWikiTarget).
function targetFor(note, notes) {
  const title = note.title || "";
  const twins = notes.filter((n) => (n.title || "").toLowerCase() === title.toLowerCase()).length;
  return twins > 1 && note.folder ? note.folder + "/" + title : title;
}

// attachWikiAutocomplete — textarea + getNotes() со списком [{id,title,folder}].
export function attachWikiAutocomplete(ta, getNotes) {
  injectStyle();
  const pop = document.createElement("div");
  pop.className = "bt-wiki-pop";
  // Попап позиционируется от родителя textarea — внутрь неё его не положить.
  const host = ta.parentElement;
  if (getComputedStyle(host).position === "static") host.style.position = "relative";
  host.appendChild(pop);

  let items = [];
  let active = 0;
  let at = null; // {start, query} на момент показа

  function close() {
    pop.classList.remove("open");
    items = [];
    at = null;
  }

  function refresh() {
    at = openQuery(ta);
    if (!at) return close();
    const q = at.query.trim().toLowerCase();
    const notes = getNotes() || [];
    items = notes
      .filter((n) => !q || (n.title || "").toLowerCase().includes(q) || (n.folder || "").toLowerCase().includes(q))
      .sort((a, b) => score(a, q) - score(b, q) || (a.title || "").localeCompare(b.title || "", "ru"))
      .slice(0, maxItems);
    if (!items.length) return close();
    active = 0;
    draw();
    const { x, y, line } = caretPoint(ta);
    pop.style.left = Math.max(0, Math.min(x, ta.clientWidth - 210)) + ta.offsetLeft + "px";
    pop.style.top = ta.offsetTop + y + line + 4 + "px";
    pop.classList.add("open");
    // Под строкой не поместилось — показываем над ней.
    const box = pop.getBoundingClientRect();
    if (box.bottom > window.innerHeight - 8) {
      pop.style.top = Math.max(0, ta.offsetTop + y - box.height - 4) + "px";
    }
  }

  function draw() {
    pop.replaceChildren();
    items.forEach((n, i) => {
      const row = document.createElement("div");
      row.className = "bt-wiki-item" + (i === active ? " active" : "");
      const title = document.createElement("b");
      title.textContent = n.title || "Без названия";
      row.appendChild(title);
      if (n.folder) {
        const where = document.createElement("span");
        where.textContent = n.folder;
        row.appendChild(where);
      }
      // mousedown, а не click: click приходит уже после blur textarea, с
      // потерянной позицией курсора.
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        insert(n);
      });
      pop.appendChild(row);
    });
  }

  function insert(note) {
    const notes = getNotes() || [];
    const target = targetFor(note, notes);
    const before = ta.value.slice(0, at.start);
    const after = ta.value.slice(ta.selectionStart);
    const closing = after.startsWith("]]") ? "" : "]]";
    const caret = before.length + target.length + 2;
    ta.value = before + target + closing + after;
    ta.setSelectionRange(caret, caret);
    ta.focus();
    ta.dispatchEvent(new Event("input", { bubbles: true })); // автосохранение записи
    close();
  }

  ta.addEventListener("input", refresh);
  ta.addEventListener("click", refresh);
  ta.addEventListener("blur", close);
  ta.addEventListener("keydown", (e) => {
    if (!pop.classList.contains("open")) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      draw();
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      insert(items[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // Esc в плавающем окне закрывает его целиком
      close();
    }
  });
}
