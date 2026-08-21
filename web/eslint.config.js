import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/**", "../cmd/beacon-table/static/**"],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // vite.config.js, тесты (node:test) и служебные скрипты (scripts/)
    // исполняются в Node, а не в браузере.
    files: ["vite.config.js", "test/**/*.js", "scripts/**/*.js", "scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
];
