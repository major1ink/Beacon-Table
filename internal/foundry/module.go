package foundry

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	// maxArchiveBytes — потолок на скачиваемый zip. Модули с картами бывают
	// в сотни мегабайт, гигабайт — уже почти наверняка не то, что ДМ хотел
	// затащить на игровой стол одним кликом.
	maxArchiveBytes = 1 << 30
	// maxUnpackedBytes — суммарный распакованный размер. Отдельный лимит от
	// maxArchiveBytes — защита от zip-бомбы (маленький архив, огромное
	// содержимое).
	maxUnpackedBytes = 4 << 30
	// maxUnpackedFiles — второй край той же защиты: миллион пустых файлов
	// весит немного, но кладёт файловую систему.
	maxUnpackedFiles = 200000
	// cacheTTL — сколько распакованный модуль лежит в кэше. Импорт идёт в
	// несколько запросов (сначала разведка паков, потом пак за паком), и
	// перекачивать сотню мегабайт на каждый — глупо; вечно держать тоже
	// незачем.
	cacheTTL = 2 * time.Hour
)

// Module — распакованный пакет Foundry на диске.
type Module struct {
	Manifest *Manifest
	// Dir — корень распаковки архива.
	Dir string
	// Root — папка ВНУТРИ Dir, где лежит module.json/system.json. Архивы
	// собирают по-разному: у одних содержимое в корне zip, у других вложено
	// в папку с именем модуля — Root прячет эту разницу от остального кода.
	Root string
	// ArchiveManifest — манифест из самого архива (может отличаться от
	// скачанного по ссылке: у "latest"-манифеста версия обычно свежее).
	// Именно его packs[] описывают то, что реально лежит на диске, поэтому
	// разведка паков предпочитает его, когда он есть.
	ArchiveManifest *Manifest
}

// Packs — список компендиумов модуля: из манифеста в архиве, если он там
// нашёлся, иначе из скачанного по ссылке.
func (m *Module) Packs() []Pack {
	if m.ArchiveManifest != nil && len(m.ArchiveManifest.Packs) > 0 {
		return m.ArchiveManifest.Packs
	}
	return m.Manifest.Packs
}

// Cache — скачанные и распакованные модули на диске. Все загрузки
// сериализованы одним мьютексом: импорт делает ДМ вручную и редко,
// параллелить нечего, а два одновременных запроса на один и тот же модуль
// иначе распаковывались бы друг поверх друга.
type Cache struct {
	root   string
	client *http.Client
	mu     sync.Mutex
}

// NewCache — кэш в папке root (создаётся при первом обращении). client —
// http-клиент с таймаутом, общий на манифест и архив.
func NewCache(root string, client *http.Client) *Cache {
	return &Cache{root: root, client: client}
}

// Manifest — только манифест по ссылке, без скачивания архива: разведка
// перед импортом (какой это пакет и какие в нём паки) стоит килобайты, а не
// сотню мегабайт.
func (c *Cache) Manifest(ctx context.Context, manifestURL string) (*Manifest, error) {
	return FetchManifest(ctx, c.client, manifestURL)
}

// Module — распакованный модуль по ссылке на манифест: берёт из кэша, если
// он свежий, иначе качает архив и распаковывает.
func (c *Cache) Module(ctx context.Context, manifestURL string) (*Module, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	man, err := FetchManifest(ctx, c.client, manifestURL)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(man.Download) == "" {
		return nil, fmt.Errorf("в манифесте «%s» нет ссылки download — такой пакет и сам Foundry ставит только вручную", man.DisplayTitle())
	}

	dir := filepath.Join(c.root, cacheKey(man.Download))
	marker := filepath.Join(dir, ".unpacked")
	if info, err := os.Stat(marker); err == nil && time.Since(info.ModTime()) < cacheTTL {
		return openModule(dir, man)
	}
	if err := os.RemoveAll(dir); err != nil {
		return nil, fmt.Errorf("не удалось очистить кэш модуля: %w", err)
	}
	// Подметаем ДО создания своей папки: sweep сносит всё без свежей отметки
	// ".unpacked", а у нашей её и не будет до конца распаковки.
	c.sweep()
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, fmt.Errorf("не удалось создать папку кэша: %w", err)
	}

	archive, err := c.downloadArchive(ctx, man.Download, dir)
	if err != nil {
		return nil, err
	}
	defer func() { _ = os.Remove(archive) }()
	if err := unzip(archive, dir); err != nil {
		return nil, err
	}
	if err := os.WriteFile(marker, []byte(man.Download), 0o600); err != nil {
		return nil, fmt.Errorf("не удалось отметить кэш распакованным: %w", err)
	}
	return openModule(dir, man)
}

// sweep — удаляет из кэша всё, что старше cacheTTL. Вызывается перед новой
// загрузкой: отдельного демона ради двух-трёх папок заводить незачем.
func (c *Cache) sweep() {
	entries, err := os.ReadDir(c.root)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		info, err := os.Stat(filepath.Join(c.root, e.Name(), ".unpacked"))
		if err != nil || time.Since(info.ModTime()) > cacheTTL {
			_ = os.RemoveAll(filepath.Join(c.root, e.Name()))
		}
	}
}

func cacheKey(downloadURL string) string {
	sum := sha256.Sum256([]byte(downloadURL))
	return hex.EncodeToString(sum[:8])
}

// downloadArchive качает zip во временный файл рядом с папкой распаковки —
// в память такое не читают.
func (c *Cache) downloadArchive(ctx context.Context, rawURL, dir string) (string, error) {
	if err := checkURL(rawURL); err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return "", fmt.Errorf("некорректная ссылка на архив: %w", err)
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("не удалось скачать архив: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("сервер ответил %s на скачивание архива", resp.Status)
	}

	dst := filepath.Join(dir, "package.zip")
	f, err := os.Create(dst) //nolint:gosec // G304: путь собран из корня кэша и константы
	if err != nil {
		return "", fmt.Errorf("не удалось создать файл архива: %w", err)
	}
	defer f.Close()
	written, err := io.Copy(f, io.LimitReader(resp.Body, maxArchiveBytes+1))
	if err != nil {
		return "", fmt.Errorf("обрыв загрузки архива: %w", err)
	}
	if written > maxArchiveBytes {
		return "", fmt.Errorf("архив модуля больше допустимого %d МиБ", int64(maxArchiveBytes)>>20)
	}
	return dst, nil
}

// unzip распаковывает архив в dir. Записи с ".." в пути (zip slip),
// симлинки и прочие не-обычные файлы пропускаются молча: чинить чужой архив
// мы не беремся, но и выпустить его за пределы своей папки не даём.
func unzip(archive, dir string) error {
	zr, err := zip.OpenReader(archive)
	if err != nil {
		return fmt.Errorf("не удалось открыть архив (это точно zip?): %w", err)
	}
	defer func() { _ = zr.Close() }()

	var total int64
	var files int
	for _, entry := range zr.File {
		target, ok := safeJoin(dir, entry.Name)
		if !ok {
			continue
		}
		if entry.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o750); err != nil {
				return err
			}
			continue
		}
		if !entry.FileInfo().Mode().IsRegular() {
			continue
		}
		files++
		if files > maxUnpackedFiles {
			return fmt.Errorf("в архиве больше %d файлов — это не похоже на модуль Foundry", maxUnpackedFiles)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o750); err != nil {
			return err
		}
		n, err := extractFile(entry, target, maxUnpackedBytes-total)
		if err != nil {
			return err
		}
		total += n
	}
	return nil
}

func extractFile(entry *zip.File, target string, budget int64) (int64, error) {
	if budget <= 0 {
		return 0, fmt.Errorf("распакованный модуль больше допустимых %d ГиБ", int64(maxUnpackedBytes)>>30)
	}
	rc, err := entry.Open()
	if err != nil {
		return 0, fmt.Errorf("не удалось прочитать %s из архива: %w", entry.Name, err)
	}
	defer rc.Close()
	out, err := os.Create(target) //nolint:gosec // G304: target прошёл через safeJoin — за пределы dir не выходит
	if err != nil {
		return 0, fmt.Errorf("не удалось записать %s: %w", entry.Name, err)
	}
	defer out.Close()
	n, err := io.Copy(out, io.LimitReader(rc, budget+1))
	if err != nil {
		return n, fmt.Errorf("обрыв распаковки %s: %w", entry.Name, err)
	}
	if n > budget {
		return n, fmt.Errorf("распакованный модуль больше допустимых %d ГиБ", int64(maxUnpackedBytes)>>30)
	}
	return n, nil
}

// safeJoin — путь внутри dir по имени записи архива. ok=false, если имя
// уводит наружу (абсолютный путь, ".." в середине, разделители Windows в
// чужом архиве).
func safeJoin(dir, name string) (string, bool) {
	clean := filepath.Clean(filepath.FromSlash(strings.ReplaceAll(name, "\\", "/")))
	if clean == "." || filepath.IsAbs(clean) || strings.HasPrefix(clean, "..") {
		return "", false
	}
	target := filepath.Join(dir, clean)
	rel, err := filepath.Rel(dir, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	return target, true
}

// openModule находит внутри распакованного архива папку с манифестом.
func openModule(dir string, man *Manifest) (*Module, error) {
	root, archiveManifest, err := findManifestDir(dir)
	if err != nil {
		return nil, err
	}
	return &Module{Manifest: man, Dir: dir, Root: root, ArchiveManifest: archiveManifest}, nil
}

// findManifestDir — обход первых двух уровней распаковки в поисках
// module.json/system.json. Глубже не ходим: если манифест лежит на третьем
// уровне вложенности, это уже не архив модуля, а чей-то бэкап целиком.
func findManifestDir(dir string) (string, *Manifest, error) {
	candidates := []string{dir}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", nil, fmt.Errorf("не удалось прочитать распакованный модуль: %w", err)
	}
	for _, e := range entries {
		if e.IsDir() {
			candidates = append(candidates, filepath.Join(dir, e.Name()))
		}
	}
	for _, c := range candidates {
		for _, name := range []string{"module.json", "system.json"} {
			data, err := os.ReadFile(filepath.Join(c, name)) //nolint:gosec // G304: путь собран из корня кэша и константы
			if err != nil {
				continue
			}
			var m Manifest
			if err := json.Unmarshal(data, &m); err != nil {
				continue
			}
			return c, &m, nil
		}
	}
	// Манифеста в архиве нет — не смертельно: паки ищутся по путям из
	// скачанного манифеста, а он у нас уже есть. Считаем корнем сам архив.
	return dir, nil, nil
}
