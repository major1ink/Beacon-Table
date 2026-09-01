package service

import (
	"context"
	"crypto/subtle"
	"strings"
	"sync"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository"
)

// broadcastKeyStateKey — ключ в repository.ServerStateRepository, под
// которым лежит ключ трансляции.
const broadcastKeyStateKey = "broadcast_key"

// BroadcastService — ключ трансляции: секрет, по которому телевизор/проектор
// получает доступ к столу без аккаунта (см. domain.BroadcastCookieName).
//
// Ключ ОДИН на сервер, а не на мир: экран в комнате настраивают один раз, а
// ДМ за вечер может переключить мир не единожды — заставлять после каждого
// переключения заново открывать ссылку на телевизоре бессмысленно. Что
// именно видит зритель, определяет запущенный сейчас мир (см.
// app.CompanyManager.Current), а ключ отвечает только на вопрос «этому
// экрану вообще можно смотреть».
type BroadcastService interface {
	// Key — текущий ключ, создавая его при первом обращении: свежая
	// установка не должна требовать отдельного «сгенерировать».
	Key(ctx context.Context) (string, error)
	// Rotate выпускает новый ключ, немедленно отзывая доступ у всех
	// зрителей, которым раздали прежнюю ссылку.
	Rotate(ctx context.Context) (string, error)
	// Valid — предъявленный зрителем ключ совпадает с текущим. Пустой ключ
	// невалиден всегда, в том числе (и особенно) если в хранилище пусто.
	Valid(ctx context.Context, key string) bool

	// ---- заявки экранов на доступ ----
	//
	// Второй путь к тому же ключу, для случая, когда ссылку вбить некуда:
	// пульт телевизора — не клавиатура. Экран открывает /broadcast.html без
	// ключа, показывает четырёхзначный код и ждёт; ДМ видит заявку у себя в
	// «Настройках», сверяет код с тем, что горит на экране, и пускает —
	// ключ уезжает экрану сам (см. api/http/broadcast_handlers.go).

	// RequestAccess заводит заявку от экрана по адресу remoteAddr.
	// domain.ErrConflict — заявок уже слишком много (см.
	// domain.MaxPendingBroadcastRequests).
	RequestAccess(remoteAddr string) (domain.BroadcastRequest, error)
	// PendingRequests — заявки, ждущие ответа ДМ, свежие первыми.
	PendingRequests() []domain.BroadcastRequest
	// ApproveRequest пускает экран. domain.ErrNotFound — заявки нет или ей
	// уже ответили.
	ApproveRequest(ctx context.Context, id string) error
	// RejectRequest отказывает экрану.
	RejectRequest(id string) error
	// RequestState — что ответить ожидающему экрану: одно из
	// domain.BroadcastRequest* плюс ключ, если пустили.
	RequestState(id string) (state, key string)
}

// broadcastService — глобальный сервис, как и authService: к запущенному
// миру не привязан и на app.CompanyManager.Launch не пересобирается.
type broadcastService struct {
	state repository.ServerStateRepository

	// mu защищает ленивое создание ключа в Key (без неё два одновременных
	// первых запроса — ДМ открыл настройки, телевизор дёрнул проверку —
	// сгенерировали бы два разных ключа, и тот, что записался первым, тут же
	// перестал бы работать) и заодно карту заявок ниже.
	mu sync.Mutex

	// requests — заявки экранов на доступ, только в памяти процесса (см.
	// broadcast_requests.go). Ленивая инициализация в RequestAccess, чтобы
	// NewBroadcastService оставался тривиальным.
	requests map[string]*broadcastRequest
}

// NewBroadcastService собирает BroadcastService поверх KV глобальных
// настроек сервера.
func NewBroadcastService(state repository.ServerStateRepository) BroadcastService {
	return &broadcastService{state: state}
}

func (s *broadcastService) Key(ctx context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	key, err := s.state.Get(ctx, broadcastKeyStateKey)
	if err != nil {
		return "", err
	}
	if key != "" {
		return key, nil
	}
	key = randomHex(16)
	if err := s.state.Set(ctx, broadcastKeyStateKey, key); err != nil {
		return "", err
	}
	return key, nil
}

func (s *broadcastService) Rotate(ctx context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	key := randomHex(16)
	if err := s.state.Set(ctx, broadcastKeyStateKey, key); err != nil {
		return "", err
	}
	return key, nil
}

// Valid НЕ создаёт ключ на пустом хранилище (в отличие от Key): проверка
// приходит со стороны непроверенного клиента, и генерировать секрет по
// чужому запросу — значит позволить угадать его собственным пустым
// значением.
func (s *broadcastService) Valid(ctx context.Context, key string) bool {
	key = strings.TrimSpace(key)
	if key == "" {
		return false
	}
	current, err := s.state.Get(ctx, broadcastKeyStateKey)
	if err != nil || current == "" {
		return false
	}
	// Сравнение за постоянное время: ключ — секрет, а обычное == выходит из
	// цикла на первом различии и по времени ответа выдаёт длину совпавшего
	// префикса.
	return subtle.ConstantTimeCompare([]byte(key), []byte(current)) == 1
}
