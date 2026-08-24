// worlds.js — экран выбора мира (worlds.html), по аналогии с Foundry VTT
// Setup: ДМ видит все свои миры (компании) и выбирает, какой из них сейчас
// поднят на сервере (см. internal/app.CompanyManager — активен ровно один).
// Только для admin — index.js уводит сюда ДМ сразу после логина, обычный
// игрок сюда попасть не может (см. guard ниже, симметрично dm.js).
import { fetchMe, apiLogout, fetchCompanies, createCompany, launchCompany, deleteCompany } from "../api.js";
import { showAlert, showConfirm } from "../modal.js";

const listEl = document.getElementById("list");
const createForm = document.getElementById("createForm");
const createMsg = document.getElementById("createMsg");

const SYSTEM_LABELS = { "dnd5e-2024": "D&D 2024", "dnd5e-2014": "D&D 5e (2014)" };
function systemLabel(system) {
  return SYSTEM_LABELS[system] || system;
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function worldCardHTML(c) {
  const badge = c.active ? `<span class="pill-badge on">Активен</span>` : "";
  const actionBtn = c.active
    ? `<button class="world-btn open-btn" data-id="${c.id}">Открыть стол →</button>`
    : `<button class="world-btn launch-btn" data-id="${c.id}">Запустить</button>`;
  return `
    <div class="row-card world-card" data-id="${c.id}">
      <div class="world-info">
        <div class="world-name">${escapeHtml(c.name)}</div>
        <div class="world-meta">
          <span class="pill-badge">${systemLabel(c.system)}</span>
          ${badge}
        </div>
      </div>
      <div class="world-actions">
        ${actionBtn}
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
  listEl.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.onclick = async () => {
      if (!(await showConfirm("Удалить этот мир из списка?", { title: "Удалить мир", okLabel: "Удалить", danger: true, hint: "Файлы на диске не трогаются." }))) return;
      try {
        await deleteCompany(btn.dataset.id);
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
