// combat-bar.js — верхний оверлей "чей сейчас ход", как в Foundry. Общий
// для всех трёх ролей (ДМ/игрок/TV) — заводится из vtt/index.js, сам решает,
// показываться ли (только когда трекер реально в бою, см. domain.CombatState.
// Active), сам вставляет себя в DOM (тот же приём, что side-menu.js/audio.js:
// страницам не нужна для этого никакая разметка).
//
// Порядок/имена/инициатива приходят уже отсортированными с сервера (см.
// internal/service/room.go: combatPayload) — здесь только рендер, никакой
// сортировки. HP/спасброски от смерти в payload попадают ДМ всегда, а
// игрокам/TV — только если ДМ включил общий переключатель "Настройки →
// показывать HP" (domain.CombatState.ShowHP, см. handleSetShowHP в
// pages/dm.js) — сервер в этом случае просто не кладёт hpCurrent/hpMax в
// payload, здесь проверяем cmb.hpMax != null и рисуем HP-бейдж рядом с
// именем (см. hpBadge). Редактирование HP по-прежнему живёт только в панели
// "Инициатива" (combat-panel.js), не в самом оверлее — тут только чтение.
// Единственное действие полосы у не-ДМ — клик по фишке бойца: открывает его
// карточку (статблок монстра у ДМ, лист СВОЕГО персонажа у игрока, см.
// combatant-card.js — права решаются там).
// BAR_H — единая высота всех "фишек" полосы (раунд/кнопки/карточки бойцов).
// Раньше кнопки хода (24px квадраты) и карточки бойцов (variable-height
// пилюли) были разной высоты — при align-items:center это не ломало
// раскладку по вертикали, но силуэт полосы получался неровным (кнопки ниже
// пилюль), из-за чего весь оверлей выглядел "криво". Теперь у всех детей
// bar одна и та же высота через явные min-height/height, а не "как влезет".
import { combatantCardTarget, combatantCardHint, openCombatantCard } from "../combatant-card.js";
import { icon } from "../icons.js";

const BAR_H = 32;
// MIN_FREE_W — ниже этого полосу не ужимаем: если панели съели почти всю
// ширину, пусть лучше немного зайдёт под них, чем схлопнется в точку.
const MIN_FREE_W = 240;

export function createCombatBar(ctx) {
  const bar = document.createElement("div");
  bar.style.cssText =
    "display:none;position:fixed;top:10px;transform:translateX(-50%);z-index:40;" +
    "align-items:center;gap:8px;height:" + BAR_H + "px;padding:0 10px;border-radius:" + (BAR_H / 2 + 2) + "px;" +
    "background:var(--glass-bg-strong,rgba(22,22,29,0.88));backdrop-filter:var(--glass-blur,blur(20px));" +
    "-webkit-backdrop-filter:var(--glass-blur,blur(20px));border:1px solid var(--glass-border,rgba(255,255,255,0.08));" +
    "box-shadow:var(--shadow-float,0 6px 20px rgba(0,0,0,0.5));" +
    "font:12px/1 sans-serif;color:#eee;box-sizing:border-box;overflow-x:auto;overflow-y:hidden;";
  document.body.appendChild(bar);

  const roundLabel = document.createElement("div");
  roundLabel.style.cssText =
    "flex:0 0 auto;display:flex;align-items:center;height:100%;font-weight:600;opacity:0.85;white-space:nowrap;";

  const divider = document.createElement("div");
  divider.style.cssText = "flex:0 0 auto;width:1px;height:60%;background:rgba(255,255,255,0.12);";

  const track = document.createElement("div");
  track.style.cssText = "display:flex;align-items:center;height:100%;gap:6px;";

  // roundBtn — общий вид для ◀/▶/✕: круглые, той же высоты BAR_H, что и
  // карточки бойцов (см. комментарий у BAR_H) — раньше это были угловатые
  // квадраты 6px-радиуса вперемешку с круглыми портретами, отсюда и
  // "неровный" вид.
  function roundBtn(iconHtml, title) {
    const b = document.createElement("button");
    b.type = "button";
    b.innerHTML = iconHtml;
    b.title = title;
    b.style.cssText =
      "flex:0 0 auto;width:26px;height:26px;border:none;border-radius:50%;background:rgba(255,255,255,0.1);" +
      "color:#eee;cursor:pointer;font-size:12px;line-height:1;padding:0;display:flex;align-items:center;justify-content:center;";
    b.onmouseenter = () => (b.style.background = "rgba(255,255,255,0.2)");
    b.onmouseleave = () => (b.style.background = "rgba(255,255,255,0.1)");
    return b;
  }

  let prevBtn = null;
  let nextBtn = null;
  let endBtn = null;
  if (ctx.isDM) {
    // Кнопки хода — только у ДМ: игроки/TV видят чистый read-only оверлей,
    // управление боем целиком через них или через панель "Инициатива".
    prevBtn = roundBtn(icon("chevron-left", { size: 13 }), "Предыдущий ход");
    nextBtn = roundBtn(icon("chevron-right", { size: 13 }), "Следующий ход");
    endBtn = roundBtn(icon("close", { size: 13 }), "Завершить бой");
    prevBtn.onclick = () => ctx.send({ type: "prev_turn" });
    nextBtn.onclick = () => ctx.send({ type: "next_turn" });
    endBtn.onclick = () => ctx.send({ type: "end_combat" });
    bar.append(roundLabel, prevBtn, divider.cloneNode(), track, nextBtn, endBtn);
  } else {
    bar.append(roundLabel, divider, track);
  }

  // pillLabel — только всплывающая подсказка при наведении (title), сама
  // инициатива на самой полосе не показывается (см. план: убрать показатель
  // инициативы из верхнего оверлея) — тут важен только порядок ходов и кто
  // ходит сейчас, цифра рядом с именем только шумела.
  function pillLabel(cmb) {
    return `${cmb.name} (иниц. ${cmb.initiative})`;
  }

  // hpBadge — компактная HP-плашка рядом с именем (см. комментарий в шапке
  // файла: сервер вообще не кладёт hpMax в payload, если бойцу его видеть не
  // положено — cmb.hpMax == null именно об этом сигнализирует). При
  // HPCurrent<=0 у ИГРОВОГО персонажа (characterId — у монстра/безликого
  // NPC спасбросков от смерти не бывает, сервер убирает его из инициативы
  // сразу, см. room.go: killMonsterCombatant) вместо числа показываем
  // отметки спасбросков от смерти — те же, что ДМ проставляет чекбоксами в
  // панели "Инициатива" (combat-panel.js), тут только read-only индикация.
  function hpBadge(cmb) {
    if (cmb.hpMax == null) return null;
    if ((cmb.hpCurrent || 0) <= 0 && cmb.characterId) {
      // Успехи и провалы — два ОТДЕЛЬНЫХ кластера точек с тонким
      // разделителем между ними (та же "палочка", что делит раунд/кнопки
      // хода в самом баре, см. divider выше) — раньше все 6 точек шли одним
      // сплошным рядом, и пока большинство ещё не отмечено (серые), понять,
      // где заканчиваются успехи и начинаются провалы, было невозможно на
      // глаз.
      const wrap = document.createElement("div");
      wrap.style.cssText = "flex:0 0 auto;display:flex;align-items:center;gap:5px;";
      wrap.title =
        `Спасброски от смерти: ${cmb.deathSaveSuccess || 0} усп. / ${cmb.deathSaveFail || 0} пров.`;
      const dot = (filled, color) => {
        const d = document.createElement("span");
        d.style.cssText =
          "width:6px;height:6px;border-radius:50%;background:" +
          (filled ? color : "rgba(255,255,255,0.18)") + ";";
        return d;
      };
      const cluster = (count, color) => {
        const c = document.createElement("div");
        c.style.cssText = "display:flex;align-items:center;gap:2px;";
        for (let i = 0; i < 3; i++) c.appendChild(dot(i < count, color));
        return c;
      };
      const sep = document.createElement("div");
      sep.style.cssText = "width:1px;height:8px;background:rgba(255,255,255,0.18);";
      wrap.append(cluster(cmb.deathSaveSuccess || 0, "#5fd08a"), sep, cluster(cmb.deathSaveFail || 0, "#e0645a"));
      return wrap;
    }
    const badge = document.createElement("span");
    const pct = cmb.hpMax > 0 ? cmb.hpCurrent / cmb.hpMax : 0;
    const color =
      cmb.hpCurrent <= 0 ? "#e0645a" : pct <= 0.25 ? "#e0985a" : pct <= 0.5 ? "#e0c95a" : "#5fd08a";
    badge.textContent = `${cmb.hpCurrent}/${cmb.hpMax}`;
    badge.style.cssText = `flex:0 0 auto;font-size:10px;font-weight:700;color:${color};white-space:nowrap;`;
    return badge;
  }

  function render(state) {
    if (!state || !state.active || !(state.combatants || []).length) {
      bar.style.display = "none";
      return;
    }
    bar.style.display = "flex";
    roundLabel.textContent = "Раунд " + (state.round || 1);
    track.innerHTML = "";
    for (const cmb of state.combatants) {
      const pill = document.createElement("div");
      const current = cmb.id === state.currentId;
      pill.title = pillLabel(cmb);
      pill.style.cssText =
        "flex:0 0 auto;display:flex;align-items:center;height:26px;box-sizing:border-box;gap:6px;" +
        "padding:0 10px 0 3px;border-radius:13px;white-space:nowrap;" +
        (current
          ? "background:rgba(93,208,255,0.22);box-shadow:0 0 0 1.5px #5dd0ff inset;"
          : "background:rgba(255,255,255,0.07);");

      const portrait = document.createElement("div");
      portrait.style.cssText =
        "flex:0 0 auto;width:20px;height:20px;border-radius:50%;background-size:cover;background-position:center;" +
        "box-shadow:0 0 0 1px rgba(255,255,255,0.15) inset;";
      if (cmb.image) portrait.style.backgroundImage = `url("${cmb.image}")`;
      else portrait.style.background = cmb.color || "#555";

      const name = document.createElement("span");
      name.textContent = cmb.name;
      name.style.cssText =
        "max-width:120px;overflow:hidden;text-overflow:ellipsis;line-height:26px;" + (current ? "font-weight:600;" : "");

      pill.append(portrait, name);
      const hp = hpBadge(cmb);
      if (hp) pill.appendChild(hp);

      // Клик по фишке — карточка бойца (статблок монстра у ДМ, лист своего
      // персонажа у игрока, см. combatant-card.js: права там же). Тот же
      // быстрый вход, что и в панели "Инициатива", только доступный, когда
      // панель закрыта или её вовсе нет (игрок/TV) — во время боя это
      // единственный список бойцов, который видно всем. У бойца без
      // карточки (или когда роль её видеть не должна) фишка остаётся
      // некликабельной: курсор ничего не обещает.
      const cardOpts = { isDM: ctx.isDM, playerId: ctx.playerId };
      if (combatantCardTarget(cmb, cardOpts)) {
        pill.style.cursor = "pointer";
        pill.title = `${pillLabel(cmb)} — ${combatantCardHint(cmb).toLowerCase()}`;
        // Куда именно ляжет карточка, решает страница (см. combatant-card.js:
        // setCardOpener): у ДМ и у игрока это боковая колонка у карты, а не
        // плавающее окно поверх неё.
        pill.onclick = () => openCombatantCard(cmb, cardOpts);
      }

      track.appendChild(pill);
    }
  }

  document.addEventListener("vtt:combatState", (e) => render(e.detail));

  // ---- где стоит сама полоса ----
  // Центр берём по СВОБОДНОЙ части карты, а не по окну. Слева от карты
  // лежат панели: у ДМ — рейл, панель рейла и колонка со статблоком (они
  // канвас не ужимают, а накрывают: #canvasWrap{position:absolute;inset:0}
  // в dm.html), у игрока — боковой док листа (этот как раз ужимает канвас,
  // и его видно по rect канваса). Поэтому слагаемых два: rect канваса плюс
  // отступ, о котором сообщает страница событием "vtt:chromeInset" (шлёт
  // pages/dm.js: updateChromeInset — тем же числом он двигает плашку
  // статуса). Без этого полоса центрировалась по всему окну и наезжала на
  // шапку колонки со статблоком.
  let leftInset = 0;
  function position() {
    const rect = ctx.canvas.getBoundingClientRect();
    const free = Math.max(MIN_FREE_W, rect.width - leftInset);
    bar.style.left = Math.round(rect.left + leftInset + free / 2) + "px";
    bar.style.maxWidth = Math.round(free - 24) + "px";
  }
  document.addEventListener("vtt:chromeInset", (e) => {
    leftInset = (e.detail && e.detail.left) || 0;
    position();
  });
  window.addEventListener("resize", position);
  // Канвас меняет размер и без ресайза окна (у игрока — открытый док листа),
  // тот же приём, что в side-menu.js.
  new ResizeObserver(position).observe(ctx.canvas);
  position();

  return { render };
}
