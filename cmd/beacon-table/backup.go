package main

import (
	"context"
	"database/sql"
	"log"

	"beacon-table/internal/backup"
	"beacon-table/internal/repository/sqlite"
)

// backupOptions собирает параметры бэкапа из конфига.
func backupOptions(cfg Config, db *sql.DB) backup.Options {
	return backup.Options{
		DB:     db,
		DBPath: cfg.DBPath(),
		Dirs:   []string{cfg.DataDir, cfg.UploadsDir},
		Dest:   cfg.BackupPath(),
		Keep:   cfg.BackupKeep,
	}
}

// runBackupCommand — `beacon-table backup`: один бэкап прямо сейчас и выход.
// Аргументы после "backup" — те же, что у сервера (--data, --config и т.д.).
func runBackupCommand(args []string) {
	cfg, _, err := loadConfig(args)
	if err != nil {
		log.Fatal(err)
	}
	db, err := sqlite.Open(cfg.DBPath())
	if err != nil {
		log.Fatal("не удалось открыть базу:", err)
	}
	defer db.Close()

	path, err := backup.Once(context.Background(), backupOptions(cfg, db))
	if err != nil {
		log.Fatal("бэкап не удался: ", err)
	}
	//nolint:gosec // G706: путь собран из конфига и метки времени, не из сети.
	log.Println("бэкап готов:", path)
}
