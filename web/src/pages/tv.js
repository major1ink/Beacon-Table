// Перенос inline-скрипта static/tv.html. initVTT теперь async
// (PIXI.Application.init() в v8 — промис), но результат tv.html не нужен —
// вызов и раньше был "выстрелил и забыл", тут то же самое, просто с
// промисом внутри.
import { initVTT } from "../vtt/index.js";

initVTT({ canvasId: "scene", role: "tv" });
