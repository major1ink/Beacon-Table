import{i as z}from"./icons-BwZXTdhR.js";let D=0;const K='a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';let A=!1;function L(){if(A)return;A=!0;const o=document.createElement("style");o.textContent=`
    .bt-modal-overlay {
      /* 500 — выше всего остального UI: плавающих окон (200+), оверлеев
         страниц и модалки лута (400). Диалог всегда поверх того, о чём
         спрашивает. */
      position: fixed; inset: 0; z-index: 500; display: flex; align-items: center; justify-content: center;
      padding: 16px; background: rgba(0, 0, 0, 0.55);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 13px;
      animation: bt-modal-fade .12s ease-out;
    }
    @keyframes bt-modal-fade { from { opacity: 0 } to { opacity: 1 } }
    .bt-modal {
      width: min(420px, 100%); max-height: 100%; display: flex; flex-direction: column; overflow: hidden;
      background: var(--panel-bg, #1c1c25); color: var(--text, #eee);
      border: 1px solid var(--border, rgba(255,255,255,0.08)); border-radius: var(--radius-lg, 18px);
      box-shadow: var(--shadow-float, 0 16px 40px rgba(0,0,0,0.45));
    }
    .bt-modal-head {
      flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 12px 14px;
      border-bottom: 1px solid var(--border, rgba(255,255,255,0.08));
      font-size: 14px; font-weight: 600;
    }
    .bt-modal-head span { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bt-modal-close {
      flex: 0 0 auto; width: 26px; height: 26px; padding: 0; display: flex; align-items: center; justify-content: center;
      background: none; border: none; border-radius: 8px; color: var(--text-dim, rgba(238,238,238,0.55)); cursor: pointer;
    }
    .bt-modal-close:hover { background: var(--surface-hover, #303039); color: var(--text, #eee); }
    .bt-modal-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
    .bt-modal-text { margin: 0; line-height: 1.55; white-space: pre-wrap; overflow-wrap: break-word; }
    .bt-modal-text.dim { color: var(--text-dim, rgba(238,238,238,0.55)); font-size: 12px; }
    /* Вид поля — общий из theme.css, здесь только моноширинный textarea. */
    .bt-modal-textarea { min-height: 110px; font: 13px/1.6 "Cascadia Code", Consolas, monospace; }
    .bt-modal-foot {
      flex: 0 0 auto; display: flex; align-items: center; gap: 8px; justify-content: flex-end;
      padding: 10px 14px; border-top: 1px solid var(--border, rgba(255,255,255,0.08));
    }
    .bt-modal-btn {
      padding: 7px 14px; border: none; border-radius: var(--radius, 10px); cursor: pointer; font: inherit;
      background: var(--surface, #26262f); color: var(--text, #eee);
    }
    .bt-modal-btn:hover { background: var(--surface-hover, #303039); }
    .bt-modal-btn.primary { background: var(--accent, #7c6cf0); }
    .bt-modal-btn.primary:hover { background: var(--accent-hover, #6a5ae0); }
    .bt-modal-btn.danger { background: var(--danger, #6b2b2b); }
    .bt-modal-btn.danger:hover { background: var(--danger-hover, #8a3535); }
  `,document.head.appendChild(o)}function E({title:o,danger:s,okLabel:m,cancelLabel:i,buildBody:l,onOk:p,onCancel:n}){return L(),new Promise(c=>{const e=document.activeElement,r=document.createElement("div");r.className="bt-modal-overlay";const d=document.createElement("div");d.className="bt-modal",d.setAttribute("role","dialog"),d.setAttribute("aria-modal","true"),r.appendChild(d);const a=document.createElement("div");a.className="bt-modal-head";const x=document.createElement("span");x.id="bt-modal-title-"+ ++D,x.textContent=o,d.setAttribute("aria-labelledby",x.id);const u=document.createElement("button");u.type="button",u.className="bt-modal-close",u.title="Закрыть",u.innerHTML=z("close",{size:14}),u.onclick=()=>f(n()),a.append(x,u);const y=document.createElement("div");y.className="bt-modal-body";const h=l(y,()=>f(p())),v=document.createElement("div");if(v.className="bt-modal-foot",i){const t=document.createElement("button");t.type="button",t.className="bt-modal-btn",t.textContent=i,t.onclick=()=>f(n()),v.appendChild(t)}const b=document.createElement("button");b.type="button",b.className="bt-modal-btn "+(s?"danger":"primary"),b.textContent=m,b.onclick=()=>f(p()),v.appendChild(b),d.append(a,y,v);function j(t){if(t.key==="Escape"){t.preventDefault(),f(n());return}if(t.key!=="Tab")return;const g=[...d.querySelectorAll(K)].filter(B=>!B.disabled&&B.offsetParent!==null);if(g.length===0)return;const w=g[0],N=g[g.length-1],C=document.activeElement;t.shiftKey&&(C===w||!d.contains(C))?(t.preventDefault(),N.focus()):!t.shiftKey&&C===N&&(t.preventDefault(),w.focus())}r.addEventListener("keydown",j),r.addEventListener("mousedown",t=>{t.target===r&&f(n())});let k=!1;function f(t){k||(k=!0,r.remove(),e&&e.focus&&e.focus(),c(t))}document.body.appendChild(r),(h||b).focus(),h&&h.select&&h.select()})}function T(o,{title:s="Beacon Table",okLabel:m="Понятно"}={}){return E({title:s,okLabel:m,cancelLabel:"",buildBody:i=>{const l=document.createElement("p");return l.className="bt-modal-text",l.textContent=o,i.appendChild(l),null},onOk:()=>{},onCancel:()=>{}})}function U(o,{title:s="Подтверждение",okLabel:m="Да",cancelLabel:i="Отмена",danger:l=!1,hint:p=""}={}){return E({title:s,danger:l,okLabel:m,cancelLabel:i,buildBody:n=>{const c=document.createElement("p");if(c.className="bt-modal-text",c.textContent=o,n.appendChild(c),p){const e=document.createElement("p");e.className="bt-modal-text dim",e.textContent=p,n.appendChild(e)}return null},onOk:()=>!0,onCancel:()=>!1})}function F(o,{title:s="Ввод",value:m="",placeholder:i="",okLabel:l="ОК",cancelLabel:p="Отмена",multiline:n=!1,hint:c=""}={}){let e=null;return E({title:s,okLabel:l,cancelLabel:p,buildBody:(r,d)=>{if(o){const a=document.createElement("p");a.className="bt-modal-text",a.textContent=o,r.appendChild(a)}if(e=document.createElement(n?"textarea":"input"),e.className=n?"bt-modal-textarea":"bt-modal-input",o&&e.setAttribute("aria-label",o),n||(e.type="text"),e.value=m,e.placeholder=i,e.addEventListener("keydown",a=>{a.key==="Enter"&&(n&&!(a.ctrlKey||a.metaKey)||(a.preventDefault(),d()))}),r.appendChild(e),c){const a=document.createElement("p");a.className="bt-modal-text dim",a.textContent=c,r.appendChild(a)}return e},onOk:()=>e.value,onCancel:()=>null})}export{U as a,F as b,E as o,T as s};
