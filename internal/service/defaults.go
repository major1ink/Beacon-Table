package service

import "beacon-table/internal/schema"

// SchemaOf — схема вида карточек (schema.KindMonster…) мира; nil — схемы
// нет. По ней новая карточка получает значения по умолчанию.
type SchemaOf func(kind string) *schema.Schema

// applyDefaults кладёт в новую карточку card значения по умолчанию схемы
// вида kind.
func applyDefaults(of SchemaOf, kind string, card any) {
	if of == nil {
		return
	}
	if s := of(kind); s != nil {
		_ = s.ApplyDefaults(card)
	}
}
