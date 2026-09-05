# Excalidraw в Beacon Table

Страница доски (`web/board.html`) использует редактор
[Excalidraw](https://github.com/excalidraw/excalidraw) — пакет
`@excalidraw/excalidraw`, лицензия **MIT**, текст в [LICENSE](LICENSE).

Пакет на npm файла лицензии не содержит (в тарболе только `dist`, `README.md`
и `package.json`), поэтому текст взят из репозитория проекта и лежит здесь.

Excalidraw — торговая марка своих авторов. Beacon Table пользуется
библиотекой, но не выступает от их имени: их название и логотип в интерфейсе
не используются.

## Шрифты

Вместе с редактором распространяются шрифты — отдельные произведения со
своими лицензиями. Текст SIL Open Font License 1.1 общий для всех, кроме
Comic Shanns, и лежит в [OFL-1.1](OFL-1.1).

| Шрифт | Правообладатель | Лицензия |
| --- | --- | --- |
| Excalifont | Copyright (c) 2024 Excalidraw | SIL OFL 1.1 |
| Virgil | Copyright (c) 2024 Excalidraw | SIL OFL 1.1 |
| Nunito | Copyright 2014 The Nunito Project Authors | SIL OFL 1.1 |
| Lilita One | The Lilita One Project Authors | SIL OFL 1.1 |
| Assistant | The Assistant Project Authors | SIL OFL 1.1 |
| Cascadia Code | Copyright (c) 2019–наст. время Microsoft Corporation | SIL OFL 1.1 |
| Liberation Sans | Copyright (c) 2012 Red Hat, Inc.; digitized data (c) 2010 Google Corporation | SIL OFL 1.1 |
| Comic Shanns | Copyright (c) 2018 Shannon Miwa; (c) 2023 Jesus Gonzalez; (c) 2023 Rodrigo Batista de Moraes | MIT |

**Xiaolai не поставляется.** Это шрифт для китайской письменности, и он один
весит 13 МБ из 14 МБ всех шрифтов Excalidraw. Иероглифы на доске отрисуются
запасным системным шрифтом.

Шрифты не лежат в исходниках: они копируются в сборку из `node_modules` при
`npm run build` (см. `excalidrawAssets` в `web/vite.config.js`) и раздаются с
самого стола по `/excalidraw-assets/`.
