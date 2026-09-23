import{i as N,g as M}from"./icons-B3FNQ1jq.js";import{l as _,d as $}from"./stat-editor-D40hQ5I1.js";import{g as j}from"./condition-glyphs--FpfEy0z.js";import{a as B}from"./a11y-BN9NYDBm.js";const H=`
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
`;let S=!1;function z(){if(S)return;S=!0;const e=document.createElement("style");e.textContent=H,document.head.appendChild(e)}let v=null,w=null;async function T(){return v||(w||(w=M().then(e=>(v=Array.isArray(e)?e:[],v)).catch(()=>[]).finally(()=>{w=null})),w)}function A(){v=null}let L=!1;document.addEventListener("vtt:combatState",e=>{L=!!(e.detail&&e.detail.showBuiltinCards)});window.addEventListener("message",e=>{e.data&&e.data.type==="beacon:conditionSaved"&&A()});function P(e,n){if(e&&e.imageUrl){const r=document.createElement("img");return r.src=e.imageUrl,r.alt=n||"",r}return j(e&&e.icon,"")}function F(e){return e.tokenId?{tokenId:e.tokenId}:{combatantId:e.combatantId}}function U(e){return Array.isArray(e.tokenIds)?e.tokenIds.map(n=>({tokenId:n})):[F(e)]}function y(e,n,r,c){for(const l of U(n))e({type:r,...l,...c})}function G(e,{onAdd:n,onRemove:r,addTitle:c}={}){z();const l=document.createElement("div");l.className="status-chips";for(const t of e||[]){const s=document.createElement("span");s.className="status-chip"+(r?" clickable":""),t.color&&s.style.setProperty("--chip-color",t.color),s.appendChild(P(t,t.name));const h=document.createElement("span");h.textContent=t.name+(t.level?` ${t.level}`:"")+(t.rounds?` · ${t.rounds}р`:""),s.appendChild(h);const u=[t.source,t.hidden?"только для ДМ":""].filter(Boolean);s.title=u.length?`${t.name} (${u.join("; ")})`:t.name,t.hidden&&(s.style.opacity="0.6"),r&&(s.onclick=()=>r(t)),l.appendChild(s)}if(n){const t=document.createElement("button");t.type="button",t.className="status-chip-add",t.innerHTML=N("plus",{size:12}),t.title=c||"Наложить состояние",t.onclick=s=>{s.stopPropagation(),n(s)},l.appendChild(t)}return l}let f=null;function k(){f&&(f.el.remove(),f=null)}function J(){f&&E(f)}async function K({x:e,y:n,target:r,send:c,statusesFor:l,title:t}){z(),k();const s=document.createElement("div");s.className="status-palette",document.body.appendChild(s),f={el:s,x:e,y:n,target:r,send:c,statusesFor:l,title:t,detailSlug:"",filter:""},I(s,e,n),s.textContent="Загрузка…",await Promise.all([T(),_()]),!(!f||f.el!==s)&&E(f)}function I(e,n,r){const c=e.offsetWidth||296,l=e.offsetHeight||320,t=Math.max(8,Math.min(n,window.innerWidth-c-8)),s=Math.max(8,Math.min(r,window.innerHeight-l-8));e.style.left=t+"px",e.style.top=s+"px"}function E(e){const{el:n,send:r,target:c}=e,l=e.statusesFor()||[],t=new Map(l.map(a=>[a.slug,a]));n.innerHTML="";const s=document.createElement("div");s.className="status-palette-head";const h=document.createElement("input");h.type="search",h.placeholder=e.title?`Состояния — ${e.title}`:"Состояние…",h.value=e.filter,h.oninput=()=>{e.filter=h.value,E(e);const a=n.querySelector(".status-palette-head input");a&&(a.focus(),a.setSelectionRange(a.value.length,a.value.length))};const u=document.createElement("button");u.type="button",u.className="status-palette-close",u.innerHTML=N("close",{size:14}),u.title="Закрыть",u.onclick=k,s.append(h,u),n.appendChild(s);const C=e.filter.trim().toLowerCase(),g=(v||[]).filter(a=>(L||!a.system)&&(!C||[a.name,a.slug,...a.tags||[]].join(" ").toLowerCase().includes(C)));if(g.length===0){const a=document.createElement("p");a.className="status-palette-empty",a.textContent=v&&v.length?"Ничего не найдено.":"В этом мире ещё нет состояний — заведи их в конструкторе (Компендиум → Состояния).",n.appendChild(a)}else{const a=document.createElement("div");a.className="status-palette-grid";for(const o of g){const p=o.slug||"",i=t.get(p),d=document.createElement("div");if(d.className="status-cell"+(i?" active":""),o.color&&d.style.setProperty("--cell-color",o.color),d.appendChild(P(o,o.name)),d.title=`${o.name}
ЛКМ — повесить/снять, ПКМ — подробности`,i&&i.level){const x=document.createElement("span");x.className="status-cell-level",x.textContent=i.level,d.appendChild(x)}if(i&&i.rounds){const x=document.createElement("span");x.className="status-cell-rounds",x.textContent=i.rounds,d.appendChild(x)}p?(B(d,o.name),d.onclick=()=>{i?y(r,c,"remove_status",{statusSlug:p}):y(r,c,"apply_status",{statusSlug:p}),e.detailSlug=""},d.oncontextmenu=x=>{x.preventDefault(),e.detailSlug=e.detailSlug===p?"":p,E(e)}):(d.style.cursor="not-allowed",d.title=`${o.name}
Карточка ещё не сохранена.`),a.appendChild(d)}n.appendChild(a)}if(e.detailSlug){const a=(v||[]).find(o=>o.slug===e.detailSlug);a&&n.appendChild(W(a,t.get(a.slug),e))}const b=document.createElement("div");b.className="status-palette-foot";const m=document.createElement("button");m.type="button",m.textContent="Снять все",m.disabled=l.length===0,m.onclick=()=>y(r,c,"clear_statuses",{}),b.appendChild(m),n.appendChild(b),I(n,e.x,e.y)}function W(e,n,r){const{send:c,target:l}=r,t=document.createElement("div");t.className="status-palette-detail";const s=document.createElement("h4");s.textContent=e.name,t.appendChild(s);const h=n?n.modifiers||[]:e.modifiers||[];for(const o of h){const p=document.createElement("p");p.textContent="▸ "+$(o),p.style.color="var(--text)",t.appendChild(p)}if(e.mechanics){const o=document.createElement("p");o.textContent=e.mechanics,t.appendChild(o)}if(!n){const o=document.createElement("p");return o.textContent="Не наложено. ЛКМ по иконке — повесить.",t.appendChild(o),t}if(e.levels>1){const o=document.createElement("div");o.className="status-palette-row";const p=document.createElement("span");p.textContent=`Уровень (0–${e.levels}):`;const i=document.createElement("input");i.type="number",i.min="0",i.max=String(e.levels),i.value=String(n.level||0),i.title="0 — снять состояние целиком",i.onchange=()=>{const d=parseInt(i.value,10);Number.isNaN(d)||y(c,l,"set_status_level",{statusSlug:e.slug,level:d})},o.append(p,i),t.appendChild(o)}const u=document.createElement("div");u.className="status-palette-row";const C=document.createElement("span");C.textContent="Раундов:";const g=document.createElement("input");g.type="number",g.min="0",g.value=String(n.rounds||0),g.title="0 — бессрочно. Счётчик уменьшается в начале хода этого бойца.",g.onchange=()=>{const o=parseInt(g.value,10);Number.isNaN(o)||y(c,l,"set_status_rounds",{statusSlug:e.slug,rounds:o})},u.append(C,g),t.appendChild(u);const b=document.createElement("label");b.className="status-palette-row";const m=document.createElement("input");m.type="checkbox",m.className="switch",m.checked=!!n.hidden,m.onchange=()=>y(c,l,"apply_status",{statusSlug:e.slug,rounds:n.rounds||0,level:n.level||0,hidden:m.checked,source:n.source||""});const a=document.createElement("span");if(a.textContent="видно только ДМ",b.append(m,a),t.appendChild(b),n.source){const o=document.createElement("p");o.textContent="Источник: "+n.source,t.appendChild(o)}return t}document.addEventListener("pointerdown",e=>{f&&!f.el.contains(e.target)&&k()},!0);document.addEventListener("keydown",e=>{e.key==="Escape"&&k()});export{J as a,k as c,K as o,G as r};
