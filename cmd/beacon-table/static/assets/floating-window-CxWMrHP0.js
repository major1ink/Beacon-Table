import{a as I}from"./modal-DOpLO7Pn.js";let F=!1;function U(){if(F)return;F=!0;const n=document.createElement("style");n.textContent=`
    .fw-window {
      position: fixed; display: flex; flex-direction: column;
      background: #1c1c24; border: 1px solid rgba(255,255,255,0.14); border-radius: 10px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.55); overflow: hidden;
      resize: both; min-width: 420px; min-height: 320px;
    }
    .fw-titlebar {
      flex: 0 0 auto; display: flex; align-items: center; gap: 4px; padding: 6px 6px 6px 10px;
      background: #26262f; cursor: move; user-select: none; border-bottom: 1px solid rgba(255,255,255,0.08);
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
  `,document.head.appendChild(n)}const j=200;let S=j,H=0;const p=new Map;function u(n){S+=1,n.style.zIndex=String(S)}function P({key:n,title:c,url:i,navigate:d=!1,popoutFeatures:l="width=1040,height=880",width:N=1040,height:k=880}){U();const f=p.get(n);if(f){if(d){const t=f.querySelector(".fw-iframe"),a=t.contentWindow&&t.contentWindow.location.href||t.src;new URL(a,location.href).href!==new URL(i,location.href).href&&(t.src=i)}return u(f),f}const g=Math.min(N,Math.round(window.innerWidth*.94)),b=Math.min(k,Math.round(window.innerHeight*.9)),y=H++%8*28,e=document.createElement("div");e.className="fw-window",e.style.width=g+"px",e.style.height=b+"px",e.style.left=Math.max(8,Math.round((window.innerWidth-g)/2)+y)+"px",e.style.top=Math.max(8,Math.round((window.innerHeight-b)/2)+y)+"px";const w=document.createElement("div");w.className="fw-titlebar";const m=document.createElement("span");m.className="fw-title",m.textContent=c||"";const r=document.createElement("button");r.type="button",r.className="fw-btn fw-popout",r.textContent="🗗",r.title="Открыть в отдельном окне браузера";const s=document.createElement("button");s.type="button",s.className="fw-btn",s.textContent="✕",s.title="Закрыть",w.append(m,r,s);const h=document.createElement("div");h.className="fw-body";const o=document.createElement("iframe");o.className="fw-iframe",o.src=i,h.appendChild(o),e.append(w,h),document.body.appendChild(e),p.set(n,e),u(e);async function v(){let t;try{t=o.contentWindow&&o.contentWindow.beaconFlush}catch{return}if(typeof t=="function")try{await Promise.race([Promise.resolve(t()),new Promise(a=>setTimeout(a,3e3))])}catch{}}async function x(){await v(),window.removeEventListener("message",E),e.remove(),p.delete(n)}async function W(){let t="";try{const a=o.contentWindow&&o.contentWindow.beaconCloseGuard;typeof a=="function"&&(t=a()||"")}catch{}return t?I(t,{title:"Закрыть окно",okLabel:"Закрыть",cancelLabel:"Не закрывать",danger:!0}):!0}s.onclick=async()=>{await W()&&x()},r.onclick=async()=>{await W()&&(await v(),window.open(i,n,l),x())};function E(t){t.source===o.contentWindow&&t.data&&t.data.type==="beacon:closeFloatingWindow"&&x()}return window.addEventListener("message",E),w.addEventListener("mousedown",t=>{if(t.target===r||t.target===s)return;u(e);const a=t.clientX,z=t.clientY,T=e.offsetLeft,B=e.offsetTop;function M(C){e.style.left=Math.max(0,T+(C.clientX-a))+"px",e.style.top=Math.max(0,B+(C.clientY-z))+"px"}function L(){document.removeEventListener("mousemove",M),document.removeEventListener("mouseup",L)}document.addEventListener("mousemove",M),document.addEventListener("mouseup",L)}),o.addEventListener("load",()=>{try{o.contentWindow.addEventListener("mousedown",()=>u(e),!0)}catch{}}),e}function Y(n){return p.has(n)}function q(n,c){for(const[i,d]of p){if(!i.startsWith(n))continue;const l=d.querySelector(".fw-iframe");l&&l.contentWindow&&l.contentWindow.postMessage(c,location.origin)}}function O({key:n,title:c,url:i,navigate:d=!1}){if(window.parent&&window.parent!==window){window.parent.postMessage({type:"beacon:openFloatingWindow",key:n,title:c,url:i,navigate:d},location.origin);return}P({key:n,title:c,url:i,navigate:d})}export{P as a,Y as i,O as o,q as p};
