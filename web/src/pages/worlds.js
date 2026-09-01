// worlds.js — экран выбора мира (worlds.html), по аналогии с Foundry VTT
// Setup: ДМ видит все свои миры (компании) и выбирает, какой из них сейчас
// поднят на сервере (см. internal/app.CompanyManager — активен ровно один).
// Только для admin — index.js уводит сюда ДМ сразу после логина, обычный
// игрок сюда попасть не может (см. guard ниже, симметрично dm.js).
import { fetchMe, apiLogout, fetchCompanies, createCompany, launchCompany, deleteCompany, exportCompanyURL, importCompany, stopActiveWorld, fetchVersion } from "../api.js";
import { openModal, showAlert, showConfirm } from "../modal.js";

// Версия сервера в углу — как на экране входа (index.js). Молча пусто при ошибке.
fetchVersion()
  .then(({ version }) => {
    document.getElementById("appVersion").textContent = version;
  })
  .catch(() => {});

const listEl = document.getElementById("list");
const createForm = document.getElementById("createForm");
const createMsg = document.getElementById("createMsg");
const importBtn = document.getElementById("importBtn");
const importFile = document.getElementById("importFile");
const importMsg = document.getElementById("importMsg");

const SYSTEM_LABELS = { "dnd5e-2024": "D&D 2024", "dnd5e-2014": "D&D 5e (2014)" };
function systemLabel(system) {
  return SYSTEM_LABELS[system] || system;
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// Мир может быть ещё запущен (ДМ пришёл сюда сразу после логина, а не кнопкой
// «К мирам» из стола, которая гасит стол) — тогда «Открыть стол →» вместо
// «Запустить», как и было. Удаление такого мира сначала снимет его со стола.
function worldCardHTML(c) {
  const players = c.accounts ? `<span class="pill-badge">игроков: ${c.accounts}</span>` : "";
  const badge = c.active ? `<span class="pill-badge on">На столе</span>` : "";
  const actionBtn = c.active
    ? `<button class="world-btn open-btn" data-id="${c.id}">Открыть стол →</button>`
    : `<button class="world-btn launch-btn" data-id="${c.id}">Запустить</button>`;
  return `
    <div class="row-card world-card" data-id="${c.id}">
      <div class="world-info">
        <div class="world-name">${escapeHtml(c.name)}</div>
        <div class="world-meta">
          <span class="pill-badge">${systemLabel(c.system)}</span>
          ${players}
          ${badge}
        </div>
      </div>
      <div class="world-actions">
        ${actionBtn}
        <button class="icon-btn export-btn" data-id="${c.id}" title="Экспортировать мир в .zip">⬇</button>
        <button class="icon-btn danger delete-btn" data-id="${c.id}" title="Удалить">✕</button>
      </div>
    </div>
  `;
}

async function render() {
  let companies;
  try {
    companies = await fetchCompanies();
  } catch (err) {
    listEl.innerHTML = `<div class="msg error">${escapeHtml(err.message)}</div>`;
    return;
  }
  if (!companies.length) {
    listEl.innerHTML = `<div id="emptyMsg">Миров ещё нет — создай первый ниже.</div>`;
    return;
  }
  listEl.innerHTML = companies.map(worldCardHTML).join("");

  listEl.querySelectorAll(".launch-btn").forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = "Запускаю…";
      try {
        await launchCompany(btn.dataset.id);
        location.href = "/dm.html";
      } catch (err) {
        showAlert(err.message);
        btn.disabled = false;
        btn.textContent = "Запустить";
      }
    };
  });
  listEl.querySelectorAll(".open-btn").forEach((btn) => {
    btn.onclick = () => {
      location.href = "/dm.html";
    };
  });
  listEl.querySelectorAll(".export-btn").forEach((btn) => {
    btn.onclick = async () => {
      const choice = await askExportOptions();
      if (!choice.export) return;
      window.location.href = exportCompanyURL(btn.dataset.id, choice.withAccounts);
    };
  });
  listEl.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.onclick = async () => {
      const c = companies.find((w) => w.id === btn.dataset.id);
      const n = c?.accounts || 0;
      const parts = [];
      if (c?.active) parts.push("мир сейчас на столе — он будет снят, игроки отключатся");
      if (n > 0) parts.push(`удалятся ${n} аккаунт(а/ов) игроков с персонажами и инвентарём (аккаунт ДМ останется)`);
      parts.push("файлы мира на диске (сцены, журнал, загрузки) тоже удалятся");
      const hint = parts.join("; ") + ". Это необратимо.";
      if (!(await showConfirm(`Удалить мир «${c?.name || ""}»?`, { title: "Удалить мир", okLabel: "Удалить", danger: true, hint }))) return;
      try {
        if (c?.active) await stopActiveWorld();
        await deleteCompany(btn.dataset.id, n > 0);
        render();
      } catch (err) {
        showAlert(err.message);
      }
    };
  });
}

document.getElementById("logoutBtn").onclick = async () => {
  await apiLogout();
  location.href = "/";
};

// askExportOptions — диалог перед скачиванием: с аккаунтами игроков или без.
function askExportOptions() {
  let cb = null;
  return openModal({
    title: "Экспорт мира",
    okLabel: "Экспортировать",
    cancelLabel: "Отмена",
    buildBody: (body) => {
      const p = document.createElement("p");
      p.className = "bt-modal-text";
      p.textContent = "Скачать мир одним .zip: сцены, журнал, библиотеки, плейлисты, загрузки.";
      body.appendChild(p);
      const label = document.createElement("label");
      label.style.cssText = "display:flex;gap:8px;align-items:flex-start;font-size:13px;margin-top:6px;cursor:pointer;";
      cb = document.createElement("input");
      cb.type = "checkbox";
      label.append(cb, document.createTextNode(" Перенести аккаунты игроков с персонажами"));
      body.appendChild(label);
      const hint = document.createElement("p");
      hint.className = "bt-modal-text dim";
      hint.textContent = "Логины игроков с паролями, листы, инвентарь. Аккаунт ДМ не переносится — на сервере, куда импортируешь, используется его собственный. Нужно при переезде кампании; для обмена приключением обычно нет.";
      body.appendChild(hint);
      return cb;
    },
    onOk: () => ({ export: true, withAccounts: cb.checked }),
    onCancel: () => ({ export: false }),
  });
}

importBtn.onclick = () => importFile.click();
importFile.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = ""; // сброс, чтобы повторный выбор того же файла сработал
  if (!file) return;
  importMsg.textContent = "Импортирую…";
  importMsg.className = "msg";
  importBtn.disabled = true;
  try {
    const world = await importCompany(file);
    let msg = `Мир «${world.name}» импортирован — запусти его в списке выше.`;
    const renamed = world.renamedLogins ? Object.entries(world.renamedLogins) : [];
    if (renamed.length) {
      msg += ` Логины переименованы из-за совпадений: ${renamed.map(([o, n]) => `${o} → ${n}`).join(", ")}.`;
    }
    importMsg.textContent = msg;
    importMsg.className = "msg ok";
    render();
  } catch (err) {
    importMsg.textContent = err.message;
    importMsg.className = "msg error";
  } finally {
    importBtn.disabled = false;
  }
});

createForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  createMsg.textContent = "";
  createMsg.className = "msg";
  const name = document.getElementById("worldName").value.trim();
  const system = document.getElementById("worldSystem").value;
  try {
    await createCompany(name, system);
    createForm.reset();
    render();
  } catch (err) {
    createMsg.textContent = err.message;
    createMsg.className = "msg error";
  }
});

// guard — только admin. Игрок (или гость без сессии) уводится на "/", тем же
// принципом, что и dm.js/player.js проверяют роль перед рендером.
fetchMe().then((me) => {
  if (!me || me.role !== "admin") {
    location.href = "/";
    return;
  }
  render();
});
