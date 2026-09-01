package service

import (
	"context"
	"errors"
	"log"
	"strings"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository"
)

// AuthService — регистрация/логин/сессии/смена пароля/выдача seed-ДМ
// аккаунта. Единственная точка бизнес-правил вокруг аутентификации: api-слой
// только парсит HTTP-запрос и мапит возвращённую ошибку на статус-код, не
// зная, например, какой длины должен быть пароль.
type AuthService interface {
	// SeedAdmin создаёт (или пересоздаёт временный пароль) единственный
	// admin-аккаунт стола при старте сервера.
	SeedAdmin(ctx context.Context) error
	// Register — companyID обязателен: саморегистрация привязывает игрока к
	// тому миру, что запущен на сервере в момент отправки формы (см.
	// api/http/auth_handlers.go: handleRegister резолвит его через
	// app.CompanyManager.ActiveCompanyID, до вызова сюда — если ничего не
	// запущено, до Register дело не доходит, хендлер отвечает сам).
	Register(ctx context.Context, companyID, username, password string) error
	// Login возвращает новый токен сессии и аккаунт при успехе.
	Login(ctx context.Context, username, password string) (token string, account *domain.Account, err error)
	Logout(ctx context.Context, token string) error
	AccountBySession(ctx context.Context, token string) (*domain.Account, error)
	ChangeOwnPassword(ctx context.Context, accountID, oldPassword, newPassword string) error
	// CreateGuest заводит гостя публичного демо: активный аккаунт с ролью
	// domain.AccountRoleDemo, привязанный к демо-миру, и сразу открытую
	// сессию. Пароля у гостя нет по смыслу — войти повторно этим логином
	// нельзя, только завести нового гостя.
	//
	// maxGuests ограничивает число живых гостей: аккаунт заводится без
	// всякой проверки со стороны человека, и без предела один скрипт набьёт
	// базу за минуту. domain.ErrConflict — гостей уже слишком много.
	CreateGuest(ctx context.Context, companyID string, maxGuests int) (token string, account *domain.Account, err error)
}

// authService — полностью глобальный сервис: аккаунты/сессии не привязаны
// ни к какому конкретному запущенному миру (см. domain.Account.CompanyID),
// поэтому, в отличие от AdminService/CharacterService/…, никогда не
// пересобирается на app.CompanyManager.Launch.
type authService struct {
	accounts repository.AccountRepository
	sessions repository.SessionRepository
}

// NewAuthService собирает AuthService поверх интерфейсов репозиториев —
// какая это конкретно БД (sqlite.Store, memory.AccountStore в тестах и т.п.)
// сервису не известно и не важно.
func NewAuthService(accounts repository.AccountRepository, sessions repository.SessionRepository) AuthService {
	return &authService{accounts: accounts, sessions: sessions}
}

const seedAdminUsername = "dm"

// SeedAdmin создаёт единственный admin-аккаунт ("dm") при самом первом
// запуске. Если он уже есть, но ДМ так и не залогинился и не сменил
// временный пароль (MustChangePassword всё ещё true) — выпускает и печатает
// НОВЫЙ пароль при каждом старте, чтобы не зависеть от того, что лог с
// прошлого запуска кто-то сохранил.
func (s *authService) SeedAdmin(ctx context.Context) error {
	acc, err := s.accounts.ByUsername(ctx, seedAdminUsername)
	if err != nil && !errors.Is(err, domain.ErrNotFound) {
		return err
	}
	if err == nil {
		if !acc.MustChangePassword {
			return nil // ДМ уже сменил пароль на свой — ничего не трогаем
		}
		plain := generatePassword()
		hash, herr := hashPassword(plain)
		if herr != nil {
			return herr
		}
		if err := s.accounts.SetPassword(ctx, acc.ID, hash, true); err != nil {
			return err
		}
		log.Printf("ДМ ещё не сменил временный пароль. Логин: %s  Пароль: %s", seedAdminUsername, plain)
		return nil
	}
	plain := generatePassword()
	hash, herr := hashPassword(plain)
	if herr != nil {
		return herr
	}
	if err := s.accounts.Create(ctx, &domain.Account{
		ID: newID(), Username: seedAdminUsername, PasswordHash: hash,
		Role: domain.AccountRoleAdmin, Status: domain.AccountStatusActive, MustChangePassword: true,
	}); err != nil {
		return err
	}
	log.Printf("Создан аккаунт ДМ. Логин: %s  Пароль: %s", seedAdminUsername, plain)
	return nil
}

// Register — открытая форма, но аккаунт неактивен, пока ДМ не одобрит его в
// панели управления (см. AdminService.ApproveAccount). companyID — см.
// комментарий у интерфейса выше.
func (s *authService) Register(ctx context.Context, companyID, username, password string) error {
	username, err := validateUsername(username)
	if err != nil {
		return err
	}
	if err := validatePassword(password); err != nil {
		return err
	}
	if _, err := s.accounts.ByUsername(ctx, username); err == nil {
		return domain.ErrConflict
	} else if !errors.Is(err, domain.ErrNotFound) {
		return err
	}
	hash, err := hashPassword(password)
	if err != nil {
		return err
	}
	return s.accounts.Create(ctx, &domain.Account{
		ID: newID(), Username: username, PasswordHash: hash,
		Role: domain.AccountRolePlayer, Status: domain.AccountStatusPending, CompanyID: companyID,
	})
}

func (s *authService) Login(ctx context.Context, username, password string) (string, *domain.Account, error) {
	acc, err := s.accounts.ByUsername(ctx, strings.TrimSpace(username))
	if err != nil || !checkPassword(acc.PasswordHash, password) {
		return "", nil, domain.ErrUnauthorized
	}
	if acc.Status == domain.AccountStatusPending {
		return "", nil, domain.ErrForbidden
	}
	token := newSessionToken()
	if err := s.sessions.Create(ctx, token, acc.ID); err != nil {
		return "", nil, err
	}
	return token, acc, nil
}

// guestPrefix — по нему гостевые аккаунты и считаются, и отличаются в списке
// аккаунтов у владельца сервера.
const guestPrefix = "гость-"

func (s *authService) CreateGuest(ctx context.Context, companyID string, maxGuests int) (string, *domain.Account, error) {
	if companyID == "" {
		return "", nil, &domain.ValidationError{Msg: "демо-мир не запущен"}
	}
	if maxGuests > 0 {
		all, err := s.accounts.List(ctx)
		if err != nil {
			return "", nil, err
		}
		live := 0
		for _, acc := range all {
			if acc.Role == domain.AccountRoleDemo {
				live++
			}
		}
		if live >= maxGuests {
			return "", nil, domain.ErrConflict
		}
	}

	// Пароль случайный и нигде не показывается: гость входит по сессии,
	// которую получает прямо сейчас. Заводить аккаунт без пароля нельзя —
	// пустой хеш совпал бы с пустым вводом на форме входа.
	hash, err := hashPassword(randomHex(32))
	if err != nil {
		return "", nil, err
	}
	acc := &domain.Account{
		ID: newID(), Username: guestPrefix + randomHex(4), PasswordHash: hash,
		Role: domain.AccountRoleDemo, Status: domain.AccountStatusActive, CompanyID: companyID,
	}
	if err := s.accounts.Create(ctx, acc); err != nil {
		return "", nil, err
	}
	token := newSessionToken()
	if err := s.sessions.Create(ctx, token, acc.ID); err != nil {
		return "", nil, err
	}
	return token, acc, nil
}

func (s *authService) Logout(ctx context.Context, token string) error {
	return s.sessions.Delete(ctx, token)
}

func (s *authService) AccountBySession(ctx context.Context, token string) (*domain.Account, error) {
	return s.sessions.AccountByToken(ctx, token)
}

// ChangeOwnPassword — самообслуживание: своя смена пароля, зная старый (в
// отличие от админ-сброса, которому старый пароль не нужен). Успех сносит
// ВСЕ сессии этого аккаунта (включая текущую) — приходится перелогиниться,
// зато старый пароль нигде больше не работает.
func (s *authService) ChangeOwnPassword(ctx context.Context, accountID, oldPassword, newPassword string) error {
	acc, err := s.accounts.ByID(ctx, accountID)
	if err != nil {
		return err
	}
	if !checkPassword(acc.PasswordHash, oldPassword) {
		return domain.ErrUnauthorized
	}
	if err := validatePassword(newPassword); err != nil {
		return err
	}
	hash, err := hashPassword(newPassword)
	if err != nil {
		return err
	}
	if err := s.accounts.SetPassword(ctx, acc.ID, hash, false); err != nil {
		return err
	}
	return s.sessions.DeleteForAccount(ctx, acc.ID)
}
