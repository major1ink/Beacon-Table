import{H as i,ax as m,n as u,ay as y,az as g,aA as h}from"./api-NaC6-tA4.js";import{s,b as f}from"./modal-DUy-NyPP.js";const n=document.getElementById("list"),d=document.getElementById("createForm"),o=document.getElementById("createMsg"),v={"dnd5e-2024":"D&D 2024","dnd5e-2014":"D&D 5e (2014)"};function p(e){return v[e]||e}function l(e){const t=document.createElement("div");return t.textContent=e,t.innerHTML}function w(e){const t=e.active?'<span class="pill-badge on">Активен</span>':"",a=e.active?`<button class="world-btn open-btn" data-id="${e.id}">Открыть стол →</button>`:`<button class="world-btn launch-btn" data-id="${e.id}">Запустить</button>`;return`
    <div class="row-card world-card" data-id="${e.id}">
      <div class="world-info">
        <div class="world-name">${l(e.name)}</div>
        <div class="world-meta">
          <span class="pill-badge">${p(e.system)}</span>
          ${t}
        </div>
      </div>
      <div class="world-actions">
        ${a}
        <button class="icon-btn danger delete-btn" data-id="${e.id}" title="Удалить">✕</button>
      </div>
    </div>
  `}async function r(){let e;try{e=await y()}catch(t){n.innerHTML=`<div class="msg error">${l(t.message)}</div>`;return}if(!e.length){n.innerHTML='<div id="emptyMsg">Миров ещё нет — создай первый ниже.</div>';return}n.innerHTML=e.map(w).join(""),n.querySelectorAll(".launch-btn").forEach(t=>{t.onclick=async()=>{t.disabled=!0,t.textContent="Запускаю…";try{await g(t.dataset.id),location.href="/dm.html"}catch(a){s(a.message),t.disabled=!1,t.textContent="Запустить"}}}),n.querySelectorAll(".open-btn").forEach(t=>{t.onclick=()=>{location.href="/dm.html"}}),n.querySelectorAll(".delete-btn").forEach(t=>{t.onclick=async()=>{if(await f("Удалить этот мир из списка?",{title:"Удалить мир",okLabel:"Удалить",danger:!0,hint:"Файлы на диске не трогаются."}))try{await h(t.dataset.id),r()}catch(a){s(a.message)}}})}document.getElementById("logoutBtn").onclick=async()=>{await i(),location.href="/"};d.addEventListener("submit",async e=>{e.preventDefault(),o.textContent="",o.className="msg";const t=document.getElementById("worldName").value.trim(),a=document.getElementById("worldSystem").value;try{await m(t,a),d.reset(),r()}catch(c){o.textContent=c.message,o.className="msg error"}});u().then(e=>{if(!e||e.role!=="admin"){location.href="/";return}r()});
