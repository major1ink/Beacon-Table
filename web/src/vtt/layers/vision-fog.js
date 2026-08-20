import { Container, Graphics } from "pixi.js";
import { computeVisibilityPolygon, weldWalls, pointInPolygon, wallBlocksSight } from "../../geometry.js";
import { worldSize } from "../camera.js";
import { unionAll, intersectMulti, differenceMulti, unionMulti, worldRect, paintMulti, gridUnitsToWorld, quantizePoints } from "../light-geometry.js";

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
// QUANTUM_LADDER — шаги сетки, к которой прижимаются точки рейкастинга перед
// булевой алгеброй (см. quantizePoints в light-geometry.js и rebuild ниже).
// Первый — рабочий (0.25px, визуально неотличимо), остальные — аварийные
// повторы, если на точном polygon-clipping всё-таки упал.
const QUANTUM_LADDER = [0.25, 1, 4];

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
    // Каскад по QUANTUM_LADDER — страховка поверх основной защиты
    // (квантование входа, см. quantizePoints в light-geometry.js). Основная
    // снимает подавляющее большинство падений polygon-clipping, но
    // гарантии не даёт: библиотека может споткнуться на любой достаточно
    // невезучей геометрии. Раньше единственное падение означало ранний
    // return — и, поскольку геометрия сцены между кадрами почти не меняется,
    // СЛЕДУЮЩИЙ кадр падал ровно так же. Освещение намертво зависало на
    // последнем удачном кадре (в консоль сыпался один и тот же стек, а
    // токены визуально переставали двигаться — их позиции обновляет этот же
    // пересчёт), пока ДМ не менял стены на что-то попроще.
    //
    // Повтор на более грубом кванте — это ДРУГОЙ вход для той же
    // библиотеки: точки прижимаются к более редкой сетке, вырожденные
    // случаи схлопываются, расчёт проходит. Цена — доли пикселя точности
    // границы света, и только в тех редких кадрах, где точный квант не
    // сработал. Кадры, где всё хорошо (обычный случай), не платят ничего:
    // цикл выходит на первой же итерации.
    let plan = null;
    let lastErr = null;
    for (const quantum of QUANTUM_LADDER) {
      try {
        plan = computePlan(quantum);
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!plan) {
      console.error("beacon: сбой пересчёта освещения (vision-fog computePlan) — оставляю прошлый кадр как есть:", lastErr, {
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
  function computePlan(quantum) {
    // Только не-DM экран — DM должен видеть весь стол целиком, всегда, вне
    // зависимости от света (ориентир для редактирования, как и со стенами/
    // hidden-токенами). Ручные fogAreas (layers/manual-fog.js) рисуются
    // независимо от этого тумблера, отдельным слоем поверх этого.
    if (ctx.isDM) return { skip: true };
    if (ctx.scene.fogOfWar === false) return { skip: true };

    const { w, h } = worldSize(ctx.scene);
    const empty = { skip: false, w, h, dimIslands: [] };

    // weldWalls — склеивает почти-совпадающие концы стен ПЕРЕД raycasting'ом
    // (см. geometry.js): без этого щель в пару пикселей на углу комнаты
    // пропускает луч насквозь, и токен внутри формально огороженного
    // помещения видит всю карту. Не трогает сами данные стен — только эту
    // локальную копию, которую видит только расчёт видимости/света ниже.
    //
    // wallBlocksSight — фильтрует ДО weldWalls: открытая дверь и окно (см.
    // domain.Wall.Door/DoorState/Window, geometry.js:wallBlocksSight) просто
    // не попадают в raycasting вообще, как будто их тут нет — ни отдельной
    // ветки в computeVisibilityPolygon, ни пересчёта геометрии не нужно.
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
    const walls = weldWalls(Object.values(ctx.scene.walls || {}).filter(wallBlocksSight));
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

    // ray — ЕДИНСТВЕННАЯ точка входа в рейкастинг в этом файле: сразу
    // санитарит результат под текущий quantum (см. quantizePoints), чтобы
    // ни один сырой многоугольник не утёк в булеву алгебру мимо обработки.
    const ray = (x, y, radius) => quantizePoints(computeVisibilityPolygon(x, y, radius, walls), quantum);

    const sightRadius = Math.hypot(w, h) + SIGHT_MARGIN;
    const visionPolys = sightTokens.map((t) => ray(t.x, t.y, sightRadius)).filter((p) => p.length >= 3);
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
    // Контуры зданий прижимаем к ТОЙ ЖЕ сетке, что и лучи (quantizePoints) —
    // иначе вершина здания и упёршийся в неё луч расходились бы на доли
    // пикселя, а такие "почти совпадающие, но не совпавшие" точки — ровно
    // тот случай, на котором polygon-clipping и спотыкается.
    const buildings = Object.values(ctx.scene.buildings || {})
      .filter((b) => b.points.length >= 3)
      .map((b) => ({ points: quantizePoints(b.points, quantum) }))
      .filter((b) => b.points.length >= 3);
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
        .map((t) => ({ token: t, poly: ray(t.x, t.y, gridUnitsToWorld(grid, Math.max(t.light.dim || 0, t.light.bright || 0))) }))
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
        .map((t) => ({ token: t, poly: ray(t.x, t.y, gridUnitsToWorld(grid, t.light.bright)) }))
        .filter((e) => e.poly.length >= 3);
      brightMulti = clipLightByBuildings(brightEntries);
    }

    const revealDim = intersectMulti(visionMulti, dimMulti);
    if (!revealDim.length) return empty;
    const revealBright = brightMulti.length ? intersectMulti(visionMulti, brightMulti) : [];

    // dimIslands — revealDim, но каждый отдельный "остров" (одна дыра могла
    // распасться на несколько несмежных кусков — стены дробят даже свет
    // ОДНОГО факела, а уж несколько факелов в разных углах карты почти
    // всегда дают больше одного острова) уже со СВОИМ кусочком revealBright
    // внутри него (см. paintPlan — там на пару fill()+cut() надо ровно по
    // одному острову за раз, иначе Pixi Graphics.cut() перепутает остров).
    // Пересечение считаем ЛОКАЛЬНО: один остров (обёрнутый в [poly] — уже
    // готовый MultiPolygon из одного элемента) против revealBright — вход
    // ограничен размером ЭТОГО острова, не всей карты. Первая версия фикса
    // считала вместо этого differenceMulti(worldRect(w,h), revealDim) — вычитание
    // острова(-ов) из прямоугольника ВСЕЙ карты целиком: на картах со
    // сложной геометрией стен (много изрезанных islands) polygon-clipping
    // на такой операции валится ("Unable to find segment ... in SweepLine
    // tree", переполнение стека в isExteriorRing на большом числе вложенных
    // дыр) — ловится в try/catch (см. rebuild()), но КАЖДЫЙ кадр подряд, то
    // есть освещение зависает на последнем удачном кадре навсегда, пока
    // геометрия сцены не поменяется на что-то попроще. Локальный per-island
    // intersect на порядки меньше и без этой патологии.
    const dimIslands = revealDim.map((poly) => ({
      poly,
      bright: revealBright.length ? intersectMulti([poly], revealBright) : [],
    }));

    return { skip: false, w, h, dimIslands };
  }

  // paintPlan — только рисование, готовым результатом computePlan(). Не
  // может кинуть исключение на геометрии (она уже посчитана и провалидирована
  // computePlan'ом) — сюда долетает только safe-часть (Pixi Graphics-вызовы).
  function paintPlan(plan) {
    clearAll();
    if (plan.skip) return; // DM/выключенный туман войны — совсем без тьмы

    const { w, h, dimIslands } = plan;
    darkness.rect(0, 0, w, h).fill({ color: DARK_COLOR, alpha: DARK_ALPHA });
    if (!dimIslands.length) return; // света нет — сплошная тьма как уже залито

    // revealDim (все острова разом) — то, что видно хотя бы тускло.
    // Вырезаем целиком из ОДНОЙ базовой заливки тьмы (дыры — обратно
    // темнотой, см. refillStyle) — тут работает старый трюк: darkness это
    // ОДНА fill-инструкция (rect() чуть выше), Pixi Graphics.cut() вешает
    // дыру именно на неё, и сколько бы островов ни было — все их cut()'ы
    // корректно накапливаются на этой единственной инструкции через
    // hole.addPath (см. node_modules/pixi.js/lib/scene/graphics/shared/
    // GraphicsContext.js:cut). Дальше dimTint решает, насколько ярко.
    paintMulti(darkness, dimIslands.map((d) => d.poly), w, h, "cut", null, { color: DARK_COLOR, alpha: DARK_ALPHA });

    // dimTint — а вот тут ОДНОЙ инструкцией не обойтись: у каждого острова
    // своя часть revealBright, которую нужно вырезать ИМЕННО из заливки
    // ЭТОГО острова, а не из чужой. Pixi'шный cut() вешает дыру только на
    // последнюю fill-инструкцию контекста (та же ссылка на GraphicsContext.js
    // выше) — поэтому на каждый остров идёт СВОЯ пара fill()+cut() подряд,
    // без единого fill() между ними от соседнего острова: cut() яркой части
    // всегда попадает точно в только что нарисованную заливку своего
    // острова, а не в чужую/самую последнюю. Раньше это было сломано:
    // сначала заливались ВСЕ острова разом, потом ВСЕ cut()'ы разом — все
    // они доставались только последнему острову, и яркий свет у любого
    // источника, кроме последнего нарисованного, не работал вообще (см.
    // историю правки этого файла).
    for (const { poly, bright } of dimIslands) {
      paintMulti(dimTint, [poly], w, h, "fill", { color: DARK_COLOR, alpha: DIM_ALPHA });
      if (bright.length) {
        paintMulti(dimTint, bright, w, h, "cut", null, { color: DARK_COLOR, alpha: DIM_ALPHA });
      }
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
