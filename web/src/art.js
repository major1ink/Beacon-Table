// art.js — арт существа в шапках и списках: картинка или анимированный
// токен (mp4/webm). Видео здесь не играет — стоит кадром, как картинка:
// анимация нужна на карте, а десяток роликов в каталоге только грузит страницу.
import { cssUrl } from "./html.js";
import { isVideoUrl } from "./geometry.js";

// artNode — <img> или <video> на первом кадре.
export function artNode(url, className) {
  if (!isVideoUrl(url)) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    if (className) img.className = className;
    return img;
  }
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "metadata";
  v.setAttribute("aria-hidden", "true");
  // #t — без него часть браузеров по metadata не рисует кадр, остаётся пусто.
  v.src = url.includes("#") ? url : url + "#t=0.1";
  if (className) v.className = className;
  return v;
}

// setArtBackground — арт фоном аватара; видео фоном не бывает — кадр внутри.
export function setArtBackground(el, url) {
  if (isVideoUrl(url)) el.appendChild(artNode(url, "art-fill"));
  else el.style.backgroundImage = cssUrl(url);
}
