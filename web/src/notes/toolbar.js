// Панель форматирования редактора записи (notes/editor.js): команды TipTap,
// подсветка по состоянию выделения.
import { showAlert, showPrompt } from "../modal.js";
import { icon } from "../icons.js";

async function insertLink(editor) {
  const { from, to, empty } = editor.state.selection;
  const selected = empty ? "" : editor.state.doc.textBetween(from, to, " ");
  const href = await showPrompt("Адрес ссылки:", { title: "Ссылка", value: "https://", okLabel: "Вставить" });
  if (!href || href === "https://") return;
  if (selected) {
    editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    return;
  }
  const text = (await showPrompt("Текст ссылки:", { title: "Ссылка", value: href, okLabel: "Вставить" })) || href;
  editor
    .chain()
    .focus()
    .insertContent({ type: "text", text, marks: [{ type: "link", attrs: { href } }] })
    .run();
}

// insertWikiLink — выделение → [[ссылка]]; без выделения — "[[" и подсказка.
function insertWikiLink(editor) {
  const { from, to, empty } = editor.state.selection;
  const selected = empty ? "" : editor.state.doc.textBetween(from, to, " ").trim();
  if (selected) {
    editor.chain().focus().insertContent({ type: "wikiLink", attrs: { target: selected } }).run();
  } else {
    editor.chain().focus().insertContent("[[").run();
  }
}

function insertTable(editor) {
  editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
}

// mountNoteToolbar(toolbarEl, note) — кнопки для note (createNoteEditor).
export function mountNoteToolbar(toolbarEl, note) {
  const { editor } = note;
  toolbarEl.innerHTML = "";

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.className = "note-toolbar-file-input";
  fileInput.onchange = () => {
    const file = fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    note.insertFile(file).catch((err) => showAlert("Не удалось загрузить файл: " + err.message));
  };
  toolbarEl.appendChild(fileInput);

  const c = () => editor.chain().focus();
  const groups = [
    [
      { icon: "bold", title: "Жирный (Ctrl+B)", action: () => c().toggleBold().run(), active: () => editor.isActive("bold") },
      { icon: "italic", title: "Курсив (Ctrl+I)", action: () => c().toggleItalic().run(), active: () => editor.isActive("italic") },
      { icon: "underline", title: "Подчёркнутый (Ctrl+U)", action: () => c().toggleUnderline().run(), active: () => editor.isActive("underline") },
      { icon: "strikethrough", title: "Зачёркнутый", action: () => c().toggleStrike().run(), active: () => editor.isActive("strike") },
      { icon: "code", title: "Код", action: () => c().toggleCode().run(), active: () => editor.isActive("code") },
    ],
    [1, 2, 3].map((level) => ({
      label: "H" + level,
      title: `Заголовок ${level} уровня`,
      action: () => c().toggleHeading({ level }).run(),
      active: () => editor.isActive("heading", { level }),
    })),
    [
      { icon: "list", title: "Маркированный список", action: () => c().toggleBulletList().run(), active: () => editor.isActive("bulletList") },
      { icon: "list-ordered", title: "Нумерованный список", action: () => c().toggleOrderedList().run(), active: () => editor.isActive("orderedList") },
      { icon: "check-square", title: "Список с чекбоксами", action: () => c().toggleTaskList().run(), active: () => editor.isActive("taskList") },
      { icon: "quote", title: "Цитата", action: () => c().toggleBlockquote().run(), active: () => editor.isActive("blockquote") },
      {
        icon: "megaphone",
        title: "Врезка «зачитать вслух» игрокам",
        action: () => c().toggleCallout({ kind: "readaloud" }).run(),
        active: () => editor.isActive("callout", { kind: "readaloud" }),
      },
    ],
    [
      { icon: "link", title: "Вставить ссылку", action: () => insertLink(editor), active: () => editor.isActive("link") },
      { icon: "brackets", title: "Вики-ссылка на другую запись — можно с папкой: [[Глава 1/Таверна]]", action: () => insertWikiLink(editor) },
      { icon: "image", title: "Вставить файл или картинку", action: () => fileInput.click() },
      { icon: "minus", title: "Разделитель", action: () => c().setHorizontalRule().run() },
      { icon: "table", title: "Вставить таблицу", action: () => insertTable(editor), active: () => editor.isActive("table") },
    ],
    [
      { icon: "undo", title: "Отменить (Ctrl+Z)", action: () => c().undo().run(), enabled: () => editor.can().undo() },
      { icon: "redo", title: "Повторить (Ctrl+Y)", action: () => c().redo().run(), enabled: () => editor.can().redo() },
    ],
  ];

  // Группа таблицы видна только с курсором в таблице.
  const tableGroup = [
    { label: "+ строка", title: "Добавить строку ниже", action: () => c().addRowAfter().run() },
    { label: "+ колонка", title: "Добавить колонку справа", action: () => c().addColumnAfter().run() },
    { label: "− строка", title: "Удалить строку", action: () => c().deleteRow().run() },
    { label: "− колонка", title: "Удалить колонку", action: () => c().deleteColumn().run() },
    { icon: "trash", title: "Удалить таблицу", action: () => c().deleteTable().run(), cls: "danger" },
  ];

  const buttons = [];
  function addGroup(defs, extraClass = "") {
    const g = document.createElement("div");
    g.className = "note-toolbar-group" + (extraClass ? " " + extraClass : "");
    for (const b of defs) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "note-toolbar-btn" + (b.cls ? " " + b.cls : "");
      btn.innerHTML = b.icon ? icon(b.icon, { size: 15 }) : b.label;
      btn.title = b.title;
      // mousedown — чтобы клик не снимал выделение в редакторе
      btn.onmousedown = (e) => e.preventDefault();
      btn.onclick = b.action;
      buttons.push({ btn, def: b });
      g.appendChild(btn);
    }
    toolbarEl.appendChild(g);
    return g;
  }
  for (const group of groups) addGroup(group);
  const tableEl = addGroup(tableGroup, "note-toolbar-table");

  function refresh() {
    for (const { btn, def } of buttons) {
      if (def.active) btn.classList.toggle("active", def.active());
      if (def.enabled) btn.disabled = !def.enabled();
    }
    tableEl.style.display = editor.isActive("table") ? "" : "none";
  }
  editor.on("transaction", refresh);
  refresh();
}
