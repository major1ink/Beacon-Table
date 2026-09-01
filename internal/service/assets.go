package service

import (
	"context"
	"io"

	"beacon-table/internal/domain"
	"beacon-table/internal/repository"
)

// AssetService — загрузка, листинг и организация в папки файлов
// (карты/токены/аудио/пропы карты). Правило "maps, audio и props грузит
// только ДМ, tokens — любой активный аккаунт (свои аватары персонажей)" —
// бизнес-правило, зависящее от данных запроса (kind), а не просто "весь
// endpoint только для ДМ" — поэтому живёт здесь, а не в виде общего
// api-мидлвара. Управление папками (CreateFolder/DeleteFolder) и удаление
// файлов той же логикой ограничены — сейчас ей реально пользуется только
// раздел "Ассеты" (kind=props, см. web/dm.html), но правило общее для всех
// kind ради единообразия.
type AssetService interface {
	Upload(ctx context.Context, account *domain.Account, kind, folder, filename string, r io.Reader) (url string, err error)
	List(ctx context.Context) (map[string][]domain.AssetInfo, error)
	// FoldersAll — папки всех kind разом, для совмещения с List() в одном
	// ответе /assets (см. handleAssets).
	FoldersAll(ctx context.Context) (map[string][]domain.AssetFolder, error)
	CreateFolder(ctx context.Context, account *domain.Account, kind, folder string) error
	DeleteFolder(ctx context.Context, account *domain.Account, kind, folder string) error
	DeleteAsset(ctx context.Context, account *domain.Account, kind, url string) error
}

type assetService struct {
	assets repository.AssetRepository
}

func NewAssetService(assets repository.AssetRepository) AssetService {
	return &assetService{assets: assets}
}

// dmOnlyKind — kind, доступный только ДМ (в отличие от tokens — тот же
// аккаунт может грузить туда собственный аватар персонажа).
func dmOnlyKind(kind string) bool {
	return kind == domain.AssetKindMaps || kind == domain.AssetKindAudio ||
		kind == domain.AssetKindProps || kind == domain.AssetKindHandouts
}

func (s *assetService) Upload(ctx context.Context, account *domain.Account, kind, folder, filename string, r io.Reader) (string, error) {
	if dmOnlyKind(kind) && !account.IsGM() {
		return "", domain.ErrForbidden
	}
	return s.assets.Save(ctx, kind, folder, filename, r)
}

func (s *assetService) List(ctx context.Context) (map[string][]domain.AssetInfo, error) {
	out := make(map[string][]domain.AssetInfo, len(domain.AssetKinds))
	for _, kind := range domain.AssetKinds {
		items, err := s.assets.List(ctx, kind)
		if err != nil {
			return nil, err
		}
		out[kind] = items
	}
	return out, nil
}

func (s *assetService) FoldersAll(ctx context.Context) (map[string][]domain.AssetFolder, error) {
	out := make(map[string][]domain.AssetFolder, len(domain.AssetKinds))
	for _, kind := range domain.AssetKinds {
		items, err := s.assets.Folders(ctx, kind)
		if err != nil {
			return nil, err
		}
		out[kind] = items
	}
	return out, nil
}

func (s *assetService) CreateFolder(ctx context.Context, account *domain.Account, kind, folder string) error {
	if dmOnlyKind(kind) && !account.IsGM() {
		return domain.ErrForbidden
	}
	return s.assets.CreateFolder(ctx, kind, folder)
}

func (s *assetService) DeleteFolder(ctx context.Context, account *domain.Account, kind, folder string) error {
	if dmOnlyKind(kind) && !account.IsGM() {
		return domain.ErrForbidden
	}
	return s.assets.DeleteFolder(ctx, kind, folder)
}

func (s *assetService) DeleteAsset(ctx context.Context, account *domain.Account, kind, url string) error {
	if dmOnlyKind(kind) && !account.IsGM() {
		return domain.ErrForbidden
	}
	return s.assets.DeleteAsset(ctx, kind, url)
}
