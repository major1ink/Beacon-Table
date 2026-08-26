import{j as I}from"./api-m72PrEiY.js";import{i as L}from"./modal-ClzvMhHz.js";import{l as $,d as P}from"./modifier-editor-CEELzg08.js";function U(e,a){const o=String(e||"").trim().replace(/\s+/g,"").replace(/[‒–—―−]/g,"-");if(!o)return null;if(/^[+-]\d+$/.test(o)){const s=parseInt(o,10);return{delta:s,value:a+s}}return/^\d+$/.test(o)?{delta:null,value:parseInt(o,10)}:null}function V(e,{getState:a,onPreview:o,onCommit:s}){e&&e.addEventListener("pointerdown",l=>{if(l.button!==0)return;const{current:n,max:r}=a();if(!(r>0))return;l.preventDefault();const d=e.getBoundingClientRect(),p=f=>{const t=Math.max(0,Math.min(1,(f-d.left)/d.width));return Math.round(t*r)};let i=p(l.clientX);o(i);const x=f=>{const t=p(f.clientX);t!==i&&(i=t,o(i))},m=()=>{window.removeEventListener("pointermove",x),window.removeEventListener("pointerup",m),window.removeEventListener("pointercancel",m),i!==n?s(i):o(null)};window.addEventListener("pointermove",x),window.addEventListener("pointerup",m),window.addEventListener("pointercancel",m)})}function W({current:e,temp:a,max:o}){if(!(o>0))return{hp:0,temp:0};const s=Math.max(0,Math.min(1,(e||0)/o)),l=Math.max(0,Math.min(1-s,(a||0)/o));return{hp:s,temp:l}}function X(e){return e>.5?"var(--green-bright, #5fd08a)":e>.25?"var(--gold, #e0c95a)":"#d9534f"}const j=`
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
`;let S=!1;function M(){if(S)return;S=!0;const e=document.createElement("style");e.textContent=j,document.head.appendChild(e)}let y=null,C=null;async function _(){return y||(C||(C=I().then(e=>(y=Array.isArray(e)?e:[],y)).catch(()=>[]).finally(()=>{C=null})),C)}function H(){y=null}window.addEventListener("message",e=>{e.data&&e.data.type==="beacon:conditionSaved"&&H()});function z(e,a){if(e&&e.imageUrl){const s=document.createElement("img");return s.src=e.imageUrl,s.alt=a||"",s}const o=document.createElement("span");return o.textContent=e&&e.icon||"❔",o}function A(e){return e.tokenId?{tokenId:e.tokenId}:{combatantId:e.combatantId}}function B(e){return Array.isArray(e.tokenIds)?e.tokenIds.map(a=>({tokenId:a})):[A(e)]}function w(e,a,o,s){for(const l of B(a))e({type:o,...l,...s})}function q(e,{onAdd:a,onRemove:o,addTitle:s}={}){M();const l=document.createElement("div");l.className="status-chips";for(const n of e||[]){const r=document.createElement("span");r.className="status-chip"+(o?" clickable":""),n.color&&r.style.setProperty("--chip-color",n.color),r.appendChild(z(n,n.name));const d=document.createElement("span");d.textContent=n.name+(n.level?` ${n.level}`:"")+(n.rounds?` · ${n.rounds}р`:""),r.appendChild(d);const p=[n.source,n.hidden?"только для ДМ":""].filter(Boolean);r.title=p.length?`${n.name} (${p.join("; ")})`:n.name,n.hidden&&(r.style.opacity="0.6"),o&&(r.onclick=()=>o(n)),l.appendChild(r)}if(a){const n=document.createElement("button");n.type="button",n.className="status-chip-add",n.innerHTML=L("plus",{size:12}),n.title=s||"Наложить состояние",n.onclick=r=>{r.stopPropagation(),a(r)},l.appendChild(n)}return l}let v=null;function k(){v&&(v.el.remove(),v=null)}function Q(){v&&E(v)}async function G({x:e,y:a,target:o,send:s,statusesFor:l,title:n}){M(),k();const r=document.createElement("div");r.className="status-palette",document.body.appendChild(r),v={el:r,target:o,send:s,statusesFor:l,title:n,detailSlug:"",filter:""},N(r,e,a),r.textContent="Загрузка…",await Promise.all([_(),$()]),!(!v||v.el!==r)&&(E(v),N(r,e,a))}function N(e,a,o){const s=e.offsetWidth||296,l=e.offsetHeight||320,n=Math.max(8,Math.min(a,window.innerWidth-s-8)),r=Math.max(8,Math.min(o,window.innerHeight-l-8));e.style.left=n+"px",e.style.top=r+"px"}function E(e){const{el:a,send:o,target:s}=e,l=e.statusesFor()||[],n=new Map(l.map(t=>[t.slug,t]));a.innerHTML="";const r=document.createElement("div");r.className="status-palette-head";const d=document.createElement("input");d.type="search",d.placeholder=e.title?`Состояния — ${e.title}`:"Состояние…",d.value=e.filter,d.oninput=()=>{e.filter=d.value,E(e);const t=a.querySelector(".status-palette-head input");t&&(t.focus(),t.setSelectionRange(t.value.length,t.value.length))};const p=document.createElement("button");p.type="button",p.className="status-palette-close",p.innerHTML=L("close",{size:14}),p.title="Закрыть",p.onclick=k,r.append(d,p),a.appendChild(r);const i=e.filter.trim().toLowerCase(),x=(y||[]).filter(t=>!i||[t.name,t.slug,...t.tags||[]].join(" ").toLowerCase().includes(i));if(x.length===0){const t=document.createElement("p");t.className="status-palette-empty",t.textContent=y&&y.length?"Ничего не найдено.":"В этом мире ещё нет состояний — заведи их в конструкторе (Компендиум → Состояния).",a.appendChild(t)}else{const t=document.createElement("div");t.className="status-palette-grid";for(const u of x){const c=u.slug||"",h=n.get(c),g=document.createElement("div");if(g.className="status-cell"+(h?" active":""),u.color&&g.style.setProperty("--cell-color",u.color),g.appendChild(z(u,u.name)),g.title=`${u.name}${c?` (${c})`:""}
ЛКМ — повесить/снять, ПКМ — подробности`,h&&h.level){const b=document.createElement("span");b.className="status-cell-level",b.textContent=h.level,g.appendChild(b)}if(h&&h.rounds){const b=document.createElement("span");b.className="status-cell-rounds",b.textContent=h.rounds,g.appendChild(b)}c?(g.onclick=()=>{h?w(o,s,"remove_status",{statusSlug:c}):w(o,s,"apply_status",{statusSlug:c}),e.detailSlug=""},g.oncontextmenu=b=>{b.preventDefault(),e.detailSlug=e.detailSlug===c?"":c,E(e)}):(g.style.cursor="not-allowed",g.title=`${u.name}
У карточки не заполнен slug — заполни его в конструкторе, иначе состояние не на что повесить.`),t.appendChild(g)}a.appendChild(t)}if(e.detailSlug){const t=(y||[]).find(u=>u.slug===e.detailSlug);t&&a.appendChild(R(t,n.get(t.slug),e))}const m=document.createElement("div");m.className="status-palette-foot";const f=document.createElement("button");f.type="button",f.textContent="Снять все",f.disabled=l.length===0,f.onclick=()=>w(o,s,"clear_statuses",{}),m.appendChild(f),a.appendChild(m)}function R(e,a,o){const{send:s,target:l}=o,n=document.createElement("div");n.className="status-palette-detail";const r=document.createElement("h4");r.textContent=e.name,n.appendChild(r);for(const t of e.modifiers||[]){const u=document.createElement("p");u.textContent="▸ "+P(t),u.style.color="var(--text)",n.appendChild(u)}if(e.mechanics){const t=document.createElement("p");t.textContent=e.mechanics,n.appendChild(t)}if(!a){const t=document.createElement("p");return t.textContent="Не наложено. ЛКМ по иконке — повесить.",n.appendChild(t),n}if(e.levels>1){const t=document.createElement("div");t.className="status-palette-row";const u=document.createElement("span");u.textContent=`Уровень (0–${e.levels}):`;const c=document.createElement("input");c.type="number",c.min="0",c.max=String(e.levels),c.value=String(a.level||0),c.title="0 — снять состояние целиком",c.onchange=()=>{const h=parseInt(c.value,10);Number.isNaN(h)||w(s,l,"set_status_level",{statusSlug:e.slug,level:h})},t.append(u,c),n.appendChild(t)}const d=document.createElement("div");d.className="status-palette-row";const p=document.createElement("span");p.textContent="Раундов:";const i=document.createElement("input");i.type="number",i.min="0",i.value=String(a.rounds||0),i.title="0 — бессрочно. Счётчик уменьшается в начале хода этого бойца.",i.onchange=()=>{const t=parseInt(i.value,10);Number.isNaN(t)||w(s,l,"set_status_rounds",{statusSlug:e.slug,rounds:t})},d.append(p,i),n.appendChild(d);const x=document.createElement("label");x.className="status-palette-row";const m=document.createElement("input");m.type="checkbox",m.checked=!!a.hidden,m.onchange=()=>w(s,l,"apply_status",{statusSlug:e.slug,rounds:a.rounds||0,level:a.level||0,hidden:m.checked,source:a.source||""});const f=document.createElement("span");if(f.textContent="видно только ДМ",x.append(m,f),n.appendChild(x),a.source){const t=document.createElement("p");t.textContent="Источник: "+a.source,n.appendChild(t)}return n}document.addEventListener("pointerdown",e=>{v&&!v.el.contains(e.target)&&k()},!0);document.addEventListener("keydown",e=>{e.key==="Escape"&&k()});export{V as a,X as b,Q as c,W as h,G as o,U as p,q as r};
