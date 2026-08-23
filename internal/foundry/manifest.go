// Package foundry — чтение пакетов (модулей и систем) Foundry VTT: манифест
// по ссылке, скачивание и распаковка архива, разбор компендиумов внутри него
// в плоские JSON-документы.
//
// Граница пакета проходит по КОНТЕЙНЕРУ, а не по игровой схеме: здесь знают,
// что модуль — это zip с module.json и папкой packs/, что пак бывает трёх
// форматов (LevelDB v11+, NeDB .db v10 и раньше, каталог .json) и что внутри
// документа поле img ссылается на файл в том же архиве. Что означает
// system.damage.parts у предмета dnd5e — здесь по-прежнему не знают: карточки
// (предметы/заклинания/существа/справочник/состояния) маппят те же чистые
// функции на клиенте, что и раньше для одиночного файла (см.
// web/src/item-import.js и соседей), сервер только достаёт им документы.
//
// Исключение — сцены, плейлисты и заметки (см. scene.go/playlist.go/
// journal.go): у них на клиенте маппера нет и быть не может (сцены живут в
// Room, плейлисты и заметки — свои сервисы), поэтому эти три вида документов
// пакет переводит в domain сам.
package foundry

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// maxManifestBytes — потолок на сам module.json/system.json. Манифест — это
// десятки килобайт даже у огромных модулей; мегабайт с запасом отсекает
// попытку скормить нам "манифест" на гигабайт.
const maxManifestBytes = 4 << 20

// Manifest — module.json (или system.json) пакета Foundry VTT. Полей у него
// на порядок больше (совместимость, зависимости, языки, стили) — берём
// только то, без чего импорт не сделать.
type Manifest struct {
	// ID/Name — идентификатор пакета. До v10 он назывался name, с v10 — id;
	// живые модули в интернете встречаются и такие, и такие (см. PackageID).
	ID   string `json:"id"`
	Name string `json:"name"`

	Title   string `json:"title"`
	Version string `json:"version"`
	// Download — ссылка на zip-архив ИМЕННО ЭТОЙ версии. Без неё импорт
	// невозможен: в Foundry такой манифест ставится только вручную.
	Download string `json:"download"`
	Packs    []Pack `json:"packs"`
	// Manifest — канонический URL манифеста самого пакета (в модулях он
	// обычно указывает на "latest"); нам он не нужен, но пусть будет виден
	// в ответе API, чтобы ДМ понимал, что именно скачалось.
	ManifestURL string `json:"manifest"`
}

// Pack — один компендиум внутри пакета.
type Pack struct {
	Name  string `json:"name"`
	Label string `json:"label"`
	Path  string `json:"path"`
	// Type — тип документов пака ("Item", "Actor", "JournalEntry", "Scene",
	// "Playlist", "RollTable", "Adventure", "Macro", "Cards"). До v10 то же
	// самое лежало в поле entity — принимаем оба, см. DocType.
	Type   string `json:"type"`
	Entity string `json:"entity"`
	System string `json:"system"`
}

// DocType — тип документов пака с учётом старого имени поля.
func (p Pack) DocType() string {
	if p.Type != "" {
		return p.Type
	}
	return p.Entity
}

// PackageID — идентификатор пакета с учётом переименования поля в v10.
func (m *Manifest) PackageID() string {
	if m.ID != "" {
		return m.ID
	}
	return m.Name
}

// DisplayTitle — человекочитаемое имя пакета для UI.
func (m *Manifest) DisplayTitle() string {
	if m.Title != "" {
		return m.Title
	}
	return m.PackageID()
}

// FetchManifest скачивает и разбирает манифест по ссылке, которую ДМ
// скопировал со страницы модуля. Разрешены только http/https — file:// и
// прочие схемы отсекаются здесь, а не в хендлере, чтобы правило действовало
// для любого вызывающего.
func FetchManifest(ctx context.Context, client *http.Client, rawURL string) (*Manifest, error) {
	body, err := fetch(ctx, client, rawURL, maxManifestBytes)
	if err != nil {
		return nil, err
	}
	var m Manifest
	if err := json.Unmarshal(body, &m); err != nil {
		return nil, fmt.Errorf("это не похоже на манифест Foundry (не разобрался JSON): %w", err)
	}
	if m.PackageID() == "" {
		return nil, fmt.Errorf("в манифесте нет id пакета — это точно module.json/system.json?")
	}
	if m.ManifestURL == "" {
		m.ManifestURL = rawURL
	}
	return &m, nil
}

// fetch — общий GET с ограничением размера тела. limit байт читаются в
// память; всё, что больше, — ошибка, а не молча обрезанный файл.
func fetch(ctx context.Context, client *http.Client, rawURL string, limit int64) ([]byte, error) {
	if err := checkURL(rawURL); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, fmt.Errorf("некорректная ссылка: %w", err)
	}
	req.Header.Set("Accept", "*/*")
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("не удалось скачать %s: %w", rawURL, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("сервер ответил %s на %s", resp.Status, rawURL)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, fmt.Errorf("обрыв загрузки %s: %w", rawURL, err)
	}
	if int64(len(body)) > limit {
		return nil, fmt.Errorf("файл по ссылке %s больше допустимых %d МиБ", rawURL, limit>>20)
	}
	return body, nil
}

// checkURL — единственная проверка ссылки перед запросом: схема. Хождение по
// локальной сети не запрещаем (self-hosted стол вполне может тянуть модуль с
// соседней машины или с локального зеркала), но эндпоинты импорта доступны
// только ДМ — см. internal/api/http/foundry_handlers.go.
func checkURL(rawURL string) error {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return fmt.Errorf("некорректная ссылка: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("ссылка должна начинаться с http:// или https://")
	}
	if u.Host == "" {
		return fmt.Errorf("в ссылке нет адреса сервера")
	}
	return nil
}
