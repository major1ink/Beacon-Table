// pages/board.js — страница одной доски: забрать холст с сервера, отдать его
// редактору (см. board/editor.js) и показать, кто ещё за ней сидит.
//
// Сохранением страница не занимается вовсе: правки уходят по WebSocket, на
// диск пишет сервер.
import { fetchMe, fetchBoard, fetchBoardScene, fetchJournal } from "../api.js";
import { mountBoardEditor } from "../board/editor.js";
import { parseWikilink, wikilink, findEntryByTitle } from "../board/links.js";
import { openModal, showAlert } from "../modal.js";
import { openFloatingWindow } from "../floating-window.js";

const editorRoot = document.getElementById("editorRoot");
const statusEl = document.getElementById("status");
const nameEl = document.getElementById("boardName");
const metaEl = document.getElementById("boardMeta");
const readonlyBadge = document.getElementById("readonlyBadge");
const linkState = document.getElementById("linkState");
const linkBtn = document.getElementById("linkBtn");
const peersEl = document.getElementById("peers");

// Доска открывается плавающим окном по ссылке board.html?id=… — см.
// openBoardWindow в board-list.js.
const boardId = new URLSearchParams(location.search).get("id") || "";

function fail(msg) {
  statusEl.textContent = msg;
  statusEl.style.display = "";
}

let me = "";
// Записи журнала для связывания. Читаются один раз при открытии доски:
// заводят их редко, а ходить в сеть на каждый клик по ссылке незачем.
let entries = [];
let selected = null;

// openJournal — то же окно журнала, что открывают значки заметок на карте и
// боковое меню (key "journal", см. pages/dm.js).
function openJournal(entryId) {
  openFloatingWindow({
    key: "journal",
    title: "Журнал стола",
    url: "/journal.html?id=" + encodeURIComponent(entryId),
    navigate: true,
    width: 900,
    height: 640,
    popoutFeatures: "width=900,height=640",
  });
}

// followLink — true, если ссылку разобрали и открыли сами. Всё, что не
// [[Заметка]], пусть открывает Excalidraw как обычный адрес.
function followLink(link) {
  const title = parseWikilink(link);
  if (!title) return false;
  const entry = findEntryByTitle(entries, title);
  if (!entry) {
    showAlert("Записи «" + title + "» в журнале нет. Ссылка ведёт на заметку ваулта Obsidian.");
    return true;
  }
  openJournal(entry.id);
  return true;
}

// Кнопка живёт в шапке, а не в меню Excalidraw: своё меню он подменяет
// целиком, вместе со всеми стандартными пунктами.
function showSelection(el) {
  selected = el;
  linkBtn.hidden = !el;
  if (!el) return;
  const title = parseWikilink(el.link);
  linkBtn.textContent = title ? "Связано: " + title : "Связать с журналом";
}

async function pickEntry(current) {
  let select = null;
  const ok = await openModal({
    title: "Связать с записью журнала",
    okLabel: "Связать",
    buildBody: (body) => {
      const hint = document.createElement("p");
      hint.className = "bt-modal-text";
      hint.textContent =
        "Ссылка хранится названием записи, как в Obsidian: та же доска в ваулте откроет одноимённую заметку.";
      body.appendChild(hint);
      select = document.createElement("select");
      select.className = "bt-modal-input";
      const none = document.createElement("option");
      none.value = "";
      none.textContent = "— без ссылки —";
      select.appendChild(none);
      for (const e of entries) {
        const opt = document.createElement("option");
        opt.value = e.title;
        opt.textContent = e.title + (e.folder ? " · " + e.folder : "");
        select.appendChild(opt);
      }
      select.value = current || "";
      body.appendChild(select);
    },
    onOk: () => select.value,
    onCancel: () => null,
  });
  return ok;
}

// Пока связь есть, писать об этом нечего — а вот её отсутствие надо
// увидеть: правки в это время никуда не уходят.
function showStatus(state) {
  linkState.textContent = state === "online" ? "" : "нет связи";
  linkState.classList.toggle("err", state !== "online");
}

function showPeers(list) {
  const others = list.filter((p) => p.id !== me);
  peersEl.textContent = others.length ? "тут ещё: " + others.map((p) => p.name).join(", ") : "";
}

(async function boot() {
  if (!boardId) {
    fail("Доска не указана.");
    return;
  }

  let board;
  let scene;
  try {
    // Свой id нужен, чтобы не показывать себя же в списке соседей.
    me = (await fetchMe())?.id || "";
    board = await fetchBoard(boardId);
    scene = await fetchBoardScene(boardId);
  } catch (err) {
    fail((err && err.message) || "Не удалось открыть доску.");
    return;
  }

  nameEl.textContent = board.name;
  document.title = "Beacon Table — " + board.name;
  const who = board.ownerName ? "автор: " + board.ownerName : "заведена ДМ";
  metaEl.textContent = board.shared ? who + " · общая" : who + " · личная";
  // canEdit считает сервер, см. boardJSON в
  // internal/api/http/board_handlers.go.
  const readOnly = !board.canEdit;
  readonlyBadge.classList.toggle("on", readOnly);

  // Журнал нужен и на чтение ссылок, и на их раздачу. Не приехал — ссылки
  // просто не разрешатся по названию, доска от этого не ломается.
  entries = await fetchJournal().catch(() => []);

  statusEl.style.display = "none";
  const editor = mountBoardEditor(editorRoot, {
    boardId,
    scene,
    readOnly,
    onStatus: showStatus,
    onPeers: showPeers,
    onSelection: readOnly ? undefined : showSelection,
    onLinkOpen: followLink,
  });

  linkBtn.onclick = async () => {
    if (!selected) return;
    const title = await pickEntry(parseWikilink(selected.link));
    if (title === null) return;
    editor.setLink(selected.id, title ? wikilink(title) : null);
    showSelection(editor.selectedElement());
  };

  // pagehide, а не beforeunload: срабатывает и когда вкладку убирают в фон
  // на телефоне, откуда она может не вернуться.
  window.addEventListener("pagehide", () => editor.flush());
})();
