package sqlite

import (
	"context"
	"testing"

	"beacon-table/internal/domain"
)

func TestChatStore_TrimKeepsNewestPerCompany(t *testing.T) {
	ctx := context.Background()
	db, err := Open(":memory:")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()

	a, b := NewChatStore(db, "company-a"), NewChatStore(db, "company-b")
	for i := 1; i <= 5; i++ {
		if err := a.Add(ctx, &domain.ChatMessage{ID: "a" + string(rune('0'+i)), At: int64(i), FromRole: domain.RolePlayer, FromName: "Валера", Text: "a"}); err != nil {
			t.Fatalf("Add: %v", err)
		}
	}
	if err := b.Add(ctx, &domain.ChatMessage{ID: "b1", At: 1, FromRole: domain.RoleDM, FromName: "ДМ", To: "acc-1", ToName: "Гость", Text: "b"}); err != nil {
		t.Fatalf("Add: %v", err)
	}

	if err := a.Trim(ctx, 2); err != nil {
		t.Fatalf("Trim: %v", err)
	}
	got, err := a.List(ctx)
	if err != nil || len(got) != 2 || got[0].ID != "a4" || got[1].ID != "a5" {
		t.Fatalf("после Trim(2) ожидались a4, a5, получено %+v (err %v)", got, err)
	}
	other, _ := b.List(ctx)
	if len(other) != 1 || other[0].To != "acc-1" || other[0].ToName != "Гость" {
		t.Fatalf("чужой мир задет или поля личного потеряны: %+v", other)
	}

	if err := a.Clear(ctx); err != nil {
		t.Fatalf("Clear: %v", err)
	}
	if got, _ := a.List(ctx); len(got) != 0 {
		t.Fatalf("после Clear история не пуста: %+v", got)
	}
	if other, _ := b.List(ctx); len(other) != 1 {
		t.Fatal("Clear задел чужой мир")
	}
}
