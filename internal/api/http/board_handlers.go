package http

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path"
	"strings"
	"time"

	"beacon-table/internal/domain"
	"beacon-table/internal/excalidraw"
	"beacon-table/internal/service"
)

// maxBoardUpload — потолок тела запроса на импорт доски
const maxBoardUpload = 16 << 20

// ---- доски стола (см. internal/service/boards.go,
// internal/repository/boardfile) ----
//
// Как и журнал, а в отличие от заметок ДМ, сюда ходят и игроки: гейт —
// обычный requireAccount, а кто что может с конкретной доской, решает
// BoardService по domain.JournalViewer. Список аккаунтов для раздачи прав
// отдельным хендлером не заводится — он общий с журналом
// (GET /api/journal/members).

// boardJSON — доска как её видит ЭТОТ аккаунт. Кроме полей самой доски
// отдаёт вычисленные права (myAccess/canEdit/canManage): иначе клиенту
// пришлось бы повторять у себя всю логику domain.Sharing.AccessFor, а два
// источника правды о правах — ровно то, чего не хочется.
//
// Раздачу прав (access) видит только тот, кто ими и распоряжается (автор и
// ДМ) — остальным незачем знать, кому ещё автор открыл свою доску.
func boardJSON(b *domain.Board, v domain.JournalViewer) map[string]any {
	out := map[string]any{
		"id":        b.ID,
		"name":      b.Name,
		"ownerId":   b.OwnerID,
		"ownerName": b.OwnerName,
		"default":   string(b.Default),
		"shared":    b.IsShared(),
		"myAccess":  string(b.AccessFor(v)),
		"canEdit":   b.CanEdit(v),
		"canManage": b.CanManage(v),
		"updatedAt": b.UpdatedAt.Format(time.RFC3339),
	}
	if b.CanManage(v) {
		access := make(map[string]string, len(b.Access))
		for id, level := range b.Access {
			access[id] = string(level)
		}
		out["access"] = access
	}
	return out
}

// writeBoardErr — разбор ошибок сервиса досок. Отдельно от writeJournalErr
// только ради текста «доска не найдена» вместо «запись журнала не найдена».
func writeBoardErr(w http.ResponseWriter, err error) {
	var verr *domain.ValidationError
	switch {
	case errors.As(err, &verr):
		writeErr(w, http.StatusBadRequest, verr.Msg)
	case errors.Is(err, domain.ErrNotFound):
		writeErr(w, http.StatusNotFound, "доска не найдена")
	case errors.Is(err, domain.ErrForbidden):
		writeErr(w, http.StatusForbidden, "недостаточно прав на эту доску")
	default:
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
	}
}

func (a *API) handleBoardList(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	v := journalViewer(acc)
	boards, err := world.Boards.List(r.Context(), v)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка сервера")
		return
	}
	out := make([]map[string]any, 0, len(boards))
	for _, b := range boards {
		out = append(out, boardJSON(b, v))
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *API) handleBoardCreate(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	var req struct {
		Name    string            `json:"name"`
		Default string            `json:"default"`
		Access  map[string]string `json:"access"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	v := journalViewer(acc)
	b, err := world.Boards.Create(r.Context(), v, service.BoardDraft{
		Name:    req.Name,
		Default: domain.JournalAccess(req.Default),
		Access:  accessMap(req.Access),
	})
	if err != nil {
		writeBoardErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, boardJSON(b, v))
}

// handleBoardImport — доска из файла Excalidraw: .excalidraw.md из ваулта
// Obsidian либо голый .excalidraw. Имя берётся из поля формы, а если его нет
// — из имени файла.
func (a *API) handleBoardImport(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBoardUpload)
	//nolint:gosec // G120: тело уже ограничено MaxBytesReader выше
	if err := r.ParseMultipartForm(multipartMemoryBudget); err != nil {
		writeErr(w, http.StatusBadRequest, "файл слишком большой")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "нет файла")
		return
	}
	defer file.Close()

	raw, err := io.ReadAll(file)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "не удалось прочитать файл")
		return
	}

	name := strings.TrimSpace(r.FormValue("name"))
	if name == "" && header != nil {
		name = boardNameFromFile(header.Filename)
	}

	v := journalViewer(acc)
	b, err := world.Boards.Import(r.Context(), v, name, raw)
	if err != nil {
		writeBoardErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, boardJSON(b, v))
}

// boardNameFromFile — «Сессия 55.excalidraw.md» -> «Сессия 55». Обрезаются
// оба расширения: у плагина файл называется именно так, и оставлять
// «.excalidraw» в названии доски незачем.
func boardNameFromFile(filename string) string {
	name := path.Base(strings.ReplaceAll(filename, "\\", "/"))
	name = strings.TrimSuffix(name, ".md")
	name = strings.TrimSuffix(name, ".excalidraw")
	return strings.TrimSpace(name)
}

// handleBoardScene — сам холст доски. Отдельно от handleBoardGet: список и
// шапку клиент читает часто, а рисунок — только когда доску открыли.
func (a *API) handleBoardScene(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	doc, err := world.Boards.Scene(r.Context(), journalViewer(acc), r.PathValue("id"))
	if err != nil {
		writeBoardErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, doc.Scene)
}

// handleBoardSceneSave — запись холста. Тело — сцена Excalidraw ровно в том
// виде, в каком её отдаёт редактор (см. serializeAsJSON в
// web/src/board/editor.js).
func (a *API) handleBoardSceneSave(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBoardUpload)
	var scene excalidraw.Scene
	if err := json.NewDecoder(r.Body).Decode(&scene); err != nil {
		writeErr(w, http.StatusBadRequest, "не удалось разобрать холст")
		return
	}
	if err := world.Boards.SaveScene(r.Context(), journalViewer(acc), r.PathValue("id"), &scene); err != nil {
		writeBoardErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) handleBoardGet(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	v := journalViewer(acc)
	b, err := world.Boards.Get(r.Context(), v, r.PathValue("id"))
	if err != nil {
		writeBoardErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, boardJSON(b, v))
}

func (a *API) handleBoardRename(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	v := journalViewer(acc)
	b, err := world.Boards.Rename(r.Context(), v, r.PathValue("id"), req.Name)
	if err != nil {
		writeBoardErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, boardJSON(b, v))
}

func (a *API) handleBoardAccess(w http.ResponseWriter, r *http.Request) {
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
	b, err := world.Boards.SetAccess(r.Context(), v, r.PathValue("id"), domain.JournalAccess(req.Default), accessMap(req.Access))
	if err != nil {
		writeBoardErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, boardJSON(b, v))
}

func (a *API) handleBoardDelete(w http.ResponseWriter, r *http.Request) {
	acc, ok := a.requireAccount(w, r)
	if !ok {
		return
	}
	world, ok := a.requireWorld(w)
	if !ok {
		return
	}
	if err := world.Boards.Delete(r.Context(), journalViewer(acc), r.PathValue("id")); err != nil {
		writeBoardErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
