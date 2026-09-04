import{i as $}from"./api-BciOZEr1.js";import{i as N}from"./modal-g49pjxWl.js";import{l as P,d as _}from"./modifier-editor-VRFCohqV.js";function V(e,n){const o=String(e||"").trim().replace(/\s+/g,"").replace(/[‒–—―−]/g,"-");if(!o)return null;if(/^[+-]\d+$/.test(o)){const s=parseInt(o,10);return{delta:s,value:n+s}}return/^\d+$/.test(o)?{delta:null,value:parseInt(o,10)}:null}function W(e,{getState:n,onPreview:o,onCommit:s}){e&&e.addEventListener("pointerdown",i=>{if(i.button!==0)return;const{current:t,max:r}=n();if(!(r>0))return;i.preventDefault();const m=e.getBoundingClientRect(),d=u=>{const a=Math.max(0,Math.min(1,(u-m.left)/m.width));return Math.round(a*r)};let v=d(i.clientX);o(v);const h=u=>{const a=d(u.clientX);a!==v&&(v=a,o(v))},g=()=>{window.removeEventListener("pointermove",h),window.removeEventListener("pointerup",g),window.removeEventListener("pointercancel",g),v!==t?s(v):o(null)};window.addEventListener("pointermove",h),window.addEventListener("pointerup",g),window.addEventListener("pointercancel",g)})}function X({current:e,temp:n,max:o}){if(!(o>0))return{hp:0,temp:0};const s=Math.max(0,Math.min(1,(e||0)/o)),i=Math.max(0,Math.min(1-s,(n||0)/o));return{hp:s,temp:i}}function q(e){return e>.5?"var(--green-bright, #5fd08a)":e>.25?"var(--gold, #e0c95a)":"#d9534f"}const j=`
.status-palette {
  position: fixed; z-index: 60; width: 296px; max-height: 72vh; overflow: auto;
  display: flex; flex-direction: column; gap: 8px; padding: 10px;
  background: var(--glass-bg-strong); backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--glass-border); border-radius: var(--radius);
  box-shadow: var(--shadow-float); color: var(--text); font-size: 13px;
}
.status-palette-head { display: flex; align-items: center; gap: 6px; }
.status-palette-head input {
  flex: 1; min-width: 0; padding: 5px 8px; border-radius: var(--radius);
  border: 1px solid var(--border); background: var(--surface); color: var(--text);
}
.status-palette-close { background: none; border: none; color: var(--text-dim); cursor: pointer; padding: 2px; }
.status-palette-close:hover { color: var(--text); }
.status-palette-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 5px; }
.status-cell {
  position: relative; aspect-ratio: 1; display: flex; align-items: center; justify-content: center;
  font-size: 19px; line-height: 1; cursor: pointer; user-select: none;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--surface); opacity: 0.5; transition: opacity .12s, box-shadow .12s;
}
.status-cell:hover { opacity: 0.85; background: var(--surface-hover); }
.status-cell.active { opacity: 1; box-shadow: inset 0 0 0 2px var(--cell-color, var(--accent)); }
.status-cell img { width: 76%; height: 76%; object-fit: contain; }
.status-cell-level {
  position: absolute; right: 1px; bottom: 0; font-size: 10px; font-weight: 700;
  padding: 0 3px; border-radius: var(--radius-pill); background: var(--bg); color: var(--text);
}
.status-cell-rounds {
  position: absolute; left: 1px; top: 0; font-size: 9px; padding: 0 3px;
  border-radius: var(--radius-pill); background: var(--bg); color: var(--text-dim);
}
.status-palette-detail {
  display: flex; flex-direction: column; gap: 6px; padding: 8px;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel-bg);
}
.status-palette-detail h4 { margin: 0; font-size: 13px; }
.status-palette-detail p { margin: 0; font-size: 12px; color: var(--text-dim); }
.status-palette-row { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.status-palette-row input[type="number"] {
  width: 62px; padding: 3px 5px; border-radius: var(--radius);
  border: 1px solid var(--border); background: var(--surface); color: var(--text);
}
.status-palette-foot { display: flex; gap: 6px; }
.status-palette-foot button {
  flex: 1; padding: 5px 8px; border-radius: var(--radius); border: 1px solid var(--border);
  background: var(--surface); color: var(--text); cursor: pointer; font-size: 12px;
}
.status-palette-foot button:hover { background: var(--surface-hover); }
.status-palette-empty { color: var(--text-dim); font-size: 12px; margin: 0; }
/* чипы наложенных меток — карточка бойца в трекере, лист персонажа */
.status-chips { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.status-chip {
  display: inline-flex; align-items: center; gap: 3px; padding: 1px 6px 1px 4px;
  border-radius: var(--radius-pill); background: var(--surface); color: var(--text);
  border: 1px solid var(--chip-color, var(--border)); font-size: 11px; line-height: 1.6;
  cursor: default; max-width: 100%;
}
.status-chip.clickable { cursor: pointer; }
.status-chip.clickable:hover { background: var(--surface-hover); }
.status-chip img { width: 12px; height: 12px; object-fit: contain; }
.status-chip-add {
  display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px;
  border-radius: var(--radius-pill); border: 1px dashed var(--border); background: none;
  color: var(--text-dim); cursor: pointer; padding: 0;
}
.status-chip-add:hover { color: var(--text); border-color: var(--text-dim); }
`;let S=!1;function L(){if(S)return;S=!0;const e=document.createElement("style");e.textContent=j,document.head.appendChild(e)}let y=null,C=null;async function B(){return y||(C||(C=$().then(e=>(y=Array.isArray(e)?e:[],y)).catch(()=>[]).finally(()=>{C=null})),C)}function H(){y=null}let M=!1;document.addEventListener("vtt:combatState",e=>{M=!!(e.detail&&e.detail.showBuiltinCards)});window.addEventListener("message",e=>{e.data&&e.data.type==="beacon:conditionSaved"&&H()});function z(e,n){if(e&&e.imageUrl){const s=document.createElement("img");return s.src=e.imageUrl,s.alt=n||"",s}const o=document.createElement("span");return o.textContent=e&&e.icon||"❔",o}function A(e){return e.tokenId?{tokenId:e.tokenId}:{combatantId:e.combatantId}}function R(e){return Array.isArray(e.tokenIds)?e.tokenIds.map(n=>({tokenId:n})):[A(e)]}function w(e,n,o,s){for(const i of R(n))e({type:o,...i,...s})}function Q(e,{onAdd:n,onRemove:o,addTitle:s}={}){L();const i=document.createElement("div");i.className="status-chips";for(const t of e||[]){const r=document.createElement("span");r.className="status-chip"+(o?" clickable":""),t.color&&r.style.setProperty("--chip-color",t.color),r.appendChild(z(t,t.name));const m=document.createElement("span");m.textContent=t.name+(t.level?` ${t.level}`:"")+(t.rounds?` · ${t.rounds}р`:""),r.appendChild(m);const d=[t.source,t.hidden?"только для ДМ":""].filter(Boolean);r.title=d.length?`${t.name} (${d.join("; ")})`:t.name,t.hidden&&(r.style.opacity="0.6"),o&&(r.onclick=()=>o(t)),i.appendChild(r)}if(n){const t=document.createElement("button");t.type="button",t.className="status-chip-add",t.innerHTML=N("plus",{size:12}),t.title=s||"Наложить состояние",t.onclick=r=>{r.stopPropagation(),n(r)},i.appendChild(t)}return i}let x=null;function k(){x&&(x.el.remove(),x=null)}function G(){x&&E(x)}async function J({x:e,y:n,target:o,send:s,statusesFor:i,title:t}){L(),k();const r=document.createElement("div");r.className="status-palette",document.body.appendChild(r),x={el:r,x:e,y:n,target:o,send:s,statusesFor:i,title:t,detailSlug:"",filter:""},I(r,e,n),r.textContent="Загрузка…",await Promise.all([B(),P()]),!(!x||x.el!==r)&&E(x)}function I(e,n,o){const s=e.offsetWidth||296,i=e.offsetHeight||320,t=Math.max(8,Math.min(n,window.innerWidth-s-8)),r=Math.max(8,Math.min(o,window.innerHeight-i-8));e.style.left=t+"px",e.style.top=r+"px"}function E(e){const{el:n,send:o,target:s}=e,i=e.statusesFor()||[],t=new Map(i.map(a=>[a.slug,a]));n.innerHTML="";const r=document.createElement("div");r.className="status-palette-head";const m=document.createElement("input");m.type="search",m.placeholder=e.title?`Состояния — ${e.title}`:"Состояние…",m.value=e.filter,m.oninput=()=>{e.filter=m.value,E(e);const a=n.querySelector(".status-palette-head input");a&&(a.focus(),a.setSelectionRange(a.value.length,a.value.length))};const d=document.createElement("button");d.type="button",d.className="status-palette-close",d.innerHTML=N("close",{size:14}),d.title="Закрыть",d.onclick=k,r.append(m,d),n.appendChild(r);const v=e.filter.trim().toLowerCase(),h=(y||[]).filter(a=>(M||!a.system)&&(!v||[a.name,a.slug,...a.tags||[]].join(" ").toLowerCase().includes(v)));if(h.length===0){const a=document.createElement("p");a.className="status-palette-empty",a.textContent=y&&y.length?"Ничего не найдено.":"В этом мире ещё нет состояний — заведи их в конструкторе (Компендиум → Состояния).",n.appendChild(a)}else{const a=document.createElement("div");a.className="status-palette-grid";for(const l of h){const p=l.slug||"",c=t.get(p),f=document.createElement("div");if(f.className="status-cell"+(c?" active":""),l.color&&f.style.setProperty("--cell-color",l.color),f.appendChild(z(l,l.name)),f.title=`${l.name}${p?` (${p})`:""}
ЛКМ — повесить/снять, ПКМ — подробности`,c&&c.level){const b=document.createElement("span");b.className="status-cell-level",b.textContent=c.level,f.appendChild(b)}if(c&&c.rounds){const b=document.createElement("span");b.className="status-cell-rounds",b.textContent=c.rounds,f.appendChild(b)}p?(f.onclick=()=>{c?w(o,s,"remove_status",{statusSlug:p}):w(o,s,"apply_status",{statusSlug:p}),e.detailSlug=""},f.oncontextmenu=b=>{b.preventDefault(),e.detailSlug=e.detailSlug===p?"":p,E(e)}):(f.style.cursor="not-allowed",f.title=`${l.name}
У карточки не заполнен slug — заполни его в конструкторе, иначе состояние не на что повесить.`),a.appendChild(f)}n.appendChild(a)}if(e.detailSlug){const a=(y||[]).find(l=>l.slug===e.detailSlug);a&&n.appendChild(T(a,t.get(a.slug),e))}const g=document.createElement("div");g.className="status-palette-foot";const u=document.createElement("button");u.type="button",u.textContent="Снять все",u.disabled=i.length===0,u.onclick=()=>w(o,s,"clear_statuses",{}),g.appendChild(u),n.appendChild(g),I(n,e.x,e.y)}function T(e,n,o){const{send:s,target:i}=o,t=document.createElement("div");t.className="status-palette-detail";const r=document.createElement("h4");r.textContent=e.name,t.appendChild(r);const m=n?n.modifiers||[]:e.modifiers||[];for(const l of m){const p=document.createElement("p");p.textContent="▸ "+_(l),p.style.color="var(--text)",t.appendChild(p)}if(e.mechanics){const l=document.createElement("p");l.textContent=e.mechanics,t.appendChild(l)}if(!n){const l=document.createElement("p");return l.textContent="Не наложено. ЛКМ по иконке — повесить.",t.appendChild(l),t}if(e.levels>1){const l=document.createElement("div");l.className="status-palette-row";const p=document.createElement("span");p.textContent=`Уровень (0–${e.levels}):`;const c=document.createElement("input");c.type="number",c.min="0",c.max=String(e.levels),c.value=String(n.level||0),c.title="0 — снять состояние целиком",c.onchange=()=>{const f=parseInt(c.value,10);Number.isNaN(f)||w(s,i,"set_status_level",{statusSlug:e.slug,level:f})},l.append(p,c),t.appendChild(l)}const d=document.createElement("div");d.className="status-palette-row";const v=document.createElement("span");v.textContent="Раундов:";const h=document.createElement("input");h.type="number",h.min="0",h.value=String(n.rounds||0),h.title="0 — бессрочно. Счётчик уменьшается в начале хода этого бойца.",h.onchange=()=>{const l=parseInt(h.value,10);Number.isNaN(l)||w(s,i,"set_status_rounds",{statusSlug:e.slug,rounds:l})},d.append(v,h),t.appendChild(d);const g=document.createElement("label");g.className="status-palette-row";const u=document.createElement("input");u.type="checkbox",u.checked=!!n.hidden,u.onchange=()=>w(s,i,"apply_status",{statusSlug:e.slug,rounds:n.rounds||0,level:n.level||0,hidden:u.checked,source:n.source||""});const a=document.createElement("span");if(a.textContent="видно только ДМ",g.append(u,a),t.appendChild(g),n.source){const l=document.createElement("p");l.textContent="Источник: "+n.source,t.appendChild(l)}return t}document.addEventListener("pointerdown",e=>{x&&!x.el.contains(e.target)&&k()},!0);document.addEventListener("keydown",e=>{e.key==="Escape"&&k()});export{W as a,q as b,G as c,X as h,J as o,V as p,Q as r};
