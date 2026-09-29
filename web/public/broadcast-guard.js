/* eslint no-unused-vars: ["warn", { "caughtErrors": "none" }] */
// Сторож страницы трансляции: отправляет на сервер сведения о браузере и ошибки,
// а если стол не запустился, показывает объяснение на экране.
// Написан на ES5 без сборки и подключён до модулей, чтобы работать в старых браузерах.
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
    } catch (e) {
      // сервер недоступен, отчёт не отправить
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
        if (lose) lose.loseContext();
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
    } catch (e) {
      return String(err);
    }
  }

  // capture: true, чтобы ловить и не загрузившиеся скрипты и стили
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

  // ошибки, которые приложение ловит само, до window.onerror не доходят
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

  // Вызывается из pages/broadcast.js: started — модуль страницы запустился,
  // note — сведения для отчёта, fatal — стол поднять не удалось.
  window.__beaconBroadcast = {
    started: function () {
      if (started) return;
      started = true;
      post({ kind: "started" });
    },
    note: function (info) {
      post({ kind: "info", info: info });
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
