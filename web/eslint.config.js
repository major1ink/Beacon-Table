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
    // vite.config.js и тесты (node:test) исполняются в Node, а не в браузере.
    files: ["vite.config.js", "test/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
];
