package foundry

import "strings"

// Куда едет документ компендиума. Это НЕ типы Foundry — это разделы Beacon
// Table (см. internal/domain): один пак Foundry типа "Item" разъезжается
// сразу по трём (заклинания, снаряжение, справочник), а пак "Adventure"
// вообще по всем.
const (
	TargetItems      = "items"      // domain.Item
	TargetSpells     = "spells"     // domain.Spell
	TargetMonsters   = "monsters"   // domain.Monster
	TargetPregens    = "pregens"    // domain.Pregen — актёры типа "character" (предгенерированные персонажи приключения)
	TargetReferences = "references" // domain.Reference — классы/архетипы/виды/предыстории/черты
	TargetConditions = "conditions" // domain.Condition — документы ActiveEffect
	TargetNotes      = "notes"      // domain.Note — журналы
	TargetScenes     = "scenes"     // domain.SceneState
	TargetPlaylists  = "playlists"  // domain.Playlist
	// TargetSkipped — распознали, но переносить некуда: таблицы случайных
	// значений, макросы, колоды карт. Показываем числом в отчёте, чтобы ДМ
	// видел, что пак не потерялся молча.
	TargetSkipped = "skipped"
)

// ServerSideTargets — что раскладывает по местам сам сервер, а не клиент:
// сцена живёт в Room, плейлист — в своём сервисе, и оба тянут за собой файлы
// из архива (карта, треки), которые всё равно переносит сервер.
//
// Заметок здесь нет, хотя маппера на клиенте у них тоже нет: текст заметки
// сервер готовит (см. MapJournal), но НЕ создаёт её — заметка с тем же
// названием в той же папке может уже существовать, и решение принимает ДМ
// (см. service.FoundryImport.Notes).
var ServerSideTargets = map[string]bool{
	TargetScenes:    true,
	TargetPlaylists: true,
}

// Entry — документ пака с уже определённым местом назначения.
type Entry struct {
	Doc    Doc
	Target string
}

// itemTargets — подтипы документа Item системы dnd5e. Всё, чего тут нет,
// считается снаряжением (см. Classify): незнакомый подтип лучше положить
// карточкой предмета, чем потерять.
var itemTargets = map[string]string{
	"spell":      TargetSpells,
	"class":      TargetReferences,
	"subclass":   TargetReferences,
	"feat":       TargetReferences,
	"background": TargetReferences,
	"race":       TargetReferences,
	"species":    TargetReferences,
	"subspecies": TargetReferences,
	"origin":     TargetReferences,
	"effect":     TargetConditions,
	"facility":   TargetReferences,
}

// Expand разворачивает документы пака в плоский список "документ →
// раздел". packType — тип пака из манифеста ("Item", "Actor", ...), он же
// подсказка для документов, у которых собственный вид по полям не читается.
func Expand(docs []Doc, packType string) []Entry {
	out := make([]Entry, 0, len(docs))
	for _, d := range docs {
		out = append(out, expandOne(d, packType, 0)...)
	}
	return out
}

func expandOne(d Doc, packType string, depth int) []Entry {
	if d == nil || depth > 2 {
		return nil
	}
	if isAdventure(d, packType) {
		return expandAdventure(d, depth)
	}
	return []Entry{{Doc: d, Target: Classify(d, packType)}}
}

// adventureFields — что лежит внутри документа Adventure и какому типу пака
// это соответствует. Adventure — не самостоятельная сущность, а коробка с
// готовым приключением: сцены, NPC, раздатка, музыка (см. expandAdventure).
var adventureFields = []struct {
	field    string
	packType string
}{
	{"actors", "Actor"},
	{"items", "Item"},
	{"journal", "JournalEntry"},
	{"scenes", "Scene"},
	{"playlists", "Playlist"},
	{"tables", "RollTable"},
	{"macros", "Macro"},
	{"cards", "Cards"},
}

func isAdventure(d Doc, packType string) bool {
	if strings.EqualFold(packType, "Adventure") {
		return true
	}
	// Не полагаемся только на тип пака: приключение встречается и внутри
	// обычного пака. Признак — сразу несколько коллекций документов рядом.
	filled := 0
	for _, f := range adventureFields {
		if len(asSlice(d[f.field])) > 0 {
			filled++
		}
	}
	return filled >= 2
}

func expandAdventure(d Doc, depth int) []Entry {
	out := make([]Entry, 0, 32)
	for _, f := range adventureFields {
		for _, raw := range asSlice(d[f.field]) {
			inner := asMap(raw)
			if inner == nil {
				continue
			}
			out = append(out, expandOne(Doc(inner), f.packType, depth+1)...)
		}
	}
	return out
}

// Classify — раздел одного документа. Сначала по типу пака (он надёжнее
// всего), потом по форме самого документа — модули иногда объявляют пак
// типом "Item", а кладут туда журналы.
func Classify(d Doc, packType string) string {
	docType := strings.ToLower(asString(d["type"]))

	switch strings.ToLower(packType) {
	case "actor":
		return actorTarget(docType)
	case "item":
		if t, ok := itemTargets[docType]; ok {
			return t
		}
		if looksLikeEffect(d) {
			return TargetConditions
		}
		return TargetItems
	case "journalentry", "journal":
		return TargetNotes
	case "scene":
		return TargetScenes
	case "playlist":
		return TargetPlaylists
	case "rolltable", "macro", "cards", "folder":
		return TargetSkipped
	}

	// Тип пака не указан/незнакомый — смотрим на сам документ.
	switch {
	case len(asSlice(d["pages"])) > 0:
		return TargetNotes
	case d["walls"] != nil || d["grid"] != nil && d["width"] != nil:
		return TargetScenes
	case d["sounds"] != nil && d["playing"] != nil:
		return TargetPlaylists
	case d["prototypeToken"] != nil || d["token"] != nil:
		return actorTarget(docType)
	case looksLikeEffect(d):
		return TargetConditions
	}
	if t, ok := itemTargets[docType]; ok {
		return t
	}
	if d["system"] != nil {
		return TargetItems
	}
	return TargetSkipped
}

// actorTarget — существо едет в бестиарий. Транспорт (vehicle) — туда же:
// domain.Monster почти целиком свободный текст (см. комментарий в
// internal/domain/monster.go), статблок корабля/повозки в него ложится не
// хуже статблока существа, а КД/ХП у vehicle-актёра в dnd5e лежат в тех же
// полях, что у npc (см. web/src/monster-import.js — маппер общий). Группы
// (group) — не статблок, а обёртка со ссылками на актёров пака; сами актёры
// приедут своими документами, тащить группу отдельно значило бы задвоить.
//
// Актёр типа "character" — это лист ИГРОКА: модули-приключения кладут туда
// предгенерированных персонажей («готовые персонажи, которых вы можете
// использовать в приключении»). Он едет в пул готовых персонажей мира
// (TargetPregens), а не в бестиарий — оттуда его берёт игрок или назначает
// ДМ (см. domain.Pregen, service.PregenService). Пустой type у актёра обычно
// всё же NPC, поэтому он остаётся в бестиарии.
func actorTarget(docType string) string {
	switch docType {
	case "character":
		return TargetPregens
	case "", "npc", "vehicle":
		return TargetMonsters
	default:
		return TargetSkipped
	}
}

// looksLikeEffect — документ похож на ActiveEffect (карточка состояния):
// есть changes[] или statuses[] и нет system-блока предмета.
func looksLikeEffect(d Doc) bool {
	if d["changes"] == nil && d["statuses"] == nil {
		return false
	}
	return d["system"] == nil || d["duration"] != nil
}
