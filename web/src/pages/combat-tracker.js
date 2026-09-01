// combat-tracker.js — трекер инициативы как самостоятельная страница
// (открывается в плавающем окне через floating-window.js, см. pages/dm.js:
// "🗗 Открыть в окне", и может быть открыта напрямую по URL — тот же принцип,
// что и у note-window.html). Вся логика самой панели — в общем модуле
// combat-panel.js (там же встроенная панель ДМ-стола, см. pages/dm.js);
// здесь только: проверка, что это ДМ (fetchMe), свой собственный
// WS-клиент до /ws/dm (эта страница — отдельный iframe/окно, не имеет
// доступа к соединению основного стола) и подключение combat-panel.js к
// нему. Полноценный vtt/net.js сюда не тащим — канвас/сцена этой странице
// не нужны вообще, только сообщения "combat_state" в одну сторону и команды
// трекера в другую.
import { fetchMe } from "../api.js";
import { initCombatPanel } from "../combat-panel.js";
import { isGM } from "../roles.js";

(async function boot() {
  const me = await fetchMe();
  if (!me || !isGM(me.role)) {
    location.href = "/";
    return;
  }

  const wsScheme = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${wsScheme}//${location.host}/ws/dm`);

  // gotAny — пришло ли хоть одно сообщение: если соединение закрылось раньше
  // первого сообщения, это отказ на этапе хендшейка (сессия истекла/не ДМ),
  // а не обрыв уже рабочего сокета — тот же приём, что gotSnapshot в
  // web/src/vtt/net.js.
  let gotAny = false;
  ws.onclose = () => {
    if (!gotAny) document.getElementById("authFailedOverlay").classList.add("open");
  };
  ws.onmessage = (ev) => {
    gotAny = true;
    const data = JSON.parse(ev.data);
    if (data.type === "combat_state") {
      document.dispatchEvent(new CustomEvent("vtt:combatState", { detail: data }));
    }
    // snapshot/scene_list/player_list/roll_result/... — эта страница их не
    // рендерит, молча игнорируем (тот же сокет несёт все типы сообщений
    // комнаты, фильтрация только на приёме, не на подписке).
  };

  function send(msg) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  initCombatPanel({
    send,
    els: {
      startBtn: document.getElementById("combatStartBtn"),
      endBtn: document.getElementById("combatEndBtn"),
      roundRow: document.getElementById("combatRoundRow"),
      roundLabel: document.getElementById("combatRoundLabel"),
      prevBtn: document.getElementById("combatPrevBtn"),
      nextBtn: document.getElementById("combatNextBtn"),
      addBtn: document.getElementById("combatAddBtn"),
      searchWrap: document.getElementById("combatSearchWrap"),
      search: document.getElementById("combatSearch"),
      searchResults: document.getElementById("combatSearchResults"),
      list: document.getElementById("combatList"),
      // вкладки "Инициатива"/"Убитые" (см. combat-panel.js: switchCombatTab)
      tabTrackerBtn: document.getElementById("combatTabTrackerBtn"),
      tabKilledBtn: document.getElementById("combatTabKilledBtn"),
      trackerTab: document.getElementById("combatTrackerTab"),
      killedTab: document.getElementById("combatKilledTab"),
      killedList: document.getElementById("combatKilledList"),
      killedSummary: document.getElementById("combatKilledSummary"),
      killedClearBtn: document.getElementById("combatKilledClearBtn"),
    },
  });
})();
