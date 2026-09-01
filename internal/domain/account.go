package domain

import "time"

// Роли аккаунта (Account.Role) и статусы (Account.Status) — простые строки,
// а не отдельный enum-тип: значения нужны как есть в JSON API и в SQL, заводить
// ради них конвертацию туда-обратно не оправдано на масштабе этого проекта.
const (
	AccountRoleAdmin  = "admin"
	AccountRolePlayer = "player"
	// AccountRoleDemo — гость публичного демо: за столом может всё то же,
	// что и ДМ (сцены, освещение, бестиарий, журнал), но сервером не
	// распоряжается — ни аккаунтами, ни мирами, ни настройками. Заводится
	// только когда сервер запущен в демо-режиме (см. Config.DemoMode).
	AccountRoleDemo = "demo"

	AccountStatusActive  = "active"
	AccountStatusPending = "pending"
)

// SessionTTL — срок жизни сессии. Достаточно долго, чтобы не разлогинивать
// игроков между игровыми сессиями раз в неделю; истёкшие сессии чистятся
// лениво на чтении (см. repository/sqlite: AccountBySession).
const SessionTTL = 90 * 24 * time.Hour

// SessionCookieName — единственная точка правды об имени cookie сессии,
// общая для api/http (ставит/читает её на REST-запросах) и api/ws (читает
// её на WS-хендшейке). HttpOnly+SameSite=Lax настраиваются на стороне,
// которая ставит cookie (api/http) — здесь только имя.
const SessionCookieName = "beacon_session"

// Account — аккаунт за столом. PasswordHash — bcrypt, plaintext пароль на
// диск никогда не попадает. Status "pending" — самозарегистрировался, но ДМ
// ещё не одобрил (см. service.AdminService.ApproveAccount).
type Account struct {
	ID                 string
	Username           string
	PasswordHash       string
	Role               string // AccountRoleAdmin | AccountRolePlayer
	Status             string // AccountStatusActive | AccountStatusPending
	MustChangePassword bool
	// CompanyID — мир (Company), к которому привязан аккаунт. Пусто у
	// единственного admin-аккаунта ("dm") — он не принадлежит конкретному
	// миру, а управляет всеми ими (см. service.CompanyManager). У игрока
	// всегда непусто и не меняется после регистрации/создания ДМ-ом: стол
	// игрока виден только когда именно эта компания сейчас запущена (см.
	// service.CompanyManager.AccountInActiveWorld).
	CompanyID string
	CreatedAt time.Time
}

// IsActive — короткий помощник для service/api слоёв: активен ли аккаунт
// (прошёл модерацию ДМ).
func (a *Account) IsActive() bool { return a.Status == AccountStatusActive }

// IsGM — ведёт стол: настоящий ДМ или гость демо. Всё, что касается игры —
// сцены, токены, освещение, бестиарий, журнал, плейлисты — доступно обоим.
func (a *Account) IsGM() bool {
	return a.Role == AccountRoleAdmin || a.Role == AccountRoleDemo
}

// IsOwner — хозяин сервера. От IsGM отличается тем, что можно делать вне
// игры: заводить аккаунты, создавать и удалять миры, править настройки
// сервера, выдавать ключ трансляции, тянуть модули из интернета. Гость демо
// этого не может — иначе публичное демо означало бы «возьмите мой сервер».
func (a *Account) IsOwner() bool { return a.Role == AccountRoleAdmin }

// IsDemo — гость демо. Нужен там, где поведение отличается не правами, а
// смыслом: например, гостя не ведут на экран выбора мира.
func (a *Account) IsDemo() bool { return a.Role == AccountRoleDemo }

// Character — персонаж игрока: имя + аватар/токен-арт (управляются из
// player.html, панель "Мои персонажи") плюс структурированный лист
// характеристик D&D 2024 (Sheet, см. character_sheet.go) — редактируется
// отдельно, в своём окне (character-sheet.html), через CharacterService.UpdateSheet.
type Character struct {
	ID        string
	AccountID string
	// CompanyID/System — проставляются один раз при создании персонажа
	// (репозиторием, из компании, активной на тот момент, см.
	// sqlite.CharacterStore), дальше неизменны. System определяет, какие
	// поля CharacterSheet показывает фронт (см. character_sheet.go: поля
	// Race/PersonalityTraits/Ideals/Bonds/Flaws — только 2014,
	// Info.Species/Background — только 2024).
	CompanyID string
	System    string // domain.SystemDnD5e2014 | SystemDnD5e2024
	Name      string
	AvatarURL string
	Sheet     CharacterSheet
	CreatedAt time.Time
}
