import { icon } from "./icons.js";

// Панель «Карты» игрока: сцены, которые ДМ открыл (SceneState.PlayerAccess),
// плюс та, что сейчас за столом. Клик — view_scene: открыть у себя, стол не
// трогая; «Вернуться к столу» — снова активная. Список приходит в scene_list
// уже отфильтрованным (см. broadcastSceneList в internal/service/room.go),
// здесь только отрисовка. Пока открыть больше нечего (одна активная сцена),
// панель прячется целиком — иконка без выбора только сбивает с толку.
export function mountScenePicker(panelEl, { send }) {
  panelEl.classList.add("scene-picker");

  const header = document.createElement("div");
  header.className = "compendium-panel-header";
  const title = document.createElement("span");
  title.textContent = "Карты";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "icon-btn";
  closeBtn.innerHTML = icon("close", { size: 14 });
  closeBtn.title = "Закрыть";
  closeBtn.onclick = () => panelEl.close();
  header.append(title, closeBtn);

  const list = document.createElement("div");
  list.className = "scene-picker-list";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "scene-picker-back";
  back.innerHTML = icon("users", { size: 14 }) + " Вернуться к столу";
  panelEl.append(header, list, back);

  let scenes = [];
  let activeId = "";
  let viewId = "";

  back.onclick = () => {
    if (activeId && activeId !== viewId) send({ type: "view_scene", sceneId: activeId });
  };

  function render() {
    list.innerHTML = "";
    for (const s of scenes) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "scene-row row-card scene-pick" + (s.id === viewId ? " active" : "");
      row.setAttribute("aria-pressed", String(s.id === viewId));
      const name = document.createElement("span");
      name.className = "scene-name";
      name.textContent = s.name;
      row.appendChild(name);
      if (s.id === activeId) {
        const live = document.createElement("span");
        live.className = "pill-badge on";
        live.innerHTML = icon("users", { size: 10 });
        live.append(" за столом");
        live.title = "Эту сцену сейчас показывает ДМ";
        row.appendChild(live);
      }
      row.onclick = () => {
        if (s.id !== viewId) send({ type: "view_scene", sceneId: s.id });
        panelEl.close();
      };
      list.appendChild(row);
    }
    // «Вернуться» — только если ушёл сам: этаж здания, где стоит твой токен
    // (см. sceneOf в internal/service/room.go), в списке не значится, и
    // возвращаться с него некуда — стол и так показывает твой этаж.
    back.hidden = !activeId || viewId === activeId || !scenes.some((s) => s.id === viewId);
    // Одна сцена и она активная — выбирать нечего.
    panelEl.host.style.display = scenes.length > 1 ? "" : "none";
  }

  document.addEventListener("vtt:sceneList", (e) => {
    scenes = e.detail.scenes || [];
    activeId = e.detail.currentSceneId || "";
    viewId = e.detail.viewSceneId || activeId;
    render();
  });
  render();
}
