// broadcast-guard.js — сторож страницы трансляции.
//
// Телевизор или приставка не показывают консоль, а человек у экрана видит
// только «квадратик» и не может сказать, что сломалось. Этот скрипт:
//
//  - сразу сообщает серверу, что за браузер открыл трансляцию (модули,
//    WebGL, видеокарта, размер экрана);
//  - пересылает на сервер ошибки страницы — ДМ получит их в «Сообщить о
//    баге» (см. internal/api/http/broadcast_diag.go, web/src/bug-report.js);
//  - если стол так и не запустился, показывает на экране понятное
//    объяснение вместо пустоты.
//
// Намеренно ES5 и без сборки (лежит в public/, копируется как есть): его
// задача — выполниться там, где основной код страницы даже не разобрался.
// Подключён обычным <script> до модулей, поэтому ловит и их ошибки разбора.
(function () {
  "use strict";

  var START_TIMEOUT_MS = 20000;
  var MAX_POSTS = 30;
  var MAX_LEN = 600;

  var posts = 0;
  var started = false;
  var lastError = "";

  function post(body) {
    if (posts >= MAX_POSTS) return;
    posts++;
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/broadcast/diag", true);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.send(JSON.stringify(body));
    // eslint-disable-next-line no-unused-vars -- ES5: catch без переменной появился только в ES2019
    } catch (_) {
      /* сеть недоступна — показывать на экране всё равно будем */
    }
  }

  function webglInfo() {
    var out = { webgl2: "нет", webgl: "нет" };
    try {
      var canvas = document.createElement("canvas");
      var gl2 = canvas.getContext("webgl2");
      if (gl2) out.webgl2 = "да";
      var gl = gl2 || canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
      if (gl) {
        out.webgl = "да";
        var dbg = gl.getExtension("WEBGL_debug_renderer_info");
        if (dbg) out.gpu = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
        var lose = gl.getExtension("WEBGL_lose_context");
        if (lose) lose.loseContext(); // у телевизора контекстов мало, пробный не держим
      }
    } catch (e) {
      out.webglError = String(e && e.message);
    }
    return out;
  }

  function pageInfo() {
    var info = webglInfo();
    info.modules = "noModule" in document.createElement("script") ? "да" : "нет";
    info.screen = window.screen ? screen.width + "×" + screen.height : "?";
    info.window = window.innerWidth + "×" + window.innerHeight;
    info.dpr = String(window.devicePixelRatio || 1);
    return info;
  }

  function report(text) {
    text = String(text || "").slice(0, MAX_LEN);
    if (!text) return;
    lastError = text;
    post({ kind: "error", message: text });
  }

  function errorText(err) {
    if (!err) return "";
    if (err.stack) return String(err.stack);
    if (err.message) return (err.name || "Error") + ": " + err.message;
    try {
      return JSON.stringify(err);
    // eslint-disable-next-line no-unused-vars -- ES5: catch без переменной появился только в ES2019
    } catch (_) {
      return String(err);
    }
  }

  // capture: true — так сюда попадают и файлы, которые не загрузились
  // (скрипт, стиль): у них событие error не всплывает до window.
  window.addEventListener(
    "error",
    function (e) {
      var t = e.target;
      if (t && t !== window && (t.src || t.href)) {
        report("не загрузился " + (t.src || t.href));
        return;
      }
      if (e.error) report(errorText(e.error));
      else report(e.message + " (" + e.filename + ":" + e.lineno + ")");
    },
    true
  );
  window.addEventListener("unhandledrejection", function (e) {
    report("promise: " + errorText(e.reason));
  });

  // Приложение и само ловит свои ошибки (catch + console.error) — такие до
  // window.onerror не доходят, а они как раз самые говорящие.
  if (window.console && console.error) {
    var original = console.error;
    console.error = function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        var a = arguments[i];
        parts.push(typeof a === "string" ? a : errorText(a));
      }
      report("console: " + parts.join(" "));
      return original.apply(console, arguments);
    };
  }

  function show(detail) {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", function () {
        show(detail);
      });
      return;
    }
    if (document.getElementById("broadcastGuard")) return;
    var box = document.createElement("div");
    box.id = "broadcastGuard";
    box.style.cssText =
      "position:fixed;top:0;right:0;bottom:0;left:0;z-index:10000;background:#000;color:#e8e8ea;" +
      "display:flex;align-items:center;justify-content:center;padding:5vmin;text-align:center;" +
      "font:400 20px/1.5 sans-serif;";
    var inner = document.createElement("div");
    inner.style.cssText = "max-width:40em;";
    function line(text, css) {
      var p = document.createElement("p");
      p.style.cssText = "margin:0 0 .8em;" + (css || "");
      p.textContent = text;
      inner.appendChild(p);
    }
    line("Браузер этого экрана не смог запустить трансляцию", "font-size:1.4em;font-weight:600;");
    if (detail) line(detail, "color:#e0756e;font-family:monospace;font-size:.8em;word-break:break-word;");
    line(
      "Подробности уже переданы на стол: ДМ может отправить их разработчикам — «Настройки» → «Сервер» → «Сообщить о баге». " +
        "Если под рукой есть другой браузер (например, Chrome) или ноутбук — попробуйте открыть трансляцию там.",
      "color:#a9adb4;"
    );
    line(navigator.userAgent, "color:#6d7078;font-size:.65em;word-break:break-all;");
    box.appendChild(inner);
    document.body.appendChild(box);
  }

  // Контракт с pages/broadcast.js: started() — модуль страницы запустился,
  // fatal() — запустился, но стол поднять не смог (например, нет WebGL).
  window.__beaconBroadcast = {
    started: function () {
      if (started) return;
      started = true;
      post({ kind: "started" });
    },
    fatal: function (err) {
      var text = errorText(err) || String(err);
      report("fatal: " + text);
      show(text.split("\n")[0]);
    },
  };

  post({ kind: "page", info: pageInfo() });

  setTimeout(function () {
    if (started) return;
    post({ kind: "timeout" });
    show(lastError ? lastError.split("\n")[0] : "страница не ответила за " + START_TIMEOUT_MS / 1000 + " с");
  }, START_TIMEOUT_MS);
})();
