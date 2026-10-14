package domain

import (
	"reflect"
	"testing"
)

func TestParseJournalRelations(t *testing.T) {
	content := "# Орден Тихого Звона\n\n```связи\nсвязи:\n  подчинённый: [[Марго Вейл]], [[Брат Ансельм|брат]]\n  Враг: [[Звонарь Тобиас#Логово]]\nпросто строка [[Не связь]]\n```\n\nУпомянут [[Город Вельтор]].\n"
	got := ParseJournalRelations(content)
	want := []JournalRelation{
		{Type: "подчинённый", Target: "Марго Вейл"},
		{Type: "подчинённый", Target: "Брат Ансельм"},
		{Type: "враг", Target: "Звонарь Тобиас"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("связи: %+v", got)
	}
	// Ссылки из блока связей и макросы Foundry простыми ссылками не считаются.
	links := JournalLinkTargets(content + "Бросок [[/r 2d6]], код `[[Нет]]`.")
	if !reflect.DeepEqual(links, []string{"Город Вельтор"}) {
		t.Fatalf("ссылки: %v", links)
	}
}

func TestJournalTags(t *testing.T) {
	got := JournalTags("# Заголовок\n## Раздел\n#НПС и #нпс, #место/город, a#b, `#код`")
	if !reflect.DeepEqual(got, []string{"нпс", "место/город"}) {
		t.Fatalf("метки: %v", got)
	}
}

func TestResolveJournalTargetPrefersSameFolder(t *testing.T) {
	entries := []*JournalEntry{
		{ID: "a", Title: "Таверна", Folder: "Глава 1"},
		{ID: "b", Title: "Таверна", Folder: "Глава 2"},
		{ID: "c", Title: "Марго", Folder: "Глава 2/NPC"},
	}
	if e := ResolveJournalTarget("Таверна", entries, "Глава 2"); e == nil || e.ID != "b" {
		t.Fatalf("та же папка: %+v", e)
	}
	if e := ResolveJournalTarget("Глава 1/таверна", entries, "Глава 2"); e == nil || e.ID != "a" {
		t.Fatalf("путь: %+v", e)
	}
	if e := ResolveJournalTarget("NPC/Марго", entries, "Глава 2"); e == nil || e.ID != "c" {
		t.Fatalf("относительный путь: %+v", e)
	}
	if e := ResolveJournalTarget("Глава 3/Таверна", entries, ""); e != nil {
		t.Fatalf("чужая папка не подставляется: %+v", e)
	}
}

// Связь видна, только если читаешь обе записи — ту, где она объявлена, и ту,
// на которую она указывает.
func TestBuildJournalGraphRespectsAccess(t *testing.T) {
	liara := JournalViewer{ID: "liara"}
	dm := JournalViewer{ID: "dm", IsDM: true}
	shared := Sharing{Default: JournalObserver}
	entries := []*JournalEntry{
		{ID: "order", Title: "Орден", Folder: "Фракции", Sharing: Sharing{Default: JournalLimited},
			Content: "# Орден\n```связи\nподчинённый: [[Марго]]\n```\n"},
		{ID: "margo", Title: "Марго", Folder: "NPC", Sharing: shared,
			Content: "# Марго\n```связи\nсоюзник: [[Тобиас]]\n```\nСм. [[Колокольня]] и [[Тобиас]] #нпс"},
		{ID: "tobias", Title: "Тобиас", Folder: "NPC", Sharing: shared, Content: "# Тобиас\n[[Марго]]"},
		{ID: "tower", Title: "Колокольня", Folder: "Места", Sharing: shared, Content: "# Колокольня"},
		{ID: "secret", Title: "Тайник", Sharing: Sharing{Default: JournalNone}, Content: "# Тайник\n[[Марго]]"},
	}

	g := BuildJournalGraph(entries, liara, nil)
	if len(g.Nodes) != 3 {
		t.Fatalf("игрок читает три записи: %+v", g.Nodes)
	}
	want := []JournalGraphEdge{
		{From: "margo", To: "tobias", Type: "союзник"},
		{From: "margo", To: "tower"},
	}
	if !reflect.DeepEqual(g.Edges, want) {
		t.Fatalf("рёбра игрока: %+v", g.Edges)
	}
	if !reflect.DeepEqual(g.Nodes[0].Tags, []string{"нпс"}) {
		t.Fatalf("метки узла: %+v", g.Nodes[0])
	}

	g = BuildJournalGraph(entries, dm, []JournalViewer{liara})
	secret := map[string]bool{}
	for _, e := range g.Edges {
		secret[e.From+">"+e.To] = e.Secret
	}
	if len(g.Edges) != 4 || !secret["order>margo"] || !secret["secret>margo"] || secret["margo>tobias"] {
		t.Fatalf("рёбра ДМ: %+v", g.Edges)
	}
}
