package modcatalog

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"beacon-table/internal/modtool"
)

// repo — каталог на httptest: модули упаковываются btmod-ом, index.json
// собирается по ним.
type repo struct {
	t       *testing.T
	out     string
	entries []modtool.IndexEntry
	srv     *httptest.Server
	hits    atomic.Int32
}

func newRepo(t *testing.T) *repo {
	t.Helper()
	r := &repo{t: t, out: t.TempDir()}
	mux := http.NewServeMux()
	mux.HandleFunc("/index.json", func(w http.ResponseWriter, _ *http.Request) {
		r.hits.Add(1)
		_ = json.NewEncoder(w).Encode(modtool.Index{Format: modtool.IndexFormat, Modules: r.entries})
	})
	mux.Handle("/", http.FileServer(http.Dir(r.out)))
	r.srv = httptest.NewServer(mux)
	t.Cleanup(r.srv.Close)
	return r
}

func (r *repo) index() string { return r.srv.URL + "/index.json" }

// add упаковывает модуль и вносит его в каталог; extra дописывается в манифест.
func (r *repo) add(id, version, typ, extra string) modtool.IndexEntry {
	r.t.Helper()
	dir := r.t.TempDir()
	manifest := fmt.Sprintf(`{"format":"beacon-module/v1","id":%q,"type":%q,"title":"Модуль %s","version":%q%s}`, id, typ, id, version, extra)
	files := map[string]string{
		"module.json":       manifest,
		"CHANGELOG.md":      "# Изменения\n\n## " + version + " — 2026-10-04\nТест.\n",
		"LICENSE":           "CC-BY-4.0",
		"bestiary/a.json":   `{"name":"Волк","ac":13,"hp":11}`,
		"bestiary/b.json":   `{"name":"Лиса","ac":12,"hp":5}`,
		"spells/spark.json": `{"name":"Искра","level":1}`,
	}
	if typ == "system" {
		files = map[string]string{"module.json": manifest, "CHANGELOG.md": files["CHANGELOG.md"], "LICENSE": "CC-BY-4.0"}
	}
	for name, content := range files {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o750); err != nil {
			r.t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
			r.t.Fatal(err)
		}
	}
	pack, err := modtool.PackModule(dir, r.out)
	if err != nil {
		r.t.Fatal(err)
	}
	sum, err := modtool.ReadSummary(filepath.Join(r.out, pack.Summary))
	if err != nil {
		r.t.Fatal(err)
	}
	e := modtool.IndexEntry{
		ID: id, Title: sum.Title, Type: typ, Version: version, MinAppVersion: sum.MinAppVersion, Systems: sum.Systems, Requires: sum.Requires,
		Size: pack.Size, SHA256: pack.SHA256, URL: r.srv.URL + "/" + pack.Archive, SummaryURL: r.srv.URL + "/" + pack.Summary,
	}
	r.entries = append(r.entries, e)
	return e
}

func (r *repo) catalog(t *testing.T) *Catalog {
	t.Helper()
	return New(Options{IndexURL: r.index(), Dir: t.TempDir(), AppVersion: "0.9.0", AllowPrivate: true})
}

func ids(list []Entry) string {
	out := make([]string, len(list))
	for i, e := range list {
		out[i] = e.ID + "@" + e.Version
	}
	return strings.Join(out, ",")
}

func TestListMergesSourcesAndKeepsNewest(t *testing.T) {
	a, b := newRepo(t), newRepo(t)
	a.add("rules", "1.0.0", "system", "")
	a.add("pack", "1.0.0", "content", "")
	b.add("pack", "1.2.0", "content", "")
	b.add("extra", "1.0.0", "content", "")
	bad := b.add("broken", "1.0.0", "content", "")
	bad.SHA256 = "нет"
	b.entries[len(b.entries)-1] = bad

	c := a.catalog(t)
	if err := c.SetSources([]string{b.index(), "http://127.0.0.1:1/index.json"}); err != nil {
		t.Fatal(err)
	}
	list, sources := c.List(context.Background(), false)
	if got := ids(list); got != "rules@1.0.0,extra@1.0.0,pack@1.2.0" {
		t.Fatalf("список: %s", got)
	}
	if len(sources) != 3 || !sources[0].Default || sources[0].Count != 2 || sources[1].Count != 2 || sources[2].Error == "" {
		t.Fatalf("источники: %+v", sources)
	}
	if list[2].Source != b.index() {
		t.Fatalf("источник записи: %s", list[2].Source)
	}
}

func TestListCachesIndex(t *testing.T) {
	r := newRepo(t)
	r.add("pack", "1.0.0", "content", "")
	c := r.catalog(t)
	c.List(context.Background(), false)
	c.List(context.Background(), false)
	if r.hits.Load() != 1 {
		t.Fatalf("индекс читался %d раз", r.hits.Load())
	}
	c.List(context.Background(), true)
	if r.hits.Load() != 2 {
		t.Fatalf("после обновления: %d", r.hits.Load())
	}
}

func TestListKeepsOldEntriesWhenIndexFails(t *testing.T) {
	r := newRepo(t)
	r.add("pack", "1.0.0", "content", "")
	c := r.catalog(t)
	c.List(context.Background(), false)
	r.srv.Close()
	list, sources := c.List(context.Background(), true)
	if len(list) != 1 || sources[0].Error == "" {
		t.Fatalf("список %v, источники %+v", ids(list), sources)
	}
}

func TestSummaryAndDownload(t *testing.T) {
	r := newRepo(t)
	r.add("pack", "1.0.0", "content", "")
	c := r.catalog(t)
	e, err := c.Find(context.Background(), "pack")
	if err != nil {
		t.Fatal(err)
	}
	s, err := c.Summary(context.Background(), e)
	if err != nil || s.Counts["bestiary"] != 2 || s.Counts["spells"] != 1 {
		t.Fatalf("сводка: %+v %v", s, err)
	}
	path, err := c.Download(context.Background(), e)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(path)
	if st, err := os.Stat(path); err != nil || st.Size() != e.Size {
		t.Fatalf("архив: %v %v", st, err)
	}
	if _, err := c.Find(context.Background(), "нет-такого"); err == nil {
		t.Fatal("ожидали ErrNotFound")
	}
}

func TestDownloadRejects(t *testing.T) {
	r := newRepo(t)
	e := r.add("pack", "1.0.0", "content", "")
	c := r.catalog(t)
	entry := func(f func(*Entry)) Entry {
		x := Entry{IndexEntry: e, Source: r.index()}
		f(&x)
		return x
	}
	for name, ent := range map[string]Entry{
		"чужая сумма":     entry(func(x *Entry) { x.SHA256 = strings.Repeat("a", 64) }),
		"другой размер":   entry(func(x *Entry) { x.Size++ }),
		"слишком большой": entry(func(x *Entry) { x.Size = MaxArchiveSize + 1 }),
		"нет файла":       entry(func(x *Entry) { x.URL = r.srv.URL + "/нет.btmod" }),
	} {
		if path, err := c.Download(context.Background(), ent); err == nil {
			_ = os.Remove(path)
			t.Errorf("%s: ожидали ошибку", name)
		}
	}
}

func TestDownloadURLChecksSum(t *testing.T) {
	r := newRepo(t)
	e := r.add("pack", "1.0.0", "content", "")
	c := r.catalog(t)
	path, sum, err := c.DownloadURL(context.Background(), e.URL, "")
	if err != nil || sum != e.SHA256 {
		t.Fatalf("без суммы: %q %v", sum, err)
	}
	_ = os.Remove(path)
	if _, _, err := c.DownloadURL(context.Background(), e.URL, strings.Repeat("b", 64)); err == nil {
		t.Fatal("ожидали ошибку суммы")
	}
	if _, _, err := c.DownloadURL(context.Background(), e.URL, "кривая"); err == nil {
		t.Fatal("ожидали ошибку формата суммы")
	}
}

func TestPlan(t *testing.T) {
	r := newRepo(t)
	r.add("rules", "1.2.0", "system", "")
	r.add("pack", "1.0.0", "content", `,"requires":[{"id":"rules","minVersion":"1.1.0"}]`)
	r.add("orphan", "1.0.0", "content", `,"requires":[{"id":"ghost"}]`)
	r.add("new", "1.0.0", "content", `,"minAppVersion":"1.0.0"`)
	c := r.catalog(t)
	ctx := context.Background()
	have := map[string]string{}
	lookup := func(id string) (string, bool) { v, ok := have[id]; return v, ok }

	plan, err := c.Plan(ctx, "pack", lookup)
	if err != nil || ids(plan) != "rules@1.2.0,pack@1.0.0" {
		t.Fatalf("без зависимостей на месте: %s %v", ids(plan), err)
	}
	have["rules"] = "1.1.0"
	if plan, err = c.Plan(ctx, "pack", lookup); err != nil || ids(plan) != "pack@1.0.0" {
		t.Fatalf("зависимость стоит: %s %v", ids(plan), err)
	}
	have["rules"] = "1.0.0"
	if plan, err = c.Plan(ctx, "pack", lookup); err != nil || ids(plan) != "rules@1.2.0,pack@1.0.0" {
		t.Fatalf("зависимость старая: %s %v", ids(plan), err)
	}
	have["pack"] = "1.0.0"
	have["rules"] = "1.2.0"
	if plan, err = c.Plan(ctx, "pack", lookup); err != nil || ids(plan) != "pack@1.0.0" {
		t.Fatalf("переустановка самого модуля: %s %v", ids(plan), err)
	}
	if _, err = c.Plan(ctx, "orphan", lookup); err == nil || !strings.Contains(err.Error(), "ghost") {
		t.Fatalf("зависимости нет в каталоге: %v", err)
	}
	if _, err = c.Plan(ctx, "new", lookup); err == nil || !strings.Contains(err.Error(), "обнови") {
		t.Fatalf("программа старая: %v", err)
	}
	if _, err = c.Plan(ctx, "нет", lookup); err == nil {
		t.Fatal("ожидали ErrNotFound")
	}
}

func TestCompatible(t *testing.T) {
	c := New(Options{Dir: t.TempDir(), AppVersion: "0.9.0"})
	need := func(v string) Entry { return Entry{IndexEntry: modtool.IndexEntry{MinAppVersion: v}} }
	if !c.Compatible(need("")) || !c.Compatible(need("0.9.0")) || c.Compatible(need("0.10.0")) {
		t.Fatal("сравнение версий")
	}
	dev := New(Options{Dir: t.TempDir(), AppVersion: "dev"})
	if !dev.Compatible(need("9.0.0")) {
		t.Fatal("сборка разработчика подходит всем")
	}
}

func TestSources(t *testing.T) {
	dir := t.TempDir()
	c := New(Options{Dir: dir, AppVersion: "0.9.0"})
	if err := c.SetSources([]string{"http://example.com/index.json"}); err == nil {
		t.Fatal("http без частной сети должен отклоняться")
	}
	if err := c.SetSources([]string{"ftp://x", "не адрес"}); err == nil {
		t.Fatal("кривые адреса")
	}
	many := make([]string, MaxSources)
	for i := range many {
		many[i] = fmt.Sprintf("https://example.com/%d/index.json", i)
	}
	if err := c.SetSources(many); err == nil {
		t.Fatal("слишком много адресов")
	}
	if err := c.SetSources([]string{" https://example.com/a/index.json ", "https://example.com/a/index.json", DefaultIndexURL, ""}); err != nil {
		t.Fatal(err)
	}
	if got := c.CustomSources(); len(got) != 1 || got[0] != "https://example.com/a/index.json" {
		t.Fatalf("адреса: %v", got)
	}
	again := New(Options{Dir: dir, AppVersion: "0.9.0"})
	if got := again.CustomSources(); len(got) != 1 {
		t.Fatalf("после перезапуска: %v", got)
	}
}

func TestPrivateNetworkBlocked(t *testing.T) {
	r := newRepo(t)
	r.add("pack", "1.0.0", "content", "")
	c := New(Options{IndexURL: r.index(), Dir: t.TempDir(), AppVersion: "0.9.0"})
	_, sources := c.List(context.Background(), false)
	if len(sources) != 1 || sources[0].Error == "" || sources[0].Count != 0 {
		t.Fatalf("локальный адрес без разрешения: %+v", sources)
	}
}

func TestWrongFormatIndex(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"format":"beacon-module-index/v9","modules":[]}`))
	}))
	defer srv.Close()
	c := New(Options{IndexURL: srv.URL, Dir: t.TempDir(), AppVersion: "0.9.0", AllowPrivate: true})
	if _, sources := c.List(context.Background(), false); sources[0].Error == "" {
		t.Fatalf("ожидали ошибку формата: %+v", sources)
	}
}
