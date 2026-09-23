// roll-mode.js — скрытые броски. В localStorage: книги и лист — отдельные
// страницы, а режим общий.

const KEY = "beacon:rollHidden";

export function isRollHidden() {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setRollHidden(on) {
  try {
    if (on) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    /* приватный режим */
  }
}

export function withRollMode(msg) {
  return isRollHidden() ? { ...msg, hidden: true } : msg;
}
