// embed.js — страница, открытая внутри рамки стола: плавающего окна
// (floating-window.js) или дока листа (sheet-dock.js).
//
// announceOwnHeader — у страницы своя шапка с ✕ (карточки справочника,
// лист персонажа). На телефоне рамка тогда прячет свою строку заголовка:
// две шапки подряд с двумя крестиками съедали четверть экрана в альбоме,
// а название в рамке и так повторяет шапку страницы. Закрывает окно ✕
// страницы — сообщением beacon:closeFloatingWindow, как и раньше.
export function announceOwnHeader() {
  if (window.parent === window) return;
  window.parent.postMessage({ type: "beacon:ownHeader" }, location.origin);
}
