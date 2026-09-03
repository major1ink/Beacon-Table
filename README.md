<p align="center">
  <img src="docs/assets/logo.png" width="110" alt="">
</p>

<h1 align="center">Beacon Table</h1>

<p align="center">
  <b>Виртуальный стол для D&amp;D, который умещается в один файл.</b><br>
  Ведущий держит игру на ноутбуке, телевизор показывает ту же карту<br>
  по локальной сети, а игроки из дома подключаются через интернет.<br>
  Все играют за одним столом.
</p>

<p align="center">
  <a href="https://demo.beacontable.ru/"><b>🌐 Живое демо</b></a> ·
  <a href="https://beacontable.ru/">Сайт</a> ·
  <a href="https://github.com/major1ink/Beacon-Table/releases/latest">Скачать</a> ·
  <a href="https://github.com/major1ink/Beacon-Table/wiki">Документация</a> ·
  <a href="https://beacontable.ru/roadmap.html">Роадмап</a> ·
  <a href="#english-summary">English summary</a>
</p>

<p align="center">
  <a href="https://github.com/major1ink/Beacon-Table/releases/latest"><img alt="Последний релиз" src="https://img.shields.io/github/v/release/major1ink/Beacon-Table?display_name=tag&amp;label=%D1%80%D0%B5%D0%BB%D0%B8%D0%B7"></a>
  <img alt="Лицензия AGPL-3.0" src="https://img.shields.io/github/license/major1ink/beacon-table">
  <img alt="Написано на Go" src="https://img.shields.io/github/go-mod/go-version/major1ink/Beacon-Table?label=go">
</p>

![Окно ведущего: карта пещеры со стенами, источниками света и токенами](docs/assets/screenshots/dm-window.png)

---

## Зачем это

Большинство VTT изначально заточены под игру через интернет.

Но когда компания собирается дома, сценарий немного другой. Хочется поставить ноутбук ведущего рядом, вывести карту на телевизор и играть. А вместо этого иногда получается квест уже не по подземелью, а по настройкам: где второй клиент, зачем нужен аккаунт, почему это требует подписку и куда опять пропал нужный экран.

Beacon Table я делал немного с другой стороны.

Скачал один файл, запустил — сервер уже работает, а стол открывается в браузере.

Дальше можно открыть разные окна для разных участников:

- **у ведущего** — полная карта, стены, свет, монстры, музыка и заметки;
- **на телевизоре или проекторе** — отдельный экран с картой во весь экран, без панелей ведущего;
- **у удалённых игроков** — своё окно с персонажем, токеном, бросками и только той частью карты, которую они должны видеть.

Все эти окна работают одновременно с одним столом.

Телевизор может находиться в той же локальной сети, а игроки, которые не смогли приехать, подключаются через интернет.

Данные хранятся в двух папках рядом с программой. Нужно перенести кампанию на другой компьютер — можно просто скопировать папку.

Никакой обязательной телеметрии, облака или аккаунта разработчика нет.

Код открыт под AGPL-3.0. 

---

## 🌐 Живое демо

**https://demo.beacontable.ru/** — можно зайти и просто посмотреть, как всё работает.

Регистрация не нужна. На входе есть две кнопки: можно зайти как ДМ или как игрок.

![Страница входа демо-стола: две кнопки — «Я ведущий» и «Я игрок»](docs/assets/screenshots/login.png)

В демо доступны функции, которыми пользуются непосредственно во время игры.

Закрыты только возможности, относящиеся к владельцу сервера: импорт из Foundry, аккаунты, миры и настройки.

Стол общий для всех посетителей и раз в полчаса возвращается к исходному состоянию. Поэтому строить там кампанию на двадцать часов не стоит — она всё равно исчезнет.

---

## Свет живёт по стенам

Одна из вещей, на которой я хотел сделать нормальный акцент, — свет.

Стены рисуются прямо мышью на карте, двери можно открывать и закрывать. Источник света у токена действительно учитывает стены.

Например, персонаж идёт по тёмному коридору с факелом. Свет идёт вместе с ним и упирается в стену. Повернул за угол — открылся новый кусок коридора. Отошёл обратно — там снова темно.

То, что персонаж уже успел исследовать, остаётся в тумане войны.

![Игрок ведёт токен по пещере: круг света движется вместе с ним, стены обрезают обзор](docs/assets/video/demo-light.gif)

---

## Три окна одной игры

Один запущенный сервер может отдавать сразу три интерфейса.

Они не дублируют друг друга — каждому достаётся то, что ему нужно.

| Окно ДМ | Окно игрока | Экран трансляции |
| --- | --- | --- |
| ![Окно ДМ](docs/assets/screenshots/dm-window.png) | ![Окно игрока](docs/assets/screenshots/player-window.png) | ![Экран трансляции](docs/assets/screenshots/broadcast-window.png) |
| Вся карта, стены, свет, монстры, музыка и заметки | Свой лист, свой токен, свои броски и только доступная часть карты | Карта во весь экран, без логина и панелей ДМ |

На среднем и правом скриншотах — та же самая сцена, что и слева.

Просто ДМ видит её целиком, игрок — через туман войны и собственный источник света, а телевизор показывает чистую карту для всей компании.

---

## Что внутри

### Сцены

На сценах есть:

- динамическое освещение;
- line-of-sight от токенов;
- стены и двери;
- туман войны с памятью уже разведанных мест;
- видео-фоны карт (`mp4`/`webm`);
- анимированные токены;
- быстрое переключение между сценами;
- отдельный фоновый звук для каждой сцены.

### Бой

Есть трекер инициативы с полосой хода и общий лог бросков кубов.

У состояний есть длительность — она отсчитывается по раундам.

И состояния, и экипировка действительно влияют на персонажа, а не просто лежат красивыми значками на листе. Например, могут измениться КД, скорость, характеристики или максимум хитов.

Есть и эффекты, которые работают сами. Например, «горит» снимает хиты в начале хода, а «регенерация» их восстанавливает.

![Трекер инициативы рядом с картой](docs/assets/screenshots/initiative.png)

### Библиотеки и заметки

В комплекте есть каталог контента на основе SRD 5.1/5.2.

Поверх него можно добавлять своих монстров, заклинания и предметы.

Для ДМа есть отдельные заметки в формате Markdown. Они устроены как небольшая вики: есть дерево каталогов и ссылки между заметками.

Есть и журнал стола. Это обычные `.md`-файлы, причём для каждой записи можно отдельно указать, кто её видит — весь стол или конкретный игрок.

![Журнал стола: список записей слева, открытая статья справа](docs/assets/screenshots/journal.png)

### Атмосфера

У каждой сцены может быть свой фоновый звук.

Поверх него ДМ может запускать отдельные плейлисты.

У игроков есть собственные аккаунты и персонажи. У каждого — свой лист, инвентарь и права доступа.

### Перенос данных

Можно переносить:

- листы персонажей из LSS;
- предметы и заклинания из ttg.club;
- модули и системы Foundry VTT по ссылке на манифест.

При импорте из Foundry переносятся сцены, стены, свет и музыка.

А весь мир Beacon Table можно целиком упаковать в один `.zip` и перенести на другой сервер.

---

## Быстрый старт

Если хочется просто попробовать — скачайте готовый файл под свою систему со страницы [Releases](https://github.com/major1ink/Beacon-Table/releases/latest).

Положите его в пустую папку и запустите.

Linux/macOS:

```bash
chmod +x beacon-table_*        # GitHub не хранит бит "исполняемый"
./beacon-table_v0.8.1_linux_amd64
```

Windows:

```powershell
.\beacon-table_v0.8.1_windows_amd64.exe
```

Через секунду стол должен открыться в браузере.

Логин и пароль ведущего уже подставлены в форму входа — достаточно нажать «Войти».

Если телевизор находится в той же сети, откройте на нём:

```text
http://<адрес-компьютера>:8080/broadcast.html
```

### Запуск на VPS

Если у вас уже есть VPS с доменом, можно запустить Beacon Table через Docker.

В репозитории есть готовый `docker-compose.yml` с Caddy и автоматическим HTTPS:

```bash
docker compose up -d
```

Подробная инструкция по первому запуску, настройке и возможным проблемам находится в [Wiki](https://github.com/major1ink/Beacon-Table/wiki/Установка-и-первый-запуск).

---

## Документация

Всю подробную документацию я вынес в [Wiki](https://github.com/major1ink/Beacon-Table/wiki), чтобы README не превращался в инструкцию на полчаса чтения.

| | |
| --- | --- |
| [Установка и первый запуск](https://github.com/major1ink/Beacon-Table/wiki/Установка-и-первый-запуск) | Запуск, первый вход, подключение телевизора и SmartScreen |
| [Настройка](https://github.com/major1ink/Beacon-Table/wiki/Настройка) | `beacon.conf`, переменные и флаги: порт, каталоги, прокси, квоты |
| [Запуск в Docker](https://github.com/major1ink/Beacon-Table/wiki/Запуск-в-Docker) | Готовый compose с Caddy и HTTPS для VPS |
| [Запуск на сервере](https://github.com/major1ink/Beacon-Table/wiki/Запуск-на-сервере) | systemd и обратный прокси без Docker |
| [Эксплуатация](https://github.com/major1ink/Beacon-Table/wiki/Эксплуатация) | Журнал, `/healthz`, резервные копии и обновление |
| [Импорт из Foundry VTT](https://github.com/major1ink/Beacon-Table/wiki/Импорт-из-Foundry-VTT) | Что именно переносится и как работают повторные импорты |
| [Экспорт и импорт мира](https://github.com/major1ink/Beacon-Table/wiki/Экспорт-и-импорт-мира) | Перенос мира между серверами одним `.zip` |
| [Несколько ДМ](https://github.com/major1ink/Beacon-Table/wiki/Несколько-ДМ) | Как подключить соведущего к тому же столу |
| [Сборка из исходников](https://github.com/major1ink/Beacon-Table/wiki/Сборка-из-исходников) | Для сборки нужен только Go — фронтенд уже собран |

---

## Помочь проекту

Нашли баг или что-то работает не так — создайте [Issue](https://github.com/major1ink/Beacon-Table/issues).

Есть идея, чего не хватает для игры, — тоже пишите.

Что уже запланировано и над чем идёт работа — на [странице роадмапа](https://beacontable.ru/roadmap.html).

Если хочется покопаться в коде или что-нибудь добавить, порядок работы над проектом описан в [`CONTRIBUTING.md`](CONTRIBUTING.md).

И да, особенно интересно узнать, как Beacon Table ведёт себя **в настоящей игре**. На своём компьютере можно проверить далеко не всё.

---

## Лицензия

Код распространяется под [AGPL-3.0](LICENSE).

Если вы форкаете Beacon Table, дорабатываете его и раздаёте другим — в том числе запускаете как публичный сервис — ваши изменения должны распространяться под той же лицензией.

Встроенный каталог контента — отдельная история. В нём только SRD 5.1/5.2, которые распространяются по CC-BY-4.0/OGL.

Это лицензия именно на игровой контент: статблоки монстров, заклинания и тому подобное. Она не заменяет и не изменяет лицензию самого движка.

---

## English summary

**Beacon Table** is an open-source, self-hosted VTT for D&D 5e and other TTRPGs.

The idea is pretty simple: run one server, use the DM interface on a laptop, put the map on a TV or projector in the room, and let remote players join the same table over the internet.

It ships as a single binary. Download it, run it, and the table is ready in your browser.

No mandatory cloud service, account or subscription.

**Live demo:** <https://demo.beacontable.ru/>

**Roadmap:** <https://beacontable.ru/roadmap.html>

The demo is shared and can be joined without signing up. You can enter as a guest DM or a guest player. The game itself is fully usable; server-owner features such as Foundry VTT imports, accounts, worlds and settings are disabled. The demo resets to its reference state every 30 minutes, so changes made there are not permanent.

### How the table works

One running server provides three interfaces:

- **DM window** — the full map, walls, lighting, tokens, monsters, music and notes;
- **Player window** — the player's character sheet, token, dice rolls and visible part of the map;
- **Broadcast window** — a clean full-screen map for a TV or projector, without the DM interface.

The broadcast screen can run over the local network while remote players connect through the internet.

Game data is stored in folders next to the executable, so moving a campaign to another machine is as simple as copying the folder.

### Scenes and lighting

Scenes support walls, doors, dynamic lighting, line-of-sight and fog of war.

Lighting follows tokens and respects walls. A torch carried by a character lights the area in front of them, disappears around corners and leaves previously explored areas in the fog of war.

Scenes can also use video backgrounds (`mp4`/`webm`), animated tokens and their own ambient sound.

### Combat

Beacon Table includes an initiative tracker with a turn bar, a shared dice log and round-based status effects.

Statuses and equipment can actually change character numbers such as AC, speed, ability scores and maximum HP.

Some effects also handle their own changes at the start of a turn. For example, burning deals damage while regeneration restores HP.

### Characters, content and notes

Players have their own accounts, character sheets, inventories and permissions.

The built-in content catalog contains SRD 5.1/5.2 content. DMs can add their own monsters, spells and items.

DM notes work like a small wiki, with folders and links between notes. The table journal uses regular `.md` files and allows each entry to be visible to everyone at the table or only to a specific player.

### Import and export

Beacon Table can import:

- character sheets from LSS;
- items and spells from ttg.club;
- Foundry VTT modules and systems through their manifests.

Foundry VTT imports can include scenes, walls, lighting and music.

A complete Beacon Table world can be exported and moved between servers as a single `.zip` file.

### Quick start

Download a prebuilt binary for your OS from [Releases](https://github.com/major1ink/Beacon-Table/releases/latest) and run it.

No Go installation is required. The frontend and default SRD data are already included in the binary.

For source builds:

```bash
git clone https://github.com/major1ink/Beacon-Table.git
cd Beacon-Table
go run ./cmd/beacon-table
```

More detailed instructions are available in the [Wiki](https://github.com/major1ink/Beacon-Table/wiki).

The project's main documentation and community are currently Russian-speaking, but issues and contributions in English are welcome.

### License

The code is licensed under AGPL-3.0.

The bundled content catalog contains SRD 5.1/5.2 content only and is distributed under its applicable CC-BY-4.0/OGL terms.

No proprietary Wizards of the Coast book content is redistributed. DMs are free to add their own homebrew and imported content locally.