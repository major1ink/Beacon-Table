// avatar-cropper.js — кадрирование аватара/токен-арта перед загрузкой.
// Раньше файл уходил как есть и везде обрезался по центру (cover), поправить
// кадр было нечем. На сервер уходит готовый квадрат, поэтому все места показа
// (фишка на карте, чип в доке, шапка листа) берут один и тот же кадр.
// Видео (mp4/webm) не кадрируется — уходит как есть.
import { openModal } from "./modal.js";
import { uploadFile } from "./api.js";

// isVideoAvatar — по расширению, как player.js/dm.js: isVideoUrl (в разметке
// есть только URL, не MIME).
export function isVideoAvatar(url) {
  return /\.(mp4|webm|m4v)(\?|#|$)/i.test(url || "");
}

// maxOutputSize — потолок стороны квадрата: больше не нужно даже фишке на
// карте в максимальном зуме.
const maxOutputSize = 512;
const maxZoom = 4;

let styleInjected = false;
function injectStyle() {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .bt-crop-stage {
      position: relative; width: 100%; aspect-ratio: 1 / 1; overflow: hidden;
      border-radius: var(--radius-lg, 18px); background: var(--surface, #26262f);
      cursor: grab; touch-action: none; user-select: none;
    }
    .bt-crop-stage.dragging { cursor: grabbing; }
    .bt-crop-stage img { position: absolute; display: block; max-width: none; pointer-events: none; }
    /* Круг-подсказка: арт показывается и кругом (чип, фишка), и квадратом
       (шапка листа) — видно, что по углам обрежется не везде. */
    .bt-crop-ring {
      position: absolute; inset: 0; pointer-events: none;
      box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.35) inset;
      border-radius: 50%;
    }
    .bt-crop-zoom { display: flex; align-items: center; gap: 10px; }
    .bt-crop-zoom input[type="range"] { flex: 1 1 auto; accent-color: var(--accent, #7c6cf0); }
  `;
  document.head.appendChild(style);
}

// loadImage — File или URL (свой /uploads) → готовый <img> и release для
// blob:-ссылки. Отзывать её сразу после onload нельзя: этот же элемент потом
// показывается в окне кадрирования и остался бы пустым.
function loadImage(source) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = typeof source === "string" ? null : URL.createObjectURL(source);
    const release = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    img.onload = () => {
      if (!img.naturalWidth || !img.naturalHeight) {
        release();
        reject(new Error("файл не похож на картинку"));
      } else {
        resolve({ img, release });
      }
    };
    img.onerror = () => {
      release();
      reject(new Error("не удалось прочитать картинку"));
    };
    img.src = objectUrl || source;
  });
}

// Геометрия — в долях картинки, от размера окошка не зависит: zoom — во
// сколько раз крупнее cover, cx/cy (0..1) — точка, стоящая в центре окошка.
// Одни и те же цифры годятся и для превью в процентах, и для вырезки.
function frame(img, zoom) {
  const wRatio = Math.max(1, img.naturalWidth / img.naturalHeight) * zoom; // ширина картинки / сторона окошка
  const hRatio = Math.max(1, img.naturalHeight / img.naturalWidth) * zoom;
  return { wRatio, hRatio };
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

// cropImage — окно кадрирования. Возвращает Blob готового квадрата или null,
// если человек передумал.
export async function cropImage(source, { title = "Кадрирование" } = {}) {
  injectStyle();
  const { img, release } = await loadImage(source);

  let zoom = 1;
  let cx = 0.5;
  let cy = 0.5;

  // Сам загруженный элемент, а не копия: копия грузила бы ту же blob:-ссылку
  // второй раз (а после release — уже никак).
  const view = img;
  view.alt = "";
  const stage = document.createElement("div");
  stage.className = "bt-crop-stage";
  const ring = document.createElement("div");
  ring.className = "bt-crop-ring";
  stage.append(view, ring);

  const zoomInput = document.createElement("input");
  zoomInput.type = "range";
  zoomInput.min = "1";
  zoomInput.max = String(maxZoom);
  zoomInput.step = "0.01";
  zoomInput.value = "1";

  function apply() {
    const { wRatio, hRatio } = frame(img, zoom);
    // Картинка всегда закрывает окошко целиком — центр не пускаем ближе к
    // краю, чем полокошка.
    cx = clamp(cx, 0.5 / wRatio, 1 - 0.5 / wRatio);
    cy = clamp(cy, 0.5 / hRatio, 1 - 0.5 / hRatio);
    view.style.width = wRatio * 100 + "%";
    view.style.height = hRatio * 100 + "%";
    view.style.left = (0.5 - cx * wRatio) * 100 + "%";
    view.style.top = (0.5 - cy * hRatio) * 100 + "%";
  }
  apply();

  const pointers = new Map();
  let pinchStart = 0; // расстояние между пальцами на момент начала щипка
  let pinchZoom = 1;

  stage.addEventListener("pointerdown", (e) => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      pinchZoom = zoom;
    }
    stage.classList.add("dragging");
  });
  stage.addEventListener("pointermove", (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const side = stage.clientWidth || 1;
    if (pointers.size === 2) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      setZoom(pinchZoom * (dist / pinchStart));
      return;
    }
    const { wRatio, hRatio } = frame(img, zoom);
    cx -= (e.clientX - prev.x) / (side * wRatio);
    cy -= (e.clientY - prev.y) / (side * hRatio);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    apply();
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = 0;
    if (!pointers.size) stage.classList.remove("dragging");
  };
  stage.addEventListener("pointerup", endPointer);
  stage.addEventListener("pointercancel", endPointer);
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
  });

  function setZoom(next) {
    zoom = clamp(next, 1, maxZoom);
    zoomInput.value = String(zoom);
    apply();
  }
  zoomInput.oninput = () => setZoom(parseFloat(zoomInput.value) || 1);

  const ok = await openModal({
    title,
    okLabel: "Готово",
    cancelLabel: "Отмена",
    buildBody(body) {
      const hint = document.createElement("p");
      hint.className = "bt-modal-text dim";
      hint.textContent = "Тяни картинку и меняй масштаб — в кадр попадёт то, что внутри рамки.";
      const zoomRow = document.createElement("div");
      zoomRow.className = "bt-crop-zoom";
      const minus = document.createElement("span");
      minus.textContent = "−";
      const plus = document.createElement("span");
      plus.textContent = "+";
      zoomRow.append(minus, zoomInput, plus);
      body.append(stage, zoomRow, hint);
      return null;
    },
    onOk: () => true,
    onCancel: () => false,
  });
  if (!ok) {
    release();
    return null;
  }

  // Теми же долями, что и превью. Апскейла нет: кусок мельче потолка таким и
  // останется — растянуть можно на показе.
  const { wRatio, hRatio } = frame(img, zoom);
  const sw = img.naturalWidth / wRatio;
  const sh = img.naturalHeight / hRatio;
  const sx = clamp(cx * img.naturalWidth - sw / 2, 0, img.naturalWidth - sw);
  const sy = clamp(cy * img.naturalHeight - sh / 2, 0, img.naturalHeight - sh);
  const side = Math.max(64, Math.round(Math.min(maxOutputSize, Math.min(sw, sh))));

  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, side, side);

  // webp — альфа сохраняется (токен-арт часто с ней), вес меньше png.
  // Не умеет браузер — toBlob вернёт png.
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.92));
  const out = blob || (await new Promise((resolve) => canvas.toBlob(resolve, "image/png")));
  release();
  return out;
}

// uploadAvatarFile — файл → URL на сервере. Картинка через кадрирование
// (null = отменили), видео как есть.
export async function uploadAvatarFile(file, { kind = "tokens", title } = {}) {
  if (!file) return null;
  if (file.type.startsWith("video/")) {
    const { url } = await uploadFile(file, kind);
    return url;
  }
  const blob = await cropImage(file, { title });
  if (!blob) return null;
  const base = (file.name || "avatar").replace(/\.[^.]+$/, "");
  const ext = blob.type === "image/webp" ? ".webp" : ".png";
  const { url } = await uploadFile(new File([blob], base + ext, { type: blob.type }), kind);
  return url;
}

// recropAvatarUrl — переснять кадр уже загруженного аватара, не выбирая файл
// заново. Результат — новый файл, старый остаётся в библиотеке токен-арта.
export async function recropAvatarUrl(url, { kind = "tokens", title } = {}) {
  if (!url || isVideoAvatar(url)) return null;
  const blob = await cropImage(url, { title });
  if (!blob) return null;
  const ext = blob.type === "image/webp" ? ".webp" : ".png";
  const { url: next } = await uploadFile(new File([blob], "avatar" + ext, { type: blob.type }), kind);
  return next;
}
