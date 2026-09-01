// Единственное место, где страница открывает WebSocket к столу.
//
// Зачем модуль. Раньше каждая из семи страниц (стол, трекер инициативы, лист
// персонажа, журнал, бестиарий, книга заклинаний, книга предметов) звала
// `new WebSocket` сама, и ни одна не переподключалась. Обрыв — а на мобильной
// сети и через NAT он рядовое событие — выглядел так: карта на экране,
// кнопки нажимаются, на сервер ничего не уходит и никто об этом не знает.
// У пяти страниц не было даже onclose: там молча переставали работать кубики.
//
// Что делает. Держит соединение живым: переподключается с растущей паузой,
// не спит, когда вкладку вернули на экран или сеть появилась снова, и умеет
// отличить «сервер перезапускается» от «эта сессия больше не действительна».
// Состояние после переподключения восстанавливается само: комната шлёт
// полный snapshot каждому вошедшему (см. internal/service/room.go, ветка
// join), так что страницам ничего доподписывать не нужно.

// Пауза перед следующей попыткой. Растёт вдвое до полуминуты: сервер могли
// перезапускать, а могли и выключить до вечера — долбиться раз в секунду в
// обоих случаях бессмысленно.
const backoffSteps = [1000, 2000, 4000, 8000, 15000, 30000];

// Разброс паузы. Один стол — это семь сокетов на вкладку у каждого за столом,
// и после перезапуска сервера все они проснулись бы в одну и ту же
// миллисекунду.
const jitter = 0.25;

function backoffFor(attempt) {
  const base = backoffSteps[Math.min(attempt, backoffSteps.length - 1)];
  return Math.round(base * (1 + (Math.random() * 2 - 1) * jitter));
}

// sessionState — почему не удалось подключиться. Хендшейк, отвергнутый по
// роли или протухшей сессии, и полное отсутствие сети выглядят для браузера
// ОДИНАКОВО (close 1006, onopen не случился), а вести себя надо
// противоположным образом: в первом случае — увести на экран входа, во
// втором — молча ждать сеть. Различает их обычный запрос к /api/me:
//
//   401/403 — сессии больше нет (истекла, ДМ удалил аккаунт, гостя демо
//             убрал уборщик — см. app.GuestKeeper);
//   любой другой ОТВЕТ — сервер на связи, дело не в сессии;
//   исключение — до сервера не достучаться, сети нет.
async function sessionState() {
  try {
    const res = await fetch("/api/me");
    return res.status === 401 || res.status === 403 ? "invalid" : "ok";
  } catch {
    return "unreachable";
  }
}

// openSocket открывает сокет по адресу path ("/ws/dm", "/ws/player",
// "/ws/view") и держит его открытым, пока страница жива.
//
// Колбэки все необязательные:
//   onMessage(data) — разобранный JSON очередного сообщения;
//   onOpen({ first }) — соединение установлено; first=false означает, что это
//     переподключение и на экране могли устареть данные (стол в этот момент
//     и так получит snapshot, а вот панели поменьше могут перечитать своё);
//   onDrop() — связь потеряна, идут попытки восстановить;
//   onAuthFailed() — сессия недействительна, попытки прекращены.
//
// Возвращает { send, close, isOpen }. send принимает объект (сериализует
// сам) и возвращает false, если прямо сейчас отправить некуда — ровно то же
// поведение, что и у прежней проверки readyState на каждой странице.
export function openSocket(path, { onMessage, onOpen, onDrop, onAuthFailed } = {}) {
  // wss:// обязателен, когда саму страницу отдали по https: иначе браузер
  // блокирует соединение как mixed content (см. README, раздел HTTPS).
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${scheme}//${location.host}${path}`;

  let ws = null;
  let attempt = 0;
  let timer = null;
  let closedByUs = false;
  let everOpened = false;

  function connect() {
    timer = null;
    try {
      ws = new WebSocket(url);
    } catch {
      // Конструктор бросает только на негодном адресе — чинить нечего, но и
      // ронять страницу незачем: попробуем ещё раз по общему расписанию.
      scheduleRetry();
      return;
    }

    ws.onopen = () => {
      const first = !everOpened;
      everOpened = true;
      attempt = 0;
      onOpen?.({ first });
    };

    ws.onmessage = (ev) => {
      let data;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return; // не наш кадр — молча пропускаем, рвать соединение не за что
      }
      onMessage?.(data);
    };

    ws.onclose = () => {
      if (closedByUs) return;
      ws = null;
      onDrop?.();
      scheduleRetry();
    };

    // onerror браузер всегда сопровождает onclose — отдельной обработки не
    // требует, иначе одна и та же потеря связи считалась бы дважды.
    ws.onerror = () => {};
  }

  // scheduleRetry решает, ждать ли дальше. Отдельно от connect, потому что
  // на первом же обрыве надо выяснить, есть ли ещё кого спрашивать: сессию
  // могли закрыть, и тогда переподключаться незачем ни через секунду, ни
  // через полчаса.
  async function scheduleRetry() {
    if (closedByUs || timer) return;
    if ((await sessionState()) === "invalid") {
      closedByUs = true; // дальше только через экран входа
      onAuthFailed?.();
      return;
    }
    if (closedByUs || timer) return; // пока ходили за ответом, могли закрыть
    timer = setTimeout(connect, backoffFor(attempt++));
  }

  // Вкладку вернули на экран или сеть появилась — не ждём оставшуюся паузу.
  // На телефоне это разница между «стол ожил сразу» и «полминуты смотрю на
  // застывшую карту».
  function retryNow() {
    if (closedByUs || ws || !timer) return;
    clearTimeout(timer);
    timer = null;
    attempt = 0;
    connect();
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") retryNow();
  });
  window.addEventListener("online", retryNow);

  connect();

  return {
    send(msg) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(msg));
      return true;
    },
    close() {
      closedByUs = true;
      if (timer) clearTimeout(timer);
      timer = null;
      ws?.close();
      ws = null;
    },
    isOpen() {
      return !!ws && ws.readyState === WebSocket.OPEN;
    },
  };
}
