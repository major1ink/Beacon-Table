// chat.js — чат за столом: вкладка в окне лога бросков (см. roll-log.js,
// opts.chat). Ведущий пишет всем или одному игроку, игрок — всем, ведущему
// или другому игроку. Сами сообщения решает сервер (internal/service/
// room_chat.go): отправителя он проставляет по сокету, личное доставляет
// только двоим — сюда чужое просто не приходит, прятать нечего.
//
// Данные: "chat_history" при входе (vtt:chatHistory) и "chat_message" по
// одному (vtt:chatMessage) — domain.ChatMessage: { id, at, fromRole, fromId?,
// fromName, to?, toName?, text }. Адресаты — из "player_list"
// (vtt:playerList): тот же список, что у ДМ в «кто онлайн».

import { icon } from "./icons.js";
import { showConfirm } from "./modal.js";

// fromRole — domain.ClientRole: 1 — ДМ, 2 — игрок.
const ROLE_DM = 1;
export const CHAT_TO_DM = "dm";

// createChatPane(host, opts) → { el, setHistory, push, setParticipants, focus }
//   opts.role — "dm" | "player"; opts.selfId — id аккаунта игрока (у ДМ не нужен).
//   opts.send(msg) — отправка ClientMsg в комнату.
//   opts.onMessage(m, own) — вызывается на каждое входящее (для счётчика
//     непрочитанных у хозяина окна).
export function createChatPane(host, { role, selfId, send, onMessage = () => {} }) {
  const isDM = role === "dm";
  host.classList.add("chat-pane");

  const body = document.createElement("div");
  body.className = "chat-body";
  const empty = document.createElement("div");
  empty.className = "chat-empty";
  empty.textContent = "Сообщений пока нет";

  const compose = document.createElement("form");
  compose.className = "chat-compose";
  const toRow = document.createElement("div");
  toRow.className = "chat-to-row";
  const toLabel = document.createElement("span");
  toLabel.className = "chat-to-label";
  toLabel.textContent = "Кому";
  const to = document.createElement("select");
  to.className = "chat-to";
  to.title = "Адресат: всем за столом или лично";
  toRow.append(toLabel, to);
  if (isDM) {
    // Очистка истории — только у ведущего (сервер игрока не пустит, см.
    // Room.authorize): «между кампаниями», не «мне надоело».
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "icon-btn chat-clear";
    clearBtn.title = "Очистить историю чата у всех";
    clearBtn.innerHTML = icon("trash", { size: 13 });
    clearBtn.onclick = async () => {
      if (!(await showConfirm("Стереть всю историю чата — и общую, и личные сообщения — у всех за столом?", { title: "Очистить чат", okLabel: "Очистить", danger: true }))) return;
      send({ type: "chat_clear" });
    };
    toRow.appendChild(clearBtn);
  }
  const inputRow = document.createElement("div");
  inputRow.className = "chat-input-row";
  const input = document.createElement("textarea");
  input.className = "chat-input";
  input.rows = 1;
  input.placeholder = "Сообщение…";
  input.title = "Enter — отправить, Shift+Enter — новая строка";
  input.maxLength = 2000; // maxChatTextLen на сервере
  const sendBtn = document.createElement("button");
  sendBtn.type = "submit";
  sendBtn.className = "icon-btn chat-send";
  sendBtn.title = "Отправить";
  sendBtn.innerHTML = icon("send", { size: 15 });
  inputRow.append(input, sendBtn);
  compose.append(toRow, inputRow);

  host.append(body, empty, compose);

  // participants — подключённые игроки (player_list). Выбранный адресат
  // переживает перерисовку списка; ушёл со стола — возвращаемся к «Всем».
  let participants = [];
  function renderTo() {
    const prev = to.value;
    to.replaceChildren();
    const all = new Option("Всем", "");
    to.appendChild(all);
    if (!isDM) to.appendChild(new Option("Ведущему (лично)", CHAT_TO_DM));
    for (const p of participants) {
      if (!isDM && p.id === selfId) continue;
      to.appendChild(new Option(`${p.name || "без имени"} (лично)`, p.id));
    }
    to.value = prev;
    if (to.value !== prev) to.value = "";
    compose.classList.toggle("is-private", to.value !== "");
  }
  to.onchange = () => compose.classList.toggle("is-private", to.value !== "");
  renderTo();

  function isOwn(m) {
    return isDM ? m.fromRole === ROLE_DM : m.fromId === selfId;
  }

  function fmtTime(at) {
    const d = new Date(at);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }

  function renderMsg(m) {
    const el = document.createElement("div");
    el.className = "chat-msg";
    const own = isOwn(m);
    if (m.to) el.classList.add("is-private");
    if (own) el.classList.add("is-own");

    const head = document.createElement("div");
    head.className = "chat-msg-head";
    const who = document.createElement("button");
    who.type = "button";
    who.className = "chat-msg-who";
    who.textContent = own ? "Вы" : m.fromName;
    // Клик по имени — ответить лично тому, кто написал (ведущему или игроку).
    // Своё имя и адресат, которого уже нет за столом, ничего не делают.
    if (!own) {
      const target = m.fromRole === ROLE_DM ? CHAT_TO_DM : m.fromId;
      who.title = "Ответить лично";
      who.onclick = () => {
        to.value = target;
        if (to.value !== target) return;
        to.onchange();
        input.focus();
      };
    } else {
      who.disabled = true;
    }
    head.appendChild(who);
    if (m.to) {
      const arrow = document.createElement("span");
      arrow.className = "chat-msg-to";
      arrow.textContent = "→ " + (own ? m.toName : "вам");
      head.appendChild(arrow);
      const tag = document.createElement("span");
      tag.className = "chat-msg-tag";
      tag.textContent = "лично";
      head.appendChild(tag);
    }
    const time = document.createElement("time");
    time.className = "chat-msg-time";
    time.textContent = fmtTime(m.at);
    head.appendChild(time);

    const text = document.createElement("div");
    text.className = "chat-msg-text";
    text.textContent = m.text;

    el.append(head, text);
    return el;
  }

  function scrollDown() {
    body.scrollTop = body.scrollHeight;
  }

  function syncEmpty() {
    empty.hidden = body.children.length > 0;
  }

  function setHistory(list) {
    body.replaceChildren(...(list || []).map(renderMsg));
    syncEmpty();
    scrollDown();
  }

  function push(m) {
    body.appendChild(renderMsg(m));
    syncEmpty();
    scrollDown();
    onMessage(m, isOwn(m));
  }

  function setParticipants(list) {
    participants = Array.isArray(list) ? list : [];
    renderTo();
  }

  function submit() {
    const text = input.value.trim();
    if (!text) return;
    send({ type: "chat_send", text, to: to.value });
    input.value = "";
    input.style.height = "";
    input.focus();
  }
  compose.onsubmit = (e) => {
    e.preventDefault();
    submit();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  // Поле растёт под текст до нескольких строк, дальше — прокрутка внутри.
  input.addEventListener("input", () => {
    input.style.height = "";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  });

  syncEmpty();
  return { el: host, setHistory, push, setParticipants, focus: () => input.focus() };
}
