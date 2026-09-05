// board-list.js — панель «Доски»: список, создание, переименование, права,
// удаление. Один компонент на обе роли (у ДМ и у игрока панель одинаковая) —
// по той же причине, по которой общая панель у пометок: доски заводят и те и
// другие, и разбирать, кому какая половина списка положена, незачем — это уже
// разобрал сервер.
//
// Прав компонент не считает: сервер присылает вместе с доской вычисленные
// canEdit/canManage (см. boardJSON в internal/api/http/board_handlers.go), и
// второй источник правды о правах тут не заводится.
import { icon } from "./icons.js";
import { showAlert, showConfirm, showPrompt, openModal } from "./modal.js";
import { fetchBoards, createBoard, renameBoard, setBoardAccess, deleteBoard, importBoard, fetchJournalMembers, fetchJournal, createJournalEntry } from "./api.js";
import { imageNamesOf, indexFolder, lookupFile, noteFileFor, titleOf, noteContent } from "./board/import.js";
import { openFloatingWindow } from "./floating-window.js";

// ACCESS_LEVELS — те же четыре уровня, что у журнала (domain.JournalAccess),
// и теми же словами, какими они названы в критериях задачи.
const ACCESS_LEVELS = [
  ["none", "Нет доступа"],
  ["limited", "Только название"],
  ["observer", "Чтение"],
  ["owner", "Чтение и правка"],
];

// openBoardWindow — доска плавающим окном поверх стола, как журнал: ДМ держит
// её на втором мониторе, не уходя со сцены.
export function openBoardWindow(board) {
  openFloatingWindow({
    key: "board-" + board.id,
    title: board.name,
    url: "/board.html?id=" + encodeURIComponent(board.id),
    width: 1100,
    height: 820,
  });
}

// accessDialog — раздача прав: уровень по умолчанию плюс точечные выдачи
// аккаунтам стола. Список аккаунтов общий с журналом (одни и те же люди за
// одним столом), поэтому и ручка та же.
async function accessDialog(board) {
  let members = [];
  try {
    members = await fetchJournalMembers();
  } catch {
    members = []; // список не приехал — раздать точечно не выйдет, но общий уровень поменять можно
  }
  let defSelect = null;
  const rows = new Map();
  const ok = await openModal({
    title: "Доступ к доске «" + board.name + "»",
    okLabel: "Сохранить",
    buildBody: (body) => {
      const hint = document.createElement("p");
      hint.className = "bt-modal-text";
      hint.textContent = "Уровень по умолчанию достаётся всем за столом. Персональная выдача перебивает его, если она выше.";
      body.appendChild(hint);

      const defLabel = document.createElement("label");
      defLabel.className = "bt-modal-text";
      defLabel.textContent = "Всем за столом";
      defSelect = document.createElement("select");
      defSelect.className = "bt-modal-input";
      for (const [value, text] of ACCESS_LEVELS) {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = text;
        defSelect.appendChild(opt);
      }
      defSelect.value = board.default || "none";
      body.append(defLabel, defSelect);

      if (!members.length) return;
      const personal = document.createElement("p");
      personal.className = "bt-modal-text";
      personal.textContent = "Персонально";
      body.appendChild(personal);
      for (const m of members) {
        const row = document.createElement("label");
        row.className = "bt-modal-text";
        row.style.cssText = "display:flex;align-items:center;gap:8px;justify-content:space-between;";
        const who = document.createElement("span");
        who.textContent = m.username;
        const sel = document.createElement("select");
        sel.className = "bt-modal-input";
        sel.style.width = "auto";
        for (const [value, text] of ACCESS_LEVELS) {
          const opt = document.createElement("option");
          opt.value = value;
          opt.textContent = text;
          sel.appendChild(opt);
        }
        sel.value = (board.access && board.access[m.id]) || "none";
        rows.set(m.id, sel);
        row.append(who, sel);
        body.appendChild(row);
      }
    },
    onOk: () => true,
    onCancel: () => false,
  });
  if (!ok) return null;
  const access = {};
  for (const [id, sel] of rows) {
    if (sel.value !== "none") access[id] = sel.value;
  }
  return { def: defSelect.value, access };
}

// importDialog — что импортировать и откуда брать то, на что доска
// ссылается. Папку спрашиваем именно папкой: картинки в ваулте лежат
// отдельно от excalidraw-файлов, и заставлять человека вылавливать их по
// одной — перекладывать на него работу, которую машина сделает точнее (см.
// board/import.js).
async function importDialog() {
  let boards = null;
  let vault = null;
  let withImages = null;
  let withNotes = null;

  const ok = await openModal({
    title: "Импорт из Excalidraw",
    okLabel: "Импортировать",
    buildBody: (body) => {
      const hint = document.createElement("p");
      hint.className = "bt-modal-text";
      hint.textContent =
        "Доска сама знает, какие картинки и заметки ей нужны — папку ваулта укажи, чтобы было где их взять.";
      body.appendChild(hint);

      boards = fileRow(body, "Файлы досок", { accept: ".md,.excalidraw", multiple: true });
      vault = fileRow(body, "Папка ваулта (необязательно)", { directory: true });

      withImages = checkRow(body, "Перенести картинки", true);
      withNotes = checkRow(body, "Завести заметки, на которые ссылается доска", false);

      const note = document.createElement("p");
      note.className = "bt-modal-text";
      note.textContent =
        "Заметки заводятся только те, что названы прямо на доске, и только если такой записи в журнале ещё нет: связь идёт по названию, и уже имеющаяся подхватится сама.";
      body.appendChild(note);
    },
    onOk: () => ({
      boards: [...boards.files],
      vault: [...vault.files],
      images: withImages.checked,
      notes: withNotes.checked,
    }),
    onCancel: () => null,
  });
  if (!ok || !ok.boards.length) return null;
  return ok;
}

function fileRow(body, label, { accept, multiple, directory } = {}) {
  const wrap = document.createElement("label");
  wrap.className = "bt-modal-text";
  wrap.style.cssText = "display:block;margin-top:6px;";
  const cap = document.createElement("div");
  cap.textContent = label;
  const input = document.createElement("input");
  input.type = "file";
  input.className = "bt-modal-input";
  if (accept) input.accept = accept;
  if (multiple) input.multiple = true;
  if (directory) {
    // webkitdirectory поддерживают все живые браузеры, но только атрибутом:
    // свойства с таким именем у input нет.
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
  }
  wrap.append(cap, input);
  body.appendChild(wrap);
  return input;
}

function checkRow(body, label, on) {
  const wrap = document.createElement("label");
  wrap.className = "bt-modal-text";
  wrap.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:8px;";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = on;
  const cap = document.createElement("span");
  cap.textContent = label;
  wrap.append(box, cap);
  body.appendChild(wrap);
  return box;
}

// runImport — сам перенос. Отчёт в конце обязателен: молчаливый частичный
// импорт хуже честного «эту картинку не нашёл».
async function runImport(refresh) {
  const opts = await importDialog();
  if (!opts) return;

  const index = indexFolder(opts.vault);
  const failed = [];
  const missingImages = new Set();
  const missingNotes = new Set();
  let addedNotes = 0;

  // Список записей журнала — чтобы не заводить то, что уже есть. Читаем один
  // раз на весь импорт и дополняем по ходу.
  let titles = new Set();
  if (opts.notes) {
    try {
      titles = new Set((await fetchJournal()).map((e) => (e.title || "").trim().toLowerCase()));
    } catch {
      titles = new Set();
    }
  }

  for (const file of opts.boards) {
    try {
      const text = await file.text();
      const images = [];
      if (opts.images) {
        for (const name of imageNamesOf(text)) {
          const found = lookupFile(index, name);
          if (found) images.push({ name, file: found });
          else missingImages.add(name);
        }
      }
      const board = await importBoard(file, "", images);
      for (const name of board.missingImages || []) missingImages.add(name);

      if (!opts.notes) continue;
      for (const title of board.notes || []) {
        if (titles.has(title.trim().toLowerCase())) continue;
        const note = noteFileFor(index, title);
        if (!note) {
          missingNotes.add(title);
          continue;
        }
        await createJournalEntry({ content: noteContent(titleOf(note.name), await note.text()) });
        titles.add(title.trim().toLowerCase());
        addedNotes++;
      }
    } catch (err) {
      failed.push(`${file.name}: ${(err && err.message) || "ошибка"}`);
    }
  }

  await refresh();

  const report = [];
  const done = opts.boards.length - failed.length;
  if (done) report.push(`Досок перенесено: ${done}.`);
  if (addedNotes) report.push(`Заметок заведено: ${addedNotes}.`);
  if (missingImages.size) report.push("Не нашлось картинок: " + [...missingImages].join(", ") + ".");
  if (missingNotes.size) report.push("Не нашлось заметок: " + [...missingNotes].join(", ") + ".");
  if (failed.length) report.push("Не импортировалось:\n" + failed.join("\n"));
  if (report.length) showAlert(report.join("\n\n"));
}

// createBoardList наполняет mount списком досок. Возвращает { refresh } —
// список перечитывается при открытии панели, а не живёт подпиской: доски
// заводят редко, и держать ради этого ещё один канал незачем.
export function createBoardList(mount) {
  mount.classList.add("board-list");

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "board-add";
  addBtn.innerHTML = `${icon("plus", { size: 14 })} Новая доска`;

  const importBtn = document.createElement("button");
  importBtn.type = "button";
  importBtn.className = "board-add board-import";
  importBtn.innerHTML = `${icon("upload", { size: 14 })} Импорт из Excalidraw`;
  importBtn.onclick = () => runImport(refresh);

  const listEl = document.createElement("div");
  listEl.className = "board-items";

  const hint = document.createElement("p");
  hint.className = "draw-hint";
  hint.textContent =
    "Доска — бесконечный холст рядом с заметками. Открытая всем за столом видна всем, закрытая — только тебе и ДМ. Импорт принимает файлы плагина Excalidraw и переносит их картинки, если показать папку ваулта.";

  mount.append(addBtn, importBtn, listEl, hint);

  async function refresh() {
    let boards = [];
    try {
      boards = await fetchBoards();
    } catch (err) {
      listEl.textContent = (err && err.message) || "Не удалось получить список досок.";
      return;
    }
    listEl.textContent = "";
    if (!boards.length) {
      const empty = document.createElement("p");
      empty.className = "draw-hint";
      empty.textContent = "Досок пока нет.";
      listEl.appendChild(empty);
      return;
    }
    for (const board of boards) listEl.appendChild(row(board));
  }

  function row(board) {
    const el = document.createElement("div");
    el.className = "board-item";

    const open = document.createElement("button");
    open.type = "button";
    open.className = "board-open";
    open.title = board.shared ? "Общая доска" : "Личная доска";
    const name = document.createElement("span");
    name.className = "board-item-name";
    name.textContent = board.name;
    const meta = document.createElement("span");
    meta.className = "board-item-meta";
    // Кто завёл и общая ли — две вещи, ради которых иначе пришлось бы лезть
    // в диалог прав.
    meta.textContent = [board.ownerName || "ДМ", board.shared ? "общая" : "личная"].join(" · ");
    open.append(name, meta);
    open.onclick = () => openBoardWindow(board);
    el.appendChild(open);

    // Переименование, права и удаление — только тому, кто доской
    // распоряжается (автор и ДМ). Остальным кнопок просто нет: сервер их
    // всё равно не пустит, а серая кнопка — это обещание, которого не будет.
    if (!board.canManage) return el;

    const actions = document.createElement("div");
    actions.className = "board-item-actions";

    const renameBtn = iconBtn("pencil", "Переименовать", async () => {
      const next = await showPrompt("Название доски", { title: "Переименовать", value: board.name });
      if (next === null || !next.trim()) return;
      try {
        await renameBoard(board.id, next.trim());
        await refresh();
      } catch (err) {
        showAlert((err && err.message) || "Не удалось переименовать доску.");
      }
    });

    const accessBtn = iconBtn("users", "Доступ", async () => {
      const result = await accessDialog(board);
      if (!result) return;
      try {
        await setBoardAccess(board.id, result.def, result.access);
        await refresh();
      } catch (err) {
        showAlert((err && err.message) || "Не удалось изменить доступ.");
      }
    });

    const delBtn = iconBtn("trash", "Удалить", async () => {
      if (!(await showConfirm(`Удалить доску «${board.name}»? Вместе с ней исчезнет всё, что на ней нарисовано.`, { title: "Удалить доску", okLabel: "Удалить", danger: true }))) return;
      try {
        await deleteBoard(board.id);
        await refresh();
      } catch (err) {
        showAlert((err && err.message) || "Не удалось удалить доску.");
      }
    });

    actions.append(renameBtn, accessBtn, delBtn);
    el.appendChild(actions);
    return el;
  }

  function iconBtn(name, title, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "board-item-btn";
    b.title = title;
    b.innerHTML = icon(name, { size: 13 });
    b.onclick = onClick;
    return b;
  }

  addBtn.onclick = async () => {
    const name = await showPrompt("Название доски", { title: "Новая доска", placeholder: "Схема расследования" });
    if (name === null || !name.trim()) return;
    try {
      // Заводится ЗАКРЫТОЙ: открыть столу — осознанное действие через
      // «Доступ», а не то, что случается по умолчанию.
      const board = await createBoard({ name: name.trim(), def: "none" });
      await refresh();
      openBoardWindow(board);
    } catch (err) {
      showAlert((err && err.message) || "Не удалось создать доску.");
    }
  };

  return { refresh };
}
