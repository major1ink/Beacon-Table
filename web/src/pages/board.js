// pages/board.js — страница одной доски: забрать холст с сервера, отдать его
// редактору (см. board/editor.js) и показать, кто ещё за ней сидит.
//
// Сохранением страница не занимается вовсе: правки уходят по WebSocket, на
// диск пишет сервер.
import { fetchMe, fetchBoard, fetchBoardScene } from "../api.js";
import { mountBoardEditor } from "../board/editor.js";

const editorRoot = document.getElementById("editorRoot");
const statusEl = document.getElementById("status");
const nameEl = document.getElementById("boardName");
const metaEl = document.getElementById("boardMeta");
const readonlyBadge = document.getElementById("readonlyBadge");
const linkState = document.getElementById("linkState");
const peersEl = document.getElementById("peers");

// Доска открывается плавающим окном по ссылке board.html?id=… — см.
// openBoardWindow в board-list.js.
const boardId = new URLSearchParams(location.search).get("id") || "";

function fail(msg) {
  statusEl.textContent = msg;
  statusEl.style.display = "";
}

let me = "";

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

  statusEl.style.display = "none";
  const editor = mountBoardEditor(editorRoot, {
    boardId,
    scene,
    readOnly,
    onStatus: showStatus,
    onPeers: showPeers,
  });

  // pagehide, а не beforeunload: срабатывает и когда вкладку убирают в фон
  // на телефоне, откуда она может не вернуться.
  window.addEventListener("pagehide", () => editor.flush());
})();
