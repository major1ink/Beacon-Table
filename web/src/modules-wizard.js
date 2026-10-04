// modules-wizard.js — экран «Для запуска мира нужны модули» (см.
// GET /api/companies/{id}/requirements): человек сам выбирает, что поставить,
// или запускает мир без модулей. Ничего не ставится без нажатия.
import { installCatalogModule, installModuleFile } from "./api.js";
import { el as h } from "./card-shell.js";
import { openModal } from "./modal.js";
import { TYPE_LABEL, formatSize } from "./modules-view.js";

let styled = false;
function injectStyle() {
  if (styled) return;
  styled = true;
  const style = document.createElement("style");
  style.textContent = `
    .bt-modal .wiz-rows { display: flex; flex-direction: column; gap: 8px; }
    .bt-modal .wiz-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
    .bt-modal .wiz-info { min-width: 0; display: flex; flex-direction: column; gap: 5px; }
    .bt-modal .wiz-state { flex: 0 0 auto; display: flex; align-items: center; }
    .bt-modal .wiz-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .bt-modal .mod-name { font-size: 14px; font-weight: 600; }
    .bt-modal .detail-meta { display: flex; flex-wrap: wrap; gap: 6px; }
    .bt-modal .hint { font-size: 12px; color: var(--text-dim); line-height: 1.5; }
    .bt-modal .pill { display: inline-block; border-radius: var(--radius-pill); padding: 1px 8px; font-size: 11px; background: rgba(255, 255, 255, 0.07); color: var(--text-dim); }
    .bt-modal .pill.on { background: rgba(31, 107, 58, 0.35); color: var(--green-bright); }
    .bt-modal .pill.warn { background: rgba(165, 115, 15, 0.3); color: #e6b450; }
    .bt-modal .act { border: none; border-radius: var(--radius); padding: 8px 14px; font-size: 12.5px; font-weight: 600; cursor: pointer; background: var(--accent); color: #fff; white-space: nowrap; }
    .bt-modal .act:hover { background: var(--accent-hover); }
    .bt-modal .act.alt { background: var(--surface); color: var(--text-dim); border: 1px solid var(--border); }
    .bt-modal .act.alt:hover { background: var(--surface-hover); color: var(--text); }
    .bt-modal .act:disabled { opacity: 0.6; cursor: default; }
    @media (max-width: 520px) { .bt-modal .wiz-row { flex-direction: column; } }
  `;
  document.head.appendChild(style);
}

// needsSystem — модулю нужна ещё не установленная система из этого списка.
export function needsSystem(m, list) {
  return (m.requires || []).some((d) => list.some((x) => x.id === d.id && !x.done));
}

// runModulesWizard — true: запускать мир; false: отмена. req — ответ requirements.
export function runModulesWizard(req) {
  const list = req.missing.map((m) => ({ ...m, done: false }));
  let statusEl;
  let rowsEl;
  let okBtn;

  const pending = () => list.filter((m) => !m.done);
  const installable = (m) => !m.done && m.inCatalog && m.compatible;

  function setStatus(text, kind) {
    statusEl.textContent = text || "";
    statusEl.style.color = kind === "error" ? "#e74c3c" : kind === "ok" ? "var(--green-bright)" : "var(--text-dim)";
  }

  function markDone(ids) {
    for (const m of list) if (ids.includes(m.id)) m.done = true;
    draw();
  }

  async function act(label, fn) {
    for (const b of document.querySelectorAll(".wiz-act")) b.disabled = true;
    setStatus(label);
    try {
      await fn();
      setStatus("");
    } catch (err) {
      setStatus(err.message, "error");
    }
    draw();
  }

  function installOne(m) {
    return act(`Устанавливаю «${m.title}»…`, async () => {
      const res = await installCatalogModule(m.id, true);
      markDone(res.installed.map((x) => x.id));
    });
  }

  function installAll() {
    return act("Устанавливаю…", async () => {
      for (const m of pending()) {
        if (!installable(m) || m.done) continue;
        const res = await installCatalogModule(m.id, true);
        markDone(res.installed.map((x) => x.id));
      }
    });
  }

  function row(m) {
    let state;
    if (m.done) state = h("span", { class: "pill on", text: "Установлен" });
    else if (!m.inCatalog) state = h("span", { class: "hint", text: "нет в каталоге — «Из файла»" });
    else if (!m.compatible) state = h("span", { class: "pill warn", text: "Нужно обновить программу" });
    else state = h("button", { type: "button", class: "act wiz-act", text: m.type === "content" && needsSystem(m, list) ? "Установить с системой" : "Установить", onclick: () => installOne(m) });
    const meta = [h("span", { class: "pill", text: TYPE_LABEL[m.type] || m.type })];
    if (m.size) meta.push(h("span", { class: "pill", text: formatSize(m.size) }));
    return h("div", { class: "wiz-row" }, [
      h("div", { class: "wiz-info" }, [h("div", { class: "mod-name", text: m.title }), h("div", { class: "detail-meta" }, meta), m.description ? h("div", { class: "hint", text: m.description }) : null]),
      h("div", { class: "wiz-state" }, [state]),
    ]);
  }

  function draw() {
    rowsEl.replaceChildren(...list.map(row));
    if (okBtn) okBtn.textContent = pending().length ? "Продолжить без модулей" : "Запустить мир";
  }

  injectStyle();
  return openModal({
    title: "Для запуска мира нужны модули",
    okLabel: "Продолжить без модулей",
    cancelLabel: "Отмена",
    buildBody: (body) => {
      const intro = `Мир «${req.world.name}» использует модули, которых нет на этом сервере. Установите их или запустите мир без них: лист покажется универсальным, карточек и правил модулей не будет. Данные мира не меняются.`;
      statusEl = h("div", { class: "hint", style: "min-height:16px" });
      rowsEl = h("div", { class: "wiz-rows" });
      const fileInput = h("input", { type: "file", accept: ".btmod,.zip,application/zip", hidden: true });
      fileInput.addEventListener("change", () => {
        const file = fileInput.files[0];
        fileInput.value = "";
        if (!file) return;
        act("Устанавливаю из файла…", async () => {
          const m = await installModuleFile(file);
          markDone([m.id]);
        });
      });
      const offline = req.catalogErrors && req.catalogErrors.length ? h("p", { class: "bt-modal-text dim", text: "Каталог недоступен: " + req.catalogErrors.join("; ") + ". «Из файла» работает без интернета." }) : null;
      body.append(
        ...[
          h("p", { class: "bt-modal-text", text: intro }),
          offline,
          rowsEl,
          h("div", { class: "wiz-tools" }, [
            h("button", { type: "button", class: "act wiz-act", text: "Установить всё", onclick: installAll }),
            h("button", { type: "button", class: "act alt wiz-act", text: "Из файла", onclick: () => fileInput.click() }),
            h("a", { class: "hint", href: "/modules.html", target: "_blank", rel: "noopener", text: "Открыть витрину" }),
          ]),
          fileInput,
          statusEl,
        ].filter(Boolean),
      );
      queueMicrotask(() => {
        const modal = body.closest(".bt-modal");
        if (modal) {
          modal.style.width = "min(640px, 100%)";
          okBtn = modal.querySelector(".bt-modal-btn.primary");
        }
      });
      draw();
      return null;
    },
    onOk: () => true,
    onCancel: () => false,
  });
}
