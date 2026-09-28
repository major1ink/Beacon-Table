import { defineConfig } from "vite";
import legacy from "@vitejs/plugin-legacy";
import { resolve } from "node:path";

// Страница трансляции собирается отдельно от остальных (см. vite.config.js):
// её открывают встроенные браузеры телевизоров и Android-приставок, а там
// движок бывает на годы старше того, что понимает основная сборка. Одна и та
// же страница выходит в двух вариантах:
//
//  - современный — ES-модули, синтаксис опущен до Chrome 64 (`??=`, `?.` и
//    прочее разворачиваются), недостающие встроенные функции
//    (Object.fromEntries, Array.prototype.flatMap…) подкладывает core-js —
//    ровно те, что встречаются в коде;
//  - legacy — для браузеров без модулей или без динамического import: тот же
//    код через Babel в ES5 и SystemJS.
//
// Какой из них грузить, браузер решает сам (type="module" / nomodule плюс
// проверка плагина). Остальные страницы так не собираются: excalidraw и
// редакторы в legacy-варианте удвоили бы бинарник ради экранов, которые на
// телевизоре не открывают.
//
// Встроенные скрипты, которые плагин добавляет в HTML, разрешены в CSP по
// хешам (internal/api/http/security_headers.go, тест там же сверяет их со
// сборкой).
//
// Сборка идёт второй, после основной, и дописывает в тот же каталог — отсюда
// emptyOutDir: false и publicDir: false (public/ уже скопирован).
export default defineConfig({
  root: __dirname,
  publicDir: false,
  plugins: [
    legacy({
      targets: ["chrome >= 49", "android >= 5", "samsung >= 5", "safari >= 10", "firefox >= 52"],
      modernTargets: ["chrome >= 64", "android >= 64", "samsung >= 9", "safari >= 12", "firefox >= 67", "edge >= 79"],
      modernPolyfills: true,
    }),
  ],
  build: {
    outDir: resolve(__dirname, "../cmd/beacon-table/static"),
    emptyOutDir: false,
    // CSS тоже под старые движки: `inset` у Chromium до 87 нет, и без
    // разворота в top/right/bottom/left полноэкранные слои схлопываются.
    cssTarget: ["chrome61", "safari11"],
    rollupOptions: {
      input: {
        broadcast: resolve(__dirname, "broadcast.html"),
      },
    },
  },
});
