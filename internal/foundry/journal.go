package foundry

import (
	"context"
	"fmt"
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
// на заметку-на-страницу означало бы потерять их порядок и принадлежность
// (у нас нет папок для заметок, только плоский список).
func MapJournal(ctx context.Context, d Doc, assets *Assets) string {
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
			b.WriteString(assets.RewriteHTML(ctx, domain.AssetKindNotes, content))
			b.WriteString("\n")
		}
		return b.String()
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
	return b.String()
}

// pageBody — содержимое одной страницы по её типу. Видео/PDF/встроенные
// документы отдельного представления у заметки не имеют — от них остаётся
// ссылка, чтобы ДМ хотя бы видел, что там было.
func pageBody(ctx context.Context, page map[string]any, assets *Assets) string {
	switch strings.ToLower(asString(page["type"])) {
	case "image":
		src := assets.URL(ctx, domain.AssetKindNotes, asString(page["src"]))
		caption := asString(page["image"])
		if m := asMap(page["image"]); m != nil {
			caption = asString(m["caption"])
		}
		if src == "" {
			return ""
		}
		return fmt.Sprintf("![%s](%s)", caption, src)
	case "video", "pdf":
		src := assets.URL(ctx, domain.AssetKindNotes, asString(page["src"]))
		if src == "" {
			return ""
		}
		return fmt.Sprintf("[%s](%s)", asString(page["name"]), src)
	default:
		return assets.RewriteHTML(ctx, domain.AssetKindNotes, digString(page, "text", "content"))
	}
}
