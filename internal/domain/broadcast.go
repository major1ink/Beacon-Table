package domain

import "time"

// BroadcastCookieName — cookie зрителя трансляции (ТВ/проектор). Ставится
// сервером в ответ на переход по ссылке /broadcast.html?key=<ключ> (см.
// api/http/broadcast_handlers.go) и дальше пускает этот браузер к /ws/view и
// к загруженным файлам в /uploads/ — аккаунта у телевизора нет и не должно
// быть, а вот безымянного доступа к картам с любого адреса в интернете быть
// не должно тем более.
//
// Значение cookie — сам ключ трансляции, а не производный токен: ключ один
// на сервер, перевыпуск отзывает доступ у всех зрителей разом, и хранить
// отдельную таблицу выданных зрительских сессий незачем.
const BroadcastCookieName = "beacon_view"

// BroadcastCookieTTL — насколько долго телевизор помнит ключ. Год: экран в
// комнате настраивают один раз и не трогают годами, а отзыв доступа делается
// перевыпуском ключа на сервере, а не истечением cookie.
const BroadcastCookieTTL = 365 * 24 * time.Hour

// BroadcastKeyParam — имя query-параметра со ссылкой трансляции.
const BroadcastKeyParam = "key"

// BroadcastRequestTTL — сколько живёт неподтверждённая заявка экрана на
// доступ (см. service.BroadcastService.RequestAccess). Пятнадцать минут:
// человек у телевизора успевает дойти до ДМ и обратно, а забытая заявка
// не висит в списке до конца вечера.
const BroadcastRequestTTL = 15 * time.Minute

// MaxPendingBroadcastRequests — предел одновременных заявок. Заявку создаёт
// кто угодно без авторизации, поэтому список нужно чем-то ограничить: без
// предела достаточно открыть страницу трансляции тысячу раз, чтобы ДМ
// перестал находить среди заявок свой телевизор.
const MaxPendingBroadcastRequests = 12

// BroadcastRequest — заявка экрана на доступ к трансляции: телевизор открыл
// /broadcast.html без ключа и ждёт, пока ДМ пустит его со своего стола.
//
// Code — четыре знака, которые экран показывает крупно, а ДМ видит рядом с
// кнопкой «Пустить». Это не пароль, а способ сверки: подтверждать нужно
// именно тот экран, что стоит в комнате, а не чужой браузер, постучавшийся
// в ту же секунду. RemoteAddr показывается ДМ по той же причине — заявка из
// интернета и заявка из своей же локальной сети должны отличаться на вид.
type BroadcastRequest struct {
	ID         string
	Code       string
	RemoteAddr string
	CreatedAt  time.Time
}

// Состояния заявки, как их видит ожидающий экран (см.
// service.BroadcastService.RequestState).
const (
	// BroadcastRequestPending — ДМ ещё не ответил.
	BroadcastRequestPending = "pending"
	// BroadcastRequestApproved — пустили; вместе с этим состоянием экран
	// получает cookie зрителя.
	BroadcastRequestApproved = "approved"
	// BroadcastRequestRejected — ДМ отказал.
	BroadcastRequestRejected = "rejected"
	// BroadcastRequestUnknown — заявки нет: истекла, вытеснена или сервер
	// перезапустился. Экрану остаётся подать новую.
	BroadcastRequestUnknown = "unknown"
)
