//go:build desktop

// Десктопная сборка: стол открывается в своём окне, а не во вкладке
// браузера. Серверная сборка этот файл не видит и остаётся без CGO.

package main

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed desktop_launcher.html
var launcherHTML string

var launcherPage = template.Must(template.New("launcher").Parse(launcherHTML))

func init() { runDesktop = desktopWindow }

func desktopWindow(open func(dir string) (server, error)) {
	// WebKitGTK на NVIDIA заметно лагает с рендером через DMA-BUF.
	if runtime.GOOS == "linux" && os.Getenv("WEBKIT_DISABLE_DMABUF_RENDERER") == "" {
		_ = os.Setenv("WEBKIT_DISABLE_DMABUF_RENDERER", "1")
	}

	l := &launcher{open: open, prefs: loadDesktopPrefs(), stop: make(chan struct{})}
	l.closeToTray.Store(l.prefs.closeToTray())
	icon, _ := staticFiles.ReadFile("static/icon-512.png")
	app := application.New(application.Options{
		Name: "Beacon Table",
		// Иконка окна — Alt+Tab и панель задач там, где иконку берут у окна
		// (X11). Под Wayland её ищут по ApplicationID ниже.
		Icon: icon,
		Linux: application.LinuxOptions{
			// Совпадает с именем ярлыка в пакете (packaging/linux): только
			// так GNOME и KDE связывают окно с ярлыком и показывают иконку,
			// а не шестерёнку.
			ApplicationID: desktopAppID,
		},
		// Свой журнал Wails — только предупреждения и ошибки: окно создаётся
		// раньше, чем прочитан уровень журнала из beacon.conf папки стола.
		LogLevel: slog.LevelWarn,
		Mac:      application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed: true},
		// Экран выбора отдаёт сам десктоп: сервера стола в этот момент
		// может не быть вовсе.
		Assets: application.AssetOptions{Handler: l, DisableLogging: true},
	})
	l.app = app
	l.win = app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:       mainWindow,
		Title:      "Beacon Table",
		Width:      1440,
		Height:     900,
		StartState: application.WindowStateMaximised,
		JS:         desktopJS(),
		// Кнопки стола зовут десктоп голым именем события (см. desktopJS).
		// Любой скрипт страницы может сделать то же, поэтому по событию
		// десктоп только открывает окно трансляции на уже выбранном сервере.
		AllowSimpleEventEmit: true,
	})
	// Есть трей — крестик только прячет окно: стол для игроков и телевизора
	// работает дальше, вернуть окно можно из трея.
	l.win.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		// Без l.mu: хук идёт в потоке GTK, а замок может держать обработчик
		// экрана запуска, который сам ждёт этот поток (диалог выбора папки).
		if l.closeToTray.Load() && l.tray.hides.Load() {
			e.Cancel()
			l.win.Hide()
		}
	})
	// Иначе главное окно закрыли — закрывается и трансляция, иначе приложение
	// жило бы дальше ради одного окна телевизора.
	l.win.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) { app.Quit() })
	app.Event.On(broadcastEvent, func(e *application.CustomEvent) {
		if e.Sender == mainWindow {
			l.toggleBroadcast()
		}
	})
	// Настройки десктопа со страницы стола: запрос текущих и смена
	// «при закрытии окна» (см. desktopJS и раздел «Интерфейс ДМ»).
	app.Event.On(stateEvent, func(e *application.CustomEvent) {
		if e.Sender == mainWindow {
			l.sendState()
		}
	})
	for _, action := range []string{closeTray, closeQuit} {
		app.Event.On(closeEvent+action, func(e *application.CustomEvent) {
			if e.Sender != mainWindow {
				return
			}
			l.mu.Lock()
			l.prefs.CloseAction = action
			l.closeToTray.Store(l.prefs.closeToTray())
			l.remember()
			l.mu.Unlock()
			l.sendState()
		})
	}
	l.newTray()
	// Окна WebKit появляются только на старте приложения.
	app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		reloadOnCrash(l.win)
	})
	if err := app.Run(); err != nil {
		slog.Error("Окно закрылось с ошибкой", "err", err)
	}
	l.shutdown()
}

const (
	desktopAppID   = "ru.beacontable.BeaconTable"
	mainWindow     = "main"
	broadcastEvent = "beacon:broadcast"
	stateEvent     = "beacon:state"
	closeEvent     = "beacon:close:"
	closeTray      = "tray"
	closeQuit      = "quit"
)

// sendState — настройки десктопа странице стола: что делать с крестиком и
// есть ли вообще трей (нет — выбирать нечего, пункт скрыт).
func (l *launcher) sendState() {
	l.mu.Lock()
	action := closeQuit
	if l.prefs.closeToTray() {
		action = closeTray
	}
	l.mu.Unlock()
	l.win.ExecJS(fmt.Sprintf(`document.dispatchEvent(new CustomEvent("beacon:desktop-state", { detail: { closeAction: %q, tray: %t } }))`,
		action, l.tray.hides.Load()))
}

// launcher — экран выбора «стол на этом компьютере / подключиться к
// серверу» и то, что поднято по этому выбору.
type launcher struct {
	open  func(dir string) (server, error) // prepareIn: подготовить стол в папке
	table server                           // заполнен, когда стол поднимается здесь
	app   *application.App
	win   *application.WebviewWindow
	stop  chan struct{}

	mu     sync.Mutex
	prefs  desktopPrefs
	served chan struct{}              // стол поднят здесь; второй раз его не поднимаем
	origin string                     // сервер, выбранный на экране запуска
	cast   *application.WebviewWindow // окно трансляции, пока открыто
	tray   tray

	closeToTray atomic.Bool // копия prefs.closeToTray() для хука закрытия окна
}

func (l *launcher) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	l.mu.Lock()
	defer l.mu.Unlock()

	q := r.URL.Query()
	switch r.URL.Path {
	case "/start":
	case "/pick":
		l.pickFolder(w, q)
		return
	case "/folder":
		l.saveFolder(w, q)
		return
	default:
		l.render(w, "")
		return
	}
	if l.served != nil && q.Get("mode") == "local" {
		go l.win.SetURL(browserURL(l.table.cfg.Addr))
		l.message(w, "Открываю стол…")
		return
	}
	switch q.Get("mode") {
	case "local":
		l.prefs.Mode = "local"
		// Папку ещё ни разу не выбирали — спрашиваем поверх экрана, а не
		// молча кладём данные туда, куда человек не смотрел.
		if len(l.prefs.Folders) == 0 && strings.TrimSpace(q.Get("folder")) == "" {
			l.page(w, launcherView{Ask: true, Folder: defaultFolder()})
			return
		}
		l.startLocal(w, q.Get("folder"), false)
	case "remote":
		l.prefs.Mode = "remote"
		target, err := serverURL(q.Get("server"))
		if err == nil {
			err = checkServer(target)
		}
		if err != nil {
			l.prefs.Server = strings.TrimSpace(q.Get("server"))
			l.render(w, err.Error())
			return
		}
		l.prefs.Server = target
		l.remember()
		if u, err := url.Parse(target); err == nil {
			l.origin = u.Scheme + "://" + u.Host
		}
		// Не из обработчика: запрос окна может обслуживаться в том же потоке
		// GTK, куда SetURL передаёт работу, и они ждали бы друг друга.
		go l.win.SetURL(target)
		l.message(w, "Подключаюсь к "+target+"…")
	default:
		l.render(w, "")
	}
}

// toggleBroadcast — открыть окно трансляции или закрыть уже открытое:
// управлять телевизором ДМ должен из своего окна, а не искать окно на нём.
//
// Окно — на том же сервере, что и главное. Ключ не нужен: окна делят
// cookie, а сессия ДМ пускает и на трансляцию. Есть второй монитор — окно
// сразу на нём во весь экран: ради этого десктоп и нужен, в браузере
// вкладку пришлось бы перетаскивать руками.
func (l *launcher) toggleBroadcast() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.cast != nil {
		go l.cast.Close()
		return
	}
	if l.origin == "" {
		return
	}
	opts := application.WebviewWindowOptions{
		Name:   "broadcast",
		Title:  "Beacon Table — трансляция",
		URL:    l.origin + "/broadcast.html",
		Width:  1280,
		Height: 720,
		// У окна во весь экран нет заголовка с крестиком — без клавиш из
		// него не выйти иначе как закрыв всю программу.
		KeyBindings: map[string]func(application.Window){
			"escape": func(w application.Window) { w.UnFullscreen() },
			"f11":    func(w application.Window) { w.ToggleFullscreen() },
		},
	}
	if s := secondScreen(l.app); s != nil && canPlaceWindows() {
		opts.Screen = s
		opts.StartState = application.WindowStateFullscreen
	}
	l.cast = l.app.Window.NewWithOptions(opts)
	go reloadOnCrash(l.cast)
	l.cast.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) {
		l.mu.Lock()
		l.cast = nil
		l.mu.Unlock()
		l.castChanged(false)
	})
	l.castChanged(true)
}

// castChanged — сказать столу в главном окне, открыта ли трансляция: от
// этого зависит надпись на кнопке.
func (l *launcher) castChanged(open bool) {
	l.trayCast(open)
	l.win.ExecJS(fmt.Sprintf(`document.dispatchEvent(new CustomEvent("beacon:broadcast", { detail: { open: %t } }))`, open))
}

// canPlaceWindows — может ли программа сама поставить окно на нужный
// монитор. Под Wayland решает композитор: окно «во весь экран на втором
// мониторе» легло бы поверх главного на первом.
func canPlaceWindows() bool {
	if runtime.GOOS != "linux" {
		return true
	}
	return os.Getenv("WAYLAND_DISPLAY") == "" || os.Getenv("GDK_BACKEND") == "x11"
}

// secondScreen — монитор, на котором нет главного окна: при двух экранах
// это телевизор или проектор. nil, если экран один.
func secondScreen(app *application.App) *application.Screen {
	for _, s := range app.Screen.GetAll() {
		if !s.IsPrimary {
			return s
		}
	}
	return nil
}

// capitalize — ошибки в коде строчные (как везде в проекте), а на экране
// это отдельная фраза.
func capitalize(s string) string {
	r := []rune(s)
	if len(r) > 0 {
		r[0] = unicode.ToUpper(r[0])
	}
	return string(r)
}

// launcherURL — адрес экрана запуска: его отдаёт asset-сервер Wails, у
// которого на Windows своя схема.
func launcherURL() string {
	if runtime.GOOS == "windows" {
		return "http://wails.localhost/"
	}
	return "wails://localhost/"
}

// desktopJS — то, что десктоп добавляет в каждую страницу окна:
//   - window.beaconDesktop: стол по нему узнаёт, что он в десктопе, и
//     показывает кнопки, которых нет в браузере (событие "beacon:desktop" —
//     на Linux скрипт приходит уже после загрузки страницы);
//   - кнопку «к выбору сервера» на любой странице, которая не стол: ошибка
//     WebKit (сервер не ответил, упал посреди игры), заглушка прокси и т. п.,
//     иначе окну из неё некуда деться. Страницы стола узнаём по собранным
//     стилям из /assets/ — их нет ни у страниц ошибок, ни у экрана запуска.
func desktopJS() string {
	return fmt.Sprintf(`(() => {
  const home = %q;
  const send = (msg) => {
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.external) window.webkit.messageHandlers.external.postMessage(msg);
    else if (window.chrome && window.chrome.webview) window.chrome.webview.postMessage(msg);
  };
  if (!window.beaconDesktop) {
    window.beaconDesktop = {
      toggleBroadcast: () => send("wails:event:emit:%s"),
      // Ответ приходит событием "beacon:desktop-state".
      requestState: () => send("wails:event:emit:%s"),
      setCloseAction: (action) => {
        if (action === %q || action === %q) send("wails:event:emit:%s" + action);
      },
    };
    document.dispatchEvent(new Event("beacon:desktop"));
  }
  const back = () => {
    if (location.href.startsWith(home) || document.getElementById("bt-desktop-back")) return;
    if (document.querySelector('link[rel="stylesheet"][href*="/assets/"]')) return;
    const a = document.createElement("a");
    a.id = "bt-desktop-back";
    a.href = home;
    a.textContent = "← К выбору сервера";
    a.style.cssText = "position:fixed;left:16px;bottom:16px;z-index:2147483647;padding:10px 16px;border-radius:10px;background:#7c6cf0;color:#fff;font:600 15px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-decoration:none;box-shadow:0 8px 24px rgba(0,0,0,.35)";
    (document.body || document.documentElement).appendChild(a);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", back);
  else back();
})();`, launcherURL(), broadcastEvent, stateEvent, closeTray, closeQuit, closeEvent)
}

// shutdown — окно закрыто: поднятый стол должен сохранить мир до выхода.
func (l *launcher) shutdown() {
	l.mu.Lock()
	served := l.served
	l.mu.Unlock()
	if served == nil {
		return
	}
	close(l.stop)
	<-served
}

func (l *launcher) render(w http.ResponseWriter, errText string) {
	l.page(w, launcherView{Error: errText})
}

// startLocal поднимает стол в папке; ask — запрос пришёл из окна выбора
// папки, и ошибку показываем в нём же.
func (l *launcher) startLocal(w http.ResponseWriter, raw string, ask bool) {
	fail := func(text string) {
		l.page(w, launcherView{Ask: ask, Folder: strings.TrimSpace(raw), Error: text})
	}
	folder, err := folderPath(raw)
	if err != nil {
		fail(err.Error())
		return
	}
	table, err := l.open(folder)
	if err != nil {
		slog.Error("Не удалось подготовить папку стола", "folder", folder, "err", err)
		fail(err.Error())
		return
	}
	ln, err := table.listen()
	if err != nil {
		slog.Error("Не удалось занять адрес", "addr", table.cfg.Addr, "err", err)
		fail("Не удалось занять адрес " + table.cfg.Addr + ": скорее всего Beacon Table уже запущен. Закройте прошлую копию или смените BEACON_ADDR в beacon.conf.")
		return
	}
	l.table = table
	l.prefs.useFolder(folder)
	l.remember()
	l.origin = strings.TrimSuffix(browserURL(l.table.cfg.Addr), "/")
	l.served = make(chan struct{})
	go func() {
		// Настоящий адрес сервера, а не asset-сервер Wails: куки, WS и
		// проверки «открыто с этой машины» работают как в браузере.
		l.table.serve(ln, l.stop, func() {
			l.win.SetURL(browserURL(l.table.cfg.Addr))
			l.enableTray()
		})
		close(l.served)
		select {
		case <-l.stop:
			// Окно уже закрыто и ждёт в shutdown: цикла Wails больше нет,
			// Quit ждал бы его вечно.
		default:
			// Стол остановили изнутри («Выключить сервер» у ДМ) — окну
			// показывать больше нечего.
			l.app.Quit()
		}
	}()
	l.message(w, "Запускаю стол…")
}

// saveFolder — «Сохранить» в окне выбора папки: папку создаём сразу, чтобы
// ошибка (нет прав, опечатка в пути) всплыла в этом окне, и тут же
// поднимаем стол — «на этом компьютере» человек уже выбрал.
func (l *launcher) saveFolder(w http.ResponseWriter, q url.Values) {
	folder, err := folderPath(q.Get("folder"))
	if err == nil {
		//nolint:gosec // G703: папку выбрал сам пользователь на своём экране запуска
		if mkErr := os.MkdirAll(folder, 0o750); mkErr != nil {
			err = errors.New("не удалось создать папку " + folder + ": " + mkErr.Error())
		}
	}
	if err != nil {
		l.page(w, launcherView{Ask: true, Folder: strings.TrimSpace(q.Get("folder")), Error: err.Error()})
		return
	}
	l.startLocal(w, folder, true)
}

// launcherView — что показать на экране запуска. Ask — окно выбора папки
// поверх экрана (первый выбор «на этом компьютере»); Folder — папка в поле,
// если пусто — последняя открытая.
type launcherView struct {
	Ask    bool
	Folder string
	Error  string
}

func (l *launcher) page(w http.ResponseWriter, v launcherView) {
	if v.Folder == "" && !v.Ask {
		v.Folder = l.prefs.folder()
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = launcherPage.Execute(w, map[string]any{
		// Папку ещё ни разу не выбирали: на экране без поля папки, её
		// спросят отдельным окном, когда выберут «на этом компьютере».
		"FirstRun": len(l.prefs.Folders) == 0,
		"Ask":      v.Ask,
		"Remote":   l.prefs.Mode == "remote",
		"Server":   l.prefs.Server,
		"Folder":   v.Folder,
		"Recent":   l.prefs.Folders,
		"Error":    capitalize(v.Error),
	})
}

// pickFolder — системный диалог выбора папки стола. Запросы экрана запуска
// Wails обслуживает не в потоке GTK, так что модальный диалог отсюда можно.
func (l *launcher) pickFolder(w http.ResponseWriter, q url.Values) {
	l.prefs.Mode = "local"
	if s := strings.TrimSpace(q.Get("server")); s != "" {
		l.prefs.Server = s
	}
	current := strings.TrimSpace(q.Get("folder"))
	start := current
	for start != "" {
		//nolint:gosec // G703: путь из поля экрана запуска — его вписал сам пользователь
		if st, err := os.Stat(start); err == nil && st.IsDir() {
			break
		}
		if parent := filepath.Dir(start); parent != start {
			start = parent
		} else {
			start = ""
		}
	}
	dlg := l.app.Dialog.OpenFile().
		SetTitle("Папка стола").
		CanChooseFiles(false).
		CanChooseDirectories(true).
		CanCreateDirectories(true)
	if start != "" {
		dlg = dlg.SetDirectory(start)
	}
	chosen, err := dlg.PromptForSingleSelection()
	if err != nil || chosen == "" {
		chosen = current // отменили — остаётся то, что было в поле
	}
	l.page(w, launcherView{Ask: q.Get("ask") == "1", Folder: chosen})
}

func (l *launcher) message(w http.ResponseWriter, text string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = launcherPage.Execute(w, map[string]any{"Message": text})
}

func (l *launcher) remember() {
	if err := saveDesktopPrefs(l.prefs); err != nil {
		slog.Warn("Не удалось запомнить выбор на экране запуска", "err", err)
	}
}

// serverURL — адрес сервера из поля ввода: без схемы считаем https, как
// набрал бы человек в адресной строке браузера. Возвращаем как введено, а не
// u.String(): тот кодирует кириллический домен в %D0…, а WebKit сам переведёт
// его в punycode.
func serverURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("укажите адрес сервера, например https://table.example.ru")
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	bad := errors.New("не похоже на адрес сервера: " + raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return "", bad
	}
	// Одно слово без точки — почти всегда опечатка, а не имя хоста: окно
	// ушло бы на несуществующий адрес, откуда к этому экрану не вернуться.
	host := u.Hostname()
	if host != "localhost" && net.ParseIP(host) == nil && !strings.Contains(strings.Trim(host, "."), ".") {
		return "", bad
	}
	return raw, nil
}

// checkServer — отвечает ли сервер вообще. Любой HTTP-ответ годится (вход
// и прочее — уже на самом столе); не годится только отсутствие ответа.
func checkServer(target string) error {
	client := &http.Client{Timeout: 6 * time.Second}
	resp, err := client.Get(target) //nolint:gosec // G107: адрес ввёл сам пользователь на экране запуска
	if err != nil {
		return errors.New("сервер " + target + " не отвечает. Проверьте адрес и интернет.")
	}
	_ = resp.Body.Close()
	return nil
}

// desktopPrefs — прошлый выбор на экране запуска: в следующий раз хватает
// одного Enter.
type desktopPrefs struct {
	Mode        string   `json:"mode"`
	Server      string   `json:"server,omitempty"`
	Folders     []string `json:"folders,omitempty"`     // папки стола, последняя открытая — первой
	CloseAction string   `json:"closeAction,omitempty"` // "quit" — крестик закрывает программу; иначе прячет в трей
}

func (p desktopPrefs) closeToTray() bool { return p.CloseAction != closeQuit }

const maxRecentFolders = 5

// folder — какую папку стола предложить: последнюю открытую, а при первом
// запуске — «Документы/Beacon Table».
func (p desktopPrefs) folder() string {
	if len(p.Folders) > 0 {
		return p.Folders[0]
	}
	return defaultFolder()
}

func (p *desktopPrefs) useFolder(dir string) {
	list := []string{dir}
	for _, f := range p.Folders {
		if f != dir && len(list) < maxRecentFolders {
			list = append(list, f)
		}
	}
	p.Folders = list
}

// defaultFolder — «Документы/Beacon Table»: папка стола — документ
// пользователя, её копируют и бэкапят, место ей там, где её видно. Нет
// «Документов» (голый Linux) — каталог данных программ по XDG, а не
// корень домашней папки.
func defaultFolder() string {
	if docs := documentsDir(); docs != "" {
		return filepath.Join(docs, "Beacon Table")
	}
	home, _ := os.UserHomeDir()
	if runtime.GOOS == "linux" {
		data := os.Getenv("XDG_DATA_HOME")
		if data == "" {
			data = filepath.Join(home, ".local", "share")
		}
		return filepath.Join(data, "beacon-table")
	}
	return filepath.Join(home, "Beacon Table")
}

// folderPath — папка стола из поля ввода: только абсолютный путь, иначе
// она легла бы туда, откуда запустили программу, — ровно то, от чего
// выбор папки и уводит.
func folderPath(raw string) (string, error) {
	dir := strings.TrimSpace(raw)
	if strings.HasPrefix(dir, "~") {
		if home, err := os.UserHomeDir(); err == nil {
			dir = filepath.Join(home, strings.TrimPrefix(dir, "~"))
		}
	}
	if dir == "" || !filepath.IsAbs(dir) {
		return "", errors.New("укажите полный путь к папке стола или выберите её кнопкой «Изменить…»")
	}
	return filepath.Clean(dir), nil
}

func desktopPrefsPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "beacon-table", "desktop.json"), nil
}

func loadDesktopPrefs() desktopPrefs {
	p := desktopPrefs{Mode: "local"}
	path, err := desktopPrefsPath()
	if err != nil {
		return p
	}
	b, err := os.ReadFile(path) //nolint:gosec // G304: путь собран из системного каталога настроек
	if err != nil {
		return p
	}
	_ = json.Unmarshal(b, &p)
	return p
}

func saveDesktopPrefs(p desktopPrefs) error {
	path, err := desktopPrefsPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return err
	}
	b, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o600)
}
