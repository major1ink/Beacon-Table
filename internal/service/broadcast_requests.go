package service

import (
	"context"
	"crypto/rand"
	"log"
	"sort"
	"time"

	"beacon-table/internal/domain"
)

// requestCodeAlphabet — знаки кода сверки. Без похожих начертаний (0/O,
// 1/I/L) — код читают с экрана телевизора через комнату и диктуют вслух.
const requestCodeAlphabet = "ACDEFGHJKMNPQRSTUVWXYZ23456789"

const requestCodeLength = 4

// broadcastRequest — заявка плюс её судьба. Хранится только в памяти
// процесса: заявка живёт минуты, переживать перезапуск ей незачем, а после
// подтверждения доступ держится cookie у самого экрана.
type broadcastRequest struct {
	req      domain.BroadcastRequest
	state    string
	approved string // ключ на момент подтверждения — экран получит именно его
}

func newRequestCode() string {
	b := make([]byte, requestCodeLength)
	if _, err := rand.Read(b); err != nil {
		log.Fatal("crypto/rand недоступен:", err)
	}
	out := make([]byte, len(b))
	for i, v := range b {
		out[i] = requestCodeAlphabet[int(v)%len(requestCodeAlphabet)]
	}
	return string(out)
}

// dropStaleRequests убирает истёкшие заявки. Вызывается под s.mu из каждого
// метода работы с заявками — отдельного таймера нет: список короткий, а
// чистка на обращении не требует фоновой горутины, которую пришлось бы
// останавливать вместе с сервером.
func (s *broadcastService) dropStaleRequests() {
	for id, r := range s.requests {
		if time.Since(r.req.CreatedAt) > domain.BroadcastRequestTTL {
			delete(s.requests, id)
		}
	}
}

// RequestAccess implements BroadcastService.
func (s *broadcastService) RequestAccess(remoteAddr string) (domain.BroadcastRequest, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.requests == nil {
		s.requests = map[string]*broadcastRequest{}
	}
	s.dropStaleRequests()

	pending := 0
	for _, r := range s.requests {
		if r.state == domain.BroadcastRequestPending {
			pending++
		}
	}
	if pending >= domain.MaxPendingBroadcastRequests {
		return domain.BroadcastRequest{}, domain.ErrConflict
	}

	// Код должен быть уникален среди ожидающих: две заявки с одинаковыми
	// знаками лишили бы сверку смысла.
	code := ""
	for attempt := 0; attempt < 20; attempt++ {
		candidate := newRequestCode()
		taken := false
		for _, r := range s.requests {
			if r.state == domain.BroadcastRequestPending && r.req.Code == candidate {
				taken = true
				break
			}
		}
		if !taken {
			code = candidate
			break
		}
	}
	if code == "" {
		return domain.BroadcastRequest{}, domain.ErrConflict
	}

	req := domain.BroadcastRequest{
		ID:         randomHex(16),
		Code:       code,
		RemoteAddr: remoteAddr,
		CreatedAt:  time.Now(),
	}
	s.requests[req.ID] = &broadcastRequest{req: req, state: domain.BroadcastRequestPending}
	return req, nil
}

// PendingRequests implements BroadcastService. Свежие сверху: ДМ жмёт
// «Пустить» сразу после того, как у телевизора нажали «Открыть».
func (s *broadcastService) PendingRequests() []domain.BroadcastRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dropStaleRequests()

	out := make([]domain.BroadcastRequest, 0, len(s.requests))
	for _, r := range s.requests {
		if r.state == domain.BroadcastRequestPending {
			out = append(out, r.req)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out
}

// ApproveRequest implements BroadcastService. Ключ фиксируется в заявке в
// момент подтверждения: если ДМ тут же перевыпустит ключ, экран, ещё не
// успевший забрать ответ, получит уже недействительный — и подаст заявку
// заново, вместо того чтобы молча остаться с рабочим доступом после отзыва.
func (s *broadcastService) ApproveRequest(ctx context.Context, id string) error {
	key, err := s.Key(ctx)
	if err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.dropStaleRequests()

	r, ok := s.requests[id]
	if !ok || r.state != domain.BroadcastRequestPending {
		return domain.ErrNotFound
	}
	r.state = domain.BroadcastRequestApproved
	r.approved = key
	return nil
}

// RejectRequest implements BroadcastService.
func (s *broadcastService) RejectRequest(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dropStaleRequests()

	r, ok := s.requests[id]
	if !ok || r.state != domain.BroadcastRequestPending {
		return domain.ErrNotFound
	}
	r.state = domain.BroadcastRequestRejected
	return nil
}

// RequestState implements BroadcastService. Подтверждённая заявка забирается
// из списка первым же обращением: ключ выдаётся ровно один раз, повторный
// опрос той же заявки увидит уже "unknown".
func (s *broadcastService) RequestState(id string) (state, key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dropStaleRequests()

	r, ok := s.requests[id]
	if !ok {
		return domain.BroadcastRequestUnknown, ""
	}
	switch r.state {
	case domain.BroadcastRequestApproved:
		delete(s.requests, id)
		return domain.BroadcastRequestApproved, r.approved
	case domain.BroadcastRequestRejected:
		delete(s.requests, id)
		return domain.BroadcastRequestRejected, ""
	default:
		return domain.BroadcastRequestPending, ""
	}
}
