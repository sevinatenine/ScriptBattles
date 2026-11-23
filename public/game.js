const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const container = document.getElementById("container");

const scriptsList = document.getElementById("scriptsList");
const editor = document.getElementById("editor");

const leaderboardTable = document.getElementById("leaderboard-tbody");

const statsEl = document.getElementById("stats-tbody");

const notificationsElem = document.getElementById("notificationsOverlay");
var notifications = [];

const NOTIFICATION_REMOVE_DELAY = 3000;
const NOTIFICATION_ANIM_MS = 300;

function dismissNotification(n) {
    if (n.leaving) return;
    n.leaving = true;
    n.elem.classList.add("leaving");
    setTimeout(() => {
        n.elem.remove();
        notifications = notifications.filter(e => e !== n);
    }, NOTIFICATION_ANIM_MS);
}

function makeNotification(header, body) {
    const elem = document.createElement("div");
    elem.className = "notification";

    const headerElem = document.createElement("span");
    headerElem.textContent = header;
    headerElem.classList.add("header");

    const bodyElem = document.createElement("span");
    bodyElem.textContent = body;
    bodyElem.classList.add("body");

    elem.append(headerElem, bodyElem);

    var n = {
        header,
        body,
        elem
    };

    notifications.push(n);

    setTimeout(() => dismissNotification(n), NOTIFICATION_REMOVE_DELAY);
    elem.addEventListener("click", () => dismissNotification(n));

    notificationsElem.appendChild(elem);
}

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

const KINDS = ["wanderer","crawler","skulker","brute","stalker","warden","reaver","revenant","colossus","horror", "player", "other"];

var images = {
    heart: "assets/heart.png",
    wall: "assets/wall.png"
};

for (var i of KINDS) {
    images[i] = `assets/sprites/${i}.png`;
    images[i + "_hit"] = `assets/sprites/${i}_hit.png`;
}

const loadedImages = {};

function preloadImages() {
    Object.entries(images).forEach(([name, url]) => {
        const img = new Image();

        img.src = url;

        img.addEventListener("load", () => {
            loadedImages[name] = img;
        })
    });
}

preloadImages();

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

function drawSprite(name, fallback, p, w, h) {
    const img = loadedImages[name];
    if (img) {
        ctx.save();
        ctx.imageSmoothingEnabled = img.width > w;
        ctx.drawImage(img, Math.round(p.x - w / 2), Math.round(p.y - h / 2), Math.ceil(w), Math.ceil(h));
        ctx.restore();
    } else {
        ctx.fillStyle = fallback;
        ctx.fillRect(p.x - w / 2, p.y - h / 2, w, h);
    }
}

function drawPlayer() {
    const p = worldToScreen(player.x, player.y);
    const w = CELL_WIDTH * camera.zoom;
    const h = CELL_HEIGHT * camera.zoom;

    const me = entities.find(e => e.name === player.username);
    const hit = me && (Date.now() - me.lastHit) <= HIT_DURATION;

    drawSprite(hit ? "player_hit" : "player", hit ? "#f88" : "#e33", p, w, h);
}

new ResizeObserver(resizeCanvas).observe(canvas);

let entities = [];
socket.on("entities", (list) => { entities = list; });

const BOT_FALLBACK = { color: "#888", hit: "#fff" };

function botColors(kind) {
    const i = KINDS.indexOf(kind);
    if (i < 0) return BOT_FALLBACK;
    const hue = 210 + i * (150 / 9);
    return { color: `hsl(${hue}, 65%, 45%)`, hit: `hsl(${hue}, 100%, 70%)` };
}

function entityColors(e) {
    const hit = (Date.now() - e.lastHit) <= HIT_DURATION;
    if (e.type === "bot") {
        const c = botColors(e.kind) ?? BOT_FALLBACK;
        return hit ? c.hit : c.color;
    }
    return hit ? PLAYER_HIT : PLAYER;
}

// const BOT = "#36c";
// const BOT_HIT = "#00eeff";
const PLAYER = "#3a3";
const PLAYER_HIT = "rgb(0, 255, 0)";
const HIT_DURATION = 400;

function drawEntities() {
    const w = CELL_WIDTH * camera.zoom, h = CELL_HEIGHT * camera.zoom;
    for (const e of entities) {
        if (e.name === player.username) continue;

        const p = worldToScreen((e.col + 0.5) * CELL_WIDTH, (e.row + 0.5) * CELL_HEIGHT);
        const hit = (Date.now() - e.lastHit) <= HIT_DURATION;

        const kind = e.type === "bot" ? e.kind : "other";
        const name = kind + (hit ? "_hit" : "");

        drawSprite(name, entityColors(e), p, w, h);
    }
    for (const e of entities) {
        const p = worldToScreen((e.col + 0.5) * CELL_WIDTH, (e.row + 0.5) * CELL_HEIGHT);
        
        if (e.hp < e.maxHp) {
            drawHpBar(p.x, p.y, w, h, (e.hp / e.maxHp))
        }

        drawName(p.x, p.y, h, e.type === "bot" ? (e.kind[0].toUpperCase() + e.kind.slice(1)) : e.name, e.type === "bot" ? "gray" : "white");
    }
}

function drawDrops() {
    const cell = CELL_WIDTH * camera.zoom;
    const box = cell * 0.6;
    const bob = Math.sin(Date.now() / 300) * cell * 0.04;

    ctx.save();
    for (const d of drops) {
        const img = loadedImages[d.kind];
        if (!img) continue;

        const scale = box / Math.max(img.width, img.height);
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);

        ctx.imageSmoothingEnabled = img.width > 64;
        ctx.imageSmoothingQuality = "high";

        const p = worldToScreen((d.x + 0.5) * CELL_WIDTH, (d.y + 0.5) * CELL_HEIGHT);

        ctx.fillStyle = "rgba(0,0,0,0.2)";
        ctx.beginPath();
        ctx.ellipse(p.x, p.y + box * 0.45, box * 0.3, box * 0.1, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.drawImage(img, Math.round(p.x - w / 2), Math.round(p.y - h / 2 + bob), w, h);
    }
    ctx.restore();
}

const WALL_COLOR = "#333";

const SAFE_ZONE_RADIUS = 8;                       // keep in sync with the server
const SAFE_ZONE_CENTER = { col: 0, row: 0 };      // same as the server's SPAWN

// same test as the server's inSafeZone()
const inSafeZone = (col, row) =>
    Math.hypot(col - SAFE_ZONE_CENTER.col, row - SAFE_ZONE_CENTER.row) <= SAFE_ZONE_RADIUS;

// built once: the zone's tiles, plus every tile edge that borders the outside
const safeTiles = [];
const safeEdges = [];   // [x1, y1, x2, y2] in tile units
for (let dy = -SAFE_ZONE_RADIUS; dy <= SAFE_ZONE_RADIUS; dy++) {
    for (let dx = -SAFE_ZONE_RADIUS; dx <= SAFE_ZONE_RADIUS; dx++) {
        const c = SAFE_ZONE_CENTER.col + dx, r = SAFE_ZONE_CENTER.row + dy;
        if (!inSafeZone(c, r)) continue;
        safeTiles.push([c, r]);
        if (!inSafeZone(c, r - 1)) safeEdges.push([c, r, c + 1, r]);          // top
        if (!inSafeZone(c, r + 1)) safeEdges.push([c, r + 1, c + 1, r + 1]);  // bottom
        if (!inSafeZone(c - 1, r)) safeEdges.push([c, r, c, r + 1]);          // left
        if (!inSafeZone(c + 1, r)) safeEdges.push([c + 1, r, c + 1, r + 1]);  // right
    }
}

function drawSafeZone() {
    const toScreen = (c, r) => worldToScreen(c * CELL_WIDTH, r * CELL_HEIGHT);
    ctx.save();

    ctx.fillStyle = "rgba(80, 200, 120, 0.15)";
    ctx.beginPath();
    for (const [c, r] of safeTiles) {
        if (wallAt(c, r)) continue;
        const a = toScreen(c, r), b = toScreen(c + 1, r + 1);
        const x0 = Math.round(a.x), y0 = Math.round(a.y);
        ctx.rect(x0, y0, Math.round(b.x) - x0, Math.round(b.y) - y0);
    }
    ctx.fill();

    ctx.strokeStyle = "rgba(40, 150, 80, 0.9)";
    ctx.lineWidth = Math.max(2, 3 * camera.zoom);
    ctx.lineCap = "square";
    ctx.beginPath();
    for (const [x1, y1, x2, y2] of safeEdges) {
        const a = toScreen(x1, y1), b = toScreen(x2, y2);
        ctx.moveTo(Math.round(a.x), Math.round(a.y));
        ctx.lineTo(Math.round(b.x), Math.round(b.y));
    }
    ctx.stroke();

    ctx.restore();
}
function drawWalls() {
    if (!walls.length) return;

    const tl = screenToWorld(0, 0);
    const br = screenToWorld(width, height);
    const c0 = Math.floor(tl.x / CELL_WIDTH),  c1 = Math.floor(br.x / CELL_WIDTH);
    const r0 = Math.floor(tl.y / CELL_HEIGHT), r1 = Math.floor(br.y / CELL_HEIGHT);

    const w = CELL_WIDTH * camera.zoom, h = CELL_HEIGHT * camera.zoom;
    const tileW = Math.ceil(w) + 1, tileH = Math.ceil(h) + 1;   // +1 overlaps neighbors so there are no seams
    const img = loadedImages.wall;

    ctx.save();
    if (img) ctx.imageSmoothingEnabled = img.width > w;
    else ctx.fillStyle = WALL_COLOR;

    for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
            if (!wallAt(c, r)) continue;
            const p = worldToScreen(c * CELL_WIDTH, r * CELL_HEIGHT);   // tile's top-left corner
            const x = Math.floor(p.x), y = Math.floor(p.y);

            if (img) ctx.drawImage(img, x, y, tileW, tileH);
            else ctx.fillRect(x, y, tileW, tileH);
        }
    }
    ctx.restore();
}

var walls = [];
var drops = [];

var leaderboard = { top: [], me: null };

function updateLeaderboard() {
    const { top = [], me = null } = leaderboard;
    leaderboardTable.replaceChildren();

    const addRow = (e) => {
        const tr = document.createElement("tr");
        if (e.name === player.username) tr.style.fontWeight = "bold";
        for (const v of [e.rank, e.name, e.level, e.xp]) {
            const td = document.createElement("td");
            td.textContent = v;
            tr.appendChild(td);
        }
        leaderboardTable.appendChild(tr);
    };

    top.forEach(addRow);

    if (me && !top.some(e => e.name === me.name)) {
        const gap = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 4;
        td.textContent = "…";
        gap.appendChild(td);
        leaderboardTable.appendChild(gap);
        addRow(me);
    }
}

const MAP_X_OFFSET = -150;
const MAP_Y_OFFSET = -150;

function wallAt(col, row) {
    const x = col - MAP_X_OFFSET;
    const y = row - MAP_Y_OFFSET;
    if (y < 0 || x < 0 || y >= walls.length || x >= (walls[0]?.length ?? 0)) return true; // out of bounds = solid
    return walls[y][x] !== 0;
}

let last = performance.now();
function draw(now) {
    const dt = (now - last) / 1000;
    last = now;

    updateCamera(dt);

    ctx.clearRect(0, 0, width, height);
    drawWalls();
    drawSafeZone();
    const origin = worldToScreen(0, 0);
    drawGrid(origin.x, origin.y);
    drawPlayer();
    drawEntities();
    drawDrops();

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

socket.on("notify", (data) => {
    const { header, body } = data ?? {};
    if (!header || !body) return;
    makeNotification(header, body);
});

socket.on("leaderboard", (l) => {
    leaderboard = l;
    updateLeaderboard();
})

let stats = { level: 1, xp: 0, next: 50, hp: -1 };

const XP_PER_LEVEL = 50;
const levelFor = (xp) => 1 + Math.floor(Math.sqrt((xp ?? 0) / XP_PER_LEVEL));
const damageFor = (xp) => 10 + 2 * (levelFor(xp) - 1);

function renderStats() {
    statsEl.innerHTML =
        `<tr><td style="font-weight: bold;">Level</td><td>${stats.level} · ${stats.xp}/${stats.next} XP</td>` +
        `<tr><td style="font-weight: bold;">Position</td><td>(${player.col}, ${player.row})</td>` + 
        `<tr><td style="font-weight: bold;">HP</td><td>${stats.hp}/${stats.maxHp}</td>` + 
        `<tr><td style="font-weight: bold;">Damage</td><td>${damageFor(stats.xp)}</td>`;
}

function drawHpBar(cx, cy, w, h, frac) {
    if (!(frac < 1)) return;
    const bw = w * 0.8, bh = Math.max(3, 5 * camera.zoom);
    const x = cx - bw / 2, y = cy - h / 2 - bh - 2;
    ctx.fillStyle = "#900"; ctx.fillRect(x, y, bw, bh);
    ctx.fillStyle = "#0b0"; ctx.fillRect(x, y, bw * Math.max(0, frac), bh);
}

function drawName(cx, cy, h, name, color = "#fff") {
    if (!name || camera.zoom < 0.5) return;

    const bh = Math.max(3, 5 * camera.zoom);
    const size = Math.min(18, Math.max(11, 13 * camera.zoom));
    const y = cy - h / 2 - bh - 5;

    ctx.save();
    ctx.font = `${size}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.fillStyle = color;
    ctx.strokeText(name, cx, y);
    ctx.fillText(name, cx, y);
    ctx.restore();
}

socket.on("stats", (s) => { stats = s; renderStats(); });
socket.on("walls", (w) => { walls = w; })
socket.on("drops", (d) => { drops = d; })
socket.on("playerMove", ({ col, row }) => { player.col = col; player.row = row; renderStats(); });

let selectedId = null;
let selectNext = false;
let saveTimer = null;

function selectScript(id) {
    selectedId = id;
    const s = player.scripts.find(x => x.id === id);
    editor.disabled = !s;
    editor.value = s ? s.script : "";
    window.refreshHighlight?.();
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

    if (s.id === selectedId && document.activeElement !== editor) {
        editor.value = s.script;
        window.refreshHighlight?.();
    }
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