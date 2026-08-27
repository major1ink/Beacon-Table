package foundry

import (
	"html"
	"regexp"
	"strings"
)

// Перекрёстные ссылки внутри текстов модуля. В Foundry ссылка на другой
// документ пишется макросом-«обогатителем»:
//
//	@UUID[Compendium.пакет.пак.JournalEntry.abc123]{Правила перемещения}
//	@UUID[Compendium.пакет.пак.JournalEntry.abc.JournalEntryPage.def]{Раздел}
//	@Embed[Compendium.пакет.пак.JournalEntry.abc.JournalEntryPage.def inline]
//	@Compendium[пакет.пак.abc123]{Огненный шар}   (v9 и раньше)
//
// Вне Foundry это просто мусор в тексте — ровно то, что ДМ и видел в
// импортированных заметках. Здесь макросы превращаются в ссылки Beacon Table
// на те же документы, если они тоже приехали импортом: в разметку
// .catalog-ref, которую клиент уже умеет открывать (см.
// web/src/catalog-links.js — тот же приём, что и у карточек «из коробки»).
//
// Ссылка резолвится ПО ИМЕНИ на клике, а не по id: карточки создаются в
// библиотеке со своими id, и знать их на момент импорта нельзя (часть
// импорта вообще делает клиент). Поэтому в разметку кладём вид документа и
// имя цели, а для заметок ещё и папку — имена в дереве повторяются.
//
// Чего этот перевод НЕ делает: @Embed не вставляет содержимое другого
// документа в текст (в Foundry он именно вставляет) — вместо этого остаётся
// ссылка на него. Дублировать чужой текст в десяток заметок ради вида «как в
// Foundry» дороже, чем один переход.

// enricherRe — макрос-обогатитель: @Тип[цель]{подпись}. Подпись
// необязательна (у @Embed её обычно нет). Внутри скобок у @Embed после uuid
// идут опции через пробел ("... inline"), их отрезаем при разборе.
var enricherRe = regexp.MustCompile(`@(UUID|Embed|Compendium|Item|Actor|JournalEntry|Scene|RollTable|Macro)\[([^\]]*)\](?:\{([^}]*)\})?`)

// LinkTarget — на что указывает ссылка после резолва по индексу модуля.
type LinkTarget struct {
	// Kind — раздел стола: "note" | "item" | "spell" | "reference" |
	// "monster" | "scene" | "playlist". Пусто — цель есть в модуле, но
	// переносить её некуда (таблица, макрос, отдельный звук плейлиста), от
	// ссылки останется только подпись.
	Kind string
	Name string
	// Folder — папка библиотеки заметок (только для Kind == "note").
	Folder string
	// Section — имя страницы журнала, если ссылка вела на страницу. Страницы
	// у нас не отдельные заметки, а разделы одной (см. MapJournal), поэтому
	// ссылка ведёт на всю заметку, а имя раздела идёт подписью.
	Section string
}

// LinkIndex — «id документа модуля → куда он приехал». Ключ — именно id
// документа Foundry: он последний сегмент любой формы ссылки (полный UUID
// v11, короткий Compendium-путь v9, ссылка на страницу журнала), так что
// разбирать все формы по отдельности не нужно.
type LinkIndex struct {
	targets map[string]LinkTarget
}

// BuildLinkIndex обходит ВСЕ паки модуля: ссылка из одного компендиума на
// другой — обычное дело (правила ссылаются на заклинания, бестиарий на
// правила), и построить индекс по одному паку недостаточно.
func BuildLinkIndex(mod *Module, moduleTitle string) *LinkIndex {
	ix := &LinkIndex{targets: make(map[string]LinkTarget, 256)}
	for _, p := range mod.Packs() {
		contents, err := mod.ReadPack(p)
		if err != nil {
			continue // нечитаемый пак не должен ронять ссылки в остальных
		}
		packLabel := p.Label
		if packLabel == "" {
			packLabel = p.Name
		}
		for _, e := range Expand(contents.Docs, p.DocType()) {
			ix.add(e, contents.Folders, moduleTitle, packLabel)
		}
	}
	return ix
}

func (ix *LinkIndex) add(e Entry, folders *Folders, moduleTitle, packLabel string) {
	id := asString(e.Doc["_id"])
	name := strings.TrimSpace(asString(e.Doc["name"]))
	if id == "" || name == "" {
		return
	}
	switch e.Target {
	case TargetNotes:
		target := LinkTarget{
			Kind:   "note",
			Name:   name,
			Folder: NoteFolder(moduleTitle, packLabel, folders.Path(DocFolderID(e.Doc))),
		}
		ix.targets[id] = target
		// Страницы журнала адресуются своим id — ведём их на ту же заметку.
		for _, raw := range asSlice(e.Doc["pages"]) {
			page := asMap(raw)
			pageID := asString(page["_id"])
			if pageID == "" {
				continue
			}
			withSection := target
			withSection.Section = strings.TrimSpace(asString(page["name"]))
			ix.targets[pageID] = withSection
		}
	case TargetItems, TargetSpells, TargetReferences, TargetMonsters, TargetScenes, TargetPlaylists:
		ix.targets[id] = LinkTarget{Kind: cardKind(e.Target), Name: name}
	default:
		ix.targets[id] = LinkTarget{Name: name} // цель известна, но переносить её некуда
	}
}

// cardKind — раздел импорта → data-kind разметки .catalog-ref.
func cardKind(target string) string {
	switch target {
	case TargetItems:
		return "item"
	case TargetSpells:
		return "spell"
	case TargetReferences:
		return "reference"
	case TargetMonsters:
		return "monster"
	case TargetScenes:
		return "scene"
	case TargetPlaylists:
		return "playlist"
	default:
		return ""
	}
}

// Lookup — цель по id документа Foundry.
func (ix *LinkIndex) Lookup(id string) (LinkTarget, bool) {
	if ix == nil {
		return LinkTarget{}, false
	}
	t, ok := ix.targets[id]
	return t, ok
}

// Rewrite переводит в тексте ВСЕ макросы Foundry: ссылки на документы — в
// ссылки Beacon Table (ниже), инлайн-броски — в обычный текст формулы или
// фразу проверки (см. RewriteRolls). Цель ссылки не нашлась (непереносимый
// документ, другой модуль, документ мира) — остаётся только подпись: лучше
// просто текст, чем «@UUID[Compendium.…]» посреди абзаца.
func (ix *LinkIndex) Rewrite(text string) string {
	return ix.rewriteWithName(text, "")
}

// rewriteWithName — то же, что Rewrite, но обогатитель [[lookup @name]]
// подставляет переданное имя документа (см. rolls.go: lookupValue). Пустое
// name = поведение Rewrite (макрос сворачивается в свою подпись).
func (ix *LinkIndex) rewriteWithName(text, name string) string {
	return rewriteRollsNamed(ix.rewriteLinks(text), name)
}

func (ix *LinkIndex) rewriteLinks(text string) string {
	if !strings.Contains(text, "@") {
		return text
	}
	return enricherRe.ReplaceAllStringFunc(text, func(match string) string {
		parts := enricherRe.FindStringSubmatch(match)
		if parts == nil {
			return match
		}
		ref, label := parts[2], strings.TrimSpace(parts[3])
		target, ok := ix.Lookup(refID(ref))
		if !ok {
			return html.EscapeString(label)
		}
		if label == "" {
			label = target.Section
		}
		if label == "" {
			label = target.Name
		}
		return anchor(target, label)
	})
}

// refID — id документа из любой формы ссылки: последний сегмент пути через
// точку. Опции @Embed ("… inline", "… caption=…") идут после пробела —
// отрезаем их первыми.
func refID(ref string) string {
	ref = strings.TrimSpace(ref)
	if space := strings.IndexAny(ref, " \t"); space != -1 {
		ref = ref[:space]
	}
	ref = strings.Trim(ref, ".")
	if dot := strings.LastIndex(ref, "."); dot != -1 {
		return ref[dot+1:]
	}
	return ref
}

// anchor — разметка ссылки, которую понимает web/src/catalog-links.js.
func anchor(target LinkTarget, label string) string {
	if target.Kind == "" {
		return html.EscapeString(label)
	}
	attrs := `class="catalog-ref" data-kind="` + target.Kind + `" data-name="` + html.EscapeString(target.Name) + `"`
	if target.Kind == "note" && target.Folder != "" {
		attrs += ` data-folder="` + html.EscapeString(target.Folder) + `"`
	}
	// Ссылка вела на страницу журнала — у нас это раздел внутри заметки
	// (см. MapJournal): открываем заметку и подсвечиваем нужный раздел, а не
	// бросаем читателя в начало длинного текста.
	if target.Section != "" {
		attrs += ` data-section="` + html.EscapeString(target.Section) + `"`
	}
	return "<a " + attrs + ">" + html.EscapeString(label) + "</a>"
}

// RewriteDocMacros проходит по всем строкам документа и переводит найденные в
// них макросы. Именно по всем: описания в схеме dnd5e лежат в разных местах
// (system.description.value, system.unidentified.description, тексты
// эффектов, страницы журнала), и перечислять их поимённо — гарантированно
// что-нибудь забыть.
func RewriteDocMacros(doc Doc, ix *LinkIndex) {
	if ix == nil {
		return
	}
	// Имя документа верхнего уровня — для обогатителя [[lookup @name]] в
	// описаниях его же способностей ("[[lookup @name]] совершает действие …").
	// У владеемых предметов актёра @name в данных броска — это имя АКТЁРА, а
	// не предмета, поэтому имя берём здесь один раз и несём вглубь.
	name := strings.TrimSpace(asString(map[string]any(doc)["name"]))
	rewriteValue(map[string]any(doc), ix, name, 0)
}

func rewriteValue(node any, ix *LinkIndex, name string, depth int) {
	if depth > 12 {
		return // защита от неожиданно глубокой вложенности чужого документа
	}
	switch v := node.(type) {
	case map[string]any:
		for key, value := range v {
			if s, ok := value.(string); ok {
				v[key] = ix.rewriteWithName(s, name)
				continue
			}
			rewriteValue(value, ix, name, depth+1)
		}
	case []any:
		for i, value := range v {
			if s, ok := value.(string); ok {
				v[i] = ix.rewriteWithName(s, name)
				continue
			}
			rewriteValue(value, ix, name, depth+1)
		}
	}
}
