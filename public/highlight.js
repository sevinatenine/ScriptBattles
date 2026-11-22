import hljs from "/lib/highlight.js/core.js";
import javascript from "/lib/highlight.js/languages/javascript.min.js";
hljs.registerLanguage("javascript", javascript);

const editor = document.getElementById("editor");
const code = document.querySelector("#hl code");
const pre = document.getElementById("hl");

function syncScroll() {
    pre.scrollTop = editor.scrollTop;
    pre.scrollLeft = editor.scrollLeft;
}

function sync() {
    const v = editor.value;
    code.textContent = v.endsWith("\n") ? v + " " : v;
    delete code.dataset.highlighted;
    hljs.highlightElement(code);
    syncScroll();
}

editor.addEventListener("input", sync);
editor.addEventListener("scroll", syncScroll);
window.refreshHighlight = sync;

hljs.highlightAll();