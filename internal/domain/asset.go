package domain

// Виды загружаемых ассетов — подпапки хранилища файлов. "audio" — амбиент
// сцены и треки плейлистов ДМ (см. CueState).
const (
	AssetKindMaps = "maps"
	// AssetKindTokens — токен-арт монстров (см. Monster.ImageURL) и аватары
	// персонажей игроков (см. Character.AvatarURL). НЕ то же самое, что
	// AssetKindProps: у монстра/персонажа уже есть своё поле-владелец
	// картинки, эта библиотека — просто повторный выбор ранее загруженного
	// файла для них же (см. dm.js: dmCharEditAvatarUpload, bestiary.js).
	AssetKindTokens = "tokens"
	AssetKindAudio  = "audio"
	// AssetKindNotes — файлы/картинки, вставленные в текст заметки ДМ (см.
	// web/src/notes/toolbar.js: "Вставить файл"). Отдельная подпапка, чтобы
	// не путать со списком токен-артов (AssetKindTokens доступен любому
	// активному аккаунту по той же причине — не только ДМ, см.
	// AssetService.Upload).
	AssetKindNotes = "notes"
	// AssetKindProps — библиотека ассетов карты (костры, бочки, лодки и
	// т.п. декорации), которые ДМ перетаскивает на сцену как обычные
	// токены (см. web/dm.html: раздел "Ассеты", web/src/pages/dm.js).
	// Отдельно от AssetKindTokens осознанно: это не портреты существ, а
	// декорации сцены, и только эта библиотека поддерживает подпапки (см.
	// AssetRepository.Folders/CreateFolder/DeleteFolder) — организовывать
	// токен-арт монстров/аватары персонажей в папки не требовалось.
	// Доступ — только ДМ, как у maps/audio (см. AssetService.Upload).
	AssetKindProps = "props"
	// AssetKindHandouts — картинки для показа «поверх всего» на экранах
	// игроков и трансляции (раздел «Показ» у ДМ, см. web/dm.html и
	// web/src/showcase-overlay.js). Не токены и не декорации сцены — это
	// хендауты (портрет NPC, письмо, символ), поэтому своя библиотека, а не
	// AssetKindProps. Доступ — только ДМ, как у maps/audio/props.
	AssetKindHandouts = "handouts"
)

// AssetKinds — все известные виды ассетов, в порядке отображения в
// библиотеке DM.
var AssetKinds = []string{AssetKindMaps, AssetKindTokens, AssetKindAudio, AssetKindNotes, AssetKindProps, AssetKindHandouts}

// AssetInfo — одна запись в библиотеке ранее загруженных файлов. Name —
// человекочитаемое имя (без "<unixnano>-" префикса, добавленного при
// сохранении ради уникальности). Path — папка внутри библиотеки kind, в
// которой лежит файл ("" — корень, иначе posix-путь вида "Огонь/Костры");
// на сегодня подпапки реально использует только AssetKindProps.
type AssetInfo struct {
	URL     string `json:"url"`
	Name    string `json:"name"`
	Ext     string `json:"ext"`
	Size    int64  `json:"size"`
	ModTime string `json:"modTime"`
	Path    string `json:"path"`
}

// AssetFolder — папка библиотеки ассетов. Отдельный список от AssetInfo.Path
// нужен, чтобы показывать и ПУСТЫЕ папки (без единого файла внутри) — Path
// у AssetInfo существующих файлов их не перечислит.
type AssetFolder struct {
	// Path — полный путь папки от корня kind, posix-разделители, без
	// начального/конечного "/", например "Огонь/Костры".
	Path string `json:"path"`
}
