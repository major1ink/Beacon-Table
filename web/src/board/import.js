// board/import.js — импорт доски из ваулта Obsidian вместе с тем, на что она
// ссылается.
//
// Искать файлы руками не нужно: доска сама перечисляет, что ей нужно —
// картинки в разделе «## Embedded Files», заметки в поле link элементов.
// Человек показывает ГДЕ искать (папку ваулта), остальное берём по списку.
//
// Картинки разбираем прямо тут: раздел лежит в файле обычным текстом. Ссылки
// на заметки — внутри сжатого блока рисунка, их называет сервер в ответе на
// импорт (см. BoardImport в internal/service/boards.go).

// EMBEDDED — строка раздела: «<fileId>: [[файл.png]]». Путь внутри ваулта и
// подпись после | отбрасываем: искать всё равно будем по имени файла.
const EMBEDDED = /^[A-Za-z0-9_.-]+:\s*\[\[(.+?)\]\]\s*$/;

// imageNamesOf — какие картинки называет файл доски.
export function imageNamesOf(text) {
  const at = text.indexOf("## Embedded Files");
  if (at < 0) return [];
  const out = [];
  for (const raw of text.slice(at + 17).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // Следующий заголовок или начало блока данных — конец раздела.
    if (line.startsWith("#") || line.startsWith("%%") || line.startsWith("```")) break;
    const m = EMBEDDED.exec(line);
    if (!m) continue;
    const name = m[1].split("|")[0].split("#")[0].trim();
    const short = name.slice(name.lastIndexOf("/") + 1).trim();
    if (short) out.push(short);
  }
  return out;
}

// key — по чему ищем файл. Одно и то же имя приходит из двух источников: из
// текста доски и из файловой системы, — а буквы с диакритикой они хранят
// по-разному (в macOS-ваулте «й» бывает разложена на «и» и знак краткости).
// Приводим к одному виду, заодно снимая разницу в регистре.
function key(name) {
  return name.normalize("NFC").trim().toLowerCase();
}

// indexFolder — что человек выбрал папкой: имя файла → сам файл. Одноимённые
// файлы в разных папках ваулта — норма, берём первый: какой из них имела в
// виду доска, по имени не отличить.
export function indexFolder(files) {
  const byName = new Map();
  for (const f of files) {
    const k = key(f.name);
    if (!byName.has(k)) byName.set(k, f);
  }
  return byName;
}

export function lookupFile(index, name) {
  return index.get(key(name)) || null;
}

// noteFileFor — заметка ваулта по названию: «Кладбище» → «Кладбище.md».
export function noteFileFor(index, title) {
  return lookupFile(index, title + ".md");
}

// titleOf — как назовётся запись журнала. У Obsidian имя файла и есть
// название заметки, и связь у нас именно по названию — значит заголовок
// внутри текста трогать нельзя, иначе ссылка с доски не найдёт запись.
export function titleOf(fileName) {
  return fileName.replace(/\.md$/i, "");
}

// noteContent приводит текст заметки к тому, что ждёт журнал. Название он
// берёт из первой строки, и только если та начинается с решётки (см.
// noteTitleFromContent в notes/markdown.js) — а у заметки Obsidian сверху
// обычно шапка YAML, после которой заголовка может не быть вовсе.
//
// Название обязано совпасть с именем файла: связь доски с записью идёт
// именно по нему.
export function noteContent(title, text) {
  let body = text.replace(/^\ufeff/, "");
  // Шапка YAML — свойства заметки для самого Obsidian, журналу они ни к чему.
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(body);
  if (fm) body = body.slice(fm[0].length);
  body = body.trimStart();
  if (body.split("\n", 1)[0].trim() === "# " + title) return body;
  return "# " + title + "\n\n" + body;
}
