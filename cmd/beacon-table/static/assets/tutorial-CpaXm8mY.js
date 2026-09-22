import{i as P}from"./icons-D-aZ-3A3.js";import{r as K}from"./tooltip-DWlYhOSE.js";const R="bt.tutorial.step.",I=6,m=14,h=12,$=150;let j=!1;function U(){if(j)return;j=!0;const e=document.createElement("style");e.textContent=`
    /* 450 — выше плавающих окон (200+) и оверлея лута (400), ниже модалок
       (500): вопрос «сохранить?» должен перекрывать и тур. */
    .bt-tour-spot {
      position: fixed; z-index: 450; pointer-events: none;
      border-radius: 14px; border: 2px solid var(--accent, #7c6cf0);
      box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.5), 0 0 0 5px rgba(124, 108, 240, 0.28);
      transition: top .18s ease-out, left .18s ease-out, width .18s ease-out, height .18s ease-out;
    }
    .bt-tour-spot.bt-tour-spot--none { border-color: transparent; box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.5); }
    .bt-tour-card {
      position: fixed; z-index: 451; box-sizing: border-box; width: min(360px, calc(100vw - 24px));
      display: flex; flex-direction: column; gap: 8px; padding: 14px 16px 12px;
      background: var(--glass-bg-strong, rgba(22, 22, 29, 0.92)); color: var(--text, #eee);
      backdrop-filter: var(--glass-blur, blur(20px)); -webkit-backdrop-filter: var(--glass-blur, blur(20px));
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.07)); border-radius: var(--radius-lg, 18px);
      box-shadow: var(--shadow-float, 0 16px 40px rgba(0, 0, 0, 0.45));
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 13px; line-height: 1.5;
      transition: top .18s ease-out, left .18s ease-out;
      animation: bt-tour-in .16s ease-out;
    }
    @keyframes bt-tour-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
    /* Шапка — ручка: карточку можно оттащить, если она легла на то, с чем
       шаг просит поработать (перетащить существо на карту). */
    .bt-tour-head { display: flex; align-items: center; gap: 8px; cursor: grab; user-select: none; -webkit-user-select: none; touch-action: none; }
    .bt-tour-card.bt-tour-card--dragging { transition: none; }
    .bt-tour-card.bt-tour-card--dragging .bt-tour-head { cursor: grabbing; }
    .bt-tour-counter {
      flex: 0 0 auto; padding: 2px 8px; border-radius: var(--radius-pill, 999px);
      background: var(--accent-bg, rgba(124, 108, 240, 0.16)); color: var(--accent, #7c6cf0);
      font-size: 11px; font-weight: 600; letter-spacing: 0.04em;
    }
    .bt-tour-title { flex: 1 1 auto; margin: 0; font-size: 14px; font-weight: 600; }
    .bt-tour-text { margin: 0; color: var(--text, #eee); }
    .bt-tour-text + .bt-tour-text { margin-top: 2px; }
    .bt-tour-text .bt-tip-key {
      display: inline-block; padding: 0 5px; margin: 0 1px; border-radius: 5px; font: inherit; font-size: 11px; line-height: 17px;
      background: var(--surface, #26262f); border: 1px solid var(--border, rgba(255,255,255,0.08)); color: var(--text, #eee);
    }
    .bt-tour-foot { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
    .bt-tour-skip {
      flex: 1 1 auto; text-align: left; padding: 6px 0; background: none; border: none; cursor: pointer; font: inherit; font-size: 12px;
      color: var(--text-dim, rgba(238,238,238,0.55));
    }
    .bt-tour-skip:hover { color: var(--text, #eee); }
    .bt-tour-btn {
      flex: 0 0 auto; display: inline-flex; align-items: center; gap: 4px; padding: 7px 12px; border: none; border-radius: var(--radius, 10px);
      cursor: pointer; font: inherit; font-size: 12px; background: var(--surface, #26262f); color: var(--text, #eee);
    }
    .bt-tour-btn:hover { background: var(--surface-hover, #303039); }
    .bt-tour-btn:disabled { opacity: 0.4; cursor: default; }
    .bt-tour-btn.primary { background: var(--accent, #7c6cf0); color: #fff; }
    .bt-tour-btn.primary:hover { background: var(--accent-hover, #6a5ae0); }
    .bt-tour-btn svg { display: block; }
    /* Подсказки инструментов (tooltip.js) лежат ниже тени тура — под ней их
       не прочесть; поднимаем на время тура. */
    body.bt-tour-active .bt-tip { z-index: 452; }
  `,document.head.appendChild(e)}function V(e){if(!e)return null;let r=null;try{r=typeof e=="function"?e():document.querySelector(e)}catch{r=null}if(!r||!r.isConnected)return null;const d=r.getBoundingClientRect();return!d.width&&!d.height?null:r}function J(e){if(!e)return 0;try{const r=parseInt(localStorage.getItem(R+e)||"",10);return Number.isFinite(r)&&r>=0?r:0}catch{return 0}}function S(e,r){if(e)try{r===null?localStorage.removeItem(R+e):localStorage.setItem(R+e,String(r))}catch{}}const D="bt.tutorial.hint.";function tt(e){try{if(localStorage.getItem(D+e))return!1;localStorage.setItem(D+e,"1")}catch{}return!0}function et(e){S(e,null);try{const r=[];for(let d=0;d<localStorage.length;d++){const y=localStorage.key(d);y&&y.startsWith(D)&&r.push(y)}r.forEach(d=>localStorage.removeItem(d))}catch{}}let v=null;function nt(e,{key:r,onFinish:d,onSkip:y}={}){v&&v.stop(),U();const s=document.createElement("div");s.className="bt-tour-spot bt-tour-spot--none";const o=document.createElement("div");o.className="bt-tour-card",o.setAttribute("role","dialog"),o.setAttribute("aria-live","polite"),document.body.append(s,o),document.body.classList.add("bt-tour-active");let a=Math.min(J(r),e.length-1),F=null,M=!1,W=null,C="",w=null;function z(){M||(M=!0,clearInterval(F),window.removeEventListener("resize",E),window.removeEventListener("scroll",E,!0),s.remove(),o.remove(),document.body.classList.remove("bt-tour-active"),v===H&&(v=null))}function N(){S(r,null),z(),d&&d()}function G(){S(r,null),z(),y&&y()}async function x(n){a=Math.max(0,Math.min(n,e.length-1)),S(r,a);const t=e[a];if(C=t.placement||"",w=null,t.before){try{await t.before()}catch(l){console.error("режим обучения: шаг не подготовился:",l)}if(M||e[a]!==t)return}if(X(t)){a===e.length-1?N():x(a+1);return}O(t),E()}function X(n){if(!n.waitFor)return!1;try{return!!n.waitFor()}catch{return!1}}function O(n){o.replaceChildren();const t=document.createElement("div");t.className="bt-tour-head";const l=document.createElement("span");l.className="bt-tour-counter",l.textContent=`${a+1} / ${e.length}`;const p=document.createElement("h3");p.className="bt-tour-title",p.textContent=n.title,t.append(l,p),t.addEventListener("pointerdown",Y),o.appendChild(t);for(const k of String(n.text).split(/\n\s*\n/)){const g=document.createElement("p");g.className="bt-tour-text",K(g,k.trim()),o.appendChild(g)}const f=document.createElement("div");f.className="bt-tour-foot";const u=document.createElement("button");u.type="button",u.className="bt-tour-skip",u.textContent="Пропустить тур",u.onclick=G;const i=document.createElement("button");i.type="button",i.className="bt-tour-btn",i.innerHTML=P("chevron-left",{size:14})+"<span>Назад</span>",i.disabled=a===0,i.onclick=()=>x(a-1);const c=document.createElement("button");c.type="button",c.className="bt-tour-btn primary";const b=a===e.length-1;c.innerHTML=b?"<span>Готово</span>"+P("check",{size:14}):"<span>Далее</span>"+P("chevron-right",{size:14}),c.onclick=()=>b?N():x(a+1),f.append(u,i,c),o.appendChild(f)}function E(){if(M)return;const n=e[a];if(X(n)){a===e.length-1?N():x(a+1);return}const t=V(n.target);t!==W&&(W=t,s.style.transition="none",requestAnimationFrame(()=>s.style.transition=""),t&&t.scrollIntoView({block:"nearest",inline:"nearest"}));const l=window.innerWidth,p=window.innerHeight,f=o.offsetWidth,u=o.offsetHeight;if(!t){s.classList.add("bt-tour-spot--none"),s.style.left=Math.round(l/2)+"px",s.style.top=Math.round(p/2)+"px",s.style.width="0px",s.style.height="0px",T((l-f)/2,(p-u)/2);return}const i=t.getBoundingClientRect(),c=i.left-I,b=i.top-I,k=i.width+I*2,g=i.height+I*2;s.classList.remove("bt-tour-spot--none"),s.style.left=Math.round(c)+"px",s.style.top=Math.round(b)+"px",s.style.width=Math.round(k)+"px",s.style.height=Math.round(g)+"px";const _={right:c+k+m+f+h<=l,left:c-m-f-h>=0,bottom:b+g+m+u+h<=p,top:b-m-u-h>=0};let L=C&&_[C]?C:"";L||(L=["right","left","bottom","top"].find(q=>_[q])||"bottom");let A,B;L==="right"||L==="left"?(A=L==="right"?c+k+m:c-m-f,B=b+g/2-u/2):(A=c+k/2-f/2,B=L==="bottom"?b+g+m:b-m-u),T(A,B)}function T(n,t){w&&({x:n,y:t}=w);const l=o.offsetWidth,p=o.offsetHeight;n=Math.max(h,Math.min(n,window.innerWidth-l-h)),t=Math.max(h,Math.min(t,window.innerHeight-p-h)),o.style.left=Math.round(n)+"px",o.style.top=Math.round(t)+"px"}function Y(n){if(n.button!==0)return;n.preventDefault();const t=n.currentTarget,l=o.getBoundingClientRect(),p=n.clientX-l.left,f=n.clientY-l.top;o.classList.add("bt-tour-card--dragging"),t.setPointerCapture(n.pointerId);const u=c=>{w={x:c.clientX-p,y:c.clientY-f},T(w.x,w.y)},i=()=>{t.removeEventListener("pointermove",u),t.removeEventListener("pointerup",i),t.removeEventListener("pointercancel",i),o.classList.remove("bt-tour-card--dragging")};t.addEventListener("pointermove",u),t.addEventListener("pointerup",i),t.addEventListener("pointercancel",i)}const H={next:()=>x(a+1),prev:()=>x(a-1),stop:z,get index(){return a}};return v=H,F=setInterval(E,$),window.addEventListener("resize",E),window.addEventListener("scroll",E,!0),x(a),H}function rt(){v&&v.stop()}export{rt as a,et as c,nt as s,tt as t};
