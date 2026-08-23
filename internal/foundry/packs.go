package foundry

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/syndtr/goleveldb/leveldb"
	"github.com/syndtr/goleveldb/leveldb/opt"
)

// Doc — один документ компендиума как есть, без перевода в domain: карточки
// (предметы/заклинания/существа/справочник/состояния) маппит клиент теми же
// функциями, что и раньше для одиночного файла экспорта (см. package-doc).
type Doc map[string]any

// maxDocsPerPack — потолок на количество документов в одном паке. Самые
// толстые официальные компендиумы — это тысячи записей; сто тысяч означает,
// что мы читаем не то (или что чтение зациклилось).
const maxDocsPerPack = 100000

// ReadPack читает один компендиум модуля. Поддерживаются три формата, в
// которых Foundry за свою историю хранил паки:
//
//   - каталог LevelDB (v11 и новее) — бинарный, документы лежат россыпью,
//     вложенные (предметы актёра, страницы журнала, стены сцены) — отдельными
//     записями со своим ключом, их надо собирать обратно, см. assemble;
//   - файл .db формата NeDB (v10 и раньше) — построчный JSON;
//   - каталог с .json-файлами — так выглядят исходники паков (packs/_source)
//     у модулей, которые кладут их в релиз рядом со сборкой.
func (m *Module) ReadPack(p Pack) ([]Doc, error) {
	path, err := m.packPath(p)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("пак «%s» не читается: %w", p.Name, err)
	}
	if info.IsDir() {
		if _, err := os.Stat(filepath.Join(path, "CURRENT")); err == nil {
			return readLevelDB(path)
		}
		return readJSONDir(path)
	}
	if strings.EqualFold(filepath.Ext(path), ".json") {
		return readJSONFile(path)
	}
	return readNeDB(path)
}

// packPath — где на диске лежит пак. Path в манифесте пишут по-разному:
// относительно корня модуля ("packs/spells.db"), от корня данных Foundry
// ("modules/my-module/packs/spells") и изредка с "./" в начале. Плюс
// сборка релиза может не совпадать с манифестом (пак собран в LevelDB, а в
// манифесте остался старый .db) — поэтому кандидатов несколько.
func (m *Module) packPath(p Pack) (string, error) {
	rel := strings.TrimPrefix(filepath.ToSlash(strings.TrimSpace(p.Path)), "./")
	rel = strings.TrimPrefix(rel, "/")
	// "modules/<id>/packs/x" и "systems/<id>/packs/x" — путь от корня данных
	// Foundry, а не от корня модуля: отрезаем два первых сегмента.
	if parts := strings.SplitN(rel, "/", 3); len(parts) == 3 && (parts[0] == "modules" || parts[0] == "systems" || parts[0] == "worlds") {
		rel = parts[2]
	}

	candidates := make([]string, 0, 8)
	add := func(base, sub string) {
		if base == "" || sub == "" {
			return
		}
		target, ok := safeJoin(base, sub)
		if ok {
			candidates = append(candidates, target)
		}
	}
	for _, base := range []string{m.Root, m.Dir} {
		add(base, rel)
		if p.Name != "" {
			add(base, "packs/"+p.Name)
			add(base, "packs/"+p.Name+".db")
			add(base, "packs/_source/"+p.Name)
			add(base, "packs/"+p.Name+".json")
		}
		if strings.HasSuffix(rel, ".db") {
			add(base, strings.TrimSuffix(rel, ".db")) // .db в манифесте, LevelDB-каталог в релизе
		}
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return c, nil
		}
	}
	return "", fmt.Errorf("пак «%s» не найден в архиве (ожидался %s)", p.Name, p.Path)
}

// ---- LevelDB (Foundry v11+) ----

// readLevelDB читает каталог LevelDB целиком в память. ReadOnly — чтобы не
// трогать LOCK и не дописывать в чужой пак ничего своего.
func readLevelDB(dir string) ([]Doc, error) {
	db, err := leveldb.OpenFile(dir, &opt.Options{ReadOnly: true, ErrorIfMissing: true})
	if err != nil {
		return nil, fmt.Errorf("не удалось открыть пак LevelDB: %w", err)
	}
	defer func() { _ = db.Close() }()

	type entry struct {
		key   string
		value []byte
	}
	entries := make([]entry, 0, 256)
	iter := db.NewIterator(nil, nil)
	for iter.Next() {
		if len(entries) >= maxDocsPerPack {
			break
		}
		entries = append(entries, entry{key: string(iter.Key()), value: append([]byte(nil), iter.Value()...)})
	}
	iter.Release()
	if err := iter.Error(); err != nil {
		return nil, fmt.Errorf("ошибка чтения пака LevelDB: %w", err)
	}

	// Разбираем ключи вида "!items!ID" (документ пака) и
	// "!actors.items!ACTORID.ITEMID" (вложенный документ). Сначала все
	// верхнеуровневые, потом вложенные по возрастанию глубины — иначе
	// вложенному будет некуда лечь.
	type parsed struct {
		colls []string
		ids   []string
		value []byte
	}
	all := make([]parsed, 0, len(entries))
	for _, e := range entries {
		colls, ids, ok := splitPackKey(e.key)
		if !ok || colls[0] == "folders" {
			continue // папки — это организация компендиума, а не содержимое
		}
		all = append(all, parsed{colls: colls, ids: ids, value: e.value})
	}
	sort.SliceStable(all, func(i, j int) bool { return len(all[i].colls) < len(all[j].colls) })

	order := make([]string, 0, len(all))
	byID := make(map[string]Doc, len(all))
	for _, p := range all {
		doc, err := decodeDoc(p.value)
		if err != nil {
			continue // один битый документ не повод ронять весь пак
		}
		if len(p.colls) == 1 {
			if _, exists := byID[p.ids[0]]; !exists {
				order = append(order, p.ids[0])
			}
			byID[p.ids[0]] = doc
			continue
		}
		attachEmbedded(byID[p.ids[0]], embeddedPath(p.colls[1:], p.ids[1:]), doc)
	}

	out := make([]Doc, 0, len(order))
	for _, id := range order {
		out = append(out, byID[id])
	}
	return out, nil
}

// splitPackKey разбирает ключ записи LevelDB: "!" + путь коллекций через
// точку + "!" + путь идентификаторов через точку. Длины путей должны
// совпадать — иначе это служебная запись, не документ.
func splitPackKey(key string) (colls, ids []string, ok bool) {
	if !strings.HasPrefix(key, "!") {
		return nil, nil, false
	}
	parts := strings.Split(strings.TrimPrefix(key, "!"), "!")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return nil, nil, false
	}
	colls = strings.Split(parts[0], ".")
	ids = strings.Split(parts[1], ".")
	if len(colls) != len(ids) {
		return nil, nil, false
	}
	return colls, ids, true
}

// embeddedStep — один шаг пути к вложенному документу: имя коллекции внутри
// родителя ("items", "pages", "effects") и id документа в ней. Пара, а не
// два параллельных среза, ровно потому, что рассинхронизировать их тогда
// нельзя в принципе.
type embeddedStep struct {
	coll string
	id   string
}

// embeddedPath собирает путь от документа пака к вложенному по разобранному
// ключу (см. splitPackKey): первый сегмент — сам документ, дальше вложения.
func embeddedPath(colls, ids []string) []embeddedStep {
	path := make([]embeddedStep, 0, len(colls))
	for i := range colls {
		if i >= len(ids) {
			break
		}
		path = append(path, embeddedStep{coll: colls[i], id: ids[i]})
	}
	return path
}

// attachEmbedded кладёт вложенный документ на его место в родителе: path —
// путь ОТ родителя ("items" у предмета актёра, "pages" у страницы журнала,
// "items"→"effects" у эффекта предмета внутри актёра). Родителя может не
// быть (битый пак) — тогда просто ничего не делаем.
func attachEmbedded(parent Doc, path []embeddedStep, doc Doc) {
	if parent == nil || len(path) == 0 {
		return
	}
	field := path[0].coll
	list, _ := parent[field].([]any)
	if len(path) == 1 {
		parent[field] = append(list, map[string]any(doc))
		return
	}
	// Не лист: path[0] описывает промежуточный документ (предмет актёра),
	// в который нужно спуститься, чтобы положить вложенный в него (эффект).
	for _, item := range list {
		child, ok := item.(map[string]any)
		if ok && asString(child["_id"]) == path[0].id {
			attachEmbedded(child, path[1:], doc)
			return
		}
	}
}

// ---- NeDB (Foundry v10 и раньше) ----

// readNeDB читает построчный JSON. Записи с $$deleted — надгробия NeDB
// (документ удалён, но строка осталась), повторы по _id — история правок,
// побеждает последняя.
func readNeDB(path string) ([]Doc, error) {
	f, err := os.Open(path) //nolint:gosec // G304: путь получен из packPath (safeJoin по корню кэша)
	if err != nil {
		return nil, fmt.Errorf("не удалось открыть пак: %w", err)
	}
	defer f.Close()

	order := make([]string, 0, 256)
	byID := make(map[string]Doc, 256)
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 16<<20) // одна строка = один документ, у крупных существ это мегабайты
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		doc, err := decodeDoc(line)
		if err != nil {
			continue
		}
		id := asString(doc["_id"])
		if id == "" {
			id = fmt.Sprintf("#%d", len(order))
		}
		if deleted, ok := doc["$$deleted"].(bool); ok && deleted {
			delete(byID, id)
			continue
		}
		if _, exists := byID[id]; !exists {
			order = append(order, id)
		}
		byID[id] = doc
		if len(order) >= maxDocsPerPack {
			break
		}
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("ошибка чтения пака: %w", err)
	}

	out := make([]Doc, 0, len(order))
	for _, id := range order {
		if doc, ok := byID[id]; ok {
			out = append(out, doc)
		}
	}
	return out, nil
}

// ---- каталог .json (исходники паков) ----

func readJSONDir(dir string) ([]Doc, error) {
	out := make([]Doc, 0, 64)
	err := filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.EqualFold(filepath.Ext(p), ".json") {
			return nil
		}
		docs, err := readJSONFile(p)
		if err != nil {
			return nil // мусорный файл в каталоге пака — просто пропускаем
		}
		out = append(out, docs...)
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("в каталоге пака нет ни одного документа")
	}
	return out, nil
}

// readJSONFile читает и один документ, и массив документов — оба варианта
// встречаются в исходниках паков.
func readJSONFile(path string) ([]Doc, error) {
	data, err := os.ReadFile(path) //nolint:gosec // G304: путь получен из packPath/WalkDir по корню кэша
	if err != nil {
		return nil, err
	}
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) > 0 && trimmed[0] == '[' {
		dec := json.NewDecoder(bytes.NewReader(trimmed))
		dec.UseNumber()
		var list []Doc
		if err := dec.Decode(&list); err != nil {
			return nil, err
		}
		return list, nil
	}
	doc, err := decodeDoc(trimmed)
	if err != nil {
		return nil, err
	}
	return []Doc{doc}, nil
}

// decodeDoc — общий разбор одного документа. UseNumber, чтобы числа
// доехали до клиента ровно такими, какими лежали в паке (иначе целые
// уровни/дистанции превращаются в 5.000000000000001 и подобное).
func decodeDoc(data []byte) (Doc, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var doc Doc
	if err := dec.Decode(&doc); err != nil {
		return nil, err
	}
	return doc, nil
}
