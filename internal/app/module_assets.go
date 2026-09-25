package app

import (
	"context"
	"log/slog"
	"path"
	"regexp"
	"strings"

	"beacon-table/internal/domain"
	"beacon-table/internal/module"
	"beacon-table/internal/repository"
)

// moduleAssetRef — ссылка на картинку модуля внутри JSON карточки (см.
// cmd/beacon-table/modules.go: moduleAssetsURL). Путь — до кавычки, пробела
// или скобки: так ссылка заканчивается и в поле imageUrl, и в markdown.
var moduleAssetRef = regexp.MustCompile(`/module-assets/([a-z0-9]+(?:-[a-z0-9]+)*)/([^"\s)\\]+)`)

// moduleAssetLocalizer — копирует картинки модулей, на которые ссылается
// карточка библиотеки мира, в загрузки мира и переписывает ссылки (см.
// cardcatalog.Localizer). Так клон карточки модуля не теряет картинку, когда
// модуль выключают или удаляют.
//
// Копии кладутся в tokens/modules/<id модуля>/<путь в модуле> — туда же, куда
// ДМ грузит арт карточек; повторное сохранение карточки находит уже
// скопированный файл и отдаёт ту же ссылку.
type moduleAssetLocalizer struct {
	modules *module.Registry
	assets  repository.AssetRepository
}

func (l *moduleAssetLocalizer) LocalizeJSON(ctx context.Context, data []byte) ([]byte, error) {
	matches := moduleAssetRef.FindAllSubmatch(data, -1)
	if len(matches) == 0 {
		return data, nil
	}
	var known map[string]string // "папка/имя" → ссылка на уже скопированный файл
	replace := map[string]string{}
	for _, m := range matches {
		ref, moduleID, rel := string(m[0]), string(m[1]), string(m[2])
		if _, done := replace[ref]; done {
			continue
		}
		if known == nil {
			list, err := l.assets.List(ctx, domain.AssetKindTokens)
			if err != nil {
				return nil, err
			}
			known = make(map[string]string, len(list))
			for _, a := range list {
				known[a.Path+"/"+a.Name] = a.URL
			}
		}
		url, err := l.copyAsset(ctx, known, moduleID, rel)
		if err != nil {
			// Модуля или файла уже нет — оставляем ссылку как есть: карточка
			// сохранится, просто без картинки, как и без этой правки.
			slog.Warn("Картинка модуля не скопирована в мир", "ref", ref, "err", err)
			continue
		}
		replace[ref] = url
	}
	out := string(data)
	for from, to := range replace {
		out = strings.ReplaceAll(out, from, to)
	}
	return []byte(out), nil
}

func (l *moduleAssetLocalizer) copyAsset(ctx context.Context, known map[string]string, moduleID, rel string) (string, error) {
	folder := path.Join("modules", moduleID, path.Dir(path.Clean("/" + rel))[1:])
	name := path.Base(rel)
	if url, ok := known[folder+"/"+name]; ok {
		return url, nil
	}
	mod, err := l.modules.Get(moduleID)
	if err != nil {
		return "", err
	}
	f, err := mod.OpenAsset(rel)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	url, err := l.assets.Save(ctx, domain.AssetKindTokens, folder, name, f)
	if err != nil {
		return "", err
	}
	known[folder+"/"+name] = url
	return url, nil
}
