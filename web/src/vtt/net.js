import { DEFAULT_WORLD_W, DEFAULT_WORLD_H } from "./camera.js";
import { diffAndMarkDirty } from "./dirty.js";

// WS-подключение + диспетчер сообщений — перенос ws.onmessage из
// static/js/app.js. Протокол и набор кастомных DOM-событий (vtt:*) не
// меняются ни на бит — только то, что происходит ПОСЛЕ получения snapshot,
// поменялось: вместо немедленного draw() теперь диффим сцену против
// предыдущей (diffAndMarkDirty) и просим ctx.render() обновить только
// реально изменившиеся слои Pixi (см. dirty.js — корневой фикс краша).
//
// protocol-aware: если страницу отдают по HTTPS (реверс-прокси для доступа
// через интернет, см. README), WS обязан идти по wss:// — иначе браузер
// блокирует его как mixed content. Никаких query-параметров — браузер сам
// прикладывает cookie сессии (beacon_session) к WS-хендшейку на том же
// origin, роль и личность сервер резолвит из неё.
export function createNet(ctx, audio) {
  ctx.scene = {
    width: DEFAULT_WORLD_W,
    height: DEFAULT_WORLD_H,
    mapUrl: "",
    grid: { size: 0, offsetX: 0, offsetY: 0 },
    tokens: {},
    hidden: {},
    walls: {},
    fogAreas: {},
    buildings: {},
  };
  ctx.clockOffsetMs = 0;
  // now() — время сервера с поправкой на рассинхрон часов ЭТОГО клиента:
  // serverNow (из snapshot/audio_cue) минус Date.now() в момент получения.
  // Без этого два клиента с разведёнными системными часами (нормальная
  // ситуация для ноутбуков/телефонов) слышали/видели бы разные моменты
  // одного и того же трека/видео.
  ctx.now = () => Date.now() + ctx.clockOffsetMs;

  const wsScheme = location.protocol === "https:" ? "wss:" : "ws:";
  const wsPath = ctx.isDM ? "/ws/dm" : ctx.isPlayer ? "/ws/player" : "/ws/view";
  const ws = new WebSocket(`${wsScheme}//${location.host}${wsPath}`);

  // Пока не пришёл первый snapshot — соединение либо ещё устанавливается,
  // либо было отвергнуто сервером (сессия истекла/роль не подходит). Сервер
  // отвечает http.Error ДО апгрейда до WS, браузер видит это просто как
  // неудавшийся хендшейк — dm.html/player.html показывают понятное сообщение
  // по событию vtt:authFailed.
  let gotSnapshot = false;
  ws.onclose = () => {
    if (!gotSnapshot) document.dispatchEvent(new CustomEvent("vtt:authFailed"));
  };

  ws.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    if (data.type === "snapshot") {
      gotSnapshot = true;
      if (typeof data.serverNow === "number") ctx.clockOffsetMs = data.serverNow - Date.now();
      const nextScene = data.scene;
      if (!nextScene.walls) nextScene.walls = {};
      if (!nextScene.fogAreas) nextScene.fogAreas = {};
      if (!nextScene.buildings) nextScene.buildings = {};
      if (!nextScene.grid) nextScene.grid = { size: 0, offsetX: 0, offsetY: 0 };
      diffAndMarkDirty(ctx.dirty, ctx.scene, nextScene);
      ctx.scene = nextScene;
      ctx.mapStartedAt = data.mapStartedAt;
      audio.applyAmbient(nextScene.ambientUrl || "", data.ambientStartedAt, nextScene.ambientVolume);
      ctx.render();
      document.dispatchEvent(new CustomEvent("vtt:sceneUpdated", { detail: ctx.scene }));
    } else if (data.type === "fx") {
      ctx.spawnFx(data.fx);
    } else if (data.type === "scene_list") {
      document.dispatchEvent(new CustomEvent("vtt:sceneList", { detail: data }));
    } else if (data.type === "scene_detail") {
      document.dispatchEvent(new CustomEvent("vtt:sceneDetail", { detail: data.scene }));
    } else if (data.type === "player_list") {
      document.dispatchEvent(new CustomEvent("vtt:playerList", { detail: data.players || [] }));
    } else if (data.type === "journal_shown") {
      // «Показать игрокам» из журнала ДМ (см. relayJournalShow в
      // internal/service/room.go) — эфемерное «посмотрите сюда», состояние
      // мира не трогает; открывает окно журнала у игрока (pages/player.js).
      document.dispatchEvent(new CustomEvent("vtt:journalShown", { detail: data }));
    } else if (data.type === "roll_result") {
      document.dispatchEvent(new CustomEvent("vtt:rollResult", { detail: data }));
    } else if (data.type === "audio_cue") {
      if (typeof data.serverNow === "number") ctx.clockOffsetMs = data.serverNow - Date.now();
      audio.applyCue(data.cue);
    } else if (data.type === "combat_state") {
      // Трекер инициативы (см. internal/service/room.go: combatPayload) —
      // не часть сцены (живёт вне r.scene, переживает switch_scene), поэтому
      // отдельный тип сообщения, а не поле snapshot.scene. ctx.combat даёт
      // combat-bar.js/pages/dm.js синхронный доступ к последнему состоянию
      // без необходимости всем самим держать подписку.
      ctx.combat = data;
      document.dispatchEvent(new CustomEvent("vtt:combatState", { detail: data }));
    } else if (data.type === "hub_state") {
      // Хаб лута ДМ (см. internal/service/room.go: hubPayload) — не привязан
      // к сцене/бою, отдельный тип сообщения, тот же принцип, что и
      // combat_state. ctx.hub даёт синхронный доступ последнему состоянию,
      // как ctx.combat.
      ctx.hub = data.entries || [];
      document.dispatchEvent(new CustomEvent("vtt:hubState", { detail: ctx.hub }));
    }
  };

  function send(msg) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }
  ctx.send = send;

  return { ws, send };
}
