import { defineConfig } from "vite";
import legacy from "@vitejs/plugin-legacy";
import { resolve } from "node:path";

// Отдельная сборка страницы трансляции под старые браузеры телевизоров и приставок.
// Запускается после основной (vite.config.js) и дописывает в тот же каталог.
// Выходят два варианта: современный (Chrome 64+) и legacy (ES5 + SystemJS).
// Служебные inline-скрипты плагина разрешены в CSP по хешам (security_headers.go).
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
    // без этого inset в CSS остался бы как есть, а в Chromium до 87 его нет
    cssTarget: ["chrome61", "safari11"],
    rollupOptions: {
      input: {
        broadcast: resolve(__dirname, "broadcast.html"),
      },
    },
  },
});
