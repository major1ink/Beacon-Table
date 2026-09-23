import { ExtensionType, extensions } from "pixi.js";

// Замена штатного WebGL-загрузчика видео-текстур Pixi. Чинит корень той самой
// поломки, вокруг которой построен ../video-texture.js: чёрная карта у игрока
// и поток "GL_INVALID_OPERATION: glTexSubImage2DRobustANGLE: Level of detail
// outside of range" по строке на кадр.
//
// Механика штатного пути (rendering/renderers/gl/texture/uploaders/
// glUploadImageResource.mjs, uploadImageWebGL2): ПЕРВАЯ заливка идёт
// девятиаргументным texImage2D, где источник — сам элемент <video>, то есть
// выделение уровня 0 и запись пикселей одной командой. Chromium в этот момент
// просит у медиаплеера текущий кадр и, если кадра ещё нет, МОЛЧА выходит: ни
// одной GL-команды, ни ошибки, ни исключения. Уровень 0 остаётся
// невыделенным — но Pixi об этом не знает и в конце upload() записывает
// glTexture.width/height так, будто аллокация прошла. Дальше needsAllocation
// уже никогда не станет true, и каждый следующий кадр льётся через
// texSubImage2D в несуществующий уровень — отсюда и поток ошибок, и
// непрозрачный чёрный (0,0,0,1) при сэмплировании неполной текстуры. Состояние
// невосстановимое: до конца сессии текстура останется чёрной, хотя видео
// играет, texture.valid === true и диагностика чистая.
//
// Здесь те же два действия разнесены на две команды: сначала texImage2D с
// null — чистое выделение памяти под уровень 0, оно не зависит от медиаплеера
// и не может тихо не случиться, — и только потом texSubImage2D с кадром.
// Пропущенный кадр теперь стоит ровно один пустой кадр вместо навсегда битой
// текстуры: уровень выделен, следующий texSubImage2D ляжет в него штатно.
// Оверхед нулевой — texImage2D(null) делается только на смену размера, дальше
// работает тот же дешёвый texSubImage2D, что и раньше.
//
// Ровно этот же приём Pixi уже применяет к невыделенным текстурам в ветке
// !resourceFitsTexture, и он же по сути стоит за forceAllocation=isSafari() в
// glUploadVideoResource — только Safari там лечат полной переаллокацией на
// КАЖДЫЙ кадр, что для 4K-карты недёшево.
//
// Регистрируется как расширение ExtensionType.TextureUploaderWebGL с именем
// "video": GlTextureSystem собирает таблицу загрузчиков в конструкторе и
// подмешивает расширения ПОСЛЕ встроенных (см. GlTextureSystem.mjs,
// baseUploaders), так что одноимённое расширение перекрывает штатное. Отсюда
// важное следствие: installVideoUploaderFix() обязана отработать ДО создания
// рендерера (app.init) — позже таблица уже собрана.
const glUploadVideoResourceSafe = {
  extension: { type: ExtensionType.TextureUploaderWebGL, name: "video" },
  id: "video",
  upload(source, glTexture, gl, _webGLVersion, targetOverride) {
    const target = targetOverride ?? glTexture.target;

    // Размеры кадра ещё не известны (нет метаданных) — держим уровень 0
    // выделенным заглушкой 1×1, как это делает штатный загрузчик. Размеры
    // пишем честно: иначе после смены src на видео другого разрешения
    // needsAllocation ниже мог бы посчитать, что переаллокация не нужна.
    if (!source.isValid) {
      gl.texImage2D(target, 0, glTexture.internalFormat, 1, 1, 0, glTexture.format, glTexture.type, null);
      glTexture.width = 1;
      glTexture.height = 1;
      return;
    }

    // Текстура может быть меньше кадра: UV у Pixi в долях, спрайт этого не
    // заметит (см. stageStep).
    const step = stageStep(source);
    const width = Math.max(1, Math.round(source.pixelWidth * step));
    const height = Math.max(1, Math.round(source.pixelHeight * step));

    if (glTexture.width !== width || glTexture.height !== height) {
      gl.texImage2D(target, 0, glTexture.internalFormat, width, height, 0, glTexture.format, glTexture.type, null);
      glTexture.width = width;
      glTexture.height = height;
    }

    // Семиаргументная форма — та же, что Pixi использует для всех последующих
    // кадров, и она одинаково валидна в WebGL1 и WebGL2. Если кадра сейчас нет,
    // Chromium снова молча ничего не сделает — но теперь это просто пустой
    // кадр, а не приговор текстуре.
    gl.texSubImage2D(target, 0, 0, 0, glTexture.format, glTexture.type, stagedFrame(source.resource, width, height));
  },
};

// stageStep — во сколько раз ужать кадр перед заливкой. 4K-карта целиком на
// экране 1440 px использует треть разрешения, а заливалась полностью:
// ~100 МБ видеопамяти на кадр, и два окна (ДМ и трансляция на одной
// машине) упирали GT 1030 в 15 FPS. stageScale — сколько экранных пикселей
// приходится на пиксель кадра, его вешает слой, который знает камеру.
// Уменьшаем с запасом, чтобы не прыгать туда-обратно на границе шага.
const STEPS = [1, 0.5, 0.25];

function stageStep(source) {
  const need = typeof source.stageScale === "function" ? source.stageScale() : 1;
  let step = source.stagedStep || 1;
  if (need > step) step = STEPS.slice().reverse().find((s) => s >= need) || 1;
  else {
    const smaller = STEPS.find((s) => s < step && need <= s * 0.9);
    if (smaller) step = smaller;
  }
  source.stagedStep = step;
  return step;
}

// Заливка прямо из <video> в Chromium на Linux без аппаратного декодера идёт
// через CPU: 4K-кадр — 90 мс на GT 1030, видео-карта роняла стол до 24 FPS.
// Через ускоренный 2D-canvas тот же кадр — 1,4 мс, пиксели те же.
const stages = new WeakMap();

function stagedFrame(video, width, height) {
  if (!(video instanceof HTMLVideoElement)) return video;
  let canvas = stages.get(video);
  if (!canvas) {
    canvas = document.createElement("canvas");
    stages.set(video, canvas);
  }
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const c2d = canvas.getContext("2d");
  c2d.clearRect(0, 0, width, height); // у webm-токенов с альфой кадры иначе накладываются
  c2d.drawImage(video, 0, 0, width, height);
  return canvas;
}

// releaseVideoStage — отпустить промежуточный canvas выброшенного видео
// сразу: он держит видеопамять размером с кадр, а WeakMap отдаст его только
// со сборкой мусора.
export function releaseVideoStage(video) {
  const canvas = stages.get(video);
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
  stages.delete(video);
}

export function installVideoUploaderFix() {
  extensions.add(glUploadVideoResourceSafe);
}
