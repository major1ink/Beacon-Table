// Ячейки ширмы «Граф связей» и «Лента сессии» — те же виды, что в журнале
// (journal-graph.js, session-feed.js), только компактные.
import { icon } from "../icons.js";
import { mountJournalGraph } from "../journal-graph.js";
import { mountSessionFeed } from "../session-feed.js";
import { ctx, el, openInHost } from "./shared.js";

const openEntry = (id) => openInHost("journal", "Журнал стола", `/journal.html?id=${id}`, true);

// Ленты ширмы, которым нужны события сокета (session_state/session_event).
const feeds = new Set();

export function onSessionMessage(msg) {
  for (const f of feeds) {
    if (!f.root.isConnected) feeds.delete(f);
    else f.feed.onMessage(msg);
  }
}

export function openGraphButton() {
  const b = el("button", { class: "icon-btn", type: "button", title: "Открыть граф в журнале", html: icon("external-link", { size: 14 }) });
  b.onclick = () => openInHost("journal", "Журнал стола", "/journal.html?view=graph", true);
  return b;
}

export function openFeedButton() {
  const b = el("button", { class: "icon-btn", type: "button", title: "Все сессии в журнале", html: icon("external-link", { size: 14 }) });
  b.onclick = () => openInHost("journal", "Журнал стола", "/journal.html?view=sessions", true);
  return b;
}

export function graphWidget() {
  const root = el("div", { class: "session-cell" });
  // Ячейка ещё не в DOM — без размеров граф не впишется.
  requestAnimationFrame(() => mountJournalGraph(root, { compact: true, onOpen: openEntry }).refresh());
  return root;
}

export function feedWidget() {
  const root = el("div", { class: "session-cell" });
  const feed = mountSessionFeed(root, {
    isDM: ctx.gm,
    compact: true,
    send: (msg) => ctx.socket && ctx.socket.send(msg),
    onOpenEntry: openEntry,
  });
  feeds.add({ root, feed });
  feed.refresh();
  return root;
}
