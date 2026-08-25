import { Container, Graphics } from "pixi.js";
import { cutMulti, fillMulti } from "../light-geometry.js";
import { computeVisionPlanWithFallback } from "../vision-plan.js";

// ---- освещение (см. README, раздел про свет) ----
//
// ВСЯ математика освещения живёт в ../vision-plan.js (чистый расчёт без
// Pixi, покрыт тестами — web/test/vision-fog-geometry.test.js). Здесь
// остаётся только Pixi-часть: когда пересчитывать и как нарисовать готовый
// план.
//
// Яркий свет (Token.Light.Bright) открывает область полностью, тусклый
// (Token.Light.Dim) — тоже открывает, но с затемняющей поволокой (см.
// DIM_ALPHA), силуэты видны, детали приглушены — как тусклый свет в Foundry.
//
// Между этими двумя границами поволока не обрывается ступенькой, а плавно
// сходит на нет: план приносит готовые непересекающиеся кольца с полем level
// (0 — край тусклого света, 1 — ярко освещённое ядро), см. LIGHT_STEPS и
// ringMultis в vision-plan.js. Здесь остаётся только перевод level в альфу —
// alphaForLevel ниже.
const DARK_ALPHA = 0.96; // совсем не освещено
const DIM_ALPHA = 0.55; // самый край тусклого света — не тьма, но и не "видно как есть"
const DARK_COLOR = 0x06060a;

// alphaForLevel — линейный спад от DIM_ALPHA на внешнем краю тусклого света
// до нуля в ярком. Линейный, а не квадратичный (как затухание настоящего
// источника): поволока тут не имитация физики, а читаемость карты — на
// квадратичном спаде почти вся ширина кольца выглядит одинаково тёмной, и
// смысл ступеней теряется.
function alphaForLevel(level) {
  return DIM_ALPHA * (1 - level);
}

// Line-of-sight/туман войны — САМОЕ ГЛАВНОЕ место переезда (см. план,
// раздел "Корневой фикс"). В старом Canvas2D-движке computeVisibilityPolygon
// (raycasting по всем стенам для каждого токена) пересчитывался ВНУТРИ
// draw(), которую гонял rAF-цикл видео-фона на каждый кадр — 60 раз в
// секунду, даже если ни один токен/стена не двигались. Здесь update()
// вызывается ТОЛЬКО когда dirty.vision выставлен (позиции токенов, стены
// или источники света реально изменились в снапшоте — см. dirty.js), не на
// кадр видео.
//
// Дырки в заливке тьмы вырезаются ГЕОМЕТРИЕЙ, а не блендом/маской — та же
// причина, что и раньше (см. git-историю этого файла): 'erase'-блендмод и
// stencil-маски на некоторых GPU/фолбэках портят соседние слои или дают
// чёрный экран без единой ошибки в консоли. paintMulti (light-geometry.js)
// работает через GraphicsContext.cut()/fill() — чистая триангуляция,
// одинаково ведёт себя везде.
//
// Тяжёлая часть (пересечение обзора и света через polygon-clipping, см.
// light-geometry.js) НЕ гоняется синхронно на каждый mousemove во время
// драга токена (а драг шлёт move_token десятками раз в секунду — см.
// interaction.js/README) — scheduleRebuild схлопывает все запросы в рамках
// одного анимационного кадра в один rebuild(), который на момент срабатывания
// читает АКТУАЛЬНОЕ состояние сцены. Первый рендер — исключение: он должен
// быть синхронным, иначе один кадр между первым snapshot и первым rAF показал
// бы карту вообще без тумана (пустой Graphics).
export function createVisionFogLayer(ctx) {
  const container = new Container();
  const darkness = new Graphics(); // тьма + вырезанные "видно хотя бы тускло" дыры
  const dimTint = new Graphics(); // полупрозрачная дымка поверх тускло освещённого (не яркого)
  container.addChild(darkness, dimTint);

  function clearAll() {
    darkness.clear();
    dimTint.clear();
  }

  // memo — то, что расчёту незачем делать заново на каждый кадр: сработавший
  // в прошлый раз квант, посчитанный слой света, обзор каждого наблюдателя и
  // подпись всего входа целиком (см. computeVisionPlanWithFallback). Живёт
  // ровно столько же, сколько сам слой, и на результат не влияет — только на
  // цену кадра.
  const memo = {};

  // rebuild — намеренно в два прохода: СНАЧАЛА вся геометрия (raycasting +
  // polygon-clipping — единственное, что вообще может кинуть исключение,
  // см. computeVisionPlanWithFallback), и ТОЛЬКО ПОТОМ, если всё
  // посчиталось без ошибок, трогаем сам Graphics (clear+перерисовка).
  // Раньше было наоборот (сначала clear() и заливка сплошной тьмой, потом
  // расчёт) — если polygon-clipping падал НА КАКОЙ-ТО КОНКРЕТНОЙ геометрии
  // (а во время драга токена по карте она меняется на каждый кадр —
  // зацепить вырожденный случай, например, когда точки обзора и света почти
  // совпадают у угла стены, вполне реально), экран на этот кадр оставался
  // залит сплошной тьмой (уже вырезанный до исключения не успевал) —
  // заметно мигало чёрным при перетаскивании источника света рядом со
  // стеной. Теперь при сбое расчёта Graphics вообще не трогается — на
  // экране просто остаётся ПРЕДЫДУЩИЙ (корректный) кадр, без единого мига,
  // пока следующий пересчёт (следующий кадр драга) не спасёт положение сам.
  function rebuild() {
    const { plan, error, unchanged } = computeVisionPlanWithFallback(ctx.scene, ctx.isDM, memo);
    // unchanged — вход расчёта бит в бит тот же, что в прошлый раз (см.
    // planInputKey): на экране уже нарисовано ровно это, перерисовывать
    // Graphics незачем.
    if (unchanged) return;
    if (!plan) {
      console.error("beacon: сбой пересчёта освещения (vision-fog computePlan) — оставляю прошлый кадр как есть:", error, {
        tokens: ctx.scene.tokens,
        walls: ctx.scene.walls,
        globalLight: ctx.scene.globalLight,
      });
      return;
    }
    paintPlan(plan);
  }

  // paintPlan — только рисование, готовым результатом computeVisionPlan. Не
  // может кинуть исключение на геометрии (она уже посчитана и
  // провалидирована) — сюда долетает только safe-часть (Pixi Graphics-вызовы).
  function paintPlan(plan) {
    clearAll();
    if (plan.skip) return; // DM/выключенный туман войны — совсем без тьмы

    const { w, h, dimIslands, rings } = plan;
    darkness.rect(0, 0, w, h).fill({ color: DARK_COLOR, alpha: DARK_ALPHA });
    if (!dimIslands.length) return; // света нет — сплошная тьма как уже залито

    // revealDim (все острова разом) — то, что видно хотя бы тускло.
    // Вырезаем целиком из ОДНОЙ базовой заливки тьмы (rect() чуть выше);
    // дыры островов возвращаются заплатками тьмы (refillStyle). Порядок
    // инструкций внутри — забота cutMulti: Pixi'шный cut() сам выбирает,
    // какую заливку дырявить, и на этом легко получить чужую (см. "ПРАВИЛО
    // РАБОТЫ С Pixi cut()" в light-geometry.js). Дальше dimTint решает,
    // насколько ярко.
    cutMulti(darkness, dimIslands.map((d) => d.poly), w, h, { color: DARK_COLOR, alpha: DARK_ALPHA });

    // dimTint — поволока над тускло освещённым, кольцами от тёмного края к
    // прозрачному ядру. Кольца НЕ ПЕРЕСЕКАЮТСЯ (см. ringMultis в
    // vision-plan.js), поэтому каждое рисуется независимо и ничего ни у кого
    // не вырезает: extraCuts тут не нужны совсем, а с ними ушёл и весь риск
    // из "ПРАВИЛА РАБОТЫ С Pixi cut()" — у каждой заливки остаются ровно её
    // собственные дыры и ровно один cut() на них.
    //
    // Порядок колец не важен по той же причине (не перекрываются), но идут
    // они как посчитаны — от края к центру.
    for (const { level, multi } of rings) {
      fillMulti(dimTint, multi, w, h, { color: DARK_COLOR, alpha: alphaForLevel(level) });
    }
  }

  let rafHandle = null;
  let builtOnce = false;
  function scheduleRebuild() {
    if (rafHandle != null) return;
    rafHandle = requestAnimationFrame(() => {
      rafHandle = null;
      rebuild();
    });
  }

  function update() {
    if (!ctx.dirty.vision) return;
    if (!builtOnce) {
      // первый рендер — синхронно, чтобы не мигнуть кадром без тумана
      // (см. комментарий выше про rAF-throttle).
      builtOnce = true;
      rebuild();
      return;
    }
    scheduleRebuild();
  }

  return { container, update };
}
