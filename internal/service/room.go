package service

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"regexp"
	"sort"
	"strconv"
	"time"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository"
)

// RoomClient — то, что Room-актору нужно от подключённого клиента, чтобы не
// зависеть от конкретного транспорта. Реализуется в api/ws.Client; здесь —
// только интерфейс, чтобы зависимость шла в правильную сторону (api зависит
// от service, а не наоборот).
type RoomClient interface {
	// Send кладёт payload в исходящую очередь клиента (не блокирует Room,
	// если клиент отстаёт — см. реализацию в api/ws).
	Send(payload any)
	// Close сигналит транспорту, что клиент покинул комнату и его исходящий
	// канал/соединение можно закрывать.
	Close()
	Role() domain.ClientRole
	PlayerID() string
	PlayerName() string
}

// RoomService — единственная "комната" стола: живая модель сцен, токенов,
// стен, тумана и канала ДМ, плюс маршрутизация команд клиентов и
// авторизация по роли. Реализация (*Room) — actor: всё состояние
// принадлежит одной горутине run(), мутации идут только через каналы
// join/leave/inbound, так что гонок на state нет без единого ручного мьютекса.
type RoomService interface {
	Join(c RoomClient)
	Leave(c RoomClient)
	// Dispatch кладёт разобранную команду в очередь на обработку run().
	// Разбор сырых байт WS-сообщения в domain.ClientMsg — забота
	// транспортного (api/ws) слоя, не этого.
	Dispatch(c RoomClient, msg domain.ClientMsg)
	// Shutdown синхронно сохраняет текущую сцену и завершает горутину run().
	Shutdown()
}

type inboundMsg struct {
	from RoomClient
	msg  domain.ClientMsg
}

// Room — реализация RoomService.
type Room struct {
	store repository.SceneRepository
	dice  DiceRoller
	// characters/monsters — только для чтения, нужны исключительно чтобы
	// "add_combatant" мог сам подтянуть имя/арт/HP/модификатор инициативы
	// (Dex) персонажа/монстра, не доверяя эти цифры недоверенному клиенту
	// (см. handleAddCombatant). Никаких мутаций через них Room не делает —
	// владение персонажами/бестиарием остаётся за CharacterService/
	// BestiaryService.
	characters repository.CharacterRepository
	monsters   repository.MonsterRepository
	// items — только для чтения, нужен исключительно чтобы "hub_add_item"
	// мог сам подтянуть имя/картинку/вес предмета каталога (см.
	// handleHubAddItem) — тем же принципом недоверия клиенту, что и у
	// characters/monsters выше.
	items repository.ItemRepository
	// conditions — только для чтения, нужен, чтобы "apply_status" сам
	// подтянул имя/иконку/цвет/уровни/зависимые состояния из карточки
	// справочника (см. room_statuses.go: lookupCondition, snapshotStatus) —
	// тем же принципом недоверия клиенту, что и items выше.
	conditions repository.ConditionRepository

	scenes         map[string]*domain.SceneState // все сцены комнаты, ключ — SceneState.ID
	sceneOrder     []string                      // порядок сцен в переключателе DM
	currentSceneID string                        // ID активной сейчас сцены — ключ в scenes
	scene          *domain.SceneState            // == scenes[currentSceneID]; кэш, чтобы не лазить в map на каждую мутацию
	clients        map[RoomClient]bool
	join           chan RoomClient
	leave          chan RoomClient
	inbound        chan inboundMsg
	shutdown       chan chan struct{}
	dirty          bool            // есть хоть одна несохранённая мутация с последнего флаша
	dirtyScenes    map[string]bool // какие именно сцены мутировали — флашим на диск только их файлы, а не всю библиотеку

	// combat — трекер инициативы всего стола (см. domain.CombatState), не
	// привязан к конкретной сцене — переживает switch_scene. combatDirty —
	// тот же принцип, что и dirtyScenes, но для единственного файла
	// combat.json (см. flushIfDirty). combatSeq — счётчик для Combatant.Seq
	// (детерминированный тай-брейк сортировки при равной инициативе),
	// продолжается с максимума уже загруженных бойцов, а не с нуля, чтобы
	// перезапуск сервера посреди боя не перемешал порядок стоящих вничью.
	combat      *domain.CombatState
	combatDirty bool
	combatSeq   int64

	// hub — общий хаб лута ДМ (см. domain.LootHub), не привязан к
	// сцене/бою, живёт всё время стола, тем же принципом, что combat выше.
	hub      *domain.LootHub
	hubDirty bool

	// ambientStartedAtMs — момент, с которого отсчитывается позиция амбиента
	// АКТИВНОЙ сцены (см. SceneState.AmbientURL и CueState.StartedAtMs — тот
	// же принцип синхронизации по времени, не по стриму позиции). Обновляется
	// на switch_scene всегда и на update_scene только если реально
	// поменялся AmbientURL — не хотим дёргать музыку правкой сетки.
	ambientStartedAtMs int64
	// mapStartedAtMs — тот же принцип, но для позиции ЗАЦИКЛЕННОГО mp4-фона
	// карты: все клиенты (ДМ, TV, игроки) должны видеть один и тот же кадр
	// анимации в один момент времени, а не каждый со своего момента
	// подключения. Игнорируется клиентом, если текущий фон — не видео.
	mapStartedAtMs int64
	cue            *domain.CueState // канал ДМ — независим от амбиента сцены, nil = ничего не играет
}

// NewRoom поднимает комнату из sceneRepo (все сцены с прошлого запуска,
// каждая со своими стенами/туманом/токенами, плюс трекер инициативы и хаб
// лута) и запускает её actor-горутину. characterRepo/monsterRepo/itemRepo/
// conditionRepo — см. Room.characters/Room.monsters/Room.items/
// Room.conditions, только для чтения (кроме точечных мутаций инвентаря
// персонажа при луте, см. handleHubTakeItem/handleLootTakeItem).
func NewRoom(sceneRepo repository.SceneRepository, dice DiceRoller, characterRepo repository.CharacterRepository, monsterRepo repository.MonsterRepository, itemRepo repository.ItemRepository, conditionRepo repository.ConditionRepository) (*Room, error) {
	rs, err := sceneRepo.Load(context.Background())
	if err != nil {
		return nil, err
	}
	combat := rs.Combat
	if combat == nil {
		combat = domain.NewCombatState()
	}
	hub := rs.Hub
	if hub == nil {
		hub = domain.NewLootHub()
	}
	r := &Room{
		store:          sceneRepo,
		dice:           dice,
		characters:     characterRepo,
		monsters:       monsterRepo,
		items:          itemRepo,
		conditions:     conditionRepo,
		scenes:         rs.Scenes,
		sceneOrder:     rs.SceneOrder,
		currentSceneID: rs.CurrentSceneID,
		clients:        make(map[RoomClient]bool),
		join:           make(chan RoomClient),
		leave:          make(chan RoomClient),
		inbound:        make(chan inboundMsg, 32),
		shutdown:       make(chan chan struct{}),
		dirtyScenes:    make(map[string]bool),
		combat:         combat,
		hub:            hub,
	}
	r.scene = r.scenes[r.currentSceneID]
	r.ambientStartedAtMs = time.Now().UnixMilli() // амбиент активной сцены (если есть) стартует заново при запуске сервера
	r.mapStartedAtMs = time.Now().UnixMilli()     // видео-фон активной сцены (если есть) — аналогично
	for _, cmb := range combat.Combatants {
		if cmb.Seq >= r.combatSeq {
			r.combatSeq = cmb.Seq + 1
		}
	}
	go r.run()
	return r, nil
}

func (r *Room) Join(c RoomClient)  { r.join <- c }
func (r *Room) Leave(c RoomClient) { r.leave <- c }
func (r *Room) Dispatch(c RoomClient, msg domain.ClientMsg) {
	r.inbound <- inboundMsg{from: c, msg: msg}
}

// autosaveInterval — как часто сбрасывать на диск накопившиеся мутации. Не
// пишем файл на каждое "move_token" (при драге токена мышью это до сотни
// сообщений в секунду) — вместо этого просто помечаем сцену "грязной" и
// сохраняем её по таймеру. Секунда простоя после последней мутации — не
// заметно на глаз, а нагрузку на диск снижает на порядки.
const autosaveInterval = 2 * time.Second

// run — единственная горутина, владеющая состоянием комнаты.
func (r *Room) run() {
	ticker := time.NewTicker(autosaveInterval)
	defer ticker.Stop()

	for {
		select {
		case c := <-r.join:
			r.clients[c] = true
			c.Send(r.snapshotPayload(c))
			c.Send(r.cuePayload())     // канал ДМ — что уже играет, если играет
			c.Send(r.combatPayload(c)) // трекер инициативы — свежеподключившийся сразу видит бой (если идёт)
			c.Send(r.hubPayload())     // хаб лута — свежеподключившийся сразу видит, что уже накидал ДМ
			r.broadcastSceneList()
			r.broadcastPlayerList()

		case c := <-r.leave:
			delete(r.clients, c)
			c.Close()
			r.broadcastSceneList()
			r.broadcastPlayerList()

		case im := <-r.inbound:
			if !r.authorize(im.from, im.msg.Type) {
				continue // роли/сообщению не положено — молча игнорируем
			}
			switch im.msg.Type {
			case "animate_attack":
				r.relayFx(im.msg) // не трогает state, просто ретранслируем всем
				continue
			case "roll_dice":
				r.handleRollDice(im.from, im.msg) // эфемерно, не трогает state
				continue
			case "move_own_token":
				r.applyOwnTokenMove(im.from, im.msg) // сам шлёт broadcastAll при успехе
				continue
			case "toggle_door":
				// Своя ветка, а не applyMutation — единственная мутация стен,
				// доступная игроку (см. authorize), поэтому нужна ролевая
				// проверка внутри (секретная/запертая дверь — только ДМ), а
				// не просто "разрешено/нет" целиком по типу сообщения.
				r.handleToggleDoor(im.from, im.msg)
				continue
			case "set_door_lock":
				// ДМ-only (authorize не пускает игрока), но своя ветка —
				// нужно перевести Locked в конкретное DoorState, а не просто
				// присвоить поле как applyMutation делает для прочих стен.
				r.handleSetDoorLock(im.msg)
				continue
			case "get_scene":
				// точечный запрос: DM открыл "Настроить сцену" для НЕактивной
				// сцены через шестерёнку в списке — её данных (фон/размер/сетка)
				// у клиента ещё нет, snapshot несёт только активную сцену.
				// Ответ уходит только запросившему, состояние комнаты не трогаем.
				if s, ok := r.scenes[im.msg.SceneID]; ok {
					im.from.Send(map[string]any{"type": "scene_detail", "scene": s})
				}
				continue
			case "play_cue":
				if im.msg.Cue != nil {
					r.cue = &domain.CueState{
						URL: im.msg.Cue.URL, Name: im.msg.Cue.Name,
						Volume: im.msg.Cue.Volume, Loop: im.msg.Cue.Loop,
						StartedAtMs: time.Now().UnixMilli(),
					}
					r.broadcastCue()
				}
				continue
			case "stop_cue":
				r.cue = nil
				r.broadcastCue()
				continue
			case "set_cue_volume":
				// живая правка громкости уже играющего трека — НЕ трогает
				// StartedAtMs, иначе у всех перематывало бы трек на каждый
				// сдвиг слайдера.
				if r.cue != nil && im.msg.Cue != nil {
					r.cue.Volume = im.msg.Cue.Volume
					r.broadcastCue()
				}
				continue

			// ---- трекер инициативы (см. domain.CombatState/Combatant) —
			// своя ветка мутаций, а не applyMutation: он живёт вне r.scene и
			// рассылается отдельным broadcastCombat, а не broadcastAll.
			case "add_combatant":
				r.handleAddCombatant(im.msg)
				continue
			case "remove_combatant":
				r.handleRemoveCombatant(im.msg.CombatantID)
				continue
			case "set_combatant_initiative":
				if im.msg.Initiative != nil {
					r.handleSetCombatantInitiative(im.msg.CombatantID, *im.msg.Initiative)
				}
				continue
			case "set_combatant_ac":
				if im.msg.AC != nil {
					r.handleSetCombatantAC(im.msg.CombatantID, *im.msg.AC)
				}
				continue
			case "set_combatant_hp":
				r.handleSetCombatantHP(im.msg.CombatantID, im.msg.HPCurrent, im.msg.HPMax)
				continue
			case "set_combatant_death_save":
				if im.msg.DeathSaveValue != nil {
					r.handleSetCombatantDeathSave(im.msg.CombatantID, im.msg.DeathSaveKind, *im.msg.DeathSaveValue)
				}
				continue
			case "set_show_hp":
				if im.msg.ShowHP != nil {
					r.handleSetShowHP(*im.msg.ShowHP)
				}
				continue
			case "place_combatant_token":
				r.handlePlaceCombatantToken(im.msg.CombatantID, im.msg.TokenX, im.msg.TokenY)
				continue
			case "start_combat":
				r.handleStartCombat()
				continue
			case "end_combat":
				r.handleEndCombat()
				continue
			case "next_turn":
				r.handleTurnStep(1)
				continue
			case "prev_turn":
				r.handleTurnStep(-1)
				continue
			case "set_looting_enabled":
				if im.msg.LootingEnabled != nil {
					r.handleSetLootingEnabled(*im.msg.LootingEnabled)
				}
				continue

			// ---- хаб лута ДМ (см. domain.LootHub) — своя ветка мутаций, тем
			// же принципом, что и трекер инициативы: живёт вне r.scene,
			// рассылается отдельным broadcastHub.
			case "hub_add_item":
				r.handleHubAddItem(im.msg)
				continue
			case "hub_remove_item":
				r.handleHubRemoveItem(im.msg.EntryID)
				continue
			case "hub_set_quantity":
				if im.msg.Quantity != nil {
					r.handleHubSetQuantity(im.msg.EntryID, *im.msg.Quantity)
				}
				continue
			case "hub_take_item":
				r.handleHubTakeItem(im.from, im.msg)
				continue

			// ---- лут убитого монстра прямо с токена (см. Token.Loot) ----
			case "loot_take_item":
				r.handleLootTakeItem(im.from, im.msg)
				continue

			// ---- наложенные состояния (см. domain.AppliedStatus,
			// room_statuses.go) — своя ветка мутаций, потому что цель команды
			// может лежать и в сцене (Token.Statuses), и в трекере
			// (Combatant.Statuses): куда именно писать и что рассылать,
			// решает resolveStatusTarget/commitStatuses, а не общий
			// applyMutation+broadcastAll внизу.
			case "apply_status":
				r.handleApplyStatus(im.msg)
				continue
			case "remove_status":
				r.handleRemoveStatus(im.msg)
				continue
			case "set_status_level":
				r.handleSetStatusLevel(im.msg)
				continue
			case "set_status_rounds":
				r.handleSetStatusRounds(im.msg)
				continue
			case "clear_statuses":
				r.handleClearStatuses(im.msg)
				continue
			}
			r.applyMutation(im.msg)
			r.broadcastAll()
			r.broadcastSceneList()

		case <-ticker.C:
			r.flushIfDirty()

		case done := <-r.shutdown:
			// финальное сохранение перед выходом процесса — не ждём таймер,
			// чтобы Ctrl+C или закрытие сервиса не роняло последние секунды правок.
			r.flushIfDirty()
			close(done)
			return
		}
	}
}

// markDirty помечает сцену как нуждающуюся в сохранении на следующем тике
// автосейва (см. flushIfDirty).
func (r *Room) markDirty(sceneID string) {
	if sceneID == "" {
		return
	}
	r.dirtyScenes[sceneID] = true
	r.dirty = true
}

// flushIfDirty пишет на диск только те сцены, что реально мутировали с
// прошлого сохранения (плюс крошечные метаданные с указателем активной
// сцены и порядком списка) — а не всю библиотеку целиком. При сотне сцен в
// архиве это разница между записью пары килобайт и перезаписью всего
// архива на каждый чих. Вызывается только из run(), так что чтение
// r.scenes тут безопасно без мьютекса.
func (r *Room) flushIfDirty() {
	if !r.dirty {
		return
	}
	ctx := context.Background()
	for id, isDirty := range r.dirtyScenes {
		if !isDirty {
			continue
		}
		s, ok := r.scenes[id]
		if !ok {
			delete(r.dirtyScenes, id)
			continue
		}
		if err := r.store.SaveScene(ctx, id, s); err != nil {
			log.Println("не удалось сохранить сцену, попробую ещё раз позже:", id, err)
			continue // не сбрасываем — повторим именно эту сцену на следующем тике
		}
		delete(r.dirtyScenes, id)
	}
	if err := r.store.SaveMeta(ctx, r.currentSceneID, r.sceneOrder); err != nil {
		log.Println("не удалось сохранить активную сцену:", err)
		return
	}
	if r.combatDirty {
		if err := r.store.SaveCombat(ctx, r.combat); err != nil {
			log.Println("не удалось сохранить трекер инициативы, попробую ещё раз позже:", err)
		} else {
			r.combatDirty = false
		}
	}
	if r.hubDirty {
		if err := r.store.SaveHub(ctx, r.hub); err != nil {
			log.Println("не удалось сохранить хаб лута, попробую ещё раз позже:", err)
		} else {
			r.hubDirty = false
		}
	}
	if len(r.dirtyScenes) == 0 && !r.combatDirty && !r.hubDirty {
		r.dirty = false
	}
}

// Shutdown синхронно сохраняет текущую сцену и завершает горутину run().
// Вызывается композиционным корнем при получении SIGINT/SIGTERM, чтобы
// гарантированно не потерять правки за последние autosaveInterval секунд.
func (r *Room) Shutdown() {
	done := make(chan struct{})
	r.shutdown <- done
	<-done
}

// sceneFor — ключевое место фильтрации: каждый клиент получает свою версию
// сцены в зависимости от того, DM он или зритель.
func (r *Room) sceneFor(c RoomClient) *domain.PublicScene {
	tokens := make(map[string]*domain.Token)
	isDM := c.Role() == domain.RoleDM
	for id, t := range r.scene.Tokens {
		switch {
		case isDM:
			tokens[id] = t
		case t.Hidden:
			// токен целиком вырезан из payload — как и раньше
		default:
			// Скрытые метки состояний (AppliedStatus.Hidden) вырезаются тем
			// же принципом, что и hidden-токен: физически из payload, а не
			// стилями на клиенте (см. room_statuses.go: publicToken).
			tokens[id] = publicToken(t)
		}
	}
	// noteMarkers — личный инструмент ДМ (см. domain.NoteMarker), никогда не
	// уходит игрокам/TV — не toggle "раскрыто/нет", как было у старого
	// HiddenAsset, а полная фильтрация, тем же принципом, что и
	// broadcastSceneList для списка сцен.
	noteMarkers := map[string]*domain.NoteMarker{}
	if isDM {
		noteMarkers = r.scene.NoteMarkers
	}
	return &domain.PublicScene{
		ID:            r.scene.ID,
		Name:          r.scene.Name,
		MapURL:        r.scene.MapURL,
		Width:         r.scene.Width,
		Height:        r.scene.Height,
		FogOfWar:      r.scene.FogOfWar,
		Grid:          r.scene.Grid,
		AmbientURL:    r.scene.AmbientURL,
		AmbientVolume: r.scene.AmbientVolume,
		GlobalLight:   r.scene.GlobalLight,
		Tokens:        tokens,
		NoteMarkers:   noteMarkers,
		Walls:         r.scene.Walls,
		FogAreas:      r.scene.FogAreas,
		Buildings:     r.scene.Buildings,
	}
}

// snapshotPayload — сцена клиента + ambientStartedAtMs в одном сообщении:
// амбиент — атрибут активной сцены, отдельный WS-запрос под него не нужен.
// serverNow — время сервера в момент отправки: клиент сравнивает его со
// своим Date.now() и держит поправку — без нее два клиента с разведёнными
// системными часами (что для обычных ноутбуков/телефонов совершенно
// нормально, на секунды-десятки секунд) слышали бы разные моменты одного и
// того же трека, хотя оба честно считают offset от одного и того же
// startedAtMs.
func (r *Room) snapshotPayload(c RoomClient) map[string]any {
	return map[string]any{
		"type": "snapshot", "scene": r.sceneFor(c),
		"ambientStartedAt": r.ambientStartedAtMs, "mapStartedAt": r.mapStartedAtMs,
		"serverNow": time.Now().UnixMilli(),
	}
}

// broadcastAll шлёт каждому клиенту его персональную (отфильтрованную)
// версию АКТИВНОЙ сцены. Для демо-масштаба (один стол, до десятка клиентов)
// слать полный снапшот на каждую мутацию проще и надёжнее, чем городить
// дельты с ручной фильтрацией по каждому типу события.
func (r *Room) broadcastAll() {
	for c := range r.clients {
		c.Send(r.snapshotPayload(c))
	}
}

// broadcastCue шлёт всем клиентам (не только ДМ — канал ДМ слышат все)
// текущее состояние канала ДМ. r.cue может быть nil — тогда JSON-поле "cue"
// уйдёт как null, клиент это трактует как "ничего не играет". serverNow —
// см. комментарий snapshotPayload, та же поправка часов.
func (r *Room) broadcastCue() {
	payload := r.cuePayload()
	for c := range r.clients {
		c.Send(payload)
	}
}

func (r *Room) cuePayload() map[string]any {
	return map[string]any{"type": "audio_cue", "cue": r.cue, "serverNow": time.Now().UnixMilli()}
}

// broadcastSceneList шлёт только DM-клиентам список всех сцен комнаты (для
// переключателя сцен) — зрителям он не нужен, они и так видят ровно одну
// активную сцену через broadcastAll. ViewerCount у сцены ненулевой только
// для текущей активной.
func (r *Room) broadcastSceneList() {
	viewerCount := 0
	for c := range r.clients {
		if c.Role() != domain.RoleDM {
			viewerCount++
		}
	}
	entries := make([]domain.SceneListEntry, 0, len(r.sceneOrder))
	for _, id := range r.sceneOrder {
		s, ok := r.scenes[id]
		if !ok {
			continue
		}
		vc := 0
		if id == r.currentSceneID {
			vc = viewerCount
		}
		entries = append(entries, domain.SceneListEntry{ID: s.ID, Name: s.Name, ViewerCount: vc})
	}
	payload := map[string]any{"type": "scene_list", "scenes": entries, "currentSceneId": r.currentSceneID}
	for c := range r.clients {
		if c.Role() == domain.RoleDM {
			c.Send(payload)
		}
	}
}

// broadcastPlayerList шлёт ДМ-клиентам список сейчас подключённых игроков
// (id+имя) — используется в UI назначения владельца токена.
func (r *Room) broadcastPlayerList() {
	type playerInfo struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	players := make([]playerInfo, 0)
	for c := range r.clients {
		if c.Role() == domain.RolePlayer {
			players = append(players, playerInfo{ID: c.PlayerID(), Name: c.PlayerName()})
		}
	}
	payload := map[string]any{"type": "player_list", "players": players}
	for c := range r.clients {
		if c.Role() == domain.RoleDM {
			c.Send(payload)
		}
	}
}

// authorize — права по типу сообщения и роли отправителя. DM может всё; TV
// не может ничего (чистый зритель); игрок — только двигать СВОИ токены,
// кидать кубы и открывать/закрывать двери (см. handleToggleDoor — секретные и
// запертые для игрока дополнительно отбрасывает уже сам обработчик, тут
// только "тип сообщения вообще разрешён этой роли"), остальное (создание/
// удаление/скрытие токенов, стены, окна, замки дверей, туман, сцены) —
// только ДМ. Владение конкретным токеном проверяется отдельно, уже внутри
// applyOwnTokenMove.
func (r *Room) authorize(c RoomClient, msgType string) bool {
	switch c.Role() {
	case domain.RoleDM:
		return true
	case domain.RolePlayer:
		return msgType == "move_own_token" || msgType == "roll_dice" ||
			msgType == "hub_take_item" || msgType == "loot_take_item" ||
			msgType == "toggle_door"
	default: // RoleTV
		return false
	}
}

// applyOwnTokenMove — двигает только X/Y токена, и только если он
// принадлежит приславшему игроку (Token.OwnerID == c.PlayerID()). В отличие
// от move_token (ДМ), не может поменять цвет/подпись/скрытость/картинку —
// минимальная поверхность доверия клиенту, которого сервер не контролирует.
func (r *Room) applyOwnTokenMove(c RoomClient, msg domain.ClientMsg) {
	if msg.Token == nil {
		return
	}
	existing, ok := r.scene.Tokens[msg.Token.ID]
	if !ok || existing.OwnerID == "" || existing.OwnerID != c.PlayerID() {
		return // не твой токен — тихо игнорируем, а не ошибку шлём
	}
	existing.X = msg.Token.X
	existing.Y = msg.Token.Y
	r.markDirty(r.currentSceneID)
	r.broadcastAll()
}

// handleToggleDoor переключает дверь closed<->open. Разрешено и ДМ, и
// игроку (см. authorize) — но игроку сервер, а не только клиентский UI,
// отказывает для секретной (Door=="secret") и запертой (DoorState=="locked")
// двери: клиент и так прячет их значок/хит-тест от роли player (см.
// web/src/vtt/layers/doors.js, geometry.js:doorAt), но подделать WS-сообщение
// руками ничего не стоит, а тут — единственная стеновая мутация, доступная
// не-ДМ, так что источник правды должен быть здесь.
func (r *Room) handleToggleDoor(from RoomClient, msg domain.ClientMsg) {
	w, ok := r.scene.Walls[msg.ID]
	if !ok || w.Door == "" {
		return
	}
	if from.Role() != domain.RoleDM && (w.Door == "secret" || w.DoorState == "locked") {
		return
	}
	if w.DoorState == "open" {
		w.DoorState = "closed"
	} else {
		w.DoorState = "open"
	}
	r.markDirty(r.currentSceneID)
	r.broadcastAll()
}

// handleSetDoorLock — запереть/отпереть дверь, только ДМ (authorize не
// пускает игрока к "set_door_lock" вовсе). Запереть подразумевает и закрыть
// (запертая-но-открытая дверь бессмысленна); отпереть просто возвращает в
// "closed", а не открывает — ДМ решает открыть отдельным действием.
func (r *Room) handleSetDoorLock(msg domain.ClientMsg) {
	if msg.Locked == nil {
		return
	}
	w, ok := r.scene.Walls[msg.ID]
	if !ok || w.Door == "" {
		return
	}
	if *msg.Locked {
		w.DoorState = "locked"
	} else {
		w.DoorState = "closed"
	}
	r.markDirty(r.currentSceneID)
	r.broadcastAll()
}

// handleRollDice парсит и бросает формулу, полученную от игрока или ДМ, и
// рассылает результат всем клиентам комнаты (DM+TV+игроки видят один лог).
// Не пишет ничего в SceneState — бросок эфемерен, как animate_attack.
func (r *Room) handleRollDice(c RoomClient, msg domain.ClientMsg) {
	result, err := r.dice.Roll(msg.Formula)
	if err != nil {
		return // некорректная/вне-лимитов формула — просто игнорируем
	}
	name := c.PlayerName()
	if c.Role() == domain.RoleDM {
		name = "ДМ"
	}
	r.relayRoll(name, msg.Formula, clampRunes(msg.Label, maxRollLabel), result)
}

// maxRollLabel — потолок длины Label (см. domain.ClientMsg), чтобы кривой
// клиент не раздул roll_result-payload, рассылаемый всем клиентам комнаты.
const maxRollLabel = 80

func (r *Room) relayRoll(name, formula, label string, result domain.RollResult) {
	payload := map[string]any{
		"type":     "roll_result",
		"name":     name,
		"formula":  formula,
		"rolls":    result.Rolls,
		"modifier": result.Modifier,
		"total":    result.Total,
	}
	if label != "" {
		payload["label"] = label
	}
	for c := range r.clients {
		c.Send(payload)
	}
}

// relayFx — анимации в state не пишем: это одноразовое "проиграй эффект",
// снапшот сцены им не разрастается со временем и не требует чистки.
func (r *Room) relayFx(msg domain.ClientMsg) {
	payload := map[string]any{"type": "fx", "fx": msg}
	for c := range r.clients {
		c.Send(payload)
	}
}

// ================= трекер инициативы (domain.CombatState) =================
//
// Живёт вне r.scene (см. Room.combat) — не сцена, не сбрасывается
// switch_scene. Единственный источник правды о ПОРЯДКЕ ходов —
// sortedCombatantIDs, вызывается заново на каждую мутацию/бродкаст: хранить
// отдельный []string с порядком было бы вторым источником правды, который
// пришлось бы вручную ресинхронить при каждой правке инициативы вручную.

// combatantNameSuffixRe разбирает "Гоблин 2" -> ("Гоблин", 2) — см.
// uniqueCombatantName.
var combatantNameSuffixRe = regexp.MustCompile(`^(.*) (\d+)$`)

// uniqueCombatantName — если base уже занято одним или несколькими бойцами
// трекера, возвращает "base N" со следующим свободным номером (как Foundry
// нумерует "Гоблин", "Гоблин 2", "Гоблин 3" при повторном добавлении одного
// монстра из бестиария) — иначе просто base без изменений.
func (r *Room) uniqueCombatantName(base string) string {
	maxN := 0
	for _, cmb := range r.combat.Combatants {
		if cmb.Name == base {
			if maxN < 1 {
				maxN = 1
			}
			continue
		}
		if m := combatantNameSuffixRe.FindStringSubmatch(cmb.Name); m != nil && m[1] == base {
			if n, err := strconv.Atoi(m[2]); err == nil && n > maxN {
				maxN = n
			}
		}
	}
	if maxN == 0 {
		return base
	}
	return fmt.Sprintf("%s %d", base, maxN+1)
}

// abilityMod — тот же floor((score-10)/2), что и на клиенте (см.
// web/src/pages/character-sheet.js: abilityMod) — сервер должен посчитать
// ровно то же самое число для модификатора инициативы, иначе бросок "1d20 +
// мод" разъедется с тем, что игрок видит у себя на листе.
func abilityMod(score int) int {
	return int(math.Floor(float64(score-10) / 2))
}

// handleAddCombatant — "add_combatant": источник ОДИН из двух (см.
// domain.ClientMsg) — TokenID (существующий токен активной сцены, обычный
// путь через ПКМ-меню токена) либо MonsterID (карточка бестиария напрямую,
// без токена на карте — путь через поиск "+" в трекере). Имя/арт/HP/
// модификатор инициативы сервер подтягивает сам из Character/Monster —
// клиент их не присылает и повлиять на бросок не может (та же логика
// недоверия клиенту, что и у handleRollDice).
func (r *Room) handleAddCombatant(msg domain.ClientMsg) {
	var name, image, color, ownerID, characterID, monsterID, tokenID string
	dexScore := 10
	ac, hpCur, hpMax := 0, 0, 0

	switch {
	case msg.TokenID != "":
		t, ok := r.scene.Tokens[msg.TokenID]
		if !ok || t.LightOnly {
			return // токена-лампочки в инициативе не бывает — у него нет "хода"
		}
		tokenID = t.ID
		name = t.Label
		image = t.Image
		color = t.Color
		ownerID = t.OwnerID
		characterID = t.CharacterID
		monsterID = t.MonsterID
	case msg.CharacterID != "":
		// Третий источник (после TokenID/MonsterID) — карточка ИГРОКА из
		// поиска "+ Добавить" (см. combat-panel.js, api.js: fetchAdminCharacters),
		// без токена на карте, симметрично добавлению монстра из бестиария.
		// ownerID/имя/арт/HP подтягиваются ниже, как и у token-пути — сам
		// токен на сцене появится только когда ДМ вытащит карточку из
		// трекера на карту (см. handlePlaceCombatantToken).
		characterID = msg.CharacterID
	case msg.MonsterID != "":
		monsterID = msg.MonsterID
	default:
		return
	}

	ctx := context.Background()
	if characterID != "" && r.characters != nil {
		if ch, err := r.characters.ByID(ctx, characterID); err == nil {
			if name == "" {
				name = ch.Name
			}
			if image == "" {
				image = ch.AvatarURL
			}
			if ownerID == "" {
				ownerID = ch.AccountID
			}
			dexScore = ch.Sheet.Abilities.Dex
			ac = ch.Sheet.Combat.AC
			hpCur = ch.Sheet.Combat.HPCurrent
			hpMax = ch.Sheet.Combat.HPMax
		}
	} else if monsterID != "" && r.monsters != nil {
		if m, err := r.monsters.Get(ctx, monsterID); err == nil {
			if name == "" {
				name = m.Name
			}
			if image == "" {
				image = m.ImageURL
			}
			dexScore = m.Abilities.Dex
			ac = m.AC
			hpCur = m.HP
			hpMax = m.HP
		}
	}
	if name == "" {
		name = "Без имени"
	}
	name = r.uniqueCombatantName(name)

	mod := abilityMod(dexScore)
	// Модификаторы инициативы от состояний, УЖЕ висящих на токене (ДМ мог
	// пометить монстра до того, как бросил инициативу) — см.
	// domain.ModifierTargetInitiative. Задним числом уже брошенную
	// инициативу ничто не пересчитывает: это разовый бросок, а не
	// производное число.
	if t, _ := r.findToken(tokenID); t != nil {
		mods := make([]domain.Modifier, 0, len(t.Statuses))
		for _, st := range t.Statuses {
			mods = append(mods, st.Modifiers...)
		}
		mod = domain.ApplyModifiers(mod, domain.ModifierTargetInitiative, mods)
	}
	formula := fmt.Sprintf("1d20%+d", mod)
	initiative := 0.0
	if result, err := r.dice.Roll(formula); err == nil {
		initiative = float64(result.Total)
		r.relayRoll("ДМ", formula, "Инициатива: "+name, result)
	}

	id := "combatant-" + newID()
	r.combatSeq++
	r.combat.Combatants[id] = &domain.Combatant{
		ID: id, TokenID: tokenID, Name: name, Image: image, Color: color,
		OwnerID: ownerID, CharacterID: characterID, MonsterID: monsterID,
		Initiative: initiative, AC: ac, HPCurrent: hpCur, HPMax: hpMax, Seq: r.combatSeq,
	}
	r.markCombatDirty()
	r.broadcastCombat()
}

func (r *Room) handleRemoveCombatant(id string) {
	if _, ok := r.combat.Combatants[id]; !ok {
		return
	}
	delete(r.combat.Combatants, id)
	if r.combat.CurrentID == id {
		if order := sortedCombatantIDs(r.combat); len(order) > 0 {
			r.combat.CurrentID = order[0]
		} else {
			r.combat.CurrentID = ""
			r.combat.Active = false
			r.combat.Round = 0
		}
	}
	r.markCombatDirty()
	r.broadcastCombat()
}

func (r *Room) handleSetCombatantInitiative(id string, v float64) {
	cmb, ok := r.combat.Combatants[id]
	if !ok {
		return
	}
	cmb.Initiative = v
	r.markCombatDirty()
	r.broadcastCombat()
}

func (r *Room) handleSetCombatantAC(id string, ac int) {
	cmb, ok := r.combat.Combatants[id]
	if !ok {
		return
	}
	cmb.AC = ac
	r.markCombatDirty()
	r.broadcastCombat()
}

// handleSetCombatantHP — правка HP бойца прямо из трекера (единственное,
// что ДМ там правит вручную числом, не считая ручной инициативы, см.
// требование в плане). cur/max независимо необязательны, оба указателя —
// различаем "не прислали" от "прислали 0". Значения намеренно НЕ зажимаются
// в [0, HPMax]: временный овербафф/переранение поверх максимума — решение
// ДМ по столу, не наше дело валидировать боевую механику (та же философия
// "умного бланка", что и у CharacterSheet/Monster).
//
// Побочные эффекты по правилам (см. план):
//   - HP поднялось выше нуля — боец стабилизировался/подлечен, отметки
//     спасбросков от смерти больше не актуальны, сбрасываем их в ноль; если
//     за ним стоит токен, ранее помеченный Dead (например, ДМ заново
//     добавил в инициативу уже "умершего" монстра/NPC по его токену и
//     проставил HP), снимаем метку — кости на карте меняются обратно на
//     аватарку (см. reviveTokenIfDead).
//   - HP опустилось до нуля или ниже у бойца БЕЗ CharacterID (монстр или
//     голый NPC-токен, см. domain.Combatant) — спасбросков от смерти у них
//     не бывает, умирает сразу (killMonsterCombatant). У бойца С
//     CharacterID (игровой персонаж) вместо этого просто ждём отметок
//     "set_combatant_death_save" — из инициативы его уберёт только 3-й
//     провал (см. handleSetCombatantDeathSave).
func (r *Room) handleSetCombatantHP(id string, cur, max *int) {
	cmb, ok := r.combat.Combatants[id]
	if !ok {
		return
	}
	if max != nil {
		cmb.HPMax = *max
		if cmb.HPMax < 0 {
			cmb.HPMax = 0
		}
	}
	if cur != nil {
		cmb.HPCurrent = *cur
		if cmb.HPCurrent > 0 {
			cmb.DeathSaveSuccess = 0
			cmb.DeathSaveFail = 0
			r.reviveTokenIfDead(cmb.TokenID)
		} else if cmb.CharacterID == "" {
			r.killMonsterCombatant(cmb)
			return // combatant уже удалён и разослан внутри killMonsterCombatant
		}
	}
	r.markCombatDirty()
	r.broadcastCombat()
}

// markTokenDead — если у бойца есть токен на активной сцене, помечает его
// Dead и рассылает сцену. Общая часть между "монстр/NPC умер сразу" (см.
// killMonsterCombatant) и "персонаж провалил 3-й спасбросок от смерти" (см.
// handleSetCombatantDeathSave) — в обоих случаях итог на карте один и тот
// же: кости вместо арта (web/src/vtt/layers/tokens.js). Токен с карты не
// убираем, только помечаем — сам токен остаётся двигаемым.
func (r *Room) markTokenDead(tokenID string) {
	if tokenID == "" {
		return
	}
	t, ok := r.scene.Tokens[tokenID]
	if !ok || t.Dead {
		return
	}
	t.Dead = true
	r.markDirty(r.scene.ID)
	r.broadcastAll()
}

// reviveTokenIfDead — обратная операция: HP бойца снова стало
// положительным (см. handleSetCombatantHP/handleSetCombatantDeathSave) —
// если за ним стоит токен, ранее помеченный Dead, снимаем метку, чтобы
// tokens.js вернул обычный арт вместо костей.
func (r *Room) reviveTokenIfDead(tokenID string) {
	if tokenID == "" {
		return
	}
	t, ok := r.scene.Tokens[tokenID]
	if !ok || !t.Dead {
		return
	}
	t.Dead = false
	r.markDirty(r.scene.ID)
	r.broadcastAll()
}

// snapshotTokenLoot — вызывается ровно один раз, из killMonsterCombatant, в
// момент смерти монстра: КОПИРУЕТ (не ссылается на) текущий
// Monster.Inventory этого монстра в Token.Loot убитого токена, с новыми ID
// на каждую запись. Копия, а не общая ссылка на шаблон — так лутание одного
// трупа не трогает "склад" шаблона бестиария и других уже стоящих на карте
// токенов того же монстра (см. план фичи). monsterID == "" (голый NPC-токен
// без карточки бестиария за спиной) — тихо ничего не делает, лутить нечего.
func (r *Room) snapshotTokenLoot(tokenID, monsterID string) {
	if tokenID == "" || monsterID == "" || r.monsters == nil {
		return
	}
	t, ok := r.scene.Tokens[tokenID]
	if !ok {
		return
	}
	m, err := r.monsters.Get(context.Background(), monsterID)
	if err != nil || len(m.Inventory) == 0 {
		return
	}
	loot := make([]domain.InventoryEntry, len(m.Inventory))
	for i, e := range m.Inventory {
		e.ID = "loot-" + newID()
		loot[i] = e
	}
	t.Loot = loot
	r.markDirty(r.scene.ID)
}

// killMonsterCombatant — HP монстра/безликого NPC (нет CharacterID, см.
// domain.Combatant) опустилось до нуля: по правилам спасбросков от смерти у
// них не бывает, умирает сразу. Убирает бойца из трекера, как
// handleRemoveCombatant, и помечает его токен Dead (markTokenDead) —
// требование "заменить токен на отображение костей".
func (r *Room) killMonsterCombatant(cmb *domain.Combatant) {
	id := cmb.ID
	// Снимок лута ДО markTokenDead: тот сам шлёт broadcastAll (см. его
	// комментарий) — если поставить его раньше, Loot уйдёт клиентам только
	// следующей несвязанной мутацией сцены, а не сразу со смертью токена.
	r.snapshotTokenLoot(cmb.TokenID, cmb.MonsterID)
	r.markTokenDead(cmb.TokenID)
	delete(r.combat.Combatants, id)
	if r.combat.CurrentID == id {
		if order := sortedCombatantIDs(r.combat); len(order) > 0 {
			r.combat.CurrentID = order[0]
		} else {
			r.combat.CurrentID = ""
			r.combat.Active = false
			r.combat.Round = 0
		}
	}
	r.markCombatDirty()
	r.broadcastCombat()
}

// handleSetCombatantDeathSave — "set_combatant_death_save": ДМ вручную
// отмечает чекбоксы спасбросков от смерти прямо в трекере (как в Foundry) —
// сервер сам кубик не кидает, только хранит отметки и разруливает
// последствия. value — абсолютное значение 0-3 (см. domain.ClientMsg).
//
//   - 3 успеха — персонаж стабилизируется и приходит в себя с 1 HP (см.
//     требование), отметки сбрасываются, боец остаётся в инициативе.
//   - 3 провала — персонаж умирает: убираем его из инициативы (требование
//     "если у персонажа провалены спасброски на смерть — убрать из
//     инициативы") и помечаем его токен Dead, как и у монстра (требование
//     "должны появиться такие же кости, как у монстра" — см. markTokenDead).
func (r *Room) handleSetCombatantDeathSave(id, kind string, value int) {
	cmb, ok := r.combat.Combatants[id]
	if !ok {
		return
	}
	if value < 0 {
		value = 0
	} else if value > 3 {
		value = 3
	}
	switch kind {
	case "success":
		cmb.DeathSaveSuccess = value
	case "fail":
		cmb.DeathSaveFail = value
	default:
		return
	}
	if cmb.DeathSaveSuccess >= 3 {
		cmb.HPCurrent = 1
		cmb.DeathSaveSuccess = 0
		cmb.DeathSaveFail = 0
		r.markCombatDirty()
		r.broadcastCombat()
		return
	}
	if cmb.DeathSaveFail >= 3 {
		r.markTokenDead(cmb.TokenID)
		delete(r.combat.Combatants, id)
		if r.combat.CurrentID == id {
			if order := sortedCombatantIDs(r.combat); len(order) > 0 {
				r.combat.CurrentID = order[0]
			} else {
				r.combat.CurrentID = ""
				r.combat.Active = false
				r.combat.Round = 0
			}
		}
	}
	r.markCombatDirty()
	r.broadcastCombat()
}

// handleSetShowHP — "set_show_hp": общий переключатель стола (раздел
// "Настройки" в dm.html/dm.js), видят ли игроки/TV HP в верхнем оверлее
// хода (см. domain.CombatState.ShowHP, combatPayload). ДМ HP там видит
// всегда — это не трогает.
func (r *Room) handleSetShowHP(v bool) {
	r.combat.ShowHP = v
	r.markCombatDirty()
	r.broadcastCombat()
}

// handleSetLootingEnabled — "set_looting_enabled": общий тумблер стола,
// разрешать ли игрокам лутить убитых монстров (см. domain.CombatState.
// LootingEnabled). Персистится в тот же combat.json, что и ShowHP —
// перепроверяется сервером заново в handleLootTakeItem, а не только прячет
// кнопку на клиенте.
func (r *Room) handleSetLootingEnabled(v bool) {
	r.combat.LootingEnabled = v
	r.markCombatDirty()
	r.broadcastCombat()
}

// handlePlaceCombatantToken — "place_combatant_token": ДМ вытащил карточку
// бойца из трекера (см. web/src/combat-panel.js: dragstart на .combat-row,
// pages/dm.js: drop на #scene) на карту. Актуально в первую очередь для
// бойцов, добавленных через "+ Добавить из бестиария" — они сразу попадают
// в инициативу БЕЗ токена на активной сцене (см. handleAddCombatant: путь
// через MonsterID). Токен собирается из уже сохранённого в Combatant
// снимка (имя/арт/цвет/владелец/characterId/monsterId, см. domain.Combatant)
// — клиент присылает только КУДА (TokenX/TokenY) и КОГО (CombatantID).
//
// Если у бойца уже есть токен (TokenID != "") — он был добавлен через ПКМ
// на существующем токене карты, тянуть тут больше нечего, второй токен не
// плодим, молча игнорируем: у одной карточки трекера не может быть больше
// одного токена.
func (r *Room) handlePlaceCombatantToken(id string, x, y float64) {
	cmb, ok := r.combat.Combatants[id]
	if !ok || cmb.TokenID != "" {
		return
	}
	gridSize := r.scene.Grid.Size
	if gridSize <= 0 {
		gridSize = 48
	}
	tokenID := "tok-" + newID()
	if cmb.CharacterID != "" {
		// Тот же инвариант "один персонаж — один токен одновременно", что и
		// у обычного drag&drop персонажа на карту (см. applyMutation:
		// "add_token"/dropDuplicateCharacterTokens).
		r.dropDuplicateCharacterTokens(cmb.CharacterID, tokenID)
	}
	r.scene.Tokens[tokenID] = &domain.Token{
		ID: tokenID, X: x, Y: y, Size: gridSize / 2,
		Label: cmb.Name, Image: cmb.Image, Color: cmb.Color,
		OwnerID: cmb.OwnerID, CharacterID: cmb.CharacterID, MonsterID: cmb.MonsterID,
		// Метки состояний, повешенные на бойца ДО того, как он попал на
		// карту, переезжают на токен — с этого момента источник истины он
		// (см. room_statuses.go), собственный список бойца обнуляем, чтобы
		// не осталось второй копии.
		Statuses: cmb.Statuses,
	}
	cmb.Statuses = nil
	cmb.TokenID = tokenID
	r.markDirty(r.currentSceneID)
	r.markCombatDirty()
	r.broadcastAll()
	r.broadcastCombat()
}

func (r *Room) handleStartCombat() {
	order := sortedCombatantIDs(r.combat)
	if len(order) == 0 {
		return
	}
	r.combat.Active = true
	r.combat.Round = 1
	r.combat.CurrentID = order[0]
	r.markCombatDirty()
	r.broadcastCombat()
}

func (r *Room) handleEndCombat() {
	r.combat.Active = false
	r.combat.Round = 0
	r.combat.CurrentID = ""
	r.markCombatDirty()
	r.broadcastCombat()
}

// handleTurnStep — dir=+1 "next_turn"/-1 "prev_turn". Оборачивается по
// концам списка, продвигая/откатывая счётчик раунда — тот же принцип, что у
// Foundry ("следующий после последнего" начинает новый раунд).
func (r *Room) handleTurnStep(dir int) {
	order := sortedCombatantIDs(r.combat)
	if len(order) == 0 {
		return
	}
	idx := indexOfString(order, r.combat.CurrentID)
	if idx < 0 {
		idx = 0
	} else {
		idx += dir
	}
	if idx >= len(order) {
		idx = 0
		r.combat.Round++
	} else if idx < 0 {
		idx = len(order) - 1
		if r.combat.Round > 1 {
			r.combat.Round--
		}
	}
	// Периодические модификаторы «в конце хода» — тому, чей ход только что
	// закончился, ДО смены текущего бойца (см. room_statuses.go:
	// applyPeriodicModifiers). Только вперёд и только в активном бою: шаг
	// назад — отмена ошибки ДМ, а не течение времени.
	if r.combat.Active && dir > 0 {
		r.applyPeriodicModifiers(r.combat.Combatants[r.combat.CurrentID], domain.ModifierPeriodTurnEnd)
	}

	r.combat.CurrentID = order[idx]

	if r.combat.Active && dir > 0 {
		// Ход перешёл к бойцу: сначала разовый урон/лечение «в начале хода»
		// (горение, регенерация, яд), потом отсчёт длительностей — иначе
		// метка с последним оставшимся раундом успела бы истечь до того, как
		// сработать в свой последний ход.
		//
		// applyPeriodicModifiers может УБИТЬ бойца (тот же путь, что и
		// ручная правка HP в трекере) — тогда он исчезает из r.combat и
		// killMonsterCombatant сам переставляет CurrentID; поэтому дальше
		// работаем по свежему чтению из map, а не по сохранённому указателю.
		r.applyPeriodicModifiers(r.combat.Combatants[r.combat.CurrentID], domain.ModifierPeriodTurnStart)
		if changed, sceneID := r.tickStatuses(r.combat.Combatants[r.combat.CurrentID]); changed {
			// Рассылка сцены нужна лишь если метки лежали на токене и
			// действительно поменялись — combat_state уходит всё равно, ниже.
			if sceneID != "" {
				r.markDirty(sceneID)
				r.broadcastAll()
			}
		}
	}
	r.markCombatDirty()
	r.broadcastCombat()
}

func (r *Room) markCombatDirty() {
	r.combatDirty = true
	r.dirty = true
}

func (r *Room) markHubDirty() {
	r.hubDirty = true
	r.dirty = true
}

// sortedCombatantIDs — порядок ходов: инициатива по убыванию, при равенстве
// раньше добавленный (меньший Seq) идёт первым — детерминированно, в
// отличие от порядка итерации map. Единственное место, где считается
// "порядок инициативы" — и mutating-хендлеры выше, и combatPayload зовут
// именно его, а не кэшированный список, так что ручная правка Initiative
// посреди боя не может разойтись с тем, что видят клиенты.
func sortedCombatantIDs(cs *domain.CombatState) []string {
	ids := make([]string, 0, len(cs.Combatants))
	for id := range cs.Combatants {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		a, b := cs.Combatants[ids[i]], cs.Combatants[ids[j]]
		if a.Initiative != b.Initiative {
			return a.Initiative > b.Initiative
		}
		return a.Seq < b.Seq
	})
	return ids
}

func indexOfString(list []string, v string) int {
	for i, x := range list {
		if x == v {
			return i
		}
	}
	return -1
}

// combatPayload — версия трекера для конкретного клиента: AC/HP правит
// ТОЛЬКО ДМ (см. план) и видит их в трекере всегда — игроки/TV получают тот
// же порядок, имена, арт и инициативу (нужно, чтобы видеть, чей сейчас ход)
// без AC, тем же принципом фильтрации, что sceneFor скрывает hidden-токены
// от не-ДМ. HP/спасброски от смерти для НЕ-ДМ клиентов уходят, только когда
// ДМ включил CombatState.ShowHP в "Настройках" (см. handleSetShowHP) — это
// общий показ в верхнем оверлее (web/src/vtt/combat-bar.js), редактировать
// их игрок всё равно не может (см. Room.authorize). combatants — уже
// отсортированный по инициативе массив (не map), чтобы клиенту не пришлось
// сортировать самому и порядок не "плавал" от особенностей
// JSON-сериализации map в разных браузерах.
func (r *Room) combatPayload(c RoomClient) map[string]any {
	isDM := c.Role() == domain.RoleDM
	order := sortedCombatantIDs(r.combat)
	combatants := make([]map[string]any, 0, len(order))
	for _, id := range order {
		cmb := r.combat.Combatants[id]
		entry := map[string]any{
			"id": cmb.ID, "tokenId": cmb.TokenID, "name": cmb.Name, "image": cmb.Image,
			"color": cmb.Color, "ownerId": cmb.OwnerID, "characterId": cmb.CharacterID,
			"monsterId": cmb.MonsterID, "initiative": cmb.Initiative,
			// statuses — уже разрешённый набор меток (с токена бойца, если
			// токен есть, см. room_statuses.go: statusesOf) и уже без
			// скрытых, если клиент не ДМ. Не секрет сам по себе, в отличие
			// от AC/HP ниже: игроки должны видеть, что вожак напуган.
			"statuses": publicStatuses(r.statusesOf(cmb), isDM),
		}
		if isDM {
			entry["ac"] = cmb.AC
			// acEffective — КД с учётом постоянных модификаторов висящих
			// меток (см. domain.Modifier, room_statuses.go: effectiveStat).
			// Отдельным полем рядом с базовым, а не вместо него: в трекере
			// ДМ правит именно базу, а видеть должен оба числа («14 → 12»).
			entry["acEffective"] = r.effectiveStat(cmb, cmb.AC, domain.ModifierTargetAC)
		}
		if isDM || r.combat.ShowHP {
			entry["hpCurrent"] = cmb.HPCurrent
			entry["hpMax"] = cmb.HPMax
			entry["hpMaxEffective"] = r.effectiveStat(cmb, cmb.HPMax, domain.ModifierTargetHPMax)
			entry["deathSaveSuccess"] = cmb.DeathSaveSuccess
			entry["deathSaveFail"] = cmb.DeathSaveFail
		}
		combatants = append(combatants, entry)
	}
	return map[string]any{
		"type": "combat_state", "active": r.combat.Active, "round": r.combat.Round,
		"currentId": r.combat.CurrentID, "combatants": combatants, "showHp": r.combat.ShowHP,
		"lootingEnabled": r.combat.LootingEnabled,
	}
}

// broadcastCombat шлёт каждому клиенту его версию трекера (см. combatPayload)
// — так же, как broadcastAll делает для сцены.
func (r *Room) broadcastCombat() {
	for c := range r.clients {
		c.Send(r.combatPayload(c))
	}
}

// ================= хаб лута ДМ (domain.LootHub) =================
//
// Живёт вне r.scene (см. Room.hub), не привязан к бою — тот же принцип, что
// и трекер инициативы выше, но без ролевой фильтрации полезной нагрузки:
// содержимое хаба не секрет ни от кого (в отличие от AC/HP в combatPayload).

// maxHubNote/maxHubEntries — те же санитарные пределы, что и у остальных
// сервисов (см. maxMonsterLongText в bestiary.go) — защита от гигантского
// текста/бесконечного разрастания хаба, не игровое правило.
const (
	maxHubNote    = 300
	maxHubEntries = 500
)

// hubPayload — версия хаба для рассылки: массив, отсортированный по ID (не
// map) — тот же приём, что и sortedCombatantIDs/combatPayload, чтобы порядок
// строк на клиенте не плавал от итерации map.
func (r *Room) hubPayload() map[string]any {
	ids := make([]string, 0, len(r.hub.Entries))
	for id := range r.hub.Entries {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	entries := make([]*domain.InventoryEntry, 0, len(ids))
	for _, id := range ids {
		entries = append(entries, r.hub.Entries[id])
	}
	return map[string]any{"type": "hub_state", "entries": entries}
}

// broadcastHub шлёт всем клиентам комнаты текущее содержимое хаба.
func (r *Room) broadcastHub() {
	payload := r.hubPayload()
	for c := range r.clients {
		c.Send(payload)
	}
}

// handleHubAddItem — "hub_add_item" (только ДМ, см. authorize): резолвит
// msg.ItemID через каталог предметов (r.items — сервер не доверяет
// имени/картинке/весу от клиента, те же принцип, что у handleAddCombatant),
// апсертит в r.hub.Entries по ItemID — повторное добавление уже лежащего в
// хабе предмета суммирует количество, а не плодит вторую строку.
func (r *Room) handleHubAddItem(msg domain.ClientMsg) {
	if msg.ItemID == "" || r.items == nil {
		return
	}
	item, err := r.items.Get(context.Background(), msg.ItemID)
	if err != nil {
		return
	}
	qty := 1
	if msg.Quantity != nil && *msg.Quantity > 0 {
		qty = *msg.Quantity
	}
	note := clampRunes(msg.Note, maxHubNote)

	for _, e := range r.hub.Entries {
		if e.ItemID == item.ID {
			e.Quantity += qty
			if note != "" {
				e.Notes = note
			}
			r.markHubDirty()
			r.broadcastHub()
			return
		}
	}
	if len(r.hub.Entries) >= maxHubEntries {
		return
	}
	id := "hub-" + newID()
	r.hub.Entries[id] = &domain.InventoryEntry{
		ID: id, ItemID: item.ID, Name: item.Name, ImageURL: item.ImageURL,
		WeightLb: item.WeightLb, Quantity: qty, Notes: note,
	}
	r.markHubDirty()
	r.broadcastHub()
}

// handleHubRemoveItem — "hub_remove_item" (только ДМ): убирает запись целиком
// (например, ДМ передумал/ошибся) — не то же самое, что "забрали всё" через
// hub_take_item, но итог для хаба одинаковый.
func (r *Room) handleHubRemoveItem(entryID string) {
	if _, ok := r.hub.Entries[entryID]; !ok {
		return
	}
	delete(r.hub.Entries, entryID)
	r.markHubDirty()
	r.broadcastHub()
}

// handleHubSetQuantity — "hub_set_quantity" (только ДМ): ручная правка
// количества конкретной записи хаба (не то, что "взял игрок" —
// hub_take_item), например ДМ поправил ошибку. qty<=0 удаляет запись.
func (r *Room) handleHubSetQuantity(entryID string, qty int) {
	e, ok := r.hub.Entries[entryID]
	if !ok {
		return
	}
	if qty <= 0 {
		delete(r.hub.Entries, entryID)
	} else {
		e.Quantity = qty
	}
	r.markHubDirty()
	r.broadcastHub()
}

// ownedCharacterID — общая проверка для hub_take_item/loot_take_item:
// characterID действительно принадлежит игроку c (сравнение AccountID), иначе
// nil — молча игнорируем команду, тем же принципом недоверия клиенту, что и
// applyOwnTokenMove (нельзя перетащить чужой токен, нельзя начислить лут
// чужому персонажу).
func (r *Room) ownedCharacter(c RoomClient, characterID string) *domain.Character {
	if characterID == "" || r.characters == nil {
		return nil
	}
	ch, err := r.characters.ByID(context.Background(), characterID)
	if err != nil || ch.AccountID != c.PlayerID() {
		return nil
	}
	return ch
}

// handleHubTakeItem — "hub_take_item" (только игрок, см. authorize): берёт
// min(запрошенное, доступное) из записи хаба msg.EntryID в инвентарь СВОЕГО
// (проверено ownedCharacter) персонажа msg.CharacterID, уменьшает/удаляет
// запись хаба.
func (r *Room) handleHubTakeItem(c RoomClient, msg domain.ClientMsg) {
	ch := r.ownedCharacter(c, msg.CharacterID)
	if ch == nil {
		return
	}
	e, ok := r.hub.Entries[msg.EntryID]
	if !ok {
		return
	}
	take := e.Quantity
	if msg.Quantity != nil && *msg.Quantity > 0 && *msg.Quantity < take {
		take = *msg.Quantity
	}
	if take <= 0 {
		return
	}
	entry := *e
	entry.ID = newID()
	entry.Quantity = take
	if _, err := r.characters.AddInventoryEntry(context.Background(), ch.ID, ch.AccountID, entry); err != nil {
		return
	}
	if take >= e.Quantity {
		delete(r.hub.Entries, msg.EntryID)
	} else {
		e.Quantity -= take
	}
	r.markHubDirty()
	r.broadcastHub()
}

// ================= лут убитого монстра прямо с токена (Token.Loot) =================

// handleLootTakeItem — "loot_take_item" (только игрок): требует включённого
// CombatState.LootingEnabled (перепроверяется сервером, а не только прячет
// кнопку на клиенте — см. domain.CombatState.LootingEnabled), находит МЁРТВЫЙ
// токен msg.TokenID на активной сцене, списывает min(запрошенное, доступное)
// из его Loot в инвентарь СВОЕГО (ownedCharacter) персонажа.
func (r *Room) handleLootTakeItem(c RoomClient, msg domain.ClientMsg) {
	if !r.combat.LootingEnabled {
		return
	}
	t, ok := r.scene.Tokens[msg.TokenID]
	if !ok || !t.Dead {
		return
	}
	ch := r.ownedCharacter(c, msg.CharacterID)
	if ch == nil {
		return
	}
	idx := -1
	for i, e := range t.Loot {
		if e.ID == msg.EntryID {
			idx = i
			break
		}
	}
	if idx < 0 {
		return
	}
	e := &t.Loot[idx]
	take := e.Quantity
	if msg.Quantity != nil && *msg.Quantity > 0 && *msg.Quantity < take {
		take = *msg.Quantity
	}
	if take <= 0 {
		return
	}
	entry := *e
	entry.ID = newID()
	entry.Quantity = take
	if _, err := r.characters.AddInventoryEntry(context.Background(), ch.ID, ch.AccountID, entry); err != nil {
		return
	}
	if take >= e.Quantity {
		t.Loot = append(t.Loot[:idx], t.Loot[idx+1:]...)
	} else {
		e.Quantity -= take
	}
	r.markDirty(r.currentSceneID)
	r.broadcastAll()
}

// removeString возвращает копию list без первого вхождения v — используется
// при удалении сцены из sceneOrder.
func removeString(list []string, v string) []string {
	out := make([]string, 0, len(list))
	for _, x := range list {
		if x != v {
			out = append(out, x)
		}
	}
	return out
}

// dropDuplicateCharacterTokens удаляет ЛЮБОЙ другой токен (в любой сцене
// комнаты, не только текущей), уже привязанный к characterID — инвариант
// "один персонаж — один токен одновременно" (см. applyMutation:
// "add_token"/"move_token"). keepTokenID — ID токена, который сейчас
// создаётся/двигается, его не трогаем (иначе move_token уже существующего
// токена удалял бы сам себя, не найдя другого ID с тем же CharacterID).
// Сцены, из которых что-то удалили, помечаются грязными, даже если это не
// текущая активная сцена — иначе правка не переживёт следующий рестарт.
func (r *Room) dropDuplicateCharacterTokens(characterID, keepTokenID string) {
	for sceneID, s := range r.scenes {
		for id, t := range s.Tokens {
			if id == keepTokenID || t.CharacterID != characterID {
				continue
			}
			delete(s.Tokens, id)
			r.markDirty(sceneID)
		}
	}
}

func (r *Room) applyMutation(msg domain.ClientMsg) {
	switch msg.Type {
	case "move_token", "add_token":
		if msg.Token != nil {
			// У персонажа может быть только один токен "на столе"
			// одновременно (см. web/src/pages/dm.js: drag&drop персонажа из
			// панели "Персонажи" на карту) — повторное перетаскивание того
			// же персонажа (в эту же сцену или в другую) переносит его
			// единственный токен, а не плодит дубликаты.
			if msg.Token.CharacterID != "" {
				r.dropDuplicateCharacterTokens(msg.Token.CharacterID, msg.Token.ID)
			}
			r.scene.Tokens[msg.Token.ID] = msg.Token
			r.markDirty(r.currentSceneID)
		}

	case "remove_token":
		delete(r.scene.Tokens, msg.ID)
		r.markDirty(r.currentSceneID)

	case "reveal_token":
		if t, ok := r.scene.Tokens[msg.ID]; ok {
			t.Hidden = false
			r.markDirty(r.currentSceneID)
		}

	case "move_note_marker", "add_note_marker":
		if msg.NoteMarker != nil {
			r.scene.NoteMarkers[msg.NoteMarker.ID] = msg.NoteMarker
			r.markDirty(r.currentSceneID)
		}

	case "remove_note_marker":
		delete(r.scene.NoteMarkers, msg.ID)
		r.markDirty(r.currentSceneID)

	case "add_wall":
		if msg.Wall != nil {
			r.scene.Walls[msg.Wall.ID] = msg.Wall
			r.markDirty(r.currentSceneID)
		}

	case "remove_wall":
		delete(r.scene.Walls, msg.ID)
		r.markDirty(r.currentSceneID)

	// set_wall_door/set_wall_window — классификация уже существующей стены
	// (ДМ-only, см. authorize: оба типа не в списке RolePlayer). Открыть/
	// закрыть/запереть саму дверь — отдельные сообщения ("toggle_door"/
	// "set_door_lock"), см. handleToggleDoor/handleSetDoorLock выше: там
	// нужна ролевая проверка внутри, тут — нет, поэтому эти два кейса живут
	// в общем applyMutation, а не рядом с теми в run().
	case "set_wall_door":
		if w, ok := r.scene.Walls[msg.ID]; ok {
			switch msg.Door {
			case "", "door", "secret":
				w.Door = msg.Door
				if w.Door != "" {
					// Door и Window взаимоисключающие (см. domain.Wall) —
					// назначение двери сбрасывает окно, если оно было.
					w.Window = false
					if w.DoorState == "" {
						w.DoorState = "closed" // дверь всегда стартует закрытой
					}
				} else {
					w.DoorState = "" // вернули обычной стеной — состояние больше не осмысленно
				}
				r.markDirty(r.currentSceneID)
			}
		}

	case "set_wall_window":
		if w, ok := r.scene.Walls[msg.ID]; ok && msg.Window != nil {
			w.Window = *msg.Window
			if w.Window {
				// Window и Door взаимоисключающие — назначение окна сбрасывает дверь.
				w.Door = ""
				w.DoorState = ""
			}
			r.markDirty(r.currentSceneID)
		}

	case "move_wall_point":
		// Один угол может быть общим концом НЕСКОЛЬКИХ стен — двигаем все
		// переданные концы одной мутацией, чтобы угол не "разъезжался" между
		// двумя snapshot'ами.
		for _, ref := range msg.WallPoints {
			w, ok := r.scene.Walls[ref.WallID]
			if !ok {
				continue
			}
			if ref.Which == 1 {
				w.X1, w.Y1 = ref.X, ref.Y
			} else {
				w.X2, w.Y2 = ref.X, ref.Y
			}
		}
		r.markDirty(r.currentSceneID)

	case "split_wall":
		// Вставка точки в середину стены (см. web/src/vtt/interaction.js:
		// splitWallAt) — исходная стена заменяется двумя новыми, стыкующимися
		// в точке вставки; одна мутация вместо remove_wall+add_wall×2, чтобы
		// у остальных клиентов не мелькал момент "стена исчезла".
		if msg.Wall != nil && msg.Wall2 != nil {
			delete(r.scene.Walls, msg.ID)
			r.scene.Walls[msg.Wall.ID] = msg.Wall
			r.scene.Walls[msg.Wall2.ID] = msg.Wall2
			r.markDirty(r.currentSceneID)
		}

	case "remove_wall_point":
		// "удалить точку" = удалить все стены, у которых там конец — одна
		// стена, если конец никем больше не разделён, несколько — если это
		// был угол/T-образное соединение.
		for _, id := range msg.WallIDs {
			delete(r.scene.Walls, id)
		}
		r.markDirty(r.currentSceneID)

	case "add_fog_area":
		if msg.FogArea != nil {
			r.scene.FogAreas[msg.FogArea.ID] = msg.FogArea
			r.markDirty(r.currentSceneID)
		}

	case "remove_fog_area":
		delete(r.scene.FogAreas, msg.ID)
		r.markDirty(r.currentSceneID)

	case "add_building":
		// Контур приходит уже замкнутым по построению клиента (см.
		// web/src/vtt/interaction.js — открытая цепочка на сервер вообще не
		// отправляется), но сервер — источник истины, не доверяет клиенту
		// слепо: < 3 точек не образуют контур ни при каком порядке обхода.
		if msg.Building != nil && len(msg.Building.Points) >= 3 {
			r.scene.Buildings[msg.Building.ID] = msg.Building
			r.markDirty(r.currentSceneID)
		}

	case "remove_building":
		delete(r.scene.Buildings, msg.ID)
		r.markDirty(r.currentSceneID)

	case "set_global_light":
		switch msg.GlobalLight {
		case "", "dim", "bright":
			r.scene.GlobalLight = msg.GlobalLight
			r.markDirty(r.currentSceneID)
		} // любое другое значение — игнорируем, а не падаем на мусоре от клиента

	case "create_scene":
		if msg.SceneID == "" {
			return
		}
		if _, exists := r.scenes[msg.SceneID]; exists {
			return
		}
		name := msg.SceneName
		if name == "" {
			name = "Новая сцена"
		}
		r.scenes[msg.SceneID] = domain.NewScene(msg.SceneID, name)
		r.sceneOrder = append(r.sceneOrder, msg.SceneID)
		r.markDirty(msg.SceneID)

	case "rename_scene":
		if s, ok := r.scenes[msg.SceneID]; ok && msg.SceneName != "" {
			s.Name = msg.SceneName
			r.markDirty(msg.SceneID)
		}

	case "delete_scene":
		if len(r.scenes) <= 1 {
			return // нельзя удалить последнюю сцену комнаты
		}
		if _, ok := r.scenes[msg.SceneID]; !ok {
			return
		}
		delete(r.scenes, msg.SceneID)
		r.sceneOrder = removeString(r.sceneOrder, msg.SceneID)
		delete(r.dirtyScenes, msg.SceneID)
		if err := r.store.DeleteScene(context.Background(), msg.SceneID); err != nil {
			log.Println("не удалось удалить файл сцены:", msg.SceneID, err)
		}
		if r.currentSceneID == msg.SceneID {
			nextID := ""
			if len(r.sceneOrder) > 0 {
				nextID = r.sceneOrder[0]
			} else {
				for id := range r.scenes { // защитный код, не должен случаться из-за guard выше
					nextID = id
					break
				}
			}
			r.currentSceneID = nextID
			r.scene = r.scenes[nextID]
			r.markDirty(nextID) // метаданные (currentSceneId) точно поменялись
		}

	case "switch_scene":
		if s, ok := r.scenes[msg.SceneID]; ok {
			r.currentSceneID = msg.SceneID
			r.scene = s
			r.dirty = true                                // метаданные (currentSceneId) поменялись, даже если сама сцена — нет
			r.ambientStartedAtMs = time.Now().UnixMilli() // новая активная сцена — амбиент (если есть) стартует заново у всех
			r.mapStartedAtMs = time.Now().UnixMilli()     // и видео-фон (если есть) — аналогично
		}

	case "update_scene":
		s, ok := r.scenes[msg.SceneID]
		if !ok {
			return
		}
		oldW, oldH := s.Width, s.Height
		oldAmbient := s.AmbientURL
		oldMapURL := s.MapURL
		if msg.SceneName != "" {
			s.Name = msg.SceneName
		}
		s.MapURL = msg.MapURL
		if msg.Width > 0 {
			s.Width = msg.Width
		}
		if msg.Height > 0 {
			s.Height = msg.Height
		}
		fogOfWar := msg.FogOfWar
		s.FogOfWar = &fogOfWar
		if msg.Grid != nil {
			s.Grid = *msg.Grid
		}
		s.AmbientURL = msg.AmbientURL
		s.AmbientVolume = msg.AmbientVolume
		if oldW > 0 && oldH > 0 && (s.Width != oldW || s.Height != oldH) {
			s.RescaleGeometry(oldW, oldH)
		}
		// Правка не связанных с музыкой полей (имя, сетка, размер) не должна
		// перематывать трек всем на середине — рестартуем ambientStartedAtMs
		// только если реально сменился трек этой (и она же активная) сцены.
		if s.AmbientURL != oldAmbient && s.ID == r.currentSceneID {
			r.ambientStartedAtMs = time.Now().UnixMilli()
		}
		// То же самое для видео-фона: рестартуем позицию только если реально
		// сменился MapURL активной сцены, а не любая правка (иначе, например,
		// перетаскивание сетки — оно тоже шлёт update_scene — дёргало бы
		// анимацию на середине у всех).
		if s.MapURL != oldMapURL && s.ID == r.currentSceneID {
			r.mapStartedAtMs = time.Now().UnixMilli()
		}
		r.markDirty(msg.SceneID)
	}
}

// DecodeClientMsg разбирает сырое WS-сообщение в domain.ClientMsg. Вынесено
// сюда (а не оставлено голым json.Unmarshal в api/ws), чтобы формат
// сообщений оставался знанием service-слоя: транспорт лишь передаёт байты и
// зовёт Dispatch.
func DecodeClientMsg(raw []byte) (domain.ClientMsg, error) {
	var msg domain.ClientMsg
	err := json.Unmarshal(raw, &msg)
	return msg, err
}
