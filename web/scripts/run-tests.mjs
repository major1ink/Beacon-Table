// run-tests.mjs — находит *.test.js под test/ и передаёт их файлами
// (не шаблоном) в `node --test`.
//
// Почему не просто `node --test test/` или glob-шаблон в package.json:
// разные комбинации ОС/шелла/версии Node разворачивают его по-разному, и
// ни один вариант не работает одинаково везде:
//   - `node --test test/` — на Node 22/Windows падает с MODULE_NOT_FOUND
//     (баг резолвинга бинарной директории как модуля CommonJS);
//   - `node --test "test/**/*.test.js"` — на Node 20/Linux (CI) кавычки
//     мешают шеллу развернуть маску сам, а встроенный резолвинг Node не
//     находит по ней файлов ("Could not find ...");
//   - `node --test test/*.test.js` без кавычек работает, только если шелл
//     САМ разворачивает маску (POSIX sh) — а npm-скрипты на Windows обычно
//     идут через cmd.exe, который `*` не разворачивает вообще.
// Три площадки — три разных поведения одной и той же строки. Единственный
// способ получить одинаковый результат везде — не отдавать глобусы на
// откуп ни шеллу, ни Node, а перечислить файлы явно средствами самого
// Node (fs.readdirSync), которые от ОС/версии не зависят.
import { readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const testDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test");

// Плоский список — test/fixtures/ намеренно не заходим: там лежат данные
// для тестов (walls-manor.js и т.п.), а не сами тесты (см. test/fixtures).
// Если когда-нибудь тесты разъедутся по подпапкам, тут нужно будет пройтись
// рекурсивно — сегодня в этом нет необходимости.
const files = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => path.join(testDir, name));

if (files.length === 0) {
  console.error("run-tests.mjs: не найдено ни одного *.test.js в " + testDir);
  process.exit(1);
}

const child = spawn(process.execPath, ["--test", ...files], { stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1));
