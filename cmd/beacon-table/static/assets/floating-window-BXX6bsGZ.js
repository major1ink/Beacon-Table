import{a as N}from"./modal-D-SqX1d0.js";import{a as T,c as B}from"./back-stack-C8cwVhaZ.js";import{i as j}from"./native-app-BgGKemc-.js";let S=!1;function H(){if(S)return;S=!0;const n=document.createElement("style");n.textContent=`
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
  `,document.head.appendChild(n)}const I=200;let F=I,O=0;const p=new Map;function m(n){F+=1,n.style.zIndex=String(F)}function P({key:n,title:r,url:i,navigate:s=!1,popoutFeatures:l="width=1040,height=880",width:k=1040,height:z=880}){H();const w=p.get(n);if(w){if(s){const e=w.querySelector(".fw-iframe"),a=e.contentWindow&&e.contentWindow.location.href||e.src;new URL(a,location.href).href!==new URL(i,location.href).href&&(e.src=i)}return m(w),w}const y=Math.min(k,Math.round(window.innerWidth*.94)),v=Math.min(z,Math.round(window.innerHeight*.9)),W=O++%8*28,t=document.createElement("div");t.className="fw-window",t.style.width=y+"px",t.style.height=v+"px",t.style.left=Math.max(8,Math.round((window.innerWidth-y)/2)+W)+"px",t.style.top=Math.max(8,Math.round((window.innerHeight-v)/2)+W)+"px";const f=document.createElement("div");f.className="fw-titlebar";const h=document.createElement("span");h.className="fw-title",h.textContent=r||"";const c=document.createElement("button");c.type="button",c.className="fw-btn fw-popout",c.textContent="🗗",c.title="Открыть в отдельном окне браузера";const d=document.createElement("button");d.type="button",d.className="fw-btn",d.textContent="✕",d.title="Закрыть",f.append(h,...j?[]:[c],d);const x=document.createElement("div");x.className="fw-body";const o=document.createElement("iframe");o.className="fw-iframe",o.allowFullscreen=!0,o.src=i,x.appendChild(o),t.append(f,x),document.body.appendChild(t),p.set(n,t),m(t);async function M(){let e;try{e=o.contentWindow&&o.contentWindow.beaconFlush}catch{return}if(typeof e=="function")try{await Promise.race([Promise.resolve(e()),new Promise(a=>setTimeout(a,3e3))])}catch{}}const b=B(async()=>{await g()?u():b.set(!0)});b.set(!0);async function u(){b.set(!1),await M(),window.removeEventListener("message",E),t.remove(),p.delete(n)}async function g(){let e="";try{const a=o.contentWindow&&o.contentWindow.beaconCloseGuard;typeof a=="function"&&(e=a()||"")}catch{}return e?N(e,{title:"Закрыть окно",okLabel:"Закрыть",cancelLabel:"Не закрывать",danger:!0}):!0}d.onclick=async()=>{await g()&&u()},c.onclick=async()=>{await g()&&(await M(),window.open(i,n,l),u())};function E(e){e.source!==o.contentWindow||!e.data||(e.data.type==="beacon:closeFloatingWindow"&&u(),e.data.type==="beacon:ownHeader"&&t.classList.add("fw-own-header"))}window.addEventListener("message",E),f.addEventListener("pointerdown",()=>m(t));let L=0,C=0;return T(f,{onStart:()=>{L=t.offsetLeft,C=t.offsetTop},onMove:(e,a)=>{t.style.left=Math.max(0,L+e)+"px",t.style.top=Math.max(0,C+a)+"px"}}),o.addEventListener("load",()=>{try{o.contentWindow.addEventListener("mousedown",()=>m(t),!0)}catch{}}),t}function R(n){return p.has(n)}function D(n,r){for(const[i,s]of p){if(!i.startsWith(n))continue;const l=s.querySelector(".fw-iframe");l&&l.contentWindow&&l.contentWindow.postMessage(r,location.origin)}}function G({key:n,title:r,url:i,navigate:s=!1}){if(window.parent&&window.parent!==window){window.parent.postMessage({type:"beacon:openFloatingWindow",key:n,title:r,url:i,navigate:s},location.origin);return}P({key:n,title:r,url:i,navigate:s})}export{P as a,R as i,G as o,D as p};
