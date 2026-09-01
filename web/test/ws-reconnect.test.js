// Переподключение WebSocket (web/src/ws-reconnect.js). Проверяется главное
// решение модуля: отличить «сессия кончилась» от «сеть пропала» — браузер
// показывает то и другое одинаково (close без onopen), а вести себя надо
// противоположным образом.
//
// Браузерных API в node нет, поэтому все, кого трогает модуль (WebSocket,
// fetch, location, document/window, таймеры), подменяются заглушками ДО
// вызова openSocket — сам модуль читает их в момент вызова, а не при
// импорте.
import test from "node:test";
import assert from "node:assert/strict";

import { openSocket } from "../src/ws-reconnect.js";

// FakeSocket — ровно та часть контракта WebSocket, которой пользуется
// модуль. Все созданные экземпляры копятся в sockets, чтобы тест мог
// «уронить» текущий и посмотреть, появился ли следующий.
let sockets = [];
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = FakeSocket.CONNECTING;
    this.sent = [];
    sockets.push(this);
  }
  send(raw) {
    this.sent.push(raw);
  }
  close() {
    this.readyState = FakeSocket.CLOSED;
  }
  // ---- то, чем управляет тест ----
  accept() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  deliver(obj) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  drop() {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
}
FakeSocket.CONNECTING = 0;
FakeSocket.OPEN = 1;
FakeSocket.CLOSED = 3;

// pending — отложенные попытки переподключения. Настоящий setTimeout ждал бы
// секунду на первом же шаге, а проверять надо решение модуля, а не арифметику
// паузы, поэтому таймеры под нашим управлением.
let pending = [];
let fetchStatus = 200;
let fetchThrows = false;

function installBrowser() {
  sockets = [];
  pending = [];
  fetchStatus = 200;
  fetchThrows = false;
  globalThis.WebSocket = FakeSocket;
  globalThis.location = { protocol: "http:", host: "table.example" };
  globalThis.document = { addEventListener() {}, visibilityState: "visible" };
  globalThis.window = { addEventListener() {} };
  globalThis.fetch = async () => {
    if (fetchThrows) throw new Error("сети нет");
    return { status: fetchStatus };
  };
  globalThis.setTimeout = (fn) => {
    pending.push(fn);
    return pending.length;
  };
  globalThis.clearTimeout = (id) => {
    if (id) pending[id - 1] = null;
  };
}

// settle — дать модулю доработать его собственные await'ы (он спрашивает
// /api/me перед тем, как решить, ждать ли дальше).
const settle = () => new Promise((resolve) => process.nextTick(resolve));

// runPending — «прошла пауза»: выполняем отложенные попытки.
function runPending() {
  const due = pending.filter(Boolean);
  pending = [];
  for (const fn of due) fn();
}

test("сообщения приходят разобранными, send сериализует", () => {
  installBrowser();
  const got = [];
  const conn = openSocket("/ws/dm", { onMessage: (d) => got.push(d) });

  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, "ws://table.example/ws/dm");

  sockets[0].accept();
  sockets[0].deliver({ type: "roll_result", total: 7 });
  assert.deepEqual(got, [{ type: "roll_result", total: 7 }]);

  assert.equal(conn.send({ type: "roll_dice" }), true);
  assert.deepEqual(sockets[0].sent, ['{"type":"roll_dice"}']);
});

test("на https-странице сокет идёт по wss", () => {
  installBrowser();
  globalThis.location = { protocol: "https:", host: "table.example" };
  openSocket("/ws/player", {});
  assert.equal(sockets[0].url, "wss://table.example/ws/player");
});

test("обрыв рабочего соединения — переподключаемся", async () => {
  installBrowser();
  const events = [];
  openSocket("/ws/dm", {
    onOpen: ({ first }) => events.push(first ? "open" : "reopen"),
    onDrop: () => events.push("drop"),
    onAuthFailed: () => events.push("auth"),
  });

  sockets[0].accept();
  sockets[0].drop();
  await settle();

  runPending();
  assert.equal(sockets.length, 2, "второй сокет не открыт");
  sockets[1].accept();

  assert.deepEqual(events, ["open", "drop", "reopen"]);
});

// Главное различение модуля. Сессию мог закрыть кто угодно — она истекла, ДМ
// удалил аккаунт, гостя демо убрал уборщик (см. app.GuestKeeper), — и
// долбиться в сервер после этого бессмысленно: там ждёт тот же отказ.
test("сессия недействительна — попытки прекращаются", async () => {
  installBrowser();
  let authFailed = 0;
  openSocket("/ws/dm", { onAuthFailed: () => authFailed++ });

  fetchStatus = 401;
  sockets[0].drop();
  await settle();

  assert.equal(authFailed, 1);
  assert.equal(pending.filter(Boolean).length, 0, "запланирована попытка после отказа сессии");
});

// Обратный случай: браузеру он выглядит ТОЧНО так же (close без onopen), но
// сессия тут ни при чём — надо молча ждать сеть.
test("сети нет — продолжаем пытаться, экран входа не показываем", async () => {
  installBrowser();
  let authFailed = 0;
  openSocket("/ws/dm", { onAuthFailed: () => authFailed++ });

  fetchThrows = true;
  sockets[0].drop();
  await settle();

  assert.equal(authFailed, 0, "отсутствие сети принято за отказ сессии");
  runPending();
  assert.equal(sockets.length, 2, "попытка переподключиться не запланирована");

  // Сеть вернулась, но сервер ещё поднимается и рвёт соединение — это тоже
  // не повод сдаться.
  fetchThrows = false;
  fetchStatus = 503;
  sockets[1].drop();
  await settle();
  runPending();
  assert.equal(sockets.length, 3);
  assert.equal(authFailed, 0);
});

test("close() закрывает насовсем", async () => {
  installBrowser();
  const conn = openSocket("/ws/dm", {});
  sockets[0].accept();
  conn.close();

  sockets[0].drop();
  await settle();
  runPending();

  assert.equal(sockets.length, 1, "после close() соединение переоткрылось");
  assert.equal(conn.send({ type: "roll_dice" }), false);
  assert.equal(conn.isOpen(), false);
});

test("пока связи нет, send честно отвечает «не отправлено»", async () => {
  installBrowser();
  const conn = openSocket("/ws/dm", {});
  sockets[0].accept();
  assert.equal(conn.isOpen(), true);

  sockets[0].drop();
  await settle();

  assert.equal(conn.isOpen(), false);
  assert.equal(conn.send({ type: "show_journal" }), false);
});

test("негодный кадр не роняет обработчик и не рвёт соединение", () => {
  installBrowser();
  const got = [];
  openSocket("/ws/dm", { onMessage: (d) => got.push(d) });
  sockets[0].accept();

  sockets[0].onmessage({ data: "не json" });
  sockets[0].deliver({ type: "roll_result" });

  assert.deepEqual(got, [{ type: "roll_result" }]);
});
