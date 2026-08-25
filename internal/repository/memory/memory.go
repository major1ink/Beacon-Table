// Package memory содержит in-memory реализации интерфейсов пакета
// repository. Основное назначение — unit-тесты service-слоя без поднятия
// настоящей SQLite/файловой системы, но заодно они наглядно доказывают, что
// service-слой действительно завязан на интерфейсы repository, а не на
// sqlite/scenefile/localfs напрямую: одна и та же service.AuthService
// одинаково работает и с sqlite.Store, и с memory.AccountStore.
package memory

import (
	"context"
	"sort"
	"strconv"
	"sync"

	"beacon-table/internal/domain"
)

// AccountStore — in-memory repository.AccountRepository.
type AccountStore struct {
	mu     sync.Mutex
	byID   map[string]*domain.Account
	byUser map[string]string // username -> id
}

func NewAccountStore() *AccountStore {
	return &AccountStore{byID: map[string]*domain.Account{}, byUser: map[string]string{}}
}

func cloneAccount(a *domain.Account) *domain.Account {
	cp := *a
	return &cp
}

func (s *AccountStore) Create(ctx context.Context, a *domain.Account) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.byUser[a.Username]; exists {
		return domain.ErrConflict
	}
	s.byID[a.ID] = cloneAccount(a)
	s.byUser[a.Username] = a.ID
	return nil
}

func (s *AccountStore) ByUsername(ctx context.Context, username string) (*domain.Account, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id, ok := s.byUser[username]
	if !ok {
		return nil, domain.ErrNotFound
	}
	return cloneAccount(s.byID[id]), nil
}

func (s *AccountStore) ByID(ctx context.Context, id string) (*domain.Account, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, ok := s.byID[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	return cloneAccount(a), nil
}

func (s *AccountStore) List(ctx context.Context) ([]*domain.Account, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*domain.Account, 0, len(s.byID))
	for _, a := range s.byID {
		out = append(out, cloneAccount(a))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out, nil
}

func (s *AccountStore) Delete(ctx context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if a, ok := s.byID[id]; ok {
		delete(s.byUser, a.Username)
		delete(s.byID, id)
	}
	return nil
}

func (s *AccountStore) Approve(ctx context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if a, ok := s.byID[id]; ok {
		a.Status = domain.AccountStatusActive
	}
	return nil
}

func (s *AccountStore) SetPassword(ctx context.Context, id, passwordHash string, mustChangePassword bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if a, ok := s.byID[id]; ok {
		a.PasswordHash = passwordHash
		a.MustChangePassword = mustChangePassword
	}
	return nil
}

// CharacterStore — in-memory repository.CharacterRepository.
type CharacterStore struct {
	mu        sync.Mutex
	byID      map[string]*domain.Character
	inventory map[string][]*domain.InventoryEntry // characterID -> записи, тот же принцип, что playlist_tracks в sqlite
	invSeq    int
}

func NewCharacterStore() *CharacterStore {
	return &CharacterStore{byID: map[string]*domain.Character{}, inventory: map[string][]*domain.InventoryEntry{}}
}

func cloneCharacter(c *domain.Character) *domain.Character {
	cp := *c
	return &cp
}

func (s *CharacterStore) Create(ctx context.Context, c *domain.Character) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.byID[c.ID] = cloneCharacter(c)
	return nil
}

func (s *CharacterStore) ByID(ctx context.Context, id string) (*domain.Character, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.byID[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	return cloneCharacter(c), nil
}

func (s *CharacterStore) ByAccount(ctx context.Context, accountID string) ([]*domain.Character, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []*domain.Character
	for _, c := range s.byID {
		if c.AccountID == accountID {
			out = append(out, cloneCharacter(c))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out, nil
}

func (s *CharacterStore) All(ctx context.Context) ([]*domain.Character, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*domain.Character, 0, len(s.byID))
	for _, c := range s.byID {
		out = append(out, cloneCharacter(c))
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].AccountID != out[j].AccountID {
			return out[i].AccountID < out[j].AccountID
		}
		return out[i].CreatedAt.Before(out[j].CreatedAt)
	})
	return out, nil
}

func (s *CharacterStore) Update(ctx context.Context, id, accountID, name, avatarURL string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.byID[id]
	if !ok || c.AccountID != accountID {
		return false, nil
	}
	c.Name = name
	c.AvatarURL = avatarURL
	return true, nil
}

func (s *CharacterStore) UpdateSheet(ctx context.Context, id, accountID string, sheet domain.CharacterSheet) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.byID[id]
	if !ok || c.AccountID != accountID {
		return false, nil
	}
	c.Sheet = sheet
	return true, nil
}

// UpdateSheetHP implements repository.CharacterRepository.
func (s *CharacterStore) UpdateSheetHP(ctx context.Context, id string, hpCurrent, hpTemp, hpMax int) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.byID[id]
	if !ok {
		return false, nil
	}
	c.Sheet.Combat.HPCurrent = hpCurrent
	c.Sheet.Combat.HPTemp = hpTemp
	c.Sheet.Combat.HPMax = hpMax
	return true, nil
}

func (s *CharacterStore) Delete(ctx context.Context, id, accountID string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.byID[id]
	if !ok || c.AccountID != accountID {
		return false, nil
	}
	delete(s.byID, id)
	delete(s.inventory, id)
	return true, nil
}

// ---- инвентарь персонажа (см. repository.CharacterRepository) ----

func (s *CharacterStore) ownsCharacter(id, accountID string) bool {
	c, ok := s.byID[id]
	return ok && c.AccountID == accountID
}

func (s *CharacterStore) ListInventory(ctx context.Context, characterID string) ([]*domain.InventoryEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*domain.InventoryEntry, len(s.inventory[characterID]))
	for i, e := range s.inventory[characterID] {
		cp := *e
		out[i] = &cp
	}
	return out, nil
}

func (s *CharacterStore) AddInventoryEntry(ctx context.Context, characterID, accountID string, entry domain.InventoryEntry) (*domain.InventoryEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.ownsCharacter(characterID, accountID) {
		return nil, domain.ErrNotFound
	}
	if entry.ItemID != "" {
		for _, e := range s.inventory[characterID] {
			if e.ItemID == entry.ItemID {
				e.Quantity += entry.Quantity
				cp := *e
				return &cp, nil
			}
		}
	}
	s.invSeq++
	if entry.ID == "" {
		entry.ID = "inv-" + strconv.Itoa(s.invSeq)
	}
	cp := entry
	s.inventory[characterID] = append(s.inventory[characterID], &cp)
	out := cp
	return &out, nil
}

func (s *CharacterStore) UpdateInventoryEntry(ctx context.Context, characterID, accountID, entryID string, quantity int, equipped bool, notes string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.ownsCharacter(characterID, accountID) {
		return false, nil
	}
	for _, e := range s.inventory[characterID] {
		if e.ID == entryID {
			e.Quantity = quantity
			e.Equipped = equipped
			e.Notes = notes
			return true, nil
		}
	}
	return false, nil
}

func (s *CharacterStore) RemoveInventoryEntry(ctx context.Context, characterID, accountID, entryID string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.ownsCharacter(characterID, accountID) {
		return false, nil
	}
	list := s.inventory[characterID]
	for i, e := range list {
		if e.ID == entryID {
			s.inventory[characterID] = append(list[:i], list[i+1:]...)
			return true, nil
		}
	}
	return false, nil
}

// SessionStore — in-memory repository.SessionRepository.
type SessionStore struct {
	mu       sync.Mutex
	accounts *AccountStore     // сессии резолвятся в аккаунт через тот же AccountStore, что и в проде (SessionRepository.AccountByToken)
	byToken  map[string]string // token -> accountID
}

func NewSessionStore(accounts *AccountStore) *SessionStore {
	return &SessionStore{accounts: accounts, byToken: map[string]string{}}
}

func (s *SessionStore) Create(ctx context.Context, token, accountID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.byToken[token] = accountID
	return nil
}

func (s *SessionStore) AccountByToken(ctx context.Context, token string) (*domain.Account, error) {
	s.mu.Lock()
	accountID, ok := s.byToken[token]
	s.mu.Unlock()
	if !ok {
		return nil, domain.ErrNotFound
	}
	return s.accounts.ByID(ctx, accountID)
}

func (s *SessionStore) Delete(ctx context.Context, token string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.byToken, token)
	return nil
}

func (s *SessionStore) DeleteForAccount(ctx context.Context, accountID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for token, id := range s.byToken {
		if id == accountID {
			delete(s.byToken, token)
		}
	}
	return nil
}

// FoundryModuleStore — in-memory repository.FoundryModuleRepository.
type FoundryModuleStore struct {
	mu   sync.Mutex
	byID map[string]domain.FoundryModule
}

func NewFoundryModuleStore() *FoundryModuleStore {
	return &FoundryModuleStore{byID: map[string]domain.FoundryModule{}}
}

func (s *FoundryModuleStore) Upsert(ctx context.Context, m domain.FoundryModule) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.byID[m.ID] = m
	return nil
}

func (s *FoundryModuleStore) List(ctx context.Context) ([]*domain.FoundryModule, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*domain.FoundryModule, 0, len(s.byID))
	for _, m := range s.byID {
		cp := m
		out = append(out, &cp)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ImportedAt.After(out[j].ImportedAt) })
	return out, nil
}

func (s *FoundryModuleStore) ByID(ctx context.Context, id string) (*domain.FoundryModule, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, ok := s.byID[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	return &m, nil
}

func (s *FoundryModuleStore) Delete(ctx context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.byID, id)
	return nil
}
