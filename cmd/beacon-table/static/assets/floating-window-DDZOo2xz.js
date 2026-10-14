import{j as U}from"./modal-B967srPi.js";function B(t,{onStart:o,onMove:i,onEnd:r}={}){t.addEventListener("pointerdown",a=>{if(a.button!==0||a.target.closest("button, input, select, textarea, a")||o&&o(a)===!1)return;a.preventDefault();try{t.setPointerCapture(a.pointerId)}catch{}const f=a.clientX,d=a.clientY;let m=0,p=0;const b=w=>{m=w.clientX-f,p=w.clientY-d,i&&i(m,p,w)},l=()=>{window.removeEventListener("pointermove",b),window.removeEventListener("pointerup",l),window.removeEventListener("pointercancel",l),r&&r(m,p)};window.addEventListener("pointermove",b),window.addEventListener("pointerup",l),window.addEventListener("pointercancel",l)})}const Y="(max-width: 860px), (max-height: 500px)",W=[];let C=0;typeof window<"u"&&window.addEventListener("popstate",()=>{if(C>0){C--;return}const t=W.pop();t&&(t.active=!1,t.onBack())});function A(t){const o={active:!1,onBack:t};return{set(i){if(i===o.active)return;if(i){if(!matchMedia(Y).matches)return;o.active=!0,W.push(o),history.pushState({beaconLayer:!0},"");return}o.active=!1;const r=W.indexOf(o);r<0||(W.splice(r,1),C++,history.back())}}}function J(t,o,i){const r=A(i),a=()=>r.set(t.classList.contains(o));return new MutationObserver(a).observe(t,{attributes:!0,attributeFilter:["class"]}),a(),r}const R=typeof navigator<"u"&&/\bBeaconTableApp\//.test(navigator.userAgent);let P=!1;function X(){if(P)return;P=!0;const t=document.createElement("style");t.textContent=`
    .fw-window {
      position: fixed; display: flex; flex-direction: column;
      background: #1c1c24; border: 1px solid rgba(255,255,255,0.14); border-radius: 10px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.55); overflow: hidden;
      min-width: 420px; min-height: 320px;
    }
    /* Свой уголок вместо CSS resize: в WebKit (десктоп) ручку resize перекрывает
       iframe — WebKit ищет её только у слоя элемента под курсором. */
    .fw-resize {
      position: absolute; right: 0; bottom: 0; z-index: 1; width: 16px; height: 16px;
      cursor: nwse-resize; touch-action: none;
      background: linear-gradient(135deg, transparent 55%, rgba(255,255,255,0.3) 55% 62%, transparent 62% 72%, rgba(255,255,255,0.3) 72% 79%, transparent 79%);
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
        box-sizing: border-box; padding: var(--safe-t) var(--safe-r) var(--safe-b) var(--safe-l);
      }
      .fw-titlebar { cursor: default; padding: 8px 8px 8px 12px; }
      .fw-btn { width: 34px; height: 34px; font-size: 15px; }
      /* 🗗 на телефоне — вторая вкладка, из которой не вернуться. */
      .fw-popout, .fw-resize { display: none; }
      .fw-own-header .fw-titlebar { display: none; }
    }
  `,document.head.appendChild(t)}const q=200;let j=q,K=0;const v=new Map;function x(t){j+=1,t.style.zIndex=String(j)}function D({key:t,title:o,url:i,navigate:r=!1,popoutFeatures:a="width=1040,height=880",width:f=1040,height:d=880,desktopFill:m=!1}){X();const p=v.get(t);if(p){if(r){const e=p.querySelector(".fw-iframe"),c=e.contentWindow&&e.contentWindow.location.href||e.src;new URL(c,location.href).href!==new URL(i,location.href).href&&(e.src=i)}return x(p),p}const b=Math.min(f,Math.round(window.innerWidth*.94)),l=Math.min(d,Math.round(window.innerHeight*.9)),w=K++%8*28,n=document.createElement("div");n.className="fw-window",n.style.width=b+"px",n.style.height=l+"px",n.style.left=Math.max(8,Math.round((window.innerWidth-b)/2)+w)+"px",n.style.top=Math.max(8,Math.round((window.innerHeight-l)/2)+w)+"px";const g=document.createElement("div");g.className="fw-titlebar";const L=document.createElement("span");L.className="fw-title",L.textContent=o||"";const u=document.createElement("button");u.type="button",u.className="fw-btn fw-popout",u.textContent="🗗",u.title=window.beaconDesktop?"Открыть в отдельном окне":"Открыть в отдельном окне браузера";const h=document.createElement("button");h.type="button",h.className="fw-btn",h.textContent="✕",h.title="Закрыть",g.append(L,...R?[]:[u],h);const E=document.createElement("div");E.className="fw-body";const s=document.createElement("iframe");s.className="fw-iframe",s.allowFullscreen=!0,s.src=i,E.appendChild(s);const M=document.createElement("div");M.className="fw-resize",n.append(g,E,M),document.body.appendChild(n),v.set(t,n),x(n);async function F(){let e;try{e=s.contentWindow&&s.contentWindow.beaconFlush}catch{return}if(typeof e=="function")try{await Promise.race([Promise.resolve(e()),new Promise(c=>setTimeout(c,3e3))])}catch{}}const k=A(async()=>{await S()?y():k.set(!0)});k.set(!0);async function y(){k.set(!1),await F(),window.removeEventListener("message",z),n.remove(),v.delete(t)}async function S(){let e="";try{const c=s.contentWindow&&s.contentWindow.beaconCloseGuard;typeof c=="function"&&(e=c()||"")}catch{}return e?U(e,{title:"Закрыть окно",okLabel:"Закрыть",cancelLabel:"Не закрывать",danger:!0}):!0}h.onclick=async()=>{await S()&&y()},u.onclick=async()=>{if(!await S())return;await F();const e=window.beaconDesktop;e&&e.popout?e.popout({key:t,title:o,url:I(),width:f,height:d,fill:m}):window.open(i,t,a),y()};function z(e){e.source!==s.contentWindow||!e.data||(e.data.type==="beacon:closeFloatingWindow"&&y(),e.data.type==="beacon:ownHeader"&&n.classList.add("fw-own-header"))}window.addEventListener("message",z),g.addEventListener("pointerdown",()=>x(n));let N=0,T=0;B(g,{onStart:()=>{N=n.offsetLeft,T=n.offsetTop},onMove:(e,c)=>{n.style.left=Math.max(0,N+e)+"px",n.style.top=Math.max(0,T+c)+"px"}}),s.addEventListener("load",()=>{try{s.contentWindow.addEventListener("mousedown",()=>x(n),!0)}catch{}});let H=0,O=0;B(M,{onStart:()=>{x(n),H=n.offsetWidth,O=n.offsetHeight},onMove:(e,c)=>{n.style.width=Math.min(H+e,window.innerWidth-n.offsetLeft)+"px",n.style.height=Math.min(O+c,window.innerHeight-n.offsetTop)+"px"}});function I(){try{const e=s.contentWindow.location;if(e.origin===location.origin)return e.pathname+e.search+e.hash}catch{}return i}return n}function Q(t){return v.has(t)}function _(t,o){for(const[i,r]of v){if(!i.startsWith(t))continue;const a=r.querySelector(".fw-iframe");a&&a.contentWindow&&a.contentWindow.postMessage(o,location.origin)}}function V({key:t,title:o,url:i,navigate:r=!1}){if(window.parent&&window.parent!==window){window.parent.postMessage({type:"beacon:openFloatingWindow",key:t,title:o,url:i,navigate:r},location.origin);return}D({key:t,title:o,url:i,navigate:r})}const G=new Set(["beacon:closeFloatingWindow","beacon:ownHeader"]);typeof window<"u"&&window.parent===window&&window.addEventListener("message",t=>{if(t.origin!==location.origin||!t.data||typeof t.data.type!="string")return;const{type:o,key:i,title:r,url:a,navigate:f}=t.data;if(o==="beacon:openFloatingWindow"){D({key:i,title:r,url:a,navigate:!!f});return}const d=window.beaconDesktop;!d||!d.toTable||!o.startsWith("beacon:")||G.has(o)||(d.toTable(t.data),o.endsWith("Saved")&&_("catalog-",t.data))});export{B as a,V as b,A as c,Q as d,R as i,D as o,_ as p,J as t};
