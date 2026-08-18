import { Assets, Container, Sprite, Texture } from "pixi.js";
import { isVideoUrl } from "../../geometry.js";
import { worldSize } from "../camera.js";
import { createVideoTexture } from "../video-texture.js";

// Фон карты (картинка или зацикленное mp4/webm) — самый частый источник
// нагрузки в старом Canvas2D-движке: каждый кадр видео заново декодировался
// и рисовался через ctx.drawImage, плюс отдельный офскрин-кэш "последнего
// кадра" (mapVideoFrame) только чтобы обойти видимое мерцание на границе
// цикла. С PIXI.Texture.from(videoEl) этот хак не нужен вообще — Pixi сам
// сэмплирует текущий декодированный кадр видео как GPU-текстуру на каждый
// внутренний тик рендера, без единого вызова JS с нашей стороны; зацикливание
// (video.loop=true) остаётся плавным, потому что не завязано на то, успели
// ли мы вручную скопировать пиксели в этот конкретный момент.
export function createBackgroundLayer(ctx) {
  const container = new Container();

  let currentSprite = null;
  let mapVideo = null;
  let lastMapUrl = null;
  let lastMapStartedAt = null;
  let cancelFrameWait = null; // ожидание первого кадра текущего видео-фона
  let frameWatchdog = null; // таймер "кадры так и не поехали"
  let lastRecoveryAt = 0; // анти-петля пересоздания видео при реально битом файле (см. ниже)

  // Новый <video> на каждый видео-фон, а не один переиспользуемый на всю
  // жизнь слоя. Причина: Texture.from(element) кеширует текстуру ПО САМОМУ
  // элементу (см. pixi.js .../utils/textureFrom.js: resourceToTexture →
  // Cache.set(resource, texture)), поэтому при смене сцены на другое видео
  // тот же элемент отдавал СТАРУЮ текстуру от прошлого ролика. Отдельный
  // элемент на URL снимает эту коллизию, а старый мы явно глушим и
  // выбрасываем — иначе он продолжал бы качать и декодировать трафик в фоне
  // (для 4K-карты это десятки мегабайт).
  function createVideoEl(url) {
    const v = document.createElement("video");
    v.loop = true;
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.src = url;
    return v;
  }

  function releaseVideo() {
    if (cancelFrameWait) {
      cancelFrameWait();
      cancelFrameWait = null;
    }
    if (frameWatchdog !== null) {
      clearInterval(frameWatchdog);
      frameWatchdog = null;
    }
    if (!mapVideo) return;
    mapVideo.pause();
    mapVideo.removeAttribute("src");
    mapVideo.load();
    mapVideo = null;
    ctx.mapVideoEl = null;
  }

  // resizeSprite растягивает спрайт на мировой размер сцены. Вызывать её
  // ОБЯЗАТЕЛЬНО после того, как текстура узнала свой настоящий размер:
  // sprite.width/height — это не «занимать столько всегда», а разовая
  // фиксация scale относительно текущего texture.orig.width/height. Если
  // выставить размер, пока текстура ещё пустая (1×1 или 0×0), спрайт
  // застынет с абсурдным scale и после догрузки уже не исправится сам.
  function resizeSprite() {
    if (!currentSprite) return;
    // Texture.EMPTY имеет размер 0×0, а sprite.width = v пересчитывает scale
    // как v / texture.orig.width — на пустой текстуре это деление на ноль и
    // scale = Infinity. Само по себе оно чинится при следующем вызове (уже с
    // настоящей текстурой), но по дороге отравляет bounds спрайта, а от
    // bounds зависит, какого размера рендер-таргет выделит фильтр соседнего
    // слоя. Пока размер неизвестен — просто не трогаем scale.
    if (!currentSprite.texture || !currentSprite.texture.orig.width) return;
    const { w, h } = worldSize(ctx.scene);
    currentSprite.width = w;
    currentSprite.height = h;
  }

  // applyMapBackground — реагирует на снапшот, аналогично applyAmbient/
  // applyCue: пересоздаёт спрайт только если реально сменился URL или момент
  // старта (не на каждый чих снапшота). startedAtMs — см.
  // Room.mapStartedAtMs: тот же принцип синхронизации по времени, что и у
  // амбиента, так что все клиенты видят один кадр анимации в один момент.
  function applyMapBackground(url, startedAtMs) {
    if (url === lastMapUrl && startedAtMs === lastMapStartedAt) return;
    lastMapUrl = url;
    lastMapStartedAt = startedAtMs;

    container.removeChildren();
    currentSprite = null;
    releaseVideo();
    if (!url) return;

    if (isVideoUrl(url)) {
      const v = createVideoEl(url);
      mapVideo = v;
      ctx.mapVideoEl = v; // для __beacon.probeMap() — сам элемент в DOM не попадает
      v.muted = !ctx.audioUnlocked; // уже разблокированным клиентам звук не приглушаем при смене сцены
      ctx.seekToStart(v, startedAtMs, true);
      ctx.registerUnlockable(v);
      if (!ctx.audioUnlocked) ctx.showUnlockPrompt();

      // Спрайт заводим сразу (чтобы порядок слоёв не зависел от того, когда
      // приедет видео), но ПУСТЫМ: текстуру навешиваем только после первого
      // ПОКАЗАННОГО кадра — раньше нельзя, иначе карта навсегда останется
      // чёрной (полный разбор в ../video-texture.js). Ожидание пустой
      // текстуры выглядит как прозрачный фон, сквозь который видно сетку и
      // токены, — а не как чёрная заливка поверх всей сцены.
      currentSprite = new Sprite(Texture.EMPTY);
      container.addChild(currentSprite);

      cancelFrameWait = createVideoTexture(v, (texture) => {
        cancelFrameWait = null;
        if (frameWatchdog !== null) {
          clearInterval(frameWatchdog);
          frameWatchdog = null;
        }
        if (mapVideo !== v || !currentSprite) return; // фон успели сменить, пока ждали кадр
        currentSprite.texture = texture;
        resizeSprite();
      });

      // Диагностика: до этого видео-фон отваливался НЕМО. Браузер, который не
      // умеет кодек контейнера (сборки Chromium без проприетарных кодеков —
      // обычное дело в дистрибутивных пакетах, а H.264 в mp4 как раз такой),
      // или заблокированный автоплей дают ровно одну и ту же картинку —
      // чёрный прямоугольник вместо карты, без единой строчки в консоли.
      // Картиночная ветка ниже свои ошибки логирует, видео-ветка не логировала
      // ничего.
      v.addEventListener("error", () => {
        if (mapVideo !== v) return;
        const e = v.error;
        console.error("видео-фон карты не загрузился:", url, e && `code=${e.code} ${e.message || ""}`);
        // MediaError.MEDIA_ERR_DECODE (code 3) после того, как кадры уже
        // шли какое-то время, — известный баг Chromium: decoder pipeline
        // давно неактивного (paused) видео Chrome сам suspend'ит ради
        // памяти, а resume после этого для WebM VP8+альфа надёжно ловит
        // PIPELINE_ERROR_DECODE и остаётся "kStopped" НАВСЕГДА (см. разбор
        // и то же самолечение в layers/tokens.js: recoverTokenVideo,
        // подтверждено через chrome://media-internals). Сам элемент после
        // этого мёртв необратимо — пересоздаём с нуля, если такое уже не
        // делали для этого URL в последние несколько секунд (иначе будет
        // тугая петля при реально битом файле).
        const now = performance.now();
        if (now - lastRecoveryAt < 3000) return;
        lastRecoveryAt = now;
        lastMapUrl = null; // иначе applyMapBackground() ниже выйдет по раннему return "URL не менялся"
        applyMapBackground(url, startedAtMs);
      });
      v.addEventListener("stalled", () => {
        if (mapVideo === v) console.warn("видео-фон карты застрял на загрузке:", url);
      });
      // Кадры не поехали за 6 секунд — и это не гипотетический случай.
      // seekToStart ради синхронизации фазы петли перематывает видео в
      // ПРОИЗВОЛЬНУЮ точку (elapsed % duration). Для 4K-mp4 это выборка с
      // середины файла: браузер тянет диапазоны от ближайшего ключевого кадра,
      // и на небыстром канале первый кадр может не приехать вообще никогда
      // (проверено на стенде: перемотка на 16-ю секунду ролика — и кадров нет
      // и через минуту, при полностью исправном видео).
      //
      // Синхронная фаза петли — приятная мелочь, отсутствующая карта —
      // сломанная сцена, поэтому при заминке отказываемся от фазы в пользу
      // картинки: начало файла уже прогружено (preload="auto"), перемотка в 0
      // отдаёт кадр сразу. Условие — именно "кадра всё ещё нет"
      // (cancelFrameWait не сброшен), а не readyState: readyState тут врёт в
      // обе стороны, Chrome присылал canplay, не декодировав ни одного кадра.
      //
      // Проверяем ПОВТОРНО, а не однократно: сама перемотка на нужную фазу
      // случается только в момент loadedmetadata (см. audio.js: seekToStart),
      // а метаданные на медленном канале приезжают позже 6 секунд — разовый
      // таймер успевал отработать вхолостую ДО перемотки и больше не
      // возвращался.
      let rescueAttempts = 0;
      frameWatchdog = setInterval(() => {
        if (mapVideo !== v || !cancelFrameWait || ++rescueAttempts > 5) {
          clearInterval(frameWatchdog);
          frameWatchdog = null;
          return;
        }
        console.warn(
          "видео-фон карты не отдал кадров за 6с:", url,
          `readyState=${v.readyState} paused=${v.paused} networkState=${v.networkState} currentTime=${v.currentTime}`,
          "— откатываюсь на начало ролика (синхронность фазы петли теряется)."
        );
        try {
          if (v.currentTime !== 0) v.currentTime = 0;
        } catch (e) {
          console.error("не удалось перемотать видео-фон в начало:", e);
        }
        ctx.tryPlay(v);
      }, 6000);
    } else {
      // Texture.from(строка) — это ТОЛЬКО синхронный поиск в Assets.Cache
      // (см. pixi.js rendering/.../utils/textureFrom.js: Texture.from вызывает
      // Cache.get, ничего не грузит сам). Для карты, которую Pixi ещё ни разу
      // не грузил через Assets, Cache.get промахивается, молча (с варнингом в
      // консоль) возвращает undefined — и Sprite.from(url) навсегда остаётся
      // с Texture.EMPTY: картинка физически никогда не запрашивается у
      // сервера. Раньше (Canvas2D) фон грузился через голый new Image(), у
      // которого такой ловушки нет — при переезде на Pixi это потерялось.
      // Настоящая загрузка — через Assets.load(url), он и кеширует, и
      // реально идёт в сеть.
      currentSprite = new Sprite(Texture.EMPTY);
      container.addChild(currentSprite);
      const requestedUrl = url;
      Assets.load(url)
        .then((texture) => {
          // Пока грузилось, сцена/фон могли уже смениться — не подставляем
          // устаревшую текстуру в чужой (или уже уничтоженный) спрайт.
          if (requestedUrl !== lastMapUrl || !currentSprite) return;
          currentSprite.texture = texture;
          resizeSprite();
        })
        .catch((err) => console.error("не удалось загрузить фон карты:", url, err));
    }
    resizeSprite();
  }

  function update() {
    applyMapBackground(ctx.scene.mapUrl || "", ctx.mapStartedAt);
    resizeSprite();
  }

  return { container, update };
}
