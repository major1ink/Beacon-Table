package schema

import (
	"reflect"
	"testing"
)

// typedRoot — корень с типизированными путями: так проверяется, что схема
// сверяет поле с Go-типом, по которому оно хранится (у настоящих листов и
// карточек типизированы только общие поля, а поля систем лежат в Extra).
type typedRoot struct {
	Flag   bool            `json:"flag"`
	Count  int             `json:"count"`
	Text   string          `json:"text"`
	Slots  [9]string       `json:"slots"`
	Skills map[string]int  `json:"skills"`
	Saves  map[string]bool `json:"saves"`
}

func keyedTable(path string, col *Field, keys ...string) *Field {
	rows := make([]Row, len(keys))
	for i, k := range keys {
		rows[i] = Row{Key: k, Label: k}
	}
	col.ID, col.Path, col.Label = "c", "{key}", "Колонка"
	return &Field{Type: TypeTable, Path: path, Label: "Таблица", Rows: rows, Columns: []*Field{col}}
}

func TestFieldsAreCheckedAgainstGoTypes(t *testing.T) {
	root := reflect.TypeOf(typedRoot{})
	good := map[string]*Field{
		"владение из трёх состояний в числе": keyedTable("skills", &Field{Type: TypeProf, Levels: 3}, "a"),
		"владение-флажок в bool":             keyedTable("saves", &Field{Type: TypeProf, Levels: 2}, "a"),
		"шкала в числе":                      {Type: TypeTally, Path: "count", Label: "Шкала", Max: 3},
		"счётчик в строке":                   {Type: TypePool, Path: "text", Label: "Счётчик"},
		"ячейки по номерам массива":          keyedTable("slots", &Field{Type: TypePool}, "0", "8"),
	}
	for name, f := range good {
		if err := checkField(root, f, false); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
	bad := map[string]*Field{
		"флажок в числе":       keyedTable("skills", &Field{Type: TypeProf, Levels: 2}, "a"),
		"тройка в флажке":      keyedTable("saves", &Field{Type: TypeProf, Levels: 3}, "a"),
		"шкала не в число":     {Type: TypeTally, Path: "text", Label: "Шкала", Max: 3},
		"счётчик не в строку":  {Type: TypePool, Path: "count", Label: "Счётчик"},
		"ключ строки не номер": keyedTable("slots", &Field{Type: TypePool}, "x"),
		"строки на строку":     keyedTable("text", &Field{Type: TypePool}, "a"),
		"путь в никуда":        {Type: TypeNumber, Path: "count.value", Label: "Число"},
	}
	for name, f := range bad {
		if err := checkField(root, f, false); err == nil {
			t.Errorf("%s: ожидали ошибку", name)
		}
	}
}
