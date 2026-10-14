// Package modcatalog — каталог модулей контента из интернета: индексы
// (modtool.Index), сводки и скачивание архивов. Ходит только по адресам из
// каталога по умолчанию и тем, что добавил владелец, через защищённый
// транспорт (foundry.GuardedTransport).
package modcatalog

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"beacon-table/internal/domain"
	"beacon-table/internal/foundry"
	"beacon-table/internal/modtool"
	"beacon-table/internal/module"
)

const (
	DefaultIndexURL = "https://major1ink.github.io/beacon-table-modules/index.json"
	MaxArchiveSize  = 64 << 20
	MaxSources      = 8

	maxIndexSize   = 4 << 20
	maxSummarySize = 4 << 20
	maxRedirects   = 8
	indexTTL       = 5 * time.Minute
	requestTimeout = 20 * time.Second
	archiveTimeout = 5 * time.Minute
	sourcesFile    = "module-sources.json"
)

var (
	ErrUnavailable = errors.New("каталог недоступен")
	ErrNotFound    = errors.New("модуля нет в каталоге")

	hexSHA = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)
)

// Entry — запись каталога и адрес индекса, из которого она взята.
type Entry struct {
	modtool.IndexEntry
	Source string `json:"source"`
}

// Source — адрес индекса и итог его последнего чтения.
type Source struct {
	URL     string `json:"url"`
	Default bool   `json:"default"`
	Count   int    `json:"count"`
	Error   string `json:"error,omitempty"`
}

type Options struct {
	IndexURL     string
	Dir          string
	AppVersion   string
	AllowPrivate bool
}

type cached struct {
	entries []Entry
	err     string
	at      time.Time
}

type Catalog struct {
	client       *http.Client
	defaultURL   string
	path         string
	appVersion   string
	allowPrivate bool

	mu     sync.Mutex
	custom []string
	cache  map[string]cached
}

func New(opt Options) *Catalog {
	c := &Catalog{
		client: &http.Client{
			Transport: foundry.GuardedTransport(opt.AllowPrivate),
			CheckRedirect: func(_ *http.Request, via []*http.Request) error {
				if len(via) >= maxRedirects {
					return errors.New("слишком много перенаправлений")
				}
				return nil
			},
		},
		defaultURL:   opt.IndexURL,
		path:         filepath.Join(opt.Dir, sourcesFile),
		appVersion:   opt.AppVersion,
		allowPrivate: opt.AllowPrivate,
		cache:        map[string]cached{},
	}
	if c.defaultURL == "" {
		c.defaultURL = DefaultIndexURL
	}
	c.custom = c.loadSources()
	return c
}

func (c *Catalog) loadSources() []string {
	data, err := os.ReadFile(c.path)
	if err != nil {
		return nil
	}
	var f struct {
		Sources []string `json:"sources"`
	}
	if json.Unmarshal(data, &f) != nil {
		return nil
	}
	out := make([]string, 0, len(f.Sources))
	for _, u := range f.Sources {
		if c.checkURL(u) == nil && u != c.defaultURL {
			out = append(out, u)
		}
	}
	return out
}

func (c *Catalog) checkURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return validation("%q — не адрес", raw)
	}
	if u.Scheme != "https" && (u.Scheme != "http" || !c.allowPrivate) {
		return validation("адрес %q: нужен https", raw)
	}
	return nil
}

func validation(format string, args ...any) error {
	return &domain.ValidationError{Msg: fmt.Sprintf(format, args...)}
}

// Compatible — подходит ли запись этой версии программы; сборка разработчика
// подходит всем.
func (c *Catalog) Compatible(e Entry) bool {
	if e.MinAppVersion == "" {
		return true
	}
	app, err := module.ParseVersion(c.appVersion)
	if err != nil {
		return true
	}
	need, err := module.ParseVersion(e.MinAppVersion)
	return err != nil || !app.Less(need)
}

// CustomSources — адреса, добавленные владельцем.
func (c *Catalog) CustomSources() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string{}, c.custom...)
}

// SetSources заменяет добавленные адреса; каталог по умолчанию остаётся.
func (c *Catalog) SetSources(urls []string) error {
	seen := map[string]bool{c.defaultURL: true}
	clean := make([]string, 0, len(urls))
	for _, raw := range urls {
		raw = strings.TrimSpace(raw)
		if raw == "" || seen[raw] {
			continue
		}
		if err := c.checkURL(raw); err != nil {
			return err
		}
		seen[raw] = true
		clean = append(clean, raw)
	}
	if len(clean) > MaxSources-1 {
		return validation("адресов каталога не больше %d", MaxSources-1)
	}
	data, err := json.MarshalIndent(map[string]any{"sources": clean}, "", "  ")
	if err != nil {
		return err
	}
	tmp := c.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, c.path); err != nil {
		return err
	}
	c.mu.Lock()
	c.custom = clean
	c.cache = map[string]cached{}
	c.mu.Unlock()
	return nil
}

// List — модули всех каталогов: из нескольких адресов остаётся запись с
// наибольшей версией, при равенстве — из более раннего. refresh читает
// индексы заново, иначе — из кеша не старше indexTTL.
func (c *Catalog) List(ctx context.Context, refresh bool) ([]Entry, []Source) {
	c.mu.Lock()
	urls := append([]string{c.defaultURL}, c.custom...)
	c.mu.Unlock()

	got := make([]cached, len(urls))
	var wg sync.WaitGroup
	for i, u := range urls {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got[i] = c.index(ctx, u, refresh)
		}()
	}
	wg.Wait()

	best := map[string]Entry{}
	sources := make([]Source, len(urls))
	for i, u := range urls {
		sources[i] = Source{URL: u, Default: i == 0, Count: len(got[i].entries), Error: got[i].err}
		for _, e := range got[i].entries {
			if cur, ok := best[e.ID]; !ok || Newer(e.Version, cur.Version) {
				best[e.ID] = e
			}
		}
	}
	out := make([]Entry, 0, len(best))
	for _, e := range best {
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool {
		if (out[i].Type == module.TypeSystem) != (out[j].Type == module.TypeSystem) {
			return out[i].Type == module.TypeSystem
		}
		return strings.ToLower(out[i].Title) < strings.ToLower(out[j].Title)
	})
	return out, sources
}

// Newer — версия a новее версии b.
func Newer(a, b string) bool {
	va, err1 := module.ParseVersion(a)
	vb, err2 := module.ParseVersion(b)
	return err1 == nil && err2 == nil && vb.Less(va)
}

func (c *Catalog) index(ctx context.Context, src string, refresh bool) cached {
	c.mu.Lock()
	hit, ok := c.cache[src]
	c.mu.Unlock()
	if ok && !refresh && time.Since(hit.at) < indexTTL {
		return hit
	}
	res := cached{at: time.Now()}
	entries, err := c.fetchIndex(ctx, src)
	if err != nil {
		res.err = err.Error()
		if ok {
			res.entries = hit.entries
		}
	} else {
		res.entries = entries
	}
	c.mu.Lock()
	c.cache[src] = res
	c.mu.Unlock()
	return res
}

func (c *Catalog) fetchIndex(ctx context.Context, src string) ([]Entry, error) {
	data, err := c.get(ctx, src, maxIndexSize)
	if err != nil {
		return nil, err
	}
	var idx modtool.Index
	if err := json.Unmarshal(data, &idx); err != nil {
		return nil, fmt.Errorf("каталог %s не разбирается: %w", src, err)
	}
	if idx.Format != modtool.IndexFormat {
		return nil, fmt.Errorf("каталог %s: формат %q не поддерживается — обнови программу", src, idx.Format)
	}
	out := make([]Entry, 0, len(idx.Modules))
	for _, e := range idx.Modules {
		if c.validEntry(e) {
			out = append(out, Entry{IndexEntry: e, Source: src})
		}
	}
	return out, nil
}

func (c *Catalog) validEntry(e modtool.IndexEntry) bool {
	if _, err := module.ParseVersion(e.Version); err != nil {
		return false
	}
	return e.ID != "" && e.Title != "" && (e.Type == module.TypeSystem || e.Type == module.TypeContent) &&
		hexSHA.MatchString(e.SHA256) && c.checkURL(e.URL) == nil && c.checkURL(e.SummaryURL) == nil
}

// Find — запись каталога по id модуля.
func (c *Catalog) Find(ctx context.Context, id string) (Entry, error) {
	list, _ := c.List(ctx, false)
	for _, e := range list {
		if e.ID == id {
			return e, nil
		}
	}
	return Entry{}, ErrNotFound
}

// Plan — что поставить, чтобы появился модуль id: недостающие зависимости
// (have отдаёт версию установленного модуля) и затем он сам, в порядке
// установки. Уже стоящий и подходящий модуль в план не попадает.
func (c *Catalog) Plan(ctx context.Context, id string, have func(id string) (string, bool)) ([]Entry, error) {
	var plan []Entry
	seen := map[string]bool{}
	var visit func(id, minVersion string, root bool) error
	visit = func(id, minVersion string, root bool) error {
		if seen[id] {
			return nil
		}
		seen[id] = true
		if v, ok := have(id); ok && !root && (minVersion == "" || !Newer(minVersion, v)) {
			return nil
		}
		e, err := c.Find(ctx, id)
		if err != nil {
			if root {
				return err
			}
			return validation("нужен модуль %s, но его нет в каталоге — поставь его из файла", id)
		}
		if !c.Compatible(e) {
			return validation("модулю %s нужна программа не ниже %s — обнови Beacon Table", e.ID, e.MinAppVersion)
		}
		for _, d := range e.Requires {
			if err := visit(d.ID, d.MinVersion, false); err != nil {
				return err
			}
		}
		plan = append(plan, e)
		return nil
	}
	if err := visit(id, "", true); err != nil {
		return nil, err
	}
	return plan, nil
}

// Summary — состав модуля из summary.json; сам архив не скачивается.
func (c *Catalog) Summary(ctx context.Context, e Entry) (*modtool.Summary, error) {
	data, err := c.get(ctx, e.SummaryURL, maxSummarySize)
	if err != nil {
		return nil, err
	}
	var s modtool.Summary
	if err := json.Unmarshal(data, &s); err != nil || s.ID != e.ID {
		return nil, fmt.Errorf("%w: сводка модуля %s не разбирается", ErrUnavailable, e.ID)
	}
	return &s, nil
}

// Download скачивает архив записи во временный файл и сверяет размер и
// sha256 с каталогом; файл удаляет вызывающий.
func (c *Catalog) Download(ctx context.Context, e Entry) (string, error) {
	if e.Size > MaxArchiveSize {
		return "", tooBig()
	}
	path, _, err := c.download(ctx, e.URL, e.SHA256, e.Size)
	return path, err
}

// DownloadURL скачивает архив по ссылке; wantSHA, если задан, сверяется.
func (c *Catalog) DownloadURL(ctx context.Context, raw, wantSHA string) (path, sum string, err error) {
	if wantSHA != "" && !hexSHA.MatchString(wantSHA) {
		return "", "", validation("контрольная сумма: нужны 64 шестнадцатеричных символа")
	}
	return c.download(ctx, raw, wantSHA, 0)
}

func tooBig() error {
	return validation("архив больше %d МБ", MaxArchiveSize>>20)
}

func (c *Catalog) open(ctx context.Context, raw string, timeout time.Duration) (*http.Response, context.CancelFunc, error) {
	if err := c.checkURL(raw); err != nil {
		return nil, nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		cancel()
		return nil, nil, validation("%q — не адрес", raw)
	}
	resp, err := c.client.Do(req)
	if err != nil {
		cancel()
		return nil, nil, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	if resp.StatusCode != http.StatusOK {
		_ = resp.Body.Close()
		cancel()
		return nil, nil, fmt.Errorf("%w: %s ответил %d", ErrUnavailable, raw, resp.StatusCode)
	}
	return resp, cancel, nil
}

func (c *Catalog) get(ctx context.Context, raw string, limit int64) ([]byte, error) {
	resp, cancel, err := c.open(ctx, raw, requestTimeout)
	if err != nil {
		return nil, err
	}
	defer cancel()
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("%w: ответ %s слишком большой", ErrUnavailable, raw)
	}
	return data, nil
}

func (c *Catalog) download(ctx context.Context, raw, wantSHA string, wantSize int64) (string, string, error) {
	resp, cancel, err := c.open(ctx, raw, archiveTimeout)
	if err != nil {
		return "", "", err
	}
	defer cancel()
	defer resp.Body.Close()
	if resp.ContentLength > MaxArchiveSize {
		return "", "", tooBig()
	}
	tmp, err := os.CreateTemp("", "beacon-module-*.btmod")
	if err != nil {
		return "", "", err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(resp.Body, MaxArchiveSize+1))
	closeErr := tmp.Close()
	fail := func(err error) (string, string, error) {
		_ = os.Remove(tmp.Name())
		return "", "", err
	}
	switch {
	case err != nil:
		return fail(fmt.Errorf("%w: %w", ErrUnavailable, err))
	case closeErr != nil:
		return fail(closeErr)
	case n > MaxArchiveSize:
		return fail(tooBig())
	case wantSize > 0 && n != wantSize:
		return fail(validation("размер архива не совпал с каталогом: %d вместо %d байт", n, wantSize))
	}
	sum := hex.EncodeToString(h.Sum(nil))
	if wantSHA != "" && !strings.EqualFold(sum, wantSHA) {
		return fail(validation("контрольная сумма архива не совпала — архив не установлен"))
	}
	return tmp.Name(), sum, nil
}
