import { icon } from "./icons.js";
import { openStatusPalette, closeStatusPalette } from "./status-palette.js";
import { openFloatingWindow } from "./floating-window.js";
import { showConfirm } from "./modal.js";

// ПКМ игрока по СВОЕМУ токену (Token.OwnerID == он): то же меню, что у ДМ
// (web/dm.html #tokenMenu), без того, что решает ДМ — инициатива, владелец,
// скрытость, замок, копия, этаж. Что остаётся: лист персонажа или статблок
// призванного существа, метки состояний, форма, зрение, свет, убрать
// призванного с карты. Сервер принимает правки только на свои токены
// (internal/service/room.go: playerMayTouch, applyOwnTokenUpdate).
//
// Стили — из JS, как у палитры состояний: страница игрока одна, но меню
// должно совпадать с ДМ-ским по виду, а тот живёт в dm.html.
const CSS = `
.pt-menu {
  position: fixed; display: none; z-index: 10; min-width: 190px; box-sizing: border-box;
  background: var(--glass-bg-strong); backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--glass-border); border-radius: var(--radius-lg);
  padding: 8px; font-size: 13px; box-shadow: var(--shadow-float);
  max-height: calc(100vh - 16px); overflow-y: auto;
}
.pt-menu.open { display: block; }
.pt-menu label { display: flex; align-items: center; gap: 6px; padding: 4px 2px; cursor: pointer; }
.pt-menu .pt-field { display: none; }
.pt-menu .pt-field.visible { display: flex; }
.pt-menu input[type="number"] { width: 64px; }
.pt-menu input[type="color"] { width: 42px; height: 22px; padding: 0; border: none; background: none; cursor: pointer; }
.pt-menu button {
  width: 100%; margin-top: 6px; display: flex; align-items: center; gap: 6px;
  padding: 7px 10px; border: 0; border-radius: 10px; background: var(--accent); color: #fff; font: inherit; font-size: 13px; cursor: pointer;
}
.pt-menu button:hover { background: var(--accent-hover); }
.pt-menu button.danger { background: var(--danger, #8b2c2c); }
.pt-menu button.danger:hover { background: var(--danger-hover, #a63a3a); }
.pt-menu .pt-title { font-weight: 600; padding: 2px 2px 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

export function mountPlayerTokenMenu({ send, getScene, playerId, openCharacterSheet }) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  const menu = document.createElement("div");
  menu.className = "pt-menu";
  document.body.appendChild(menu);
  let tokenId = null;

  const title = el("div", "pt-title");
  const sheetBtn = button(icon("scroll", { size: 14 }) + " Лист персонажа");
  const statBtn = button(icon("creature", { size: 14 }) + " Статблок");
  const statusBtn = button(icon("zap", { size: 14 }) + " Состояния");

  const shape = document.createElement("select");
  shape.innerHTML = '<option value="circle">○ Круг</option><option value="square">▢ Квадрат</option>';
  const shapeRow = label("Форма: ", shape);

  const vision = document.createElement("select");
  vision.innerHTML = '<option value="">обычное</option><option value="dark">тёмное</option>';
  const visionRow = label("зрение: ", vision);
  const visionRange = number(0, 5);
  const visionRangeRow = label("радиус ", visionRange, "pt-field");

  const light = document.createElement("input");
  light.type = "checkbox";
  light.className = "switch";
  const lightRow = label("", light, "", "источник света");
  const lightBright = number(0, 5);
  const lightDim = number(0, 5);
  const lightColor = document.createElement("input");
  lightColor.type = "color";
  const brightRow = label("яркий ", lightBright, "pt-field");
  const dimRow = label("тусклый ", lightDim, "pt-field");
  const colorRow = label("цвет ", lightColor, "pt-field");

  const removeBtn = button(icon("trash", { size: 14 }) + " Убрать с карты", "danger");

  menu.append(title, sheetBtn, statBtn, statusBtn, shapeRow, visionRow, visionRangeRow, lightRow, brightRow, dimRow, colorRow, removeBtn);

  function live() {
    return tokenId ? (getScene().tokens || {})[tokenId] : null;
  }

  function syncFields() {
    visionRangeRow.classList.toggle("visible", vision.value === "dark");
    for (const row of [brightRow, dimRow, colorRow]) row.classList.toggle("visible", light.checked);
  }

  // Правка уходит одним сообщением со всеми тремя полями — сервер берёт
  // только их (см. applyOwnTokenUpdate), остальное из живого токена.
  function sendUpdate() {
    const t = live();
    if (!t) return;
    const visionMode = vision.value;
    const range = +visionRange.value || 0;
    send({
      type: "update_own_token",
      token: {
        id: t.id,
        shape: shape.value === "square" ? "square" : "",
        vision: visionMode ? { mode: visionMode, range } : null,
        light: light.checked
          ? { enabled: true, bright: +lightBright.value || 0, dim: +lightDim.value || 0, color: lightColor.value, angle: (t.light && t.light.angle) || 0, direction: (t.light && t.light.direction) || 0 }
          : t.light
            ? { ...t.light, enabled: false }
            : null,
      },
    });
  }

  shape.onchange = sendUpdate;
  vision.onchange = () => {
    // 60 фт — тёмное зрение большинства рас 5e, как и у ДМ.
    if (vision.value === "dark" && !(+visionRange.value > 0)) visionRange.value = 60;
    syncFields();
    sendUpdate();
  };
  visionRange.oninput = debounce(sendUpdate);
  light.onchange = () => {
    // Факел по умолчанию: включил — уже светит, без возни с полями.
    if (light.checked && !(+lightBright.value > 0) && !(+lightDim.value > 0)) {
      lightBright.value = 20;
      lightDim.value = 40;
    }
    syncFields();
    sendUpdate();
  };
  lightBright.oninput = debounce(sendUpdate);
  lightDim.oninput = debounce(sendUpdate);
  lightColor.oninput = debounce(sendUpdate);

  sheetBtn.onclick = () => {
    const t = live();
    close();
    if (t && t.characterId) openCharacterSheet({ id: t.characterId, name: t.label });
  };
  statBtn.onclick = () => {
    const t = live();
    close();
    if (t && t.monsterId) openFloatingWindow({ key: "monster-" + t.monsterId, title: t.label || "Существо", url: "/bestiary.html?id=" + encodeURIComponent(t.monsterId), width: 560, height: 640 });
  };
  statusBtn.onclick = (e) => {
    const id = tokenId;
    const t = live();
    close();
    if (!t) return;
    openStatusPalette({
      x: e.clientX,
      y: e.clientY,
      target: { tokenId: id },
      send,
      title: t.label || "Токен",
      statusesFor: () => {
        const tok = (getScene().tokens || {})[id];
        return (tok && tok.statuses) || [];
      },
    });
  };
  removeBtn.onclick = async () => {
    const t = live();
    close();
    if (!t) return;
    if (!(await showConfirm(`Убрать «${t.label || "существо"}» с карты?`, { title: "Призванное существо", okLabel: "Убрать", danger: true }))) return;
    send({ type: "remove_own_token", id: t.id });
  };

  function open(t, x, y) {
    tokenId = t.id;
    title.textContent = t.label || "Мой токен";
    sheetBtn.style.display = t.characterId ? "flex" : "none";
    statBtn.style.display = t.monsterId ? "flex" : "none";
    // Убрать можно только призванного: фишку персонажа ставит ДМ.
    removeBtn.style.display = !t.characterId ? "flex" : "none";
    shape.value = t.shape === "square" ? "square" : "circle";
    vision.value = (t.vision && t.vision.mode) || "";
    visionRange.value = (t.vision && t.vision.range) || 0;
    light.checked = !!(t.light && t.light.enabled);
    lightBright.value = (t.light && t.light.bright) || 0;
    lightDim.value = (t.light && t.light.dim) || 0;
    lightColor.value = /^#[0-9a-fA-F]{6}$/.test((t.light && t.light.color) || "") ? t.light.color : "#ffcc66";
    syncFields();
    menu.classList.add("open");
    // В пределах окна: у нижнего/правого края разворачиваем.
    const w = menu.offsetWidth || 200;
    const h = menu.offsetHeight || 300;
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + "px";
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + "px";
  }
  function close() {
    menu.classList.remove("open");
    tokenId = null;
  }

  document.addEventListener("vtt:tokenContextMenu", (e) => {
    const { token, pageX, pageY } = e.detail;
    if (!token || token.ownerId !== playerId) return;
    closeStatusPalette();
    open(token, pageX, pageY);
  });
  document.addEventListener("pointerdown", (e) => {
    if (menu.classList.contains("open") && !menu.contains(e.target)) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  // Токен пропал (ДМ убрал, телепорт) — меню закрывается, а не висит над пустотой.
  document.addEventListener("vtt:sceneUpdated", () => {
    if (tokenId && !live()) close();
  });
}

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
function button(html, cls) {
  const b = el("button", cls);
  b.type = "button";
  b.innerHTML = html;
  return b;
}
function number(min, step) {
  const i = document.createElement("input");
  i.type = "number";
  i.min = String(min);
  i.step = String(step);
  i.value = "0";
  return i;
}
function label(text, input, cls, after) {
  const l = el("label", cls);
  if (text) l.append(text);
  l.appendChild(input);
  if (after) l.append(" " + after);
  return l;
}
function debounce(fn) {
  let t = null;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, 250);
  };
}
