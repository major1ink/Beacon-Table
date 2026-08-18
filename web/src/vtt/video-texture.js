import { Texture } from "pixi.js";

// Одно правило на весь проект: <video> отдаётся в Pixi ТОЛЬКО после того, как
// браузер показал хотя бы один декодированный кадр. Отдать раньше — получить
// НАВСЕГДА чёрную текстуру (и карты, и токена), вот механика целиком.
//
// Первую заливку Pixi делает девятиаргументным texImage2D, где источник — сам
// элемент <video> (rendering/renderers/gl/texture/uploaders/
// glUploadImageResource.mjs, uploadImageWebGL2, ветка needsAllocation).
// Chromium в этот момент спрашивает у медиаплеера текущий кадр
// (WebGLRenderingContextBase::TexImageHelperHTMLVideoElement) и, если кадра
// ещё нет, МОЛЧА выходит: ни одной GL-команды, ни ошибки в консоли, ни
// исключения. Нулевой уровень текстуры остаётся невыделенным — но Pixi об
// этом не знает и в конце upload() записывает glTexture.width/height так,
// будто аллокация прошла. С этого момента needsAllocation уже никогда не
// станет true, и каждый следующий кадр льётся через texSubImage2D в
// несуществующий уровень:
//
//   GL_INVALID_OPERATION: glTexSubImage2DRobustANGLE: Level of detail
//   outside of range.
//
// — по строке на кадр видео до конца сессии. Сэмплирование неполной текстуры
// даёт непрозрачный чёрный (0,0,0,1), поэтому снаружи это выглядит не как
// «фон не появился», а как «всё залито чёрным»: спрайт есть, размер
// правильный, texture.valid === true, диагностика чистая.
//
// Проверено на стенде (та же 4K-карта, отдача ~128 КБ/с с поддержкой Range —
// как у боевого Go-сервера): в момент loadedmetadata readyState === 1 и ноль
// декодированных кадров, то есть клиент с холодным кешем попадает в это окно
// штатно. У ДМ, который только что заливал файл и держит его в кеше браузера,
// кадр готов сразу — та же сцена рисуется нормально. Отсюда и «у меня всё
// видно, а у игроков чёрный экран».
//
// Ждём по двум признакам сразу, потому что ни один в одиночку не закрывает
// все случаи:
//
//   1. requestVideoFrameCallback — самый честный сигнал, вызывается ПОСЛЕ
//      показа кадра. Но он завязан на отрисовку страницы: во вкладке, которая
//      сейчас не композитится (свёрнутое окно, фоновая вкладка), он просто не
//      приходит — проверено, кадры декодируются, а колбэк молчит.
//   2. getVideoPlaybackQuality().totalVideoFrames > 0 — «декодирован хотя бы
//      один кадр», от отрисовки не зависит. Именно этот счётчик на стенде
//      совпал с моментом, когда заливка впервые дошла до драйвера (пока он был
//      нулём, Chromium молча глотал и texImage2D, и texSubImage2D).
//
// События loadeddata/canplay не годятся ни на что: Chrome прислал оба при
// readyState === 1 и нулевом счётчике декодированных кадров.
export function onFirstVideoFrame(video, cb) {
  let stopped = false;
  let rvfcHandle = null;
  let pollTimer = null;

  function stop() {
    stopped = true;
    if (rvfcHandle !== null && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(rvfcHandle);
    if (pollTimer !== null) clearInterval(pollTimer);
    rvfcHandle = null;
    pollTimer = null;
  }

  function fire() {
    if (stopped) return;
    stop();
    cb();
  }

  const hasFrame = () => {
    if (video.getVideoPlaybackQuality) return video.getVideoPlaybackQuality().totalVideoFrames > 0;
    // Движки без счётчика кадров: остаётся readyState >= HAVE_CURRENT_DATA.
    // Гарантия слабее, но и заливка там не через ANGLE — ловушка выше
    // специфична для Chromium.
    return video.readyState >= 2;
  };

  if (video.requestVideoFrameCallback) rvfcHandle = video.requestVideoFrameCallback(fire);
  pollTimer = setInterval(() => {
    if (hasFrame()) fire();
  }, 100);
  if (hasFrame()) fire();

  return stop; // вызывать, если видео выбросили раньше, чем приехал кадр
}

// createVideoTexture — то же самое, но сразу отдаёт готовую к рисованию
// текстуру. Возвращает функцию отмены (видео могли сменить, пока ждали кадр).
export function createVideoTexture(video, onTexture) {
  return onFirstVideoFrame(video, () => {
    const texture = Texture.from(video);
    // autoUpdate — дальше Pixi сам забирает новые кадры (rVFC/тикер), без
    // единого вызова с нашей стороны.
    if (texture.source) texture.source.autoUpdate = true;
    onTexture(texture);
  });
}
