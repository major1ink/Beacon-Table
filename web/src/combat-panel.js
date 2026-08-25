// combat-panel.js — вся логика панели "Трекер инициативы": список бойцов
// (портрет/имя/Иниц./КД/HP, правка вручную, удаление), поиск по бестиарию
// для "+", кнопки старта/раундов/хода, быстрый переход в карточку бойца по
// клику на портрет/имя (см. combatant-card.js). Общий модуль для встроенной панели
// ДМ-стола (pages/dm.js, раздел рейла "🎯") и вынесенного плавающего окна
// (combat-tracker.html/pages/combat-tracker.js, см. floating-window.js) —
// обе страницы держат одинаковую разметку/CSS (секция "Трекер инициативы" в
// dm.html и её копия в combat-tracker.html), сюда передаются только уже
// найденные DOM-узлы (els) и функция отправки WS-команд (send) — сама
// логика не знает и не должна знать, какая именно страница её вызвала.
//
// Состояние трекера целиком приходит с сервера через "combat_state" (см.
// internal/service/room.go: combatPayload, web/src/vtt/net.js) — уже
// отсортированное по инициативе, HP/КД включены только у ДМ (см. план).
// Этот модуль ничего не считает сам, только шлёт команды и перерисовывается
// по каждому document-событию "vtt:combatState" — событие дожидается либо
// от полноценного vtt/net.js (встроенная панель), либо от собственного
// мини-WS-клиента плавающего окна (см. pages/combat-tracker.js) — оба
// диспатчат его в одном и том же формате, откуда взято неважно.
import { fetchBestiary, fetchAdminCharacters } from "./api.js";
import { openActionsPeek, closeActionsPeek } from "./combat-actions-peek.js";
import { icon } from "./icons.js";
import { combatantCardTarget, combatantCardHint, openCombatantCard } from "./combatant-card.js";
import { renderStatusChips, openStatusPalette, refreshStatusPalette } from "./status-palette.js";

// FOLLOW_KEY — режим "статблок следует за ходом" переживает перезагрузку
// страницы: это настройка привычки ДМ, а не состояние конкретного боя.
const FOLLOW_KEY = "beacon:combatFollowTurn";

export function initCombatPanel({ send, els }) {
  let latestCombat = { active: false, round: 0, currentId: "", combatants: [] };
  // searchList — кэш последнего поиска "+ Добавить": монстры бестиария и
  // персонажи ВСЕХ игроков вперемешку, своя копия, не общая с панелями
  // "Бестиарий"/"Персонажи". kind различает, что слать в add_combatant —
  // monsterId или characterId (см. domain.ClientMsg/room.go: handleAddCombatant,
  // третий источник — карточка игрока напрямую, без токена на карте).
  let searchList = [];

  function renderPanel() {
    els.startBtn.style.display = latestCombat.active ? "none" : "flex";
    els.startBtn.disabled = latestCombat.combatants.length === 0;
    els.endBtn.style.display = latestCombat.active ? "flex" : "none";
    els.roundRow.style.display = latestCombat.active ? "flex" : "none";
    els.roundLabel.textContent = "Раунд " + (latestCombat.round || 1);

    els.list.innerHTML = "";
    if (latestCombat.combatants.length === 0) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "Пока никого — добавь через «+ Добавить» ниже (монстра или персонажа игрока) или ПКМ на токене на карте.";
      els.list.appendChild(empty);
      return;
    }
    for (const cmb of latestCombat.combatants) {
      const row = document.createElement("div");
      row.className = "combat-row" + (cmb.id === latestCombat.currentId ? " current" : "");

      // Перетащить карточку на карту — актуально только для бойца БЕЗ
      // токена (добавлен через "+ Добавить из бестиария", см. ниже) — у
      // него ещё нет фигурки на сцене. Боец, у которого tokenId уже есть
      // (добавлен через ПКМ на существующем токене карты), тянуть некуда —
      // второй токен на него не заводим (см. room.go:
      // handlePlaceCombatantToken), поэтому строка тогда не draggable —
      // курсор не обещает того, что не сработает.
      const draggable = !cmb.tokenId;
      row.draggable = draggable;
      if (draggable) {
        row.title = "Перетащи на карту, чтобы поставить токен";
        row.addEventListener("dragstart", (e) => {
          e.dataTransfer.setData("application/x-beacon-combatant", cmb.id);
          e.dataTransfer.effectAllowed = "copy";
        });
      }

      // ---- шапка: (хватка) портрет, имя, удалить ----
      const top = document.createElement("div");
      top.className = "combat-row-top";

      const avatar = document.createElement("div");
      avatar.className = "combat-avatar";
      if (cmb.image) avatar.style.backgroundImage = `url("${cmb.image}")`;
      else avatar.style.background = cmb.color || "#555";

      const name = document.createElement("div");
      name.className = "combat-name";
      name.textContent = cmb.name;
      name.title = cmb.name;

      // Быстрый вход в карточку бойца прямо из инициативы — то, ради чего
      // в Foundry делают двойной клик по строке трекера: во время боя
      // статблок нужен постоянно ("а что у него за реакция?"), и идти за
      // ним через отдельный поиск по бестиарию слишком долго. Кликается
      // портрет и имя, двойной клик по всей карточке — для привычки тех,
      // кто пришёл из Foundry. Панель трекера открыта только ДМ (встроенная
      // — раздел рейла dm.html, вынесенная — combat-tracker.js проверяет
      // роль на входе), поэтому isDM: true.
      const card = combatantCardTarget(cmb, { isDM: true });
      if (card) {
        const hint = `${combatantCardHint(cmb)} — «${cmb.name}»`;
        for (const el of [avatar, name]) {
          el.classList.add("combat-card-link");
          el.title = hint;
          el.onclick = () => openCombatantCard(cmb, { isDM: true });
        }
        row.addEventListener("dblclick", (e) => {
          // Инпуты/кнопки исключаем: двойной клик по числу выделяет его —
          // открывать при этом ещё и окно человек точно не просил.
          if (e.target.closest("input, button")) return;
          openCombatantCard(cmb, { isDM: true });
        });
      }

      // "Действия" — компактный попап с боевыми блоками статблока прямо у
      // строки (см. combat-actions-peek.js): посреди чужого хода нужно
      // "чем он бьёт", а не весь статблок. Только у монстра: у игрового
      // персонажа боевые блоки живут не в статблоке, а на его бланке —
      // туда ведёт клик по имени.
      let peekBtn = null;
      if (cmb.monsterId) {
        peekBtn = document.createElement("button");
        peekBtn.className = "combat-peek";
        peekBtn.innerHTML = icon("sword", { size: 12 });
        peekBtn.title = "Действия и реакции — быстрый взгляд";
        peekBtn.onclick = (e) => openActionsPeek({ x: e.clientX, y: e.clientY, combatant: cmb, send });
      }

      const removeBtn = document.createElement("button");
      removeBtn.className = "combat-remove";
      removeBtn.innerHTML = icon("close", { size: 11 });
      removeBtn.title = "Убрать из инициативы";
      removeBtn.onclick = () => send({ type: "remove_combatant", combatantId: cmb.id });

      if (draggable) {
        const handle = document.createElement("span");
        handle.className = "drag-handle";
        handle.innerHTML = icon("grip-vertical", { size: 14 });
        top.appendChild(handle);
      }
      top.append(avatar, name);
      if (peekBtn) top.appendChild(peekBtn);
      top.appendChild(removeBtn);

      // ---- ряд подписанных характеристик: Иниц. / КД / HP ----
      // stat(label, content) — подписанное поле: маленькая подпись сверху,
      // сам инпут снизу — так на карточке видно, что есть что, а не голый
      // ряд из ничем не подписанных чисел.
      function stat(label, content) {
        const wrap = document.createElement("label");
        wrap.className = "combat-stat";
        const l = document.createElement("span");
        l.className = "combat-stat-label";
        l.textContent = label;
        wrap.append(l, content);
        return wrap;
      }

      const initInput = document.createElement("input");
      initInput.type = "number";
      initInput.step = "any";
      initInput.className = "combat-init";
      initInput.title = "Инициатива — правка вручную, без переброски";
      initInput.value = cmb.initiative;
      initInput.onchange = () => {
        const v = parseFloat(initInput.value);
        if (Number.isNaN(v)) {
          initInput.value = cmb.initiative;
          return;
        }
        send({ type: "set_combatant_initiative", combatantId: cmb.id, initiative: v });
      };

      const acInput = document.createElement("input");
      acInput.type = "number";
      acInput.min = "0";
      acInput.className = "combat-ac";
      // В поле — БАЗОВЫЙ КД (его ДМ и правит), а если состояния его меняют
      // (см. domain.Modifier), сервер присылает ещё и acEffective —
      // показываем разницу подписью рядом, а не подменяем число в поле,
      // иначе правка затирала бы базу результатом.
      acInput.title = "Класс доспеха";
      acInput.value = cmb.ac ?? 0;
      acInput.onchange = () => {
        const v = parseInt(acInput.value, 10);
        if (Number.isNaN(v)) {
          acInput.value = cmb.ac ?? 0;
          return;
        }
        send({ type: "set_combatant_ac", combatantId: cmb.id, ac: v });
      };

      const hpCurInput = document.createElement("input");
      hpCurInput.type = "number";
      hpCurInput.title = "Текущее HP";
      hpCurInput.value = cmb.hpCurrent ?? 0;
      const hpSep = document.createElement("span");
      hpSep.className = "combat-hp-sep";
      hpSep.textContent = "/";
      const hpMaxInput = document.createElement("input");
      hpMaxInput.type = "number";
      hpMaxInput.title = "Максимум HP";
      hpMaxInput.value = cmb.hpMax ?? 0;
      const sendHp = () => {
        const cur = parseInt(hpCurInput.value, 10);
        const max = parseInt(hpMaxInput.value, 10);
        send({
          type: "set_combatant_hp",
          combatantId: cmb.id,
          hpCurrent: Number.isNaN(cur) ? undefined : cur,
          hpMax: Number.isNaN(max) ? undefined : max,
        });
      };
      hpCurInput.onchange = sendHp;
      hpMaxInput.onchange = sendHp;
      const hpGroup = document.createElement("div");
      hpGroup.className = "combat-hp-group";
      hpGroup.append(hpCurInput, hpSep, hpMaxInput);

      // acWrap — поле КД плюс, если состояния его меняют, стрелка с
      // эффективным значением («14 → 12»).
      const acWrap = document.createElement("div");
      acWrap.className = "combat-ac-group";
      acWrap.appendChild(acInput);
      if (cmb.acEffective !== undefined && cmb.acEffective !== cmb.ac) {
        const eff = document.createElement("span");
        eff.className = "combat-ac-eff";
        eff.textContent = "→ " + cmb.acEffective;
        eff.title = "КД с учётом наложенных состояний";
        acWrap.appendChild(eff);
      }

      const stats = document.createElement("div");
      stats.className = "combat-row-stats";
      stats.append(stat("Иниц.", initInput), stat("КД", acWrap), stat("HP", hpGroup));

      row.append(top, stats);

      // ---- наложенные состояния (см. domain.AppliedStatus) ----
      // Метки приходят в combat_state уже разрешёнными: если за бойцом стоит
      // токен, сервер отдаёт метки ТОКЕНА (см. room_statuses.go: statusesOf)
      // — панель ничего не сводит сама и не знает, где они физически лежат.
      // "+" открывает ту же палитру, что и ПКМ-меню токена на карте.
      const statusRow = document.createElement("div");
      statusRow.className = "combat-row-statuses";
      statusRow.appendChild(
        renderStatusChips(cmb.statuses || [], {
          addTitle: "Наложить состояние",
          onAdd: (e) =>
            openStatusPalette({
              x: e.clientX,
              y: e.clientY,
              target: { combatantId: cmb.id },
              send,
              title: cmb.name,
              // Функция, а не готовый массив: пока палитра открыта, придёт
              // ещё несколько combat_state, и читать метки надо в момент
              // отрисовки (см. комментарий в status-palette.js).
              statusesFor: () => {
                const fresh = latestCombat.combatants.find((c) => c.id === cmb.id);
                return (fresh && fresh.statuses) || [];
              },
            }),
          onRemove: (st) => send({ type: "remove_status", combatantId: cmb.id, statusSlug: st.slug }),
        })
      );
      row.appendChild(statusRow);

      // ---- спасброски от смерти — только у игрового персонажа (characterId)
      // с HP<=0. У монстра/безликого NPC (нет characterId) спасбросков не
      // бывает — сервер убирает его из инициативы сразу, как только HP
      // достигает нуля (см. room.go: killMonsterCombatant), так что строка
      // тут для него просто никогда не появится. ДМ отмечает чекбоксы
      // руками, как в Foundry (см. bulbRow на бланке персонажа,
      // character-sheet.js) — клик по крайнему заполненному гасит его,
      // иначе заполняет по эту включительно; 3 провала сервер сам уберёт
      // бойца из инициативы (требование "провалены спасброски — убрать из
      // инициативы").
      if ((cmb.hpCurrent ?? 0) <= 0 && cmb.characterId) {
        row.appendChild(deathSaveRow(cmb, send));
      }

      els.list.appendChild(row);
    }
  }

  // ---- "Следовать за ходом" ----
  // Держать перед глазами действия того, чей сейчас ход: тот же компактный
  // попап, что открывает кнопка ⚔ в строке (см. combat-actions-peek.js), но
  // закреплённый в углу карты — он сам переезжает на следующего бойца и не
  // закрывается кликом мимо. В Foundry это делают руками, открывая и
  // закрывая лист очередного монстра.
  //
  // Полная карточка отсюда не открывается специально: она заметно больше и
  // лезет на карту, а посреди боя нужны три строки про атаки. Нужен весь
  // статблок — кнопка ⤢ в шапке попапа.
  //
  // Кнопка есть только у встроенной панели ДМ-стола (её узел передаёт
  // dm.html), в вынесенном окне трекера её нет: попап открывался бы внутри
  // этого окна, а не поверх карты.
  let followTurn = !!els.followBtn && localStorage.getItem(FOLLOW_KEY) === "1";
  let followedId = ""; // чей статблок уже показан — чтобы не дёргать док на каждый combat_state

  function renderFollowBtn() {
    if (!els.followBtn) return;
    els.followBtn.classList.toggle("active", followTurn);
    els.followBtn.title = followTurn
      ? "Действия следуют за ходом — выключить"
      : "Показывать действия того, чей сейчас ход";
  }

  function syncFollow() {
    if (!followTurn) return;
    if (!latestCombat.active) {
      followedId = ""; // бой кончился — следующий начнём с чистого листа
      closeActionsPeek();
      return;
    }
    const current = latestCombat.combatants.find((c) => c.id === latestCombat.currentId);
    if (!current || current.id === followedId) return;
    // Ход отмечаем пройденным в любом случае, даже если показывать нечего:
    // иначе на каждый следующий combat_state этого же хода мы пытались бы
    // открыть попап заново.
    followedId = current.id;
    // Ход игрока — статблока нет и быть не может (его действия у него на
    // бланке): гасим попап, а не оставляем висеть чужого монстра.
    if (current.monsterId) openActionsPeek({ combatant: current, send, pinned: true });
    else closeActionsPeek();
  }

  if (els.followBtn) {
    els.followBtn.onclick = () => {
      followTurn = !followTurn;
      localStorage.setItem(FOLLOW_KEY, followTurn ? "1" : "0");
      renderFollowBtn();
      followedId = ""; // включили посреди боя — показать текущего сразу, не дожидаясь следующего хода
      if (followTurn) syncFollow();
      else closeActionsPeek();
    };
    renderFollowBtn();
  }

  document.addEventListener("vtt:combatState", (e) => {
    latestCombat = e.detail;
    renderPanel();
    syncFollow();
    // Палитра состояний, если она сейчас открыта, живёт вне этой панели
    // (document.body) — её надо перерисовать отдельно, иначе после наложения
    // метки ячейка не подсветится до следующего открытия.
    refreshStatusPalette();
  });

  els.startBtn.onclick = () => send({ type: "start_combat" });
  els.endBtn.onclick = () => send({ type: "end_combat" });
  els.prevBtn.onclick = () => send({ type: "prev_turn" });
  els.nextBtn.onclick = () => send({ type: "next_turn" });

  // "+ Добавить" — раскрывает поиск (при вводе ищет по бестиарию И по
  // персонажам всех игроков разом, см. searchList выше); пустое поле — без
  // результатов, чтобы не вываливать сразу весь список. Список НЕ
  // закрывается после выбора — так удобнее наштамповать сразу несколько
  // одинаковых монстров (клик-клик-клик), уникальные имена "Гоблин
  // 2"/"Гоблин 3" сервер проставляет сам (см. Room.uniqueCombatantName).
  //
  // Оба списка тянем заново при каждом открытии (а не кэшируем между
  // открытиями) — тем же принципом, что и раньше был у одного бестиария:
  // ДМ мог поправить лист персонажа/статблок в соседнем окне, не закрывая
  // трекер.
  els.addBtn.onclick = async () => {
    const opening = els.searchWrap.style.display === "none";
    els.searchWrap.style.display = opening ? "block" : "none";
    if (!opening) return;
    els.search.value = "";
    els.searchResults.innerHTML = "";
    try {
      const [monsters, characters] = await Promise.all([fetchBestiary(), fetchAdminCharacters()]);
      searchList = [
        ...monsters.map((m) => ({
          kind: "monster",
          id: m.id,
          name: m.name,
          image: m.imageUrl,
          tags: [m.type, ...(m.tags || [])],
        })),
        ...characters.map((c) => ({
          kind: "character",
          id: c.id,
          name: c.name,
          image: c.avatarUrl,
          owner: c.accountUsername,
          tags: [c.accountUsername],
        })),
      ];
    } catch (err) {
      const errEl = document.createElement("p");
      errEl.className = "hint";
      errEl.textContent = "Ошибка: " + err.message;
      els.searchResults.appendChild(errEl);
      return;
    }
    renderSearchResults();
    els.search.focus();
  };

  function renderSearchResults() {
    const filter = els.search.value.trim().toLowerCase();
    els.searchResults.innerHTML = "";
    if (!filter) return;
    const filtered = searchList
      .filter((m) => [m.name, ...(m.tags || [])].join(" ").toLowerCase().includes(filter))
      .slice(0, 20);
    if (filtered.length === 0) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "Ничего не найдено.";
      els.searchResults.appendChild(empty);
      return;
    }
    for (const m of filtered) {
      const row = document.createElement("div");
      row.className = "combat-search-row";
      const avatar = document.createElement("div");
      avatar.className = "combat-avatar";
      if (m.image) avatar.style.backgroundImage = `url("${m.image}")`;
      else avatar.style.background = "#555";
      const name = document.createElement("div");
      name.className = "combat-name";
      name.textContent = m.name;
      // Персонажа помечаем именем владельца — иначе в общем списке с
      // монстрами непонятно, что это игрок, а не NPC.
      if (m.kind === "character") {
        name.textContent += m.owner ? ` (игрок: ${m.owner})` : " (игрок)";
        name.title = m.name;
      }
      row.append(avatar, name);
      row.onclick = () =>
        send(
          m.kind === "character" ? { type: "add_combatant", characterId: m.id } : { type: "add_combatant", monsterId: m.id }
        );
      els.searchResults.appendChild(row);
    }
  }
  els.search.oninput = renderSearchResults;

  renderPanel(); // начальный (пустой) рендер — до первого "combat_state" с сервера
}

// deathSaveRow — блок "Спасброски от смерти" под карточкой бойца: общий
// заголовок по центру, под ним рядом две колонки "успехи"/"провалы", у
// каждой — своя подпись ПРЯМО НАД своими чекбоксами-"лампами" (раньше
// подпись успехов была слитно с заголовком — "Спасброски — успехи" против
// голого "провалы", из-за чего колонки визуально не читались как пара).
// bulbGroup — тот же click-до-этого-индекса-включительно приём, что и
// bulbRow на бланке персонажа (character-sheet.js), но свой маленький
// вариант тут: там правится sheet.combat.* локально в открытом листе и
// шлётся save-запросом, здесь — сразу WS-командой на сервер, который и
// держит истину (cmb.deathSaveSuccess/Fail, domain.Combatant).
function deathSaveRow(cmb, send) {
  function bulbGroup(label, kind, value) {
    const wrap = document.createElement("div");
    wrap.className = "combat-death-group";
    const l = document.createElement("span");
    l.className = "combat-stat-label";
    l.textContent = label;
    const bulbs = document.createElement("div");
    bulbs.className = "bulb-row";
    for (let i = 0; i < 3; i++) {
      const filled = i < value;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "bulb" + (filled ? " filled" + (kind === "fail" ? " fail" : "") : "");
      b.title = String(i + 1);
      b.onclick = () => {
        send({
          type: "set_combatant_death_save",
          combatantId: cmb.id,
          deathSaveKind: kind,
          deathSaveValue: value > i ? i : i + 1,
        });
      };
      bulbs.appendChild(b);
    }
    wrap.append(l, bulbs);
    return wrap;
  }

  const title = document.createElement("div");
  title.className = "combat-death-title";
  title.textContent = "Спасброски от смерти";

  const groups = document.createElement("div");
  groups.className = "combat-death-groups";
  groups.append(bulbGroup("успехи", "success", cmb.deathSaveSuccess ?? 0), bulbGroup("провалы", "fail", cmb.deathSaveFail ?? 0));

  const row = document.createElement("div");
  row.className = "combat-death-row";
  row.append(title, groups);
  return row;
}
