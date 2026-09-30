package service

import (
	"testing"

	"beacon-table/internal/domain"
	"beacon-table/internal/schema"
)

func TestApplyDefaultsBySchemaOf(t *testing.T) {
	s, err := schema.Parse([]byte(`{"format":"beacon-schema/v1","kind":"monster","fields":{
		"ac":{"type":"number","path":"ac","label":"КД","default":10}
	},"layout":[{"fields":["ac"]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	of := func(kind string) *schema.Schema {
		if kind == schema.KindMonster {
			return s
		}
		return nil
	}
	m := domain.NewMonster("id", "Гоблин")
	applyDefaults(of, schema.KindMonster, m)
	if m.AC != 10 {
		t.Fatalf("КД по умолчанию: %d", m.AC)
	}
	blank := domain.NewMonster("id2", "Тень")
	applyDefaults(of, schema.KindSpell, blank)
	applyDefaults(nil, schema.KindMonster, blank)
	if blank.AC != 0 {
		t.Fatalf("без схемы карточка пустая: %d", blank.AC)
	}
}
