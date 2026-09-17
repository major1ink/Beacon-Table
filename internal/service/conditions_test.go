package service

import (
	"context"
	"testing"

	"beacon-table/internal/domain"
)

// Пустой slug не должен доживать до хранилища: без ключа метку не на что
// повесить (см. defaultConditionSlug).
func TestConditionSlugDefaults(t *testing.T) {
	svc := NewConditionService(&fakeConditions{})
	ctx := context.Background()

	created, err := svc.Create(ctx, "Рана")
	if err != nil {
		t.Fatal(err)
	}
	if created.Slug != "c-"+created.ID {
		t.Fatalf("slug после Create = %q, ждали c-%s", created.Slug, created.ID)
	}

	// Клиент прислал карточку без slug (в конструкторе поля нет) — ключ из ID.
	updated, err := svc.Update(ctx, created.ID, domain.Condition{Name: "Рана", Slug: ""})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Slug != "c-"+created.ID {
		t.Fatalf("slug после Update без slug = %q", updated.Slug)
	}

	// Выбранный код Foundry нормализуется, а не подменяется дефолтом.
	updated, err = svc.Update(ctx, created.ID, domain.Condition{Name: "Ослеплён", Slug: " Blinded ", Riders: []string{"Blinded", "Prone"}})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Slug != "blinded" {
		t.Fatalf("slug после Update с кодом = %q", updated.Slug)
	}
	// Riders: свой ключ отброшен как петля, чужой нормализован.
	if len(updated.Riders) != 1 || updated.Riders[0] != "prone" {
		t.Fatalf("riders = %v", updated.Riders)
	}

	// Кириллица в slug вырезается целиком — и тогда тоже нужен дефолт.
	updated, err = svc.Update(ctx, created.ID, domain.Condition{Name: "Рана", Slug: "рана"})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Slug != "c-"+created.ID {
		t.Fatalf("slug после кириллицы = %q", updated.Slug)
	}
}
