import{H as c,au as m,m as u,av as y,aw as g,ax as h}from"./api-CwnEFZ2M.js";import{s,b as f}from"./modal-CY9_0aAs.js";import"./icons-B8E5VJBp.js";const n=document.getElementById("list"),d=document.getElementById("createForm"),o=document.getElementById("createMsg"),v={"dnd5e-2024":"D&D 2024","dnd5e-2014":"D&D 5e (2014)"};function p(t){return v[t]||t}function i(t){const e=document.createElement("div");return e.textContent=t,e.innerHTML}function w(t){const e=t.active?'<span class="pill-badge on">Активен</span>':"",a=t.active?`<button class="world-btn open-btn" data-id="${t.id}">Открыть стол →</button>`:`<button class="world-btn launch-btn" data-id="${t.id}">Запустить</button>`;return`
    <div class="row-card world-card" data-id="${t.id}">
      <div class="world-info">
        <div class="world-name">${i(t.name)}</div>
        <div class="world-meta">
          <span class="pill-badge">${p(t.system)}</span>
          ${e}
        </div>
      </div>
      <div class="world-actions">
        ${a}
        <button class="icon-btn danger delete-btn" data-id="${t.id}" title="Удалить">✕</button>
      </div>
    </div>
  `}async function r(){let t;try{t=await y()}catch(e){n.innerHTML=`<div class="msg error">${i(e.message)}</div>`;return}if(!t.length){n.innerHTML='<div id="emptyMsg">Миров ещё нет — создай первый ниже.</div>';return}n.innerHTML=t.map(w).join(""),n.querySelectorAll(".launch-btn").forEach(e=>{e.onclick=async()=>{e.disabled=!0,e.textContent="Запускаю…";try{await g(e.dataset.id),location.href="/dm.html"}catch(a){s(a.message),e.disabled=!1,e.textContent="Запустить"}}}),n.querySelectorAll(".open-btn").forEach(e=>{e.onclick=()=>{location.href="/dm.html"}}),n.querySelectorAll(".delete-btn").forEach(e=>{e.onclick=async()=>{if(await f("Удалить этот мир из списка?",{title:"Удалить мир",okLabel:"Удалить",danger:!0,hint:"Файлы на диске не трогаются."}))try{await h(e.dataset.id),r()}catch(a){s(a.message)}}})}document.getElementById("logoutBtn").onclick=async()=>{await c(),location.href="/"};d.addEventListener("submit",async t=>{t.preventDefault(),o.textContent="",o.className="msg";const e=document.getElementById("worldName").value.trim(),a=document.getElementById("worldSystem").value;try{await m(e,a),d.reset(),r()}catch(l){o.textContent=l.message,o.className="msg error"}});u().then(t=>{if(!t||t.role!=="admin"){location.href="/";return}r()});
