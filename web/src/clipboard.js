// clipboard.js — копирование в буфер. Стол чаще всего открыт по http в
// локальной сети, а там navigator.clipboard браузеру недоступен — без
// запасного пути кнопки «Копировать» просто ничего не делают.

// copyToClipboard — true, если текст удалось положить в буфер.
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // пробуем запасной путь ниже
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;top:-1000px;opacity:0;";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

// flashCopied — подпись кнопки на пару секунд меняется на «Скопировано»:
// иначе по нажатию не видно, случилось ли что-нибудь.
export function flashCopied(btn, { done = "Скопировано", failed = "Не вышло — выделите и скопируйте", ms = 1600 } = {}, ok = true) {
  if (btn.dataset.copyBusy) return;
  const label = btn.textContent;
  btn.dataset.copyBusy = "1";
  btn.textContent = ok ? done : failed;
  setTimeout(() => {
    btn.textContent = label;
    delete btn.dataset.copyBusy;
  }, ms);
}
