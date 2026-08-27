import{s as S}from"./markdown-CH_1mRWr.js";import{u as x}from"./api-DNvZmt1E.js";import{s as $,b as y}from"./modal-g49pjxWl.js";const C=`
  position: fixed; z-index: 60; min-width: 200px; max-width: 340px;
  max-height: 60vh; overflow-y: auto; padding: 4px;
  background: var(--panel-bg, #1e1e22); color: var(--text, #eee);
  border: 1px solid var(--border, #3a3a40); border-radius: 10px;
  box-shadow: var(--shadow-float, 0 8px 30px rgba(0,0,0,.4)); font-size: 12.5px;
`,W=`
  display: block; width: 100%; box-sizing: border-box; text-align: left;
  padding: 6px 10px; border: none; border-radius: 6px; background: none;
  color: inherit; font: inherit; cursor: pointer; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
`;function z(n,e){if(!n||!e)return{refresh(){}};let t=null;const o=()=>[...e.querySelectorAll("h1, h2, h3, h4")].filter(a=>a.textContent.trim()&&!a.closest(".beacon-readaloud, .beacon-dm-note"));function l(){t&&(t.remove(),t=null,document.removeEventListener("click",s,!0),document.removeEventListener("keydown",i),window.removeEventListener("resize",l))}function s(a){t&&!t.contains(a.target)&&!n.contains(a.target)&&l()}function i(a){a.key==="Escape"&&l()}function c(){const a=o();if(a.length<2)return;const d=Math.min(...a.map(u=>+u.tagName[1]));t=document.createElement("div"),t.setAttribute("style",C);for(const u of a){const m=+u.tagName[1],r=document.createElement("button");r.type="button",r.setAttribute("style",W+`padding-left:${10+(m-d)*14}px;`),m===d&&(r.style.fontWeight="600"),m>d+1&&(r.style.opacity=".7"),r.textContent=u.textContent.trim(),r.addEventListener("mouseenter",()=>r.style.background="var(--surface-hover, #34343a)"),r.addEventListener("mouseleave",()=>r.style.background="none"),r.addEventListener("click",()=>{l(),S(e,u)}),t.appendChild(r)}document.body.appendChild(t);const f=n.getBoundingClientRect(),p=t.offsetWidth;t.style.top=Math.round(f.bottom+4)+"px",t.style.left=Math.round(Math.max(8,Math.min(f.right-p,window.innerWidth-p-8)))+"px",setTimeout(()=>{document.addEventListener("click",s,!0),document.addEventListener("keydown",i),window.addEventListener("resize",l)},0)}return n.addEventListener("click",a=>{a.stopPropagation(),t?l():c()}),{refresh(){l(),n.style.display=o().length>=2?"":"none"}}}function h(n,e,t,o){n.value=e,n.setSelectionRange(t,o),n.focus(),n.dispatchEvent(new Event("input",{bubbles:!0}))}function b(n,e,t,o){const{selectionStart:l,selectionEnd:s,value:i}=n,c=i.slice(l,s)||o,a=i.slice(0,l)+e+c+t+i.slice(s),d=l+e.length;h(n,a,d,d+c.length)}function E(n,e,t){const{selectionStart:o,selectionEnd:l,value:s}=n,i=s.slice(0,o)+e+s.slice(l),c=o+e.length;h(n,i,c,c)}function w(n,e){const t=n.lastIndexOf(`
`,e-1)+1;let o=n.indexOf(`
`,e);return o===-1&&(o=n.length),{lineStart:t,lineEnd:o}}function g(n,e){const{value:t,selectionStart:o}=n,{lineStart:l,lineEnd:s}=w(t,o),i=t.slice(l,s),c=(i.match(/^#{1,6}(?=\s|$)/)||[""])[0].length,a=i.replace(/^#{1,6}\s*/,""),d=c===e?a:"#".repeat(e)+" "+a,f=t.slice(0,l)+d+t.slice(s),p=l+d.length;h(n,f,p,p)}function v(n,e,t){const{value:o,selectionStart:l,selectionEnd:s}=n,{lineStart:i}=w(o,l),{lineEnd:c}=w(o,Math.max(s,l)),d=o.slice(i,c).split(`
`),u=((t?d.every(r=>/^\d+\.\s/.test(r)):d.every(r=>r.startsWith(e)))?d.map(r=>r.replace(t?/^\d+\.\s/:new RegExp("^"+e.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")),"")):d.map((r,L)=>t?`${L+1}. ${r}`:e+r)).join(`
`),m=o.slice(0,i)+u+o.slice(c);h(n,m,i,i+u.length)}async function A(n){const{selectionStart:e,selectionEnd:t,value:o}=n,l=o.slice(e,t),s=await y("Адрес ссылки:",{title:"Ссылка",value:"https://",okLabel:"Вставить"});if(!s)return;const c=`[${l||await y("Текст ссылки:",{title:"Ссылка",value:s,okLabel:"Вставить"})||s}](${s})`;h(n,o.slice(0,e)+c+o.slice(t),e+c.length,e+c.length)}function M(n){const{selectionStart:e,selectionEnd:t,value:o}=n,l=o.slice(e,t),s=o.slice(0,e)+"[["+l+"]]"+o.slice(t),i=e+2;h(n,s,i,i+l.length)}function k(n,e){const{selectionStart:t,value:o}=n,l=o.slice(0,t),s=o.slice(t),i=l.length===0||l.endsWith(`

`)?"":l.endsWith(`
`)?`
`:`

`,c=s.length===0||s.startsWith(`
`)?"":`

`;E(n,i+e+c)}function V(n){k(n,`| Заголовок 1 | Заголовок 2 | Заголовок 3 |
| --- | --- | --- |
| ячейка | ячейка | ячейка |`)}function B(n){const{selectionStart:e,selectionEnd:t,value:o}=n,l=(o.slice(e,t)||"Текст, который зачитывают игрокам.").trim(),s=o.slice(0,e),i=o.slice(t),c=s===""||s.endsWith(`

`)?"":s.endsWith(`
`)?`
`:`

`,a=i===""||i.startsWith(`
`)?"":`

`,d=`<aside class="beacon-readaloud">

`,f=d+l+`

</aside>`,p=s+c+f+a+i,u=s.length+c.length+d.length;h(n,p,u,u+l.length)}async function H(n,e){const{url:t}=await x(e,"notes"),o=e.name.replace(/\.[^./\\]+$/,""),l=e.type.startsWith("image/");E(n,l?`![${o}](${t})`:`[${o}](${t})`)}function P(n,e){n.innerHTML="";const t=document.createElement("input");t.type="file",t.className="note-toolbar-file-input",t.onchange=()=>{const l=t.files[0];t.value="",l&&H(e,l).catch(s=>$("Не удалось загрузить файл: "+s.message))},n.appendChild(t);const o=[[{label:"H1",title:"Заголовок 1 уровня",action:()=>g(e,1)},{label:"H2",title:"Заголовок 2 уровня",action:()=>g(e,2)},{label:"H3",title:"Заголовок 3 уровня",action:()=>g(e,3)}],[{label:"B",cls:"tb-bold",title:"Жирный",action:()=>b(e,"**","**","текст")},{label:"I",cls:"tb-italic",title:"Курсив",action:()=>b(e,"*","*","текст")},{label:"S",cls:"tb-strike",title:"Зачёркнутый",action:()=>b(e,"~~","~~","текст")},{label:"<>",title:"Код",action:()=>b(e,"`","`","код")}],[{label:"☰",title:"Маркированный список",action:()=>v(e,"- ")},{label:"①",title:"Нумерованный список",action:()=>v(e,"",!0)},{label:"❝",title:"Цитата",action:()=>v(e,"> ")},{label:"📢",title:"Врезка «зачитать вслух» игрокам",action:()=>B(e)}],[{label:"🔗",title:"Вставить ссылку",action:()=>A(e)},{label:"[[·]]",title:"Вставить вики-ссылку на другую заметку — можно с папкой: [[Глава 1/Таверна]]",action:()=>M(e)},{label:"📎",title:"Вставить файл или картинку",action:()=>t.click()},{label:"▦",title:"Вставить таблицу",action:()=>V(e)},{label:"―",title:"Разделитель",action:()=>k(e,"---")}]];for(const l of o){const s=document.createElement("div");s.className="note-toolbar-group";for(const i of l){const c=document.createElement("button");c.type="button",c.className="note-toolbar-btn"+(i.cls?" "+i.cls:""),c.textContent=i.label,c.title=i.title,c.onmousedown=a=>a.preventDefault(),c.onclick=i.action,s.appendChild(c)}n.appendChild(s)}}export{z as a,P as m};
