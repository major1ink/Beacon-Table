// board/sync.js — живая связь с доской по WebSocket (/ws/board?id=…).
//
// Транспорт и только транспорт: что делать с пришедшим, решает editor.js.
// Правки идут поэлементно, сводит их сервер (см. internal/service/boardroom.go).

// Задержка переподключения: растёт до минуты, чтобы закрытая вкладка не
// долбила сервер, но первые попытки шли быстро — обрыв обычно секундный.
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 60000;

export function connectBoard(boardId, handlers = {}) {
  const url = new URL("/ws/board", location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("id", boardId);

  let ws = null;
  let retry = RETRY_MIN_MS;
  let timer = null;
  let closed = false;

  function open() {
    if (closed) return;
    ws = new WebSocket(url);

    ws.onopen = () => {
      retry = RETRY_MIN_MS;
      handlers.onStatus?.("online");
    };

    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "board_snapshot":
          handlers.onSnapshot?.(msg);
          break;
        case "board_change":
          handlers.onChange?.(msg.elements || []);
          break;
        case "board_files":
          handlers.onFiles?.(msg.files || []);
          break;
        case "board_cursor":
          handlers.onCursor?.(msg);
          break;
        case "board_peers":
          handlers.onPeers?.(msg.peers || []);
          break;
        case "board_peer_left":
          handlers.onPeerLeft?.(msg.id);
          break;
      }
    };

    ws.onclose = () => {
      ws = null;
      if (closed) return;
      handlers.onStatus?.("offline");
      timer = setTimeout(open, retry);
      retry = Math.min(retry * 2, RETRY_MAX_MS);
    };

    // Ошибку не разбираем: за ней всегда идёт onclose, который и
    // переподключает.
    ws.onerror = () => {};
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  open();

  return {
    sendChange(elements) {
      if (elements.length) send({ type: "board_change", elements });
    },
    sendFiles(files) {
      if (files.length) send({ type: "board_files", files });
    },
    sendCursor(x, y, selected) {
      send({ type: "board_cursor", x, y, selected });
    },
    close() {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    },
  };
}
