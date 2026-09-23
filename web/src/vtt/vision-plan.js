// vision-plan.js — ЧИСТЫЙ расчёт освещения: снапшот сцены -> план того, что
// рисовать (layers/vision-fog.js), без единого обращения к Pixi. Вынесен из
// layers/vision-fog.js именно ради этого: вся математика, которая реально
// может упасть (polygon-clipping на вырожденной геометрии — см. ниже),
// теперь запускается в тестах на настоящих картах без канваса и WebGL
// (web/test/vision-fog-geometry.test.js). Пока расчёт жил замыканием внутри
// createVisionFogLayer, накрыть его тестом было нечем — и регрессия
// (сборка фронта, отставшая от исходников) доехала до боевого стола.
//
// Что видит игрок = (объединение обзора токенов ПАРТИИ) ∩ (объединение всех
// источников света + опциональный глобальный свет на всю карту), плюс зоны
// ТЁМНОГО ЗРЕНИЯ наблюдателей (domain.TokenVision) — единственное, что видно
// без света вообще. Все слагаемые — обычный raycasting от точки,
// ограниченный стенами и радиусом (computeVisibilityPolygon).
//
// "Обзор" у токена не ограничен константным радиусом — единственная граница
// обзора это стены (см. SIGHT_MARGIN: радиус берётся с запасом больше
// диагонали карты, то есть фактически "докуда видно по прямой"). Это
// осознанно ближе к дефолтному поведению Foundry VTT: без тёмного зрения
// видно ровно то, что освещено и не закрыто стеной.
import { computeVisibilityPolygon, weldWalls, pointInPolygon, wallBlocksSight, wallBlocksLight, wallsInRange } from "../geometry.js";
import { worldSize } from "./camera.js";
import {
  unionAll,
  intersectMulti,
  differenceMulti,
  subtractNested,
  unionMulti,
  unionMany,
  unionInto,
  worldRect,
  gridUnitsToWorld,
  quantizePoints,
  sectorPoints,
} from "./light-geometry.js";

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
  const skipDark = isDM || scene.fogOfWar === false;
  // Тьмы нет, но цветной свет рисуется и там (см. computeVisionPlan) —
  // тогда вход зависит от источников, и подписать его надо честно.
  if (skipDark && !hasColoredLight(scene)) return "skip";
  const parts = [scene.width, scene.height, scene.globalLight || "", skipDark ? "nodark" : ""];
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
    // Цвет и конус тоже меняют картинку: без них смена оттенка не сбрасывала
    // кэш плана, и заливка обновлялась только со следующей правкой сцены.
    if (lights) parts.push(light.bright || 0, light.dim || 0, light.color || "", light.angle || 0, light.direction || 0);
    if (observes && t.vision) parts.push(t.vision.mode || "", t.vision.range || 0);
  }
  parts.push(wallsSignature(scene));
  for (const id in scene.buildings || {}) {
    parts.push("B", id);
    for (const p of scene.buildings[id].points) parts.push(p.x, p.y);
  }
  parts.push(fogZonesSignature(scene));
  return parts.join("|");
}

// fogZonesSignature — подпись ПОКАЗАННЫХ зон тумана со СВЕТОМ
// (domain.FogArea.Light): только они — вход расчёта. Скрытая зона —
// сплошная тьма поверх всего (layers/manual-fog.js), на расчёт света не
// влияет и в подпись не попадает — её правка не сбрасывает кэш ни слоя
// света, ни плана.
function fogZonesSignature(scene) {
  const parts = [];
  for (const id in scene.fogAreas || {}) {
    const zone = scene.fogAreas[id];
    if (!zone.light || !zone.revealed) continue;
    parts.push("Z", id, zone.light);
    for (const p of zone.points) parts.push(p.x, p.y);
  }
  return parts.join(",");
}

// fogLightZones — зоны тумана со светом как готовые MultiPolygon'ы по
// режиму (см. domain.FogArea.Light). Контуры прижаты к тому же кванту, что
// и лучи (см. коммент у buildings в computeLightLayer — иначе
// polygon-clipping спотыкается на почти совпадающих точках).
function fogLightZones(scene, quantum) {
  const byLight = { bright: [], dim: [], dark: [] };
  for (const id in scene.fogAreas || {}) {
    const zone = scene.fogAreas[id];
    if (!zone.revealed || !byLight[zone.light] || zone.points.length < 3) continue;
    const pts = quantizePoints(zone.points, quantum);
    if (pts.length >= 3) byLight[zone.light].push(pts);
  }
  return {
    bright: byLight.bright.length ? unionAll(byLight.bright) : [],
    dim: byLight.dim.length ? unionAll(byLight.dim) : [],
    dark: byLight.dark.length ? unionAll(byLight.dark) : [],
  };
}

// hasColoredLight — есть ли на сцене хоть один горящий цветной источник.
// Проверка дешёвая и решает, платить ли за расчёт слоя света там, где тьму
// не рисуют вовсе (ДМ, выключенный туман войны).
function hasColoredLight(scene) {
  for (const id in scene.tokens || {}) {
    const t = scene.tokens[id];
    if (t.hidden || !t.light || !t.light.enabled || !t.light.color) continue;
    if ((t.light.bright || 0) > 0 || (t.light.dim || 0) > 0) return true;
  }
  return false;
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
  const { w, h } = worldSize(scene);
  // Тьму рисуем только игроку, но цветную заливку — всем: ДМ должен видеть,
  // куда и каким цветом светит фонарь, не заходя глазами игрока.
  if (isDM || scene.fogOfWar === false) {
    if (!hasColoredLight(scene)) return { skip: true };
    const lit = Object.values(scene.tokens || {}).filter((t) => !t.hidden);
    const { tints } = cachedLightLayer(scene, quantum, lit, w, h, memo);
    return { skip: true, w, h, tints };
  }

  const empty = { skip: false, w, h, dimIslands: [], rings: [], tints: [] };

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

  // darkMulti — что видно ТЁМНЫМ ЗРЕНИЕМ: свой луч от каждого наблюдателя с
  // domain.TokenVision, радиусом в его Range. Свет тут не при чём — это
  // единственный способ увидеть что-то на неосвещённой карте.
  const darkPolys = cachedDarkPolys(sightTokens, scene.grid, quantum, ray, memo, wallsSignature(scene)).filter((p) => p.length >= 3);
  let darkMulti = darkPolys.length ? unionAll(darkPolys) : [];
  // Магическая тьма (domain.FogArea.Light = "dark") не пробивается и тёмным
  // зрением — как по правилам 5e. Свет она гасит уже в слое света (см.
  // applyZones в computeLightLayer), тут остаётся только зрение.
  const darkZones = darkMulti.length ? fogLightZones(scene, quantum).dark : [];
  if (darkZones.length) darkMulti = differenceMulti(darkMulti, darkZones);

  // Слой света считаем через memo (см. computeVisionPlanWithFallback): он не
  // зависит от того, где стоят наблюдатели, и при таскании токена по карте
  // не меняется вообще.
  const { dimMulti, ringMultis, tints: layerTints } = cachedLightLayer(scene, quantum, tokens, w, h, memo);
  if (!dimMulti.length && !darkMulti.length) return empty; // ни света, ни тёмного зрения — игроки не видят НИЧЕГО (п.2 ТЗ)

  const revealLight = dimMulti.length ? intersectMulti(visionMulti, dimMulti) : [];
  // Пересекать darkMulti с обзором незачем: он и построен лучом от самого
  // наблюдателя, то есть уже ограничен теми же стенами.
  const revealDim = darkMulti.length ? unionMulti(revealLight, darkMulti) : revealLight;
  if (!revealDim.length) return empty;

  // dimIslands — revealDim по отдельным "островам" (одна дыра могла
  // распасться на несколько несмежных кусков — стены дробят даже свет ОДНОГО
  // факела, а уж несколько факелов в разных углах карты почти всегда дают
  // больше одного острова). Нужны только для выреза из тьмы (см. paintPlan).
  const dimIslands = revealDim.map((poly) => ({ poly }));

  // rings — те же кольца затухания, что посчитал слой света, но обрезанные
  // обзором. level (0 — край тусклого света, 1 — яркий свет) переводит в
  // прозрачность уже vision-fog.js: план не знает про альфы и цвета.
  //
  // Каждое кольцо обрезается ОТДЕЛЬНО и падение одного не роняет весь кадр:
  // кольца — это поволока затухания, украшение поверх уже посчитанного
  // revealDim, и потерять одно из них означает ровно то, что этот поясок
  // покажется чуть ярче, чем должен. Раньше исключение отсюда роняло весь
  // план шёл в мусор, лестница квантов пересчитывала ВСЁ с нуля, а если не
  // помогала и она — свет замирал на прошлом кадре целиком. Несоразмерная
  // цена за градиент.
  const rings = [];
  for (const { level, multi } of ringMultis) {
    let reveal = null;
    try {
      reveal = intersectMulti(visionMulti, multi);
    } catch {
      continue; // см. выше — кольцо не нарисуется, туман войны от этого не пострадает
    }
    if (reveal.length) rings.push({ level, multi: reveal });
  }

  // Зона тёмного зрения — с той же поволокой, что и внешний край тусклого
  // света (level 0): по правилам 5e в темноте видно приглушённо. Освещённую
  // часть вычитаем — кольца не должны перекрываться (см. ringMultis), иначе
  // на стыке поволока ляжет дважды и получится тёмная кайма.
  if (darkMulti.length) {
    try {
      const darkOnly = revealLight.length ? differenceMulti(darkMulti, revealLight) : darkMulti;
      if (darkOnly.length) rings.push({ level: 0, multi: darkOnly });
    } catch {
      // как и со световым кольцом выше: без поволоки зона просто будет ярче
    }
  }

  // Цвет ложится только на то, что игрок реально видит: сама зона источника
  // уже посчитана слоем света, здесь остаётся пересечь её с обзором.
  const tints = [];
  for (const { color, multi } of layerTints) {
    let visible = null;
    try {
      visible = intersectMulti(visionMulti, multi);
    } catch {
      continue; // как и с кольцами: без заливки зона просто останется белой
    }
    if (visible.length) tints.push({ color, multi: visible });
  }

  return { skip: false, w, h, dimIslands, rings, tints };
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
  const layer = computeLightLayer(scene, quantum, tokens, w, h, memo);
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
    parts.push("L", t.x, t.y, t.light.bright || 0, t.light.dim || 0, t.light.color || "", t.light.angle || 0, t.light.direction || 0);
  }
  parts.push(wallsSignature(scene));
  for (const id in scene.buildings || {}) {
    parts.push("B", id);
    for (const p of scene.buildings[id].points) parts.push(p.x, p.y);
  }
  parts.push(fogZonesSignature(scene));
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

// cachedDarkPolys — лучи тёмного зрения, по одному на наблюдателя с ним (см.
// domain.TokenVision). Радиус у каждого свой, поэтому в ключе кэша, кроме
// позиции, ещё и он: сменил ДМ радиус — пересчитали только этот токен.
function cachedDarkPolys(sightTokens, grid, quantum, ray, memo, wallsKey) {
  const entries = [];
  for (const [id, t] of sightTokens) {
    const v = t.vision;
    if (!v || v.mode !== "dark") continue;
    const radius = gridUnitsToWorld(grid, v.range || 0);
    if (radius > 0) entries.push([id, t, radius]);
  }
  if (!entries.length) return [];
  if (!memo) return entries.map(([, t, radius]) => ray(t.x, t.y, radius));

  const key = `${quantum}|${wallsKey}`;
  if (memo.darkKey !== key) {
    memo.darkKey = key;
    memo.dark = new Map();
  }
  const fresh = new Map();
  const out = [];
  for (const [id, t, radius] of entries) {
    const hit = memo.dark.get(id);
    const poly = hit && hit.x === t.x && hit.y === t.y && hit.radius === radius ? hit.poly : ray(t.x, t.y, radius);
    fresh.set(id, { x: t.x, y: t.y, radius, poly });
    out.push(poly);
  }
  memo.dark = fresh;
  return out;
}

// nearWallsKey — подпись стен света, до которых достаёт источник (с запасом
// на сварку концов, см. weldWalls): ключ кэша полос одного источника.
function nearWallsKey(walls, x, y, reach) {
  const parts = [];
  for (const w of wallsInRange(walls, x, y, reach + 2)) parts.push(w.x1, w.y1, w.x2, w.y2);
  return parts.join(",");
}

// cachedUnion — объединение фигур с памятью о прошлом вызове для того же
// slot. Фигуры сравниваются по ссылке (их отдаёт кэш полос источников).
// Только добавились — вливаем их в прошлый ответ (unionInto). Какие-то ушли
// (факел сдвинулся — старая фигура сменилась новой) — нужен ответ без них:
// base — объединение тех, что не менялись, его хватает на всё перетаскивание
// одного и того же токена.
function cachedUnion(prevSlots, nextSlots, slot, multis) {
  const list = multis.filter((m) => m && m.length);
  const prev = prevSlots && prevSlots.get(slot);
  const members = new Set(list);
  let result;
  let base = null;
  if (!prev) {
    result = unionMany(list);
    base = { members, result };
  } else if ([...prev.members].every((m) => members.has(m))) {
    result = unionInto(prev.result, list.filter((m) => !prev.members.has(m)));
    base = prev.base;
  } else if (prev.base && [...prev.base.members].every((m) => members.has(m))) {
    base = prev.base;
    result = unionInto(base.result, list.filter((m) => !base.members.has(m)));
  } else {
    const stay = list.filter((m) => prev.members.has(m));
    base = { members: new Set(stay), result: unionMany(stay) };
    result = unionInto(base.result, list.filter((m) => !prev.members.has(m)));
  }
  if (nextSlots) nextSlots.set(slot, { members, result, base });
  return result;
}

// computeLightLayer — { dimMulti, brightMulti }: где на карте есть тусклый и
// где яркий свет, уже с учётом стен и зданий, но БЕЗ обзора. МОЖЕТ КИНУТЬ —
// как и computeVisionPlan, ловит computeVisionPlanWithFallback.
export function computeLightLayer(scene, quantum, tokens, w, h, memo) {
  const globalLight = scene.globalLight || "";
  const lightTokens = tokens.filter((t) => t.light && t.light.enabled && ((t.light.bright || 0) > 0 || (t.light.dim || 0) > 0));
  // Token.Light.Bright/Dim хранятся в единицах линейки сцены (фт), не в
  // пикселях — переводим в мировые единицы прямо здесь, перед raycasting'ом
  // (см. gridUnitsToWorld и domain.TokenLight в scene.go).
  const grid = scene.grid;

  // Список стен СВЕТА — свой, не тот, по которому считается обзор: окно свет
  // держит (geometry.js:wallBlocksLight и коммент там же про иглы у окон).
  // Сварка — лениво: при сдвиге одного факела остальные берутся из кэша.
  const lightWalls = Object.values(scene.walls || {}).filter(wallBlocksLight);
  let welded = null;
  const ray = (x, y, radius) => {
    if (!welded) welded = weldWalls(lightWalls);
    return quantizePoints(computeVisibilityPolygon(x, y, radius, welded), quantum);
  };

  // buildings/buildingsMulti — контуры зданий (НЕ для raycasting'а, см.
  // коммент у walls в computeVisionPlan). Контуры прижимаем к ТОЙ ЖЕ сетке,
  // что и лучи (quantizePoints) — иначе вершина здания и упёршийся в неё луч
  // расходились бы на доли пикселя, а такие "почти совпадающие, но не
  // совпавшие" точки — ровно тот случай, на котором polygon-clipping и
  // спотыкается.
  const buildings = Object.values(scene.buildings || {})
    .filter((b) => b.points.length >= 3)
    .map((b) => ({ points: quantizePoints(b.points, quantum) }))
    .filter((b) => b.points.length >= 3);
  const buildingsMulti = buildings.length ? unionAll(buildings.map((b) => b.points)) : [];
  const buildingsKey = buildings.map((b) => b.points.map((p) => `${p.x},${p.y}`).join(";")).join("|");

  // lightBands — полосы ОДНОГО источника, k=0 — полный тусклый радиус, k=
  // LIGHT_STEPS — яркое ядро. Здание блокирует свет без единого лишнего луча:
  // источник внутри здания пересекается с его контуром (не светит наружу),
  // снаружи — из него вычитаются все здания (не светит внутрь).
  // Направленный источник (Angle/Direction) режется своим сектором.
  const lightBands = (t) => {
    const dim = gridUnitsToWorld(grid, Math.max(t.light.dim || 0, t.light.bright || 0));
    const bright = gridUnitsToWorld(grid, t.light.bright || 0);
    const angle = t.light.angle || 0;
    const sector =
      angle > 0 && angle < 360 ? unionAll([quantizePoints(sectorPoints(t.x, t.y, dim, t.light.direction || 0, angle), quantum)]) : null;
    const home = buildings.length ? buildings.find((b) => pointInPolygon(t.x, t.y, b.points)) : null;
    const homeMulti = home ? unionAll([home.points]) : null;
    const bands = [];
    for (let k = 0; k <= LIGHT_STEPS; k++) {
      const radius = dim - (dim - bright) * (k / LIGHT_STEPS);
      const poly = radius > 0 ? ray(t.x, t.y, radius) : [];
      let multi = poly.length >= 3 ? unionAll([poly]) : [];
      if (sector && multi.length) multi = intersectMulti(multi, sector);
      if (homeMulti) multi = intersectMulti(multi, homeMulti);
      else if (buildingsMulti.length) multi = differenceMulti(multi, buildingsMulti);
      bands.push(multi);
    }
    return bands;
  };

  // Кэш полос по источникам: ключ — всё, от чего зависит геометрия, включая
  // стены В РАДИУСЕ источника. Сдвинули факел — пересчитали его один;
  // открыли дверь — только те, до кого она достаёт. Результаты — те же
  // объекты, что в прошлый раз, по ним cachedUnion узнаёт неизменившиеся.
  const prevLights = (memo && memo.lights) || new Map();
  const nextLights = new Map();
  const perLight = lightTokens.map((t) => {
    const reach = gridUnitsToWorld(grid, Math.max(t.light.dim || 0, t.light.bright || 0));
    const key = [
      quantum,
      grid && grid.size,
      grid && grid.unitsPerCell,
      t.x,
      t.y,
      t.light.bright || 0,
      t.light.dim || 0,
      t.light.angle || 0,
      t.light.direction || 0,
      nearWallsKey(lightWalls, t.x, t.y, reach),
      buildingsKey,
    ].join("|");
    let bands = nextLights.get(key) || prevLights.get(key);
    if (!bands) bands = lightBands(t);
    nextLights.set(key, bands);
    return { token: t, bands };
  });
  if (memo) memo.lights = nextLights;

  const prevUnions = memo && memo.unions;
  const unions = memo ? new Map() : null;
  const union = (slot, multis) => cachedUnion(prevUnions, unions, slot, multis);

  // zones — зоны тумана со своим светом (domain.FogArea.Light). Ложатся
  // ПОВЕРХ обычного расчёта в каждую полосу: "bright" — во все полосы
  // (ярко освещённое ядро без затухания), "dim" — только в самую дальнюю
  // (тускло, без ядра), "dark" — вычитается из всех (тьма гасит даже
  // глобальный свет и свет факелов). Вложенность полос (см. ringMultis:
  // subtractNested) это не ломает: во все полосы добавляется/вычитается
  // одно и то же, в одну лишнюю — только самая широкая.
  const zones = fogLightZones(scene, quantum);
  const applyZones = (multi, k) => {
    if (zones.bright.length) multi = unionMulti(multi, zones.bright);
    if (k === 0 && zones.dim.length) multi = unionMulti(multi, zones.dim);
    if (zones.dark.length && multi.length) multi = differenceMulti(multi, zones.dark);
    return multi;
  };
  // bandAt — «докуда достаёт свет», если каждому источнику урезать радиус с
  // dim до bright на долю k/LIGHT_STEPS. Радиус у каждого источника СВОЙ (у
  // факела и у костра затухание своей ширины), поэтому доля применяется к
  // каждому по отдельности, а объединяются уже готовые многоугольники.
  const bandAt = (k) => {
    if (globalLight === "bright") return applyZones(worldRect(w, h), k);
    if (globalLight === "dim") return applyZones(k === 0 ? worldRect(w, h) : [], k);
    return applyZones(union(`band${k}`, perLight.map((e) => e.bands[k])), k);
  };

  const bands = [];
  for (let k = 0; k <= LIGHT_STEPS; k++) bands.push(bandAt(k));

  // tints — цветные зоны, сгруппированные ПО ЦВЕТУ: два факела одного
  // оттенка объединяются в одну фигуру, иначе на их пересечении заливка
  // легла бы дважды и пятно вышло бы вдвое насыщеннее. Цвет заливает весь
  // тусклый радиус источника целиком — берём полосу k=0.
  const tints = [];
  if (globalLight !== "bright" && globalLight !== "dim") {
    const byColor = new Map();
    for (const { token, bands: own } of perLight) {
      const color = token.light.color;
      if (!color || !own[0].length) continue;
      if (!byColor.has(color)) byColor.set(color, []);
      byColor.get(color).push(own[0]);
    }
    for (const [color, multis] of byColor) {
      const multi = union(`tint:${color}`, multis);
      if (multi.length) tints.push({ color, multi });
    }
  }
  if (memo) memo.unions = unions;

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
  //
  // Разность здесь — subtractNested, а не differenceMulti: соседние полосы
  // вложены друг в друга построением (тот же источник, те же стены, меньше
  // радиус), а на такой паре честная булева разность и разваливалась чаще
  // всего — половина границы у полос совпадает точка-в-точку по стенам.
  // Полное обоснование и замеры — у самой subtractNested в light-geometry.js.
  const ringMultis = [];
  for (let k = 0; k < LIGHT_STEPS; k++) {
    const multi = subtractNested(bands[k], bands[k + 1]);
    if (multi.length) ringMultis.push({ level: k / LIGHT_STEPS, multi });
  }

  return { dimMulti: bands[0], ringMultis, tints };
}
