import { Assets, Container, Graphics, Matrix, Sprite, Text, Texture } from "pixi.js";
import { isVideoUrl } from "../../geometry.js";
import { dashedCircle } from "../dash.js";
import { createVideoTexture } from "../video-texture.js";
import { gridUnitsToWorld } from "../light-geometry.js";

// Токены. В отличие от старого draw(), который каждый кадр
// заново рисовал ВСЕ токены с нуля, здесь — retained-mode: по одному
// PIXI.Container на токен, переиспользуется между обновлениями (позиция/
// арт/форма меняются точечно), пересоздаётся только когда токен реально
// появился/исчез (dirty.tokens, см. dirty.js). video-арт — тот же приём, что
// и видео-фон карты (layers/background.js): PIXI.Texture.from(videoEl), без
// офскрин-кэша последнего кадра — Pixi сам сэмплирует видео как живую
// GPU-текстуру.
//
// Круглый арт токена рисуется ЗАЛИВКОЙ Graphics-фигуры текстурой
// (graphics.circle(...).fill({texture, matrix})), а НЕ Sprite со
// stencil-маской (artSprite.mask = artMaskGraphics), как было сразу после
// переезда на PixiJS. Это не косметика, а обход конкретного бага:
// stencil-маска на скрытом (visible=false) Graphics оставляла GL_STENCIL_TEST
// включённым ПОСЛЕ кадра, в котором применялась, и это состояние переживало
// конец кадра — весь следующий кадр ЛЮБОЙ Sprite на канвасе отбрасывался
// stencil-тестом и не рисовался вообще. Больше всего это било по фону карты:
// он в z-order идёт ДО токенов, но ловил утечку из ПРЕДЫДУЩЕГО кадра, и
// карта (и картинка, и видео) была стабильно невидимой, хотя спрайт,
// текстура и transform были совершенно корректны — отладка показывала
// валидную текстуру с реальными пикселями видео и правильный размер/позицию
// на полностью прозрачном канвасе. Проверено: с textured-fill на Graphics
// (другой пайплайн, stencil не задействован вообще) фон рисуется, а
// GL_STENCIL_TEST после кадра остаётся выключенным.

export function createTokensLayer(ctx) {
  const tokensContainer = new Container();
  const container = new Container();
  container.addChild(tokensContainer);

  const tokenViews = new Map(); // id -> view

  // Видео-арт токенов: один <video> + одна PIXI.Texture на URL, разделяются
  // всеми токенами с одинаковым артом (толпа одинаковых монстров), как и
  // imageCache/getImage раньше делили один Image.
  const tokenVideoCache = new Map(); // url -> <video>
  const tokenTextureCache = new Map(); // url -> PIXI.Texture (и для видео, и для картинок — единообразно)
  // Кто сейчас показывает арт с этим url — нужно, чтобы досчитать текстуру
  // ВСЕМ токенам с этим артом, когда картинка догрузится асинхронно (см.
  // getTokenTexture: тот же баг, что и с фоном карты, см.
  // layers/background.js — Texture.from(url) не грузит картинку сам, только
  // смотрит в Assets.Cache).
  const tokenArtViews = new Map(); // url -> Set<view>

  function registerArtView(url, view) {
    let set = tokenArtViews.get(url);
    if (!set) {
      set = new Set();
      tokenArtViews.set(url, set);
    }
    set.add(view);
  }
  function unregisterArtView(url, view) {
    const set = tokenArtViews.get(url);
    if (!set) return;
    set.delete(view);
    if (set.size === 0) tokenArtViews.delete(url);
  }
  // drawArt — заливка artGfx текстурой: матрица переводит пиксели текстуры
  // в локальные координаты токена так, чтобы текстура растянулась ровно на
  // квадрат [-size,-size]..[size,size] (тот же результат, что раньше давал
  // artSprite.width=artSprite.height=size*2), после чего фигура (круг или
  // квадрат) вырезает нужную форму — обрезка тут часть самой заливки, а не
  // отдельная маска.
  function drawArt(view, size, shape, texture) {
    view.artSize = size;
    view.artShape = shape;
    const s = size * 2;
    const texW = texture.width || 1;
    const texH = texture.height || 1;
    const matrix = new Matrix(s / texW, 0, 0, s / texH, -size, -size);
    view.artGfx.clear();
    if (shape === "square") {
      view.artGfx.rect(-size, -size, s, s);
    } else {
      view.artGfx.circle(0, 0, size);
    }
    // textureSpace: "global" обязателен — по умолчанию Pixi ("local") сам
    // подгоняет UV под bounds фигуры поверх нашей matrix (ожидая матрицу в
    // нормализованных координатах, а не в пикселях текстуры), из-за чего UV
    // уезжали далеко за [0,1], а Pixi ещё и молча переключает addressMode
    // текстуры на "repeat" при первой заливке (см.
    // generateTextureFillMatrix.js) — итог: арт токена размножался плиткой
    // по всей фигуре вместо одной картинки. В "global" наша matrix (пиксели
    // текстуры -> локальные координаты токена) работает как и задумано.
    view.artGfx.fill({ texture, matrix, textureSpace: "global" });
  }

  // refreshArtViews — досчитывает заливку всем токенам с этим артом, когда
  // видео догрузило реальные размеры (source "resize") или картинка
  // наконец скачалась (Assets.load resolve) — до этого момента texture.width
  // могло быть 1×1 (плейсхолдер), и matrix в drawArt посчитан неверно.
  function refreshArtViews(url) {
    const tex = tokenTextureCache.get(url);
    refreshStatusSprites(url); // значки состояний с этим же URL — см. ниже
    const set = tokenArtViews.get(url);
    if (!tex || !set) return;
    for (const view of set) drawArt(view, view.artSize, view.artShape, tex);
  }

  // Значки состояний с собственной картинкой (domain.Condition.ImageURL)
  // грузятся тем же getTokenTexture, что и арт токена, — и ловят ту же
  // асинхронность: до конца загрузки в кэше лежит Texture.EMPTY. Арт токена
  // решает это через tokenArtViews + refreshArtViews (перерисовать заливку),
  // а значок — это обычный Sprite, ему достаточно переприсвоить .texture,
  // поэтому у него свой маленький реестр, а не общий с заливкой.
  const statusSprites = new Map(); // url -> Set<Sprite>

  function bindStatusSprite(sprite, url) {
    sprite.texture = getTokenTexture(url);
    let set = statusSprites.get(url);
    if (!set) {
      set = new Set();
      statusSprites.set(url, set);
    }
    set.add(sprite);
  }

  function refreshStatusSprites(url) {
    const tex = tokenTextureCache.get(url);
    const set = statusSprites.get(url);
    if (!tex || !set) return;
    for (const sprite of set) {
      // Значки пересоздаются на каждое обновление токена (см. drawStatuses),
      // так что в реестре копятся уже уничтоженные спрайты — вычищаем их
      // лениво здесь, а не заводим отдельный unregister на каждый рендер.
      if (sprite.destroyed) {
        set.delete(sprite);
        continue;
      }
      sprite.texture = tex;
      fitStatusSprite(sprite);
    }
    if (set.size === 0) statusSprites.delete(url);
  }

  // fitStatusSprite — вписать картинку значка в его кружок, сохранив
  // пропорции (у Sprite нет аналога drawArt с матрицей — ему просто задаём
  // размер).
  function fitStatusSprite(sprite) {
    const box = sprite.statusBox || 0;
    if (!box) return;
    const w = sprite.texture.width || 1;
    const h = sprite.texture.height || 1;
    const scale = box / Math.max(w, h);
    sprite.width = w * scale;
    sprite.height = h * scale;
  }

  // Восстановление после мёртвого декодера: Chrome сам ставит на паузу и
  // потом "suspend"-ит decoder pipeline давно неактивного фонового <video>
  // ради памяти — а для WebM VP8 с альфа-каналом (обычный формат токен-арта
  // с прозрачностью) resume после такого suspend'а надёжно ловит
  // PIPELINE_ERROR_DECODE и пайплайн навсегда остаётся "kStopped"
  // (воспроизведено и подтверждено через chrome://media-internals — перебор
  // DecryptingVideoDecoder → Dav1dVideoDecoder → FFmpegVideoDecoder, все
  // отваливаются, дальше decode-ошибка). Сам HTMLVideoElement после этого
  // мёртв необратимо — .play() на нём больше никогда не поднимет
  // воспроизведение, единственный выход пересоздать элемент с нуля.
  const lastRecoveryAt = new Map(); // url -> timestamp, анти-петля на случай реально битого файла

  function recoverTokenVideo(url) {
    const now = performance.now();
    const last = lastRecoveryAt.get(url) || 0;
    if (now - last < 3000) return; // тот же файл уже пересоздавали только что — не долбим сервер запросами
    lastRecoveryAt.set(url, now);

    const old = tokenVideoCache.get(url);
    if (old) {
      old.pause();
      old.removeAttribute("src");
      old.load();
    }
    tokenVideoCache.delete(url);
    tokenTextureCache.delete(url);
    getTokenTexture(url); // заново создаёт <video>, ждёт первый кадр, досчитывает все вьюхи с этим артом
  }

  function getTokenVideo(url) {
    let v = tokenVideoCache.get(url);
    if (!v) {
      v = document.createElement("video");
      v.loop = true;
      v.playsInline = true;
      v.preload = "auto";
      v.src = url;
      v.muted = !ctx.audioUnlocked; // новый токен сразу со звуком, если клиент уже разблокировал аудио ранее
      v.addEventListener("error", () => recoverTokenVideo(url));
      ctx.tryPlay(v);
      ctx.registerUnlockable(v);
      if (!ctx.audioUnlocked) ctx.showUnlockPrompt();
      tokenVideoCache.set(url, v);
    }
    return v;
  }

  // getTokenTexture — ВСЕГДА возвращает текстуру синхронно (может быть
  // временный Texture.EMPTY 1×1, пока настоящая картинка ещё грузится), но
  // никогда не блокирует и не роняет вызывающий код. Видео догружает размер
  // само по себе (see attachVideoResizeListener-подобный listener ниже);
  // картинку по URL Pixi сам НЕ грузит на Texture.from(строка) — грузим
  // явно через Assets.load и подставляем всем текущим вьюхам этого url,
  // когда она будет готова.
  function getTokenTexture(url) {
    let tex = tokenTextureCache.get(url);
    if (tex) return tex;
    if (isVideoUrl(url)) {
      // Видео-арт живёт по тому же правилу, что и видео-фон карты: отдать
      // <video> в Pixi ДО первого показанного кадра — значит навсегда
      // получить чёрную текстуру и поток
      // "GL_INVALID_OPERATION ... Level of detail outside of range" на каждый
      // кадр (разбор в ../video-texture.js). Поэтому до кадра держим
      // Texture.EMPTY — ровно как для ещё не скачавшейся картинки ниже, — а
      // потом подменяем и досчитываем заливку всем токенам с этим артом.
      tex = Texture.EMPTY;
      tokenTextureCache.set(url, tex);
      createVideoTexture(getTokenVideo(url), (loaded) => {
        tokenTextureCache.set(url, loaded);
        refreshArtViews(url);
      });
    } else {
      tex = Texture.EMPTY;
      tokenTextureCache.set(url, tex);
      Assets.load(url)
        .then((loaded) => {
          tokenTextureCache.set(url, loaded);
          refreshArtViews(url);
        })
        .catch((err) => console.error("не удалось загрузить арт токена:", url, err));
    }
    return tex;
  }

  function createTokenView() {
    const root = new Container();
    const colorGfx = new Graphics(); // заливка-фолбэк, когда у токена нет картинки/видео
    const artGfx = new Graphics(); // арт токена — текстурная заливка, см. drawArt()
    const hiddenOutline = new Graphics();
    const ownerRing = new Graphics();
    const lightRings = new Graphics();
    const lightIcon = new Text({ text: "💡", style: { fontSize: 20, fontFamily: "sans-serif", align: "center" } });
    lightIcon.anchor.set(0.5, 0.5);
    lightIcon.visible = false;
    // deadIcon — "кости" вместо арта/кружка, когда HP бойца в трекере
    // инициативы дошло до нуля (только у монстров/безликих NPC —
    // domain.Token.Dead, см. room.go: killMonsterCombatant). Тот же приём,
    // что и lightIcon: готовый эмодзи вместо картинки, никаких новых
    // ассетов заводить не нужно.
    const deadIcon = new Text({ text: "💀", style: { fontSize: 20, fontFamily: "sans-serif", align: "center" } });
    deadIcon.anchor.set(0.5, 0.5);
    deadIcon.visible = false;
    // lockIcon — замок в правом нижнем углу токена, когда объект заперт
    // (domain.Token.Locked, общий для всех объектов карты флаг — см.
    // web/src/vtt/map-objects.js). Виден только ДМ: игроку запертость
    // ничего не сообщает (он и так не двигает чужое), а ДМ по нему сразу
    // понимает, почему токен не берётся мышью. Тот же приём "готовый
    // эмодзи вместо ассета", что у lightIcon/deadIcon выше.
    const lockIcon = new Text({ text: "🔒", style: { fontSize: 12, fontFamily: "sans-serif", align: "center" } });
    lockIcon.anchor.set(0.5, 0.5);
    lockIcon.visible = false;
    const label = new Text({ text: "", style: { fill: 0xffffff, fontSize: 12, fontFamily: "sans-serif", align: "center" } });
    label.anchor.set(0.5, 0);
    // statusLayer — наложенные состояния (domain.AppliedStatus): значки-
    // кружки по верхней кромке токена плюс, если состояние помечено
    // Overlay, крупный глиф поверх самого арта — прямой аналог палитры и
    // overlay-иконки в Foundry. Отдельный Container, а не пачка полей вьюхи:
    // значков переменное число, они целиком пересоздаются при изменении
    // набора меток (это происходит только по dirty.tokens, не каждый кадр).
    const statusLayer = new Container();
    root.addChild(colorGfx, artGfx, lightIcon, deadIcon, lightRings, hiddenOutline, ownerRing, statusLayer, lockIcon, label);
    return { root, colorGfx, artGfx, hiddenOutline, ownerRing, lightRings, lightIcon, deadIcon, statusLayer, lockIcon, label, artUrl: null, artSize: 0, artShape: null };
  }

  // MAX_STATUS_BADGES — сколько значков рисуем в ряд, прежде чем свернуть
  // остальные в «+N»: больше пяти над токеном не читается, а прятать метки
  // совсем нельзя — по ним ДМ и игроки понимают, что происходит с целью.
  const MAX_STATUS_BADGES = 5;

  // drawStatuses — перерисовать значки состояний токена. Скрытые метки
  // (AppliedStatus.Hidden) сюда просто не доезжают: сервер вырезает их из
  // payload не-ДМ клиентам (см. room_statuses.go: publicToken), так что
  // фильтровать тут нечего — у ДМ они приходят и рисуются приглушённо.
  function drawStatuses(view, t, size) {
    view.statusLayer.removeChildren().forEach((child) => child.destroy({ children: true }));
    const statuses = t.statuses || [];
    if (statuses.length === 0 || t.lightOnly) return;

    // Overlay-состояние (окаменение/беспамятство) — крупный полупрозрачный
    // глиф поверх арта. Если их несколько, рисуем только первое: два
    // наложенных друг на друга глифа во весь токен нечитаемы.
    const overlay = statuses.find((st) => st.overlay);
    if (overlay && !t.dead) {
      const big = statusVisualNode(overlay, size * 1.5);
      big.alpha = 0.8;
      view.statusLayer.addChild(big);
    }

    const shown = statuses.slice(0, statuses.length > MAX_STATUS_BADGES ? MAX_STATUS_BADGES - 1 : MAX_STATUS_BADGES);
    const hiddenCount = statuses.length - shown.length;
    const total = shown.length + (hiddenCount > 0 ? 1 : 0);
    const r = Math.max(5, size * 0.26);
    const top = -size - r - 2;
    const startX = -(total - 1) * r;

    shown.forEach((st, i) => {
      const badge = new Container();
      badge.position.set(startX + i * 2 * r, top);
      const bg = new Graphics().circle(0, 0, r).fill({ color: 0x11111a, alpha: 0.85 });
      bg.stroke({ width: Math.max(1, r * 0.16), color: parseColor(st.color, 0x9aa0a6) });
      badge.addChild(bg, statusVisualNode(st, r * 1.5));
      if (st.level) {
        const lvl = new Text({
          text: String(st.level),
          style: { fill: 0xffffff, fontSize: Math.max(7, r * 0.85), fontFamily: "sans-serif", fontWeight: "bold" },
        });
        lvl.anchor.set(0.5, 0.5);
        lvl.position.set(r * 0.7, r * 0.7);
        badge.addChild(lvl);
      }
      if (st.hidden) badge.alpha = 0.55; // видит только ДМ — показываем это глазом
      view.statusLayer.addChild(badge);
    });

    if (hiddenCount > 0) {
      const badge = new Container();
      badge.position.set(startX + shown.length * 2 * r, top);
      const bg = new Graphics().circle(0, 0, r).fill({ color: 0x11111a, alpha: 0.85 });
      bg.stroke({ width: Math.max(1, r * 0.16), color: 0x9aa0a6 });
      const more = new Text({
        text: "+" + hiddenCount,
        style: { fill: 0xffffff, fontSize: Math.max(8, r), fontFamily: "sans-serif" },
      });
      more.anchor.set(0.5, 0.5);
      badge.addChild(bg, more);
      view.statusLayer.addChild(badge);
    }
  }

  // statusVisualNode — «картинка или глиф» одной метки, тот же контракт, что
  // и в HTML-палитре (web/src/status-palette.js: statusVisual): есть свой
  // арт — рисуем его, нет — эмодзи из карточки.
  function statusVisualNode(st, box) {
    if (st.imageUrl) {
      const sprite = new Sprite(Texture.EMPTY);
      sprite.anchor.set(0.5, 0.5);
      sprite.statusBox = box;
      bindStatusSprite(sprite, st.imageUrl);
      fitStatusSprite(sprite);
      return sprite;
    }
    const glyph = new Text({
      text: st.icon || "❔",
      style: { fontSize: box, fontFamily: "sans-serif", align: "center" },
    });
    glyph.anchor.set(0.5, 0.5);
    return glyph;
  }

  // parseColor — "#c0392b" из карточки состояния в число для Pixi. Цвет
  // приходит из пользовательской карточки, поэтому мусор не должен ронять
  // отрисовку — отдаём fallback.
  function parseColor(value, fallback) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(value || "").trim());
    return m ? parseInt(m[1], 16) : fallback;
  }

  function updateTokenView(view, id, t) {
    view.root.position.set(t.x, t.y);
    // lightOnly — "токен света" (см. domain.Token.LightOnly): полупрозрачная
    // иконка лампочки вместо обычной альфы hidden-токена.
    view.root.alpha = t.lightOnly ? 0.75 : ctx.isDM && t.hidden ? 0.45 : 1;

    const size = t.size || 20;
    const shape = t.shape === "square" ? "square" : "circle";
    view.deadIcon.visible = false; // включаем явно только в ветке t.dead ниже

    if (t.dead) {
      // Мёртвый монстр/NPC (см. domain.Token.Dead) — вместо арта/кружка/
      // лампочки только значок костей, тем же способом, что и lightIcon
      // ниже. Владельца/подсветку/лампочку света такому токену больше не
      // рисуем (нечего подсвечивать), подпись под ним оставляем — она и так
      // говорит, КТО умер.
      view.colorGfx.visible = false;
      if (view.artUrl) {
        unregisterArtView(view.artUrl, view);
        view.artUrl = null;
      }
      view.artGfx.clear();
      view.lightIcon.visible = false;
      view.deadIcon.visible = true;
      view.deadIcon.style.fontSize = Math.max(14, size * 1.6);
    } else if (t.lightOnly) {
      // Без арта/цветного кружка — только сама лампочка, жёлтая когда
      // источник включён, серая когда потушен (см. #tokenMenuLightToggleBtn
      // и dblclick в interaction.js).
      view.colorGfx.visible = false;
      if (view.artUrl) {
        unregisterArtView(view.artUrl, view);
        view.artUrl = null;
      }
      view.artGfx.clear();
      view.lightIcon.visible = true;
      view.lightIcon.style.fontSize = Math.max(14, size * 1.6);
      view.lightIcon.style.fill = t.light && t.light.enabled ? 0xffd54a : 0x8a8a95;
    } else if (t.image) {
      view.lightIcon.visible = false;
      view.colorGfx.visible = false;
      if (view.artUrl !== t.image) {
        if (view.artUrl) unregisterArtView(view.artUrl, view);
        view.artUrl = t.image;
        registerArtView(t.image, view);
      }
      // Перерисовывается на каждое обновление токена — дёшево (одна фигура
      // + заливка), а этот update() и так гоняется только по dirty.tokens
      // (см. вызов ниже), не на каждый кадр видео.
      drawArt(view, size, shape, getTokenTexture(t.image));
    } else {
      view.lightIcon.visible = false;
      if (view.artUrl) {
        unregisterArtView(view.artUrl, view);
        view.artUrl = null;
      }
      view.artGfx.clear();
      view.colorGfx.visible = true;
      view.colorGfx.clear().circle(0, 0, size).fill(t.color || "#e74c3c");
    }

    view.hiddenOutline.clear();
    if (ctx.isDM && t.hidden && !t.lightOnly) {
      dashedCircle(view.hiddenOutline, 0, 0, size, 3, 3);
      view.hiddenOutline.stroke({ width: 1, color: 0xffffff });
    }

    // Владелец токена: у ДМ тонкое белое кольцо на любом чужом токене, у
    // игрока — яркое зелёное, если это ЕГО токен. Проставляется один раз при
    // постановке персонажа из панели "Персонажи" (см. pages/dm.js), после
    // этого не редактируется отдельно. У токена света владельца не бывает.
    view.ownerRing.clear();
    if (t.ownerId && !t.lightOnly) {
      const mine = ctx.isPlayer && t.ownerId === ctx.playerId;
      const scale = ctx.world.scale.x || 1;
      view.ownerRing
        .circle(0, 0, size + 3)
        .stroke({ width: (mine ? 3 : 1.5) / scale, color: mine ? 0x2ecc71 : 0xffffff, alpha: mine ? 1 : 0.35 });
    }

    // Радиусы источника света — ориентир только для ДМ (как и линии стен,
    // layers/walls.js): сам эффект освещения игроки видят через
    // layers/vision-fog.js, а этот пунктир только помогает ДМ понять, куда
    // дотягивается свет, при расстановке/двигании токена. Token.Light.Bright/
    // Dim хранятся в единицах линейки сцены (фт), переводим в мировые
    // (пиксельные) через gridUnitsToWorld, как и vision-fog.js — масштабировать
    // под камеру не нужно — только толщину линии, как у ownerRing.
    view.lightRings.clear();
    if (ctx.isDM && t.light && t.light.enabled) {
      const scale = ctx.world.scale.x || 1;
      const dim = gridUnitsToWorld(ctx.scene.grid, t.light.dim || 0);
      const bright = gridUnitsToWorld(ctx.scene.grid, t.light.bright || 0);
      if (dim > 0) {
        dashedCircle(view.lightRings, 0, 0, dim, 6, 6);
        view.lightRings.stroke({ width: 1.5 / scale, color: 0xffcc66, alpha: 0.55 });
      }
      if (bright > 0) {
        dashedCircle(view.lightRings, 0, 0, bright, 6, 6);
        view.lightRings.stroke({ width: 1.5 / scale, color: 0xffe9b3, alpha: 0.85 });
      }
    }

    // Подпись под токеном света не нужна — она и так везде подписана как
    // "Источник света" в контекстном меню (см. dm.js), а на самой сцене её
    // роль и так однозначно читается по иконке лампочки.
    view.lockIcon.visible = !!(ctx.isDM && t.locked);
    if (view.lockIcon.visible) {
      view.lockIcon.style.fontSize = Math.max(10, size * 0.55);
      view.lockIcon.position.set(size * 0.7, size * 0.7);
    }

    view.label.text = t.lightOnly ? "" : t.label || "";
    view.label.position.set(0, size + 14);

    drawStatuses(view, t, size);
  }

  function syncMap(views, container, data, createView, updateView, onRemove) {
    for (const id of views.keys()) {
      if (!(id in data)) {
        if (onRemove) onRemove(views.get(id));
        views.get(id).root.destroy({ children: true });
        views.delete(id);
      }
    }
    for (const id in data) {
      let view = views.get(id);
      if (!view) {
        view = createView();
        views.set(id, view);
        container.addChild(view.root);
      }
      updateView(view, id, data[id]);
    }
  }

  function update() {
    if (!ctx.dirty.tokens) return;
    // На экране игрока/TV сам маркер токена света не рисуется вообще —
    // требование "н экране игрока токен не отображается, но освещение от
    // него работает". Токен НЕ помечен Token.Hidden (иначе сервер вырезал
    // бы его из PublicScene целиком, см. domain.Token.LightOnly — и тогда
    // клиенту игрока/TV нечем было бы посчитать освещение в
    // layers/vision-fog.js), поэтому фильтруем его только тут, на отрисовке.
    const tokenData = ctx.isDM
      ? ctx.scene.tokens || {}
      : Object.fromEntries(Object.entries(ctx.scene.tokens || {}).filter(([, t]) => !t.lightOnly));
    syncMap(tokenViews, tokensContainer, tokenData, createTokenView, updateTokenView, (view) => {
      // Токен исчез из сцены — не оставляем в tokenArtViews ссылку на
      // сейчас уничтожаемую вьюху, иначе refreshArtViews() позже попробует
      // выставить .texture на destroyed-спрайт.
      if (view.artUrl) unregisterArtView(view.artUrl, view);
    });
  }

  return { container, update };
}
