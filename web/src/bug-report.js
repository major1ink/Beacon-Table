// bug-report.js — «Сообщить о баге»: описание от человека плюс версия,
// браузер и последние ошибки консоли — в готовый текст issue.
//
// Ошибки копятся сами (installErrorCapture): просить игрока открыть DevTools
// посреди игры бессмысленно, а по пересказу «карта пропала» баг не чинится.
// Сам ничего не отправляет — сервер отчёты не принимает и не хранит: стол
// живёт в локальной сети, канала «наружу» у него нет.
import { openModal, showAlert } from "./modal.js";
import { fetchVersion } from "./api.js";

const REPO_URL = "https://github.com/major1ink/Beacon-Table";
export const SUPPORT_EMAIL = "info@beacontable.ru";

// Буфер живёт всю сессию стола (часы), а issue с мегабайтом стектрейсов
// никто не прочитает.
const MAX_ERRORS = 20;
const MAX_ERROR_LEN = 600;

const errorLog = [];

function remember(kind, text) {
  if (!text) return;
  const line = String(text).slice(0, MAX_ERROR_LEN);
  errorLog.push({ at: new Date(), kind, line });
  if (errorLog.length > MAX_ERRORS) errorLog.shift();
}

function formatArgs(args) {
  return args
    .map((a) => {
      if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

let captureInstalled = false;

// installErrorCapture — включить сбор ошибок; зовётся один раз при загрузке
// страницы, до всего остального.
export function installErrorCapture() {
  if (captureInstalled) return;
  captureInstalled = true;

  // console.error, а не только window.onerror: свои ошибки приложение ловит
  // само (catch + console.error) и до window.onerror они не доходят — а это
  // самые полезные строки («не удалось загрузить фон карты»).
  const original = console.error.bind(console);
  console.error = (...args) => {
    remember("console", formatArgs(args));
    original(...args);
  };

  window.addEventListener("error", (e) => {
    if (e.error) remember("js", e.error.stack || `${e.error.name}: ${e.error.message}`);
    else remember("js", `${e.message} (${e.filename}:${e.lineno})`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    remember("promise", r instanceof Error ? r.stack || `${r.name}: ${r.message}` : formatArgs([r]));
  });
}

// copyToClipboard — clipboard API, при отказе старый execCommand: на не-https
// адресе (стол в локалке по http) прав на буфер часто нет.
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // пробуем запасной путь ниже
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;top:-1000px;opacity:0;";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

function pad(n) {
  return String(n).padStart(2, "0");
}
function timeOf(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function collectTech() {
  let version = "неизвестна";
  try {
    version = (await fetchVersion()).version || version;
  } catch {
    // сервер мог как раз и отвалиться — это часть картины
    version = "не ответил /api/version";
  }
  const lines = [
    `- Версия Beacon Table: ${version}`,
    `- Страница: ${location.pathname}`,
    `- Браузер: ${navigator.userAgent}`,
    `- Окно: ${window.innerWidth}×${window.innerHeight}, dpr ${window.devicePixelRatio}`,
    `- Время: ${new Date().toLocaleString("ru-RU")}`,
  ];
  if (errorLog.length > 0) {
    lines.push("", "Последние ошибки в консоли:", "```");
    for (const e of errorLog) lines.push(`[${timeOf(e.at)}] ${e.kind}: ${e.line}`);
    lines.push("```");
  } else {
    lines.push("", "Ошибок в консоли не было.");
  }
  return lines.join("\n");
}

// buildBody — тело issue по разделам .github/ISSUE_TEMPLATE/bug_report.md.
export function buildBody({ what, steps, expected, tech, withTech }) {
  const parts = [
    "**Что сломалось**",
    what.trim() || "—",
    "",
    "**Как повторить**",
    steps.trim() || "—",
    "",
    "**Ожидалось**",
    expected.trim() || "—",
  ];
  if (withTech) parts.push("", "**Окружение**", tech);
  return parts.join("\n");
}

// Потолок длины адреса: длинный URL браузер или GitHub обрежут, и форма
// откроется с пустым телом. Считаем по закодированной ссылке — кириллица в
// percent-encoding раздувается вшестеро.
const MAX_URL_LEN = 8000;

function issueURL(title, body) {
  const url = new URL(REPO_URL + "/issues/new");
  url.searchParams.set("labels", "bug");
  url.searchParams.set("title", title);
  url.searchParams.set("body", body);
  return url.toString();
}

// mailtoURL — письмо на почту проекта. Тело кодируется через
// encodeURIComponent, а не URLSearchParams: та превращает пробелы в «+», и
// почтовые клиенты их так и показывают.
function mailtoURL(title, body) {
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("[Beacon Table] " + title)}&body=${encodeURIComponent(body)}`;
}

// fitURL — режет отчёт с конца (там техданные, описание человека важнее),
// пока ссылка не уложится в MAX_URL_LEN.
function fitURL(build, title, body) {
  let text = body;
  let url = build(title, text);
  let trimmed = false;
  while (url.length > MAX_URL_LEN && text.length > 200) {
    text = text.slice(0, Math.floor(text.length * 0.8));
    trimmed = true;
    url = build(title, text + "\n…(отчёт обрезан по длине ссылки)");
  }
  return { url, trimmed };
}

export function issueURLFitting(title, body) {
  return fitURL(issueURL, title, body);
}

export function mailtoURLFitting(title, body) {
  return fitURL(mailtoURL, title, body);
}

const TARGETS = {
  github: { label: "Issue на GitHub", okLabel: "Открыть на GitHub", fit: issueURLFitting },
  mail: { label: `Письмо на ${SUPPORT_EMAIL}`, okLabel: "Открыть в почте", fit: mailtoURLFitting },
};

function textarea(parent, label, placeholder, rows) {
  const wrap = document.createElement("label");
  // Выравнивание задано явно: у страниц под диалогом свои правила для label
  // (панель ДМ центрирует содержимое) — иначе подпись и поле съезжают в центр.
  wrap.style.cssText = "display:flex;flex-direction:column;align-items:stretch;gap:4px;";
  const cap = document.createElement("span");
  cap.style.cssText = "font-size:12px;opacity:0.75;text-align:left;";
  cap.textContent = label;
  const ta = document.createElement("textarea");
  ta.className = "bt-modal-textarea";
  ta.rows = rows;
  ta.placeholder = placeholder;
  ta.style.minHeight = "0";
  wrap.append(cap, ta);
  parent.appendChild(wrap);
  return ta;
}

// openBugReport — диалог. Версию спрашиваем у сервера асинхронно, поэтому
// окно открывается сразу, а блок техданных дозаполняется.
export async function openBugReport() {
  let tech = "собираю…";
  let what, steps, expected, withTech, techBox;
  let target = "github";

  const techPromise = collectTech().then((t) => {
    tech = t;
    if (techBox) techBox.value = t;
  });

  const send = await openModal({
    title: "Сообщить о баге",
    okLabel: TARGETS[target].okLabel,
    cancelLabel: "Закрыть",
    buildBody: (body) => {
      const intro = document.createElement("p");
      intro.className = "bt-modal-text dim";
      intro.textContent =
        "Опишите, что пошло не так. Ничего никуда не уходит само: по кнопке откроется форма нового issue на GitHub или письмо в вашей почте с уже заполненным текстом — его можно вычитать и поправить.";
      body.appendChild(intro);

      what = textarea(body, "Что сломалось", "Карта у игроков осталась чёрной после смены сцены", 3);
      steps = textarea(body, "Как повторить", "1. Открыл «Сцена» → выбрал другую\n2. …", 3);
      expected = textarea(body, "Ожидалось", "Фон новой сцены появляется у всех", 2);

      const techWrap = document.createElement("details");
      const sum = document.createElement("summary");
      sum.style.cssText = "cursor:pointer;font-size:12px;opacity:0.8;";
      sum.textContent = "Технические данные (версия, браузер, ошибки в консоли)";
      techBox = document.createElement("textarea");
      techBox.className = "bt-modal-textarea";
      techBox.readOnly = true;
      techBox.rows = 8;
      techBox.style.marginTop = "8px";
      techBox.value = tech;
      techWrap.append(sum, techBox);
      body.appendChild(techWrap);

      const techRow = document.createElement("label");
      techRow.style.cssText = "display:flex;align-items:center;gap:8px;font-size:12px;";
      withTech = document.createElement("input");
      withTech.type = "checkbox";
      withTech.className = "switch";
      withTech.checked = true;
      const techLabel = document.createElement("span");
      techLabel.textContent = "Приложить технические данные";
      techRow.append(withTech, techLabel);
      body.appendChild(techRow);

      // Куда отправлять. Подпись кнопки «ОК» меняется вместе с выбором —
      // сама кнопка появляется в подвале после buildBody, поэтому ищем её
      // в момент переключения.
      const targetRow = document.createElement("div");
      targetRow.style.cssText = "display:flex;flex-direction:column;gap:6px;font-size:12px;";
      const targetCap = document.createElement("span");
      targetCap.style.cssText = "opacity:0.75;text-align:left;";
      targetCap.textContent = "Куда отправить";
      targetRow.appendChild(targetCap);
      for (const [key, t] of Object.entries(TARGETS)) {
        const opt = document.createElement("label");
        opt.style.cssText = "display:flex;align-items:center;gap:8px;cursor:pointer;";
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "bugReportTarget";
        radio.value = key;
        radio.checked = key === target;
        radio.onchange = () => {
          target = key;
          const okBtn = body.closest(".bt-modal")?.querySelector(".bt-modal-foot .bt-modal-btn.primary");
          if (okBtn) okBtn.textContent = t.okLabel;
        };
        const text = document.createElement("span");
        text.textContent = t.label;
        opt.append(radio, text);
        targetRow.appendChild(opt);
      }
      body.appendChild(targetRow);

      // Для тех, кому не подходит ни то, ни другое: отчёт в буфер, дальше как удобно.
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "bt-modal-btn";
      copyBtn.textContent = "Скопировать отчёт";
      copyBtn.style.alignSelf = "flex-start";
      copyBtn.onclick = async () => {
        const text = buildBody({
          what: what.value,
          steps: steps.value,
          expected: expected.value,
          tech,
          withTech: withTech.checked,
        });
        if (!(await copyToClipboard(text))) {
          showAlert("Буфер обмена недоступен — браузер не дал прав. Скопируйте текст из полей диалога вручную.");
          return;
        }
        copyBtn.textContent = "Скопировано";
        setTimeout(() => (copyBtn.textContent = "Скопировать отчёт"), 1500);
      };
      body.appendChild(copyBtn);

      return what;
    },
    onOk: () => true,
    onCancel: () => false,
  });

  if (!send) return;
  await techPromise;

  const title = (what.value.trim().split("\n")[0] || "Баг").slice(0, 90);
  const body = buildBody({
    what: what.value,
    steps: steps.value,
    expected: expected.value,
    tech,
    withTech: withTech.checked,
  });
  const { url, trimmed } = TARGETS[target].fit(title, body);
  if (target === "mail") {
    // mailto не открывает окно — браузер отдаёт ссылку почтовому клиенту;
    // window.open тут вернул бы пустую вкладку.
    location.href = url;
  } else {
    const win = window.open(url, "_blank", "noopener");
    if (!win) {
      showAlert("Браузер заблокировал новое окно. Разрешите всплывающие окна для этого адреса или скопируйте отчёт кнопкой «Скопировать отчёт».");
      return;
    }
  }
  if (trimmed) {
    showAlert("Отчёт длинный — в ссылку уместилась только часть. Полный текст можно взять кнопкой «Скопировать отчёт» и вставить вручную.");
  }
}
