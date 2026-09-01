// Перенос inline-скрипта static/index.html — механически, логика не
// менялась, только глобальные вызовы app.js заменены на import из api.js.
import { fetchMe, apiLogin, apiRegister, apiLogout, fetchVersion, fetchDemoStatus, enterDemo } from "../api.js";

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
  tabs.style.display = "none";
  loginForm.classList.remove("active");
  registerForm.classList.remove("active");
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
  if (me.role === "admin") {
    location.href = "/worlds.html";
    return;
  }
  if (me.worldActive) {
    location.href = "/player.html";
    return;
  }
  showWorldWait(me);
}
fetchMe().then((me) => {
  if (me) redirectByRole(me);
});

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
    const me = await apiLogin(
      document.getElementById("loginUsername").value.trim(),
      document.getElementById("loginPassword").value
    );
    redirectByRole(me);
  } catch (err) {
    loginMsg.textContent = err.message;
    loginMsg.className = "msg error";
  }
});

// ---- вход в демо ----
// Кнопка есть только на демо-сервере: на обычной установке /api/demo
// отвечает enabled=false, и блок не показывается вовсе.
const demoBlock = document.getElementById("demoBlock");
const demoBtn = document.getElementById("demoBtn");
const demoMsg = document.getElementById("demoMsg");

fetchDemoStatus().then(({ enabled }) => {
  if (enabled) demoBlock.style.display = "";
});

demoBtn.onclick = async () => {
  demoMsg.textContent = "";
  demoMsg.className = "msg";
  demoBtn.disabled = true;
  try {
    redirectByRole(await enterDemo());
  } catch (err) {
    demoMsg.textContent = err.message;
    demoMsg.className = "msg error";
    demoBtn.disabled = false;
  }
};

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
