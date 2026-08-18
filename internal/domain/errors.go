// Package domain содержит модели предметной области Beacon Table и
// сентинел-ошибки, общие для всех слоёв (repository/service/api). Пакет не
// зависит ни от database/sql, ни от net/http, ни от websocket — модели тут
// чистые, чтобы repository- и service-слои могли ссылаться на них в обе
// стороны без цикла импортов.
package domain

import "errors"

// Сентинел-ошибки уровня домена. Репозитории возвращают их вместо
// специфичных для хранилища ошибок (sql.ErrNoRows и т.п.), а сервисы и
// api-слой мапят их на HTTP-статусы, не зная деталей конкретного хранилища.
var (
	// ErrNotFound — аккаунт/сессия/персонаж/сцена/плейлист не найдены.
	ErrNotFound = errors.New("не найдено")
	// ErrConflict — нарушение уникальности (например, занятое имя пользователя).
	ErrConflict = errors.New("уже существует")
	// ErrValidation — входные данные не прошли бизнес-валидацию сервиса.
	ErrValidation = errors.New("некорректные данные")
	// ErrForbidden — операция синтаксически валидна, но запрещена правами
	// вызывающего (не та роль, не тот владелец и т.п.).
	ErrForbidden = errors.New("недостаточно прав")
	// ErrUnauthorized — нет валидной сессии.
	ErrUnauthorized = errors.New("не авторизован")
)

// ValidationError — провал бизнес-валидации входных данных сервиса, с
// конкретным человекочитаемым сообщением (в отличие от голых сентинелов
// выше). Сообщение формирует service-слой (там, где известно правило —
// длина имени, диапазон пароля и т.п.), а api-слой лишь мапит тип ошибки на
// HTTP 400 и передаёт Msg клиенту как есть, не дублируя знание о правилах.
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

// Is делает errors.Is(err, ErrValidation) истинным для любой *ValidationError,
// не только для семантически идентичной through errors.As.
func (e *ValidationError) Is(target error) bool { return target == ErrValidation }
