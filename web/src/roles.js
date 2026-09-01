// Роли аккаунта приходят с сервера строкой как есть (см.
// internal/domain/account.go). Гость публичного демо — это обычный ДМ или
// обычный игрок ЗА СТОЛОМ, просто с одноразовым аккаунтом, и сервер их
// правами не отличает (см. Account.IsGM/IsPlayer). Страницы поэтому
// спрашивают «кто он за столом», а не сравнивают строку роли: иначе каждая
// новая гостевая роль тихо ломает очередной экран — так гость-ДМ и остался
// без бестиария и трекера инициативы, хотя сервер пускал его в оба.
//
// isOwner — единственное место, где строка сравнивается напрямую: хозяин
// сервера ровно один, и гость им не станет никогда (см. Account.IsOwner).

export function isGM(role) {
  return role === "admin" || role === "demo";
}

export function isPlayer(role) {
  return role === "player" || role === "demo_player";
}

export function isDemoGuest(role) {
  return role === "demo" || role === "demo_player";
}

export function isOwner(role) {
  return role === "admin";
}

// roleLabel — как называть роль в списке аккаунтов у хозяина сервера.
export function roleLabel(role) {
  switch (role) {
    case "admin":
      return "ДМ";
    case "demo":
      return "Гость (ДМ)";
    case "demo_player":
      return "Гость (игрок)";
    default:
      return "Игрок";
  }
}
