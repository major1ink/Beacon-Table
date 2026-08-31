package service_test

import (
	"context"
	"testing"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository/memory"
	"beacon-table/internal/service"
)

// TestBroadcastRequestApproveDeliversKeyOnce — основной путь «экран без
// ссылки»: заявка ждёт, ДМ пускает, экран забирает ключ. Второй раз тот же
// id ключа не отдаёт — иначе подсмотренный id остался бы вечным пропуском.
func TestBroadcastRequestApproveDeliversKeyOnce(t *testing.T) {
	ctx := context.Background()
	svc := service.NewBroadcastService(memory.NewServerStateStore())

	req, err := svc.RequestAccess("192.168.1.50")
	if err != nil {
		t.Fatalf("RequestAccess: %v", err)
	}
	if len(req.Code) != 4 {
		t.Fatalf("код %q — ожидались 4 знака для сверки с экраном", req.Code)
	}

	if state, key := svc.RequestState(req.ID); state != domain.BroadcastRequestPending || key != "" {
		t.Fatalf("до ответа ДМ: состояние %q, ключ %q", state, key)
	}

	pending := svc.PendingRequests()
	if len(pending) != 1 || pending[0].ID != req.ID {
		t.Fatalf("ДМ видит %d заявок, ожидалась одна наша", len(pending))
	}
	if pending[0].RemoteAddr != "192.168.1.50" {
		t.Fatalf("адрес заявки %q — ДМ по нему отличает свой телевизор от чужого браузера", pending[0].RemoteAddr)
	}

	if err := svc.ApproveRequest(ctx, req.ID); err != nil {
		t.Fatalf("ApproveRequest: %v", err)
	}

	key, err := svc.Key(ctx)
	if err != nil {
		t.Fatalf("Key: %v", err)
	}
	state, got := svc.RequestState(req.ID)
	if state != domain.BroadcastRequestApproved || got != key {
		t.Fatalf("после подтверждения: состояние %q, ключ %q (ожидался %q)", state, got, key)
	}

	if state, got := svc.RequestState(req.ID); state != domain.BroadcastRequestUnknown || got != "" {
		t.Fatalf("повторный опрос отдал состояние %q и ключ %q", state, got)
	}
	if len(svc.PendingRequests()) != 0 {
		t.Fatal("отвеченная заявка осталась в списке ДМ")
	}
}

// TestBroadcastRequestReject — отказ доводится до экрана и ключа не выдаёт.
func TestBroadcastRequestReject(t *testing.T) {
	svc := service.NewBroadcastService(memory.NewServerStateStore())

	req, err := svc.RequestAccess("10.0.0.7")
	if err != nil {
		t.Fatalf("RequestAccess: %v", err)
	}
	if err := svc.RejectRequest(req.ID); err != nil {
		t.Fatalf("RejectRequest: %v", err)
	}
	if state, key := svc.RequestState(req.ID); state != domain.BroadcastRequestRejected || key != "" {
		t.Fatalf("после отказа: состояние %q, ключ %q", state, key)
	}
	if err := svc.RejectRequest(req.ID); err == nil {
		t.Fatal("повторный отказ по той же заявке прошёл")
	}
}

// TestBroadcastRequestUnknownID — чужой/выдуманный id не является пропуском.
func TestBroadcastRequestUnknownID(t *testing.T) {
	ctx := context.Background()
	svc := service.NewBroadcastService(memory.NewServerStateStore())

	if state, key := svc.RequestState("нет-такой-заявки"); state != domain.BroadcastRequestUnknown || key != "" {
		t.Fatalf("выдуманный id: состояние %q, ключ %q", state, key)
	}
	if err := svc.ApproveRequest(ctx, "нет-такой-заявки"); err == nil {
		t.Fatal("подтверждение несуществующей заявки прошло")
	}
}

// TestBroadcastRequestLimit — поток заявок не должен вытеснять из списка ДМ
// тот самый телевизор, который сейчас ждёт подтверждения.
func TestBroadcastRequestLimit(t *testing.T) {
	svc := service.NewBroadcastService(memory.NewServerStateStore())

	for i := 0; i < domain.MaxPendingBroadcastRequests; i++ {
		if _, err := svc.RequestAccess("203.0.113.9"); err != nil {
			t.Fatalf("заявка %d: %v", i, err)
		}
	}
	if _, err := svc.RequestAccess("203.0.113.9"); err == nil {
		t.Fatal("заявка сверх предела прошла")
	}

	// Ответ на одну заявку освобождает место — ДМ не остаётся заблокирован
	// навсегда после наплыва.
	pending := svc.PendingRequests()
	if err := svc.RejectRequest(pending[0].ID); err != nil {
		t.Fatalf("RejectRequest: %v", err)
	}
	if _, err := svc.RequestAccess("203.0.113.9"); err != nil {
		t.Fatalf("после освобождения места: %v", err)
	}
}

// TestBroadcastRequestCodesAreUnique — два экрана, ждущие одновременно,
// показывают разные коды, иначе сверка не различает их.
func TestBroadcastRequestCodesAreUnique(t *testing.T) {
	svc := service.NewBroadcastService(memory.NewServerStateStore())

	seen := map[string]bool{}
	for i := 0; i < domain.MaxPendingBroadcastRequests; i++ {
		req, err := svc.RequestAccess("192.168.1.60")
		if err != nil {
			t.Fatalf("заявка %d: %v", i, err)
		}
		if seen[req.Code] {
			t.Fatalf("код %q повторился среди ожидающих заявок", req.Code)
		}
		seen[req.Code] = true
	}
}
