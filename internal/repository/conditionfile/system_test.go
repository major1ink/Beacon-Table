package conditionfile

import (
	"context"
	"os"

	"testing"
)

// systemDataRoot — тот же каталог, что уходит в бинарник через //go:embed
// systemdata (см. cmd/beacon-table/main.go). Тест читает его с диска
// (os.DirFS), а не из embed.FS: смысл проверки не в способе чтения, а в том,
// что JSON-файлы каталога реально раскладываются в domain.Condition —
// опечатка в имени поля ("rounds" вместо "defaultRounds") иначе прошла бы
// молча и превратилась бы в нули на проде.
const systemDataRoot = "../../../cmd/beacon-table/systemdata/conditions"

func TestSystemCatalogParses(t *testing.T) {
	entries, err := os.ReadDir(systemDataRoot)
	if err != nil {
		t.Fatalf("не читается каталог состояний: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("каталог состояний пуст — ожидались подпапки по системам")
	}

	for _, sys := range entries {
		if !sys.IsDir() {
			continue
		}
		t.Run(sys.Name(), func(t *testing.T) {
			// Корень fs — сам каталог conditions, а подпапка системы идёт
			// как dir: ровно та форма, в которой стор собирают в
			// app.CompanyManager.Launch ("systemdata/conditions/<system>").
			store := NewSystemStore(os.DirFS(systemDataRoot), sys.Name())
			list, err := store.List(context.Background())
			if err != nil {
				t.Fatalf("List: %v", err)
			}
			if len(list) == 0 {
				t.Fatal("ни одна карточка не разобралась")
			}
			bySlug := map[string]bool{}
			for _, c := range list {
				if c.Name == "" {
					t.Errorf("%s: пустое имя", c.ID)
				}
				if c.Slug == "" {
					t.Errorf("%s: пустой slug — метку не на что будет вешать", c.ID)
				}
				if c.Icon == "" && c.ImageURL == "" {
					t.Errorf("%s: нет ни глифа, ни картинки — значок на токене будет пустым", c.ID)
				}
				if !c.System {
					t.Errorf("%s: SystemStore обязан помечать карточки System=true", c.ID)
				}
				// id системной карточки собирается из имени файла, а имя файла
				// в этом каталоге по соглашению равно slug'у (см.
				// systemdata/README.md) — расхождение означает опечатку.
				if want := systemIDPrefix + c.Slug; c.ID != want {
					t.Errorf("id = %q, а по slug ожидался %q (имя файла должно совпадать со slug)", c.ID, want)
				}
				if bySlug[c.Slug] {
					t.Errorf("slug %q встречается дважды в одной системе", c.Slug)
				}
				bySlug[c.Slug] = true
			}
			// Зависимые состояния должны существовать в том же наборе —
			// иначе сервер развернёт rider в метку с сырым slug'ом вместо
			// человеческого имени (см. room_statuses.go: handleApplyStatus).
			for _, c := range list {
				for _, rider := range c.Riders {
					if !bySlug[rider] {
						t.Errorf("%s: зависимое состояние %q отсутствует в каталоге системы", c.Slug, rider)
					}
				}
			}
			// Многоуровневое состояние в правилах ровно одно — истощение;
			// проверяем его отдельно, потому что уровни — единственное поле,
			// от которого зависит форма UI (лампочки вместо тумблера).
			var exhaustion bool
			for _, c := range list {
				if c.Slug == "exhaustion" {
					exhaustion = true
					if c.Levels != 6 {
						t.Errorf("истощение: levels = %d, ожидалось 6", c.Levels)
					}
				}
			}
			if !exhaustion {
				t.Error("в каталоге нет истощения (exhaustion)")
			}
		})
	}
}
