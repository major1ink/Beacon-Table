import { Container, Graphics } from "pixi.js";
import { computeVisibilityPolygon, weldWalls, pointInPolygon } from "../../geometry.js";
import { worldSize } from "../camera.js";
import { unionAll, intersectMulti, differenceMulti, unionMulti, worldRect, paintMulti, gridUnitsToWorld } from "../light-geometry.js";

// ---- освещение (см. README, раздел про свет) ----
//
// Что видит игрок = (объединение обзора всех нескрытых токенов) ∩
// (объединение всех источников света + опциональный глобальный свет на всю
// карту). Оба множителя по отдельности — то же самое, чем раньше был весь
// этот файл (raycasting от точки, ограниченный стенами и радиусом,
// computeVisibilityPolygon), просто теперь их два разных смысла (обзор и
// свет), а не один. Нет ни одного источника света — пересечение пустое —
// игрок не видит НИЧЕГО, даже там, куда дотягивается обзор токена (нечего
// освещать — нечего видеть).
//
// "Обзор" у токена больше не ограничен константным радиусом — единственная
// граница обзора теперь стены (см. SIGHT_MARGIN ниже: радиус берётся с
// запасом больше диагонали карты, то есть фактически "докуда видно
// по прямой"). Это осознанно ближе к дефолтному поведению Foundry VTT (без
// дарквижна и настройки "Sight Range" на токене видно ровно то, что
// освещено и не закрыто стеной — отдельного "радиуса зрения" сверху нет).
//
// Яркий свет (Token.Light.Bright) открывает область полностью, тусклый
// (Token.Light.Dim) — тоже открывает, но с затемняющей поволокой (см.
// DIM_ALPHA), силуэты видны, детали приглушены — как тусклый свет в Foundry.
const SIGHT_MARGIN = 50; // запас поверх диагонали карты — чисто чтобы raycasting не срезал луч точно на границе
const DARK_ALPHA = 0.96; // совсем не освещено
const DIM_ALPHA = 0.55; // освещено тускло — не тьма, но и не "видно как есть"
const DARK_COLOR = 0x06060a;

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

  // rebuild — намеренно в два прохода: СНАЧАЛА вся геометрия (raycasting +
  // polygon-clipping — единственное, что вообще может кинуть исключение,
  // см. try/catch ниже), и ТОЛЬКО ПОТОМ, если всё посчиталось без ошибок,
  // трогаем сам Graphics (clear+перерисовка). Раньше было наоборот (сначала
  // clear() и заливка сплошной тьмой, потом расчёт) — если polygon-clipping
  // падал НА КАКОЙ-ТО КОНКРЕТНОЙ геометрии (а во время драга токена по карте
  // она меняется на каждый кадр — зацепить вырожденный случай, например,
  // когда точки обзора и света почти совпадают у угла стены, вполне реально),
  // экран на этот кадр оставался залит сплошной тьмой (уже вырезанный до
  // исключения не успевал) — заметно мигало чёрным при перетаскивании
  // источника света рядом со стеной. Теперь при сбое расчёта Graphics вообще
  // не трогается — на экране просто остаётся ПРЕДЫДУЩИЙ (корректный) кадр,
  // без единого мига, пока следующий пересчёт (следующий кадр драга) не
  // спасёт положение сам.
  function rebuild() {
    let plan;
    try {
      plan = computePlan();
    } catch (err) {
      console.error("beacon: сбой пересчёта освещения (vision-fog computePlan) — оставляю прошлый кадр как есть:", err, {
        tokens: ctx.scene.tokens,
        walls: ctx.scene.walls,
        globalLight: ctx.scene.globalLight,
      });
      return;
    }
    paintPlan(plan);
  }

  // computePlan — чистый расчёт, НИКАКИХ обращений к darkness/dimTint. Может
  // кинуть исключение (polygon-clipping на вырожденной геометрии) — это
  // нормально, ловится в rebuild().
  function computePlan() {
    // Только не-DM экран — DM должен видеть весь стол целиком, всегда, вне
    // зависимости от света (ориентир для редактирования, как и со стенами/
    // hidden-токенами). Ручные fogAreas (layers/manual-fog.js) рисуются
    // независимо от этого тумблера, отдельным слоем поверх этого.
    if (ctx.isDM) return { skip: true };
    if (ctx.scene.fogOfWar === false) return { skip: true };

    const { w, h } = worldSize(ctx.scene);
    const empty = { skip: false, w, h, revealDim: [], revealBright: [] };

    // weldWalls — склеивает почти-совпадающие концы стен ПЕРЕД raycasting'ом
    // (см. geometry.js): без этого щель в пару пикселей на углу комнаты
    // пропускает луч насквозь, и токен внутри формально огороженного
    // помещения видит всю карту. Не трогает сами данные стен — только эту
    // локальную копию, которую видит только расчёт видимости/света ниже.
    //
    // Здания (domain.Building) НЕ участвуют в этом raycasting'е — ни в
    // обзоре, ни в самом построении луча света: подмешивание их контуров
    // сюда добавляло вершины/лучи от КАЖДОГО угла здания для ЛЮБОГО токена
    // на карте (даже далёкого от него) — по сути те же "жёсткие" тени, что
    // рисуют обычные стены, только зданию это не нужно и заметно грузило
    // пересчёт. Обзор через стены здания и так не имеет значения — его
    // прячет независимая "крыша" (layers/buildings.js), а свет через них
    // блокируется отдельно, простым вычитанием/пересечением уже готовых
    // многоугольников (см. clipLightByBuildings ниже) — без единого лишнего
    // луча.
    const walls = weldWalls(Object.values(ctx.scene.walls || {}));
    const tokens = Object.values(ctx.scene.tokens || {}).filter((t) => !t.hidden);
    if (tokens.length === 0) return empty; // некому видеть — сплошная тьма

    // sightTokens — только те, у кого вообще есть "глаза": lightOnly-токен
    // (голая лампочка-маркер, см. domain.Token.LightOnly) — это декоративный
    // источник света, а не персонаж с обзором. Раньше он ВСЁ РАВНО попадал в
    // visionPolys ниже с sightRadius во всю карту (ограниченным только
    // стенами) — один такой факел, поставленный в открытом месте без стен
    // рядом, раскрывал обзором почти всю карту, и это перекрывало эффект
    // ЛЮБОЙ, даже идеально замкнутой, комнаты в другом месте карты (обзор —
    // объединение ПО ВСЕМ токенам сразу, см. visionMulti ниже). Сам свет
    // факела (lightTokens ниже) по-прежнему участвует как обычно — меняется
    // только то, что он не выступает ещё и "наблюдателем".
    const sightTokens = tokens.filter((t) => !t.lightOnly);
    if (sightTokens.length === 0) return empty; // одни факелы без наблюдателя — светить некому

    const sightRadius = Math.hypot(w, h) + SIGHT_MARGIN;
    const visionPolys = sightTokens.map((t) => computeVisibilityPolygon(t.x, t.y, sightRadius, walls)).filter((p) => p.length >= 3);
    const visionMulti = unionAll(visionPolys);
    if (!visionMulti.length) return empty;

    const globalLight = ctx.scene.globalLight || "";
    const lightTokens = tokens.filter((t) => t.light && t.light.enabled && ((t.light.bright || 0) > 0 || (t.light.dim || 0) > 0));
    // Token.Light.Bright/Dim хранятся в единицах линейки сцены (фт), не в
    // пикселях — переводим в мировые единицы прямо здесь, перед raycasting'ом
    // (см. gridUnitsToWorld и domain.TokenLight в scene.go).
    const grid = ctx.scene.grid;

    // buildings/buildingsMulti — контуры зданий для clipLightByBuildings
    // ниже (НЕ для raycasting'а, см. коммент у walls выше).
    const buildings = Object.values(ctx.scene.buildings || {}).filter((b) => b.points.length >= 3);
    const buildingsMulti = buildings.length ? unionAll(buildings.map((b) => b.points)) : [];

    // clipLightByBuildings — здание блокирует свет БЕЗ единого лишнего луча
    // raycasting'а: каждый уже посчитанный (по обычным стенам) многоугольник
    // источника обрезается булевой алгеброй (light-geometry.js), а не
    // пересчитывается. entries — [{token, poly}] для одного радиуса
    // (dim либо bright, см. вызовы ниже). Источник ВНУТРИ конкретного
    // здания — его собственный кусок пересекается с контуром ИМЕННО этого
    // здания (не светит наружу через стену); источники СНАРУЖИ — из их
    // объединения вычитается объединение ВСЕХ зданий разом (не светят внутрь
    // ни одного из них).
    function clipLightByBuildings(entries) {
      if (!buildings.length) return unionAll(entries.map((e) => e.poly));
      const outsidePolys = [];
      let insideMulti = [];
      for (const { token, poly } of entries) {
        const home = buildings.find((b) => pointInPolygon(token.x, token.y, b.points));
        if (home) {
          insideMulti = unionMulti(insideMulti, intersectMulti(unionAll([poly]), unionAll([home.points])));
        } else {
          outsidePolys.push(poly);
        }
      }
      const outsideMulti = differenceMulti(unionAll(outsidePolys), buildingsMulti);
      return unionMulti(outsideMulti, insideMulti);
    }

    let dimMulti;
    if (globalLight === "dim" || globalLight === "bright") {
      dimMulti = worldRect(w, h);
    } else {
      const dimEntries = lightTokens
        .map((t) => ({ token: t, poly: computeVisibilityPolygon(t.x, t.y, gridUnitsToWorld(grid, Math.max(t.light.dim || 0, t.light.bright || 0)), walls) }))
        .filter((e) => e.poly.length >= 3);
      dimMulti = clipLightByBuildings(dimEntries);
    }
    if (!dimMulti.length) return empty; // ни одного источника света на карте — игроки не видят НИЧЕГО (п.2 ТЗ)

    let brightMulti;
    if (globalLight === "bright") {
      brightMulti = worldRect(w, h);
    } else {
      const brightEntries = lightTokens
        .filter((t) => (t.light.bright || 0) > 0)
        .map((t) => ({ token: t, poly: computeVisibilityPolygon(t.x, t.y, gridUnitsToWorld(grid, t.light.bright), walls) }))
        .filter((e) => e.poly.length >= 3);
      brightMulti = clipLightByBuildings(brightEntries);
    }

    const revealDim = intersectMulti(visionMulti, dimMulti);
    if (!revealDim.length) return empty;
    const revealBright = brightMulti.length ? intersectMulti(visionMulti, brightMulti) : [];

    return { skip: false, w, h, revealDim, revealBright };
  }

  // paintPlan — только рисование, готовым результатом computePlan(). Не
  // может кинуть исключение на геометрии (она уже посчитана и провалидирована
  // computePlan'ом) — сюда долетает только safe-часть (Pixi Graphics-вызовы).
  function paintPlan(plan) {
    clearAll();
    if (plan.skip) return; // DM/выключенный туман войны — совсем без тьмы

    const { w, h, revealDim, revealBright } = plan;
    darkness.rect(0, 0, w, h).fill({ color: DARK_COLOR, alpha: DARK_ALPHA });
    if (!revealDim.length) return; // света нет — сплошная тьма как уже залито

    // revealDim — то, что видно хотя бы тускло: пересечение обзора токенов
    // со светом. Вырезаем его из базовой тьмы целиком (дыры — обратно
    // темнотой, см. refillStyle) — дальше dimTint решает, насколько ярко.
    paintMulti(darkness, revealDim, w, h, "cut", null, { color: DARK_COLOR, alpha: DARK_ALPHA });

    // dimTint — полностью покрывает revealDim полупрозрачной дымкой, потом
    // вырезает из НЕЁ revealBright (пересечение обзора с яркой частью
    // света) — в вырезанном месте dimTint прозрачен, и через него видна уже
    // полностью убранная тьма снизу (darkness), то есть чистая картинка.
    // Порядок именно такой (сначала залить весь revealDim, потом вырезать
    // яркую часть), а не наоборот — иначе пришлось бы вычитать
    // многоугольники (revealDim минус revealBright) руками.
    paintMulti(dimTint, revealDim, w, h, "fill", { color: DARK_COLOR, alpha: DIM_ALPHA });
    if (revealBright.length) {
      paintMulti(dimTint, revealBright, w, h, "cut", null, { color: DARK_COLOR, alpha: DIM_ALPHA });
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
