import{c as $}from"./api-BQXXM-FP.js";import{i as z}from"./icons-3nongrBp.js";const I=`
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
`;let S=!1;function L(){if(S)return;S=!0;const e=document.createElement("style");e.textContent=I,document.head.appendChild(e)}let v=null,w=null;async function M(){return v||(w||(w=$().then(e=>(v=Array.isArray(e)?e:[],v)).catch(()=>[]).finally(()=>{w=null})),w)}function _(){v=null}window.addEventListener("message",e=>{e.data&&e.data.type==="beacon:conditionSaved"&&_()});function P(e,o){if(e&&e.imageUrl){const s=document.createElement("img");return s.src=e.imageUrl,s.alt=o||"",s}const l=document.createElement("span");return l.textContent=e&&e.icon||"❔",l}function C(e){return e.tokenId?{tokenId:e.tokenId}:{combatantId:e.combatantId}}function T(e,{onAdd:o,onRemove:l,addTitle:s}={}){L();const i=document.createElement("div");i.className="status-chips";for(const t of e||[]){const a=document.createElement("span");a.className="status-chip"+(l?" clickable":""),t.color&&a.style.setProperty("--chip-color",t.color),a.appendChild(P(t,t.name));const c=document.createElement("span");c.textContent=t.name+(t.level?` ${t.level}`:"")+(t.rounds?` · ${t.rounds}р`:""),a.appendChild(c);const d=[t.source,t.hidden?"только для ДМ":""].filter(Boolean);a.title=d.length?`${t.name} (${d.join("; ")})`:t.name,t.hidden&&(a.style.opacity="0.6"),l&&(a.onclick=()=>l(t)),i.appendChild(a)}if(o){const t=document.createElement("button");t.type="button",t.className="status-chip-add",t.innerHTML=z("plus",{size:12}),t.title=s||"Наложить состояние",t.onclick=a=>{a.stopPropagation(),o(a)},i.appendChild(t)}return i}let h=null;function k(){h&&(h.el.remove(),h=null)}function F(){h&&E(h)}async function U({x:e,y:o,target:l,send:s,statusesFor:i,title:t}){L(),k();const a=document.createElement("div");a.className="status-palette",document.body.appendChild(a),h={el:a,target:l,send:s,statusesFor:i,title:t,detailSlug:"",filter:""},N(a,e,o),a.textContent="Загрузка…",await M(),!(!h||h.el!==a)&&(E(h),N(a,e,o))}function N(e,o,l){const s=e.offsetWidth||296,i=e.offsetHeight||320,t=Math.max(8,Math.min(o,window.innerWidth-s-8)),a=Math.max(8,Math.min(l,window.innerHeight-i-8));e.style.left=t+"px",e.style.top=a+"px"}function E(e){const{el:o,send:l,target:s}=e,i=e.statusesFor()||[],t=new Map(i.map(n=>[n.slug,n]));o.innerHTML="";const a=document.createElement("div");a.className="status-palette-head";const c=document.createElement("input");c.type="search",c.placeholder=e.title?`Состояния — ${e.title}`:"Состояние…",c.value=e.filter,c.oninput=()=>{e.filter=c.value,E(e);const n=o.querySelector(".status-palette-head input");n&&(n.focus(),n.setSelectionRange(n.value.length,n.value.length))};const d=document.createElement("button");d.type="button",d.className="status-palette-close",d.innerHTML=z("close",{size:14}),d.title="Закрыть",d.onclick=k,a.append(c,d),o.appendChild(a);const f=e.filter.trim().toLowerCase(),y=(v||[]).filter(n=>!f||[n.name,n.slug,...n.tags||[]].join(" ").toLowerCase().includes(f));if(y.length===0){const n=document.createElement("p");n.className="status-palette-empty",n.textContent=v&&v.length?"Ничего не найдено.":"В этом мире ещё нет состояний — заведи их в конструкторе (Компендиум → Состояния).",o.appendChild(n)}else{const n=document.createElement("div");n.className="status-palette-grid";for(const u of y){const r=u.slug||"",p=t.get(r),m=document.createElement("div");if(m.className="status-cell"+(p?" active":""),u.color&&m.style.setProperty("--cell-color",u.color),m.appendChild(P(u,u.name)),m.title=`${u.name}${r?` (${r})`:""}
ЛКМ — повесить/снять, ПКМ — подробности`,p&&p.level){const x=document.createElement("span");x.className="status-cell-level",x.textContent=p.level,m.appendChild(x)}if(p&&p.rounds){const x=document.createElement("span");x.className="status-cell-rounds",x.textContent=p.rounds,m.appendChild(x)}r?(m.onclick=()=>{l(p?{type:"remove_status",...C(s),statusSlug:r}:{type:"apply_status",...C(s),statusSlug:r}),e.detailSlug=""},m.oncontextmenu=x=>{x.preventDefault(),e.detailSlug=e.detailSlug===r?"":r,E(e)}):(m.style.cursor="not-allowed",m.title=`${u.name}
У карточки не заполнен slug — заполни его в конструкторе, иначе состояние не на что повесить.`),n.appendChild(m)}o.appendChild(n)}if(e.detailSlug){const n=(v||[]).find(u=>u.slug===e.detailSlug);n&&o.appendChild(j(n,t.get(n.slug),e))}const g=document.createElement("div");g.className="status-palette-foot";const b=document.createElement("button");b.type="button",b.textContent="Снять все",b.disabled=i.length===0,b.onclick=()=>l({type:"clear_statuses",...C(s)}),g.appendChild(b),o.appendChild(g)}function j(e,o,l){const{send:s,target:i}=l,t=document.createElement("div");t.className="status-palette-detail";const a=document.createElement("h4");if(a.textContent=e.name,t.appendChild(a),e.mechanics){const n=document.createElement("p");n.textContent=e.mechanics,t.appendChild(n)}if(!o){const n=document.createElement("p");return n.textContent="Не наложено. ЛКМ по иконке — повесить.",t.appendChild(n),t}if(e.levels>1){const n=document.createElement("div");n.className="status-palette-row";const u=document.createElement("span");u.textContent=`Уровень (0–${e.levels}):`;const r=document.createElement("input");r.type="number",r.min="0",r.max=String(e.levels),r.value=String(o.level||0),r.title="0 — снять состояние целиком",r.onchange=()=>{const p=parseInt(r.value,10);Number.isNaN(p)||s({type:"set_status_level",...C(i),statusSlug:e.slug,level:p})},n.append(u,r),t.appendChild(n)}const c=document.createElement("div");c.className="status-palette-row";const d=document.createElement("span");d.textContent="Раундов:";const f=document.createElement("input");f.type="number",f.min="0",f.value=String(o.rounds||0),f.title="0 — бессрочно. Счётчик уменьшается в начале хода этого бойца.",f.onchange=()=>{const n=parseInt(f.value,10);Number.isNaN(n)||s({type:"set_status_rounds",...C(i),statusSlug:e.slug,rounds:n})},c.append(d,f),t.appendChild(c);const y=document.createElement("label");y.className="status-palette-row";const g=document.createElement("input");g.type="checkbox",g.checked=!!o.hidden,g.onchange=()=>s({type:"apply_status",...C(i),statusSlug:e.slug,rounds:o.rounds||0,level:o.level||0,hidden:g.checked,source:o.source||""});const b=document.createElement("span");if(b.textContent="видно только ДМ",y.append(g,b),t.appendChild(y),o.source){const n=document.createElement("p");n.textContent="Источник: "+o.source,t.appendChild(n)}return t}document.addEventListener("pointerdown",e=>{h&&!h.el.contains(e.target)&&k()},!0);document.addEventListener("keydown",e=>{e.key==="Escape"&&k()});export{F as a,U as o,T as r};
