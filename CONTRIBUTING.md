# Contributing to Beacon Table

Спасибо за интерес к проекту! Краткая шпаргалка.

## Сборка и запуск

```bash
git clone https://github.com/major1ink/beacon-table.git
cd beacon-table
go run ./cmd/beacon-table
```

Фронтенд собран и закоммичен (`cmd/beacon-table/static/`), поэтому для
запуска сервера Node.js не нужен. Он нужен только если меняете сам фронтенд:

```bash
cd web
npm install
npm run build   # результат нужно закоммитить вместе с изменениями в web/src
```

Подробности архитектуры, слоёв, зависимостей — в разработке.

## Перед PR

В проекте используется [Task](https://taskfile.dev) (`go install
github.com/go-task/task/v3/cmd/task@latest` или пакет `task` в вашем
менеджере пакетов). Список всех задач — `task` без аргументов.

```bash
task check   # fmt + vet + test + lint (Go и фронтенд)
```

Эквивалент вручную, если Task недоступен:

```bash
go build ./...
go vet ./...
go test ./...
golangci-lint run
cd web && npm install && npm run lint
```

## Игровой контент (bestiary/spells/items/references)

Каталог "из коробки" (`cmd/beacon-table/systemdata/`) может содержать
**только** контент, лицензированный под SRD 5.1/5.2 (OGL 1.0a / CC-BY-4.0).
Ничего из платных книг WotC (Player's Handbook, Monster Manual, DMG 2024/2014
и т.д.) сюда не добавляется — ни текст статблоков, ни артворк. См.
[`cmd/beacon-table/systemdata/README.md`](cmd/beacon-table/systemdata/README.md)
для деталей и формата файлов.

Если добавляете карточку — сначала сверьтесь, что она (по имени/содержанию)
входит в официальный SRD 5.2: https://www.dndbeyond.com/srd.

## Issues / PR

- Баг — используйте темплейт "Bug report".
- Идея/фича — темплейт "Feature request".
- PR — маленькие и сфокусированные предпочтительнее больших.

## Лицензия вклада

Отправляя PR, вы соглашаетесь, что ваш код распространяется под той же
лицензией проекта — [AGPL-3.0](LICENSE).
