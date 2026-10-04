// modules-notice.js — напоминание на столе, что миру не хватает модулей
// (см. GET /api/modules: world.missing). Закрывается крестиком до перезагрузки.
import { fetchModules } from "./api.js";

export async function showMissingModulesNotice() {
  let data;
  try {
    data = await fetchModules();
  } catch {
    return;
  }
  const missing = (data.world && data.world.missing) || [];
  if (!missing.length) return;
  const bar = document.createElement("div");
  bar.setAttribute("role", "status");
  bar.style.cssText =
    "position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:150;max-width:min(560px,calc(100% - 24px));display:flex;align-items:center;gap:10px;" +
    "padding:8px 12px;border-radius:var(--radius,10px);background:var(--glass-bg-strong,#16161d);border:1px solid var(--accent,#7c6cf0);color:var(--text,#eee);font-size:12.5px;box-shadow:var(--shadow-soft)";
  const text = document.createElement("span");
  text.textContent = `Не хватает модулей: ${missing.join(", ")}. Карточек и правил из них в мире нет.`;
  const link = document.createElement("a");
  link.href = "/modules.html";
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "Открыть витрину";
  link.style.cssText = "color:var(--accent,#7c6cf0);white-space:nowrap";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "✕";
  close.setAttribute("aria-label", "Закрыть");
  close.style.cssText = "background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:13px";
  close.onclick = () => bar.remove();
  bar.append(text, link, close);
  document.body.appendChild(bar);
}
