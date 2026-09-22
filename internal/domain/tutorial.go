package domain

// Состояния режима обучения (см. service.TutorialService). Одно на сервер,
// а не на аккаунт: обучение — для ведущего, а ДМ на установке один.
const (
	// TutorialUnset — ведущего ещё не спрашивали, нужно ли обучение:
	// экран миров задаст вопрос при первом входе.
	TutorialUnset = ""
	TutorialOn    = "on"
	TutorialOff   = "off"
)

// ValidTutorialState — значение пришло из формы, а не из кода: незнакомую
// строку в хранилище не пускаем.
func ValidTutorialState(s string) bool {
	return s == TutorialUnset || s == TutorialOn || s == TutorialOff
}
