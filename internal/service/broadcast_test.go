package service_test

import (
	"context"
	"testing"

	"beacon-table/internal/repository/memory"
	"beacon-table/internal/service"
)

// TestBroadcastKeyIsCreatedOnceAndStable — первый запрос ключа создаёт его,
// второй возвращает тот же самый: иначе ссылка, которую ДМ уже открыл на
// телевизоре, переставала бы работать при следующем заходе в настройки.
func TestBroadcastKeyIsCreatedOnceAndStable(t *testing.T) {
	ctx := context.Background()
	svc := service.NewBroadcastService(memory.NewServerStateStore())

	first, err := svc.Key(ctx)
	if err != nil {
		t.Fatalf("Key: %v", err)
	}
	if first == "" {
		t.Fatal("Key вернул пустой ключ на свежей установке")
	}

	second, err := svc.Key(ctx)
	if err != nil {
		t.Fatalf("Key (повторно): %v", err)
	}
	if first != second {
		t.Fatalf("ключ изменился сам собой: %q → %q", first, second)
	}
}

// TestBroadcastRotateRevokesOldKey — перевыпуск отзывает прежнюю ссылку.
// Это единственный способ выгнать зрителя, которому ключ уже раздали.
func TestBroadcastRotateRevokesOldKey(t *testing.T) {
	ctx := context.Background()
	svc := service.NewBroadcastService(memory.NewServerStateStore())

	old, err := svc.Key(ctx)
	if err != nil {
		t.Fatalf("Key: %v", err)
	}
	fresh, err := svc.Rotate(ctx)
	if err != nil {
		t.Fatalf("Rotate: %v", err)
	}
	if fresh == old {
		t.Fatal("Rotate вернул прежний ключ")
	}
	if svc.Valid(ctx, old) {
		t.Fatal("старый ключ продолжает пускать после перевыпуска")
	}
	if !svc.Valid(ctx, fresh) {
		t.Fatal("новый ключ не пускает")
	}
}

// TestBroadcastValidRejectsEmptyAndUnknown — главная проверка: пустой ключ
// не должен совпасть с пустым хранилищем. Если бы Valid создавал ключ, как
// это делает Key, любой запрос без ключа на свежем сервере открывал бы
// трансляцию сам себе.
func TestBroadcastValidRejectsEmptyAndUnknown(t *testing.T) {
	ctx := context.Background()
	state := memory.NewServerStateStore()
	svc := service.NewBroadcastService(state)

	for _, key := range []string{"", "   ", "нетакойключ"} {
		if svc.Valid(ctx, key) {
			t.Fatalf("Valid(%q) = true на пустом хранилище", key)
		}
	}

	stored, err := state.Get(ctx, "broadcast_key")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if stored != "" {
		t.Fatalf("Valid записал ключ в хранилище по запросу извне: %q", stored)
	}

	key, err := svc.Key(ctx)
	if err != nil {
		t.Fatalf("Key: %v", err)
	}
	if svc.Valid(ctx, key+"x") {
		t.Fatal("Valid принял ключ с лишним символом")
	}
	if !svc.Valid(ctx, key) {
		t.Fatal("Valid отверг настоящий ключ")
	}
}
