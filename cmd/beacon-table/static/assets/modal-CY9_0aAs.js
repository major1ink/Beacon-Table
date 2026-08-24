import{i as E}from"./icons-B8E5VJBp.js";let k=!1;function N(){if(k)return;k=!0;const n=document.createElement("style");n.textContent=`
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
    .bt-modal-input, .bt-modal-textarea {
      width: 100%; box-sizing: border-box; font: inherit; color: var(--text, #eee);
      background: var(--surface, #26262f); border: 1px solid var(--border, rgba(255,255,255,0.08));
      border-radius: 8px; padding: 8px 10px;
    }
    .bt-modal-textarea { min-height: 110px; resize: vertical; font: 13px/1.6 "Cascadia Code", Consolas, monospace; }
    .bt-modal-input:focus, .bt-modal-textarea:focus { outline: none; border-color: var(--accent, #7c6cf0); }
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
  `,document.head.appendChild(n)}function h({title:n,danger:i,okLabel:s,cancelLabel:l,buildBody:d,onOk:m,onCancel:o}){return N(),new Promise(c=>{const e=document.activeElement,r=document.createElement("div");r.className="bt-modal-overlay";const f=document.createElement("div");f.className="bt-modal",r.appendChild(f);const t=document.createElement("div");t.className="bt-modal-head";const y=document.createElement("span");y.textContent=n;const p=document.createElement("button");p.type="button",p.className="bt-modal-close",p.title="Закрыть",p.innerHTML=E("close",{size:14}),p.onclick=()=>b(o()),t.append(y,p);const g=document.createElement("div");g.className="bt-modal-body";const x=d(g,()=>b(m())),v=document.createElement("div");if(v.className="bt-modal-foot",l){const a=document.createElement("button");a.type="button",a.className="bt-modal-btn",a.textContent=l,a.onclick=()=>b(o()),v.appendChild(a)}const u=document.createElement("button");u.type="button",u.className="bt-modal-btn "+(i?"danger":"primary"),u.textContent=s,u.onclick=()=>b(m()),v.appendChild(u),f.append(t,g,v);function C(a){a.key==="Escape"&&(a.preventDefault(),b(o()))}r.addEventListener("keydown",C),r.addEventListener("mousedown",a=>{a.target===r&&b(o())});let w=!1;function b(a){w||(w=!0,r.remove(),e&&e.focus&&e.focus(),c(a))}document.body.appendChild(r),(x||u).focus(),x&&x.select&&x.select()})}function z(n,{title:i="Beacon Table",okLabel:s="Понятно"}={}){return h({title:i,okLabel:s,cancelLabel:"",buildBody:l=>{const d=document.createElement("p");return d.className="bt-modal-text",d.textContent=n,l.appendChild(d),null},onOk:()=>{},onCancel:()=>{}})}function j(n,{title:i="Подтверждение",okLabel:s="Да",cancelLabel:l="Отмена",danger:d=!1,hint:m=""}={}){return h({title:i,danger:d,okLabel:s,cancelLabel:l,buildBody:o=>{const c=document.createElement("p");if(c.className="bt-modal-text",c.textContent=n,o.appendChild(c),m){const e=document.createElement("p");e.className="bt-modal-text dim",e.textContent=m,o.appendChild(e)}return null},onOk:()=>!0,onCancel:()=>!1})}function L(n,{title:i="Ввод",value:s="",placeholder:l="",okLabel:d="ОК",cancelLabel:m="Отмена",multiline:o=!1,hint:c=""}={}){let e=null;return h({title:i,okLabel:d,cancelLabel:m,buildBody:(r,f)=>{if(n){const t=document.createElement("p");t.className="bt-modal-text",t.textContent=n,r.appendChild(t)}if(e=document.createElement(o?"textarea":"input"),e.className=o?"bt-modal-textarea":"bt-modal-input",o||(e.type="text"),e.value=s,e.placeholder=l,e.addEventListener("keydown",t=>{t.key==="Enter"&&(o&&!(t.ctrlKey||t.metaKey)||(t.preventDefault(),f()))}),r.appendChild(e),c){const t=document.createElement("p");t.className="bt-modal-text dim",t.textContent=c,r.appendChild(t)}return e},onOk:()=>e.value,onCancel:()=>null})}export{L as a,j as b,z as s};
