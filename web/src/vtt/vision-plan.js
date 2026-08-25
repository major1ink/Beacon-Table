// vision-plan.js — ЧИСТЫЙ расчёт освещения: снапшот сцены -> план того, что
// рисовать (layers/vision-fog.js), без единого обращения к Pixi. Вынесен из
// layers/vision-fog.js именно ради этого: вся математика, которая реально
// может упасть (polygon-clipping на вырожденной геометрии — см. ниже),
// теперь запускается в тестах на настоящих картах без канваса и WebGL
// (web/test/vision-fog-geometry.test.js). Пока расчёт жил замыканием внутри
// createVisionFogLayer, накрыть его тестом было нечем — и регрессия
// (сборка фронта, отставшая от исходников) доехала до боевого стола.
//
// Что видит игрок = (объединение обзора токенов ПАРТИИ) ∩
// (объединение всех источников света + опциональный глобальный свет на всю
// карту). Оба множителя по отдельности — обычный raycasting от точки,
// ограниченный стенами и радиусом (computeVisibilityPolygon), просто теперь
// их два разных смысла (обзор и свет), а не один. Нет ни одного источника
// света — пересечение пустое — игрок не видит НИЧЕГО, даже там, куда
// дотягивается обзор токена (нечего освещать — нечего видеть).
//
// "Обзор" у токена не ограничен константным радиусом — единственная граница
// обзора это стены (см. SIGHT_MARGIN: радиус берётся с запасом больше
// диагонали карты, то есть фактически "докуда видно по прямой"). Это
// осознанно ближе к дефолтному поведению Foundry VTT (без дарквижна и
// настройки "Sight Range" на токене видно ровно то, что освещено и не
// закрыто стеной — отдельного "радиуса зрения" сверху нет).
import { computeVisibilityPolygon, weldWalls, pointInPolygon, wallBlocksSight, wallBlocksLight } from "../geometry.js";
import { worldSize } from "./camera.js";
import { unionAll, intersectMulti, differenceMulti, unionMulti, worldRect, gridUnitsToWorld, quantizePoints } from "./light-geometry.js";

export const SIGHT_MARGIN = 50; // запас поверх диагонали карты — чисто чтобы raycasting не срезал луч точно на границе

// QUANTUM_LADDER — шаги сетки, к которой прижимаются точки рейкастинга перед
// булевой алгеброй (см. quantizePoints в light-geometry.js). Первый —
// рабочий (0.25px, визуально неотличимо), остальные — аварийные повторы,
// если на точном polygon-clipping всё-таки упал.
export const QUANTUM_LADDER = [0.25, 1, 4];

// LIGHT_STEPS — на сколько ступеней разбит переход от яркого света к краю
// тусклого (см. ringMultis в computeLightLayer). Раньше ступеней было ровно
// две — «ярко» и «тускло», — и граница между ними шла резкой линией поперёк
// светового пятна: именно она читается как артефакт рядом с честными
// (и обязанными быть резкими) краями теней от стен.
//
// Цена ступени — одно пересечение с обзором на кадр (само построение колец
// живёт в кэше слоя света). Замеры на боевых картах: на "Пещере" (301
// стена, 18 источников) каждая ступень стоит ~3 мс, на "Зимнем поместье" —
// ~1.5 мс. 4 — компромисс: переход уже читается как плавный, а кадр на
// поместье остаётся в бюджете 16.7 мс.
export const LIGHT_STEPS = 4;

// computeVisionPlanWithFallback — точка входа для vision-fog.js: каскад по
// QUANTUM_LADDER поверх основной защиты (квантование входа, см.
// quantizePoints). Основная снимает подавляющее большинство падений
// polygon-clipping, но гарантии не даёт: библиотека может споткнуться на
// любой достаточно невезучей геометрии. Раньше единственное падение
// означало ранний return — и, поскольку геометрия сцены между кадрами почти
// не меняется, СЛЕДУЮЩИЙ кадр падал ровно так же. Освещение намертво
// зависало на последнем удачном кадре (в консоль сыпался один и тот же
// стек, а токены визуально переставали двигаться — их позиции обновляет
// этот же пересчёт), пока ДМ не менял стены на что-то попроще.
//
// Повтор на более грубом кванте — это ДРУГОЙ вход для той же библиотеки:
// точки прижимаются к более редкой сетке, вырожденные случаи схлопываются,
// расчёт проходит. Цена — доли пикселя точности границы света, и только в
// тех редких кадрах, где точный квант не сработал. Кадры, где всё хорошо
// (обычный случай), не платят ничего: цикл выходит на первой же итерации.
//
// Возвращает { plan, quantum } при успехе и { plan: null, error } если не
// прошёл ни один шаг лестницы — вызывающая сторона сама решает, что делать
// (vision-fog.js оставляет на экране предыдущий кадр).
//
// memo — НЕОБЯЗАТЕЛЬНЫЙ объект, который вызывающая сторона заводит один раз
// и передаёт сюда каждый кадр (см. vision-fog.js). Он несёт две вещи, и обе
// про скорость, не про результат — без memo всё считается ровно так же,
// просто дороже:
//
//   * memo.quantum — квант, на котором получилось В ПРОШЛЫЙ РАЗ. Лестница
//     задумывалась аварийной («обычно проходит первый шаг»), но на реальных
//     импортированных картах бывает наоборот: на "Пещере" из goblin-trouble
//     (301 стена) точный квант 0.25 падает ВСЕГДА, и каждый кадр честно
//     доделывал заведомо провальную попытку целиком — 86 мс из 264 мс на
//     кадр уходили в мусорку. Геометрия сцены между кадрами почти не
//     меняется, поэтому прошлый удачный квант — лучшая первая догадка;
//     точный квант при этом не забыт, а стоит следующим (см. ladderFrom):
//     как только карта упростится, расчёт сам вернётся на него.
//   * memo.layer/memo.layerKey — посчитанный слой света (см.
//     computeLightLayer). Он зависит ТОЛЬКО от источников, стен, зданий и
//     сетки — но не от того, где стоят наблюдатели. При таскании токена
//     мышью (десятки кадров в секунду) он не меняется ни на пиксель, а
//     пересчитывался вместе с обзором.
export function computeVisionPlanWithFallback(scene, isDM, memo) {
  // Сперва — не изменилось ли вообще ничего из того, от чего зависит
  // освещение. Пересчёт запускает бит dirty.vision, а его выставляет ЛЮБОЙ
  // снапшот, у которого объект tokens не тот же по ссылке (см. dirty.js:
  // diffAndMarkDirty) — то есть каждый бросок кубика, каждое изменение HP,
  // каждая правка инициативы. Геометрия при этом не менялась ни на пиксель,
  // а стол получал десятки миллисекунд заблокированного главного потока —
  // ровно то, что за столом ощущается как «лагает, будто пинг большой».
  if (memo) {
    const key = planInputKey(scene, isDM);
    if (memo.planKey === key && memo.plan) return { plan: memo.plan, quantum: memo.quantum, unchanged: true };
    memo.planKey = null; // до успешного расчёта кэшировать нечего
  }
  let lastErr = null;
  for (const quantum of ladderFrom(memo && memo.quantum)) {
    try {
      const plan = computeVisionPlan(scene, isDM, quantum, memo);
      if (memo) {
        memo.quantum = quantum;
        memo.plan = plan;
        memo.planKey = planInputKey(scene, isDM);
      }
      return { plan, quantum };
    } catch (err) {
      lastErr = err;
      if (memo) memo.layerKey = null; // недосчитанный слой мог остаться в memo — не доверяем ему
    }
  }
  return { plan: null, quantum: null, error: lastErr };
}

// planInputKey — подпись ВСЕГО входа расчёта. Строится за доли миллисекунды
// (см. соображение про строку vs хеш у lightLayerKey) и решает, надо ли
// вообще что-то считать.
//
// Правило то же, что и у lightLayerKey: здесь обязано быть перечислено ровно
// то, что читает computeVisionPlan. Забыть поле — значит показать игроку
// прошлый кадр освещения и не заметить этого (кадр-то валидный, просто
// устаревший).
function planInputKey(scene, isDM) {
  if (isDM || scene.fogOfWar === false) return "skip"; // расчёта нет вовсе — вход неважен
  const parts = [scene.width, scene.height, scene.globalLight || ""];
  const grid = scene.grid;
  if (grid) parts.push(grid.size, grid.unitsPerCell);
  for (const id in scene.tokens || {}) {
    const t = scene.tokens[id];
    if (t.hidden) continue; // скрытый токен не наблюдатель и не источник — его правки расчёта не касаются
    const light = t.light;
    const lights = !!(light && light.enabled && ((light.bright || 0) > 0 || (light.dim || 0) > 0));
    const observes = !t.lightOnly && !!t.ownerId;
    // Токен, который не смотрит и не светит (монстр, труп, безликий NPC), на
    // расчёт не влияет ВООБЩЕ — его в подписи нет. Это не микрооптимизация:
    // именно монстры двигаются в бою чаще всех, и раньше каждый их шаг
    // сбрасывал бы кэш плана впустую.
    if (!lights && !observes) continue;
    parts.push("T", id, t.x, t.y, observes ? 1 : 0);
    if (lights) parts.push(light.bright || 0, light.dim || 0);
  }
  parts.push(wallsSignature(scene));
  for (const id in scene.buildings || {}) {
    parts.push("B", id);
    for (const p of scene.buildings[id].points) parts.push(p.x, p.y);
  }
  return parts.join("|");
}

// ladderFrom — QUANTUM_LADDER, но начиная с ранее сработавшего кванта:
// сперва он сам, затем вся лестница с начала (включая шаги грубее — вдруг
// геометрия усложнилась ещё). Дубли не страшны, но и не нужны — фильтруем.
function ladderFrom(preferred) {
  if (!preferred || preferred === QUANTUM_LADDER[0]) return QUANTUM_LADDER;
  return [preferred, ...QUANTUM_LADDER.filter((q) => q !== preferred)];
}

// computeVisionPlan — один проход расчёта на заданном кванте. МОЖЕТ КИНУТЬ
// исключение (polygon-clipping на вырожденной геометрии) — это нормально и
// ожидаемо, ловит computeVisionPlanWithFallback выше.
export function computeVisionPlan(scene, isDM, quantum, memo) {
  // Только не-DM экран — DM должен видеть весь стол целиком, всегда, вне
  // зависимости от света (ориентир для редактирования, как и со стенами/
  // hidden-токенами). Ручные fogAreas (layers/manual-fog.js) рисуются
  // независимо от этого тумблера, отдельным слоем поверх этого.
  if (isDM) return { skip: true };
  if (scene.fogOfWar === false) return { skip: true };

  const { w, h } = worldSize(scene);
  const empty = { skip: false, w, h, dimIslands: [], rings: [] };

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
  // У СВЕТА список стен свой (см. computeLightLayer): окно держит свет, хотя
  // сквозь него и видно — geometry.js:wallBlocksLight. Один список на оба
  // расчёта был неверен именно на окнах.
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
  const walls = weldWalls(Object.values(scene.walls || {}).filter(wallBlocksSight));
  // Пары [id, token], а не голые токены: id нужен кэшу обзора
  // (cachedSightPolys), и брать его надо из КЛЮЧА словаря сцены, а не из
  // token.id — последнего у токена может не оказаться (так собраны сцены в
  // тестах), и тогда все наблюдатели схлопнулись бы в одну запись кэша.
  const entries = Object.entries(scene.tokens || {}).filter(([, t]) => !t.hidden);
  const tokens = entries.map(([, t]) => t);
  if (tokens.length === 0) return empty; // некому видеть — сплошная тьма

  // sightTokens — ТОКЕНЫ ПАРТИИ, то есть те, у кого есть владелец-игрок
  // (domain.Token.OwnerID; проставляется, когда ДМ выкладывает персонажа из
  // панели "Персонажи"). Именно вся партия, а не только токены смотрящего
  // игрока: за столом персонажи стоят рядом и разговаривают, общий обзор —
  // это то, чего ждут от карты.
  //
  // Раньше наблюдателем считался ЛЮБОЙ нескрытый не-lightOnly токен, то есть
  // и монстры тоже — игрок видел карту глазами гоблинов. На боевой "Пещере"
  // (3 гоблина-воителя, гигантская многоножка и трое NPC против одного
  // токена партии) это открывало игроку ровно вдвое больше карты, чем видела
  // партия. Скрытый токен (Token.Hidden) сюда и раньше не попадал — сервер
  // вырезает его из payload целиком, — а вот обычный видимый монстр попадал.
  //
  // lightOnly-токен (голая лампочка-маркер) отсекается той же строкой и по
  // отдельной причине: это декоративный источник света, а не персонаж с
  // обзором, и владельца у него не бывает вовсе. Сам свет факела
  // (computeLightLayer) по-прежнему участвует как обычно.
  const sightTokens = entries.filter(([, t]) => !t.lightOnly && t.ownerId);
  if (sightTokens.length === 0) return empty; // на сцене нет ни одного токена партии — смотреть некем

  // ray — ЕДИНСТВЕННАЯ точка входа в рейкастинг в этом файле: сразу
  // санитарит результат под текущий quantum (см. quantizePoints), чтобы
  // ни один сырой многоугольник не утёк в булеву алгебру мимо обработки.
  const ray = (x, y, radius) => quantizePoints(computeVisibilityPolygon(x, y, radius, walls), quantum);

  const sightRadius = Math.hypot(w, h) + SIGHT_MARGIN;
  // Обзор каждого наблюдателя — через кэш: пока игрок тащит свой токен,
  // остальные наблюдатели стоят на месте, и их лучи считать заново незачем
  // (см. cachedSightPolys).
  const visionPolys = cachedSightPolys(sightTokens, sightRadius, quantum, ray, memo, wallsSignature(scene)).filter((p) => p.length >= 3);
  const visionMulti = unionAll(visionPolys);
  if (!visionMulti.length) return empty;

  // Слой света считаем через memo (см. computeVisionPlanWithFallback): он не
  // зависит от того, где стоят наблюдатели, и при таскании токена по карте
  // не меняется вообще.
  const { dimMulti, ringMultis } = cachedLightLayer(scene, quantum, tokens, w, h, memo);
  if (!dimMulti.length) return empty; // ни одного источника света на карте — игроки не видят НИЧЕГО (п.2 ТЗ)

  const revealDim = intersectMulti(visionMulti, dimMulti);
  if (!revealDim.length) return empty;

  // dimIslands — revealDim по отдельным "островам" (одна дыра могла
  // распасться на несколько несмежных кусков — стены дробят даже свет ОДНОГО
  // факела, а уж несколько факелов в разных углах карты почти всегда дают
  // больше одного острова). Нужны только для выреза из тьмы (см. paintPlan).
  const dimIslands = revealDim.map((poly) => ({ poly }));

  // rings — те же кольца затухания, что посчитал слой света, но обрезанные
  // обзором. level (0 — край тусклого света, 1 — яркий свет) переводит в
  // прозрачность уже vision-fog.js: план не знает про альфы и цвета.
  const rings = [];
  for (const { level, multi } of ringMultis) {
    const reveal = intersectMulti(visionMulti, multi);
    if (reveal.length) rings.push({ level, multi: reveal });
  }

  return { skip: false, w, h, dimIslands, rings };
}

// ---- слой света ----
//
// Всё, что ниже, считает ТОЛЬКО «где на карте есть свет» — без единого
// упоминания наблюдателей. Это и есть причина, по которой слой вынесен из
// computeVisionPlan: при таскании токена мышью (десятки кадров в секунду)
// меняются позиции наблюдателей, а свет — нет, и пересчитывать его заново на
// каждый кадр было чистой потерей. Кто держит кэш — vision-fog.js (см. memo в
// computeVisionPlanWithFallback), сам расчёт остаётся чистой функцией.

// cachedLightLayer — computeLightLayer плюс проверка ключа. Ключ сравнивает
// ровно тот вход, от которого слой зависит (см. lightLayerKey): совпал —
// отдаём прошлый результат как есть, не совпал — считаем и запоминаем.
function cachedLightLayer(scene, quantum, tokens, w, h, memo) {
  const key = memo ? lightLayerKey(scene, quantum, tokens) : null;
  if (memo && memo.layerKey === key && memo.layer) return memo.layer;
  const layer = computeLightLayer(scene, quantum, tokens, w, h);
  if (memo) {
    memo.layer = layer;
    memo.layerKey = key;
  }
  return layer;
}

// lightLayerKey — подпись входа слоя света. Строка, а не хеш: собирается за
// доли миллисекунды даже на карте с сотнями стен (против десятков
// миллисекунд самого расчёта), а от коллизий, в отличие от хеша, защищена по
// построению. Всё, что здесь перечислено, обязано быть ровно тем, что читает
// computeLightLayer — забыть поле значит показать игроку прошлый кадр света.
function lightLayerKey(scene, quantum, tokens) {
  const parts = [quantum, scene.globalLight || "", scene.grid && scene.grid.size, scene.grid && scene.grid.unitsPerCell];
  for (const t of tokens) {
    if (!t.light || !t.light.enabled) continue;
    parts.push("L", t.x, t.y, t.light.bright || 0, t.light.dim || 0);
  }
  parts.push(wallsSignature(scene));
  for (const id in scene.buildings || {}) {
    parts.push("B", id);
    for (const p of scene.buildings[id].points) parts.push(p.x, p.y);
  }
  return parts.join("|");
}

// wallsSignature — подпись ВСЕХ стен со всеми полями, которые влияют хоть на
// один рейкастинг (см. wallBlocksSight/wallBlocksLight). Одна на оба кэша —
// и слоя света, и обзора: разводить их по отдельным подписям значит завести
// два места, где легко забыть новое поле стены, а цена лишнего сброса кэша
// (стены двигает только ДМ, и только в редакторе) пренебрежима.
function wallsSignature(scene) {
  const parts = [];
  for (const id in scene.walls || {}) {
    const wall = scene.walls[id];
    parts.push("W", wall.x1, wall.y1, wall.x2, wall.y2, wall.door || "", wall.doorState || "", wall.window ? 1 : 0, wall.lightThrough ? 1 : 0);
  }
  return parts.join("|");
}

// cachedSightPolys — многоугольники обзора наблюдателей, по одному на токен,
// с переиспользованием тех, что не изменились.
//
// Зачем: пока игрок тащит СВОЙ токен мышью, из всех наблюдателей на карте
// двигается ровно один, а рейкастинг гонялся заново для каждого. На "Пещере"
// (289 стен, 7 наблюдателей) это 16 мс на кадр, из которых 14 — пересчёт
// того, что не менялось.
//
// Кэш сбрасывается целиком при любой правке стен (wallsSignature) или смене
// кванта: и то и другое меняет ВСЕ многоугольники разом, разбираться
// по-токенно там нечего.
//
// Объединение (unionAll ниже) при этом всё равно считается заново — оно
// зависит от всех многоугольников сразу, и один сдвинувшийся наблюдатель
// меняет результат целиком.
function cachedSightPolys(sightTokens, radius, quantum, ray, memo, wallsKey) {
  if (!memo) return sightTokens.map(([, t]) => ray(t.x, t.y, radius));
  const key = `${quantum}|${radius}|${wallsKey}`;
  if (memo.sightKey !== key) {
    memo.sightKey = key;
    memo.sight = new Map();
  }
  const fresh = new Map();
  const out = [];
  for (const [id, t] of sightTokens) {
    const hit = memo.sight.get(id);
    const poly = hit && hit.x === t.x && hit.y === t.y ? hit.poly : ray(t.x, t.y, radius);
    fresh.set(id, { x: t.x, y: t.y, poly });
    out.push(poly);
  }
  memo.sight = fresh; // ушедшие со сцены токены не копятся в кэше
  return out;
}

// computeLightLayer — { dimMulti, brightMulti }: где на карте есть тусклый и
// где яркий свет, уже с учётом стен и зданий, но БЕЗ обзора. МОЖЕТ КИНУТЬ —
// как и computeVisionPlan, ловит computeVisionPlanWithFallback.
export function computeLightLayer(scene, quantum, tokens, w, h) {
  const globalLight = scene.globalLight || "";
  const lightTokens = tokens.filter((t) => t.light && t.light.enabled && ((t.light.bright || 0) > 0 || (t.light.dim || 0) > 0));
  // Token.Light.Bright/Dim хранятся в единицах линейки сцены (фт), не в
  // пикселях — переводим в мировые единицы прямо здесь, перед raycasting'ом
  // (см. gridUnitsToWorld и domain.TokenLight в scene.go).
  const grid = scene.grid;

  // Список стен СВЕТА — свой, не тот, по которому считается обзор: окно свет
  // держит (geometry.js:wallBlocksLight и коммент там же про иглы у окон).
  const walls = weldWalls(Object.values(scene.walls || {}).filter(wallBlocksLight));
  const ray = (x, y, radius) => quantizePoints(computeVisibilityPolygon(x, y, radius, walls), quantum);

  // buildings/buildingsMulti — контуры зданий для clipLightByBuildings
  // ниже (НЕ для raycasting'а, см. коммент у walls в computeVisionPlan).
  // Контуры зданий прижимаем к ТОЙ ЖЕ сетке, что и лучи (quantizePoints) —
  // иначе вершина здания и упёршийся в неё луч расходились бы на доли
  // пикселя, а такие "почти совпадающие, но не совпавшие" точки — ровно
  // тот случай, на котором polygon-clipping и спотыкается.
  const buildings = Object.values(scene.buildings || {})
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

  // bandAt — «докуда достаёт свет», если каждому источнику урезать радиус с
  // dim до bright на долю k/LIGHT_STEPS. k=0 — полный тусклый радиус, k=
  // LIGHT_STEPS — ровно ярко освещённое ядро. Радиус у каждого источника
  // СВОЙ (у факела и у костра затухание своей ширины), поэтому доля
  // применяется к каждому по отдельности, а объединяются уже готовые
  // многоугольники.
  const bandAt = (k) => {
    if (globalLight === "bright") return worldRect(w, h);
    if (globalLight === "dim") return k === 0 ? worldRect(w, h) : [];
    const entries = lightTokens
      .map((t) => {
        const dim = gridUnitsToWorld(grid, Math.max(t.light.dim || 0, t.light.bright || 0));
        const bright = gridUnitsToWorld(grid, t.light.bright || 0);
        const radius = dim - (dim - bright) * (k / LIGHT_STEPS);
        return { token: t, poly: radius > 0 ? ray(t.x, t.y, radius) : [] };
      })
      .filter((e) => e.poly.length >= 3);
    return clipLightByBuildings(entries);
  };

  const bands = [];
  for (let k = 0; k <= LIGHT_STEPS; k++) bands.push(bandAt(k));

  // ringMultis — КОЛЬЦА между соседними полосами, то есть фигуры, которые
  // НЕ ПЕРЕСЕКАЮТСЯ между собой. Это и есть весь фокус мягкого света: тьма
  // рисуется поверх карты, а накладывать полупрозрачные слои тьмы друг на
  // друга нельзя — там, где два факела перекрываются, суммарная альфа
  // получилась бы БОЛЬШЕ, чем от каждого по отдельности, и на стыке двух
  // световых пятен появилась бы тёмная кайма (ровно наоборот тому, как
  // ведёт себя настоящий свет). Разложенные в непересекающиеся кольца
  // полосы такого стыка иметь не могут по построению: каждая точка карты
  // попадает ровно в одно кольцо — то, которое отвечает БЛИЖАЙШЕМУ к ней
  // источнику (объединение по источникам считается ДО вычитания). Заодно
  // это снимает всю возню с Pixi cut(): кольцу не нужны чужие вырезы, у
  // него есть собственные дыры и всё (см. fillMulti в light-geometry.js).
  //
  // Само ярко освещённое ядро (bands[LIGHT_STEPS]) в список не попадает —
  // ему отвечает level 1, то есть полностью прозрачная накладка: рисовать
  // нечего.
  const ringMultis = [];
  for (let k = 0; k < LIGHT_STEPS; k++) {
    const multi = differenceMulti(bands[k], bands[k + 1]);
    if (multi.length) ringMultis.push({ level: k / LIGHT_STEPS, multi });
  }

  return { dimMulti: bands[0], ringMultis };
}
