// Панель форматирования над textarea редактора заметки. Сознательно НЕ
// полноценный WYSIWYG (contenteditable + HTML-документ) — заметки остаются
// обычными .md-файлами на диске (см. план системы заметок), поэтому кнопки
// просто вставляют/оборачивают markdown-синтаксис вокруг текущего выделения
// в textarea, как редактор markdown на GitHub/Obsidian. Общий модуль —
// используется и в боковой панели ДМ (pages/dm.js), и в отдельном окне
// заметки (pages/note-window.js).
import { uploadFile } from "../api.js";
import { showAlert, showPrompt } from "../modal.js";

function setValue(ta, value, selStart, selEnd) {
  ta.value = value;
  ta.setSelectionRange(selStart, selEnd);
  ta.focus();
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

function wrapSelection(ta, before, after, placeholder) {
  const { selectionStart: start, selectionEnd: end, value } = ta;
  const selected = value.slice(start, end) || placeholder;
  const newValue = value.slice(0, start) + before + selected + after + value.slice(end);
  const selStart = start + before.length;
  setValue(ta, newValue, selStart, selStart + selected.length);
}

function insertAtCursor(ta, text, cursorOffset) {
  const { selectionStart: start, selectionEnd: end, value } = ta;
  const newValue = value.slice(0, start) + text + value.slice(end);
  const cursor = start + (cursorOffset == null ? text.length : cursorOffset);
  setValue(ta, newValue, cursor, cursor);
}

// currentLine — границы [start,end) строки, где сейчас курсор/начало
// выделения — общая логика для заголовков и построчных префиксов (списки,
// цитата).
function currentLineBounds(value, at) {
  const lineStart = value.lastIndexOf("\n", at - 1) + 1;
  let lineEnd = value.indexOf("\n", at);
  if (lineEnd === -1) lineEnd = value.length;
  return { lineStart, lineEnd };
}

// setHeading — переключает уровень заголовка ("# "/"## "/"### ") у СТРОКИ
// под курсором: повторный клик по уже выставленному уровню снимает его.
function setHeading(ta, level) {
  const { value, selectionStart } = ta;
  const { lineStart, lineEnd } = currentLineBounds(value, selectionStart);
  const line = value.slice(lineStart, lineEnd);
  const currentLevel = (line.match(/^#{1,6}(?=\s|$)/) || [""])[0].length;
  const stripped = line.replace(/^#{1,6}\s*/, "");
  const newLine = currentLevel === level ? stripped : "#".repeat(level) + " " + stripped;
  const newValue = value.slice(0, lineStart) + newLine + value.slice(lineEnd);
  const cursor = lineStart + newLine.length;
  setValue(ta, newValue, cursor, cursor);
}

// toggleLinePrefix — применяет/снимает префикс ("- ", "> ") ко ВСЕМ строкам,
// затронутым текущим выделением (не только первой) — можно выделить
// несколько строк и разом сделать из них список/цитату. ordered=true —
// нумерованный список, префикс каждой строки считается отдельно (1. 2. 3.).
function toggleLinePrefix(ta, prefix, ordered) {
  const { value, selectionStart, selectionEnd } = ta;
  const { lineStart } = currentLineBounds(value, selectionStart);
  const { lineEnd } = currentLineBounds(value, Math.max(selectionEnd, selectionStart));
  const block = value.slice(lineStart, lineEnd);
  const lines = block.split("\n");
  const already = ordered ? lines.every((l) => /^\d+\.\s/.test(l)) : lines.every((l) => l.startsWith(prefix));
  const out = already
    ? lines.map((l) => l.replace(ordered ? /^\d+\.\s/ : new RegExp("^" + prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), ""))
    : lines.map((l, i) => (ordered ? `${i + 1}. ${l}` : prefix + l));
  const newBlock = out.join("\n");
  const newValue = value.slice(0, lineStart) + newBlock + value.slice(lineEnd);
  setValue(ta, newValue, lineStart, lineStart + newBlock.length);
}

async function insertLink(ta) {
  const { selectionStart: start, selectionEnd: end, value } = ta;
  const selected = value.slice(start, end);
  const url = await showPrompt("Адрес ссылки:", { title: "Ссылка", value: "https://", okLabel: "Вставить" });
  if (!url) return;
  const text =
    selected || (await showPrompt("Текст ссылки:", { title: "Ссылка", value: url, okLabel: "Вставить" })) || url;
  // Вставляем по координатам выделения, снятым ДО диалога: пока он открыт,
  // фокус (а с ним и «текущий курсор» textarea) находится в его поле ввода —
  // insertAtCursor вставил бы не туда. Текст за это время поменяться не мог:
  // диалог модальный.
  const md = `[${text}](${url})`;
  setValue(ta, value.slice(0, start) + md + value.slice(end), start + md.length, start + md.length);
}

function insertWikiLink(ta) {
  const { selectionStart: start, selectionEnd: end, value } = ta;
  const selected = value.slice(start, end);
  const newValue = value.slice(0, start) + "[[" + selected + "]]" + value.slice(end);
  const innerStart = start + 2;
  setValue(ta, newValue, innerStart, innerStart + selected.length);
}

// insertBlock — вставка "блочного" элемента (таблица, разделитель) —
// добавляет переводы строк вокруг него САМА, только если их там ещё нет:
// не плодит пустые строки, если курсор и так уже стоит на пустой строке
// (частый случай — courtsор в самом конце уже отделённого абзаца).
function insertBlock(ta, text) {
  const { selectionStart: start, value } = ta;
  const before = value.slice(0, start);
  const after = value.slice(start);
  const nlBefore = before.length === 0 || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const nlAfter = after.length === 0 || after.startsWith("\n") ? "" : "\n\n";
  insertAtCursor(ta, nlBefore + text + nlAfter);
}

function insertTable(ta) {
  insertBlock(ta, "| Заголовок 1 | Заголовок 2 | Заголовок 3 |\n| --- | --- | --- |\n| ячейка | ячейка | ячейка |");
}

// insertReadAloud — врезка «зачитать вслух»: выделенный текст (или заглушку)
// в <aside class="beacon-readaloud"> с пустыми строками внутри — так marked
// разбирает содержимое как markdown, а не как сырой HTML (см.
// web/src/notes/markdown.js), а .note-render рисует ей фон и полосу слева
// (см. web/src/styles/theme.css). Тот же класс эмитит импорт Foundry для
// «read aloud»-блоков модуля (см. internal/foundry/journal.go).
function insertReadAloud(ta) {
  const { selectionStart: start, selectionEnd: end, value } = ta;
  const selected = (value.slice(start, end) || "Текст, который зачитывают игрокам.").trim();
  const before = value.slice(0, start);
  const after = value.slice(end);
  const nlB = before === "" || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const nlA = after === "" || after.startsWith("\n") ? "" : "\n\n";
  const open = `<aside class="beacon-readaloud">\n\n`;
  const block = open + selected + "\n\n</aside>";
  const newValue = before + nlB + block + nlA + after;
  const innerStart = before.length + nlB.length + open.length;
  setValue(ta, newValue, innerStart, innerStart + selected.length);
}

async function insertFile(ta, file) {
  const { url } = await uploadFile(file, "notes");
  const name = file.name.replace(/\.[^./\\]+$/, "");
  const isImage = file.type.startsWith("image/");
  insertAtCursor(ta, isImage ? `![${name}](${url})` : `[${name}](${url})`);
}

// mountNoteToolbar — наполняет toolbarEl кнопками, все действия применяются
// к textarea. Идемпотентно (можно звать повторно на том же контейнере — он
// просто перестраивается), состояния не хранит нигде, кроме самого textarea.
export function mountNoteToolbar(toolbarEl, textarea) {
  toolbarEl.innerHTML = "";

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.className = "note-toolbar-file-input";
  fileInput.onchange = () => {
    const file = fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    insertFile(textarea, file).catch((err) => showAlert("Не удалось загрузить файл: " + err.message));
  };
  toolbarEl.appendChild(fileInput);

  const groups = [
    [
      { label: "H1", title: "Заголовок 1 уровня", action: () => setHeading(textarea, 1) },
      { label: "H2", title: "Заголовок 2 уровня", action: () => setHeading(textarea, 2) },
      { label: "H3", title: "Заголовок 3 уровня", action: () => setHeading(textarea, 3) },
    ],
    [
      { label: "B", cls: "tb-bold", title: "Жирный", action: () => wrapSelection(textarea, "**", "**", "текст") },
      { label: "I", cls: "tb-italic", title: "Курсив", action: () => wrapSelection(textarea, "*", "*", "текст") },
      { label: "S", cls: "tb-strike", title: "Зачёркнутый", action: () => wrapSelection(textarea, "~~", "~~", "текст") },
      { label: "<>", title: "Код", action: () => wrapSelection(textarea, "`", "`", "код") },
    ],
    [
      { label: "☰", title: "Маркированный список", action: () => toggleLinePrefix(textarea, "- ") },
      { label: "①", title: "Нумерованный список", action: () => toggleLinePrefix(textarea, "", true) },
      { label: "❝", title: "Цитата", action: () => toggleLinePrefix(textarea, "> ") },
      { label: "📢", title: "Врезка «зачитать вслух» игрокам", action: () => insertReadAloud(textarea) },
    ],
    [
      { label: "🔗", title: "Вставить ссылку", action: () => insertLink(textarea) },
      { label: "[[·]]", title: "Вставить вики-ссылку на другую заметку — можно с папкой: [[Глава 1/Таверна]]", action: () => insertWikiLink(textarea) },
      { label: "📎", title: "Вставить файл или картинку", action: () => fileInput.click() },
      { label: "▦", title: "Вставить таблицу", action: () => insertTable(textarea) },
      { label: "―", title: "Разделитель", action: () => insertBlock(textarea, "---") },
    ],
  ];

  for (const group of groups) {
    const g = document.createElement("div");
    g.className = "note-toolbar-group";
    for (const b of group) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "note-toolbar-btn" + (b.cls ? " " + b.cls : "");
      btn.textContent = b.label;
      btn.title = b.title;
      // mousedown, а не click, чтобы клик по кнопке не успевал снять
      // выделение/фокус в textarea ДО того, как action его прочитает.
      btn.onmousedown = (e) => e.preventDefault();
      btn.onclick = b.action;
      g.appendChild(btn);
    }
    toolbarEl.appendChild(g);
  }
}
