import { icon } from "./icons.js";

// Панель «Призыв» игрока: существа, которые ДМ разрешил призывать
// (Monster.Summonable, либо вся библиотека при CombatState.SummonAll),
// количество и кнопка. Запрос уходит ДМ (см. internal/service/room_summon.go),
// ответ приходит summon_status: «ждём», «пустили N», «отказ: причина».
// Список просим у сервера при открытии панели и перечитываем, когда
// библиотека или тумблеры стола поменялись; пока призывать нечего — панель
// прячется целиком, как «Карты».
export function mountSummonPanel(panelEl, { send }) {
  panelEl.classList.add("summon-panel");

  const header = document.createElement("div");
  header.className = "compendium-panel-header";
  const title = document.createElement("span");
  title.textContent = "Призыв";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "icon-btn";
  closeBtn.innerHTML = icon("close", { size: 14 });
  closeBtn.title = "Закрыть";
  closeBtn.onclick = () => panelEl.close();
  header.append(title, closeBtn);

  // Поиск — встроенный каталог это сотни строк, «сова» надо найти сразу.
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Найти существо…";
  search.className = "summon-search";
  const list = document.createElement("div");
  list.className = "summon-list";
  const form = document.createElement("div");
  form.className = "summon-form";
  const countInput = document.createElement("input");
  countInput.type = "number";
  countInput.min = "1";
  countInput.max = "20";
  countInput.value = "1";
  countInput.title = "Сколько";
  const askBtn = document.createElement("button");
  askBtn.type = "button";
  askBtn.className = "summon-ask";
  askBtn.innerHTML = icon("creature", { size: 14 }) + " Призвать";
  form.append(countInput, askBtn);
  const status = document.createElement("p");
  status.className = "summon-status";
  status.hidden = true;
  panelEl.append(header, search, list, form, status);

  let monsters = [];
  let selectedId = "";
  let pending = false;

  function setStatus(text, kind) {
    status.hidden = !text;
    status.textContent = text || "";
    status.className = "summon-status" + (kind ? " " + kind : "");
  }

  function render() {
    list.innerHTML = "";
    const q = search.value.trim().toLowerCase();
    const shown = q ? monsters.filter((m) => m.name.toLowerCase().includes(q)) : monsters;
    if (!shown.some((m) => m.id === selectedId)) selectedId = shown[0] ? shown[0].id : "";
    for (const m of shown) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "scene-row row-card scene-pick summon-row" + (m.id === selectedId ? " active" : "");
      row.setAttribute("aria-pressed", String(m.id === selectedId));
      if (m.imageUrl) {
        const img = document.createElement("img");
        img.src = m.imageUrl;
        img.alt = "";
        img.className = "summon-art";
        row.appendChild(img);
      }
      const name = document.createElement("span");
      name.className = "scene-name";
      name.textContent = m.name;
      row.appendChild(name);
      if (m.cr) {
        const cr = document.createElement("span");
        cr.className = "pill-badge";
        cr.textContent = "ПО " + m.cr;
        row.appendChild(cr);
      }
      row.onclick = () => {
        selectedId = m.id;
        render();
      };
      list.appendChild(row);
    }
    askBtn.disabled = !selectedId || pending;
    panelEl.host.style.display = monsters.length ? "" : "none";
  }

  search.addEventListener("input", render);

  askBtn.onclick = () => {
    if (!selectedId) return;
    const count = Math.max(1, Math.min(20, parseInt(countInput.value, 10) || 1));
    pending = true;
    setStatus("Ждём решения ДМ…", "");
    send({ type: "summon_request", monsterId: selectedId, count });
    render();
  };

  document.addEventListener("vtt:summonList", (e) => {
    monsters = e.detail.monsters || [];
    render();
  });
  document.addEventListener("vtt:summonStatus", (e) => {
    const d = e.detail;
    if (d.status === "pending") return;
    pending = false;
    if (d.status === "approved") setStatus(`ДМ пустил: «${d.monsterName}» × ${d.count}. Фишки рядом с тобой.`, "ok");
    else setStatus(d.reason ? `Отказ: ${d.reason}` : "ДМ отказал.", "error");
    render();
  });
  // Список — с сервера: по первому combat_state (он приходит при входе, к
  // этому моменту сокет точно открыт) и когда поменялись библиотека (флаг на
  // карточке) или тумблер «вся библиотека». Остальные combat_state —
  // ходы боя — список не трогают.
  const refresh = () => send({ type: "summon_list" });
  document.addEventListener("vtt:libraryChanged", (e) => {
    if (!e.detail || e.detail.kind === "compendium") refresh();
  });
  let all = null;
  document.addEventListener("vtt:combatState", (e) => {
    const next = !!(e.detail && e.detail.summonAll);
    if (next === all) return;
    all = next;
    refresh();
  });
  render();
}
