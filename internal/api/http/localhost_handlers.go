package http

import (
	"log/slog"
	"net"
	"net/http"
	"sync"
)

// Две вещи, которые нужны только тому, кто запустил сервер на своём же
// компьютере и сидит за ним: узнать временный пароль ДМ, не имея консоли, и
// выключить сервер, не имея её же.
//
// Обе появились из одного и того же: программу запускают двойным кликом по
// файлу, окна консоли при этом нет, и «напечатано в журнале» для человека
// за домашним столом означает «нигде».

// FirstRun — временный пароль ДМ, выданный на этом запуске (см.
// service.AuthService.SeedAdmin). Живёт, пока ДМ не сменит пароль на свой.
type FirstRun struct {
	Username string
	Password string
	// Done — что сделать, когда пароль сменили и подсказка больше не нужна.
	// Композиционный корень стирает по нему файл с паролем.
	Done func()
}

// SetFirstRun сообщает API временный пароль ДМ. nil — временного пароля нет.
func (a *API) SetFirstRun(fr *FirstRun) {
	a.firstRunMu.Lock()
	defer a.firstRunMu.Unlock()
	a.firstRun = fr
}

// clearFirstRun вызывается, когда ДМ сменил временный пароль: подсказка
// перестаёт отдаваться, файл с паролем стирается.
func (a *API) clearFirstRun(username string) {
	a.firstRunMu.Lock()
	fr := a.firstRun
	if fr == nil || fr.Username != username {
		a.firstRunMu.Unlock()
		return
	}
	a.firstRun = nil
	a.firstRunMu.Unlock()
	if fr.Done != nil {
		fr.Done()
	}
}

// handleFirstRun — GET /api/first-run: временный пароль ДМ для страницы
// входа, открытой НА ТОМ ЖЕ компьютере, где работает сервер.
//
// Почему это не дыра: пароль отдаётся, только пока он временный (ДМ ещё ни
// разу не входил) и только по запросу с петлевого адреса — то есть человеку,
// который и так сидит за этой машиной и может прочитать файл с паролем
// рядом с программой или сам журнал. За прокси и в демо не отдаётся никогда:
// там «петлевой адрес» — это сам прокси, а не человек.
func (a *API) handleFirstRun(w http.ResponseWriter, r *http.Request) {
	a.firstRunMu.Lock()
	fr := a.firstRun
	a.firstRunMu.Unlock()

	if fr == nil || a.DemoMode || a.SecureCookies || !isLoopback(r.RemoteAddr) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"username": fr.Username,
		"password": fr.Password,
	})
}

// isLoopback — запрос пришёл с этой же машины. RemoteAddr здесь берётся как
// есть, без оглядки на X-Forwarded-For: подделать заголовок может кто
// угодно, а адрес соединения — нет.
func isLoopback(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// handleShutdown — POST /api/admin/shutdown: остановить сервер (только ДМ).
//
// Кнопка в интерфейсе — единственный способ закончить игру по-человечески
// для того, кто запустил программу двойным кликом: Ctrl+C негде нажать, а
// снять процесс через диспетчер задач — это обрыв на середине сохранения.
// Здесь же уходит обычное завершение: мир сохраняется, база закрывается
// (см. cmd/beacon-table: shutdown).
//
// В демо выключать нельзя: там за ширмой сидит гость, а не хозяин сервера.
func (a *API) handleShutdown(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireOwner(w, r)
	if !ok {
		return
	}
	if a.DemoMode || a.Shutdown == nil {
		writeErr(w, http.StatusForbidden, "выключение сервера отсюда недоступно")
		return
	}
	slog.Info("выключение сервера по кнопке в интерфейсе", "кто", acc.Username)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	// Останавливаемся после того, как ответ ушёл: иначе браузер получил бы
	// оборванное соединение и показал ошибку вместо «сервер остановлен».
	if f, canFlush := w.(http.Flusher); canFlush {
		f.Flush()
	}
	go a.Shutdown()
}

// firstRunMu защищает firstRun — его читает каждая страница входа, а
// стирает смена пароля.
var _ sync.Mutex
