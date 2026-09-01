package ws

import "time"

// Тестовые окна в тот же пакет — иначе проверка «молчащего отключают, а
// отвечающего нет» шла бы больше минуты реального времени (см. pongWait).
// Файл _test.go: в собранный сервер эти рычаги не попадают.

// MaxClientFrame — потолок на кадр от клиента, для тестов лимита.
const MaxClientFrame = maxClientFrame

// SetKeepaliveForTest укорачивает пинг и срок ожидания ответа. Возвращает
// функцию, возвращающую прежние значения.
func SetKeepaliveForTest(ping, pong time.Duration) func() {
	prevPing, prevPong := pingEvery, pongWait
	pingEvery, pongWait = ping, pong
	return func() { pingEvery, pongWait = prevPing, prevPong }
}
