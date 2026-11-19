const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const container = document.getElementById("container");

const scriptsList = document.getElementById("scriptsList");
const editor = document.getElementById("editor");

const statsEl = document.getElementById("stats-box");

const socket = io({ autoConnect: false });

let width = 0;
let height = 0;

const CELL_WIDTH = 64;
const CELL_HEIGHT = 64;

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;

const player = {
    col: 0,
    row: 0,

    get x() { return (this.col + 0.5) * CELL_WIDTH; },
    get y() { return (this.row + 0.5) * CELL_HEIGHT; },
};

const camera = {
    x: 0,
    y: 0,
    zoom: 1,
    target: player,
    smoothing: 10
};

function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    width = canvas.clientWidth;
    height = canvas.clientHeight;

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function worldToScreen(wx, wy) {
    return {
        x: (wx - camera.x) * camera.zoom + width / 2,
        y: (wy - camera.y) * camera.zoom + height / 2,
    };
}

function screenToWorld(sx, sy) {
    return {
        x: (sx - width / 2) / camera.zoom + camera.x,
        y: (sy - height / 2) / camera.zoom + camera.y,
    };
}

canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.001);
    camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.zoom * factor));
}, { passive: false });

function updateCamera(dt) {
    if (!camera.target) return;

    if (camera.smoothing <= 0) {
        camera.x = camera.target.x;
        camera.y = camera.target.y;
    } else {
        const t = 1 - Math.exp(-camera.smoothing * dt);
        camera.x += (camera.target.x - camera.x) * t;
        camera.y += (camera.target.y - camera.y) * t;
    }
}

function drawGrid(x, y) {
    const cw = CELL_WIDTH * camera.zoom;
    const ch = CELL_HEIGHT * camera.zoom;

    const maxLeft  = Math.ceil(x / cw);
    const maxRight = Math.ceil((width - x) / cw);
    const maxUp    = Math.ceil(y / ch);
    const maxDown  = Math.ceil((height - y) / ch);

    ctx.strokeStyle = "#ccc";
    ctx.lineWidth = 1;
    ctx.beginPath();

    for (let i = -maxLeft; i <= maxRight; i++) {
        const px = Math.round(x + i * cw) + 0.5;
        ctx.moveTo(px, 0);
        ctx.lineTo(px, height);
    }

    for (let j = -maxUp; j <= maxDown; j++) {
        const py = Math.round(y + j * ch) + 0.5;
        ctx.moveTo(0, py);
        ctx.lineTo(width, py);
    }

    ctx.stroke();
}

function drawPlayer() {
    const p = worldToScreen(player.x, player.y);
    const w = CELL_WIDTH * camera.zoom;
    const h = CELL_HEIGHT * camera.zoom;
    ctx.fillStyle = "#e33";
    ctx.fillRect(p.x - w / 2, p.y - h / 2, w, h);
}

new ResizeObserver(resizeCanvas).observe(canvas);

let entities = [];
socket.on("entities", (list) => { entities = list; });

const BOT = "#36c";
const BOT_HIT = "#00eeff";
const PLAYER = "#3a3";
const PLAYER_HIT = "rgb(0, 255, 0)";
const HIT_DURATION = 400;

function drawEntities() {
    const w = CELL_WIDTH * camera.zoom, h = CELL_HEIGHT * camera.zoom;
    for (const e of entities) {
        if (e.name === player.username) continue;
        const p = worldToScreen((e.col + 0.5) * CELL_WIDTH, (e.row + 0.5) * CELL_HEIGHT);
        ctx.fillStyle = e.type === "bot" ? ((Date.now() - e.lastHit) > HIT_DURATION ? BOT : BOT_HIT) : ((Date.now() - e.lastHit) > HIT_DURATION ? PLAYER : PLAYER_HIT);
        ctx.fillRect(p.x - w / 2, p.y - h / 2, w, h);
    }
}

let last = performance.now();
function draw(now) {
    const dt = (now - last) / 1000;
    last = now;

    updateCamera(dt);

    ctx.clearRect(0, 0, width, height);

    const origin = worldToScreen(0, 0);
    drawGrid(origin.x, origin.y);
    drawPlayer();
    drawEntities();

    requestAnimationFrame(draw);
}

function reloadScripts() {
    scriptsList.replaceChildren();

    console.log(player.scripts);

    for (const s of player.scripts) {
        const row = document.createElement("div");

        row.classList.add("script-row");

        if (s.id == selectedId) {
            row.classList.add("selected");
        }

        const btn = document.createElement("button");
        btn.textContent = s.status.running ? "Stop" : "Start";

        const name = document.createElement("span");
        name.textContent = s.status.error ? `${s.name} ⚠ ${s.status.error}` : s.name;
        if (s.status.error) name.style.color = "#c00";

        const controls = document.createElement("div");
        controls.className = "controls";

        const btn3 = document.createElement("button");
        btn3.textContent = "Rename";

        const btn2 = document.createElement("button");
        btn2.textContent = "Delete";

        const center = document.createElement("div");
        center.style = "flex: 1;";

        controls.append(btn3, btn2);

        row.addEventListener("click", () => selectScript(s.id));
        btn.addEventListener("click", (e) => { e.stopPropagation(); toggleRun(s.id); });
        btn3.addEventListener("click", (e) => { e.stopPropagation(); renameScript(s.id); });
        btn2.addEventListener("click", (e) => { e.stopPropagation(); deleteScript(s.id); });

        row.append(btn, name, center, controls);
        scriptsList.appendChild(row);
    }
}

function createScript() {
    
}

function toggleRun(id) {
    socket.emit("toggleScript", id);
}

socket.on("connect_error", () => {
    container.hidden = true;
    loginForm.hidden = false;
});

resizeCanvas();

socket.on("scriptStopped", (data) => {

});

let stats = { level: 1, xp: 0, next: 50 };

function renderStats() {
    statsEl.textContent =
        `Level ${stats.level} · ${stats.xp}/${stats.next} XP\n` +
        `Position (${player.col}, ${player.row})`;
}

socket.on("stats", (s) => { stats = s; renderStats(); });
socket.on("playerMove", ({ col, row }) => { player.col = col; player.row = row; renderStats(); });

let selectedId = null;
let selectNext = false;
let saveTimer = null;

function selectScript(id) {
    selectedId = id;
    const s = player.scripts.find(x => x.id === id);
    editor.disabled = !s;
    editor.value = s ? s.script : "";
    reloadScripts();
}

function createScript() {
    selectNext = true;
    socket.emit("createScript");
}

function renameScript(id) {
    const s = player.scripts.find(x => x.id === id);
    const name = prompt("New name:", s?.name);
    if (name && name.trim()) socket.emit("renameScript", { id, name: name.trim() });
}

function deleteScript(id) {
    if (confirm("Delete this script?")) socket.emit("deleteScript", id);
}

editor.addEventListener("input", () => {
    if (!selectedId) return;
    const id = selectedId, script = editor.value;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => socket.emit("saveScript", { id, script }), 400);
});

socket.on("scriptData", (s) => {
    const i = player.scripts.findIndex(x => x.id === s.id);
    const isNew = i === -1;
    if (isNew) player.scripts.push(s);
    else player.scripts[i] = s;

    if (isNew && selectNext) { selectNext = false; selectScript(s.id); return; }

    if (s.id === selectedId && document.activeElement !== editor) editor.value = s.script;
    reloadScripts();
});

socket.on("scriptDeleted", (id) => {
    player.scripts = player.scripts.filter(x => x.id !== id);
    if (selectedId === id) selectScript(player.scripts[0]?.id ?? null);
    else reloadScripts();
});

canvas.tabIndex = 0;
canvas.addEventListener("pointerdown", () => canvas.focus());

const GAME_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "]);

canvas.addEventListener("keydown", (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (GAME_KEYS.has(e.key)) e.preventDefault();
    socket.emit("event", "key", e.key);
});

async function init() {
    let me;
    try {
        const r = await fetch("/me");
        if (!r.ok) throw new Error();
        me = await r.json();
    } catch {
        container.hidden = true;
        loginForm.hidden = false;
        return;
    }
    player.username = me.username;
    player.scripts = me.data?.scripts ?? [];
    player.col = me.data?.col ?? 0;
    player.row = me.data?.row ?? 0;
    socket.connect();
    reloadScripts();
    requestAnimationFrame(draw);
}

init();