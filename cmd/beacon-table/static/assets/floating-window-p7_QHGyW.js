import{a as k}from"./modal-BOMvyAUk.js";import{a as z}from"./drag-DVDIF09E.js";let L=!1;function T(){if(L)return;L=!0;const n=document.createElement("style");n.textContent=`
    .fw-window {
      position: fixed; display: flex; flex-direction: column;
      background: #1c1c24; border: 1px solid rgba(255,255,255,0.14); border-radius: 10px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.55); overflow: hidden;
      resize: both; min-width: 420px; min-height: 320px;
    }
    .fw-titlebar {
      flex: 0 0 auto; display: flex; align-items: center; gap: 4px; padding: 6px 6px 6px 10px;
      background: #26262f; cursor: move; user-select: none; touch-action: none; border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    .fw-title {
      flex: 1 1 auto; font: 600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #eee; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .fw-btn {
      flex: 0 0 auto; width: 26px; height: 26px; display: flex; align-items: center; justify-content: center;
      background: transparent; border: none; border-radius: 6px; color: #eee; font-size: 13px; cursor: pointer; padding: 0;
    }
    .fw-btn:hover { background: rgba(255,255,255,0.14); }
    .fw-body { flex: 1 1 auto; min-height: 0; position: relative; }
    .fw-iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: none; background: #1c1c24; }

    /* Телефон: окно во весь экран — min-width 420px не влезает, а таскать
       и растягивать пальцем нечем (и то и другое висит на мыши).
       !important — позицию и размер ставит инлайном openFloatingWindow.
       Брейкпоинт общий, см. theme.css. */
    @media (max-width: 860px), (max-height: 500px) {
      .fw-window {
        left: 0 !important; top: 0 !important;
        width: 100% !important; height: 100dvh !important;
        min-width: 0; min-height: 0; border: none; border-radius: 0;
        resize: none;
      }
      .fw-titlebar { cursor: default; padding: 8px 8px 8px 12px; }
      .fw-btn { width: 34px; height: 34px; font-size: 15px; }
      /* 🗗 на телефоне — вторая вкладка, из которой не вернуться. */
      .fw-popout { display: none; }
    }
  `,document.head.appendChild(n)}const B=200;let F=B,I=0;const f=new Map;function u(n){F+=1,n.style.zIndex=String(F)}function j({key:n,title:r,url:i,navigate:s=!1,popoutFeatures:l="width=1040,height=880",width:S=1040,height:N=880}){T();const w=f.get(n);if(w){if(s){const t=w.querySelector(".fw-iframe"),a=t.contentWindow&&t.contentWindow.location.href||t.src;new URL(a,location.href).href!==new URL(i,location.href).href&&(t.src=i)}return u(w),w}const g=Math.min(S,Math.round(window.innerWidth*.94)),b=Math.min(N,Math.round(window.innerHeight*.9)),y=I++%8*28,e=document.createElement("div");e.className="fw-window",e.style.width=g+"px",e.style.height=b+"px",e.style.left=Math.max(8,Math.round((window.innerWidth-g)/2)+y)+"px",e.style.top=Math.max(8,Math.round((window.innerHeight-b)/2)+y)+"px";const p=document.createElement("div");p.className="fw-titlebar";const m=document.createElement("span");m.className="fw-title",m.textContent=r||"";const c=document.createElement("button");c.type="button",c.className="fw-btn fw-popout",c.textContent="🗗",c.title="Открыть в отдельном окне браузера";const d=document.createElement("button");d.type="button",d.className="fw-btn",d.textContent="✕",d.title="Закрыть",p.append(m,c,d);const h=document.createElement("div");h.className="fw-body";const o=document.createElement("iframe");o.className="fw-iframe",o.allowFullscreen=!0,o.src=i,h.appendChild(o),e.append(p,h),document.body.appendChild(e),f.set(n,e),u(e);async function W(){let t;try{t=o.contentWindow&&o.contentWindow.beaconFlush}catch{return}if(typeof t=="function")try{await Promise.race([Promise.resolve(t()),new Promise(a=>setTimeout(a,3e3))])}catch{}}async function x(){await W(),window.removeEventListener("message",M),e.remove(),f.delete(n)}async function v(){let t="";try{const a=o.contentWindow&&o.contentWindow.beaconCloseGuard;typeof a=="function"&&(t=a()||"")}catch{}return t?k(t,{title:"Закрыть окно",okLabel:"Закрыть",cancelLabel:"Не закрывать",danger:!0}):!0}d.onclick=async()=>{await v()&&x()},c.onclick=async()=>{await v()&&(await W(),window.open(i,n,l),x())};function M(t){t.source===o.contentWindow&&t.data&&t.data.type==="beacon:closeFloatingWindow"&&x()}window.addEventListener("message",M),p.addEventListener("pointerdown",()=>u(e));let E=0,C=0;return z(p,{onStart:()=>{E=e.offsetLeft,C=e.offsetTop},onMove:(t,a)=>{e.style.left=Math.max(0,E+t)+"px",e.style.top=Math.max(0,C+a)+"px"}}),o.addEventListener("load",()=>{try{o.contentWindow.addEventListener("mousedown",()=>u(e),!0)}catch{}}),e}function U(n){return f.has(n)}function q(n,r){for(const[i,s]of f){if(!i.startsWith(n))continue;const l=s.querySelector(".fw-iframe");l&&l.contentWindow&&l.contentWindow.postMessage(r,location.origin)}}function O({key:n,title:r,url:i,navigate:s=!1}){if(window.parent&&window.parent!==window){window.parent.postMessage({type:"beacon:openFloatingWindow",key:n,title:r,url:i,navigate:s},location.origin);return}j({key:n,title:r,url:i,navigate:s})}export{j as a,U as i,O as o,q as p};
