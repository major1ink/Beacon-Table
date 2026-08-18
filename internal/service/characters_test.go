package service_test

import (
	"context"
	"errors"
	"testing"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository/memory"
	"beacon-table/internal/service"
)

func TestCharacterService_CreateListUpdateDelete(t *testing.T) {
	ctx := context.Background()
	svc := service.NewCharacterService(memory.NewCharacterStore(), nil)

	c, err := svc.Create(ctx, "acc-1", "  Elminster  ", "http://example.com/a.png")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if c.Name != "Elminster" {
		t.Fatalf("ожидали обрезанное имя, получили %q", c.Name)
	}

	list, err := svc.List(ctx, "acc-1")
	if err != nil || len(list) != 1 {
		t.Fatalf("List: %v, err=%v", list, err)
	}

	if err := svc.Update(ctx, c.ID, "acc-1", "Elminster Aumar", ""); err != nil {
		t.Fatalf("Update: %v", err)
	}
	list, _ = svc.List(ctx, "acc-1")
	if list[0].Name != "Elminster Aumar" {
		t.Fatalf("правка не применилась: %+v", list[0])
	}

	if err := svc.Delete(ctx, c.ID, "acc-1"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	list, _ = svc.List(ctx, "acc-1")
	if len(list) != 0 {
		t.Fatalf("ожидали пустой список после удаления, получили %v", list)
	}
}

// TestCharacterService_OwnershipEnforced — чужой аккаунт не может ни
// поменять, ни удалить персонажа: репозиторий фильтрует по (id, accountID)
// одновременно, сервис превращает "не найдено с этим владельцем" в
// domain.ErrNotFound, а не в отдельную ошибку доступа — чтобы не подсказывать
// злоумышленнику, что id вообще существует.
func TestCharacterService_OwnershipEnforced(t *testing.T) {
	ctx := context.Background()
	svc := service.NewCharacterService(memory.NewCharacterStore(), nil)

	c, err := svc.Create(ctx, "acc-1", "Drizzt", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := svc.Update(ctx, c.ID, "acc-2", "Hacked", ""); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("ожидали ErrNotFound на чужом Update, получили %v", err)
	}
	if err := svc.Delete(ctx, c.ID, "acc-2"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("ожидали ErrNotFound на чужом Delete, получили %v", err)
	}
}

func TestCharacterService_Create_EmptyName(t *testing.T) {
	ctx := context.Background()
	svc := service.NewCharacterService(memory.NewCharacterStore(), nil)

	_, err := svc.Create(ctx, "acc-1", "   ", "")
	var verr *domain.ValidationError
	if !errors.As(err, &verr) {
		t.Fatalf("ожидали *domain.ValidationError, получили %v", err)
	}
}

// TestCharacterService_Create_DefaultSheet — новый персонаж сразу получает
// domain.DefaultCharacterSheet() (характеристики по 10, уровень 1), а не
// нулевой CharacterSheet{} — иначе первый рендер листа делил бы на модификатор
// от несуществующей характеристики.
func TestCharacterService_Create_DefaultSheet(t *testing.T) {
	ctx := context.Background()
	svc := service.NewCharacterService(memory.NewCharacterStore(), nil)

	c, err := svc.Create(ctx, "acc-1", "Bruenor", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if c.Sheet.Abilities.Str != 10 || c.Sheet.Info.Level != 1 {
		t.Fatalf("ожидали дефолтный лист (STR=10, уровень=1), получили %+v", c.Sheet)
	}

	got, err := svc.Get(ctx, c.ID, "acc-1")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Sheet.Abilities.Str != 10 {
		t.Fatalf("Get вернул другой лист: %+v", got.Sheet)
	}
}

// TestCharacterService_UpdateSheet — сохранённые значения читаются обратно,
// а владение проверяется так же, как и у Update/Delete.
func TestCharacterService_UpdateSheet(t *testing.T) {
	ctx := context.Background()
	svc := service.NewCharacterService(memory.NewCharacterStore(), nil)

	c, err := svc.Create(ctx, "acc-1", "Drizzt", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	sheet := domain.DefaultCharacterSheet()
	sheet.Abilities.Dex = 20
	sheet.Info.Level = 5
	sheet.Weapons = []domain.WeaponRow{{Name: "Скимитары", Bonus: "+9", Damage: "1к6 колющий"}}
	if err := svc.UpdateSheet(ctx, c.ID, "acc-1", sheet); err != nil {
		t.Fatalf("UpdateSheet: %v", err)
	}

	got, err := svc.Get(ctx, c.ID, "acc-1")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Sheet.Abilities.Dex != 20 || got.Sheet.Info.Level != 5 || len(got.Sheet.Weapons) != 1 {
		t.Fatalf("лист не сохранился как ожидалось: %+v", got.Sheet)
	}

	if err := svc.UpdateSheet(ctx, c.ID, "acc-2", sheet); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("ожидали ErrNotFound на чужом UpdateSheet, получили %v", err)
	}
	if _, err := svc.Get(ctx, c.ID, "acc-2"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("ожидали ErrNotFound на чужом Get, получили %v", err)
	}
}
