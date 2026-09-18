// Подсказка записей при наборе [[ в редакторе: выбор стрелками, Enter/Tab
// заменяет "[[…" узлом wikiLink. Стиль вносит сам, как modal.js.

const maxItems = 8;

let styleInjected = false;
function injectStyle() {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .bt-wiki-pop {
      position: fixed; z-index: 60; display: none; min-width: 200px; max-width: 320px;
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

// openQuery — набранное после незакрытой [[ в текущем абзаце и её позиция.
function openQuery(editor) {
  const { $from, empty } = editor.state.selection;
  if (!empty) return null;
  const text = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
  const open = text.lastIndexOf("[[");
  if (open < 0) return null;
  const query = text.slice(open + 2);
  if (query.length > 60 || /[[\]\n￼]/.test(query)) return null;
  return { from: $from.pos - query.length - 2, query };
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

// attachWikiAutocomplete — редактор TipTap + getNotes() со списком
// [{id,title,folder}].
export function attachWikiAutocomplete(editor, getNotes) {
  injectStyle();
  const pop = document.createElement("div");
  pop.className = "bt-wiki-pop";
  document.body.appendChild(pop);

  let items = [];
  let active = 0;
  let at = null; // {from, query} на момент показа

  function close() {
    pop.classList.remove("open");
    items = [];
    at = null;
  }

  function refresh() {
    at = editor.isFocused ? openQuery(editor) : null;
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
    const caret = editor.view.coordsAtPos(at.from);
    pop.style.left = Math.max(8, Math.min(caret.left, window.innerWidth - 220)) + "px";
    pop.style.top = caret.bottom + 4 + "px";
    pop.classList.add("open");
    // Под строкой не поместилось — показываем над ней.
    const box = pop.getBoundingClientRect();
    if (box.bottom > window.innerHeight - 8) pop.style.top = Math.max(0, caret.top - box.height - 4) + "px";
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
      // mousedown: click приходит уже после blur редактора
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        insert(n);
      });
      pop.appendChild(row);
    });
  }

  function insert(note) {
    const target = targetFor(note, getNotes() || []);
    const to = editor.state.selection.from;
    editor
      .chain()
      .focus()
      .deleteRange({ from: at.from, to })
      .insertContent({ type: "wikiLink", attrs: { target } })
      .run();
    close();
  }

  editor.on("transaction", refresh);
  editor.on("blur", close);
  // capture — раньше ProseMirror, иначе Enter разобьёт абзац
  editor.view.dom.addEventListener(
    "keydown",
    (e) => {
      if (!pop.classList.contains("open")) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        active = (active + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
        draw();
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        insert(items[active]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation(); // Esc в плавающем окне закрывает его целиком
        close();
      }
    },
    true
  );
}
