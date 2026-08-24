// modal.js — модальные диалоги приложения вместо браузерных alert/confirm/
// prompt. Тот же смысл, но своё окно: нативные диалоги показывают адрес
// сервера («Подтвердите действие на 192.168.…»), выглядят чужеродно поверх
// стола, не поддаются оформлению и в iframe плавающих окон (см.
// floating-window.js) выглядят так, будто спрашивает не приложение, а
// браузер.
//
// Три функции повторяют знакомую семантику, но возвращают Promise:
//   await showAlert("текст")              → undefined
//   await showConfirm("вопрос")           → true | false
//   await showPrompt("подпись поля")      → строка | null (отмена)
//
// Стиль модуль вносит сам (см. injectStyle) — как floating-window.js, чтобы
// диалог работал на любой странице и внутри iframe, не требуя CSS в каждой.
import { icon } from "./icons.js";

let styleInjected = false;
function injectStyle() {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .bt-modal-overlay {
      /* 500 — выше всего остального UI: плавающих окон (200+), оверлеев
         страниц и модалки лута (400). Диалог всегда поверх того, о чём
         спрашивает. */
      position: fixed; inset: 0; z-index: 500; display: flex; align-items: center; justify-content: center;
      padding: 16px; background: rgba(0, 0, 0, 0.55);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 13px;
      animation: bt-modal-fade .12s ease-out;
    }
    @keyframes bt-modal-fade { from { opacity: 0 } to { opacity: 1 } }
    .bt-modal {
      width: min(420px, 100%); max-height: 100%; display: flex; flex-direction: column; overflow: hidden;
      background: var(--panel-bg, #1c1c25); color: var(--text, #eee);
      border: 1px solid var(--border, rgba(255,255,255,0.08)); border-radius: var(--radius-lg, 18px);
      box-shadow: var(--shadow-float, 0 16px 40px rgba(0,0,0,0.45));
    }
    .bt-modal-head {
      flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 12px 14px;
      border-bottom: 1px solid var(--border, rgba(255,255,255,0.08));
      font-size: 14px; font-weight: 600;
    }
    .bt-modal-head span { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bt-modal-close {
      flex: 0 0 auto; width: 26px; height: 26px; padding: 0; display: flex; align-items: center; justify-content: center;
      background: none; border: none; border-radius: 8px; color: var(--text-dim, rgba(238,238,238,0.55)); cursor: pointer;
    }
    .bt-modal-close:hover { background: var(--surface-hover, #303039); color: var(--text, #eee); }
    .bt-modal-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
    .bt-modal-text { margin: 0; line-height: 1.55; white-space: pre-wrap; overflow-wrap: break-word; }
    .bt-modal-text.dim { color: var(--text-dim, rgba(238,238,238,0.55)); font-size: 12px; }
    .bt-modal-input, .bt-modal-textarea {
      width: 100%; box-sizing: border-box; font: inherit; color: var(--text, #eee);
      background: var(--surface, #26262f); border: 1px solid var(--border, rgba(255,255,255,0.08));
      border-radius: 8px; padding: 8px 10px;
    }
    .bt-modal-textarea { min-height: 110px; resize: vertical; font: 13px/1.6 "Cascadia Code", Consolas, monospace; }
    .bt-modal-input:focus, .bt-modal-textarea:focus { outline: none; border-color: var(--accent, #7c6cf0); }
    .bt-modal-foot {
      flex: 0 0 auto; display: flex; align-items: center; gap: 8px; justify-content: flex-end;
      padding: 10px 14px; border-top: 1px solid var(--border, rgba(255,255,255,0.08));
    }
    .bt-modal-btn {
      padding: 7px 14px; border: none; border-radius: var(--radius, 10px); cursor: pointer; font: inherit;
      background: var(--surface, #26262f); color: var(--text, #eee);
    }
    .bt-modal-btn:hover { background: var(--surface-hover, #303039); }
    .bt-modal-btn.primary { background: var(--accent, #7c6cf0); }
    .bt-modal-btn.primary:hover { background: var(--accent-hover, #6a5ae0); }
    .bt-modal-btn.danger { background: var(--danger, #6b2b2b); }
    .bt-modal-btn.danger:hover { background: var(--danger-hover, #8a3535); }
  `;
  document.head.appendChild(style);
}

// openModal — общий каркас: оверлей, шапка, тело (наполняет вызывающий) и
// кнопки. resolve зовётся ровно один раз — что бы окно ни закрыло (кнопка,
// ✕, Esc, клик мимо), поэтому вызывающему не нужно ничего доубирать.
function openModal({ title, danger, okLabel, cancelLabel, buildBody, onOk, onCancel }) {
  injectStyle();
  return new Promise((resolve) => {
    const previouslyFocused = document.activeElement;
    const overlay = document.createElement("div");
    overlay.className = "bt-modal-overlay";
    const modal = document.createElement("div");
    modal.className = "bt-modal";
    overlay.appendChild(modal);

    const head = document.createElement("div");
    head.className = "bt-modal-head";
    const titleEl = document.createElement("span");
    titleEl.textContent = title;
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "bt-modal-close";
    closeBtn.title = "Закрыть";
    closeBtn.innerHTML = icon("close", { size: 14 });
    closeBtn.onclick = () => finish(onCancel());
    head.append(titleEl, closeBtn);

    const body = document.createElement("div");
    body.className = "bt-modal-body";
    const focusTarget = buildBody(body, () => finish(onOk()));

    const foot = document.createElement("div");
    foot.className = "bt-modal-foot";
    if (cancelLabel) {
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "bt-modal-btn";
      cancelBtn.textContent = cancelLabel;
      cancelBtn.onclick = () => finish(onCancel());
      foot.appendChild(cancelBtn);
    }
    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.className = "bt-modal-btn " + (danger ? "danger" : "primary");
    okBtn.textContent = okLabel;
    okBtn.onclick = () => finish(onOk());
    foot.appendChild(okBtn);

    modal.append(head, body, foot);

    function onKeyDown(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(onCancel());
      }
    }
    // Клавиатура ловится на самом оверлее, а не на document: страница под
    // модалкой (карта стола, окно заметки) слушает Esc и свои горячие
    // клавиши, и они не должны срабатывать «сквозь» диалог.
    overlay.addEventListener("keydown", onKeyDown);
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) finish(onCancel());
    });

    let done = false;
    function finish(value) {
      if (done) return;
      done = true;
      overlay.remove();
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
      resolve(value);
    }

    document.body.appendChild(overlay);
    (focusTarget || okBtn).focus();
    if (focusTarget && focusTarget.select) focusTarget.select();
  });
}

// showAlert — «прочитал и закрыл». Промис на случай, если вызывающему важно
// дождаться, пока человек закроет окно (как ждал бы нативный alert).
export function showAlert(message, { title = "Beacon Table", okLabel = "Понятно" } = {}) {
  return openModal({
    title,
    okLabel,
    cancelLabel: "",
    buildBody: (body) => {
      const p = document.createElement("p");
      p.className = "bt-modal-text";
      p.textContent = message;
      body.appendChild(p);
      return null;
    },
    onOk: () => undefined,
    onCancel: () => undefined,
  });
}

// showConfirm — да/нет. danger: true красит подтверждение в цвет опасного
// действия (удаление) — как и кнопки удаления по всему приложению.
export function showConfirm(
  message,
  { title = "Подтверждение", okLabel = "Да", cancelLabel = "Отмена", danger = false, hint = "" } = {}
) {
  return openModal({
    title,
    danger,
    okLabel,
    cancelLabel,
    buildBody: (body) => {
      const p = document.createElement("p");
      p.className = "bt-modal-text";
      p.textContent = message;
      body.appendChild(p);
      if (hint) {
        const h = document.createElement("p");
        h.className = "bt-modal-text dim";
        h.textContent = hint;
        body.appendChild(h);
      }
      return null;
    },
    onOk: () => true,
    onCancel: () => false,
  });
}

// showPrompt — ввод строки; null — отмена (как у нативного prompt, чтобы
// «отменил» не путалось с «оставил пусто»). multiline: true — многострочное
// поле (Enter переносит строку, подтверждение — кнопкой или Ctrl+Enter).
export function showPrompt(
  label,
  { title = "Ввод", value = "", placeholder = "", okLabel = "ОК", cancelLabel = "Отмена", multiline = false, hint = "" } = {}
) {
  let field = null;
  return openModal({
    title,
    okLabel,
    cancelLabel,
    buildBody: (body, submit) => {
      if (label) {
        const l = document.createElement("p");
        l.className = "bt-modal-text";
        l.textContent = label;
        body.appendChild(l);
      }
      field = document.createElement(multiline ? "textarea" : "input");
      field.className = multiline ? "bt-modal-textarea" : "bt-modal-input";
      if (!multiline) field.type = "text";
      field.value = value;
      field.placeholder = placeholder;
      field.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        if (multiline && !(e.ctrlKey || e.metaKey)) return; // в многострочном Enter — это перевод строки
        e.preventDefault();
        submit();
      });
      body.appendChild(field);
      if (hint) {
        const h = document.createElement("p");
        h.className = "bt-modal-text dim";
        h.textContent = hint;
        body.appendChild(h);
      }
      return field;
    },
    onOk: () => field.value,
    onCancel: () => null,
  });
}
