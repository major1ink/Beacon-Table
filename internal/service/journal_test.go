package service

import (
	"context"
	"errors"
	"testing"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository/journalfile"
)

// Права журнала — единственная авторизация, которая живёт в service-слое
// (HTTP знает только "admin/не admin", см. journal_handlers.go), поэтому
// проверяем именно её: кто что видит, читает, правит и раздаёт.

func newTestJournal(t *testing.T) JournalService {
	t.Helper()
	return NewJournalService(journalfile.NewStore(t.TempDir()))
}

var (
	gwen = domain.JournalViewer{ID: "acc-gwen", Name: "Гвен"}
	tom  = domain.JournalViewer{ID: "acc-tom", Name: "Том"}
	dm   = domain.JournalViewer{ID: "acc-dm", Name: "ДМ", IsDM: true}
)

func TestJournalPrivateEntryIsInvisibleToOthersButNotToDM(t *testing.T) {
	ctx := context.Background()
	svc := newTestJournal(t)

	e, err := svc.Create(ctx, gwen, JournalDraft{Content: "# Мой секрет\n", Default: domain.JournalNone})
	if err != nil {
		t.Fatal(err)
	}
	if e.OwnerID != gwen.ID || e.OwnerName != "Гвен" {
		t.Fatalf("автор не проставился: %+v", e)
	}

	// Чужой игрок: записи как будто нет — и в списке, и по прямому id.
	list, err := svc.List(ctx, tom)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 0 {
		t.Fatalf("чужая приватная запись видна игроку: %+v", list)
	}
	if _, err := svc.Get(ctx, tom, e.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("Get чужой приватной: %v, ожидали ErrNotFound", err)
	}

	// ДМ читает всё (требование «ДМ может видеть и читать этот журнал»).
	got, err := svc.Get(ctx, dm, e.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Content != "# Мой секрет\n" {
		t.Fatalf("ДМ не увидел текст: %q", got.Content)
	}
	dmList, err := svc.List(ctx, dm)
	if err != nil || len(dmList) != 1 {
		t.Fatalf("список ДМ: %d записей, err=%v", len(dmList), err)
	}
}

func TestJournalLimitedSeesTitleWithoutContent(t *testing.T) {
	ctx := context.Background()
	svc := newTestJournal(t)
	e, err := svc.Create(ctx, gwen, JournalDraft{
		Content: "# Слухи\n\nтекст\n",
		Default: domain.JournalNone,
		Access:  map[string]domain.JournalAccess{tom.ID: domain.JournalLimited},
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := svc.Get(ctx, tom, e.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "Слухи" {
		t.Fatalf("заголовок не виден: %+v", got)
	}
	if got.Content != "" {
		t.Fatalf("limited увидел текст: %q", got.Content)
	}
	if _, err := svc.Update(ctx, tom, e.ID, "# Подмена\n"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("limited смог править: %v", err)
	}
}

func TestJournalSharedEntryReadableByEveryone(t *testing.T) {
	ctx := context.Background()
	svc := newTestJournal(t)
	// Общий журнал — это Default >= observer (см. domain.JournalEntry.IsShared):
	// так ДМ «быстро скидывает» заметку всему столу.
	e, err := svc.Create(ctx, dm, JournalDraft{Content: "# Объявление\n\nвсем\n", Default: domain.JournalObserver})
	if err != nil {
		t.Fatal(err)
	}
	if !e.IsShared() {
		t.Fatal("запись с default=observer должна считаться общей")
	}
	got, err := svc.Get(ctx, tom, e.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Content == "" {
		t.Fatal("общую запись игрок не прочитал")
	}
	if _, err := svc.Update(ctx, tom, e.ID, "# Подмена\n"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("observer смог править общую запись: %v", err)
	}
}

func TestJournalGrantedOwnerCanEditButNotManage(t *testing.T) {
	ctx := context.Background()
	svc := newTestJournal(t)
	e, err := svc.Create(ctx, gwen, JournalDraft{
		Content: "# Совместная\n",
		Default: domain.JournalNone,
		Access:  map[string]domain.JournalAccess{tom.ID: domain.JournalOwner},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Update(ctx, tom, e.ID, "# Дописал\n"); err != nil {
		t.Fatalf("выданный owner не смог править: %v", err)
	}
	// Но «дал поправить» ≠ «дал раздавать ключи» и ≠ «дал удалить».
	if _, err := svc.SetAccess(ctx, tom, e.ID, domain.JournalObserver, nil); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("выданный owner переписал права: %v", err)
	}
	if err := svc.Delete(ctx, tom, e.ID); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("выданный owner удалил чужую запись: %v", err)
	}
	if err := svc.Delete(ctx, gwen, e.ID); err != nil {
		t.Fatalf("автор не смог удалить свою запись: %v", err)
	}
}

func TestJournalSetAccessKeepsContent(t *testing.T) {
	ctx := context.Background()
	svc := newTestJournal(t)
	e, err := svc.Create(ctx, gwen, JournalDraft{Content: "# Текст\n", Default: domain.JournalNone})
	if err != nil {
		t.Fatal(err)
	}
	updated, err := svc.SetAccess(ctx, gwen, e.ID, domain.JournalObserver, map[string]domain.JournalAccess{tom.ID: domain.JournalOwner})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Content != "# Текст\n" {
		t.Fatalf("смена прав съела текст: %q", updated.Content)
	}
	if !updated.IsShared() || updated.Access[tom.ID] != domain.JournalOwner {
		t.Fatalf("права не применились: %+v", updated)
	}
}

func TestJournalRejectsUnknownAccessLevel(t *testing.T) {
	ctx := context.Background()
	svc := newTestJournal(t)
	if _, err := svc.Create(ctx, gwen, JournalDraft{Content: "# Х\n", Default: "everyone"}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("неизвестный уровень по умолчанию принят: %v", err)
	}
	if _, err := svc.Create(ctx, gwen, JournalDraft{Content: "# Х\n", Access: map[string]domain.JournalAccess{tom.ID: "read"}}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("неизвестный персональный уровень принят: %v", err)
	}
}

func TestJournalFolderRulesForPlayers(t *testing.T) {
	ctx := context.Background()
	svc := newTestJournal(t)
	if err := svc.CreateFolder(ctx, gwen, "Дневник Гвен"); err != nil {
		t.Fatalf("игрок не смог завести свою папку: %v", err)
	}
	if _, err := svc.Create(ctx, gwen, JournalDraft{Folder: "Дневник Гвен", Content: "# День 1\n"}); err != nil {
		t.Fatal(err)
	}
	if err := svc.DeleteFolder(ctx, gwen, "Дневник Гвен"); err != nil {
		t.Fatalf("игрок не смог удалить папку только со своими записями: %v", err)
	}

	if _, err := svc.Create(ctx, dm, JournalDraft{Folder: "Общее", Content: "# ДМ\n", Default: domain.JournalObserver}); err != nil {
		t.Fatal(err)
	}
	if err := svc.DeleteFolder(ctx, gwen, "Общее"); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("игрок снёс папку с чужой записью: %v", err)
	}
	if err := svc.RenameFolder(ctx, gwen, "Общее", "Не общее"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("игрок переименовал общую папку: %v", err)
	}
	if err := svc.RenameFolder(ctx, dm, "Общее", "Объявления"); err != nil {
		t.Fatalf("ДМ не смог переименовать папку: %v", err)
	}
}
