// chat.js — чат за столом, вкладка окна лога бросков (roll-log.js, opts.chat).
// Права и адресность решает сервер (room_chat.go): чужое личное сюда не
// приходит. Данные — vtt:chatHistory / vtt:chatMessage (domain.ChatMessage),
// адресаты — vtt:playerList.

import { icon } from "./icons.js";
import { showConfirm } from "./modal.js";

// fromRole — domain.ClientRole: 1 — ДМ, 2 — игрок.
const ROLE_DM = 1;
export const CHAT_TO_DM = "dm";

// createChatPane(host, { role, selfId, send, onMessage }) → { el, setHistory,
// push, setParticipants, setViewing, focus }. onMessage(m, own) — для счётчика
// непрочитанных у хозяина; setViewing(bool) — видна ли лента (подсветка новых).
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
    // Очистка — только у ведущего (Room.authorize).
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

  // Адресат переживает перерисовку списка; ушёл со стола — снова «Всем».
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
    // Клик по имени — ответить лично; ушедшему со стола ответить нельзя.
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
    clearNew();
    body.replaceChildren(...(list || []).map(renderMsg));
    syncEmpty();
    scrollDown();
  }

  // Чужое, пришедшее пока ленту не видно, — .is-new и черта «Новые» перед
  // первым; своё не считается: написал — видел.
  let viewing = false;
  let divider = null;
  let seenTimer = null;
  const NEW_SEEN_MS = 4000;

  function clearNew() {
    clearTimeout(seenTimer);
    seenTimer = null;
    if (divider) divider.remove();
    divider = null;
    for (const el of body.querySelectorAll(".chat-msg.is-new")) el.classList.remove("is-new");
  }

  // Подсветка гаснет через несколько секунд просмотра; ушли раньше — останется.
  function setViewing(v) {
    viewing = v;
    if (v && divider && !seenTimer) seenTimer = setTimeout(clearNew, NEW_SEEN_MS);
    if (!v && seenTimer) {
      clearTimeout(seenTimer);
      seenTimer = null;
    }
  }

  function push(m) {
    const el = renderMsg(m);
    const own = isOwn(m);
    if (!own && !viewing) {
      if (!divider) {
        divider = document.createElement("div");
        divider.className = "chat-divider";
        divider.textContent = "Новые";
        body.appendChild(divider);
      }
      el.classList.add("is-new");
    }
    body.appendChild(el);
    syncEmpty();
    scrollDown();
    onMessage(m, own);
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
  // Поле растёт под текст, дальше прокрутка внутри.
  input.addEventListener("input", () => {
    input.style.height = "";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  });

  syncEmpty();
  return { el: host, setHistory, push, setParticipants, setViewing, focus: () => input.focus() };
}
