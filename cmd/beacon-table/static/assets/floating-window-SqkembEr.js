import{j}from"./modal-BvM74pnB.js";import{i as H}from"./native-app-BgGKemc-.js";function I(t,{onStart:o,onMove:i,onEnd:r}={}){t.addEventListener("pointerdown",a=>{if(a.button!==0||a.target.closest("button, input, select, textarea, a")||o&&o(a)===!1)return;a.preventDefault();try{t.setPointerCapture(a.pointerId)}catch{}const y=a.clientX,L=a.clientY;let p=0,c=0;const m=f=>{p=f.clientX-y,c=f.clientY-L,i&&i(p,c,f)},l=()=>{window.removeEventListener("pointermove",m),window.removeEventListener("pointerup",l),window.removeEventListener("pointercancel",l),r&&r(p,c)};window.addEventListener("pointermove",m),window.addEventListener("pointerup",l),window.addEventListener("pointercancel",l)})}const P="(max-width: 860px), (max-height: 500px)",v=[];let C=0;typeof window<"u"&&window.addEventListener("popstate",()=>{if(C>0){C--;return}const t=v.pop();t&&(t.active=!1,t.onBack())});function T(t){const o={active:!1,onBack:t};return{set(i){if(i===o.active)return;if(i){if(!matchMedia(P).matches)return;o.active=!0,v.push(o),history.pushState({beaconLayer:!0},"");return}o.active=!1;const r=v.indexOf(o);r<0||(v.splice(r,1),C++,history.back())}}}function R(t,o,i){const r=T(i),a=()=>r.set(t.classList.contains(o));return new MutationObserver(a).observe(t,{attributes:!0,attributeFilter:["class"]}),a(),r}let O=!1;function D(){if(O)return;O=!0;const t=document.createElement("style");t.textContent=`
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
  `,document.head.appendChild(t)}const U=200;let B=U,X=0;const x=new Map;function g(t){B+=1,t.style.zIndex=String(B)}function Y({key:t,title:o,url:i,navigate:r=!1,popoutFeatures:a="width=1040,height=880",width:y=1040,height:L=880,desktopPopout:p=null}){D();const c=x.get(t);if(c){if(r){const e=c.querySelector(".fw-iframe"),d=e.contentWindow&&e.contentWindow.location.href||e.src;new URL(d,location.href).href!==new URL(i,location.href).href&&(e.src=i)}return g(c),c}const m=Math.min(y,Math.round(window.innerWidth*.94)),l=Math.min(L,Math.round(window.innerHeight*.9)),f=X++%8*28,n=document.createElement("div");n.className="fw-window",n.style.width=m+"px",n.style.height=l+"px",n.style.left=Math.max(8,Math.round((window.innerWidth-m)/2)+f)+"px",n.style.top=Math.max(8,Math.round((window.innerHeight-l)/2)+f)+"px";const h=document.createElement("div");h.className="fw-titlebar";const E=document.createElement("span");E.className="fw-title",E.textContent=o||"";const w=document.createElement("button");w.type="button",w.className="fw-btn fw-popout",w.textContent="🗗",w.title="Открыть в отдельном окне браузера";const u=document.createElement("button");u.type="button",u.className="fw-btn",u.textContent="✕",u.title="Закрыть",h.append(E,...H?[]:[w],u);const W=document.createElement("div");W.className="fw-body";const s=document.createElement("iframe");s.className="fw-iframe",s.allowFullscreen=!0,s.src=i,W.appendChild(s),n.append(h,W),document.body.appendChild(n),x.set(t,n),g(n);async function F(){let e;try{e=s.contentWindow&&s.contentWindow.beaconFlush}catch{return}if(typeof e=="function")try{await Promise.race([Promise.resolve(e()),new Promise(d=>setTimeout(d,3e3))])}catch{}}const M=T(async()=>{await k()?b():M.set(!0)});M.set(!0);async function b(){M.set(!1),await F(),window.removeEventListener("message",S),n.remove(),x.delete(t)}async function k(){let e="";try{const d=s.contentWindow&&s.contentWindow.beaconCloseGuard;typeof d=="function"&&(e=d()||"")}catch{}return e?j(e,{title:"Закрыть окно",okLabel:"Закрыть",cancelLabel:"Не закрывать",danger:!0}):!0}u.onclick=async()=>{await k()&&b()},w.onclick=async()=>{await k()&&(await F(),p&&window.beaconDesktop?p():window.open(i,t,a),b())};function S(e){e.source!==s.contentWindow||!e.data||(e.data.type==="beacon:closeFloatingWindow"&&b(),e.data.type==="beacon:ownHeader"&&n.classList.add("fw-own-header"))}window.addEventListener("message",S),h.addEventListener("pointerdown",()=>g(n));let N=0,z=0;return I(h,{onStart:()=>{N=n.offsetLeft,z=n.offsetTop},onMove:(e,d)=>{n.style.left=Math.max(0,N+e)+"px",n.style.top=Math.max(0,z+d)+"px"}}),s.addEventListener("load",()=>{try{s.contentWindow.addEventListener("mousedown",()=>g(n),!0)}catch{}}),n}function G(t){return x.has(t)}function Z(t,o){for(const[i,r]of x){if(!i.startsWith(t))continue;const a=r.querySelector(".fw-iframe");a&&a.contentWindow&&a.contentWindow.postMessage(o,location.origin)}}function _({key:t,title:o,url:i,navigate:r=!1}){if(window.parent&&window.parent!==window){window.parent.postMessage({type:"beacon:openFloatingWindow",key:t,title:o,url:i,navigate:r},location.origin);return}Y({key:t,title:o,url:i,navigate:r})}export{I as a,_ as b,T as c,G as i,Y as o,Z as p,R as t};
