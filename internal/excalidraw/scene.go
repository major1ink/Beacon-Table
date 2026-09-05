package excalidraw

import (
	"encoding/json"
	"fmt"
)

// scene.go — модель сцены Excalidraw. Максимально близко к оригиналу: имена
// и значения полей ровно те же, что в файле, чтобы импорт и экспорт не
// требовали перевода туда-обратно.
//
// ГЛАВНОЕ ПРАВИЛО — НИЧЕГО НЕ ТЕРЯТЬ. Разбираем в свои структуры (один в один
// брать их модель нельзя: половина полей — состояние их редактора, которое
// наш всё равно не поддержит корректно), но всё, чего мы не знаем, кладём в
// Extra и отдаём обратно нетронутым. Без этого round-trip был бы с потерей
// данных не в теории: добавил в ваулте фрейм или привязанную стрелку,
// кто-то за столом подвинул соседний прямоугольник — и добавленное молча
// исчезло при следующей записи файла.
//
// По той же причине структурные поля, смысл которых нам сейчас не нужен
// (roundness, boundElements, привязки стрелок, customData плагина), лежат
// сырым JSON: сохранить их точно мы обязаны, а делать вид, что понимаем, —
// нет.

// Scene — корень файла: то, что лежит внутри блока ```json/```compressed-json.
type Scene struct {
	Type     string     `json:"type"`
	Version  int        `json:"version"`
	Source   string     `json:"source,omitempty"`
	Elements []*Element `json:"elements"`
	// AppState — настройки вида (тема, фон, зум, сетка). Нам из них нужно
	// разве что viewBackgroundColor, но выбрасывать остальное нельзя: это
	// то, каким автор оставил свою доску.
	AppState json.RawMessage `json:"appState,omitempty"`
	// Files — картинки, вшитые прямо в файл (data-URL). В ваулте, который
	// удалось посмотреть, всегда пусто: плагин держит картинки отдельными
	// файлами и связывает их через раздел "## Embedded Files". Но формат
	// это поле допускает, и терять его нельзя.
	Files json.RawMessage `json:"files,omitempty"`
}

// ElementType — известные нам типы элементов. Список открытый: элемент
// неизвестного типа разбирается как обычно и сохраняется целиком, просто
// наш редактор не будет уметь его нарисовать.
const (
	TypeRectangle  = "rectangle"
	TypeEllipse    = "ellipse"
	TypeDiamond    = "diamond"
	TypeLine       = "line"
	TypeArrow      = "arrow"
	TypeFreedraw   = "freedraw"
	TypeText       = "text"
	TypeImage      = "image"
	TypeFrame      = "frame"
	TypeEmbeddable = "embeddable"
)

// Element — элемент холста. Поля именованы как в формате, порядок — как в
// файлах плагина (общие, потом специфичные для типа).
type Element struct {
	ID     string  `json:"id"`
	Type   string  `json:"type"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
	Angle  float64 `json:"angle"`

	StrokeColor     string  `json:"strokeColor"`
	BackgroundColor string  `json:"backgroundColor"`
	FillStyle       string  `json:"fillStyle"`
	StrokeWidth     float64 `json:"strokeWidth"`
	StrokeStyle     string  `json:"strokeStyle"`
	Roughness       float64 `json:"roughness"`
	Opacity         float64 `json:"opacity"`

	// Roundness — {"type":2|3} либо null. Сырым: нам хватает «скруглено или
	// нет», а их числа — индексы во внутренней таблице радиусов.
	Roundness json.RawMessage `json:"roundness"`

	// Seed/Version/VersionNonce/Updated — служебное состояние их редактора
	// (детерминированность «рукописного» рендера и разрешение конфликтов
	// при совместной правке). Своего смысла у нас не имеют, но сохраняются:
	// без seed рисунок перерисуется другими случайными неровностями, и файл
	// зря окажется «изменившимся».
	Seed         int64 `json:"seed"`
	Version      int64 `json:"version"`
	VersionNonce int64 `json:"versionNonce"`
	Updated      int64 `json:"updated"`

	IsDeleted bool     `json:"isDeleted"`
	GroupIDs  []string `json:"groupIds"`
	// BoundElements — что к элементу привязано (подпись внутри фигуры,
	// стрелки). Сырым: связность мы пока не поддерживаем, а рвать её нельзя.
	BoundElements json.RawMessage `json:"boundElements"`
	Link          *string         `json:"link"`
	Locked        bool            `json:"locked"`
	// Index — дробный индекс порядка отрисовки («aU», «b1n»): у Excalidraw
	// это строка, а не число, чтобы вставлять между соседями без
	// перенумерации.
	Index   string  `json:"index,omitempty"`
	FrameID *string `json:"frameId"`

	// ---- text ----
	Text          string  `json:"text,omitempty"`
	RawText       string  `json:"rawText,omitempty"`
	OriginalText  string  `json:"originalText,omitempty"`
	FontSize      float64 `json:"fontSize,omitempty"`
	FontFamily    int     `json:"fontFamily,omitempty"`
	TextAlign     string  `json:"textAlign,omitempty"`
	VerticalAlign string  `json:"verticalAlign,omitempty"`
	ContainerID   *string `json:"containerId,omitempty"`
	AutoResize    *bool   `json:"autoResize,omitempty"`
	LineHeight    float64 `json:"lineHeight,omitempty"`

	// ---- line/arrow/freedraw ----
	// Points — точки ломаной ОТНОСИТЕЛЬНО X/Y элемента, парами [x,y].
	Points             [][]float64     `json:"points,omitempty"`
	LastCommittedPoint json.RawMessage `json:"lastCommittedPoint,omitempty"`
	StartBinding       json.RawMessage `json:"startBinding,omitempty"`
	EndBinding         json.RawMessage `json:"endBinding,omitempty"`
	StartArrowhead     *string         `json:"startArrowhead,omitempty"`
	EndArrowhead       *string         `json:"endArrowhead,omitempty"`
	Elbowed            *bool           `json:"elbowed,omitempty"`

	// ---- image ----
	// FileID — ключ в Scene.Files либо в разделе "## Embedded Files"
	// markdown-конверта (см. Document.EmbeddedFiles).
	FileID string          `json:"fileId,omitempty"`
	Status string          `json:"status,omitempty"`
	Scale  []float64       `json:"scale,omitempty"`
	Crop   json.RawMessage `json:"crop,omitempty"`

	// ---- frame ----
	Name string `json:"name,omitempty"`

	// CustomData — то, что дописывает плагин Obsidian (цвета фрейма,
	// свойства встроенной заметки). Сырым и целиком.
	CustomData json.RawMessage `json:"customData,omitempty"`

	// Extra — всё остальное, чего мы не знаем. Пустая карта — норма; всё,
	// что сюда попало, вернётся в файл как было.
	Extra map[string]json.RawMessage `json:"-"`
}

// knownElementFields — поля, которые разбираются в структуру выше. Ровно они
// вычитаются из общего набора ключей, а остаток уезжает в Extra.
var knownElementFields = []string{
	"id", "type", "x", "y", "width", "height", "angle",
	"strokeColor", "backgroundColor", "fillStyle", "strokeWidth", "strokeStyle", "roughness", "opacity",
	"roundness", "seed", "version", "versionNonce", "updated", "isDeleted", "groupIds",
	"boundElements", "link", "locked", "index", "frameId",
	"text", "rawText", "originalText", "fontSize", "fontFamily", "textAlign", "verticalAlign",
	"containerId", "autoResize", "lineHeight",
	"points", "lastCommittedPoint", "startBinding", "endBinding", "startArrowhead", "endArrowhead", "elbowed",
	"fileId", "status", "scale", "crop", "name", "customData",
}

// elementAlias — тот же Element, но без наших методов: без него
// json.Marshal/Unmarshal внутри них ушли бы в бесконечную рекурсию.
type elementAlias Element

func (e *Element) UnmarshalJSON(b []byte) error {
	var a elementAlias
	if err := json.Unmarshal(b, &a); err != nil {
		return err
	}
	*e = Element(a)
	var all map[string]json.RawMessage
	if err := json.Unmarshal(b, &all); err != nil {
		return err
	}
	for _, k := range knownElementFields {
		delete(all, k)
	}
	if len(all) > 0 {
		e.Extra = all
	}
	return nil
}

func (e Element) MarshalJSON() ([]byte, error) {
	b, err := json.Marshal(elementAlias(e))
	if err != nil {
		return nil, err
	}
	if len(e.Extra) == 0 {
		return b, nil
	}
	// Досыпаем неизвестные поля обратно. Через карту, а не склейкой строк:
	// порядок ключей в JSON всё равно не значим, а склейка ломается на
	// пустом объекте и на любом неожиданном пробеле.
	var merged map[string]json.RawMessage
	if err := json.Unmarshal(b, &merged); err != nil {
		return nil, err
	}
	for k, v := range e.Extra {
		if _, taken := merged[k]; taken {
			// Своё поле важнее: иначе Extra, набитая мусором с одноимённым
			// ключом, перезаписала бы разобранное значение.
			continue
		}
		merged[k] = v
	}
	return json.Marshal(merged)
}

// NewDocument — пустая доска: валидная сцена Excalidraw без элементов. Так
// даже только что заведённая доска сразу открывается плагином в ваулте, а не
// после первого рисунка.
func NewDocument() *Document {
	return &Document{Scene: &Scene{
		Type:     "excalidraw",
		Version:  2,
		Source:   "https://github.com/major1ink/Beacon-Table",
		Elements: []*Element{},
	}}
}

// Validate — минимальная проверка того, что перед нами сцена Excalidraw, а не
// произвольный JSON. Строгой валидации элементов тут нет намеренно: файл мог
// прийти из версии плагина новее нашей, и отказываться его открывать из-за
// незнакомого поля — ровно та потеря данных, которой мы избегаем.
func (s *Scene) Validate() error {
	if s == nil {
		return fmt.Errorf("пустая сцена")
	}
	if s.Type != "excalidraw" {
		return fmt.Errorf("это не файл Excalidraw (type = %q)", s.Type)
	}
	return nil
}

// TextElements — подписи сцены в порядке следования. Нужны конверту: в
// markdown они дублируются отдельным разделом, чтобы Obsidian их
// индексировал и находил поиском (см. Document).
func (s *Scene) TextElements() []*Element {
	out := make([]*Element, 0, len(s.Elements))
	for _, e := range s.Elements {
		if e != nil && e.Type == TypeText && !e.IsDeleted {
			out = append(out, e)
		}
	}
	return out
}

// CarryOverPluginFields переносит в новую сцену поля плагина Obsidian,
// которые редактор Excalidraw выбрасывает при загрузке.
//
// Пока такое поле одно — rawText: исходный markdown подписи с [[ссылками]].
// Переносится только у подписей с неизменившимся originalText — у правленых
// старый markdown уже не к месту.
func CarryOverPluginFields(old, next *Scene) {
	if old == nil || next == nil {
		return
	}
	prev := make(map[string]*Element, len(old.Elements))
	for _, e := range old.Elements {
		if e != nil && e.RawText != "" {
			prev[e.ID] = e
		}
	}
	if len(prev) == 0 {
		return
	}
	for _, e := range next.Elements {
		if e == nil || e.RawText != "" {
			continue
		}
		was, ok := prev[e.ID]
		if !ok || was.OriginalText != e.OriginalText {
			continue
		}
		e.RawText = was.RawText
	}
}
