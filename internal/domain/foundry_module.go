package domain

import "time"

// FoundryModule — пакет Foundry VTT (модуль/система), хотя бы раз
// импортированный в этот мир (см. service.FoundryService.ImportPack).
// Запоминается по ID пакета (module.json id/name) — повторный импорт того
// же пакета обновляет запись, а не плодит вторую: ДМ видит в настройках
// один пункт на модуль с версией последнего импорта, а не историю попыток.
//
// Хранится только это — ни список паков, ни архив: они всегда можно
// перечитать заново по ManifestURL (см. foundry.Cache), а тут нужен лишь
// минимум, чтобы показать список в настройках и понять, не вышла ли версия
// новее.
type FoundryModule struct {
	ID          string    `json:"id"`
	Title       string    `json:"title"`
	Version     string    `json:"version"`
	ManifestURL string    `json:"manifestUrl"`
	ImportedAt  time.Time `json:"importedAt"`
}
