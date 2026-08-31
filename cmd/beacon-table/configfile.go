package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

// configEntry — одна настройка в beacon.conf: имя, пояснение и пример
// значения. Единственная точка правды о содержимом файла: из этого списка
// собирается и файл при первом запуске, и дозапись настроек, появившихся в
// новой версии.
type configEntry struct {
	// group — заголовок над блоком в файле; пусто, если настройка продолжает
	// предыдущий блок (как BEACON_BACKUP_* — один комментарий на четыре).
	group   string
	key     string
	example string

	// ---- то же самое глазами ДМ: форма в разделе «Настройки» ----

	// section — заголовок группы в форме: без группировки тринадцать полей
	// подряд читаются как простыня.
	section string
	// title — имя поля в интерфейсе, hint — подпись под ним.
	title string
	hint  string
	// kind — как показать и как проверить: text, bool, int, duration,
	// size (20GB), enum.
	kind    string
	options []string // для kind == "enum"
	// readOnly — настройку видно, но менять из веба нельзя. Так закрыты пути
	// и порт: это уровень машины, а не игры. ДМ — администратор стола, но не
	// обязательно сервера, и выбирать через форму, куда процессу писать
	// файлы, ему не по чину.
	readOnly bool
	// appliesNow — вступает в силу сразу после сохранения; иначе форма
	// честно пишет, что нужен перезапуск.
	appliesNow bool
}

// configHeader — шапка файла, пишется только при создании.
const configHeader = `# Настройки Beacon Table.
#
# Формат — ИМЯ=значение. Уберите # в начале строки, чтобы настройка
# заработала, и перезапустите программу.
#
# Этот же файл понимают docker (--env-file beacon.conf) и systemd
# (EnvironmentFile=/etc/beacon-table/beacon.conf).
`

// configEntries — все настройки в том порядке, в каком они ложатся в файл.
// Новую настройку достаточно дописать сюда: в свежих файлах она появится
// сама, в уже существующих — при следующем запуске (см. syncConfigFile).
var configEntries = []configEntry{
	{
		group: `# Адрес и порт, на которых открыт стол.
# ":8080" — все сетевые интерфейсы: стол виден с телевизора и телефонов
# в той же сети. За обратным прокси лучше "127.0.0.1:8080", чтобы снаружи
# нельзя было подключиться в обход него.`,
		key: envAddr, example: ":8080",
		section: "Пути и порт", title: "Адрес и порт", hint: "Где сервер слушает. Меняется только в файле настроек или флагом запуска.",
		kind: "text", readOnly: true,
	},
	{
		group: `# Каталог данных: база аккаунтов, журнал, сцены, заметки.`,
		key:   envDataDir, example: "data",
		section: "Пути и порт", title: "Каталог данных", hint: "База, журнал, сцены, заметки.",
		kind: "text", readOnly: true,
	},
	{
		group: `# Каталог загрузок: карты, токены, аудио.`,
		key:   envUploadsDir, example: "uploads",
		section: "Пути и порт", title: "Каталог загрузок", hint: "Карты, токены, аудио.",
		kind: "text", readOnly: true,
	},
	{
		group: `# Сервер стоит за HTTPS-прокси (Caddy, nginx).
# Включает Secure у cookie — они перестают ходить по незашифрованному
# соединению. Включайте, ТОЛЬКО если снаружи действительно https, иначе
# войти не получится вовсе.`,
		key: envBehindProxy, example: "false",
		section: "Доступ", title: "За HTTPS-прокси", hint: "Включает Secure у cookie и строгую проверку источника. Ставьте, только если снаружи действительно https — иначе войти не получится.",
		kind: "bool",
	},
	{
		group: `# Дополнительные адреса, с которых разрешено открывать стол, через запятую.
# Обычно не нужно: сервер узнаёт свой адрес из самого запроса и принимает
# подключения только со страниц, открытых по нему же. Понадобится, если
# обратный прокси не передаёт исходный Host — тогда стол не откроется, а в
# журнале будет «отклонён WS-хендшейк».`,
		key: envAllowedOrigins, example: "стол.example.com,192.168.1.10:8080",
		section: "Доступ", title: "Дополнительные адреса стола", hint: "Через запятую. Нужно, только если прокси не передаёт исходный Host.",
		kind: "text",
	},
	{
		group: `# Резервное копирование: снимок базы (VACUUM INTO) плюс архив каталогов
# данных и загрузок. Делается при старте и дальше по интервалу; каждый архив
# проверяется на восстановимость. Хранятся последние BEACON_BACKUP_KEEP штук.`,
		key: envBackupEnabled, example: "true",
		section: "Резервное копирование", title: "Резервное копирование", hint: "Снимок базы и архив файлов по расписанию.",
		kind: "bool",
	},
	{
		key: envBackupDir, example: "data/backups",
		section: "Пути и порт", title: "Каталог бэкапов", hint: "Куда складывать архивы.",
		kind: "text", readOnly: true,
	},
	{
		key: envBackupInterval, example: "24h",
		section: "Резервное копирование", title: "Как часто делать бэкап", hint: "Например 24h или 12h.",
		kind: "duration",
	},
	{
		key: envBackupKeep, example: "7",
		section: "Резервное копирование", title: "Сколько архивов хранить", hint: "Лишние удаляются, начиная с самых старых.",
		kind: "int",
	},
	{
		group: `# Подробность журнала: debug, info, warn, error.
# На debug добавляется строка на каждый HTTP-запрос — удобно при разборе
# проблемы, но журнал растёт быстро.`,
		key: envLogLevel, example: "info",
		section: "Журнал", title: "Подробность журнала", hint: "debug добавляет строку на каждый запрос — журнал растёт быстро.",
		kind: "enum", options: []string{"debug", "info", "warn", "error"}, appliesNow: true,
	},
	{
		group: `# Формат журнала: text (читается глазами) или json (для систем сбора логов).`,
		key:   envLogFormat, example: "text",
		section: "Журнал", title: "Формат журнала", hint: "text читается глазами, json — для систем сбора логов.",
		kind: "enum", options: []string{"text", "json"},
	},
	{
		group: `# Сколько места отдано под загрузки (карты, токены, аудио). Пусто или 0 —
# без ограничения. Первое — предел на весь сервер, второе — на каждый мир
# по отдельности, чтобы один стол с видео-картами не съел место у прочих.
# При исчерпании загрузка отклоняется с понятным сообщением; ничего не
# удаляется само.`,
		key: envUploadsQuota, example: "20GB",
		section: "Место под загрузки", title: "Место под загрузки — всего", hint: "Например 20GB. Пусто или 0 — без ограничения.",
		kind: "size", appliesNow: true,
	},
	{
		key: envUploadsWorldQuota, example: "5GB",
		section: "Место под загрузки", title: "Место под загрузки — на мир", hint: "Например 5GB. Пусто или 0 — без ограничения.",
		kind: "size", appliesNow: true,
	},
}

// renderConfigFile — полный файл-пример. Всё закомментировано: файл ничего
// не меняет, пока его не тронули, и служит подсказкой, что можно настроить.
func renderConfigFile() string {
	var b strings.Builder
	b.WriteString(configHeader)
	for _, e := range configEntries {
		writeEntry(&b, e)
	}
	return b.String()
}

// writeEntry — блок одной настройки. Пустая строка ставится только перед
// новым заголовком: настройки одной группы (BEACON_BACKUP_*) идут подряд.
func writeEntry(b *strings.Builder, e configEntry) {
	if e.group != "" {
		b.WriteString("\n")
		b.WriteString(e.group)
		b.WriteString("\n")
	}
	fmt.Fprintf(b, "#%s=%s\n", e.key, e.example)
}

// syncConfigFile приводит существующий beacon.conf в соответствие с текущей
// версией программы: дописывает в конец настройки, которых в файле нет.
//
// Зачем: файл создаётся один раз, при первом запуске, и дальше живёт своей
// жизнью. Обновив бинарник, человек получал старый файл без новых настроек —
// и не узнавал о них, пока не полез в README. Дозапись оставляет всё, что он
// написал сам (значения, порядок, комментарии), и только добавляет
// недостающее — закомментированным, то есть ни на что не влияющим.
//
// Возвращает имена дописанных настроек (для строки в журнале).
func syncConfigFile(path string) ([]string, error) {
	//nolint:gosec // G304: путь конфига задаёт тот, кто запускает сервер.
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	present := mentionedKeys(string(body))

	var missing []configEntry
	for _, e := range configEntries {
		if !present[e.key] {
			missing = append(missing, e)
		}
	}
	if len(missing) == 0 {
		return nil, nil
	}

	var b strings.Builder
	b.Write(body)
	if !strings.HasSuffix(string(body), "\n") {
		b.WriteString("\n")
	}
	b.WriteString("\n# --- Добавлено новой версией Beacon Table ---\n")
	names := make([]string, 0, len(missing))
	for _, e := range missing {
		writeEntry(&b, e)
		names = append(names, e.key)
	}

	//nolint:gosec // G306: файл настроек читает и правит администратор
	// сервера; 0600 — как и при создании.
	if err := os.WriteFile(path, []byte(b.String()), 0o600); err != nil {
		return nil, err
	}
	return names, nil
}

// mentionedKeys — какие настройки в файле уже упомянуты. Закомментированная
// строка тоже считается упоминанием: человек мог намеренно оставить
// настройку выключенной, и дописывать ей дубль — только путать.
func mentionedKeys(body string) map[string]bool {
	out := map[string]bool{}
	sc := bufio.NewScanner(strings.NewReader(body))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		line = strings.TrimLeft(line, "#")
		line = strings.TrimSpace(line)
		key, _, found := strings.Cut(line, "=")
		if !found {
			continue
		}
		out[strings.TrimSpace(key)] = true
	}
	return out
}

// writeExampleConfig создаёт файл-подсказку, если его ещё нет. Ошибку
// вызывающий игнорирует намеренно: в контейнере с файловой системой только
// для чтения писать некуда, и это не повод не запускаться.
func writeExampleConfig(path string) error {
	//nolint:gosec // G703: путь конфига приходит из аргументов запуска или
	// из окружения — его задаёт тот, кто и так запускает этот процесс, а не
	// пользователь по сети. Ограничивать его каталогом бессмысленно: файл
	// настроек как раз и кладут туда, куда удобно администратору.
	if _, err := os.Stat(path); err == nil {
		return nil
	}
	//nolint:gosec // G703: см. выше.
	return os.WriteFile(path, []byte(renderConfigFile()), 0o600)
}
