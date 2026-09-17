import{i as E}from"./icons-CpG934KY.js";let C=!1;function N(){if(C)return;C=!0;const n=document.createElement("style");n.textContent=`
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
  `,document.head.appendChild(n)}function g({title:n,danger:i,okLabel:s,cancelLabel:l,buildBody:r,onOk:m,onCancel:o}){return N(),new Promise(c=>{const e=document.activeElement,d=document.createElement("div");d.className="bt-modal-overlay";const f=document.createElement("div");f.className="bt-modal",d.appendChild(f);const t=document.createElement("div");t.className="bt-modal-head";const y=document.createElement("span");y.textContent=n;const p=document.createElement("button");p.type="button",p.className="bt-modal-close",p.title="Закрыть",p.innerHTML=E("close",{size:14}),p.onclick=()=>b(o()),t.append(y,p);const v=document.createElement("div");v.className="bt-modal-body";const x=r(v,()=>b(m())),h=document.createElement("div");if(h.className="bt-modal-foot",l){const a=document.createElement("button");a.type="button",a.className="bt-modal-btn",a.textContent=l,a.onclick=()=>b(o()),h.appendChild(a)}const u=document.createElement("button");u.type="button",u.className="bt-modal-btn "+(i?"danger":"primary"),u.textContent=s,u.onclick=()=>b(m()),h.appendChild(u),f.append(t,v,h);function k(a){a.key==="Escape"&&(a.preventDefault(),b(o()))}d.addEventListener("keydown",k),d.addEventListener("mousedown",a=>{a.target===d&&b(o())});let w=!1;function b(a){w||(w=!0,d.remove(),e&&e.focus&&e.focus(),c(a))}document.body.appendChild(d),(x||u).focus(),x&&x.select&&x.select()})}function j(n,{title:i="Beacon Table",okLabel:s="Понятно"}={}){return g({title:i,okLabel:s,cancelLabel:"",buildBody:l=>{const r=document.createElement("p");return r.className="bt-modal-text",r.textContent=n,l.appendChild(r),null},onOk:()=>{},onCancel:()=>{}})}function z(n,{title:i="Подтверждение",okLabel:s="Да",cancelLabel:l="Отмена",danger:r=!1,hint:m=""}={}){return g({title:i,danger:r,okLabel:s,cancelLabel:l,buildBody:o=>{const c=document.createElement("p");if(c.className="bt-modal-text",c.textContent=n,o.appendChild(c),m){const e=document.createElement("p");e.className="bt-modal-text dim",e.textContent=m,o.appendChild(e)}return null},onOk:()=>!0,onCancel:()=>!1})}function L(n,{title:i="Ввод",value:s="",placeholder:l="",okLabel:r="ОК",cancelLabel:m="Отмена",multiline:o=!1,hint:c=""}={}){let e=null;return g({title:i,okLabel:r,cancelLabel:m,buildBody:(d,f)=>{if(n){const t=document.createElement("p");t.className="bt-modal-text",t.textContent=n,d.appendChild(t)}if(e=document.createElement(o?"textarea":"input"),e.className=o?"bt-modal-textarea":"bt-modal-input",o||(e.type="text"),e.value=s,e.placeholder=l,e.addEventListener("keydown",t=>{t.key==="Enter"&&(o&&!(t.ctrlKey||t.metaKey)||(t.preventDefault(),f()))}),d.appendChild(e),c){const t=document.createElement("p");t.className="bt-modal-text dim",t.textContent=c,d.appendChild(t)}return e},onOk:()=>e.value,onCancel:()=>null})}export{z as a,L as b,g as o,j as s};
