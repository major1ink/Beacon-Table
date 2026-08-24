package domain

// Token — фигурка на карте. Image — необязательная ссылка на загруженную
// картинку; если пусто — рисуем цветной кружок с подписью. Hidden — токен
// существует в состоянии, но НЕ уходит игрокам, пока DM не снимет флаг
// (двойной клик на DM-экране = "reveal_token"). Так делают засаду/NPC из
// тумана и т.п.
type Token struct {
	ID          string  `json:"id"`
	X           float64 `json:"x"`
	Y           float64 `json:"y"`
	Color       string  `json:"color"`
	Label       string  `json:"label"`
	Size        float64 `json:"size"`
	Image       string  `json:"image,omitempty"`
	Shape       string  `json:"shape,omitempty"` // "" (трактуем как "circle") | "square"
	Hidden      bool    `json:"hidden,omitempty"`
	OwnerID     string  `json:"ownerId,omitempty"`     // accountID удалённого игрока-владельца; пусто = NPC/токен ДМ
	CharacterID string  `json:"characterId,omitempty"` // необязательная ссылка на Character
	// MonsterID — необязательная ссылка на карточку бестиария (domain.Monster),
	// см. internal/repository/monsterfile. В отличие от CharacterID не
	// дедуплицируется (dropDuplicateCharacterTokens в service/room.go его не
	// трогает) — несколько токенов одного монстра на сцене нормальны (стая).
	// Ставится один раз при создании токена драгом карточки из бестиария
	// (web/src/pages/dm.js) и открывает статблок через ПКМ-меню токена
	// (#tokenMenuBestiaryBtn), как CharacterID открывает лист персонажа.
	MonsterID string      `json:"monsterId,omitempty"`
	Light     *TokenLight `json:"light,omitempty"` // необязательный источник света — см. TokenLight
	// LightOnly — "токен света": не персонаж/арт, а голый маркер-лампочка,
	// который DM ставит только ради Light. НЕ использует Hidden (тот целиком
	// вырезает токен из PublicScene — см. service.Room.sceneFor — тогда
	// клиент игрока вообще не узнает о токене и не сможет посчитать от него
	// освещение). Вместо этого lightOnly-токен уходит игрокам как обычно
	// (Hidden==false), просто web/src/vtt/layers/tokens.js не рисует его на
	// НЕ-DM экране — видна только сама заливка света от vision-fog.js, не
	// маркер. У ДМ вместо цветного кружка/арта — полупрозрачная иконка
	// лампочки (см. tokens.js), без Owner/Shape (см. web/dm.html #tokenMenu).
	LightOnly bool `json:"lightOnly,omitempty"`
	// Dead — связанный боец в трекере инициативы умер: у монстра/безликого
	// NPC (нет CharacterID, см. domain.Combatant) — как только HP дошло до
	// нуля (спасбросков от смерти у них не бывает), у игрового персонажа —
	// после 3-го провала спасброска от смерти. Проставляется автоматически
	// сервером (service.Room.markTokenDead, вызывается из
	// killMonsterCombatant и handleSetCombatantDeathSave). web/src/vtt/
	// layers/tokens.js рисует вместо арта/кружка значок костей. Токен при
	// этом с карты не убирается и остаётся двигаемым — это ДМ-решение, что
	// делать с трупом дальше (см. требование "заменить токен на отображение
	// костей"). Снимается обратно, когда HP бойца на этом же токене снова
	// становится положительным (service.Room.reviveTokenIfDead) — например,
	// ДМ заново добавил того же монстра/NPC в инициативу по его токену и
	// подлечил.
	Dead bool `json:"dead,omitempty"`
	// Loot — снимок Monster.Inventory (см. monster.go), сделанный в момент,
	// когда этот токен умер (см. service.Room.killMonsterCombatant) — с
	// собственными ID записей, независимыми от шаблона монстра и от других
	// токенов. Уменьшается по мере того, как игроки разбирают добычу (см.
	// "loot_take_item" в domain.ClientMsg) — пустой/nil, если у монстра не
	// было инвентаря или всё уже забрали. Доступность самого действия лута
	// (не только наличие тут записей) регулируется общим тумблером стола
	// CombatState.LootingEnabled — см. там же.
	Loot []InventoryEntry `json:"loot,omitempty"`
	// Statuses — наложенные состояния этого конкретного токена (ослепление,
	// испуг, истощение — см. AppliedStatus и domain.Condition). Живут именно
	// на токене, а не на карточке монстра/персонажа: стая из пяти гоблинов
	// — пять независимых наборов меток, как и пять независимых Loot выше.
	// Токен — ИСТОЧНИК ИСТИНЫ для своего инстанса: у бойца инициативы,
	// связанного с этим токеном (Combatant.TokenID), собственных меток нет,
	// трекер читает и правит эти (см. service.Room.statusesOf) — тем же
	// принципом сквозной связи токен↔боец, что уже работает у Token.Dead.
	Statuses []AppliedStatus `json:"statuses,omitempty"`
}

// AppliedStatus — ОДНА наложенная метка состояния на токене (Token.Statuses)
// или на бойце инициативы без токена (Combatant.Statuses). Аналог документа
// ActiveEffect в Foundry, но без движка changes (почему — см. большой
// комментарий в domain/condition.go).
//
// Slug — ссылка на карточку справочника (Condition.Slug), а Name/Icon/Color —
// СНИМОК её полей на момент наложения: тот же приём, что у MonsterSpellRef,
// InventoryEntry и NoteMarker.Label — удаление или правка карточки не
// оставляет висящую на токене метку безымянной. Снимок делает сервер, не
// клиент (см. service.Room.handleApplyStatus) — цифры и подписи от
// недоверенного клиента мы не берём, как и у "hub_add_item"/"add_combatant".
type AppliedStatus struct {
	Slug string `json:"slug"`
	Name string `json:"name"`
	// Icon — глиф-эмодзи (см. Condition.Icon), ImageURL — свой арт вместо
	// него, если он у карточки задан. Клиент рисует картинку, когда она
	// есть, и глиф в остальных случаях (в том числе если картинка не
	// загрузилась) — поэтому снимок несёт оба поля, а не одно из них.
	Icon     string `json:"icon,omitempty"`
	ImageURL string `json:"imageUrl,omitempty"`
	Color    string `json:"color,omitempty"`
	// Overlay — снимок Condition.Overlay: рисовать во весь токен, а не
	// значком по кромке (см. web/src/vtt/layers/tokens.js).
	Overlay bool `json:"overlay,omitempty"`
	// Level — текущий уровень многоуровневого состояния (истощение 1-6), 0 у
	// обычного тумблера. Потолок — Condition.Levels, его проверяет сервер.
	Level int `json:"level,omitempty"`
	// Rounds — сколько раундов метке ещё висеть, 0 — бессрочно (пока ДМ не
	// снимет). Тикает ТОЛЬКО в активном бою и только в начале хода того, на
	// ком метка висит (см. service.Room.tickStatuses) — это семантика 5e
	// «до конца твоего следующего хода», а не foundry-шный счётчик от раунда
	// наложения.
	Rounds int `json:"rounds,omitempty"`
	// Source — откуда прилетело («Заклинание «Удержание личности»»), аналог
	// ActiveEffect.origin в Foundry, но простой подписью, а не ссылкой на
	// документ: она нужна ДМ глазами, а не коду.
	Source string `json:"source,omitempty"`
	// Hidden — метку видит только ДМ. Как и Token.Hidden, это НЕ клиентское
	// сокрытие стилями: сервер физически вырезает такие метки из payload
	// не-ДМ клиентам (см. service.Room.sceneFor/combatPayload).
	Hidden bool `json:"hidden,omitempty"`
	// Modifiers — СНИМОК Condition.Modifiers на момент наложения (см.
	// domain.Modifier), тем же приёмом, что имя и иконка выше. Снимок, а не
	// ссылка, здесь особенно важен: правка карточки состояния посреди боя не
	// должна задним числом менять цифры на уже висящих метках — иначе ДМ,
	// поправивший «горит» с 1к6 на 2к6, незаметно для себя переписал бы
	// урон, который уже идёт по всем горящим на карте. Освежается при
	// повторном наложении того же состояния (см. service.Room.putStatus).
	Modifiers []Modifier `json:"modifiers,omitempty"`
}

// TokenLight — настройки источника света у токена (факел/фонарь/костёр — тот
// же Token, что и обычный PC/NPC, просто с этим полем). Bright/Dim — радиусы
// В ЕДИНИЦАХ ЛИНЕЙКИ СЦЕНЫ (GridSettings.Unit/UnitsPerCell, по умолчанию
// "фт"/5) — ТЕ ЖЕ единицы, что вводит DM в диалоге настройки сетки, а не
// мировые (пиксельные) координаты Wall/Token.X/Y. Значение 15 при
// UnitsPerCell=5 значит радиус в 3 клетки сетки вокруг токена. Перевод в
// мировые единицы для рейкастинга/отрисовки — на клиенте, см.
// web/src/vtt/light-geometry.js:gridUnitsToWorld (единственное место счёта).
// Из-за этого поля НЕ масштабируются в RescaleGeometry при смене размера
// холста — они уже resolution-independent, как и сам UnitsPerCell.
// Dim задаёт дальнюю границу (тусклый свет), Bright — ближнюю, более яркую;
// Bright <= Dim по смыслу (кто выставляет — тот и следит, сервер не
// валидирует). Enabled — отдельный от радиусов флаг: DM может держать
// настроенные радиусы, но временно погасить источник (потушенный факел),
// не обнуляя поля.
type TokenLight struct {
	Enabled bool    `json:"enabled"`
	Bright  float64 `json:"bright,omitempty"`
	Dim     float64 `json:"dim,omitempty"`
}

// Wall — отрезок, блокирующий обзор. Не секрет — уходит всем клиентам
// одинаково (это геометрия карты, а не скрытая информация), в отличие от
// Token.Hidden/NoteMarker. Видимость (line-of-sight) считается на клиенте.
//
// Door/DoorState/Window — дверь и окно в стене (как в Foundry): Door — ""
// (глухая стена) | "door" (обычная дверь) | "secret" (секретная — клиент
// прячет её значок и хит-тест от роли player, см. web/src/vtt/layers/doors.js
// и geometry.js:doorAt; сам Wall при этом летит в PublicScene как обычно —
// см. коммент выше про "не секрет", секретность тут чисто клиентского
// рендера ради простоты). DoorState — "closed"/"open"/"locked", осмысленно
// только когда Door != "" (сервер сам проставляет "closed" по умолчанию при
// первом выставлении Door, см. service.Room.applyMutation:"set_wall_door").
// Window — сегмент НИКОГДА не блокирует обзор (см.
// web/src/geometry.js:wallBlocksSight), во всём остальном обычная стена.
// Door и Window взаимоисключающие — сервер сам сбрасывает одно при
// выставлении другого (см. room.go: "set_wall_door"/"set_wall_window").
type Wall struct {
	ID        string  `json:"id"`
	X1        float64 `json:"x1"`
	Y1        float64 `json:"y1"`
	X2        float64 `json:"x2"`
	Y2        float64 `json:"y2"`
	Door      string  `json:"door,omitempty"`
	DoorState string  `json:"doorState,omitempty"`
	Window    bool    `json:"window,omitempty"`
}

// Point — вершина многоугольника FogArea.
type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// FogArea — область ручного тумана произвольной формы. Постоянный оверрайд
// DM: скрывает область у игроков ДАЖЕ если туда дотягивается обзор токена.
type FogArea struct {
	ID     string  `json:"id"`
	Points []Point `json:"points"`
}

// Building — здание: ЗАМКНУТЫЙ многоугольник (Points, как у FogArea — контур
// подразумевается замкнутым от последней точки к первой, без дублирования
// первой точки в конце). В отличие от Wall (независимые отрезки, не обязаны
// образовывать контур — годятся для частичных укрытий), Building — цельная
// область с обязательной замкнутостью, которую проверяет клиент ДО отправки
// (см. web/src/vtt/interaction.js: цепочка вершин коммитится на сервер ОДНИМ
// сообщением только в момент явного замыкания на стартовую точку — открытая
// цепочка на сервер вообще не попадает) и переподтверждает сервер (см.
// service.Room.applyMutation: "add_building" отбрасывает < 3 точек).
//
// Семантика скрытия — НЕ line-of-sight (Building не участвует в
// raycasting/computeVisibilityPolygon, в отличие от Wall): это независимая
// от освещения непрозрачная "крыша" ровно над своим контуром (см.
// web/src/vtt/layers/buildings.js) — скрывает у игроков только то, что
// находится ВНУТРИ (point-in-polygon), и снимается целиком, как только
// внутри контура оказывается хотя бы один видимый токен.
type Building struct {
	ID     string  `json:"id"`
	Points []Point `json:"points"`
}

// GridSettings — сетка клеток поверх карты. Size — сторона клетки в мировых
// единицах, Size<=0 значит "сетка выключена" (snap не работает). Visible —
// отдельный от Size флаг "рисовать ли сетку на экране". Указатель — чтобы
// отличить "поле отсутствует в старом файле" (nil → трактуем как true) от
// осознанного "DM снял галочку".
type GridSettings struct {
	Size         float64 `json:"size"`
	OffsetX      float64 `json:"offsetX"`
	OffsetY      float64 `json:"offsetY"`
	Visible      *bool   `json:"visible,omitempty"`
	UnitsPerCell float64 `json:"unitsPerCell,omitempty"`
	Unit         string  `json:"unit,omitempty"`
	LineColor    string  `json:"lineColor,omitempty"`
	LineOpacity  float64 `json:"lineOpacity,omitempty"`
}

// NoteMarker — значок-свиток на карте, ссылающийся на заметку ДМ (см.
// Note/NoteRepository). В отличие от старого HiddenAsset, это не игровой
// reveal-механизм — маркер целиком личный инструмент ДМ и никогда не уходит
// игрокам/TV (см. service.Room.sceneFor: PublicScene.NoteMarkers заполняется
// только для роли DM, для остальных — всегда пустая карта). Label — снимок
// заголовка заметки на момент постановки значка: правка заголовка заметки
// НЕ обновляет уже стоящие на карте подписи (см. web/src/notes/markdown.js) —
// сознательный компромисс, см. план. Size — размер значка в мировых px,
// правится ДМ через ПКМ → "Изменить размер" → драг (см.
// web/src/vtt/interaction.js); 0/отсутствует — клиент подставляет свой
// дефолт (см. layers/note-markers.js), сервер размер не валидирует, как и
// Token.Size.
type NoteMarker struct {
	ID      string  `json:"id"`
	NoteID  string  `json:"noteId"`
	Library string  `json:"library,omitempty"`
	Label   string  `json:"label"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	Size    float64 `json:"size,omitempty"`
}

// SceneState — состояние ОДНОЙ сцены: имя, фон, размер холста, туман войны,
// сетка и все объекты на ней. Сцена — самостоятельная именованная сущность
// со своим ID, НЕ привязанная к URL фона.
type SceneState struct {
	ID            string       `json:"id"`
	Name          string       `json:"name"`
	MapURL        string       `json:"mapUrl"`
	Width         float64      `json:"width"`
	Height        float64      `json:"height"`
	FogOfWar      *bool        `json:"fogOfWar,omitempty"` // nil (старые сцены) трактуем как true
	Grid          GridSettings `json:"grid"`
	AmbientURL    string       `json:"ambientUrl,omitempty"`
	AmbientVolume float64      `json:"ambientVolume,omitempty"`
	// GlobalLight — освещение на ВСЮ карту (кнопки тулбара ДМ), независимо от
	// расставленных источников света на токенах: "" — выключено (карта
	// освещена только тем, что расставил DM — см. Token.Light), "dim" —
	// вся карта минимум тускло освещена, "bright" — вся карта ярко освещена
	// (эквивалент выключенного тумана войны по свету, но не по обзору
	// токена — см. web/src/vtt/layers/vision-fog.js).
	GlobalLight string                 `json:"globalLight,omitempty"`
	Tokens      map[string]*Token      `json:"tokens"`
	NoteMarkers map[string]*NoteMarker `json:"noteMarkers"`
	Walls       map[string]*Wall       `json:"walls"`
	FogAreas    map[string]*FogArea    `json:"fogAreas"`
	Buildings   map[string]*Building   `json:"buildings"`
}

// NewScene создаёт пустую сцену с разумными дефолтами "из коробки".
func NewScene(id, name string) *SceneState {
	visible := true
	fogOfWar := true
	return &SceneState{
		ID:            id,
		Name:          name,
		Width:         1280,
		Height:        720,
		FogOfWar:      &fogOfWar,
		AmbientVolume: 0.6,
		Grid: GridSettings{
			Size:         48,
			Visible:      &visible,
			UnitsPerCell: 5,
			Unit:         "ft",
			LineColor:    "#000000",
			LineOpacity:  0.5,
		},
		Tokens:      make(map[string]*Token),
		NoteMarkers: make(map[string]*NoteMarker),
		Walls:       make(map[string]*Wall),
		FogAreas:    make(map[string]*FogArea),
		Buildings:   make(map[string]*Building),
	}
}

// RescaleGeometry пересчитывает координаты всех объектов сцены
// пропорционально изменению размера холста — чтобы токены/стены/туман не
// оказались в неожиданном месте или за пределами холста при смене
// ширины/высоты сцены. Чистая функция домена: не трогает ничего, кроме s.
func (s *SceneState) RescaleGeometry(oldW, oldH float64) {
	scaleX := s.Width / oldW
	scaleY := s.Height / oldH
	for _, t := range s.Tokens {
		t.X *= scaleX
		t.Y *= scaleY
	}
	for _, nm := range s.NoteMarkers {
		nm.X *= scaleX
		nm.Y *= scaleY
	}
	for _, w := range s.Walls {
		w.X1 *= scaleX
		w.Y1 *= scaleY
		w.X2 *= scaleX
		w.Y2 *= scaleY
	}
	for _, f := range s.FogAreas {
		for i := range f.Points {
			f.Points[i].X *= scaleX
			f.Points[i].Y *= scaleY
		}
	}
	for _, b := range s.Buildings {
		for i := range b.Points {
			b.Points[i].X *= scaleX
			b.Points[i].Y *= scaleY
		}
	}
	// Token.Light.Bright/Dim НЕ масштабируем: они хранятся в единицах линейки
	// сцены (см. TokenLight), не в пикселях, — как и Grid.UnitsPerCell чуть
	// ниже, они resolution-independent сами по себе. Пиксельный радиус для
	// рейкастинга каждый раз пересчитывается на клиенте из Grid.Size,
	// который масштабируется ниже как обычно.
	s.Grid.Size *= scaleX
	s.Grid.OffsetX *= scaleX
	s.Grid.OffsetY *= scaleY
}

// PublicScene — то, что реально уходит клиенту по сети. Для DM это зеркало
// SceneState. Для зрителя — та же сцена, но hidden-токены физически вырезаны
// из payload, а NoteMarkers всегда пуст (см. service.Room.sceneFor) — не
// просто скрыты на клиенте стилями.
type PublicScene struct {
	ID            string                 `json:"id"`
	Name          string                 `json:"name"`
	MapURL        string                 `json:"mapUrl"`
	Width         float64                `json:"width"`
	Height        float64                `json:"height"`
	FogOfWar      *bool                  `json:"fogOfWar,omitempty"`
	Grid          GridSettings           `json:"grid"`
	AmbientURL    string                 `json:"ambientUrl,omitempty"`
	AmbientVolume float64                `json:"ambientVolume,omitempty"`
	GlobalLight   string                 `json:"globalLight,omitempty"`
	Tokens        map[string]*Token      `json:"tokens"`
	NoteMarkers   map[string]*NoteMarker `json:"noteMarkers"`
	Walls         map[string]*Wall       `json:"walls"`
	FogAreas      map[string]*FogArea    `json:"fogAreas"`
	Buildings     map[string]*Building   `json:"buildings"`
}

// SceneListEntry — одна строка в переключателе сцен DM. ViewerCount
// ненулевой только у активной сцены — комната показывает всем не-DM
// клиентам ровно одну сцену одновременно.
type SceneListEntry struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	ViewerCount int    `json:"viewerCount"`
}

// RoomSnapshot — то, что repository.SceneRepository.Load отдаёт сервисному
// слою при старте: все сцены комнаты плюс какая из них активна и в каком
// порядке они идут в переключателе DM, плюс трекер инициативы (см.
// CombatState — не привязан к конкретной сцене, персистится отдельным
// файлом, см. internal/repository/scenefile) и хаб лута ДМ (см. LootHub —
// та же логика, отдельный файл, не привязан к сцене/бою).
type RoomSnapshot struct {
	CurrentSceneID string
	SceneOrder     []string
	Scenes         map[string]*SceneState
	Combat         *CombatState
	Hub            *LootHub
}

// LootHub — общий стол ДМ: сюда ДМ скидывает добычу (см. "hub_add_item" в
// domain.ClientMsg), отсюда её сами разбирают игроки ("hub_take_item"). Не
// привязан к конкретной сцене или бою, живёт всё время стола, как
// CombatState — персистится своим файлом (см. internal/repository/scenefile:
// SaveHub). Entries — map, а не срез: правки по ключу (взять/удалить одну
// запись) намного чаще перебора всех сразу, тот же приём, что и у
// CombatState.Combatants (порядок для клиента при рассылке не важен —
// в отличие от инициативы, тут сортировать нечего).
type LootHub struct {
	Entries map[string]*InventoryEntry `json:"entries"`
}

// NewLootHub — пустой хаб "из коробки" (первый запуск/нет сохранённого
// hub.json), см. NewCombatState.
func NewLootHub() *LootHub {
	return &LootHub{Entries: make(map[string]*InventoryEntry)}
}
