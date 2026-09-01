package ws

import (
	"net/http"
	"net/url"
	"strings"

	"beacon-table/internal/app"
)

// Options — политика приёма WS-подключений.
type Options struct {
	// BehindProxy — сервер за HTTPS-прокси, то есть смотрит в интернет (см.
	// Config.BehindProxy). Ужесточает правило для запросов без заголовка
	// Origin: см. checkOrigin.
	BehindProxy bool
	// AllowedOrigins — хосты, которым разрешено подключаться помимо своего
	// собственного. Обычно пуст: стол открывают с того же адреса, на котором
	// он и работает. Нужен, когда обратный прокси не передаёт исходный Host
	// (nginx без proxy_set_header Host) — иначе сервер видит вместо имени
	// сайта что-то своё и отвергает собственные же страницы.
	AllowedOrigins []string
	// Guests — уборщик гостей публичного демо (см. app.GuestKeeper). Ему
	// нужно знать, что гость сейчас за столом: тот может час смотреть, как
	// водит ДМ, не сделав ни одного HTTP-запроса, и по одним только запросам
	// выглядел бы ушедшим. nil в обычной установке.
	Guests *app.GuestKeeper
}

// checkOrigin — та самая проверка, которой раньше не было: до неё upgrader
// принимал хендшейк с любого сайта.
//
// Чем это опасно. Cookie сессии живёт месяцами, и пока она есть, любая
// открытая пользователем страница могла открыть WebSocket к его столу и
// начать слать команды от его имени — двигать токены, читать сцену, а у ДМ и
// то, что скрыто от игроков. От обычного CSRF стол прикрыт SameSite=Lax у
// cookie, но полагаться на одно лишь поведение браузера здесь мало: правило
// должно быть на сервере.
//
// Правило: хост в Origin должен совпасть с хостом, на который пришёл запрос.
// Сравнивается только хост с портом, без схемы — за HTTPS-прокси браузер
// присылает Origin вида https://стол.example.com, а до сервера запрос
// доходит уже по http, и сравнение схем отвергало бы каждое подключение.
//
// Пустой Origin — это не браузер (браузер обязан его прислать на WS): свой
// клиент, скрипт, curl. В локальной сети такое пускаем — там и телевизор с
// причудливым встроенным браузером, и ручная проверка через curl. Сервер,
// который смотрит в интернет (BehindProxy), пустой Origin отвергает: браузер
// без Origin туда не постучится, а всё остальное пусть предъявляет себя.
func checkOrigin(r *http.Request, opts Options) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return !opts.BehindProxy
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	if sameHost(u.Host, r.Host) {
		return true
	}
	for _, allowed := range opts.AllowedOrigins {
		if sameHost(u.Host, allowed) {
			return true
		}
	}
	return false
}

// sameHost сравнивает «хост:порт» без учёта регистра. Схему из разрешённого
// значения снимаем: в настройках привычнее написать
// https://стол.example.com, чем голое имя, и обе записи должны работать.
func sameHost(a, b string) bool {
	return strings.EqualFold(strings.TrimSpace(stripScheme(a)), strings.TrimSpace(stripScheme(b)))
}

func stripScheme(v string) string {
	if i := strings.Index(v, "://"); i >= 0 {
		v = v[i+3:]
	}
	return strings.TrimSuffix(v, "/")
}
