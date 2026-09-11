// WYSIWYG-редактор записи (TipTap) поверх markdown: markdown → документ →
// markdown, хранилище и просмотр (notes/markdown.js) не меняются.
// Свой синтаксис, который иначе не пережил бы сериализацию: [[вики-ссылки]],
// врезки beacon-readaloud/beacon-dm-note, <a class="catalog-ref"> из импорта,
// подчёркивание как <u>.
import { Editor, Node, Mark, nodeInputRule } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Underline } from "@tiptap/extension-underline";
import { Image } from "@tiptap/extension-image";
import { TableKit } from "@tiptap/extension-table";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import { Markdown } from "@tiptap/markdown";
import { uploadFile } from "../api.js";
import { splitWikiTarget } from "./markdown.js";

// ---- [[вики-ссылка]] ----

const wikiRe = /^\[\[([^\]|\n]+?)(?:\|([^\]\n]+?))?\]\]/;

function wikiText(attrs) {
  return attrs.label ? `[[${attrs.target}|${attrs.label}]]` : `[[${attrs.target}]]`;
}

// Подпись — заголовок без пути; макросы Foundry "[[/r 2d6]]" — как есть.
function wikiLabel(attrs) {
  if (attrs.label) return attrs.label;
  if (attrs.target.startsWith("/")) return `[[${attrs.target}]]`;
  return splitWikiTarget(attrs.target).title || attrs.target;
}

const WikiLink = Node.create({
  name: "wikiLink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return { target: { default: "" }, label: { default: null } };
  },

  parseHTML() {
    return [
      {
        tag: "a[data-wiki-target]",
        getAttrs: (el) => ({ target: el.getAttribute("data-wiki-target"), label: el.getAttribute("data-wiki-label") || null }),
      },
      {
        // ссылка из отрендеренного просмотра (копипаста)
        tag: 'a[href^="wikilink:"]',
        getAttrs: (el) => {
          const target = decodeURIComponent(el.getAttribute("href").slice("wikilink:".length));
          const text = el.textContent.trim();
          return { target, label: text && text !== splitWikiTarget(target).title ? text : null };
        },
      },
    ];
  },

  renderHTML({ node }) {
    const cls = "wikilink" + (node.attrs.target.startsWith("/") ? " wikilink-macro" : "");
    return [
      "a",
      { class: cls, "data-wiki-target": node.attrs.target, "data-wiki-label": node.attrs.label, title: node.attrs.target },
      wikiLabel(node.attrs),
    ];
  },

  renderText({ node }) {
    return wikiText(node.attrs);
  },

  markdownTokenName: "wikiLink",
  markdownTokenizer: {
    name: "wikiLink",
    level: "inline",
    start: (src) => src.indexOf("[["),
    tokenize(src) {
      const m = wikiRe.exec(src);
      if (!m) return undefined;
      return { type: "wikiLink", raw: m[0], target: m[1].trim(), label: m[2] ? m[2].trim() : null };
    },
  },
  parseMarkdown: (token, h) => h.createNode("wikiLink", { target: token.target, label: token.label }),
  renderMarkdown: (node) => wikiText(node.attrs || { target: "" }),

  addInputRules() {
    // "[[Имя]]" руками → ссылка
    return [
      nodeInputRule({
        find: /\[\[([^\]|\n]+?)(?:\|([^\]\n]+?))?\]\]$/,
        type: this.type,
        getAttributes: (m) => ({ target: m[1].trim(), label: m[2] ? m[2].trim() : null }),
      }),
    ];
  },
});

// ---- врезки «зачитать вслух» / «совет Мастеру» ----

const CALLOUT_CLASS = { readaloud: "beacon-readaloud", dmnote: "beacon-dm-note" };
const calloutOpenRe = /<(aside|section)\s+class="beacon-(readaloud|dm-note)"[^>]*>/;

const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return { kind: { default: "readaloud" } };
  },

  parseHTML() {
    return [
      { tag: "aside.beacon-readaloud, section.beacon-readaloud", attrs: { kind: "readaloud" } },
      { tag: "aside.beacon-dm-note, section.beacon-dm-note", attrs: { kind: "dmnote" } },
    ];
  },

  renderHTML({ node }) {
    return ["aside", { class: CALLOUT_CLASS[node.attrs.kind] || CALLOUT_CLASS.readaloud }, 0];
  },

  markdownTokenName: "callout",
  markdownTokenizer: {
    name: "callout",
    level: "block",
    start: (src) => src.search(calloutOpenRe),
    tokenize(src, _tokens, lexer) {
      const open = calloutOpenRe.exec(src);
      if (!open || open.index !== 0) return undefined;
      const close = src.indexOf(`</${open[1]}>`, open[0].length);
      if (close === -1) return undefined;
      const end = close + open[1].length + 3;
      const trailing = /^[^\S\n]*\n?/.exec(src.slice(end))[0];
      const inner = src.slice(open[0].length, close).trim();
      return {
        type: "callout",
        raw: src.slice(0, end) + trailing,
        kind: open[2] === "dm-note" ? "dmnote" : "readaloud",
        tokens: lexer.blockTokens(inner),
      };
    },
  },
  parseMarkdown: (token, h) => {
    const parse = h.parseBlockChildren ?? h.parseChildren;
    return h.createNode("callout", { kind: token.kind }, parse(token.tokens || []));
  },
  // Пустые строки внутри — иначе marked примет содержимое за сырой HTML.
  renderMarkdown: (node, h) =>
    `<aside class="${CALLOUT_CLASS[node.attrs?.kind] || CALLOUT_CLASS.readaloud}">\n\n${h.renderChildren(node.content || [], "\n\n")}\n\n</aside>`,

  addCommands() {
    return {
      toggleCallout:
        (attrs) =>
        ({ commands }) =>
          commands.toggleWrap(this.name, attrs),
    };
  },
});

// ---- <a class="catalog-ref"> — ссылка на карточку компендиума ----

const CatalogRef = Mark.create({
  name: "catalogRef",
  priority: 1001, // снаружи жирного/курсива, как и обычная ссылка

  addAttributes() {
    return {
      kind: { default: "", parseHTML: (el) => el.getAttribute("data-kind") },
      name: { default: "", parseHTML: (el) => el.getAttribute("data-name") },
      folder: { default: null, parseHTML: (el) => el.getAttribute("data-folder") },
      section: { default: null, parseHTML: (el) => el.getAttribute("data-section") },
    };
  },

  parseHTML() {
    return [{ tag: "a.catalog-ref" }];
  },

  renderHTML({ mark }) {
    const a = mark.attrs;
    return [
      "a",
      { class: "catalog-ref", "data-kind": a.kind, "data-name": a.name, "data-folder": a.folder, "data-section": a.section },
      0,
    ];
  },

  renderMarkdown: (node, h) => {
    const a = node.attrs || {};
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    let attrs = `class="catalog-ref" data-kind="${esc(a.kind)}" data-name="${esc(a.name)}"`;
    if (a.folder) attrs += ` data-folder="${esc(a.folder)}"`;
    if (a.section) attrs += ` data-section="${esc(a.section)}"`;
    return `<a ${attrs}>${h.renderChildren(node)}</a>`;
  },
});

const NoteUnderline = Underline.extend({
  renderMarkdown: (node, h) => `<u>${h.renderChildren(node)}</u>`,
});

// Картинка строчная (в импорте стоит внутри абзаца), поэтому абзац из одной
// картинки не разворачиваем, как делает родной Paragraph.
const NoteImage = Image.configure({ inline: true });

const NBSP = " ";
const NoteParagraph = Paragraph.extend({
  parseMarkdown: (token, h) => {
    const tokens = token.tokens || [];
    const onlyNbsp =
      tokens.length === 1 && tokens[0].type === "text" && ["&nbsp;", NBSP].includes(tokens[0].raw ?? tokens[0].text);
    return h.createNode("paragraph", undefined, onlyNbsp ? [] : h.parseInline(tokens));
  },
});

// noteExtensions — отдельно, чтобы тест собрал MarkdownManager без DOM.
export function noteExtensions() {
  return [
    StarterKit.configure({
      paragraph: false,
      underline: false,
      link: { openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: "https" },
      codeBlock: { defaultLanguage: null },
    }),
    NoteParagraph,
    NoteUnderline,
    NoteImage,
    TableKit.configure({ table: { resizable: false } }),
    // чекбоксы «- [ ]», вложенные тоже
    TaskList,
    TaskItem.configure({ nested: true }),
    WikiLink,
    Callout,
    CatalogRef,
    Markdown.configure({ markedOptions: { breaks: true, gfm: true } }),
  ];
}

// insertUpload — картинка вставляется картинкой, прочие файлы — ссылкой.
async function insertUpload(editor, file, pos) {
  const { url } = await uploadFile(file, "notes");
  const name = file.name.replace(/\.[^./\\]+$/, "");
  const chain = editor.chain().focus();
  if (pos != null) chain.setTextSelection(pos);
  if (file.type.startsWith("image/")) {
    chain.setImage({ src: url, alt: name }).run();
  } else {
    chain.insertContent({ type: "text", text: name, marks: [{ type: "link", attrs: { href: url } }] }).run();
  }
}

// createNoteEditor(mountEl, { onUpdate, onUploadError }) — редактор в mountEl;
// onUpdate — на правку документа, onUploadError — файл не загрузился.
export function createNoteEditor(mountEl, { onUpdate, onUploadError } = {}) {
  const editor = new Editor({
    element: mountEl,
    extensions: noteExtensions(),
    content: "",
    onUpdate: ({ editor: ed, transaction }) => {
      if (transaction.docChanged && onUpdate) onUpdate(ed);
    },
    editorProps: {
      attributes: { class: "note-render note-editor-content" },
      handlePaste: (view, event) => {
        const files = [...(event.clipboardData?.files || [])];
        if (!files.length) return false;
        event.preventDefault();
        uploadAll(files, null);
        return true;
      },
      handleDrop: (view, event) => {
        const files = [...(event.dataTransfer?.files || [])];
        if (!files.length) return false;
        event.preventDefault();
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
        uploadAll(files, at ? at.pos : null);
        return true;
      },
    },
  });

  function uploadAll(files, pos) {
    (async () => {
      for (const f of files) await insertUpload(editor, f, pos);
    })().catch((err) => onUploadError && onUploadError(err));
  }

  return {
    editor,
    setMarkdown(md) {
      // "1. [ ]" парсер не понимает и испортил бы при сохранении — делаем "- [ ]"
      const text = (md || "").replace(/^(\s*)\d+[.)](\s+\[(?: |x|X)\])/gm, "$1-$2");
      editor.commands.setContent(text, { contentType: "markdown", emitUpdate: false });
    },
    getMarkdown() {
      return editor.getMarkdown();
    },
    insertFile(file) {
      return insertUpload(editor, file, null);
    },
    focus(where) {
      editor.commands.focus(where);
    },
    destroy() {
      editor.destroy();
    },
  };
}
