package domain

// ClientRole — три класса подключений к комнате с разными правами
// (см. service.Room.Authorize).
type ClientRole int

const (
	RoleTV     ClientRole = iota // зритель без авторизации: локальный экран/проектор, только читает
	RoleDM                       // полный контроль, единственный admin-аккаунт
	RolePlayer                   // удалённый игрок, обычный аккаунт; двигает свои токены + кидает кубы
)
