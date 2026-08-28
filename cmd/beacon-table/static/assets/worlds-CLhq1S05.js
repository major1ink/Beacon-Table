import{G as g,af as y,ag as p,l as f,ah as h,ai as b,aj as v,ak as w}from"./api-AXxxI07i.js";import{s as l,a as E}from"./modal-g49pjxWl.js";const n=document.getElementById("list"),c=document.getElementById("createForm"),s=document.getElementById("createMsg"),i=document.getElementById("importBtn"),d=document.getElementById("importFile"),o=document.getElementById("importMsg"),C={"dnd5e-2024":"D&D 2024","dnd5e-2014":"D&D 5e (2014)"};function B(t){return C[t]||t}function m(t){const e=document.createElement("div");return e.textContent=t,e.innerHTML}function L(t){const e=t.active?'<span class="pill-badge on">Активен</span>':"",a=t.active?`<button class="world-btn open-btn" data-id="${t.id}">Открыть стол →</button>`:`<button class="world-btn launch-btn" data-id="${t.id}">Запустить</button>`;return`
    <div class="row-card world-card" data-id="${t.id}">
      <div class="world-info">
        <div class="world-name">${m(t.name)}</div>
        <div class="world-meta">
          <span class="pill-badge">${B(t.system)}</span>
          ${e}
        </div>
      </div>
      <div class="world-actions">
        ${a}
        <button class="icon-btn export-btn" data-id="${t.id}" title="Экспортировать мир в .zip">⬇</button>
        <button class="icon-btn danger delete-btn" data-id="${t.id}" title="Удалить">✕</button>
      </div>
    </div>
  `}async function r(){let t;try{t=await h()}catch(e){n.innerHTML=`<div class="msg error">${m(e.message)}</div>`;return}if(!t.length){n.innerHTML='<div id="emptyMsg">Миров ещё нет — создай первый ниже.</div>';return}n.innerHTML=t.map(L).join(""),n.querySelectorAll(".launch-btn").forEach(e=>{e.onclick=async()=>{e.disabled=!0,e.textContent="Запускаю…";try{await b(e.dataset.id),location.href="/dm.html"}catch(a){l(a.message),e.disabled=!1,e.textContent="Запустить"}}}),n.querySelectorAll(".open-btn").forEach(e=>{e.onclick=()=>{location.href="/dm.html"}}),n.querySelectorAll(".export-btn").forEach(e=>{e.onclick=()=>{window.location.href=v(e.dataset.id)}}),n.querySelectorAll(".delete-btn").forEach(e=>{e.onclick=async()=>{if(await E("Удалить этот мир из списка?",{title:"Удалить мир",okLabel:"Удалить",danger:!0,hint:"Файлы на диске не трогаются."}))try{await w(e.dataset.id),r()}catch(a){l(a.message)}}})}document.getElementById("logoutBtn").onclick=async()=>{await g(),location.href="/"};i.onclick=()=>d.click();d.addEventListener("change",async t=>{const e=t.target.files[0];if(t.target.value="",!!e){o.textContent="Импортирую…",o.className="msg",i.disabled=!0;try{const a=await y(e);o.textContent=`Мир «${a.name}» импортирован — запусти его в списке выше.`,o.className="msg ok",r()}catch(a){o.textContent=a.message,o.className="msg error"}finally{i.disabled=!1}}});c.addEventListener("submit",async t=>{t.preventDefault(),s.textContent="",s.className="msg";const e=document.getElementById("worldName").value.trim(),a=document.getElementById("worldSystem").value;try{await p(e,a),c.reset(),r()}catch(u){s.textContent=u.message,s.className="msg error"}});f().then(t=>{if(!t||t.role!=="admin"){location.href="/";return}r()});
