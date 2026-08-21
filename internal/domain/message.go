package domain

// ClientMsg — универсальный конверт команд от DM/игрока по WebSocket. Поля,
// не нужные конкретной команде, остаются zero-value и просто игнорируются.
type ClientMsg struct {
	Type       string        `json:"type"`
	Token      *Token        `json:"token,omitempty"`
	ID         string        `json:"id,omitempty"`
	NoteMarker *NoteMarker   `json:"noteMarker,omitempty"`
	Wall       *Wall         `json:"wall,omitempty"`
	Wall2      *Wall         `json:"wall2,omitempty"` // вторая половина при "split_wall" (см. Wall)
	FogArea    *FogArea      `json:"fogArea,omitempty"`
	Building   *Building     `json:"building,omitempty"` // "add_building" — контур целиком, ОДНОЙ мутацией (см. Building)
	Grid       *GridSettings `json:"grid,omitempty"`

	// поля редактирования точек стен (см. web/src/vtt/interaction.js) —
	// "точка" не отдельная сущность с ID, а координата, к которой привязан
	// конец одной или нескольких стен (общий угол комнаты); клиент сам
	// группирует их по факту совпадения координат (geometry.js:wallVertices)
	// и шлёт списком, чтобы сдвиг/удаление угла применялись ко всем стенам
	// разом, одной мутацией.
	WallPoints []WallPointRef `json:"wallPoints,omitempty"` // "move_wall_point"
	WallIDs    []string       `json:"wallIds,omitempty"`    // "remove_wall_point"

	// поля дверей/окон (см. domain.Wall) — ID (уже объявлен выше) указывает
	// целевую стену, тем же приёмом, что и "remove_wall".
	//
	// Door — только для "set_wall_door": "" | "door" | "secret" (см.
	// service.Room.applyMutation — невалидные значения молча игнорируются).
	Door string `json:"door,omitempty"`
	// Window — только для "set_wall_window".
	Window *bool `json:"window,omitempty"`
	// Locked — только для "set_door_lock": true — запереть (подразумевает
	// закрыть), false — отпереть (возвращает в "closed").
	Locked *bool `json:"locked,omitempty"`

	// "split_wall" — вставка новой точки посреди существующей стены: ID —
	// удаляемая исходная стена, Wall/Wall2 — две новые, на которые она
	// делится в точке вставки (см. web/src/vtt/interaction.js:splitWallAt).

	// поля команд управления сценами (create_scene/rename_scene/delete_scene/
	// switch_scene/update_scene)
	SceneID       string  `json:"sceneId,omitempty"`
	SceneName     string  `json:"sceneName,omitempty"`
	MapURL        string  `json:"mapUrl,omitempty"`
	Width         float64 `json:"width,omitempty"`
	Height        float64 `json:"height,omitempty"`
	FogOfWar      bool    `json:"fogOfWar,omitempty"`
	AmbientURL    string  `json:"ambientUrl,omitempty"`    // только для "update_scene"
	AmbientVolume float64 `json:"ambientVolume,omitempty"` // только для "update_scene"

	// GlobalLight — только для "set_global_light": "" | "dim" | "bright" (см.
	// SceneState.GlobalLight). Отдельное сообщение, а не поле "update_scene" —
	// это одна кнопка тулбара, а не часть модалки "Настроить сцену".
	GlobalLight string `json:"globalLight,omitempty"`

	// поля только для "animate_attack" — эфемерного fx-события, в state не
	// пишется и в snapshot не попадает
	FromX float64 `json:"fromX,omitempty"`
	FromY float64 `json:"fromY,omitempty"`
	ToX   float64 `json:"toX,omitempty"`
	ToY   float64 `json:"toY,omitempty"`
	Color string  `json:"color,omitempty"`

	// Formula — только для "roll_dice", тоже эфемерно (не пишется в state).
	Formula string `json:"formula,omitempty"`
	// Label — необязательная подпись броска ("Атлетика", "Спасбросок Ловкости"
	// и т.п.), только для "roll_dice", тоже эфемерно. Как и Formula, это
	// показываемый текст со стороны недоверенного клиента — сервер не
	// проверяет его смысл, только ограничивает длину (см. Room.handleRollDice)
	// и ретранслирует как есть. Личность бросающего (name в roll_result)
	// по-прежнему берётся с сервера (c.PlayerName()), Label её не подменяет.
	Label string `json:"label,omitempty"`

	// Cue — только для "play_cue"/"set_cue_volume" (канал ДМ). "stop_cue" его
	// не использует.
	Cue *CueState `json:"cue,omitempty"`

	// поля трекера инициативы (см. domain.CombatState/Combatant,
	// service.Room: handleAddCombatant и соседи). "start_combat"/"end_combat"/
	// "next_turn"/"prev_turn" не используют ни одно из полей ниже — они сами
	// по себе полная команда.
	//
	// "add_combatant" — источник ОДИН из трёх: TokenID (существующий токен на
	// активной сцене, см. ПКМ-меню токена), CharacterID (карточка игрока из
	// поиска "+ Добавить" — см. api.js: fetchAdminCharacters) либо MonsterID
	// (карточка бестиария) — оба последних напрямую, без токена на карте.
	// Имя/арт/HP/модификатор инициативы сервер сам подтягивает из
	// токена/персонажа/монстра — клиент их не присылает и повлиять на
	// бросок не может.
	TokenID     string `json:"tokenId,omitempty"`
	CharacterID string `json:"characterId,omitempty"`
	MonsterID   string `json:"monsterId,omitempty"`

	// CombatantID — цель "remove_combatant"/"set_combatant_initiative"/
	// "set_combatant_hp".
	CombatantID string `json:"combatantId,omitempty"`
	// Initiative — только для "set_combatant_initiative": прямое ручное
	// значение, без переброски куба и без модификатора (см. Combatant).
	Initiative *float64 `json:"initiative,omitempty"`
	// AC — только для "set_combatant_ac".
	AC *int `json:"ac,omitempty"`
	// HPCurrent/HPMax — только для "set_combatant_hp", каждое поле
	// независимо необязательно (правка одного не трогает другое).
	HPCurrent *int `json:"hpCurrent,omitempty"`
	HPMax     *int `json:"hpMax,omitempty"`

	// DeathSaveKind/DeathSaveValue — только для "set_combatant_death_save":
	// Kind "success"|"fail", Value — итоговое число отмеченных чекбоксов
	// 0-3 (абсолютное значение по индексу кликнутого чекбокса, тот же
	// приём, что и на бланке персонажа, см.
	// web/src/pages/character-sheet.js: bulbRow), а не инкремент.
	DeathSaveKind  string `json:"deathSaveKind,omitempty"`
	DeathSaveValue *int   `json:"deathSaveValue,omitempty"`

	// ShowHP — только для "set_show_hp": общий переключатель стола (раздел
	// "Настройки"), видят ли HP в верхнем оверлее хода игроки/TV (см.
	// domain.CombatState.ShowHP).
	ShowHP *bool `json:"showHp,omitempty"`

	// ---- инвентарь/лут (см. domain.InventoryEntry, LootHub, CombatState.LootingEnabled) ----

	// ItemID — только для "hub_add_item": какую карточку каталога (см.
	// domain.Item) ДМ кладёт в хаб — сервер сам резолвит снимок
	// имени/картинки/веса, клиент только указывает id.
	ItemID string `json:"itemId,omitempty"`
	// EntryID — какую запись трогаем: хаба ("hub_remove_item"/
	// "hub_set_quantity"/"hub_take_item") или лута трупа ("loot_take_item").
	EntryID string `json:"entryId,omitempty"`
	// Quantity — количество для "hub_add_item"/"hub_set_quantity"/
	// "hub_take_item"/"loot_take_item". nil трактуется как 1 там, где нужно
	// значение по умолчанию (добавление в хаб) — там, где нужно "заберу всё,
	// что есть" (взятие из хаба/трупа), 0/отсутствие тоже означает "всё
	// доступное" (см. service.Room).
	Quantity *int `json:"quantity,omitempty"`
	// LootingEnabled — только для "set_looting_enabled": общий тумблер стола,
	// разрешать ли игрокам лутить убитых монстров (см.
	// domain.CombatState.LootingEnabled).
	LootingEnabled *bool `json:"lootingEnabled,omitempty"`
	// Note — необязательная подпись записи хаба ("hub_add_item"), например
	// "с тела вожака" — чисто информационный текст, сервер его не проверяет
	// на смысл, только ограничивает длину (см. service.Room), как Label у
	// "roll_dice".
	Note string `json:"note,omitempty"`

	// ---- состояния (см. domain.Condition, AppliedStatus, service.Room:
	// handleApplyStatus и соседи) ----
	//
	// Цель ЛЮБОЙ из команд ниже — ОДНА из двух: TokenID (токен на активной
	// сцене — ПКМ-меню токена) либо CombatantID (карточка бойца в трекере,
	// в т.ч. ещё не вытащенная на карту). Оба поля уже объявлены выше и
	// переиспользуются, как ID у команд стен.
	//
	// StatusSlug — какое состояние трогаем ("blinded", см. Condition.Slug);
	// цель "apply_status"/"remove_status"/"set_status_level"/
	// "set_status_rounds". "clear_statuses" его не использует — снимает все.
	// Само имя/иконку/цвет клиент не присылает: сервер сам резолвит карточку
	// справочника и делает снимок (тем же принципом недоверия клиенту, что и
	// "hub_add_item"/"add_combatant").
	StatusSlug string `json:"statusSlug,omitempty"`
	// Level — уровень многоуровневого состояния (истощение 1-6), для
	// "apply_status"/"set_status_level". 0/отсутствие — обычный тумблер;
	// потолок клампит сервер по Condition.Levels. Для "set_status_level"
	// значение 0 означает «снять метку целиком» (клик по первой лампе, тот
	// же приём, что у спасбросков от смерти).
	Level *int `json:"level,omitempty"`
	// Rounds — длительность в раундах для "apply_status"/"set_status_rounds";
	// 0 — бессрочно. nil в "apply_status" означает «взять
	// Condition.DefaultRounds из карточки».
	Rounds *int `json:"rounds,omitempty"`
	// Hidden — метка видна только ДМ (см. AppliedStatus.Hidden), только для
	// "apply_status". nil — как в карточке (то есть видна всем).
	Hidden *bool `json:"hidden,omitempty"`
	// Source — подпись «откуда прилетело» для "apply_status" («Заклинание
	// «Огненный шар»»). Показываемый текст со стороны клиента — сервер, как
	// и с Label у "roll_dice"/Note у "hub_add_item", не проверяет его смысл,
	// только ограничивает длину.
	Source string `json:"source,omitempty"`

	// TokenX/TokenY — только для "place_combatant_token": куда на активной
	// сцене поставить новый токен (мировые координаты, см.
	// web/src/vtt/camera.js: screenToWorld) — ДМ вытащил карточку бойца из
	// трекера (см. combat-panel.js) на карту. Отдельные поля, а не Token.X/Y
	// — сервер сам собирает Token из уже сохранённого в Combatant снимка
	// (имя/арт/цвет/владелец/characterId/monsterId), клиенту нужно прислать
	// только КУДА и КОГО (CombatantID).
	TokenX float64 `json:"tokenX,omitempty"`
	TokenY float64 `json:"tokenY,omitempty"`
}

// WallPointRef — один конец одной стены в сообщении "move_wall_point". Which
// 1|2 — какой конец стены трогать (X1/Y1 или X2/Y2, см. domain.Wall).
type WallPointRef struct {
	WallID string  `json:"wallId"`
	Which  int     `json:"which"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
}

// CueState — что сейчас играет на канале ДМ (плейлисты, включаются вручную,
// независимо от амбиента сцены). StartedAtMs — момент старта в
// Unix-миллисекундах, от него каждый клиент сам считает currentTime — так
// подключившийся позже клиент слышит трек с той же позиции, а не с нуля,
// без стриминга позиции по WS. nil *CueState = ничего не играет.
type CueState struct {
	URL         string  `json:"url"`
	Name        string  `json:"name"`
	Volume      float64 `json:"volume"`
	Loop        bool    `json:"loop"`
	StartedAtMs int64   `json:"startedAtMs"`
}
