import{s as T}from"./modal-B4_pGqFT.js";import{a as B,c as j}from"./back-stack-C8cwVhaZ.js";import{i as H}from"./fullscreen-BM1DhevO.js";let F=!1;function I(){if(F)return;F=!0;const n=document.createElement("style");n.textContent=`
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
        /* --vv-* — видимая часть над клавиатурой iOS (visual-viewport.js). */
        left: 0 !important; top: var(--vv-top, 0px) !important;
        width: 100% !important; height: var(--vv-h, 100dvh) !important;
        min-width: 0; min-height: 0; border: none; border-radius: 0;
        resize: none;
        box-sizing: border-box; padding: var(--safe-t) var(--safe-r) var(--safe-b) var(--safe-l);
      }
      .fw-titlebar { cursor: default; padding: 8px 8px 8px 12px; }
      .fw-btn { width: 34px; height: 34px; font-size: 15px; }
      /* 🗗 на телефоне — вторая вкладка, из которой не вернуться. */
      .fw-popout { display: none; }
      .fw-own-header .fw-titlebar { display: none; }
    }
  `,document.head.appendChild(n)}const O=200;let k=O,U=0;const p=new Map;function m(n){k+=1,n.style.zIndex=String(k)}function q({key:n,title:r,url:i,navigate:s=!1,popoutFeatures:l="width=1040,height=880",width:z=1040,height:N=880,desktopPopout:y=null}){I();const w=p.get(n);if(w){if(s){const e=w.querySelector(".fw-iframe"),a=e.contentWindow&&e.contentWindow.location.href||e.src;new URL(a,location.href).href!==new URL(i,location.href).href&&(e.src=i)}return m(w),w}const v=Math.min(z,Math.round(window.innerWidth*.94)),W=Math.min(N,Math.round(window.innerHeight*.9)),M=U++%8*28,t=document.createElement("div");t.className="fw-window",t.style.width=v+"px",t.style.height=W+"px",t.style.left=Math.max(8,Math.round((window.innerWidth-v)/2)+M)+"px",t.style.top=Math.max(8,Math.round((window.innerHeight-W)/2)+M)+"px";const f=document.createElement("div");f.className="fw-titlebar";const h=document.createElement("span");h.className="fw-title",h.textContent=r||"";const c=document.createElement("button");c.type="button",c.className="fw-btn fw-popout",c.textContent="🗗",c.title="Открыть в отдельном окне браузера";const d=document.createElement("button");d.type="button",d.className="fw-btn",d.textContent="✕",d.title="Закрыть",f.append(h,...H?[]:[c],d);const x=document.createElement("div");x.className="fw-body";const o=document.createElement("iframe");o.className="fw-iframe",o.allowFullscreen=!0,o.src=i,x.appendChild(o),t.append(f,x),document.body.appendChild(t),p.set(n,t),m(t);async function E(){let e;try{e=o.contentWindow&&o.contentWindow.beaconFlush}catch{return}if(typeof e=="function")try{await Promise.race([Promise.resolve(e()),new Promise(a=>setTimeout(a,3e3))])}catch{}}const b=j(async()=>{await g()?u():b.set(!0)});b.set(!0);async function u(){b.set(!1),await E(),window.removeEventListener("message",L),t.remove(),p.delete(n)}async function g(){let e="";try{const a=o.contentWindow&&o.contentWindow.beaconCloseGuard;typeof a=="function"&&(e=a()||"")}catch{}return e?T(e,{title:"Закрыть окно",okLabel:"Закрыть",cancelLabel:"Не закрывать",danger:!0}):!0}d.onclick=async()=>{await g()&&u()},c.onclick=async()=>{await g()&&(await E(),y&&window.beaconDesktop?y():window.open(i,n,l),u())};function L(e){e.source!==o.contentWindow||!e.data||(e.data.type==="beacon:closeFloatingWindow"&&u(),e.data.type==="beacon:ownHeader"&&t.classList.add("fw-own-header"))}window.addEventListener("message",L),f.addEventListener("pointerdown",()=>m(t));let C=0,S=0;return B(f,{onStart:()=>{C=t.offsetLeft,S=t.offsetTop},onMove:(e,a)=>{t.style.left=Math.max(0,C+e)+"px",t.style.top=Math.max(0,S+a)+"px"}}),o.addEventListener("load",()=>{try{o.contentWindow.addEventListener("mousedown",()=>m(t),!0)}catch{}}),t}function R(n){return p.has(n)}function G(n,r){for(const[i,s]of p){if(!i.startsWith(n))continue;const l=s.querySelector(".fw-iframe");l&&l.contentWindow&&l.contentWindow.postMessage(r,location.origin)}}function Z({key:n,title:r,url:i,navigate:s=!1}){if(window.parent&&window.parent!==window){window.parent.postMessage({type:"beacon:openFloatingWindow",key:n,title:r,url:i,navigate:s},location.origin);return}q({key:n,title:r,url:i,navigate:s})}export{q as a,R as i,Z as o,G as p};
