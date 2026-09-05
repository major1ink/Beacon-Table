package excalidraw

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// file.go — конверт .excalidraw.md, в котором плагин Excalidraw для Obsidian
// держит рисунок. Файл устроен так:
//
//	---
//	excalidraw-plugin: parsed
//	tags: [excalidraw]
//	---
//	==⚠  Switch to EXCALIDRAW VIEW… ⚠==
//
//	# Excalidraw Data
//
//	## Text Elements
//	Текст подписи ^rk8Hl4ee
//
//	## Embedded Files
//	9c9ad8d5…: [[Древо общий вид.png]]
//
//	%%
//	## Drawing
//	```compressed-json
//	N4KAkARALgngDgUwgLgAQQQDwMYEMA2AlgCYBOuA7hADTgQBuCpAzoQPYB2KqATLZMzYBXUt…
//	```
//	%%
//
// Что здесь важно понимать:
//
//   - «## Text Elements» — не источник истины, а ДУБЛИКАТ подписей из самого
//     рисунка, выложенный в markdown, чтобы Obsidian их индексировал и
//     находил поиском (это и значит «excalidraw-plugin: parsed»). Читать
//     оттуда нечего, а писать — обязательно, иначе доска перестанет искаться
//     в ваулте.
//   - «## Embedded Files» — связь fileId элемента-картинки с файлом ваулта.
//     Картинки плагин хранит отдельными файлами, а не внутри рисунка: во всех
//     просмотренных файлах Scene.Files пустой.
//   - Блок рисунка бывает и сжатым (```compressed-json, lz-string), и
//     обычным (```json) — плагин умеет и то и другое, у него это тумблер в
//     настройках. Читаем оба, пишем обычный: он диффится по-человечески и в
//     git, и в ваулте.
//   - «%%» вокруг блока — обёртка комментария Obsidian, чтобы простыня
//     данных не лезла в предпросмотр заметки.

// drawingFence ловит блок рисунка любого вида. (?s) — чтобы точка брала
// переводы строк, \r? — потому что файлы бывают и с CRLF (в живом ваулте
// такой нашёлся, и на нём наивный разбор молча не находил рисунка вовсе).
var drawingFence = regexp.MustCompile("(?s)```(compressed-json|json)\r?\n(.*?)\r?\n```")

// embeddedFileLine — строка раздела «## Embedded Files». У плагина это
// «<fileId>: [[файл ваулта]]», у нас — «<fileId>: /uploads/…»: картинки доски
// лежат в загрузках стола, а не в ваулте.
// fileId у плагина — sha1, но завязываться на длину незачем.
var embeddedFileLine = regexp.MustCompile(`^([A-Za-z0-9_.-]+):\s*(\[\[.+?\]\]|\S+)\s*$`)

var whitespace = regexp.MustCompile(`\s+`)

// EmbeddedFile — картинка, лежащая отдельным файлом ваулта.
type EmbeddedFile struct {
	// FileID — то же значение, что в Element.FileID у картинки.
	FileID string
	// Link — вики-ссылка как есть, вместе со скобками: «[[Древо.png]]».
	// Не разбираем на имя: ссылка бывает с путём и с алиасом, а нам её
	// сейчас только сохранять и показывать.
	Link string
}

// Document — разобранный файл целиком.
type Document struct {
	// Frontmatter — шапка БЕЗ разделителей «---», строками как в файле.
	// Хранится сырой: в ней могут лежать чужие ключи (теги, свойства
	// Obsidian), и терять их при перезаписи нельзя.
	Frontmatter string
	// Compressed — был ли рисунок сжат в исходном файле. Нужно только чтобы
	// честно сказать об этом при импорте; пишем мы всегда несжатым.
	Compressed    bool
	EmbeddedFiles []EmbeddedFile
	Scene         *Scene
}

// ParseDocument разбирает .excalidraw.md. Годится и для голого .excalidraw
// (там просто JSON без конверта) — такой файл распознаётся по первому
// непробельному символу.
func ParseDocument(raw string) (*Document, error) {
	raw = strings.TrimPrefix(raw, "\ufeff") // BOM от редактора не должен прятать шапку

	// Голый .excalidraw — обычный JSON без markdown вокруг.
	if trimmed := strings.TrimSpace(raw); strings.HasPrefix(trimmed, "{") {
		scene, err := parseScene(trimmed)
		if err != nil {
			return nil, err
		}
		return &Document{Scene: scene}, nil
	}

	doc := &Document{}
	body := raw
	if fm, rest, ok := splitFrontmatter(raw); ok {
		doc.Frontmatter = fm
		body = rest
	}

	m := drawingFence.FindStringSubmatch(body)
	if m == nil {
		return nil, fmt.Errorf("в файле нет блока рисунка (```json или ```compressed-json)")
	}
	doc.Compressed = m[1] == "compressed-json"

	payload := m[2]
	if doc.Compressed {
		// В файле base64 разложен по строкам для читаемости — склеиваем.
		decoded, err := DecompressFromBase64(whitespace.ReplaceAllString(payload, ""))
		if err != nil {
			return nil, err
		}
		payload = decoded
	}
	scene, err := parseScene(payload)
	if err != nil {
		return nil, err
	}
	doc.Scene = scene
	doc.EmbeddedFiles = parseEmbeddedFiles(body)
	return doc, nil
}

func parseScene(payload string) (*Scene, error) {
	var scene Scene
	if err := json.Unmarshal([]byte(payload), &scene); err != nil {
		return nil, fmt.Errorf("рисунок не разбирается как JSON: %w", err)
	}
	if err := scene.Validate(); err != nil {
		return nil, err
	}
	return &scene, nil
}

// splitFrontmatter отрезает шапку «---…---» в начале файла.
func splitFrontmatter(raw string) (frontmatter, rest string, ok bool) {
	if !strings.HasPrefix(raw, "---\n") && !strings.HasPrefix(raw, "---\r\n") {
		return "", raw, false
	}
	lines := strings.Split(raw, "\n")
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			return strings.Join(lines[1:i], "\n"), strings.Join(lines[i+1:], "\n"), true
		}
	}
	return "", raw, false // незакрытая шапка — считаем, что её нет
}

// parseEmbeddedFiles собирает раздел «## Embedded Files». Разбор построчный,
// а не одним выражением по всему разделу: строки бывают разделены пустыми, а
// сам раздел может отсутствовать или идти в любом порядке с соседями.
func parseEmbeddedFiles(body string) []EmbeddedFile {
	const header = "## Embedded Files"
	idx := strings.Index(body, header)
	if idx < 0 {
		return nil
	}
	section := body[idx+len(header):]
	var out []EmbeddedFile
	for _, line := range strings.Split(section, "\n") {
		line = strings.TrimSpace(strings.TrimRight(line, "\r"))
		if line == "" {
			continue
		}
		// Следующий заголовок или начало блока данных — конец раздела.
		if strings.HasPrefix(line, "#") || strings.HasPrefix(line, "%%") || strings.HasPrefix(line, "```") {
			break
		}
		if m := embeddedFileLine.FindStringSubmatch(line); m != nil {
			out = append(out, EmbeddedFile{FileID: m[1], Link: m[2]})
		}
	}
	return out
}

// Markdown собирает файл обратно. frontmatter — шапка целиком (без «---»),
// её задаёт вызывающий: у доски стола там лежат ещё имя, автор и права (см.
// internal/repository/boardfile), а не только ключи плагина.
//
// Рисунок пишется НЕсжатым: плагин такой файл открывает (сжатие у него —
// тумблер настроек), зато файл остаётся читаемым и нормально диффится.
func (d *Document) Markdown(frontmatter string) (string, error) {
	if d.Scene == nil {
		return "", fmt.Errorf("нечего записывать: сцена пустая")
	}
	payload, err := json.MarshalIndent(d.Scene, "", "\t")
	if err != nil {
		return "", err
	}

	var b strings.Builder
	b.WriteString("---\n")
	if fm := strings.TrimRight(frontmatter, "\n"); fm != "" {
		b.WriteString(fm)
		b.WriteString("\n")
	}
	b.WriteString("---\n")
	b.WriteString("==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==\n\n")
	b.WriteString("# Excalidraw Data\n\n")

	// Подписи — дубликат для поиска Obsidian (см. комментарий вверху файла).
	b.WriteString("## Text Elements\n")
	for _, e := range d.Scene.TextElements() {
		text := e.RawText
		if text == "" {
			text = e.OriginalText
		}
		if text == "" {
			text = e.Text
		}
		b.WriteString(text + " ^" + e.ID + "\n\n")
	}

	if len(d.EmbeddedFiles) > 0 {
		b.WriteString("## Embedded Files\n")
		files := append([]EmbeddedFile(nil), d.EmbeddedFiles...)
		sort.Slice(files, func(i, j int) bool { return files[i].FileID < files[j].FileID })
		for _, f := range files {
			b.WriteString(f.FileID + ": " + f.Link + "\n\n")
		}
	}

	b.WriteString("%%\n## Drawing\n```json\n")
	b.Write(payload)
	b.WriteString("\n```\n%%\n")
	return b.String(), nil
}
