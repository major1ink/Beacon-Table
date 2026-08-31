// Package quota следит за тем, сколько места занимают загрузки, и не даёт
// им перерасти отведённый предел.
//
// Пределов два, и они независимы:
//
//   - общий на весь каталог uploads — защищает диск сервера;
//   - на один мир — не даёт одному столу с видео-картами съесть место у
//     остальных.
//
// Любой из них можно не задавать (0 — без предела). Трекер один на сервер:
// хранилище ассетов (localfs.Store) пересоздаётся под каждый запущенный мир
// и видит только свою папку, а место на диске общее.
package quota

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"beacon-table/internal/domain"
)

// rescanAfter — как долго доверяем накопленному счётчику. Он расходится с
// диском на операциях мимо трекера: удалении мира целиком, ручной правке
// файлов на сервере. Пересчёт ленивый — при обращении, а не по таймеру:
// заводить горутину ради раза в час незачем.
const rescanAfter = time.Hour

const maxInt64 = int64(^uint64(0) >> 1)

// Tracker — учёт занятого места. Полный обход каталога делается редко (при
// старте и раз в rescanAfter): при импорте модуля Foundry файлы льются
// сотнями подряд, и обход дерева на каждый съел бы больше времени, чем сама
// запись.
type Tracker struct {
	root       string
	totalLimit int64
	worldLimit int64

	mu     sync.Mutex
	total  counter
	worlds map[string]*counter // каталог мира → его счётчик
}

// counter — занятое место и время последнего пересчёта.
type counter struct {
	used      int64
	scannedAt time.Time
}

// New создаёт трекер каталога root. totalLimit — предел на весь каталог,
// worldLimit — на каждый мир; 0 в любом из них снимает соответствующий
// предел.
func New(root string, totalLimit, worldLimit int64) *Tracker {
	return &Tracker{
		root:       root,
		totalLimit: totalLimit,
		worldLimit: worldLimit,
		worlds:     map[string]*counter{},
	}
}

// TotalLimit/WorldLimit — заданные пределы (0 — не задан).
func (t *Tracker) TotalLimit() int64 {
	if t == nil {
		return 0
	}
	return t.totalLimit
}

func (t *Tracker) WorldLimit() int64 {
	if t == nil {
		return 0
	}
	return t.worldLimit
}

// TotalUsed — сколько занято во всём каталоге загрузок.
func (t *Tracker) TotalUsed() int64 {
	if t == nil {
		return 0
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.refreshLocked(&t.total, t.root, t.totalLimit)
	return t.total.used
}

// Scan пересчитывает каталог целиком. Зовётся при старте сервера, чтобы
// первая же загрузка знала реальную картину.
func (t *Tracker) Scan() error {
	if t == nil {
		return nil
	}
	total, err := dirSize(t.root)
	if err != nil {
		return err
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.total = counter{used: total, scannedAt: time.Now()}
	t.worlds = map[string]*counter{} // размеры миров пересчитаются по требованию
	return nil
}

// Invalidate помечает счётчики устаревшими: следующее обращение пересчитает
// диск. Зовётся после операций мимо трекера — например, удаления мира со
// всеми его файлами.
func (t *Tracker) Invalidate() {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.total.scannedAt = time.Time{}
	t.worlds = map[string]*counter{}
}

// World — вид на квоту глазами одного мира: и его собственный предел, и
// общий. Именно его получает хранилище ассетов этого мира.
func (t *Tracker) World(root string) *World {
	if t == nil {
		return nil
	}
	return &World{tracker: t, root: root}
}

// refreshLocked пересчитывает счётчик, если ему давно не доверяли.
// Вызывается под t.mu; на время обхода диска мьютекс отпускается.
func (t *Tracker) refreshLocked(c *counter, root string, limit int64) {
	if limit == 0 {
		return // без предела считать незачем
	}
	if !c.scannedAt.IsZero() && time.Since(c.scannedAt) < rescanAfter {
		return
	}
	t.mu.Unlock()
	size, err := dirSize(root)
	t.mu.Lock()
	if err != nil {
		return // каталога может ещё не быть — не повод падать
	}
	c.used = size
	c.scannedAt = time.Now()
}

// World — квота одного мира. Все проверки учитывают оба предела: файл
// должен влезть и в мир, и в общий каталог.
type World struct {
	tracker *Tracker
	root    string
}

// Used — сколько занимает этот мир.
func (w *World) Used() int64 {
	if w == nil || w.tracker == nil {
		return 0
	}
	t := w.tracker
	t.mu.Lock()
	defer t.mu.Unlock()
	c := t.worldCounterLocked(w.root)
	t.refreshLocked(c, w.root, t.worldLimit)
	return c.used
}

// Limit — предел этого мира (0 — не задан).
func (w *World) Limit() int64 {
	if w == nil || w.tracker == nil {
		return 0
	}
	return w.tracker.worldLimit
}

// TotalUsed/TotalLimit — цифры по всему серверу: их показывают ДМ рядом с
// цифрами мира, чтобы было видно, в какой предел он упирается.
func (w *World) TotalUsed() int64 {
	if w == nil {
		return 0
	}
	return w.tracker.TotalUsed()
}

func (w *World) TotalLimit() int64 {
	if w == nil {
		return 0
	}
	return w.tracker.TotalLimit()
}

// Remaining — сколько ещё можно записать в этот мир: меньшее из остатка
// мира и остатка всего каталога. Без пределов — заведомо достаточное
// число, чтобы вызывающему не пришлось знать про особый случай.
func (w *World) Remaining() int64 {
	if w == nil || w.tracker == nil {
		return maxInt64
	}
	t := w.tracker
	remaining := maxInt64
	if t.worldLimit > 0 {
		remaining = min64(remaining, t.worldLimit-w.Used())
	}
	if t.totalLimit > 0 {
		remaining = min64(remaining, t.totalLimit-t.TotalUsed())
	}
	if remaining < 0 {
		return 0
	}
	return remaining
}

// Reserve проверяет, что n байт ещё влезут. Для тех, кто знает размер
// заранее: импорт мира считает его по оглавлению архива и отказывается ДО
// распаковки, чтобы не оставить полураспакованный мир.
func (w *World) Reserve(n int64) error {
	if w == nil || w.tracker == nil {
		return nil
	}
	if n <= w.Remaining() {
		return nil
	}
	return w.exceeded(n)
}

// Add учитывает записанные байты, Sub — освобождённые.
func (w *World) Add(n int64) { w.adjust(n) }

func (w *World) Sub(n int64) { w.adjust(-n) }

// adjust двигает оба счётчика на delta байт. Перед этим доводит их до
// актуального состояния: иначе ленивый пересчёт, случившийся позже, затёр бы
// уже учтённые байты своим (устаревшим на этот файл) обходом диска.
func (w *World) adjust(delta int64) {
	if w == nil || w.tracker == nil || delta == 0 {
		return
	}
	t := w.tracker
	t.mu.Lock()
	defer t.mu.Unlock()

	t.refreshLocked(&t.total, t.root, t.totalLimit)
	c := t.worldCounterLocked(w.root)
	t.refreshLocked(c, w.root, t.worldLimit)

	t.total.used = clampZero(t.total.used + delta)
	c.used = clampZero(c.used + delta)

	// Отметка времени обновляется: после ручной правки счётчик снова
	// «свежий», и следующий обход придёт по расписанию, а не сразу.
	now := time.Now()
	if t.totalLimit > 0 {
		t.total.scannedAt = now
	}
	if t.worldLimit > 0 {
		c.scannedAt = now
	}
}

// CopyLimited переписывает src в dst, следя за квотой: как только предел
// исчерпан, копирование прекращается ошибкой, а не пишет файл до конца
// «чтобы потом удалить» — иначе на диск всё равно легли бы лишние сотни
// мегабайт. Возвращает число записанных байт: их учитывает вызывающий,
// который знает, оставил он файл или удалил.
func (w *World) CopyLimited(dst io.Writer, src io.Reader) (int64, error) {
	if w == nil || w.tracker == nil {
		return io.Copy(dst, src)
	}
	remaining := w.Remaining()
	if remaining == maxInt64 {
		return io.Copy(dst, src) // пределов нет; remaining+1 ниже переполнил бы int64
	}
	if remaining <= 0 {
		return 0, w.exceeded(0)
	}
	// remaining+1 — чтобы отличить «ровно влезло» от «уже не помещается».
	n, err := io.Copy(dst, io.LimitReader(src, remaining+1))
	if err != nil {
		return n, err
	}
	if n > remaining {
		return n, w.exceeded(n)
	}
	return n, nil
}

// exceeded — ошибка с цифрами: «место кончилось» без них ничего не
// подсказывает. Называем тот предел, в который упёрлись.
func (w *World) exceeded(want int64) error {
	t := w.tracker
	var msg string
	switch {
	case t.worldLimit > 0 && w.Used()+want > t.worldLimit:
		msg = fmt.Sprintf("у этого мира кончилось место: занято %s из %s",
			FormatSize(w.Used()), FormatSize(t.worldLimit))
	default:
		msg = fmt.Sprintf("на сервере кончилось место для загрузок: занято %s из %s",
			FormatSize(t.TotalUsed()), FormatSize(t.totalLimit))
	}
	if want > 0 {
		msg += fmt.Sprintf(", нужно ещё %s", FormatSize(want))
	}
	msg += ". Удалите ненужные файлы в разделе «Ассеты» или поднимите квоту в настройках"
	return fmt.Errorf("%w: %s", domain.ErrNoSpace, msg)
}

// worldCounterLocked — счётчик мира, заводится при первом обращении.
// Вызывается под t.mu.
func (t *Tracker) worldCounterLocked(root string) *counter {
	c, ok := t.worlds[root]
	if !ok {
		c = &counter{}
		t.worlds[root] = c
	}
	return c
}

func min64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

func clampZero(v int64) int64 {
	if v < 0 {
		return 0
	}
	return v
}

// dirSize — суммарный размер обычных файлов в дереве. Отсутствующий
// каталог — ноль, а не ошибка: до первой загрузки его может не быть.
func dirSize(root string) (int64, error) {
	var total int64
	err := filepath.Walk(root, func(_ string, info os.FileInfo, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return nil // файл исчез между обходом и stat — не наша забота
			}
			return err
		}
		if info.Mode().IsRegular() {
			total += info.Size()
		}
		return nil
	})
	if os.IsNotExist(err) {
		return 0, nil
	}
	return total, err
}

// DirSize — размер каталога снаружи пакета: нужен тем, кто удаляет папку
// целиком и вычитает её из счётчика.
func DirSize(root string) (int64, error) { return dirSize(root) }

// ParseSize разбирает размер в человеческой записи: "20GB", "500 MB",
// "1.5G", "1073741824". Без суффикса — байты, пусто или 0 — без предела.
func ParseSize(v string) (int64, error) {
	s := strings.TrimSpace(strings.ToUpper(v))
	if s == "" {
		return 0, nil
	}
	s = strings.TrimSuffix(s, "B") // GB → G, B → пусто

	mult := int64(1)
	switch {
	case strings.HasSuffix(s, "K"):
		mult, s = 1<<10, strings.TrimSuffix(s, "K")
	case strings.HasSuffix(s, "M"):
		mult, s = 1<<20, strings.TrimSuffix(s, "M")
	case strings.HasSuffix(s, "G"):
		mult, s = 1<<30, strings.TrimSuffix(s, "G")
	case strings.HasSuffix(s, "T"):
		mult, s = 1<<40, strings.TrimSuffix(s, "T")
	}

	s = strings.TrimSpace(s)
	if s == "" {
		return 0, fmt.Errorf("нет числа")
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, fmt.Errorf("не разобрал размер")
	}
	if f < 0 {
		return 0, fmt.Errorf("размер не может быть отрицательным")
	}
	return int64(f * float64(mult)), nil
}

// FormatSize — размер для показа человеку: «1.4 ГБ», «310 МБ».
func FormatSize(n int64) string {
	switch {
	case n <= 0:
		return "0 Б"
	case n < 1<<10:
		return fmt.Sprintf("%d Б", n)
	case n < 1<<20:
		return fmt.Sprintf("%.0f КБ", float64(n)/(1<<10))
	case n < 1<<30:
		return fmt.Sprintf("%.0f МБ", float64(n)/(1<<20))
	default:
		return fmt.Sprintf("%.1f ГБ", float64(n)/(1<<30))
	}
}

// FormatFlag — значение размера для значения по умолчанию у флага: пустой
// предел показывается как "0", а не как "0 Б".
func FormatFlag(n int64) string {
	if n <= 0 {
		return "0"
	}
	return strconv.FormatInt(n, 10)
}

// SetLimits меняет пределы на ходу — их правят из раздела «Настройки» у ДМ,
// и ради этого перезапускать сервер не нужно. Счётчики помечаются
// устаревшими: при снятом пределе они не пересчитывались, и доверять им
// после включения нельзя.
func (t *Tracker) SetLimits(total, world int64) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.totalLimit = total
	t.worldLimit = world
	t.total.scannedAt = time.Time{}
	t.worlds = map[string]*counter{}
}

// FormatCompact — размер в той же записи, в какой его пишут в настройках:
// 5368709120 → "5GB". Нужен форме настроек: показать байтами значение,
// которое человек задал как «5GB», — значит заставить его считать степени
// двойки в уме.
func FormatCompact(n int64) string {
	if n <= 0 {
		return "0"
	}
	for _, unit := range []struct {
		size   int64
		suffix string
	}{
		{1 << 40, "TB"}, {1 << 30, "GB"}, {1 << 20, "MB"}, {1 << 10, "KB"},
	} {
		if n%unit.size == 0 {
			return strconv.FormatInt(n/unit.size, 10) + unit.suffix
		}
	}
	return strconv.FormatInt(n, 10)
}
