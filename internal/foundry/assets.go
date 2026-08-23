package foundry

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"beacon-table/internal/domain"
)

const (
	// maxAssetBytes — потолок на один переносимый файл. Карта в 4K весит
	// десятки мегабайт, видео-фон — сотню; больше уже не «иллюстрация к
	// карточке», а чей-то фильм в архиве модуля.
	maxAssetBytes = 256 << 20
	// maxAssetsPerImport — сколько файлов один импорт вправе положить в
	// библиотеку. Пак заклинаний тянет за собой пару сотен иконок, модуль с
	// приключением — тысячи; десять тысяч означает, что мы копируем весь
	// архив целиком, а не то, на что ссылаются документы.
	maxAssetsPerImport = 10000
)

// AssetStore — то, куда импорт кладёт файлы из архива. Ровно один метод
// repository.AssetRepository/service.AssetService (см. adapter в
// internal/service/foundry.go) — пакету foundry не нужно знать ни про
// аккаунты, ни про папки библиотеки.
type AssetStore interface {
	Save(ctx context.Context, kind, folder, filename string, r io.Reader) (url string, err error)
}

// Assets — перенос файлов модуля в библиотеку загрузок стола. Одна и та же
// иконка в паке заклинаний встречается сотнями документов, поэтому путь →
// URL кэшируется: файл копируется один раз.
type Assets struct {
	mod    *Module
	store  AssetStore
	folder string // подпапка библиотеки, "foundry/<id модуля>"
	cache  map[string]string
	count  int
	// Missing — сколько ссылок не нашлось в архиве. Это норма, а не ошибка:
	// половина иконок в модулях ссылается на ассеты самого Foundry
	// ("icons/svg/mystery-man.svg"), которых у нас нет и быть не может.
	Missing int
}

func NewAssets(mod *Module, store AssetStore, folder string) *Assets {
	return &Assets{mod: mod, store: store, folder: folder, cache: make(map[string]string, 128)}
}

// Count — сколько файлов реально перенесено.
func (a *Assets) Count() int { return a.count }

// URL — перенести файл, на который ссылается документ, и отдать ссылку на
// него в библиотеке стола. Пустая строка, если ссылки нет, файла нет в
// архиве или лимиты исчерпаны — вызывающий трактует это как «картинки не
// будет», а не как ошибку импорта.
func (a *Assets) URL(ctx context.Context, kind, ref string) string {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return ""
	}
	// Внешние ссылки и уже наши собственные оставляем как есть.
	if strings.HasPrefix(ref, "http://") || strings.HasPrefix(ref, "https://") ||
		strings.HasPrefix(ref, "data:") || strings.HasPrefix(ref, "/uploads/") {
		return ref
	}
	if cached, ok := a.cache[ref]; ok {
		return cached
	}
	saved := a.copyFile(ctx, kind, ref)
	a.cache[ref] = saved
	if saved == "" {
		a.Missing++
	}
	return saved
}

func (a *Assets) copyFile(ctx context.Context, kind, ref string) string {
	if a.count >= maxAssetsPerImport {
		return ""
	}
	path, ok := a.locate(ref)
	if !ok {
		return ""
	}
	info, err := os.Stat(path)
	if err != nil || info.Size() > maxAssetBytes {
		return ""
	}
	f, err := os.Open(path) //nolint:gosec // G304: путь получен из locate (safeJoin по корню кэша)
	if err != nil {
		return ""
	}
	defer f.Close()
	saved, err := a.store.Save(ctx, kind, a.folder, assetFileName(ref, path), f)
	if err != nil {
		return ""
	}
	a.count++
	return saved
}

// assetFileName — имя файла в библиотеке загрузок: короткий хэш ИСХОДНОГО
// пути внутри модуля плюс само имя. Хэш нужен для повторного импорта того же
// модуля: имя получается одинаковым, хранилище узнаёт уже перенесённый файл
// (см. service.assetSaver) и отдаёт ту же ссылку, а не плодит копию с новым
// именем. Без этого повторный импорт менял бы ссылки в тексте заметок, и
// каждая заметка выглядела бы «изменившейся».
//
// Хэш от пути, а не от содержимого: файл читается один раз, потоком в
// хранилище, и считать по дороге ещё и sha было бы лишней работой ради
// случая «в модуле два разных файла с одинаковым именем и путём», которого
// не бывает.
func assetFileName(ref, path string) string {
	sum := sha256.Sum256([]byte(strings.TrimPrefix(filepath.ToSlash(ref), "/")))
	return hex.EncodeToString(sum[:4]) + "-" + filepath.Base(path)
}

// locate ищет файл в распакованном архиве. В документах путь пишут от корня
// данных Foundry ("modules/my-module/icons/x.webp"), от корня модуля
// ("icons/x.webp") и с процентным кодированием пробелов — проверяем все
// варианты.
func (a *Assets) locate(ref string) (string, bool) {
	clean := strings.TrimPrefix(filepath.ToSlash(ref), "/")
	if i := strings.IndexAny(clean, "?#"); i >= 0 {
		clean = clean[:i]
	}
	variants := []string{clean}
	if decoded, err := url.PathUnescape(clean); err == nil && decoded != clean {
		variants = append(variants, decoded)
	}
	for _, v := range append([]string{}, variants...) {
		// "modules/<id>/rest" и "systems/<id>/rest" — путь от корня данных
		// Foundry: внутри архива это просто "rest".
		if parts := strings.SplitN(v, "/", 3); len(parts) == 3 && (parts[0] == "modules" || parts[0] == "systems" || parts[0] == "worlds") {
			variants = append(variants, parts[2])
		}
	}
	for _, base := range []string{a.mod.Root, a.mod.Dir} {
		for _, v := range variants {
			target, ok := safeJoin(base, v)
			if !ok {
				continue
			}
			if info, err := os.Stat(target); err == nil && info.Mode().IsRegular() {
				return target, true
			}
		}
	}
	return "", false
}

// htmlSrc — ссылки на файлы внутри HTML-текста (страницы журнала). Только
// src: href в текстах Foundry — это почти всегда @UUID-ссылки на другие
// документы, переносить там нечего.
var htmlSrc = regexp.MustCompile(`(?i)(src\s*=\s*)("[^"]*"|'[^']*')`)

// RewriteHTML переносит картинки, вставленные прямо в текст (страницы
// журнала), и правит ссылки на них.
func (a *Assets) RewriteHTML(ctx context.Context, kind, html string) string {
	if html == "" {
		return html
	}
	return htmlSrc.ReplaceAllStringFunc(html, func(match string) string {
		parts := htmlSrc.FindStringSubmatch(match)
		if len(parts) != 3 {
			return match
		}
		quote := parts[2][:1]
		ref := strings.Trim(parts[2], "\"'")
		saved := a.URL(ctx, kind, ref)
		if saved == "" {
			return match
		}
		return parts[1] + quote + saved + quote
	})
}

// RewriteDoc правит ссылки на файлы прямо в документе, который поедет на
// клиент маппиться в карточку (см. package-doc): клиентские мапперы читают
// те же поля img/texture.src, что и Foundry, и после этой правки положат в
// карточку уже нашу /uploads/-ссылку, а не путь внутри чужого модуля.
func (a *Assets) RewriteDoc(ctx context.Context, d Doc) {
	if d == nil {
		return
	}
	if img := asString(d["img"]); img != "" {
		d["img"] = a.URL(ctx, domain.AssetKindTokens, img)
	}
	if token := asMap(d["prototypeToken"]); token != nil {
		if texture := asMap(token["texture"]); texture != nil {
			if src := asString(texture["src"]); src != "" {
				texture["src"] = a.URL(ctx, domain.AssetKindTokens, src)
			}
		}
	}
}
