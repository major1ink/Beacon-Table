package domain

import (
	"regexp"
	"sort"
	"strings"
)

// Граф связей журнала: узлы — записи, рёбра — [[ссылки]] из текста и
// типизированные связи из блока ```связи. Разбор повторяет клиентский
// (web/src/notes/markdown.js, notes/relations.js): граф строится на сервере,
// потому что видимость ребра зависит от прав на чужие записи.

// RelationsFence — язык блока кода с типизированными связями. Блок кода, а не
// YAML-шапка: шапку файла занимают права (journalfile), а блок кода
// переживает WYSIWYG-редактор без потерь.
const RelationsFence = "связи"

// JournalRelation — одна строка блока: «враг: [[Звонарь Тобиас]]».
type JournalRelation struct {
	Type   string `json:"type"`
	Target string `json:"target"`
}

// JournalGraphNode — запись, которую viewer может прочитать.
type JournalGraphNode struct {
	ID     string   `json:"id"`
	Title  string   `json:"title"`
	Folder string   `json:"folder,omitempty"`
	Tags   []string `json:"tags,omitempty"`
	Shared bool     `json:"shared"`
}

// JournalGraphEdge — связь From → To, объявленная в записи From. Type пустой
// у простой [[ссылки]].
type JournalGraphEdge struct {
	From string `json:"from"`
	To   string `json:"to"`
	Type string `json:"type,omitempty"`
	// Secret — ни один игрок этой связи не видит (заполняется только для ДМ).
	Secret bool `json:"secret,omitempty"`
}

type JournalGraph struct {
	Nodes []JournalGraphNode `json:"nodes"`
	Edges []JournalGraphEdge `json:"edges"`
}

// Та же регулярка, что wikiLinkRe на клиенте: "[[/r 2d6]]" — макрос Foundry.
var wikiLinkRe = regexp.MustCompile(`\[\[([^/\]|][^\]|]*?)(?:\|[^\]]+?)?\]\]`)

var relationsFenceRe = regexp.MustCompile("(?m)^[ \t]*(```|~~~)[ \t]*" + RelationsFence + "[ \t]*\r?\n((?:.*\r?\n)*?)[ \t]*(```|~~~)[ \t]*$")

// codeRe — блоки и вставки кода: метки и ссылки внутри них не считаются.
var codeRe = regexp.MustCompile("(?s)```.*?```|`[^`\n]*`")

var tagRe = regexp.MustCompile(`(?:^|\s)#([\p{L}\d][\p{L}\d_/-]*)`)

// ParseJournalRelations — связи из всех блоков ```связи записи. Строка —
// «тип: [[Цель]], [[Цель 2]]»; строка «связи:» (как в шапке Obsidian)
// пропускается, чтобы вставленный оттуда блок тоже читался.
func ParseJournalRelations(content string) []JournalRelation {
	var out []JournalRelation
	for _, m := range relationsFenceRe.FindAllStringSubmatch(content, -1) {
		for _, line := range strings.Split(m[2], "\n") {
			kind, rest, ok := strings.Cut(strings.TrimSpace(line), ":")
			kind = strings.ToLower(strings.TrimSpace(strings.Trim(kind, "-* ")))
			if !ok || kind == "" || kind == RelationsFence {
				continue
			}
			for _, t := range wikiTargets(rest) {
				out = append(out, JournalRelation{Type: kind, Target: t})
			}
		}
	}
	return out
}

// JournalLinkTargets — цели [[ссылок]] текста вне блоков кода (в том числе
// вне ```связи — те уже типизированы).
func JournalLinkTargets(content string) []string {
	return wikiTargets(codeRe.ReplaceAllString(content, " "))
}

func wikiTargets(text string) []string {
	var out []string
	for _, m := range wikiLinkRe.FindAllStringSubmatch(text, -1) {
		// «[[Таверна#Подвал]]» — ссылка на раздел той же записи.
		t, _, _ := strings.Cut(m[1], "#")
		if t = strings.TrimSpace(t); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// JournalTags — #метки текста без повторов, в нижнем регистре.
func JournalTags(content string) []string {
	seen := map[string]bool{}
	var out []string
	for _, m := range tagRe.FindAllStringSubmatch(codeRe.ReplaceAllString(content, " "), -1) {
		t := strings.ToLower(m[1])
		if !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	return out
}

// ResolveJournalTarget — порт resolveWikiTarget с клиента: путь целиком,
// относительно папки, хвостом пути; без пути — та же папка, затем ближайшая
// по дереву. entries должны быть отсортированы так же, как список журнала.
func ResolveJournalTarget(target string, entries []*JournalEntry, fromFolder string) *JournalEntry {
	folder, title := splitWikiTarget(target)
	var list []*JournalEntry
	for _, e := range entries {
		if lower(e.Title) == lower(title) {
			list = append(list, e)
		}
	}
	if len(list) == 0 {
		return nil
	}
	if folder != "" {
		want := lower(folder)
		for _, e := range list {
			if lower(e.Folder) == want {
				return e
			}
		}
		if fromFolder != "" {
			rel := lower(fromFolder) + "/" + want
			for _, e := range list {
				if lower(e.Folder) == rel {
					return e
				}
			}
		}
		var tail []*JournalEntry
		for _, e := range list {
			if strings.HasSuffix(lower(e.Folder), "/"+want) {
				tail = append(tail, e)
			}
		}
		if len(tail) == 0 {
			return nil
		}
		return closestEntry(tail, fromFolder)
	}
	for _, e := range list {
		if lower(e.Folder) == lower(fromFolder) {
			return e
		}
	}
	return closestEntry(list, fromFolder)
}

func splitWikiTarget(target string) (folder, title string) {
	clean := strings.ReplaceAll(strings.TrimSpace(target), "\\", "/")
	for strings.Contains(clean, "//") {
		clean = strings.ReplaceAll(clean, "//", "/")
	}
	clean = strings.Trim(clean, "/")
	cut := strings.LastIndex(clean, "/")
	if cut < 0 {
		return "", clean
	}
	return clean[:cut], clean[cut+1:]
}

func lower(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

func commonPrefixLen(a, b string) int {
	x, y := strings.Split(lower(a), "/"), strings.Split(lower(b), "/")
	n := 0
	for n < len(x) && n < len(y) && x[n] == y[n] && x[n] != "" {
		n++
	}
	return n
}

func closestEntry(list []*JournalEntry, fromFolder string) *JournalEntry {
	best, score := list[0], commonPrefixLen(list[0].Folder, fromFolder)
	for _, e := range list[1:] {
		if s := commonPrefixLen(e.Folder, fromFolder); s > score {
			best, score = e, s
		}
	}
	return best
}

// BuildJournalGraph — граф глазами v. entries — все записи стола с текстом.
// Ссылка ищется среди записей, которые v видит в списке (как клик по ней у
// него на экране), а ребро показывается, только если v читает обе записи —
// значит, и ту, где связь объявлена. audience — игроки стола: по ним ДМ
// узнаёт, какие связи не видит никто, кроме него.
func BuildJournalGraph(entries []*JournalEntry, v JournalViewer, audience []JournalViewer) *JournalGraph {
	g := &JournalGraph{Nodes: []JournalGraphNode{}, Edges: []JournalGraphEdge{}}
	for _, e := range entries {
		if e.CanRead(v) {
			g.Nodes = append(g.Nodes, JournalGraphNode{
				ID: e.ID, Title: e.Title, Folder: e.Folder,
				Tags: JournalTags(e.Content), Shared: e.IsShared(),
			})
		}
	}
	g.Edges = journalEdges(entries, v)
	if v.IsDM && len(audience) > 0 {
		seen := map[string]bool{}
		for _, p := range audience {
			for _, e := range journalEdges(entries, p) {
				seen[edgeKey(e)] = true
			}
		}
		for i := range g.Edges {
			g.Edges[i].Secret = !seen[edgeKey(g.Edges[i])]
		}
	}
	return g
}

func edgeKey(e JournalGraphEdge) string { return e.From + "\x00" + e.To + "\x00" + e.Type }

func journalEdges(entries []*JournalEntry, v JournalViewer) []JournalGraphEdge {
	visible := make([]*JournalEntry, 0, len(entries))
	for _, e := range entries {
		if e.CanSee(v) {
			visible = append(visible, e)
		}
	}
	out := []JournalGraphEdge{}
	typed := map[string]bool{}  // пара, у которой уже есть типизированная связь
	linked := map[string]bool{} // простые ссылки — без направления
	pair := func(a, b string) string {
		if a > b {
			a, b = b, a
		}
		return a + "\x00" + b
	}
	add := func(from, to *JournalEntry, kind string) {
		if to == nil || to.ID == from.ID || !to.CanRead(v) {
			return
		}
		e := JournalGraphEdge{From: from.ID, To: to.ID, Type: kind}
		if kind != "" {
			if typed[edgeKey(e)] {
				return
			}
			typed[edgeKey(e)] = true
			typed[pair(from.ID, to.ID)] = true
		}
		out = append(out, e)
	}
	for _, from := range visible {
		if !from.CanRead(v) {
			continue
		}
		for _, r := range ParseJournalRelations(from.Content) {
			add(from, ResolveJournalTarget(r.Target, visible, from.Folder), r.Type)
		}
	}
	for _, from := range visible {
		if !from.CanRead(v) {
			continue
		}
		for _, t := range JournalLinkTargets(from.Content) {
			to := ResolveJournalTarget(t, visible, from.Folder)
			if to == nil || to.ID == from.ID || !to.CanRead(v) {
				continue
			}
			k := pair(from.ID, to.ID)
			if typed[k] || linked[k] {
				continue
			}
			linked[k] = true
			add(from, to, "")
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Type != "" && out[j].Type == "" })
	return out
}
