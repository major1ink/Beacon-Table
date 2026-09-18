package service

import (
	"testing"

	"beacon-table/internal/domain"
)

// Тесты собирают *Room напрямую, как в room_drawings_test.go.

// sfxClient — RoomClient, запоминающий всё, что ему прислали: проверяем,
// долетел ли audio_sfx.
type sfxClient struct {
	role domain.ClientRole
	got  []map[string]any
}

func (c *sfxClient) Send(payload any) {
	if m, ok := payload.(map[string]any); ok {
		c.got = append(c.got, m)
	}
}
func (c *sfxClient) Close()                  {}
func (c *sfxClient) Role() domain.ClientRole { return c.role }
func (c *sfxClient) PlayerID() string        { return "" }
func (c *sfxClient) PlayerName() string      { return "" }

func (c *sfxClient) sfxURLs() []string {
	var out []string
	for _, m := range c.got {
		if m["type"] == "audio_sfx" {
			out = append(out, m["sfx"].(*domain.SfxEvent).URL)
		}
	}
	return out
}

func sfxRoom(tv *sfxClient) *Room {
	r := drawingsRoom()
	r.clients[tv] = true
	r.scene.Walls["d1"] = &domain.Wall{ID: "d1", Door: "door", DoorState: "closed"}
	return r
}

func TestDoorSoundFallsBackToScene(t *testing.T) {
	tv := &sfxClient{role: domain.RoleTV}
	r := sfxRoom(tv)

	r.handleToggleDoor(playerClient, domain.ClientMsg{ID: "d1"})
	if got := tv.sfxURLs(); len(got) != 0 {
		t.Fatalf("дверь без звука зазвучала: %v", got)
	}

	r.scene.DoorSoundURL = "/uploads/audio/creak.mp3"
	r.handleToggleDoor(playerClient, domain.ClientMsg{ID: "d1"})
	if got := tv.sfxURLs(); len(got) != 1 || got[0] != "/uploads/audio/creak.mp3" {
		t.Fatalf("звук сцены не долетел: %v", got)
	}

	r.scene.Walls["d1"].DoorSound = "/uploads/audio/iron.mp3"
	r.handleToggleDoor(playerClient, domain.ClientMsg{ID: "d1"})
	if got := tv.sfxURLs(); len(got) != 2 || got[1] != "/uploads/audio/iron.mp3" {
		t.Fatalf("звук двери не перекрыл звук сцены: %v", got)
	}
}

func TestLockedDoorStaysSilentForPlayer(t *testing.T) {
	tv := &sfxClient{role: domain.RoleTV}
	r := sfxRoom(tv)
	r.scene.DoorSoundURL = "/uploads/audio/creak.mp3"
	r.scene.Walls["d1"].DoorState = "locked"

	r.handleToggleDoor(playerClient, domain.ClientMsg{ID: "d1"})
	if got := tv.sfxURLs(); len(got) != 0 {
		t.Fatalf("запертая дверь зазвучала от игрока: %v", got)
	}
}

func TestBroadcastSfxClampsVolume(t *testing.T) {
	tv := &sfxClient{role: domain.RoleTV}
	r := sfxRoom(tv)

	r.broadcastSfx("  ", "пусто", 1)
	r.broadcastSfx("/uploads/audio/thunder.mp3", "гром", 0)
	if len(tv.got) != 1 {
		t.Fatalf("ожидалось одно событие, пришло %d", len(tv.got))
	}
	ev := tv.got[0]["sfx"].(*domain.SfxEvent)
	if ev.Name != "гром" || ev.Volume != 0.8 {
		t.Fatalf("событие: %+v", ev)
	}
}

func TestBroadcastSfxStop(t *testing.T) {
	tv := &sfxClient{role: domain.RoleTV}
	r := sfxRoom(tv)
	r.broadcastSfxStop()
	if len(tv.got) != 1 || tv.got[0]["type"] != "audio_sfx_stop" {
		t.Fatalf("audio_sfx_stop не долетел: %v", tv.got)
	}
}
