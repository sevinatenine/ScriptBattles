import hljs from "/lib/highlight.js/core.js";
import javascript from "/lib/highlight.js/languages/javascript.min.js";
hljs.registerLanguage("javascript", javascript);

const editor = document.getElementById("editor");
const code = document.querySelector("#hl code");
const pre = document.getElementById("hl");

function sync() {
    code.textContent = editor.value + "\n";
    delete code.dataset.highlighted;
    hljs.highlightElement(code);
    pre.scrollTop = editor.scrollTop;
    pre.scrollLeft = editor.scrollLeft;
}
editor.addEventListener("input", sync);
editor.addEventListener("scroll", () => { pre.scrollTop = editor.scrollTop; pre.scrollLeft = editor.scrollLeft; });
window.refreshHighlight = sync;

hljs.highlightAll();