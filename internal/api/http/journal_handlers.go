package http

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"beacon-table/internal/app"
	"beacon-table/internal/domain"
	"beacon-table/internal/service"
)

// ---- журнал стола (см. internal/service/journal.go,
// internal/repository/journalfile) ----
//
// В отличие от заметок ДМ (note_handlers.go, requireAdminAccount на каждом
// хендлере), сюда ходят и игроки: гейт — обычный requireAccount, а кто что
// может внутри журнала, решает JournalService по domain.JournalViewer.

// notifyJournal — разослать всем за столом «журнал изменился» после
// успешной мутации (см. RoomService.NotifyJournalChanged). Иначе чужая
// запись появлялась бы у остальных только после перезагрузки страницы:
// окно журнала читает список по HTTP один раз при открытии.
func notifyJournal(world *app.ActiveWorld, id string) {
	world.Room.NotifyJournalChanged(id)
}

func journalViewer(acc *domain.Account) domain.JournalViewer {
	return domain.JournalViewer{ID: acc.ID, Name: acc.Username, IsDM: acc.IsGM()}
}

// journalJSON — запись как её видит ЭТОТ аккаунт. Кроме самих полей записи
// отдаёт вычисленные права (myAccess/canEdit/canManage): клиенту иначе
// пришлось бы повторять у себя всю логику domain.JournalEntry.AccessFor, а
// два источника правды о правах — ровно то, чего не хочется.
//
// Раздачу прав (access) видит только тот, кто ими и распоряжается (автор и
// ДМ) — остальным незачем знать, кому ещё автор открыл свою запись.
func journalJSON(e *domain.JournalEntry, v domain.JournalViewer) map[string]any {
	out := map[string]any{
		"id":        e.ID,
		"title":     e.Title,
		"folder":    e.Folder,
		"content":   e.Content,
		"ownerId":   e.OwnerID,
		"ownerName": e.OwnerName,
		"default":   string(e.Default),
		"shared":    e.IsShared(),
		"myAccess":  string(e.AccessFor(v)),
		"canEdit":   e.CanEdit(v),
		"canManage": e.CanManage(v),
		"updatedAt": e.UpdatedAt.Format(time.RFC3339),
	}
	if e.CanManage(v) {
		access := make(map[string]string, len(e.Access))
		for id, level := range e.Access {
			access[id] = string(level)
		}
		out["access"] = access
	}
	return out
}

func journalListJSON(e *domain.JournalEntry, v domain.JournalViewer) map[string]any {
	out := journalJSON(e, v)
	delete(out, "content") // список — без текста (см. JournalRepository.List)
	return out
}

// writeJournalErr — общий разбор ошибок сервиса журнала: «не найдено» и
// «нет прав» приезжают отсюда чаще, чем откуда-либо ещё (это единственная
// библиотека стола с правами на каждую запись).
func writeJournalErr(w http.ResponseWriter, err error) {
	var verr *domain.ValidationError
	switch {
	case errors.As(err, &verr):
		writeErr(w, http.StatusBadRequest, verr.Msg)
	case errors.Is(err, domain.ErrNotFound):
		writeErr(w, http.StatusNotFound, "запись журнала не найдена")
	case errors.Is(err, domain.ErrForbidden):
		writeErr(w, http.StatusForbidden, "недостаточно прав на эту запись")
	default:
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
	}
}

// accessMap — раздача прав из тела запроса. JSON-строки уровней
// (domain.JournalAccess) проверяет уже сервис, тут только распаковка.
func accessMap(raw map[string]string) map[string]domain.JournalAccess {
	out := make(map[string]domain.JournalAccess, len(raw))
	for id, level := range raw {
		out[id] = domain.JournalAccess(level)
	}
	return out
}

func (a *API) handleJournalList(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	v := journalViewer(acc)
	entries, err := world.Journal.List(r.Context(), v)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	out := make([]map[string]any, 0, len(entries))
	for _, e := range entries {
		out = append(out, journalListJSON(e, v))
	}
	writeJSON(w, http.StatusOK, out)
}

// handleJournalMembers — кому вообще можно раздать права: аккаунты этого
// мира (id + имя, ничего больше). Доступно не только ДМ, потому что права
// раздаёт автор записи, а он игрок — как и в Foundry, где список
// пользователей стола видят все.
func (a *API) handleJournalMembers(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	accounts, err := world.Admin.ListAccounts(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	out := make([]map[string]any, 0, len(accounts))
	for _, acc := range accounts {
		if !acc.IsActive() {
			continue // ещё не одобренному ДМ аккаунту нечего выдавать
		}
		out = append(out, map[string]any{"id": acc.ID, "username": acc.Username})
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *API) handleJournalCreate(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	var req struct {
		Content string            `json:"content"`
		Folder  string            `json:"folder"`
		Default string            `json:"default"`
		Access  map[string]string `json:"access"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	v := journalViewer(acc)
	e, err := world.Journal.Create(r.Context(), v, service.JournalDraft{
		Folder:  req.Folder,
		Content: req.Content,
		Default: domain.JournalAccess(req.Default),
		Access:  accessMap(req.Access),
	})
	if err != nil {
		writeJournalErr(w, err)
		return
	}
	notifyJournal(world, e.ID)
	writeJSON(w, http.StatusCreated, journalJSON(e, v))
}

func (a *API) handleJournalGet(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	v := journalViewer(acc)
	e, err := world.Journal.Get(r.Context(), v, r.PathValue("id"))
	if err != nil {
		writeJournalErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, journalJSON(e, v))
}

func (a *API) handleJournalUpdate(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	var req struct{ Content string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	v := journalViewer(acc)
	e, err := world.Journal.Update(r.Context(), v, r.PathValue("id"), req.Content)
	if err != nil {
		writeJournalErr(w, err)
		return
	}
	notifyJournal(world, e.ID)
	writeJSON(w, http.StatusOK, journalJSON(e, v))
}

// handleJournalAccess — «кому видно и кому можно править». Отдельный
// эндпоинт от PUT /api/journal/{id}: текст автосейвится по таймеру при
// наборе (см. web/src/pages/journal.js), права меняются осознанным
// действием в диалоге — см. repository.JournalRepository.SetAccess.
func (a *API) handleJournalAccess(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	var req struct {
		Default string            `json:"default"`
		Access  map[string]string `json:"access"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	v := journalViewer(acc)
	e, err := world.Journal.SetAccess(r.Context(), v, r.PathValue("id"), domain.JournalAccess(req.Default), accessMap(req.Access))
	if err != nil {
		writeJournalErr(w, err)
		return
	}
	notifyJournal(world, e.ID)
	writeJSON(w, http.StatusOK, journalJSON(e, v))
}

func (a *API) handleJournalMove(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	var req struct{ Folder string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	v := journalViewer(acc)
	e, err := world.Journal.Move(r.Context(), v, r.PathValue("id"), req.Folder)
	if err != nil {
		writeJournalErr(w, err)
		return
	}
	notifyJournal(world, e.ID)
	writeJSON(w, http.StatusOK, journalJSON(e, v))
}

func (a *API) handleJournalDelete(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	if err := world.Journal.Delete(r.Context(), journalViewer(acc), r.PathValue("id")); err != nil {
		writeJournalErr(w, err)
		return
	}
	notifyJournal(world, r.PathValue("id"))
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// ---- папки журнала (общее дерево на весь стол, см. JournalService.Folders) ----

func (a *API) handleJournalFoldersList(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAccount(w, r); !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	folders, err := world.Journal.Folders(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	writeJSON(w, http.StatusOK, folders)
}

func (a *API) handleJournalFolderCreate(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	var req struct{ Folder string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	if err := world.Journal.CreateFolder(r.Context(), journalViewer(acc), req.Folder); err != nil {
		writeJournalErr(w, err)
		return
	}
	notifyJournal(world, "") // менялось дерево папок, а не конкретная запись
	writeJSON(w, http.StatusCreated, map[string]string{"status": "ok"})
}

func (a *API) handleJournalFolderRename(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	var req struct{ From, To string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	if err := world.Journal.RenameFolder(r.Context(), journalViewer(acc), req.From, req.To); err != nil {
		writeJournalErr(w, err)
		return
	}
	notifyJournal(world, "")
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (a *API) handleJournalFolderDelete(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	if err := world.Journal.DeleteFolder(r.Context(), journalViewer(acc), r.URL.Query().Get("folder")); err != nil {
		writeJournalErr(w, err)
		return
	}
	notifyJournal(world, "")
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
