// Перенос inline-скрипта static/index.html — механически, логика не
// менялась, только глобальные вызовы app.js заменены на import из api.js.
import { fetchMe, apiLogin, apiRegister, apiLogout, fetchVersion, fetchDemoStatus, enterDemo } from "../api.js";
import { isOwner, isPlayer } from "../roles.js";

// Версия сервера в углу экрана (см. cmd/beacon-table/version.go): тег релиза
// у сборок GoReleaser, иначе short commit hash. Тянем сразу при загрузке, а не
// по клику как в dm.js/player.js — на экране входа некуда прятать, и это
// единственное место, где версию видно ДО авторизации (эндпойнт публичный).
// Молча оставляем пусто при ошибке: не удалось узнать версию — не повод
// пугать надписью на экране логина, форма входа при этом рабочая.
fetchVersion()
  .then(({ version }) => {
    document.getElementById("appVersion").textContent = version;
  })
  .catch(() => {});

const tabLoginBtn = document.getElementById("tabLoginBtn");
const tabRegisterBtn = document.getElementById("tabRegisterBtn");
const loginForm = document.getElementById("loginForm");
const registerForm = document.getElementById("registerForm");
const tabs = document.getElementById("tabs");
const authBlock = document.getElementById("authBlock");
const worldWait = document.getElementById("worldWait");
const worldWaitMsg = document.getElementById("worldWaitMsg");

function showTab(name) {
  const isLogin = name === "login";
  tabLoginBtn.classList.toggle("active", isLogin);
  tabRegisterBtn.classList.toggle("active", !isLogin);
  loginForm.classList.toggle("active", isLogin);
  registerForm.classList.toggle("active", !isLogin);
}
tabLoginBtn.onclick = () => showTab("login");
tabRegisterBtn.onclick = () => showTab("register");

// showWorldWait — игрок авторизован, но его мир сейчас не тот (или никакой),
// что запущен ДМ (см. GET /api/me: worldActive, см. internal/api/http/auth_handlers.go:
// meResponseJSON) — вместо player.html показываем объяснение прямо здесь,
// форму входа/регистрации прячем (уже залогинен).
function showWorldWait(me) {
  authBlock.style.display = "none";
  demoHero.style.display = "none";
  worldWait.style.display = "block";
  worldWaitMsg.textContent = me.activeWorldName
    ? `Привет, ${me.username}! ДМ сейчас ведёт другой мир («${me.activeWorldName}»). Загляни позже.`
    : `Привет, ${me.username}! ДМ ещё не запустил ни одного мира. Загляни позже.`;
}

// Уже залогинен (валидная cookie сессии) — сразу уводим на нужный экран, не
// заставляя проходить форму входа заново. ДМ (admin) — всегда на экран
// выбора мира (worlds.html), это и есть тот самый "экран после
// авторизации" по аналогии с Foundry Setup. Игрок — на player.html, только
// если его мир сейчас реально запущен, иначе остаётся здесь (см. showWorldWait).
function redirectByRole(me) {
  // Гостя демо ведём прямо на стол: миров он не выбирает — стол на демо
  // один, и списка миров у него всё равно нет прав открыть.
  if (me.role === "demo") {
    location.href = "/dm.html";
    return;
  }
  if (isOwner(me.role)) {
    location.href = "/worlds.html";
    return;
  }
  if (isPlayer(me.role) && me.worldActive) {
    location.href = "/player.html";
    return;
  }
  showWorldWait(me);
}
fetchMe().then((me) => {
  if (me) redirectByRole(me);
});

// enterWithSession — уводит со страницы, только убедившись, что сессия
// реально прижилась в браузере. POST /login и POST /demo/guest возвращают
// аккаунт в теле ответа даже тогда, когда cookie сессии браузер не сохранил
// (самый частый случай — BEACON_BEHIND_PROXY=true без настоящего HTTPS
// снаружи: cookie приходит с пометкой Secure, и на голом http её просто не
// запишут). Без этой проверки редирект на worlds.html/player.html случался
// бы всё равно, а там fetchMe() падал молча — человек видел, как экран
// мигнул и снова стал формой входа, без единого объяснения.
//
// Возвращает true, если увели дальше — вызывающему это нужно, чтобы понять,
// возвращать ли кнопки в рабочее состояние.
async function enterWithSession(msgEl) {
  const me = await fetchMe();
  if (!me) {
    msgEl.textContent =
      "Вход выполнен, но сессия не сохранилась в браузере. Обычно это значит, " +
      "что сервер настроен на HTTPS-прокси (BEACON_BEHIND_PROXY), а снаружи нет " +
      "настоящего HTTPS — обратитесь к тому, кто ставил стол.";
    msgEl.className = "msg error";
    return false;
  }
  redirectByRole(me);
  return true;
}

document.getElementById("worldWaitLogout").onclick = async () => {
  await apiLogout();
  location.reload();
};

const loginMsg = document.getElementById("loginMsg");
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginMsg.textContent = "";
  loginMsg.className = "msg";
  try {
    await apiLogin(
      document.getElementById("loginUsername").value.trim(),
      document.getElementById("loginPassword").value
    );
    await enterWithSession(loginMsg);
  } catch (err) {
    loginMsg.textContent = err.message;
    loginMsg.className = "msg error";
  }
});

// ---- вход в демо ----
// Демо-сервер — это витрина, а не рабочий стол: аккаунт на нём есть у одного
// человека (владельца), а приходят на него сотни тех, у кого аккаунта нет и
// не будет. Поэтому на демо форма входа уступает место двум карточкам ролей,
// а сама уезжает под ссылку «У меня есть аккаунт». На обычной установке всё
// наоборот: демо-блока нет вовсе (/api/demo отвечает enabled=false), экран —
// прежние вкладки «Вход/Регистрация».
//
// Ролей две, потому что за столом два разных места. Гость-ДМ видит карту
// целиком — и не видит, ради чего считаются свет и стены; гость-игрок
// садится по эту сторону ширмы, с туманом войны, своим токеном и своим
// факелом (персонажа и токен ему выдаёт сервер, см. demo_handlers.go).
const demoHero = document.getElementById("demoHero");
const demoDmBtn = document.getElementById("demoDmBtn");
const demoPlayerBtn = document.getElementById("demoPlayerBtn");
const demoMsg = document.getElementById("demoMsg");
const showAuthBtn = document.getElementById("showAuthBtn");

// Пока ответ не пришёл, не показан ни один из двух вариантов — иначе на
// демо-сервере форма входа успевала бы мигнуть и спрятаться. Ошибка запроса
// внутри fetchDemoStatus превращается в enabled=false, то есть в обычный
// экран входа: без ответа сервера мы не останемся с пустой карточкой.
fetchDemoStatus().then(({ enabled }) => {
  if (!enabled) {
    authBlock.style.display = "";
    return;
  }
  document.getElementById("box").classList.add("demo");
  demoHero.style.display = "";
  // Регистрацию на демо не предлагаем: заявка ушла бы в мир, который
  // сбрасывается вместе со всеми аккаунтами, и одобрять её некому.
  tabs.style.display = "none";
});

// «У меня есть аккаунт» — владелец демо-сервера заходит своим паролем.
showAuthBtn.onclick = () => {
  showAuthBtn.style.display = "none";
  authBlock.style.display = "";
  document.getElementById("authHint").style.display = "";
  showTab("login");
  document.getElementById("loginUsername").focus();
};

function demoEntry(btn, role) {
  btn.onclick = async () => {
    demoMsg.textContent = "";
    demoMsg.className = "msg";
    demoDmBtn.disabled = true;
    demoPlayerBtn.disabled = true;
    try {
      await enterDemo(role);
      if (!(await enterWithSession(demoMsg))) {
        demoDmBtn.disabled = false;
        demoPlayerBtn.disabled = false;
      }
    } catch (err) {
      demoMsg.textContent = err.message;
      demoMsg.className = "msg error";
      demoDmBtn.disabled = false;
      demoPlayerBtn.disabled = false;
    }
  };
}
demoEntry(demoDmBtn, "dm");
demoEntry(demoPlayerBtn, "player");

const registerMsg = document.getElementById("registerMsg");
registerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  registerMsg.textContent = "";
  registerMsg.className = "msg";
  try {
    await apiRegister(
      document.getElementById("regUsername").value.trim(),
      document.getElementById("regPassword").value
    );
    registerForm.reset();
    registerMsg.textContent = "Заявка отправлена. Жди подтверждения от ДМ, потом заходи через вкладку «Вход».";
    registerMsg.className = "msg ok";
  } catch (err) {
    registerMsg.textContent = err.message;
    registerMsg.className = "msg error";
  }
});
