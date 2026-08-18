package service

import (
	"context"
	"errors"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository"
)

// CharacterWithOwner — персонаж плюс имя аккаунта-владельца, для
// выпадающего списка "Владелец" в контекстном меню токена (ДМ выбирает
// персонажа, а не аккаунт напрямую).
type CharacterWithOwner struct {
	Character     *domain.Character
	OwnerUsername string
}

// AdminService — то, что доступно только ДМ: управление аккаунтами игроков
// и обзор чужих персонажей. Отдельно от AuthService/CharacterService, потому
// что это принципиально другой набор прав (единственный admin-аккаунт стола),
// а не самообслуживание своего же аккаунта.
type AdminService interface {
	ListAccounts(ctx context.Context) ([]*domain.Account, error)
	// CreateAccount — ДМ заводит аккаунт напрямую: сразу активный, без
	// ожидания подтверждения (в отличие от AuthService.Register).
	CreateAccount(ctx context.Context, username, password, role string) (*domain.Account, error)
	ApproveAccount(ctx context.Context, id string) error
	// DeleteAccount — requestingAdminID нужен для правила "нельзя удалить
	// свой собственный аккаунт" (ErrForbidden).
	DeleteAccount(ctx context.Context, requestingAdminID, id string) error
	// ResetPassword — ДМ сбрасывает пароль кому угодно, не зная старого (в
	// отличие от AuthService.ChangeOwnPassword). Сносит все сессии аккаунта.
	ResetPassword(ctx context.Context, id, newPassword string) error
	ListAllCharacters(ctx context.Context) ([]CharacterWithOwner, error)
	// GetCharacter — один персонаж ЛЮБОГО игрока (в отличие от
	// CharacterService.Get, без проверки владельца — авторизация тут только
	// "вызывающий admin", проверяется на уровне HTTP-хендлера
	// requireAdminAccount). Нужен для просмотра/редактирования листа
	// персонажа из панели "Персонажи" в dm.html.
	GetCharacter(ctx context.Context, id string) (*CharacterWithOwner, error)
	// UpdateCharacter/UpdateCharacterSheet — правки имени/аватара и листа
	// ЛЮБОГО персонажа от лица ДМ (панель "Персонажи" в dm.html, кнопки
	// ✎ и полноценный лист в character-sheet.html). В отличие от
	// CharacterService.Update/UpdateSheet, не завязаны на accountID
	// вызывающего — сами подставляют реального владельца персонажа во
	// внутренний вызов CharacterRepository, чтобы не заводить отдельные
	// unscoped-методы в репозитории ради одного лишь ДМ-кейса.
	UpdateCharacter(ctx context.Context, id, name, avatarURL string) error
	UpdateCharacterSheet(ctx context.Context, id string, sheet domain.CharacterSheet) error
}

// adminService — привязан к одному миру (companyID): управление
// аккаунтами видит и заводит только игроков ЭТОЙ компании (правки чужих
// персонажей и так company-scoped через characters, см. тип
// sqlite.CharacterStore). Пересобирается заново на каждый
// service.CompanyManager (пакет internal/app) Launch, как и остальные
// сервисы ActiveWorld — companyID передаётся в конструктор, а не в каждый
// вызов, чтобы HTTP-хендлерам не нужно было протаскивать его отдельно.
type adminService struct {
	accounts   repository.AccountRepository
	sessions   repository.SessionRepository
	characters repository.CharacterRepository
	companyID  string
}

func NewAdminService(accounts repository.AccountRepository, sessions repository.SessionRepository, characters repository.CharacterRepository, companyID string) AdminService {
	return &adminService{accounts: accounts, sessions: sessions, characters: characters, companyID: companyID}
}

// ListAccounts — только аккаунты ЭТОЙ компании (не всего сервера — admin
// сам компании не принадлежит и в этот список не попадает, см.
// domain.Account.CompanyID).
func (s *adminService) ListAccounts(ctx context.Context) ([]*domain.Account, error) {
	all, err := s.accounts.List(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]*domain.Account, 0, len(all))
	for _, a := range all {
		if a.CompanyID == s.companyID {
			out = append(out, a)
		}
	}
	return out, nil
}

func (s *adminService) CreateAccount(ctx context.Context, username, password, role string) (*domain.Account, error) {
	username, err := validateUsername(username)
	if err != nil {
		return nil, err
	}
	if err := validatePassword(password); err != nil {
		return nil, err
	}
	if role != domain.AccountRoleAdmin {
		role = domain.AccountRolePlayer
	}
	if _, err := s.accounts.ByUsername(ctx, username); err == nil {
		return nil, domain.ErrConflict
	} else if !errors.Is(err, domain.ErrNotFound) {
		return nil, err
	}
	hash, err := hashPassword(password)
	if err != nil {
		return nil, err
	}
	// Аккаунт с ролью admin ДМ через эту панель не заводит (единственный
	// admin — "dm", см. AuthService.SeedAdmin) — но если когда-нибудь
	// заведёт, не привязываем его к компании, тем же принципом, что и у
	// seed-admin'а (см. domain.Account.CompanyID).
	companyID := s.companyID
	if role == domain.AccountRoleAdmin {
		companyID = ""
	}
	acc := &domain.Account{ID: newID(), Username: username, PasswordHash: hash, Role: role, Status: domain.AccountStatusActive, CompanyID: companyID}
	if err := s.accounts.Create(ctx, acc); err != nil {
		return nil, err
	}
	return acc, nil
}

// requireOwnCompanyAccount — защитная проверка перед любой мутацией чужого
// аккаунта: id должен принадлежать ИМЕННО этой компании (s.companyID) — не
// позволяет ДМ, зайдя в мир А, случайным/угаданным id задеть аккаунт игрока
// из мира Б.
func (s *adminService) requireOwnCompanyAccount(ctx context.Context, id string) error {
	acc, err := s.accounts.ByID(ctx, id)
	if err != nil {
		return err
	}
	if acc.CompanyID != s.companyID {
		return domain.ErrNotFound
	}
	return nil
}

func (s *adminService) ApproveAccount(ctx context.Context, id string) error {
	if err := s.requireOwnCompanyAccount(ctx, id); err != nil {
		return err
	}
	return s.accounts.Approve(ctx, id)
}

func (s *adminService) DeleteAccount(ctx context.Context, requestingAdminID, id string) error {
	if requestingAdminID == id {
		return domain.ErrForbidden
	}
	if err := s.requireOwnCompanyAccount(ctx, id); err != nil {
		return err
	}
	return s.accounts.Delete(ctx, id)
}

func (s *adminService) ResetPassword(ctx context.Context, id, newPassword string) error {
	if err := s.requireOwnCompanyAccount(ctx, id); err != nil {
		return err
	}
	if err := validatePassword(newPassword); err != nil {
		return err
	}
	hash, err := hashPassword(newPassword)
	if err != nil {
		return err
	}
	if err := s.accounts.SetPassword(ctx, id, hash, false); err != nil {
		return err
	}
	return s.sessions.DeleteForAccount(ctx, id)
}

func (s *adminService) ListAllCharacters(ctx context.Context) ([]CharacterWithOwner, error) {
	chars, err := s.characters.All(ctx)
	if err != nil {
		return nil, err
	}
	accs, err := s.accounts.List(ctx)
	if err != nil {
		return nil, err
	}
	usernames := make(map[string]string, len(accs))
	for _, a := range accs {
		usernames[a.ID] = a.Username
	}
	out := make([]CharacterWithOwner, 0, len(chars))
	for _, c := range chars {
		out = append(out, CharacterWithOwner{Character: c, OwnerUsername: usernames[c.AccountID]})
	}
	return out, nil
}

func (s *adminService) GetCharacter(ctx context.Context, id string) (*CharacterWithOwner, error) {
	c, err := s.characters.ByID(ctx, id)
	if err != nil {
		return nil, err
	}
	acc, err := s.accounts.ByID(ctx, c.AccountID)
	if err != nil && !errors.Is(err, domain.ErrNotFound) {
		return nil, err
	}
	username := ""
	if acc != nil {
		username = acc.Username
	}
	return &CharacterWithOwner{Character: c, OwnerUsername: username}, nil
}

func (s *adminService) UpdateCharacter(ctx context.Context, id, name, avatarURL string) error {
	name, err := validateCharacterName(name)
	if err != nil {
		return err
	}
	c, err := s.characters.ByID(ctx, id)
	if err != nil {
		return err
	}
	found, err := s.characters.Update(ctx, id, c.AccountID, name, avatarURL)
	if err != nil {
		return err
	}
	if !found {
		return domain.ErrNotFound
	}
	return nil
}

func (s *adminService) UpdateCharacterSheet(ctx context.Context, id string, sheet domain.CharacterSheet) error {
	sheet = sanitizeSheet(sheet)
	c, err := s.characters.ByID(ctx, id)
	if err != nil {
		return err
	}
	found, err := s.characters.UpdateSheet(ctx, id, c.AccountID, sheet)
	if err != nil {
		return err
	}
	if !found {
		return domain.ErrNotFound
	}
	return nil
}
