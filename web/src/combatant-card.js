// combatant-card.js — "открыть карточку бойца" прямо из инициативы: общий
// кусок для панели трекера (combat-panel.js) и верхнего оверлея хода
// (vtt/combat-bar.js). В Foundry статблок существа открывается из самой
// строки трекера (двойной клик по бойцу), а не через отдельный поиск по
// бестиарию — тут то же самое: боец помнит, из чего он сделан (monsterId —
// статблок бестиария, characterId — лист игрока, см. combatPayload в
// internal/service/room.go), отсюда и адрес карточки.
//
// Боец без monsterId/characterId (безымянный токен, заведённый в инициативу
// прямо с карты) карточки не имеет — combatantCardTarget вернёт null, и
// зовущий тогда просто не вешает клик: пустая ссылка хуже её отсутствия.
import { openCardWindow } from "./floating-window.js";

// combatantCardTarget — {key, title, url} для openCardWindow или null.
//
// Права проверяем ЗДЕСЬ, а не на клике: бестиарий отдаётся только ДМ
// (/api/bestiary → 403 игроку, см. requireAdminAccount), а чужой лист
// персонажа — только его владельцу. Показать игроку ссылку, которая
// откроет окно с ошибкой, — хуже, чем не показать её вовсе. Поэтому
// вызывающий передаёт свою роль: панель трекера — ДМ-only (isDM: true),
// оверлей хода живёт у всех трёх ролей и передаёт ещё и playerId (то же
// сравнение с ownerId, что и у "своих" токенов, см. vtt/layers/tokens.js).
export function combatantCardTarget(cmb, { isDM = false, playerId = "" } = {}) {
  if (!cmb) return null;
  if (cmb.characterId && (isDM || (playerId && cmb.ownerId === playerId))) {
    return { key: "char-" + cmb.characterId, title: cmb.name, url: `/character-sheet.html?id=${cmb.characterId}` };
  }
  if (cmb.monsterId && isDM) {
    return { key: "monster-" + cmb.monsterId, title: cmb.name, url: `/bestiary.html?id=${cmb.monsterId}` };
  }
  return null;
}

// cardHint — подпись для title-подсказки: что именно откроется. Отдельной
// функцией, чтобы панель и оверлей говорили одно и то же.
export function combatantCardHint(cmb) {
  return cmb && cmb.characterId ? "Открыть лист персонажа" : "Открыть статблок";
}

// setCardOpener — хост-страница может перехватить открытие и показать
// карточку по-своему. Так делает ДМ-стол (pages/dm.js): у него сбоку от
// карты есть колонка-док (sheet-dock.js), в которой статблок висит весь бой
// и не надо таскать окно, — а плавающее окно остаётся вторым способом
// (кнопка ⧉ в шапке дока). Без перехвата открывается плавающее окно —
// поведение самого Foundry.
let cardOpener = null;
export function setCardOpener(fn) {
  cardOpener = fn;
}

// openCombatantCard — открыть карточку, если она есть. Возвращает false,
// если у бойца её нет (или роль не позволяет) — вызывающий сам решает, что
// с этим делать (обычно ничего).
export function openCombatantCard(cmb, opts) {
  const target = combatantCardTarget(cmb, opts);
  if (!target) return false;
  if (cardOpener) {
    cardOpener(target, cmb);
  } else if (window.parent && window.parent !== window) {
    // Трекер, вынесенный в плавающее окно (combat-tracker.html в iframe):
    // своего дока у него нет, а у родителя есть — просим открыть там, иначе
    // карточка вставала бы внутрь узкого окна трекера. Единственный, кто
    // встраивает эту страницу, — dm.html, и он это сообщение слушает (см.
    // pages/dm.js). Вынесенный в ОТДЕЛЬНОЕ окно браузера трекер сюда не
    // попадёт: там window.parent === window, и ниже откроется своё
    // плавающее окно.
    window.parent.postMessage({ type: "beacon:openCombatantCard", ...target }, location.origin);
  } else {
    openCardWindow(target);
  }
  return true;
}
