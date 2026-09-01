package quota

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"beacon-table/internal/domain"
)

func fill(t *testing.T, path string, size int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, bytes.Repeat([]byte("x"), size), 0o600); err != nil {
		t.Fatal(err)
	}
}

// TestParseSize — размеры пишут по-человечески, и все привычные записи
// должны читаться одинаково.
func TestParseSize(t *testing.T) {
	cases := map[string]int64{
		"":       0,
		"0":      0,
		"1024":   1024,
		"1K":     1 << 10,
		"1KB":    1 << 10,
		"500MB":  500 << 20,
		"500 mb": 500 << 20,
		"20GB":   20 << 30,
		"1.5G":   1<<30 + 512<<20,
		"2TB":    2 << 40,
	}
	for in, want := range cases {
		got, err := ParseSize(in)
		if err != nil {
			t.Errorf("ParseSize(%q): %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("ParseSize(%q) = %d, ожидалось %d", in, got, want)
		}
	}
	for _, bad := range []string{"много", "-5GB", "GB", "12X"} {
		if _, err := ParseSize(bad); err == nil {
			t.Errorf("ParseSize(%q) принят", bad)
		}
	}
}

// TestNoLimitsAllowEverything — без заданных квот трекер не мешает ничему:
// установки, где место и так есть, не должны заметить эту функцию.
func TestNoLimitsAllowEverything(t *testing.T) {
	root := t.TempDir()
	tr := New(root, 0, 0)
	w := tr.World(filepath.Join(root, "companies", "w1"))

	if err := w.Reserve(1 << 40); err != nil {
		t.Fatalf("Reserve при снятых пределах: %v", err)
	}
	var buf bytes.Buffer
	n, err := w.CopyLimited(&buf, strings.NewReader("данные"))
	if err != nil || n != int64(len("данные")) {
		t.Fatalf("CopyLimited: n=%d err=%v", n, err)
	}
}

// TestWorldLimitStopsCopy — предел мира обрывает запись на середине, а не
// после того, как файл целиком лёг на диск.
func TestWorldLimitStopsCopy(t *testing.T) {
	root := t.TempDir()
	tr := New(root, 0, 100)
	w := tr.World(filepath.Join(root, "w1"))

	var buf bytes.Buffer
	n, err := w.CopyLimited(&buf, bytes.NewReader(bytes.Repeat([]byte("x"), 250)))
	if err == nil {
		t.Fatal("запись сверх предела мира прошла")
	}
	if !errors.Is(err, domain.ErrNoSpace) {
		t.Fatalf("ошибка не ErrNoSpace: %v", err)
	}
	if n > 101 {
		t.Fatalf("записано %d байт при пределе 100 — копирование не оборвалось вовремя", n)
	}
}

// TestTotalLimitStopsCopy — общий предел действует, даже если у мира своего
// предела нет.
func TestTotalLimitStopsCopy(t *testing.T) {
	root := t.TempDir()
	tr := New(root, 100, 0)
	w := tr.World(filepath.Join(root, "w1"))

	var buf bytes.Buffer
	if _, err := w.CopyLimited(&buf, bytes.NewReader(bytes.Repeat([]byte("x"), 250))); !errors.Is(err, domain.ErrNoSpace) {
		t.Fatalf("общий предел не сработал: %v", err)
	}
}

// TestWorldsAreIndependent — мир упирается в свой предел, не мешая соседям:
// ровно ради этого квота считается по мирам, а не только общей суммой.
func TestWorldsAreIndependent(t *testing.T) {
	root := t.TempDir()
	tr := New(root, 0, 100)
	first := tr.World(filepath.Join(root, "w1"))
	second := tr.World(filepath.Join(root, "w2"))

	first.Add(100) // первый мир выбрал свой предел целиком

	if err := first.Reserve(10); err == nil {
		t.Fatal("исчерпавший квоту мир принял ещё файл")
	}
	if err := second.Reserve(50); err != nil {
		t.Fatalf("соседний мир пострадал от чужой квоты: %v", err)
	}
}

// TestTotalCountsAllWorlds — общий предел учитывает сумму по мирам: два
// мира по половине лимита исчерпывают его вместе.
func TestTotalCountsAllWorlds(t *testing.T) {
	root := t.TempDir()
	tr := New(root, 100, 0)
	first := tr.World(filepath.Join(root, "w1"))
	second := tr.World(filepath.Join(root, "w2"))

	first.Add(60)
	second.Add(30)

	if err := second.Reserve(5); err != nil {
		t.Fatalf("влезающий файл отклонён: %v", err)
	}
	if err := second.Reserve(20); err == nil {
		t.Fatal("общий предел не сработал на сумме двух миров")
	}
}

// TestScanCountsExistingFiles — на старте трекер считает то, что уже лежит
// на диске: иначе после перезапуска квота начиналась бы с нуля.
func TestScanCountsExistingFiles(t *testing.T) {
	root := t.TempDir()
	fill(t, filepath.Join(root, "companies", "w1", "maps", "a.png"), 300)
	fill(t, filepath.Join(root, "companies", "w2", "maps", "b.png"), 200)

	tr := New(root, 1000, 1000)
	if err := tr.Scan(); err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if got := tr.TotalUsed(); got != 500 {
		t.Fatalf("посчитано %d байт, ожидалось 500", got)
	}
	if got := tr.World(filepath.Join(root, "companies", "w1")).Used(); got != 300 {
		t.Fatalf("у мира посчитано %d байт, ожидалось 300", got)
	}
}

// TestSubReturnsSpace — удаление файлов возвращает место: иначе квота
// исчерпалась бы навсегда, и «удалите лишнее» ничего бы не давало.
func TestSubReturnsSpace(t *testing.T) {
	root := t.TempDir()
	tr := New(root, 100, 0)
	w := tr.World(filepath.Join(root, "w1"))

	w.Add(100)
	if err := w.Reserve(10); err == nil {
		t.Fatal("место есть при исчерпанной квоте")
	}
	w.Sub(50)
	if err := w.Reserve(10); err != nil {
		t.Fatalf("после удаления место не вернулось: %v", err)
	}
}

// TestErrorMentionsNumbers — сообщение должно называть цифры: «место
// кончилось» без них не подсказывает, что делать.
func TestErrorMentionsNumbers(t *testing.T) {
	root := t.TempDir()
	tr := New(root, 0, 1<<20)
	w := tr.World(filepath.Join(root, "w1"))
	w.Add(1 << 20)

	err := w.Reserve(1024)
	if err == nil {
		t.Fatal("ошибки нет")
	}
	msg := err.Error()
	for _, want := range []string{"1 МБ", "Ассеты"} {
		if !strings.Contains(msg, want) {
			t.Errorf("в сообщении нет %q: %s", want, msg)
		}
	}
}

// TestFormatSize — цифры показываются человеку, а не в байтах.
func TestFormatSize(t *testing.T) {
	cases := map[int64]string{
		0:             "0 Б",
		512:           "512 Б",
		2048:          "2 КБ",
		5 << 20:       "5 МБ",
		3<<30 + 1<<29: "3.5 ГБ",
	}
	for in, want := range cases {
		if got := FormatSize(in); got != want {
			t.Errorf("FormatSize(%d) = %q, ожидалось %q", in, got, want)
		}
	}
}

// TestFormatCompact — значение возвращается в той же записи, в какой его
// задают: иначе форма настроек показывала бы «5368709120» вместо «5GB».
func TestFormatCompact(t *testing.T) {
	cases := map[int64]string{
		0:         "0",
		5 << 30:   "5GB",
		500 << 20: "500MB",
		10 << 10:  "10KB",
		1234:      "1234",
	}
	for in, want := range cases {
		got := FormatCompact(in)
		if got != want {
			t.Errorf("FormatCompact(%d) = %q, ожидалось %q", in, got, want)
		}
		// И читается обратно тем же парсером — форма сохраняет ровно то, что
		// показала.
		if back, err := ParseSize(got); err != nil || back != in {
			t.Errorf("ParseSize(FormatCompact(%d)) = %d, %v", in, back, err)
		}
	}
}
