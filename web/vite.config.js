import { defineConfig } from "vite";
import { resolve } from "node:path";
import { cp, rm } from "node:fs/promises";

// Собирает web/ (исходники, HTML — рукописный источник) в
// cmd/beacon-table/static/ (чистый build output, коммитится в git — иначе
// `go build ./cmd/beacon-table`, у которого //go:embed static, перестанет
// работать без Node.js на чистом клоне). См. README "Фронтенд" и
// /home/major/.claude/plans/imperative-baking-thunder.md.

// excalidrawAssets — шрифты редактора доски. Excalidraw грузит их в рантайме
// по window.EXCALIDRAW_ASSET_PATH, в бандл они не попадают. Копируем из
// node_modules при сборке, чтобы не держать копию в исходниках.
//
// Xiaolai пропускается: шрифт для иероглифов, 13 МБ из 14 МБ. Лицензии —
// third_party/excalidraw/NOTICE.md.
function excalidrawAssets() {
  const from = resolve(__dirname, "node_modules/@excalidraw/excalidraw/dist/prod/fonts");
  const to = resolve(__dirname, "../cmd/beacon-table/static/excalidraw-assets/fonts");
  return {
    name: "excalidraw-assets",
    async closeBundle() {
      await cp(from, to, { recursive: true });
      await rm(resolve(to, "Xiaolai"), { recursive: true, force: true });
    },
  };
}

export default defineConfig({
  root: __dirname,
  plugins: [excalidrawAssets()],
  resolve: {
    alias: {
      // См. src/board/mermaid-stub.js.
      "@excalidraw/mermaid-to-excalidraw": resolve(__dirname, "src/board/mermaid-stub.js"),
    },
  },
  build: {
    outDir: resolve(__dirname, "../cmd/beacon-table/static"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        worlds: resolve(__dirname, "worlds.html"),
        dm: resolve(__dirname, "dm.html"),
        player: resolve(__dirname, "player.html"),
        broadcast: resolve(__dirname, "broadcast.html"),
        journal: resolve(__dirname, "journal.html"),
        board: resolve(__dirname, "board.html"),
        characterSheet: resolve(__dirname, "character-sheet.html"),
        bestiary: resolve(__dirname, "bestiary.html"),
        spellbook: resolve(__dirname, "spellbook.html"),
        itembook: resolve(__dirname, "itembook.html"),
        referencebook: resolve(__dirname, "referencebook.html"),
        conditions: resolve(__dirname, "conditions.html"),
        combatTracker: resolve(__dirname, "combat-tracker.html"),
        catalog: resolve(__dirname, "catalog.html"),
        foundryImport: resolve(__dirname, "foundry-import.html"),
      },
    },
  },
  server: {
    // Дев-режим: `npm run dev` (фронт, HMR, обычно :5173) + отдельно
    // `go run ./cmd/beacon-table` (бэкенд, :8080) — все не-статические
    // запросы проксируются на бэкенд, включая апгрейд WebSocket.
    proxy: {
      "/api": "http://localhost:8080",
      "/upload": "http://localhost:8080",
      "/assets": "http://localhost:8080",
      "/uploads": "http://localhost:8080",
      "/ws": { target: "ws://localhost:8080", ws: true },
    },
  },
});
