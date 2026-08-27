package foundry

import (
	"context"
	"fmt"
	"html"
	"regexp"
	"strings"

	"beacon-table/internal/domain"
)

// MapJournal — документ JournalEntry в текст заметки ДМ (domain.Note).
// Заметки у нас markdown, а страницы журнала — готовый HTML; смешивать их
// можно: тот же marked, что рендерит заметки, пропускает HTML как есть (см.
// web/src/notes/markdown.js). Поэтому заголовок записи и заголовки страниц
// пишем markdown-ом (первый "# " ещё и становится названием заметки, см.
// notefile.deriveTitle), а содержимое страниц вставляем как пришло.
//
// Одна запись журнала = одна заметка, страницы идут подряд разделами: делить
// на заметку-на-страницу означало бы потерять их порядок и принадлежность —
// папка у заметки одна на всю запись (см. Journal.Folder).
type Journal struct {
	// Folder — папка библиотеки заметок (см. domain.Note.Folder): модуль,
	// компендиум и дерево папок самого модуля, см. NoteFolder.
	Folder string
	// Title — заголовок записи. Он же первой строкой в Content ("# …", см.
	// notefile.deriveTitle) — отдельным полем, потому что по нему клиент
	// ищет, не лежит ли такая заметка в этой папке уже.
	Title   string
	Content string
}

// MapJournal переводит документ JournalEntry в заметку. folder — куда её
// класть (см. NoteFolder), пусто — в корень библиотеки.
func MapJournal(ctx context.Context, d Doc, folder string, assets *Assets) Journal {
	title := strings.TrimSpace(asString(d["name"]))
	if title == "" {
		title = "Запись из Foundry"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "# %s\n", title)

	pages := asSlice(d["pages"])
	if len(pages) == 0 {
		// v9 и раньше: у записи не было страниц, текст лежал одним полем.
		if content := asString(d["content"]); content != "" {
			b.WriteString("\n")
			b.WriteString(rewriteCallouts(assets.RewriteHTML(ctx, domain.AssetKindNotes, content)))
			b.WriteString("\n")
		}
		return Journal{Folder: folder, Title: title, Content: b.String()}
	}

	for _, raw := range pages {
		page := asMap(raw)
		if page == nil {
			continue
		}
		if name := strings.TrimSpace(asString(page["name"])); name != "" && name != title {
			fmt.Fprintf(&b, "\n## %s\n", name)
		}
		b.WriteString("\n")
		b.WriteString(pageBody(ctx, page, assets))
		b.WriteString("\n")
	}
	return Journal{Folder: folder, Title: title, Content: b.String()}
}

// calloutRe — заметная врезка в тексте страницы: <section>/<aside> со
// своим классом. В модулях и системе dnd5e это «читать вслух» игрокам
// (fvtt narrative), советы Мастеру (fvtt advice) и боковые вставки
// (notable) — их рисует CSS системы, которого в Beacon Table нет.
var calloutRe = regexp.MustCompile(`(?i)<(section|aside)\s+class="([^"]*)"`)

// rewriteCallouts переводит классы врезок Foundry в наши, которые стилизует
// .note-render (см. web/journal.html, note-window.html, dm.html): фон +
// полоса слева, как в книгах-приключениях. Незнакомый класс не трогаем.
func rewriteCallouts(htmlText string) string {
	if !strings.Contains(htmlText, "class=") {
		return htmlText
	}
	return calloutRe.ReplaceAllStringFunc(htmlText, func(m string) string {
		sub := calloutRe.FindStringSubmatch(m)
		tag, cls := sub[1], strings.ToLower(sub[2])
		switch {
		case strings.Contains(cls, "narrative"):
			return "<" + tag + ` class="beacon-readaloud"`
		case strings.Contains(cls, "advice"), strings.Contains(cls, "notable"):
			return "<" + tag + ` class="beacon-dm-note"`
		default:
			return m
		}
	})
}

// pageBody — содержимое одной страницы по её типу. Видео/PDF проигрываются прямо в заметке .
func pageBody(ctx context.Context, page map[string]any, assets *Assets) string {
	switch strings.ToLower(asString(page["type"])) {
	case "image":
		ref := asString(page["src"])
		src := assets.URL(ctx, domain.AssetKindNotes, ref)
		caption := asString(page["image"])
		if m := asMap(page["image"]); m != nil {
			caption = asString(m["caption"])
		}
		if src == "" {
			return missingFileNote("иллюстрация не перенесена", ref)
		}
		return fmt.Sprintf("![%s](%s)", caption, src)
	case "video":
		ref := asString(page["src"])
		src := assets.URL(ctx, domain.AssetKindNotes, ref)
		if src == "" {
			return missingFileNote("видео не перенесено", ref)
		}
		esc := html.EscapeString(src)

		return fmt.Sprintf(
			`<video controls preload="metadata" style="max-width:100%%;border-radius:8px"><source src="%s">Видео не открылось — <a href="%s">скачать файл</a>.</video>`,
			esc, esc,
		)
	case "pdf":
		ref := asString(page["src"])
		src := assets.URL(ctx, domain.AssetKindNotes, ref)
		if src == "" {
			return missingFileNote("файл не перенесён", ref)
		}
		esc := html.EscapeString(src)
		return fmt.Sprintf(
			`<iframe src="%s" style="width:100%%;height:70vh;border:1px solid var(--border);border-radius:8px"></iframe>`+"\n\n"+`[Открыть PDF в отдельной вкладке](%s)`,
			esc, src,
		)
	default:
		return rewriteCallouts(assets.RewriteHTML(ctx, domain.AssetKindNotes, digString(page, "text", "content")))
	}
}

// missingFileNote — след от страницы, чей файл не нашёлся в архиве модуля
// (ссылка на арт, который модуль не распространяет, или на ассет самого
// Foundry). Пустой раздел с одним заголовком выглядит как поломка импорта —
// пусть в тексте будет видно, чего именно не хватает и откуда оно бралось.
func missingFileNote(phrase, ref string) string {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return fmt.Sprintf("*(%s — в модуле не указан файл)*", phrase)
	}
	return fmt.Sprintf("*(%s — в архиве модуля нет файла `%s`)*", phrase, ref)
}
