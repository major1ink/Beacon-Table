import{c as M}from"./api-Co19SYRS.js";import{i as z}from"./icons-3nongrBp.js";import{l as $,d as I}from"./modifier-editor-HGouSrWJ.js";const _=`
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
`;let S=!1;function P(){if(S)return;S=!0;const e=document.createElement("style");e.textContent=_,document.head.appendChild(e)}let v=null,w=null;async function j(){return v||(w||(w=M().then(e=>(v=Array.isArray(e)?e:[],v)).catch(()=>[]).finally(()=>{w=null})),w)}function H(){v=null}window.addEventListener("message",e=>{e.data&&e.data.type==="beacon:conditionSaved"&&H()});function L(e,o){if(e&&e.imageUrl){const s=document.createElement("img");return s.src=e.imageUrl,s.alt=o||"",s}const l=document.createElement("span");return l.textContent=e&&e.icon||"❔",l}function C(e){return e.tokenId?{tokenId:e.tokenId}:{combatantId:e.combatantId}}function W(e,{onAdd:o,onRemove:l,addTitle:s}={}){P();const c=document.createElement("div");c.className="status-chips";for(const n of e||[]){const a=document.createElement("span");a.className="status-chip"+(l?" clickable":""),n.color&&a.style.setProperty("--chip-color",n.color),a.appendChild(L(n,n.name));const d=document.createElement("span");d.textContent=n.name+(n.level?` ${n.level}`:"")+(n.rounds?` · ${n.rounds}р`:""),a.appendChild(d);const u=[n.source,n.hidden?"только для ДМ":""].filter(Boolean);a.title=u.length?`${n.name} (${u.join("; ")})`:n.name,n.hidden&&(a.style.opacity="0.6"),l&&(a.onclick=()=>l(n)),c.appendChild(a)}if(o){const n=document.createElement("button");n.type="button",n.className="status-chip-add",n.innerHTML=z("plus",{size:12}),n.title=s||"Наложить состояние",n.onclick=a=>{a.stopPropagation(),o(a)},c.appendChild(n)}return c}let f=null;function k(){f&&(f.el.remove(),f=null)}function q(){f&&E(f)}async function A({x:e,y:o,target:l,send:s,statusesFor:c,title:n}){P(),k();const a=document.createElement("div");a.className="status-palette",document.body.appendChild(a),f={el:a,target:l,send:s,statusesFor:c,title:n,detailSlug:"",filter:""},N(a,e,o),a.textContent="Загрузка…",await Promise.all([j(),$()]),!(!f||f.el!==a)&&(E(f),N(a,e,o))}function N(e,o,l){const s=e.offsetWidth||296,c=e.offsetHeight||320,n=Math.max(8,Math.min(o,window.innerWidth-s-8)),a=Math.max(8,Math.min(l,window.innerHeight-c-8));e.style.left=n+"px",e.style.top=a+"px"}function E(e){const{el:o,send:l,target:s}=e,c=e.statusesFor()||[],n=new Map(c.map(t=>[t.slug,t]));o.innerHTML="";const a=document.createElement("div");a.className="status-palette-head";const d=document.createElement("input");d.type="search",d.placeholder=e.title?`Состояния — ${e.title}`:"Состояние…",d.value=e.filter,d.oninput=()=>{e.filter=d.value,E(e);const t=o.querySelector(".status-palette-head input");t&&(t.focus(),t.setSelectionRange(t.value.length,t.value.length))};const u=document.createElement("button");u.type="button",u.className="status-palette-close",u.innerHTML=z("close",{size:14}),u.title="Закрыть",u.onclick=k,a.append(d,u),o.appendChild(a);const h=e.filter.trim().toLowerCase(),y=(v||[]).filter(t=>!h||[t.name,t.slug,...t.tags||[]].join(" ").toLowerCase().includes(h));if(y.length===0){const t=document.createElement("p");t.className="status-palette-empty",t.textContent=v&&v.length?"Ничего не найдено.":"В этом мире ещё нет состояний — заведи их в конструкторе (Компендиум → Состояния).",o.appendChild(t)}else{const t=document.createElement("div");t.className="status-palette-grid";for(const i of y){const r=i.slug||"",p=n.get(r),m=document.createElement("div");if(m.className="status-cell"+(p?" active":""),i.color&&m.style.setProperty("--cell-color",i.color),m.appendChild(L(i,i.name)),m.title=`${i.name}${r?` (${r})`:""}
ЛКМ — повесить/снять, ПКМ — подробности`,p&&p.level){const x=document.createElement("span");x.className="status-cell-level",x.textContent=p.level,m.appendChild(x)}if(p&&p.rounds){const x=document.createElement("span");x.className="status-cell-rounds",x.textContent=p.rounds,m.appendChild(x)}r?(m.onclick=()=>{l(p?{type:"remove_status",...C(s),statusSlug:r}:{type:"apply_status",...C(s),statusSlug:r}),e.detailSlug=""},m.oncontextmenu=x=>{x.preventDefault(),e.detailSlug=e.detailSlug===r?"":r,E(e)}):(m.style.cursor="not-allowed",m.title=`${i.name}
У карточки не заполнен slug — заполни его в конструкторе, иначе состояние не на что повесить.`),t.appendChild(m)}o.appendChild(t)}if(e.detailSlug){const t=(v||[]).find(i=>i.slug===e.detailSlug);t&&o.appendChild(T(t,n.get(t.slug),e))}const g=document.createElement("div");g.className="status-palette-foot";const b=document.createElement("button");b.type="button",b.textContent="Снять все",b.disabled=c.length===0,b.onclick=()=>l({type:"clear_statuses",...C(s)}),g.appendChild(b),o.appendChild(g)}function T(e,o,l){const{send:s,target:c}=l,n=document.createElement("div");n.className="status-palette-detail";const a=document.createElement("h4");a.textContent=e.name,n.appendChild(a);for(const t of e.modifiers||[]){const i=document.createElement("p");i.textContent="▸ "+I(t),i.style.color="var(--text)",n.appendChild(i)}if(e.mechanics){const t=document.createElement("p");t.textContent=e.mechanics,n.appendChild(t)}if(!o){const t=document.createElement("p");return t.textContent="Не наложено. ЛКМ по иконке — повесить.",n.appendChild(t),n}if(e.levels>1){const t=document.createElement("div");t.className="status-palette-row";const i=document.createElement("span");i.textContent=`Уровень (0–${e.levels}):`;const r=document.createElement("input");r.type="number",r.min="0",r.max=String(e.levels),r.value=String(o.level||0),r.title="0 — снять состояние целиком",r.onchange=()=>{const p=parseInt(r.value,10);Number.isNaN(p)||s({type:"set_status_level",...C(c),statusSlug:e.slug,level:p})},t.append(i,r),n.appendChild(t)}const d=document.createElement("div");d.className="status-palette-row";const u=document.createElement("span");u.textContent="Раундов:";const h=document.createElement("input");h.type="number",h.min="0",h.value=String(o.rounds||0),h.title="0 — бессрочно. Счётчик уменьшается в начале хода этого бойца.",h.onchange=()=>{const t=parseInt(h.value,10);Number.isNaN(t)||s({type:"set_status_rounds",...C(c),statusSlug:e.slug,rounds:t})},d.append(u,h),n.appendChild(d);const y=document.createElement("label");y.className="status-palette-row";const g=document.createElement("input");g.type="checkbox",g.checked=!!o.hidden,g.onchange=()=>s({type:"apply_status",...C(c),statusSlug:e.slug,rounds:o.rounds||0,level:o.level||0,hidden:g.checked,source:o.source||""});const b=document.createElement("span");if(b.textContent="видно только ДМ",y.append(g,b),n.appendChild(y),o.source){const t=document.createElement("p");t.textContent="Источник: "+o.source,n.appendChild(t)}return n}document.addEventListener("pointerdown",e=>{f&&!f.el.contains(e.target)&&k()},!0);document.addEventListener("keydown",e=>{e.key==="Escape"&&k()});export{q as a,A as o,W as r};
