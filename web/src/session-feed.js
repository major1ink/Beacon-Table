// Лента сессии: броски, бой, урон, состояния, сцены и заметки ведущего одной
// шкалой (service.SessionLogService). Что кому видно, решает сервер — сюда
// приходит уже версия ленты для этого клиента. Живёт в журнале (раздел
// «Сессии», pages/journal.js) и в ячейке ширмы (gm-screen/cells.js, compact).
import { fetchSessions, fetchSessionEvents, makeSessionSummary } from "./api.js";
import { icon } from "./icons.js";
import { showConfirm } from "./modal.js";

// Вид события: значок, цвета и раздел фильтра.
const KINDS = {
  roll: { icon: "dice", bg: "rgba(181,137,31,.2)", fg: "#ecc970", cat: "rolls" },
  combat: { icon: "sword", bg: "rgba(194,91,91,.2)", fg: "#f0a0a0", cat: "combat" },
  round: { icon: "sword", bg: "rgba(194,91,91,.2)", fg: "#f0a0a0", cat: "combat" },
  turn: { icon: "sword", bg: "rgba(194,91,91,.12)", fg: "#f0a0a0", cat: "combat" },
  hp: { icon: "zap", bg: "rgba(194,91,91,.2)", fg: "#f0a0a0", cat: "combat" },
  status: { icon: "zap", bg: "rgba(124,108,240,.2)", fg: "#cfc8ff", cat: "combat" },
  note: { icon: "pencil", bg: "rgba(58,90,138,.35)", fg: "#bcd3f5", cat: "notes" },
  timer: { icon: "clock", bg: "rgba(124,108,240,.22)", fg: "#cfc8ff", cat: "notes" },
  summary: { icon: "scroll", bg: "rgba(58,90,138,.35)", fg: "#bcd3f5", cat: "notes" },
  scene: { icon: "map", bg: "rgba(31,107,58,.3)", fg: "#bdf0c9", cat: "scenes" },
  start: { icon: "play", bg: "rgba(31,107,58,.3)", fg: "#bdf0c9", cat: "scenes" },
  end: { icon: "check", bg: "rgba(31,107,58,.3)", fg: "#bdf0c9", cat: "scenes" },
};

const FILTERS = [
  ["all", "Все"],
  ["rolls", "Броски"],
  ["combat", "Бой"],
  ["notes", "Заметки"],
  ["scenes", "Сцены"],
];

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

const hhmm = (ms) => new Date(ms).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" });
const day = (ms) => {
  const d = new Date(ms);
  return d.getDate() + " " + MONTHS[d.getMonth()];
};

function duration(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(min / 60);
  return h ? `${h} ч ${min % 60} мин` : `${min} мин`;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// groupEvents — разделы ленты: по сценам, бой — по раундам.
export function groupEvents(events) {
  const groups = [];
  let cur = null;
  for (const e of events) {
    const key = e.round ? "r" + e.round + "|" + (e.scene || "") : "s|" + (e.scene || "");
    if (!cur || cur.key !== key) {
      cur = {
        key,
        title: e.round ? `Бой · раунд ${e.round}` : e.scene || "Без сцены",
        meta: (e.round && e.scene ? e.scene + " · " : e.round ? "" : "сцена · ") + "с " + hhmm(e.at),
        events: [],
      };
      groups.push(cur);
    }
    cur.events.push(e);
  }
  return groups;
}

// mountSessionFeed — send(msg) шлёт в сокет стола (начать/закончить, заметка);
// onOpenEntry(id) — открыть запись журнала с итогом.
export function mountSessionFeed(root, { isDM = false, members = [], send, onOpenEntry, compact = false } = {}) {
  root.classList.add("sf");
  root.classList.toggle("sf-compact", compact);
  root.innerHTML = "";

  const list = el("aside", "sf-list");
  const main = el("div", "sf-main");
  const head = el("div", "sf-head");
  const title = el("div", "sf-title");
  const summaryBtn = el("button", "sf-btn");
  summaryBtn.type = "button";
  summaryBtn.innerHTML = icon("scroll", { size: 15 }) + "<span>Сделать итог в журнал</span>";
  const asSel = el("select", "sf-as");
  asSel.title = "Как ленту видит игрок";
  const startBtn = el("button", "sf-btn sf-start");
  startBtn.type = "button";
  head.append(title);
  if (isDM && !compact) head.append(asSel, summaryBtn);
  if (isDM) head.append(startBtn);
  const chips = el("div", "sf-chips");
  const hint = el("div", "sf-hint", "Так ленту видит игрок: без скрытых бросков, без заметок ведущего, у врагов вместо чисел хитов — «ранен», «тяжело ранен».");
  const scroll = el("div", "sf-scroll");
  const noteRow = el("form", "sf-note");
  const noteInput = el("input");
  noteInput.type = "text";
  noteInput.maxLength = 500;
  noteInput.placeholder = "Заметка в ленту — Enter. Видна только вам.";
  noteInput.setAttribute("aria-label", "Быстрая заметка");
  const noteBtn = el("button", "sf-btn", "Добавить");
  noteBtn.type = "submit";
  noteRow.append(noteInput, noteBtn);
  main.append(head, chips, hint, scroll);
  if (isDM) main.append(noteRow);
  if (!compact) root.append(list);
  root.append(main);

  let sessions = [];
  let active = null; // {id, title}
  let viewing = ""; // id открытой сессии
  let events = [];
  let filter = "all";
  let as = "";

  for (const [key, label] of FILTERS) {
    const b = el("button", "filter-chip" + (key === filter ? " active" : ""), label);
    b.type = "button";
    b.dataset.filter = key;
    b.onclick = () => {
      filter = key;
      for (const c of chips.children) c.classList.toggle("active", c.dataset.filter === filter);
      renderFeed();
    };
    chips.append(b);
  }
  if (isDM) {
    asSel.append(new Option("Ведущий", ""));
    for (const m of members.filter((m) => !m.gm)) asSel.append(new Option("Как видит " + m.username, m.id));
    asSel.style.display = asSel.options.length > 1 ? "" : "none";
    asSel.onchange = () => {
      as = asSel.value;
      loadEvents();
    };
  }

  async function refresh() {
    try {
      sessions = await fetchSessions();
    } catch {
      sessions = [];
    }
    const act = sessions.find((s) => s.active);
    active = act ? { id: act.id, title: act.title } : null;
    if (!viewing || compact || !sessions.some((s) => s.id === viewing)) viewing = (active || sessions[0] || {}).id || "";
    renderList();
    await loadEvents();
  }

  async function loadEvents() {
    events = [];
    if (viewing) {
      try {
        events = await fetchSessionEvents(viewing, { as });
      } catch {
        events = [];
      }
    }
    renderHead();
    renderFeed({ toBottom: true });
  }

  function renderList() {
    list.replaceChildren(el("div", "sf-list-head", "Сессии"));
    for (const s of sessions) {
      const b = el("button", "sf-sess" + (s.id === viewing ? " on" : ""));
      b.type = "button";
      const name = el("b", "", s.title);
      if (s.active) name.append(el("i", "sf-live"));
      const meta = [day(s.startedAt)];
      if (s.active) meta.push("идёт " + duration(Date.now() - s.startedAt));
      else if (s.endedAt) meta.push(duration(s.endedAt - s.startedAt));
      if (s.summaryId) meta.push("есть итог");
      b.append(name, el("small", "", meta.join(" · ")));
      b.onclick = () => {
        viewing = s.id;
        renderList();
        loadEvents();
      };
      list.append(b);
    }
    if (!sessions.length) list.append(el("div", "sf-empty", "Сессий ещё не было."));
  }

  function renderHead() {
    const s = sessions.find((x) => x.id === viewing);
    title.textContent = s ? s.title : "Лента сессии";
    startBtn.textContent = active ? "Закончить сессию" : "Начать сессию";
    startBtn.classList.toggle("danger", !!active);
    summaryBtn.style.display = s ? "" : "none";
    hint.style.display = as ? "" : "none";
    noteRow.style.display = active && (compact || viewing === active.id) && !as ? "" : "none";
  }

  function eventRow(e) {
    const k = KINDS[e.kind] || KINDS.note;
    const row = el("div", "sf-ev" + (e.secret && isDM && !as ? " gm" : "") + (e.kind === "turn" ? " minor" : ""));
    const ic = el("span", "sf-ic");
    ic.style.background = k.bg;
    ic.style.color = k.fg;
    ic.innerHTML = icon(k.icon, { size: 14 });
    const body = el("div", "sf-body");
    body.append(el("div", "sf-text", e.text));
    let sub = "";
    if (e.kind === "roll") sub = (e.secret ? "скрытый бросок · " : "") + (e.formula || "");
    else if (e.kind === "note") sub = "заметка ведущего";
    if (sub) body.append(el("div", "sf-sub", sub));
    row.append(el("span", "sf-time", hhmm(e.at)), ic, body);
    if (e.secret && isDM && !as) row.append(el("span", "sf-lock", "только ведущий"));
    if (e.total != null) row.append(el("span", "sf-res", String(e.total)));
    if (e.kind === "summary" && e.ref && onOpenEntry) {
      const open = el("button", "sf-btn sf-small", "Открыть");
      open.type = "button";
      open.onclick = () => onOpenEntry(e.ref);
      row.append(open);
    }
    return row;
  }

  function renderFeed({ toBottom = false } = {}) {
    const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40;
    scroll.replaceChildren();
    // «Раунд N» уже стоит заголовком группы.
    const shown = events.filter((e) => e.kind !== "round" && (filter === "all" || (KINDS[e.kind] || KINDS.note).cat === filter));
    if (!viewing) {
      scroll.append(el("div", "sf-empty", isDM ? "Начни сессию — сюда пойдут броски, бой, сцены и твои заметки." : "Ведущий ещё не начинал сессию."));
    } else if (!shown.length) {
      scroll.append(el("div", "sf-empty", "Под фильтр ничего не попало."));
    }
    for (const g of groupEvents(shown)) {
      const gh = el("div", "sf-ghead");
      gh.append(el("b", "", g.title), el("span", "", g.meta), el("i"));
      scroll.append(gh);
      for (const e of g.events) scroll.append(eventRow(e));
    }
    if (toBottom || atBottom) scroll.scrollTop = scroll.scrollHeight;
  }

  startBtn.onclick = async () => {
    if (!send) return;
    if (!active) {
      send({ type: "session_start" });
      return;
    }
    const ok = await showConfirm(`Закончить «${active.title}»?`, {
      title: "Конец сессии",
      okLabel: "Закончить",
      hint: "Лента останется в разделе «Сессии», из неё можно сделать итог в журнал.",
    });
    if (ok) send({ type: "session_end" });
  };

  noteRow.onsubmit = (ev) => {
    ev.preventDefault();
    const text = noteInput.value.trim();
    if (!text || !send) return;
    send({ type: "session_note", text });
    noteInput.value = "";
  };

  summaryBtn.onclick = async () => {
    if (!viewing) return;
    summaryBtn.disabled = true;
    try {
      const res = await makeSessionSummary(viewing);
      await refresh();
      if (onOpenEntry) onOpenEntry(res.id);
    } catch (err) {
      title.title = err.message;
    } finally {
      summaryBtn.disabled = false;
    }
  };

  // onMessage — сообщения сокета стола: состояние сессии и новые события.
  function onMessage(data) {
    if (data.type === "session_state") {
      const was = active && active.id;
      if ((data.active ? data.id : null) !== (was || null)) {
        if (data.active) viewing = data.id;
        refresh();
      }
      return;
    }
    if (data.type === "session_event" && !as && active && viewing === active.id) {
      if (events.some((e) => e.seq === data.event.seq)) return;
      events.push(data.event);
      renderFeed();
    }
  }

  return { refresh, onMessage };
}
