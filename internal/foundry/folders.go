package foundry

import (
	"strings"
)

// Папки компендиума. В Foundry (с v11) документ Folder — такая же запись
// пака, как журнал или предмет, только с ключом "!folders!ID" и ссылкой на
// родителя в поле folder. Дерево из них нужно ровно затем, зачем оно нужно
// ДМ: журналы модуля разложены по главам, и в библиотеке заметок они должны
// лечь так же (см. domain.Note.Folder и NoteFolder ниже).

// maxFolderDepth — на сколько уровней вглубь разворачиваем дерево модуля.
// Совпадает с пределом библиотеки заметок (см. service.maxNoteFolderDepth):
// два верхних уровня занимают модуль и компендиум, остальное — папки самого
// модуля; всё, что глубже, схлопывается в последнюю папку, а не теряется.
const maxFolderDepth = 8

// Folders — папки одного компендиума: id → путь от корня пака ("Глава 1/NPC").
type Folders struct {
	paths map[string]string
}

// Path — путь папки по её id; "" для неизвестного id и для корня пака.
func (f *Folders) Path(id string) string {
	if f == nil || id == "" {
		return ""
	}
	return f.paths[id]
}

// splitFolders разделяет прочитанный пак на содержимое и дерево папок.
func splitFolders(docs []Doc) ([]Doc, *Folders) {
	content := make([]Doc, 0, len(docs))
	raw := make(map[string]Doc, 8)
	for _, d := range docs {
		if isFolderDoc(d) {
			if id := asString(d["_id"]); id != "" {
				raw[id] = d
			}
			continue
		}
		content = append(content, d)
	}
	return content, buildFolders(raw)
}

// isFolderDoc — документ пака описывает папку, а не запись. Надёжный
// признак — служебный ключ ("!folders!ID"), он есть и у LevelDB-паков (см.
// readLevelDB), и у извлечённых fvtt-cli json. Запасной — форма документа:
// у папки есть sorting/sort и нет ни system, ни pages.
func isFolderDoc(d Doc) bool {
	if strings.HasPrefix(asString(d["_key"]), "!folders!") {
		return true
	}
	return d["sorting"] != nil && d["system"] == nil && d["pages"] == nil && d["name"] != nil
}

// buildFolders собирает пути, поднимаясь от каждой папки к родителям.
// Циклы (битый пак, где папка сама себе предок) обрываются по глубине.
func buildFolders(raw map[string]Doc) *Folders {
	paths := make(map[string]string, len(raw))
	for id := range raw {
		segments := make([]string, 0, 4)
		for cur, depth := id, 0; cur != "" && depth < maxFolderDepth; depth++ {
			doc, ok := raw[cur]
			if !ok {
				break
			}
			name := folderSegment(asString(doc["name"]))
			if name != "" {
				segments = append([]string{name}, segments...)
			}
			cur = parentFolderID(doc)
		}
		paths[id] = strings.Join(segments, "/")
	}
	return &Folders{paths: paths}
}

// DocFolderID — в какой папке компендиума лежит документ ("" — в корне).
// Экспортируется для вызывающего, который сопоставляет документ с деревом
// (см. service.FoundryService.ImportPack).
func DocFolderID(doc Doc) string { return parentFolderID(doc) }

// parentFolderID — ссылка на родительскую папку. В v11+ это строка id, в
// более старых дампах иногда встречается вложенный объект.
func parentFolderID(doc Doc) string {
	switch parent := doc["folder"].(type) {
	case string:
		return parent
	case map[string]any:
		return asString(parent["_id"])
	default:
		return ""
	}
}

// folderSegment — имя папки, пригодное для имени каталога на диске (папки
// библиотеки заметок — настоящие каталоги, см. internal/repository/notefile).
// Слэш внутри имени модульной папки не должен превращаться во вложенность,
// а служебные символы Windows — ломать создание каталога.
func folderSegment(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return ""
	}
	name = strings.Map(func(r rune) rune {
		switch r {
		case '/', '\\', ':', '*', '?', '"', '<', '>', '|':
			return '-'
		}
		if r < 0x20 {
			return -1
		}
		return r
	}, name)
	name = strings.Trim(strings.TrimSpace(name), ".")
	if len([]rune(name)) > 80 {
		name = string([]rune(name)[:80])
	}
	return strings.TrimSpace(name)
}

// NoteFolder — куда в библиотеке заметок класть журнал из компендиума:
// «модуль / компендиум / папки модуля». Первый уровень — откуда это вообще
// взялось (в библиотеке ДМ рядом лежат его собственные заметки), второй —
// компендиум (в одном модуле их бывает несколько, и одинаковые названия глав
// в них не редкость), дальше — дерево самого модуля как есть.
func NoteFolder(moduleTitle, packLabel, packPath string) string {
	segments := make([]string, 0, maxFolderDepth)
	for _, s := range append([]string{moduleTitle, packLabel}, strings.Split(packPath, "/")...) {
		if seg := folderSegment(s); seg != "" {
			segments = append(segments, seg)
		}
	}
	if len(segments) > maxFolderDepth {
		// Глубже предела библиотеки не уходим: остаток пути схлопываем в
		// имя последней папки, чтобы записи не потеряли, откуда они.
		tail := strings.Join(segments[maxFolderDepth-1:], " — ")
		segments = append(segments[:maxFolderDepth-1], folderSegment(tail))
	}
	return strings.Join(segments, "/")
}
