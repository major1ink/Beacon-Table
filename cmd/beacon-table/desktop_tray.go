//go:build desktop

package main

import (
	"runtime"
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
	quitItem *application.MenuItem
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

	menu := application.NewMenu()
	menu.Add("Открыть стол").OnClick(func(*application.Context) { l.showMain() })
	l.tray.castItem = menu.Add(castOpenLabel).OnClick(func(*application.Context) { l.toggleBroadcast() })
	menu.AddSeparator()
	// «Выключить стол» — только когда он поднят здесь (enableTray).
	l.tray.quitItem = menu.Add("Выйти").OnClick(func(*application.Context) { l.app.Quit() })

	t := l.app.SystemTray.New()
	t.SetIcon(icon)
	t.SetTooltip("Beacon Table — стол работает")
	t.SetMenu(menu)
	// На Linux Wails зовёт обработчик клика и когда панель просто открывает
	// меню (событие dbusmenu "opened") — правый клик разворачивал бы окно.
	// Там окно открывают пунктом «Открыть стол»; левый клик в Ubuntu и так
	// показывает меню.
	if runtime.GOOS != "linux" {
		t.OnClick(l.showMain)
	}
	l.tray.icon = t
	l.tray.menu = menu
}

// enableTray — стол поднялся: с этого момента крестик прячет окно в трей.
func (l *launcher) enableTray() {
	if l.tray.icon != nil {
		l.tray.quitItem.SetLabel("Выключить стол и выйти")
		l.tray.icon.SetMenu(l.tray.menu)
		l.tray.hides.Store(true)
	}
}

func (l *launcher) showMain() {
	l.win.Show()
	l.win.Focus()
}

// trayCast — надпись пункта трансляции вслед за окном (как и кнопка на
// вкладке «Показ»).
func (l *launcher) trayCast(open bool) {
	if l.tray.icon == nil {
		return
	}
	label := castOpenLabel
	if open {
		label = castCloseLabel
	}
	l.tray.castItem.SetLabel(label)
	l.tray.icon.SetMenu(l.tray.menu)
}
