package repository_test

// Страховочные тесты перед выносом D&D в модули (задача «Импорты при
// переходе на модули»): всё, что импорт кладёт в библиотеку, лист или
// инвентарь, должно читаться обратно без потерь. Структуры заполняются
// целиком (testutil.Fill), поэтому поле, добавленное позже или уехавшее в
// схему модуля, тоже окажется под проверкой.

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository/conditionfile"
	"beacon-table/internal/repository/itemfile"
	"beacon-table/internal/repository/monsterfile"
	"beacon-table/internal/repository/referencefile"
	"beacon-table/internal/repository/spellfile"
	"beacon-table/internal/repository/sqlite"
	"beacon-table/internal/testutil"
)

// sameJSON — сравнение через JSON: ровно то, что уходит клиенту и в архив
// мира; при расхождении называет каждое поле, которое потерялось или
// изменилось.
func sameJSON(t *testing.T, what string, got, want any) {
	t.Helper()
	var g, w any
	gb, _ := json.Marshal(got)
	wb, _ := json.Marshal(want)
	_ = json.Unmarshal(gb, &g)
	_ = json.Unmarshal(wb, &w)
	if diffs := testutil.JSONDiff(w, g); len(diffs) > 0 {
		t.Fatalf("%s: прочитано не то, что записано:\n%s", what, strings.Join(diffs, "\n"))
	}
}

func TestRoundTrip_Monster(t *testing.T) {
	ctx := context.Background()
	s := monsterfile.NewStore(t.TempDir())
	var m domain.Monster
	testutil.Fill(&m)
	m.ID = "m1"
	if err := s.Create(ctx, m.ID, &m); err != nil {
		t.Fatal(err)
	}
	got, err := s.Get(ctx, m.ID)
	if err != nil {
		t.Fatal(err)
	}
	sameJSON(t, "существо", got, &m)
}

func TestRoundTrip_Spell(t *testing.T) {
	ctx := context.Background()
	s := spellfile.NewStore(t.TempDir())
	var sp domain.Spell
	testutil.Fill(&sp)
	sp.ID = "s1"
	if err := s.Create(ctx, sp.ID, &sp); err != nil {
		t.Fatal(err)
	}
	got, err := s.Get(ctx, sp.ID)
	if err != nil {
		t.Fatal(err)
	}
	sameJSON(t, "заклинание", got, &sp)
}

func TestRoundTrip_Item(t *testing.T) {
	ctx := context.Background()
	s := itemfile.NewStore(t.TempDir())
	var it domain.Item
	testutil.Fill(&it)
	it.ID = "i1"
	if err := s.Create(ctx, it.ID, &it); err != nil {
		t.Fatal(err)
	}
	got, err := s.Get(ctx, it.ID)
	if err != nil {
		t.Fatal(err)
	}
	sameJSON(t, "предмет", got, &it)
}

func TestRoundTrip_Reference(t *testing.T) {
	ctx := context.Background()
	s := referencefile.NewStore(t.TempDir())
	var ref domain.Reference
	testutil.Fill(&ref)
	ref.ID = "r1"
	if err := s.Create(ctx, ref.ID, &ref); err != nil {
		t.Fatal(err)
	}
	got, err := s.Get(ctx, ref.ID)
	if err != nil {
		t.Fatal(err)
	}
	sameJSON(t, "запись справочника", got, &ref)
}

func TestRoundTrip_Condition(t *testing.T) {
	ctx := context.Background()
	s := conditionfile.NewStore(t.TempDir())
	var c domain.Condition
	testutil.Fill(&c)
	c.ID = "c1"
	if err := s.Create(ctx, c.ID, &c); err != nil {
		t.Fatal(err)
	}
	got, err := s.Get(ctx, c.ID)
	if err != nil {
		t.Fatal(err)
	}
	sameJSON(t, "состояние", got, &c)
}

// filledSheet — лист, где заполнено каждое поле. Чтение накладывает лист
// поверх DefaultCharacterSheet (см. sqlite.decodeSheet), где спасброски
// заведены на все шесть характеристик, — в настоящем листе их тоже всегда
// шесть, поэтому и здесь.
func filledSheet() domain.CharacterSheet {
	var sheet domain.CharacterSheet
	testutil.Fill(&sheet)
	sheet.SaveProf = map[string]bool{"str": true, "dex": false, "con": true, "int": false, "wis": true, "cha": false}
	return sheet
}

// Лист персонажа, прегены и инвентарь живут в SQLite (лист — одной JSON-
// колонкой). Сюда импорт LSS и готовых персонажей Foundry кладёт всё, что
// разобрал.
func TestRoundTrip_CharacterSheetAndInventory(t *testing.T) {
	ctx := context.Background()
	db, err := sqlite.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	company := &domain.Company{ID: "w1", Name: "Мир", System: domain.SystemDnD5e2024}
	if err := sqlite.NewCompanyStore(db).Create(ctx, company); err != nil {
		t.Fatal(err)
	}
	if err := sqlite.NewAccountStore(db).Create(ctx, &domain.Account{
		ID: "acc", Username: "gwen", PasswordHash: "h", Role: domain.AccountRolePlayer,
		Status: domain.AccountStatusActive, CompanyID: company.ID,
	}); err != nil {
		t.Fatal(err)
	}
	store := sqlite.NewCharacterStore(db, company.ID, company.System)
	if err := store.Create(ctx, &domain.Character{ID: "ch", AccountID: "acc", Name: "Гвен"}); err != nil {
		t.Fatal(err)
	}

	sheet := filledSheet()
	if ok, err := store.UpdateSheet(ctx, "ch", "acc", sheet); err != nil || !ok {
		t.Fatalf("UpdateSheet: ok=%v err=%v", ok, err)
	}
	got, err := store.ByID(ctx, "ch")
	if err != nil {
		t.Fatal(err)
	}
	sameJSON(t, "лист персонажа", got.Sheet, sheet)

	var entry domain.InventoryEntry
	testutil.Fill(&entry)
	entry.Equipped = false // «надето» переключается отдельной операцией
	added, err := store.AddInventoryEntry(ctx, "ch", "acc", entry)
	if err != nil {
		t.Fatal(err)
	}
	inv, err := store.ListInventory(ctx, "ch")
	if err != nil || len(inv) != 1 {
		t.Fatalf("инвентарь: %v err=%v", inv, err)
	}
	want := entry
	want.ID = added.ID
	sameJSON(t, "строка инвентаря", inv[0], &want)
}

func TestRoundTrip_Pregen(t *testing.T) {
	ctx := context.Background()
	db, err := sqlite.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := sqlite.NewCompanyStore(db).Create(ctx, &domain.Company{ID: "w1", Name: "Мир", System: domain.SystemDnD5e2024}); err != nil {
		t.Fatal(err)
	}
	store := sqlite.NewPregenStore(db, "w1")
	var p domain.Pregen
	testutil.Fill(&p)
	p.ID = "pg"
	p.Sheet = filledSheet()
	if err := store.Create(ctx, &p); err != nil {
		t.Fatal(err)
	}
	got, err := store.ByID(ctx, "pg")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got.Sheet, p.Sheet) {
		sameJSON(t, "лист прегена", got.Sheet, p.Sheet)
	}
	if got.Name != p.Name || got.AvatarURL != p.AvatarURL || got.Source != p.Source {
		t.Fatalf("преген: %+v, ожидали %+v", got, p)
	}
}
