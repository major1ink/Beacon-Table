package http

import (
	"encoding/json"
	"net/http"
	"sort"
	"sync"
	"time"
)

// Журнал экранов трансляции для отчёта о баге. Хранится в памяти.
const (
	maxDiagScreens = 8
	maxDiagErrors  = 12
	maxDiagText    = 600
	maxDiagInfo    = 24
)

// diagScreen описывает один экран: адрес и браузер.
type diagScreen struct {
	Addr      string            `json:"addr"`
	UserAgent string            `json:"userAgent"`
	FirstSeen time.Time         `json:"firstSeen"`
	LastSeen  time.Time         `json:"lastSeen"`
	Loads     int               `json:"loads"`
	Started   bool              `json:"started"`
	TimedOut  bool              `json:"timedOut"`
	Info      map[string]string `json:"info,omitempty"`
	Errors    []string          `json:"errors,omitempty"`
}

type broadcastDiag struct {
	mu      sync.Mutex
	screens []*diagScreen
}

// clip обрезает строку до n байт, не разрывая символ.
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && s[n]&0xC0 == 0x80 {
		n--
	}
	return s[:n] + "…"
}

// screen возвращает запись экрана, при необходимости создаёт новую. Вызывать под mu.
func (d *broadcastDiag) screen(addr, ua string, now time.Time) *diagScreen {
	ua = clip(ua, maxDiagText)
	for _, s := range d.screens {
		if s.Addr == addr && s.UserAgent == ua {
			s.LastSeen = now
			return s
		}
	}
	s := &diagScreen{Addr: addr, UserAgent: ua, FirstSeen: now, LastSeen: now}
	if len(d.screens) >= maxDiagScreens {
		oldest := 0
		for i, x := range d.screens {
			if x.LastSeen.Before(d.screens[oldest].LastSeen) {
				oldest = i
			}
		}
		d.screens = append(d.screens[:oldest], d.screens[oldest+1:]...)
	}
	d.screens = append(d.screens, s)
	return s
}

// pageLoaded запоминает загрузку страницы трансляции.
func (d *broadcastDiag) pageLoaded(addr, ua string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	s := d.screen(addr, ua, time.Now())
	s.Loads++
	s.Started = false
	s.TimedOut = false
}

// diagEvent — сообщение от страницы трансляции (web/public/broadcast-guard.js).
type diagEvent struct {
	Kind    string            `json:"kind"`
	Message string            `json:"message"`
	Info    map[string]string `json:"info"`
}

func (d *broadcastDiag) record(addr, ua string, ev diagEvent) {
	d.mu.Lock()
	defer d.mu.Unlock()
	s := d.screen(addr, ua, time.Now())
	switch ev.Kind {
	case "page", "info":
		if s.Info == nil {
			s.Info = make(map[string]string, len(ev.Info))
		}
		for k, v := range ev.Info {
			if _, ok := s.Info[k]; !ok && len(s.Info) >= maxDiagInfo {
				continue
			}
			s.Info[clip(k, 32)] = clip(v, 200)
		}
	case "started":
		s.Started = true
	case "timeout":
		s.TimedOut = true
	case "error":
		if ev.Message == "" {
			return
		}
		s.Errors = append(s.Errors, time.Now().Format("15:04:05")+" "+clip(ev.Message, maxDiagText))
		if len(s.Errors) > maxDiagErrors {
			s.Errors = s.Errors[len(s.Errors)-maxDiagErrors:]
		}
	}
}

func (d *broadcastDiag) list() []diagScreen {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]diagScreen, 0, len(d.screens))
	for _, s := range d.screens {
		c := *s
		c.Info = make(map[string]string, len(s.Info))
		for k, v := range s.Info {
			c.Info[k] = v
		}
		c.Errors = append([]string(nil), s.Errors...)
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].LastSeen.After(out[j].LastSeen) })
	return out
}

// handleBroadcastDiagPost — POST /api/broadcast/diag: сведения о браузере и ошибки экрана.
// Без авторизации: экран ещё не пущен.
func (a *API) handleBroadcastDiagPost(w http.ResponseWriter, r *http.Request) {
	var ev diagEvent
	if err := json.NewDecoder(r.Body).Decode(&ev); err != nil {
		writeErr(w, http.StatusBadRequest, "неверный формат")
		return
	}
	a.broadcastDiag.record(clientAddr(r), r.UserAgent(), ev)
	w.WriteHeader(http.StatusNoContent)
}

// handleBroadcastDiagList — GET /api/broadcast/diag (только ДМ): журнал экранов.
func (a *API) handleBroadcastDiagList(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireOwner(w, r); !ok {
		return
	}
	writeJSON(w, http.StatusOK, a.broadcastDiag.list())
}
