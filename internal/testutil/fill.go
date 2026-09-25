// Package testutil — помощники тестов, общие для нескольких пакетов.
package testutil

import (
	"fmt"
	"reflect"
	"strings"
	"time"
)

// FixedTime — время, которым Fill заполняет поля time.Time: в UTC и без
// долей секунды, чтобы пережить любую сериализацию (JSON, строка в SQLite).
var FixedTime = time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)

// Fill заполняет КАЖДОЕ экспортируемое поле структуры по указателю v
// детерминированными непустыми значениями: строки — имя поля с номером
// ("imageurl-7"), числа — маленькие (1–3, у дробных +0.5 — чтобы не упереться
// в валидаторы вроде «уровень 0–9» или «спасброски 0–3»), bool — true,
// срезы — два элемента, карты — одна запись, указатели — заполненный объект.
//
// Зачем: страховочные тесты «сохранили → прочитали → всё на месте». Поле,
// добавленное в структуру потом, заполнится само, и тест поймает, если
// хранилище или импорт его теряет, — без правки теста.
func Fill(v any) {
	rv := reflect.ValueOf(v)
	if rv.Kind() != reflect.Pointer || rv.IsNil() {
		panic("testutil.Fill: нужен непустой указатель")
	}
	f := &filler{}
	f.fill(rv.Elem(), "value", 0)
}

type filler struct{ n int }

func (f *filler) next() int {
	f.n++
	return f.n
}

var timeType = reflect.TypeOf(time.Time{})

// maxDepth — защита от рекурсивных типов (структура, ссылающаяся на себя).
const maxDepth = 8

func (f *filler) fill(v reflect.Value, name string, depth int) {
	if depth > maxDepth || !v.CanSet() {
		return
	}
	switch v.Kind() {
	case reflect.String:
		v.SetString(fmt.Sprintf("%s-%d", strings.ToLower(name), f.next()))
	case reflect.Bool:
		v.SetBool(true)
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		v.SetInt(int64(f.next()%3 + 1))
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		v.SetUint([]uint64{1, 2, 3}[f.next()%3])
	case reflect.Float32, reflect.Float64:
		v.SetFloat(float64(f.next()%3) + 1.5)
	case reflect.Struct:
		if v.Type() == timeType {
			v.Set(reflect.ValueOf(FixedTime))
			return
		}
		t := v.Type()
		for i := 0; i < t.NumField(); i++ {
			// json:"-" — не часть данных (domain.Extra и т.п.): заполнять
			// нечем и незачем, в JSON оно не попадает.
			if !t.Field(i).IsExported() || t.Field(i).Tag.Get("json") == "-" {
				continue
			}
			f.fill(v.Field(i), t.Field(i).Name, depth+1)
		}
	case reflect.Slice:
		s := reflect.MakeSlice(v.Type(), 2, 2)
		for i := 0; i < 2; i++ {
			f.fill(s.Index(i), name, depth+1)
		}
		v.Set(s)
	case reflect.Array:
		for i := 0; i < v.Len(); i++ {
			f.fill(v.Index(i), name, depth+1)
		}
	case reflect.Map:
		m := reflect.MakeMap(v.Type())
		k := reflect.New(v.Type().Key()).Elem()
		f.fill(k, name+"-key", depth+1)
		e := reflect.New(v.Type().Elem()).Elem()
		f.fill(e, name, depth+1)
		m.SetMapIndex(k, e)
		v.Set(m)
	case reflect.Pointer:
		p := reflect.New(v.Type().Elem())
		f.fill(p.Elem(), name, depth+1)
		v.Set(p)
	case reflect.Interface:
		if v.NumMethod() == 0 {
			v.Set(reflect.ValueOf(fmt.Sprintf("%s-%d", strings.ToLower(name), f.next())))
		}
	}
}
