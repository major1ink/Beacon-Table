// Очистка чужой разметки (см. web/src/html.js): тексты от игроков и из
// модулей Foundry попадают в innerHTML.
import test from "node:test";
import assert from "node:assert/strict";

import { sanitizeHtml, escapeHtml, safeUrl, cssUrl } from "../src/html.js";

test("скрипт выкидывается вместе с содержимым, текст рядом остаётся", () => {
  assert.equal(sanitizeHtml("<script>alert(1)</script>привет"), "привет");
  assert.equal(sanitizeHtml("<STYLE>body{display:none}</STYLE>ok"), "ok");
});

test("обработчики событий не переживают очистку", () => {
  assert.equal(sanitizeHtml('<img src="/uploads/a.png" onerror="alert(1)">'), '<img src="/uploads/a.png" />');
  assert.equal(sanitizeHtml('<p onclick=alert(1) class="ok">п</p>'), '<p class="ok">п</p>');
});

test("svg и iframe не проходят даже в обход разбора атрибутов", () => {
  assert.equal(sanitizeHtml("<svg/onload=alert(1)>"), "");
  assert.equal(sanitizeHtml('<iframe src="https://evil"></iframe>'), "");
  assert.equal(sanitizeHtml('<img src="x" onerror="alert(1)"'), "");
});

test("javascript-ссылка остаётся видимой, но никуда не ведёт", () => {
  assert.equal(sanitizeHtml('<a href="javascript:alert(1)">клик</a>'), '<a href="#">клик</a>');
  // Браузер декодирует мнемоники сам, поэтому проверка идёт по декодированному.
  assert.equal(sanitizeHtml('<a href="jav&#x61;script:alert(1)">клик</a>'), '<a href="#">клик</a>');
});

test("оформление текста приключения не теряется", () => {
  assert.equal(
    sanitizeHtml('<a class="catalog-ref" data-kind="item" data-name="Меч">Меч</a>'),
    '<a class="catalog-ref" data-kind="item" data-name="Меч">Меч</a>'
  );
  assert.equal(sanitizeHtml('<aside class="beacon-readaloud">врезка</aside>'), '<aside class="beacon-readaloud">врезка</aside>');
  assert.equal(sanitizeHtml('<table><tr><td colspan="2">я</td></tr></table>'), '<table><tr><td colspan="2">я</td></tr></table>');
  assert.equal(sanitizeHtml('<IMG SRC="/uploads/a.png" ALT="кот">'), '<img src="/uploads/a.png" alt="кот" />');
});

test("внешняя ссылка в новой вкладке получает rel", () => {
  assert.equal(
    sanitizeHtml('<a href="https://example.com" target="_blank">сайт</a>'),
    '<a href="https://example.com" target="_blank" rel="noopener noreferrer">сайт</a>'
  );
});

test("угловые скобки в тексте не становятся тегом", () => {
  assert.equal(sanitizeHtml("a < b и 5 > 3"), "a &lt; b и 5 > 3");
  assert.equal(sanitizeHtml('<p title="1 > 2">текст</p>'), '<p title="1 &gt; 2">текст</p>');
});

test("картинки: только настоящие изображения", () => {
  assert.equal(sanitizeHtml('<img src="data:image/png;base64,AAAA">'), '<img src="data:image/png;base64,AAAA" />');
  assert.equal(sanitizeHtml('<img src="data:text/html;base64,PHNjcmlwdD4=">'), "");
});

test("safeUrl пропускает свои адреса и отсекает чужие схемы", () => {
  assert.equal(safeUrl("/uploads/maps/a.png"), "/uploads/maps/a.png");
  assert.equal(safeUrl("#раздел"), "#раздел");
  assert.equal(safeUrl("https://beacontable.ru/"), "https://beacontable.ru/");
  assert.equal(safeUrl("wikilink:%D0%A2%D0%B0%D0%B2%D0%B5%D1%80%D0%BD%D0%B0"), "wikilink:%D0%A2%D0%B0%D0%B2%D0%B5%D1%80%D0%BD%D0%B0");
  assert.equal(safeUrl("javascript:alert(1)"), "");
  assert.equal(safeUrl("java\nscript:alert(1)"), "");
  assert.equal(safeUrl("vbscript:msgbox"), "");
});

test("cssUrl не выпускает кавычку из значения свойства", () => {
  assert.equal(cssUrl("/uploads/tokens/a.png"), 'url("/uploads/tokens/a.png")');
  assert.equal(cssUrl('");background:url(evil)'), 'url("\\");background:url(evil)")');
  assert.equal(cssUrl("javascript:alert(1)"), "none");
  assert.equal(cssUrl(""), "none");
});

test("escapeHtml закрывает и кавычки — значение подставляют в атрибут", () => {
  assert.equal(escapeHtml('<b>"x"</b>'), "&lt;b&gt;&quot;x&quot;&lt;/b&gt;");
  assert.equal(escapeHtml(null), "");
});
