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
import { fetchBoards, createBoard, renameBoard, setBoardAccess, deleteBoard, importBoard, fetchJournalMembers } from "./api.js";
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

// createBoardList наполняет mount списком досок. Возвращает { refresh } —
// список перечитывается при открытии панели, а не живёт подпиской: доски
// заводят редко, и держать ради этого ещё один канал незачем.
export function createBoardList(mount) {
  mount.classList.add("board-list");

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "board-add";
  addBtn.innerHTML = `${icon("plus", { size: 14 })} Новая доска`;

  // Импорт — скрытый input и кнопка рядом с «Новой доской»: файл
  // .excalidraw.md из ваулта Obsidian переносится целиком, вместе с
  // элементами, цветами и всем, чего мы ещё не умеем рисовать (см.
  // internal/excalidraw — незнакомое сохраняется нетронутым).
  const importInput = document.createElement("input");
  importInput.type = "file";
  importInput.accept = ".md,.excalidraw";
  importInput.multiple = true;
  importInput.style.display = "none";

  const importBtn = document.createElement("button");
  importBtn.type = "button";
  importBtn.className = "board-add board-import";
  importBtn.innerHTML = `${icon("upload", { size: 14 })} Импорт из Excalidraw`;
  importBtn.onclick = () => importInput.click();

  const listEl = document.createElement("div");
  listEl.className = "board-items";

  const hint = document.createElement("p");
  hint.className = "draw-hint";
  hint.textContent =
    "Доска — бесконечный холст рядом с заметками. Открытая всем за столом видна всем, закрытая — только тебе и ДМ. Импорт принимает файлы плагина Excalidraw из ваулта Obsidian.";

  importInput.onchange = async () => {
    const files = [...importInput.files];
    importInput.value = ""; // иначе повторный выбор того же файла не сработает
    if (!files.length) return;
    const failed = [];
    for (const file of files) {
      try {
        await importBoard(file);
      } catch (err) {
        failed.push(`${file.name}: ${(err && err.message) || "ошибка"}`);
      }
    }
    await refresh();
    if (failed.length) showAlert("Не импортировалось:\n" + failed.join("\n"));
  };

  mount.append(addBtn, importBtn, importInput, listEl, hint);

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
