import{i as N,l as $}from"./icons-tuMIUs4Z.js";import{l as P,d as _}from"./stat-editor-BV7iVGm9.js";import{g as j}from"./condition-glyphs--FpfEy0z.js";function W(e,n){const a=String(e||"").trim().replace(/\s+/g,"").replace(/[‒–—―−]/g,"-");if(!a)return null;if(/^[+-]\d+$/.test(a)){const l=parseInt(a,10);return{delta:l,value:n+l}}return/^\d+$/.test(a)?{delta:null,value:parseInt(a,10)}:null}function X(e,{getState:n,onPreview:a,onCommit:l}){e&&e.addEventListener("pointerdown",i=>{if(i.button!==0)return;const{current:t,max:r}=n();if(!(r>0))return;i.preventDefault();const p=e.getBoundingClientRect(),d=u=>{const o=Math.max(0,Math.min(1,(u-p.left)/p.width));return Math.round(o*r)};let g=d(i.clientX);a(g);const h=u=>{const o=d(u.clientX);o!==g&&(g=o,a(g))},v=()=>{window.removeEventListener("pointermove",h),window.removeEventListener("pointerup",v),window.removeEventListener("pointercancel",v),g!==t?l(g):a(null)};window.addEventListener("pointermove",h),window.addEventListener("pointerup",v),window.addEventListener("pointercancel",v)})}function q({current:e,temp:n,max:a}){if(!(a>0))return{hp:0,temp:0};const l=Math.max(0,Math.min(1,(e||0)/a)),i=Math.max(0,Math.min(1-l,(n||0)/a));return{hp:l,temp:i}}function Q(e){return e>.5?"var(--green-bright, #5fd08a)":e>.25?"var(--gold, #e0c95a)":"#d9534f"}const B=`
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
.status-cell .cond-glyph { color: var(--cell-color, var(--text)); display: inline-flex; line-height: 1; }
.status-cell .cond-glyph svg { width: 60%; height: 60%; min-width: 18px; min-height: 18px; }
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
.status-chip .cond-glyph { color: var(--chip-color, var(--text)); display: inline-flex; line-height: 1; }
.status-chip .cond-glyph svg { width: 13px; height: 13px; }
.status-chip-add {
  display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px;
  border-radius: var(--radius-pill); border: 1px dashed var(--border); background: none;
  color: var(--text-dim); cursor: pointer; padding: 0;
}
.status-chip-add:hover { color: var(--text); border-color: var(--text-dim); }
`;let S=!1;function L(){if(S)return;S=!0;const e=document.createElement("style");e.textContent=B,document.head.appendChild(e)}let y=null,C=null;async function H(){return y||(C||(C=$().then(e=>(y=Array.isArray(e)?e:[],y)).catch(()=>[]).finally(()=>{C=null})),C)}function A(){y=null}let M=!1;document.addEventListener("vtt:combatState",e=>{M=!!(e.detail&&e.detail.showBuiltinCards)});window.addEventListener("message",e=>{e.data&&e.data.type==="beacon:conditionSaved"&&A()});function z(e,n){if(e&&e.imageUrl){const a=document.createElement("img");return a.src=e.imageUrl,a.alt=n||"",a}return j(e&&e.icon,"")}function R(e){return e.tokenId?{tokenId:e.tokenId}:{combatantId:e.combatantId}}function T(e){return Array.isArray(e.tokenIds)?e.tokenIds.map(n=>({tokenId:n})):[R(e)]}function w(e,n,a,l){for(const i of T(n))e({type:a,...i,...l})}function G(e,{onAdd:n,onRemove:a,addTitle:l}={}){L();const i=document.createElement("div");i.className="status-chips";for(const t of e||[]){const r=document.createElement("span");r.className="status-chip"+(a?" clickable":""),t.color&&r.style.setProperty("--chip-color",t.color),r.appendChild(z(t,t.name));const p=document.createElement("span");p.textContent=t.name+(t.level?` ${t.level}`:"")+(t.rounds?` · ${t.rounds}р`:""),r.appendChild(p);const d=[t.source,t.hidden?"только для ДМ":""].filter(Boolean);r.title=d.length?`${t.name} (${d.join("; ")})`:t.name,t.hidden&&(r.style.opacity="0.6"),a&&(r.onclick=()=>a(t)),i.appendChild(r)}if(n){const t=document.createElement("button");t.type="button",t.className="status-chip-add",t.innerHTML=N("plus",{size:12}),t.title=l||"Наложить состояние",t.onclick=r=>{r.stopPropagation(),n(r)},i.appendChild(t)}return i}let x=null;function k(){x&&(x.el.remove(),x=null)}function J(){x&&E(x)}async function K({x:e,y:n,target:a,send:l,statusesFor:i,title:t}){L(),k();const r=document.createElement("div");r.className="status-palette",document.body.appendChild(r),x={el:r,x:e,y:n,target:a,send:l,statusesFor:i,title:t,detailSlug:"",filter:""},I(r,e,n),r.textContent="Загрузка…",await Promise.all([H(),P()]),!(!x||x.el!==r)&&E(x)}function I(e,n,a){const l=e.offsetWidth||296,i=e.offsetHeight||320,t=Math.max(8,Math.min(n,window.innerWidth-l-8)),r=Math.max(8,Math.min(a,window.innerHeight-i-8));e.style.left=t+"px",e.style.top=r+"px"}function E(e){const{el:n,send:a,target:l}=e,i=e.statusesFor()||[],t=new Map(i.map(o=>[o.slug,o]));n.innerHTML="";const r=document.createElement("div");r.className="status-palette-head";const p=document.createElement("input");p.type="search",p.placeholder=e.title?`Состояния — ${e.title}`:"Состояние…",p.value=e.filter,p.oninput=()=>{e.filter=p.value,E(e);const o=n.querySelector(".status-palette-head input");o&&(o.focus(),o.setSelectionRange(o.value.length,o.value.length))};const d=document.createElement("button");d.type="button",d.className="status-palette-close",d.innerHTML=N("close",{size:14}),d.title="Закрыть",d.onclick=k,r.append(p,d),n.appendChild(r);const g=e.filter.trim().toLowerCase(),h=(y||[]).filter(o=>(M||!o.system)&&(!g||[o.name,o.slug,...o.tags||[]].join(" ").toLowerCase().includes(g)));if(h.length===0){const o=document.createElement("p");o.className="status-palette-empty",o.textContent=y&&y.length?"Ничего не найдено.":"В этом мире ещё нет состояний — заведи их в конструкторе (Компендиум → Состояния).",n.appendChild(o)}else{const o=document.createElement("div");o.className="status-palette-grid";for(const s of h){const f=s.slug||"",c=t.get(f),m=document.createElement("div");if(m.className="status-cell"+(c?" active":""),s.color&&m.style.setProperty("--cell-color",s.color),m.appendChild(z(s,s.name)),m.title=`${s.name}
ЛКМ — повесить/снять, ПКМ — подробности`,c&&c.level){const b=document.createElement("span");b.className="status-cell-level",b.textContent=c.level,m.appendChild(b)}if(c&&c.rounds){const b=document.createElement("span");b.className="status-cell-rounds",b.textContent=c.rounds,m.appendChild(b)}f?(m.onclick=()=>{c?w(a,l,"remove_status",{statusSlug:f}):w(a,l,"apply_status",{statusSlug:f}),e.detailSlug=""},m.oncontextmenu=b=>{b.preventDefault(),e.detailSlug=e.detailSlug===f?"":f,E(e)}):(m.style.cursor="not-allowed",m.title=`${s.name}
Карточка ещё не сохранена.`),o.appendChild(m)}n.appendChild(o)}if(e.detailSlug){const o=(y||[]).find(s=>s.slug===e.detailSlug);o&&n.appendChild(D(o,t.get(o.slug),e))}const v=document.createElement("div");v.className="status-palette-foot";const u=document.createElement("button");u.type="button",u.textContent="Снять все",u.disabled=i.length===0,u.onclick=()=>w(a,l,"clear_statuses",{}),v.appendChild(u),n.appendChild(v),I(n,e.x,e.y)}function D(e,n,a){const{send:l,target:i}=a,t=document.createElement("div");t.className="status-palette-detail";const r=document.createElement("h4");r.textContent=e.name,t.appendChild(r);const p=n?n.modifiers||[]:e.modifiers||[];for(const s of p){const f=document.createElement("p");f.textContent="▸ "+_(s),f.style.color="var(--text)",t.appendChild(f)}if(e.mechanics){const s=document.createElement("p");s.textContent=e.mechanics,t.appendChild(s)}if(!n){const s=document.createElement("p");return s.textContent="Не наложено. ЛКМ по иконке — повесить.",t.appendChild(s),t}if(e.levels>1){const s=document.createElement("div");s.className="status-palette-row";const f=document.createElement("span");f.textContent=`Уровень (0–${e.levels}):`;const c=document.createElement("input");c.type="number",c.min="0",c.max=String(e.levels),c.value=String(n.level||0),c.title="0 — снять состояние целиком",c.onchange=()=>{const m=parseInt(c.value,10);Number.isNaN(m)||w(l,i,"set_status_level",{statusSlug:e.slug,level:m})},s.append(f,c),t.appendChild(s)}const d=document.createElement("div");d.className="status-palette-row";const g=document.createElement("span");g.textContent="Раундов:";const h=document.createElement("input");h.type="number",h.min="0",h.value=String(n.rounds||0),h.title="0 — бессрочно. Счётчик уменьшается в начале хода этого бойца.",h.onchange=()=>{const s=parseInt(h.value,10);Number.isNaN(s)||w(l,i,"set_status_rounds",{statusSlug:e.slug,rounds:s})},d.append(g,h),t.appendChild(d);const v=document.createElement("label");v.className="status-palette-row";const u=document.createElement("input");u.type="checkbox",u.className="switch",u.checked=!!n.hidden,u.onchange=()=>w(l,i,"apply_status",{statusSlug:e.slug,rounds:n.rounds||0,level:n.level||0,hidden:u.checked,source:n.source||""});const o=document.createElement("span");if(o.textContent="видно только ДМ",v.append(u,o),t.appendChild(v),n.source){const s=document.createElement("p");s.textContent="Источник: "+n.source,t.appendChild(s)}return t}document.addEventListener("pointerdown",e=>{x&&!x.el.contains(e.target)&&k()},!0);document.addEventListener("keydown",e=>{e.key==="Escape"&&k()});export{X as a,Q as b,J as c,q as h,K as o,W as p,G as r};
