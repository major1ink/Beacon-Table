package theme

import (
	"encoding/json"
	"strings"
	"testing"
	"testing/fstest"
)

func moduleFS() fstest.MapFS {
	return fstest.MapFS{
		"assets/fonts/title.woff2": {Data: []byte("font")},
		"assets/img/bg.png":        {Data: []byte("png")},
		"theme/sheet.css": {Data: []byte(`
/* заголовок листа */
:scope { border-radius: 4px }
.stat-table th, .card-sub { color: #c9a227; background: url("/module-assets/rules/img/bg.png") }
@media (max-width: 600px) { .stat-table { font-size: 12px } }
`)},
	}
}

func TestParse(t *testing.T) {
	spec, err := Parse(json.RawMessage(`{"vars":{"accent":"#a83a32","radius":"6px","bg":"rgb(10, 10, 12)"},"fonts":[{"family":"Заголовок","file":"fonts/title.woff2","weight":600}],"display":"Заголовок","styles":["theme/sheet.css"]}`))
	if err != nil || spec == nil || spec.Vars["accent"] != "#a83a32" {
		t.Fatalf("годная тема: %+v %v", spec, err)
	}
	if spec, err := Parse(nil); spec != nil || err != nil {
		t.Fatalf("пустая тема: %v %v", spec, err)
	}
	bad := map[string]string{
		"чужая переменная": `{"vars":{"font-size":"12px"}}`,
		"цвет не цвет":     `{"vars":{"accent":"red; background:url(x)"}}`,
		"длина не длина":   `{"vars":{"radius":"100%"}}`,
		"лишнее поле":      `{"script":"x.js"}`,
		"чужой шрифт":      `{"fonts":[{"family":"A","file":"../x.woff2"}]}`,
		"ttf":              `{"fonts":[{"family":"A","file":"fonts/a.ttf"}]}`,
		"имя шрифта":       `{"fonts":[{"family":"A\"; x","file":"fonts/a.woff2"}]}`,
		"начертание":       `{"fonts":[{"family":"A","file":"fonts/a.woff2","weight":650}]}`,
		"display":          `{"display":"Нет"}`,
		"диапазон":         `{"fonts":[{"family":"A","file":"fonts/a.woff2","unicodeRange":"U+0400; color:red"}]}`,
		"стиль":            `{"styles":["../x.css"]}`,
		"много стилей":     `{"styles":["theme/a.css","theme/b.css","theme/c.css","theme/d.css","theme/e.css"]}`,
	}
	for name, raw := range bad {
		if _, err := Parse(json.RawMessage(raw)); err == nil {
			t.Errorf("%s: ожидали ошибку", name)
		}
	}
}

func TestRender(t *testing.T) {
	spec, err := Parse(json.RawMessage(`{"vars":{"accent":"#a83a32"},"fonts":[{"family":"Заголовок","file":"fonts/title.woff2","weight":600}],"display":"Заголовок","styles":["theme/sheet.css"]}`))
	if err != nil {
		t.Fatal(err)
	}
	css, err := Render("rules", spec, moduleFS(), "assets")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`@font-face{font-family:"Заголовок";src:url("/module-assets/rules/fonts/title.woff2") format("woff2");font-weight:600`,
		`html:root{--accent:#a83a32;--font-serif:"Заголовок",Georgia`,
		`html .card-root,html .sheet-root{border-radius:4px;}`,
		`html .card-root .stat-table th,html .sheet-root .stat-table th,html .card-root .card-sub,html .sheet-root .card-sub{color:#c9a227;background:url("/module-assets/rules/img/bg.png");}`,
		`@media (max-width: 600px){html .card-root .stat-table`,
	} {
		if !strings.Contains(css, want) {
			t.Errorf("в CSS нет %q:\n%s", want, css)
		}
	}
	if strings.Contains(css, "заголовок листа") {
		t.Error("комментарий не вырезан")
	}
	if s, err := Render("rules", nil, moduleFS(), "assets"); s != "" || err != nil {
		t.Fatalf("без темы: %q %v", s, err)
	}
}

func TestRenderMissingFiles(t *testing.T) {
	for name, raw := range map[string]string{
		"нет шрифта": `{"fonts":[{"family":"A","file":"fonts/none.woff2"}]}`,
		"нет стиля":  `{"styles":["theme/none.css"]}`,
	} {
		spec, err := Parse(json.RawMessage(raw))
		if err != nil {
			t.Fatal(name, err)
		}
		if _, err := Render("rules", spec, moduleFS(), "assets"); err == nil {
			t.Errorf("%s: ожидали ошибку", name)
		}
	}
}

func TestSanitizeRejects(t *testing.T) {
	bad := map[string]string{
		"@import":           `@import url("/x.css");`,
		"@keyframes":        `@keyframes a { from {color:red} to {color:blue} }`,
		"вложенный @media":  `@media (min-width:1px) { @media (min-width:2px) { .a { color:red } } }`,
		"внешний url":       `.a { background: url(https://evil.example/x.png) }`,
		"чужой модуль":      `.a { background: url("/module-assets/other/img/bg.png") }`,
		"нет файла":         `.a { background: url("/module-assets/rules/img/none.png") }`,
		"выход из папки":    `.a { background: url("/module-assets/rules/../x.png") }`,
		"data":              `.a { background: url(data:image/png;base64,AAAA) }`,
		"url без закрытия":  `.a { background: url(/module-assets/rules/img/bg.png }`,
		"image-set":         `.a { background: image-set("/module-assets/rules/img/bg.png" 1x) }`,
		"fixed":             `.a { position: fixed; inset: 0 }`,
		"sticky":            `.a { position:STICKY }`,
		"z-index":           `.a { z-index: 99999 }`,
		"escape":            `.a { color: \72 ed }`,
		"expression":        `.a { width: expression(alert(1)) }`,
		"behavior":          `.a { behavior: url(x.htc) }`,
		"вложенное правило": `.a { color: red; .b { color: blue } }`,
		"лишняя скобка":     `.a { color: red } }`,
		"не закрыта":        `.a { color: red`,
		"комментарий":       `.a { color: red } /* вечный`,
		"селектор":          `.a; .b { color: red }`,
		"html в селекторе":  `.a<script> { color: red }`,
		"@font-face prop":   `@font-face { font-family: A; color: red }`,
		"@font-face media":  `@media (min-width:1px) { @font-face { font-family: A } }`,
		"@media условие":    `@media screen and (min-width: 1px) { .a { color: red } } @media ; { }`,
		"объявление":        `.a { color }`,
		"свойство":          `.a { 1color: red }`,
		"длинное значение":  `.a { content: "` + strings.Repeat("x", 600) + `" }`,
	}
	for name, css := range bad {
		if out, err := Sanitize(css, "rules", moduleFS(), "assets"); err == nil {
			t.Errorf("%s: принято: %q", name, out)
		}
	}
}

func TestSanitizeAccepts(t *testing.T) {
	good := map[string]string{
		"псевдо":     `.a:hover > .b + .c ~ .d[data-x="1"]::before { content: "—" }`,
		"scope":      `:scope .x { color: var(--accent) }`,
		"кавычки":    `.a { font-family: "A; B", serif }`,
		"important":  `.a { color: red !important }`,
		"font-face":  `@font-face { font-family: Local; src: url("/module-assets/rules/fonts/title.woff2") format("woff2"); font-weight: 600 }`,
		"пустое":     ``,
		"только ком": `/* пусто */`,
		"absolute":   `.a { position: absolute; top: 0 }`,
	}
	for name, css := range good {
		if _, err := Sanitize(css, "rules", moduleFS(), "assets"); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestSanitizeScopesEverySelector(t *testing.T) {
	css, err := Sanitize(`.a, .b:is(.c, .d) { color: red } @media (min-width: 1px) { .e { color: blue } }`, "rules", nil, "assets")
	if err != nil {
		t.Fatal(err)
	}
	want := `html .card-root .a,html .sheet-root .a,html .card-root .b:is(.c, .d),html .sheet-root .b:is(.c, .d){color:red;}` + "\n" +
		`@media (min-width: 1px){html .card-root .e,html .sheet-root .e{color:blue;}` + "\n}\n"
	if css != want {
		t.Fatalf("получили:\n%q\nожидали:\n%q", css, want)
	}
}

func TestPreview(t *testing.T) {
	spec, _ := Parse(json.RawMessage(`{"vars":{"accent":"#a83a32","radius":"6px","gold":"#c9a227"}}`))
	p := spec.Preview()
	if len(p) != 2 || p["accent"] != "#a83a32" || p["gold"] != "#c9a227" {
		t.Fatalf("превью: %v", p)
	}
	if (*Spec)(nil).Preview() != nil {
		t.Fatal("превью без темы")
	}
}

func TestRenderUnicodeRange(t *testing.T) {
	spec, err := Parse(json.RawMessage(`{"fonts":[{"family":"Заголовок","file":"fonts/title.woff2","unicodeRange":"U+0400-045F, U+0490-0491"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	css, err := Render("rules", spec, moduleFS(), "assets")
	if err != nil || !strings.Contains(css, ";unicode-range:U+0400-045F, U+0490-0491}") {
		t.Fatalf("%q %v", css, err)
	}
}
