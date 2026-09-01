package domain

import "time"

// Роли аккаунта (Account.Role) и статусы (Account.Status) — простые строки,
// а не отдельный enum-тип: значения нужны как есть в JSON API и в SQL, заводить
// ради них конвертацию туда-обратно не оправдано на масштабе этого проекта.
const (
	AccountRoleAdmin  = "admin"
	AccountRolePlayer = "player"
	// AccountRoleDemo — гость публичного демо, севший ЗА ШИРМУ: за столом
	// может всё то же, что и ДМ (сцены, освещение, бестиарий, журнал), но
	// сервером не распоряжается — ни аккаунтами, ни мирами, ни настройками.
	// Заводится только когда сервер запущен в демо-режиме (см.
	// Config.DemoMode).
	AccountRoleDemo = "demo"
	// AccountRoleDemoPlayer — гость публичного демо, севший ПО ЭТУ СТОРОНУ
	// ширмы: тот же одноразовый аккаунт, но с правами обычного игрока —
	// свой персонаж, свой токен, туман войны и свет глазами игрока.
	// Существует потому, что демо с одними только ДМ-гостями показывает
	// ровно половину продукта: ДМ видит карту целиком и не видит, ради чего
	// вся эта геометрия света и стен считается.
	AccountRoleDemoPlayer = "demo_player"

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
	Role               string // AccountRoleAdmin | AccountRolePlayer | AccountRoleDemo | AccountRoleDemoPlayer
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

// IsGM — ведёт стол: настоящий ДМ или гость демо, севший за ширму. Всё, что
// касается игры — сцены, токены, освещение, бестиарий, журнал, плейлисты —
// доступно обоим.
func (a *Account) IsGM() bool {
	return a.Role == AccountRoleAdmin || a.Role == AccountRoleDemo
}

// IsPlayer — сидит за столом игроком: обычный игрок мира или гость демо,
// выбравший роль игрока. Права у них одни и те же (свой токен, свой лист,
// свой обзор), различие только в происхождении аккаунта — поэтому все
// проверки «это игрок?» спрашивают именно так, а не сравнивают роль со
// строкой "player" (см. api/ws: /ws/player).
func (a *Account) IsPlayer() bool {
	return a.Role == AccountRolePlayer || a.Role == AccountRoleDemoPlayer
}

// IsOwner — хозяин сервера. От IsGM отличается тем, что можно делать вне
// игры: заводить аккаунты, создавать и удалять миры, править настройки
// сервера, выдавать ключ трансляции, тянуть модули из интернета. Гость демо
// этого не может — иначе публичное демо означало бы «возьмите мой сервер».
func (a *Account) IsOwner() bool { return a.Role == AccountRoleAdmin }

// IsDemo — гость демо, любой из двух ролей. Нужен там, где поведение
// отличается не правами, а смыслом: гостя не ведут на экран выбора мира, и
// именно гости считаются против предела одновременных посетителей (см.
// service.AuthService.CreateGuest).
func (a *Account) IsDemo() bool {
	return a.Role == AccountRoleDemo || a.Role == AccountRoleDemoPlayer
}

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
