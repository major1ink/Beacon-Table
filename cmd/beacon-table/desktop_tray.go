//go:build desktop

package main

import (
	"log/slog"
	"os/exec"
	"runtime"
	"strings"
	"sync/atomic"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Трей. Прятать окно в него крестиком — только пока стол поднят на этом
// компьютере (hides): тогда стол для игроков и телевизора работает дальше.
// Без трея (голый GNOME, см. trayAvailable) прятать некуда — крестик
// по-прежнему закрывает программу.
type tray struct {
	hides    atomic.Bool
	icon     *application.SystemTray
	menu     *application.Menu
	castItem *application.MenuItem
	castOpen bool
}

const (
	castOpenLabel  = "Открыть окно трансляции"
	castCloseLabel = "Закрыть окно трансляции"
)

// newTray заводит иконку в трее — до app.Run, целиком: на Linux трей
// регистрируется в D-Bus сразу, и свойство Menu объявляется, только если
// меню уже есть. Заданное позже меню хост (AppIndicator в Ubuntu) не видит.
// Спрятать иконку на Linux нельзя (Hide там пустой), поэтому она видна с
// запуска, а прятать окно в трей начинаем, когда стол поднялся (enableTray).
func (l *launcher) newTray() {
	if !trayAvailable() {
		return
	}
	icon, _ := staticFiles.ReadFile("static/icon-192.png")

	l.tray.menu = application.NewMenu()
	l.fillTrayMenu(false)

	t := l.app.SystemTray.New()
	t.SetIcon(icon)
	t.SetTooltip("Beacon Table — стол работает")
	t.SetMenu(l.tray.menu)
	// На Linux Wails зовёт обработчик клика и когда панель просто открывает
	// меню (событие dbusmenu "opened") — правый клик разворачивал бы окно.
	// Там окно открывают пунктом «Открыть стол»; левый клик в Ubuntu и так
	// показывает меню.
	if runtime.GOOS != "linux" {
		t.OnClick(l.showMain)
	}
	l.tray.icon = t
}

// fillTrayMenu собирает меню заново: пока стол не поднят здесь, в нём нечего
// копировать и нечего выключать.
func (l *launcher) fillTrayMenu(local bool) {
	menu := l.tray.menu
	menu.Clear()
	menu.Add("Открыть стол").OnClick(func(*application.Context) { l.showMain() })
	label := castOpenLabel
	if l.tray.castOpen {
		label = castCloseLabel
	}
	l.tray.castItem = menu.Add(label).OnClick(func(*application.Context) { l.toggleBroadcast() })
	menu.AddSeparator()
	if local {
		// «Куда заходить?» — первый вопрос за столом; раньше адрес был
		// только в журнале.
		for _, u := range accessURLs(l.table.cfg.Addr) {
			shown := strings.TrimSuffix(strings.TrimPrefix(u, "http://"), "/")
			menu.Add("Копировать адрес для игроков: " + shown).OnClick(func(*application.Context) {
				l.app.Clipboard.SetText(u)
			})
		}
		menu.Add("Открыть папку стола").OnClick(func(*application.Context) { openFolder(l.folder) })
		menu.AddSeparator()
		menu.Add("Выключить стол и выйти").OnClick(func(*application.Context) { l.app.Quit() })
		return
	}
	menu.Add("Выйти").OnClick(func(*application.Context) { l.app.Quit() })
}

// enableTray — стол поднялся: с этого момента крестик прячет окно в трей.
func (l *launcher) enableTray() {
	if l.tray.icon != nil {
		l.fillTrayMenu(true)
		l.tray.icon.SetMenu(l.tray.menu)
		l.tray.hides.Store(true)
	}
}

func (l *launcher) showMain() {
	l.win.Show()
	l.win.Focus()
}

// hideToTray — крестик при поднятом столе. В первый раз объясняем, куда
// делось окно: иначе похоже, что программа закрылась, и её запускают снова.
func (l *launcher) hideToTray() {
	l.win.Hide()
	l.mu.Lock()
	first := !l.prefs.TrayHintShown
	if first {
		l.prefs.TrayHintShown = true
		l.remember()
	}
	l.mu.Unlock()
	if first {
		l.app.Dialog.Info().
			SetTitle("Beacon Table работает в трее").
			SetMessage("Стол по-прежнему доступен игрокам и телевизору. Открыть окно или выключить стол — из значка в трее.\n\nЧтобы крестик закрывал программу: Настройки → Интерфейс ДМ → «При закрытии окна».").
			Show()
	}
}

// trayCast — надпись пункта трансляции вслед за окном (как и кнопка на
// вкладке «Показ»).
func (l *launcher) trayCast(open bool) {
	if l.tray.icon == nil {
		return
	}
	l.tray.castOpen = open
	label := castOpenLabel
	if open {
		label = castCloseLabel
	}
	l.tray.castItem.SetLabel(label)
	l.tray.icon.SetMenu(l.tray.menu)
}

// openFolder — папка в файловом менеджере системы.
func openFolder(dir string) {
	if dir == "" {
		return
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("explorer", dir) //nolint:gosec // G204: папку стола выбрал сам пользователь
	case "darwin":
		cmd = exec.Command("open", dir) //nolint:gosec // G204: см. выше
	default:
		cmd = exec.Command("xdg-open", dir) //nolint:gosec // G204: см. выше
	}
	if err := cmd.Start(); err != nil {
		slog.Warn("Не удалось открыть папку стола", "folder", dir, "err", err)
		return
	}
	go func() { _ = cmd.Wait() }()
}
