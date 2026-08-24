import{G as l,ah as i,l as m,ai as u,aj as y,ak as g}from"./api-CVeFZVLx.js";const n=document.getElementById("list"),s=document.getElementById("createForm"),o=document.getElementById("createMsg"),f={"dnd5e-2024":"D&D 2024","dnd5e-2014":"D&D 5e (2014)"};function h(e){return f[e]||e}function d(e){const t=document.createElement("div");return t.textContent=e,t.innerHTML}function v(e){const t=e.active?'<span class="pill-badge on">Активен</span>':"",a=e.active?`<button class="world-btn open-btn" data-id="${e.id}">Открыть стол →</button>`:`<button class="world-btn launch-btn" data-id="${e.id}">Запустить</button>`;return`
    <div class="row-card world-card" data-id="${e.id}">
      <div class="world-info">
        <div class="world-name">${d(e.name)}</div>
        <div class="world-meta">
          <span class="pill-badge">${h(e.system)}</span>
          ${t}
        </div>
      </div>
      <div class="world-actions">
        ${a}
        <button class="icon-btn danger delete-btn" data-id="${e.id}" title="Удалить">✕</button>
      </div>
    </div>
  `}async function r(){let e;try{e=await u()}catch(t){n.innerHTML=`<div class="msg error">${d(t.message)}</div>`;return}if(!e.length){n.innerHTML='<div id="emptyMsg">Миров ещё нет — создай первый ниже.</div>';return}n.innerHTML=e.map(v).join(""),n.querySelectorAll(".launch-btn").forEach(t=>{t.onclick=async()=>{t.disabled=!0,t.textContent="Запускаю…";try{await y(t.dataset.id),location.href="/dm.html"}catch(a){alert(a.message),t.disabled=!1,t.textContent="Запустить"}}}),n.querySelectorAll(".open-btn").forEach(t=>{t.onclick=()=>{location.href="/dm.html"}}),n.querySelectorAll(".delete-btn").forEach(t=>{t.onclick=async()=>{if(confirm("Удалить этот мир из списка? Файлы на диске не трогаются."))try{await g(t.dataset.id),r()}catch(a){alert(a.message)}}})}document.getElementById("logoutBtn").onclick=async()=>{await l(),location.href="/"};s.addEventListener("submit",async e=>{e.preventDefault(),o.textContent="",o.className="msg";const t=document.getElementById("worldName").value.trim(),a=document.getElementById("worldSystem").value;try{await i(t,a),s.reset(),r()}catch(c){o.textContent=c.message,o.className="msg error"}});m().then(e=>{if(!e||e.role!=="admin"){location.href="/";return}r()});
