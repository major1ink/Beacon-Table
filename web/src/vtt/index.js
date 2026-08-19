import { Application, Container } from "pixi.js";
import { createDirtyFlags } from "./dirty.js";
import { createCamera, applyCameraTransform, resetCamera, worldSize, canvasPos, screenToWorld } from "./camera.js";
import { createAudio } from "./audio.js";
import { createSideMenu } from "./side-menu.js";
import { createCombatBar } from "./combat-bar.js";
import { createNet } from "./net.js";
import { createInteraction } from "./interaction.js";
import { createBackgroundLayer } from "./layers/background.js";
import { createGridLayer } from "./layers/grid.js";
import { createTokensLayer } from "./layers/tokens.js";
import { createNoteMarkersLayer } from "./layers/note-markers.js";
import { createWallsLayer } from "./layers/walls.js";
import { createDoorsLayer } from "./layers/doors.js";
import { createVisionFogLayer } from "./layers/vision-fog.js";
import { createBuildingsLayer } from "./layers/buildings.js";
import { createManualFogLayer } from "./layers/manual-fog.js";
import { createFxLayer } from "./layers/fx.js";
import { installVideoUploaderFix } from "./gl-video-uploader.js";

// initVTT — единая точка входа движка для DM/TV/Player страниц. Публичный
// контракт (аргументы, {send, getScene, cueAudio}) не поменялся со старой
// Canvas2D-версии — изменилась только внутренняя механика рендера (см. план:
// /home/major/.claude/plans/imperative-baking-thunder.md). Единственное
// вынужденное отличие: initVTT теперь ASYNC (PIXI.Application.init() в v8 —
// промис) — обе вызывающих страницы (dm.html/player.html) уже вызывали её
// внутри async boot(), так что там достаточно добавить await; broadcast.html
// оборачивается в свой маленький async IIFE (см. pages/broadcast.js).
//
// role: "dm" — полный контроль. role: "tv" — чистый зритель без авторизации.
// role: "player" — авторизован сессией аккаунта, может тащить СВОИ токены
// (Token.ownerId === playerId) и бросать кубы.
export async function initVTT({ canvasId, role, playerId }) {
  const isDM = role === "dm";
  const isPlayer = role === "player";
  const canvas = document.getElementById(canvasId);

  // Строго до app.init(): таблицу WebGL-загрузчиков текстур GlTextureSystem
  // собирает один раз в конструкторе, зарегистрированное позже расширение в
  // неё уже не попадёт (подробности — в gl-video-uploader.js).
  installVideoUploaderFix();

  const app = new Application();
  await app.init({
    canvas,
    resizeTo: canvas.parentElement || canvas,
    backgroundAlpha: 0, // CSS canvas{background:#222} просвечивает в letterbox-полях, как и раньше
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });

  // Pixi умеет молча откатиться на CanvasRenderer, если WebGL-контекст не
  // завёлся (нет GPU, драйвер в чёрном списке, у вкладки кончились контексты).
  // Это не ошибка, а тихая деградация, и снаружи она неотличима от "у одного
  // клиента всё выглядит не так": фильтры (мягкий туман — BlurFilter) в
  // Canvas2D просто пропускаются, видео идёт через CPU. Пусть будет видно в
  // консоли сразу, а не после часа отладки.
  if (app.renderer.name !== "webgl") {
    console.warn(`beacon: рендер идёт не через WebGL, а через "${app.renderer.name}" — часть эффектов будет пропущена или посчитана на CPU.`);
  }

  const world = new Container();
  app.stage.addChild(world);

  // ctx — общий контекст, который держат все подмодули вместо замыкания
  // одного гигантского initVTT (как было в static/js/app.js). Поля
  // добавляются по мере инициализации нужных подсистем ниже.
  const ctx = {
    role,
    isDM,
    isPlayer,
    playerId,
    canvas,
    app,
    world,
    camera: createCamera(),
    dirty: createDirtyFlags(),
    mapStartedAt: 0,
  };

  ctx.applyCameraTransform = () => applyCameraTransform(world, app.screen.width, app.screen.height, ctx.scene, ctx.camera);

  // sideMenu — общая колонка иконок-кнопок у правого края канваса (см.
  // side-menu.js): 🔊 громкость заводит здесь же audio.js, 🎲 кубы —
  // pages/dm.js, отдельной соседней иконкой (не внутри панели громкости).
  const sideMenu = createSideMenu(ctx);
  const audio = createAudio(ctx, sideMenu);
  // combatBar — верхний оверлей "чей сейчас ход" (см. combat-bar.js),
  // общий для всех трёх ролей; сам решает, показываться ли (только когда
  // трекер инициативы реально в бою).
  createCombatBar(ctx);

  // ---- слои, в порядке отрисовки (снизу вверх) — тот же Z-order, что был
  // в старом draw(): фон → сетка → токены/hidden-метки → стены (ДМ) →
  // LOS-туман войны (игрок) → ручной туман (оверрайд ДМ поверх LOS) → fx.
  //
  // Туман войны (layers/vision-fog.js) снова в строю: вместо блендa 'erase'
  // (см. историю в самом файле слоя) дырки в заливке тьмы теперь вырезаются
  // геометрией через GraphicsContext.cut() — одинаково работает и в WebGL,
  // и в Canvas2D-фолбэке, без промежуточного рендер-таргета.
  const background = createBackgroundLayer(ctx);
  const grid = createGridLayer(ctx);
  const tokens = createTokensLayer(ctx);
  const noteMarkers = createNoteMarkersLayer(ctx);
  const walls = createWallsLayer(ctx);
  // doors — значки дверей (см. layers/doors.js), ПЕРЕД vision-fog: в отличие
  // от walls (линии — только ДМ), значки видны и игроку, и должны лежать в
  // мировых координатах ПОД тьмой — тогда тьма перекрывает их в
  // неисследованных местах бесплатно, той же причиной, что и tokens выше.
  const doors = createDoorsLayer(ctx);
  const visionFog = createVisionFogLayer(ctx);
  // buildings — ПОСЛЕ vision-fog (см. layers/buildings.js): здание не
  // участвует в raycasting'е, поэтому его непрозрачная "крыша" должна
  // перекрыть уже посчитанные дыры обычного тумана заново, а не смешиваться
  // с ними геометрией; manual-fog (ручной оверрайд ДМ) — по-прежнему самый
  // верхний слой тьмы, имеет последнее слово.
  const buildings = createBuildingsLayer(ctx);
  const manualFog = createManualFogLayer(ctx);
  const fx = createFxLayer(ctx);
  world.addChild(
    background.container,
    grid.container,
    tokens.container,
    noteMarkers.container,
    walls.container,
    doors.container,
    visionFog.container,
    buildings.container,
    manualFog.container,
    fx.container
  );
  ctx.spawnFx = fx.spawnFx;

  const layers = [background, grid, tokens, noteMarkers, walls, doors, visionFog, buildings, manualFog, fx];

  // render — вызывается на каждый WS-снапшот и на каждое локальное
  // взаимодействие (драг токена/камера/инструменты ДМ), НЕ на каждый кадр
  // видео (это и есть корневой фикс — см. dirty.js). Каждый слой сам решает
  // по своим dirty-битам, нужно ли реально что-то пересчитывать.
  ctx.render = () => {
    // Камера — ПЕРЕД слоями: grid/vision считают толщину линий и геометрию от
    // текущего world.scale, и с устаревшим масштабом они построят кадр под
    // чужой мир (см. dirty.js о worldSize).
    if (ctx.dirty.resetCamera) resetCamera(ctx.camera, ctx.scene);
    if (ctx.dirty.worldSize || ctx.dirty.resetCamera) ctx.applyCameraTransform();
    ctx.dirty.worldSize = false;
    ctx.dirty.resetCamera = false;

    for (const layer of layers) layer.update();
    ctx.dirty.tokens = false;
    ctx.dirty.vision = false;
    ctx.dirty.walls = false;
    ctx.dirty.buildings = false;
    ctx.dirty.manualFog = false;
    ctx.dirty.grid = false;
    ctx.dirty.background = false;
  };

  const net = createNet(ctx, audio);

  // Канвас резиновый: реальный размер подгоняется под то, сколько места ему
  // выделяет CSS-раскладка контейнера (см. web/*.html: #canvasWrap { flex: 1
  // 1 auto }), а не зашит атрибутами width/height. app уже настроен на
  // resizeTo canvas.parentElement (см. init выше) — он сам подгонит
  // renderer/canvas.width-height и физический backing store под
  // devicePixelRatio; здесь только пересчитываем и переприменяем НАШУ
  // камеру (Pixi ничего не знает про мировое пространство сцены) на каждое
  // фактическое изменение размера.
  function onResize() {
    ctx.applyCameraTransform();
    ctx.dirty.grid = true;
    ctx.dirty.walls = true;
    ctx.dirty.buildings = true;
    ctx.dirty.tokens = true;
    ctx.dirty.manualFog = true;
    ctx.dirty.vision = true;
    ctx.render();
  }
  new ResizeObserver(onResize).observe(canvas.parentElement || canvas);
  window.addEventListener("resize", onResize);
  ctx.applyCameraTransform();

  createInteraction(ctx);

  // ?debug=1 — отладочная ручка. Рендер живёт на GPU, поэтому «карты нет» со
  // стороны выглядит одинаково для десятка разных причин (кодек, автоплей,
  // тип рендерера, размер текстуры, камера). Один вызов __beacon.diag() в
  // консоли проблемной машины отвечает сразу на все.
  if (new URLSearchParams(location.search).has("debug")) {
    window.__beacon = {
      app,
      ctx,
      diag() {
        const bg = background.container.children[0];
        const tex = bg && bg.texture;
        const src = tex && tex.source;
        const gl = app.renderer.gl;
        const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
        const report = {
          renderer: app.renderer.name, // 'webgl' | 'webgpu' | 'canvas'
          webglVersion: app.renderer.context && app.renderer.context.webGLVersion,
          gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "n/a",
          maxTextureSize: gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : "n/a",
          resolution: app.renderer.resolution,
          screen: [app.screen.width, app.screen.height],
          role,
          mapUrl: ctx.scene.mapUrl,
          mapStartedAt: ctx.mapStartedAt,
          mapTexture: tex ? { w: tex.orig.width, h: tex.orig.height, valid: tex.source !== null } : "спрайта нет",
          mapSource: src
            ? {
                uploadMethodId: src.uploadMethodId,
                pixel: [src.pixelWidth, src.pixelHeight],
                resource: [src.resourceWidth, src.resourceHeight],
                mipLevelCount: src.mipLevelCount,
                autoGenerateMipmaps: src.autoGenerateMipmaps,
                isValid: src.isValid,
                resolution: src.resolution,
              }
            : "нет источника",
          mapSpriteScale: bg ? [bg.scale.x, bg.scale.y] : null,
          worldScale: world.scale.x,
          fogOfWar: ctx.scene.fogOfWar,
          grid: ctx.scene.grid,
          tokens: Object.keys(ctx.scene.tokens || {}).length,
        };
        console.log(JSON.stringify(report, null, 2));
        return report;
      },

      // probeMap — прямая проба GPU в обход Pixi: заливаем текущий кадр карты
      // в свежую текстуру и спрашиваем gl.getError(). Ошибки WebGL асинхронны
      // и в консоли приходят без стека и без указания, КАКАЯ текстура их
      // вызвала, — по логу невозможно отличить "видеокарта не берёт кадр 4K"
      // от "Pixi неправильно посчитал размер". Здесь оба варианта разделяются:
      // сначала пробуем кадр как есть, потом его же, ужатый до 1024 через
      // canvas. Если полный размер даёт ошибку, а ужатый нет — упирается в
      // видеокарту, и карту надо пережать.
      //
      // Проба идёт в СВОЁМ контексте WebGL, а не в контексте Pixi. Первая
      // версия работала прямо в боевом: биндила текстуры и дёргала pixelStorei
      // — а Pixi кеширует это состояние у себя (GlTextureSystem._boundTextures,
      // _premultiplyAlpha) и после чужого вмешательства начинает рисовать
      // мусором. Диагностика, которая ломает то, что диагностирует, дороже, чем
      // отсутствие диагностики: следующий же замер после неё показал стёртый
      // токен и пропавшую тьму, хотя со сценой всё было в порядке. Для вопроса
      // "берёт ли драйвер такую заливку" отдельный контекст на той же
      // видеокарте отвечает ровно так же.
      probeMap() {
        const video = ctx.mapVideoEl;
        if (!video) return "видео-фона нет (карта — картинка либо не задана)";
        const probeCanvas = document.createElement("canvas");
        const gl = probeCanvas.getContext("webgl2") || probeCanvas.getContext("webgl");
        if (!gl) return "не удалось создать контекст WebGL для пробы";

        const upload = (source, label) => {
          const tex = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, tex);
          while (gl.getError() !== gl.NO_ERROR) {
            /* чистим накопленные ошибки, чтобы поймать именно свою */
          }
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
          const err = gl.getError();
          gl.deleteTexture(tex);
          const names = { 1280: "INVALID_ENUM", 1281: "INVALID_VALUE", 1282: "INVALID_OPERATION", 1285: "OUT_OF_MEMORY" };
          return { [label]: err === 0 ? "ok" : names[err] || err };
        };

        const small = document.createElement("canvas");
        small.width = 1024;
        small.height = Math.max(1, Math.round((1024 * video.videoHeight) / (video.videoWidth || 1)));
        small.getContext("2d").drawImage(video, 0, 0, small.width, small.height);

        // Точное воспроизведение той последовательности, которой заливает Pixi
        // (glUploadImageResource.uploadImageWebGL2): аллокация девятиаргументной
        // формой texImage2D с DOM-элементом в качестве источника, затем
        // семиаргументный texSubImage2D на каждый следующий кадр. Первая проба
        // выше делает НЕ ЭТО — она берёт простую шестиаргументную форму с
        // несайзовым RGBA, и именно поэтому проходит. Здесь становится видно,
        // какой конкретно вызов отбивает драйвер.
        const bgSprite = background.container.children[0];
        const pixiSource = bgSprite && bgSprite.texture && bgSprite.texture.source;
        let pixiGl = null;
        try {
          // Только через систему текстур: source._gpuData в 8.19 пуст, ключ там
          // не совпадает с renderer.uid.
          pixiGl = pixiSource && app.renderer.texture.getGlSource(pixiSource);
        } catch {
          pixiGl = null;
        }
        const errName = (e) =>
          ({ 0: "ok", 1280: "INVALID_ENUM", 1281: "INVALID_VALUE", 1282: "INVALID_OPERATION", 1285: "OUT_OF_MEMORY" }[e] || e);

        const replay = () => {
          if (!pixiGl) return "нет GL-текстуры Pixi";
          const tex = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
          while (gl.getError() !== gl.NO_ERROR) {
            /* сбрасываем чужие ошибки */
          }
          const w = pixiSource.pixelWidth;
          const h = pixiSource.pixelHeight;
          gl.texImage2D(gl.TEXTURE_2D, 0, pixiGl.internalFormat, w, h, 0, pixiGl.format, pixiGl.type, video);
          const allocErr = gl.getError();
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, pixiGl.format, pixiGl.type, video);
          const subErr = gl.getError();
          gl.deleteTexture(tex);
          return { allocate9arg: errName(allocErr), thenTexSubImage2D: errName(subErr) };
        };

        const report = {
          video: {
            size: [video.videoWidth, video.videoHeight],
            readyState: video.readyState,
            paused: video.paused,
            currentTime: video.currentTime,
            decodedFrames: video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality().totalVideoFrames : "n/a",
          },
          webglVersion: app.renderer.context.webGLVersion,
          maxTextureSize: app.renderer.gl ? app.renderer.gl.getParameter(app.renderer.gl.MAX_TEXTURE_SIZE) : "n/a",
          ...upload(video, "uploadFullSize"),
          ...upload(small, "upload1024"),
          // Состояние текстуры, которую ведёт сам Pixi: если width/height уже
          // проставлены, а нулевой уровень на деле не выделен — это и есть
          // защёлкнувшийся отказ, каждый следующий кадр будет ошибкой.
          pixiGlTexture: pixiGl
            ? { width: pixiGl.width, height: pixiGl.height, internalFormat: pixiGl.internalFormat, format: pixiGl.format, type: pixiGl.type }
            : "нет",
          pixiSourcePixel: pixiSource ? [pixiSource.pixelWidth, pixiSource.pixelHeight] : "нет",
          replayPixiSequence: replay(),
        };
        console.log(JSON.stringify(report, null, 2));
        return report;
      },
    };
    console.log("beacon: отладка включена, вызови __beacon.diag()");
  }

  // cueAudio — отдаём наружу для dm.html: там вешают "ended" на него, чтобы
  // самим продвигать плейлист на следующий трек (сервер не декодирует аудио
  // и не знает длительность — см. internal/service/room.go). sideMenu — та
  // же боковая колонка иконок, куда добавлена 🔊 громкость: dm.js вешает
  // туда свою отдельную иконку 🎲 с кубами, см. pages/dm.js.
  //
  // pointToWorld — та же математика курсора, что использует interaction.js
  // изнутри (canvasPos + screenToWorld), но наружу — нужна dm.js, чтобы
  // превратить координаты drop-события (перетаскивание персонажа из панели
  // "Персонажи" на канвас) в мировые X/Y нового токена.
  return {
    send: net.send,
    getScene: () => ctx.scene,
    cueAudio: audio.cueAudio,
    sideMenu,
    pointToWorld: (e) => {
      const { sx, sy } = canvasPos(e, canvas);
      return screenToWorld(sx, sy, app.screen.width, app.screen.height, ctx.scene, ctx.camera);
    },
  };
}

// worldSize — реэкспорт для страниц, которым нужен текущий мировой размер
// сцены напрямую (сейчас не используется извне, оставлено для паритета с
// прежним публичным API модуля app.js на случай будущих нужд).
export { worldSize };
