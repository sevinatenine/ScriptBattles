const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const fs = require("fs");

const crypto = require('node:crypto');

const { startRuntime, tickRuntime, stopRuntime, nextAction, sendEvent, runtimes } = require("./runner");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const online = new Map();
const starting = new Set();
const isActive = (u) => online.has(u.username) || u.data.scripts?.some(s => s.status.running);

var userSockets = new Map();

app.use(express.static(path.join(__dirname, '../public')));

const hljsDir = path.join(__dirname, '../node_modules/@highlightjs/cdn-assets');
app.use('/lib/highlight.js/styles/', express.static(path.join(hljsDir, 'styles')));
app.use('/lib/highlight.js/', express.static(path.join(hljsDir, 'es')));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
const DATA_DIR = path.join(__dirname, "../data");
fs.mkdirSync(DATA_DIR, { recursive: true });

function load(f) {
    try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f))); }
    catch (e) {
        if (e.code === "ENOENT") return [];
        throw e;
    }
}

const accounts = load("accounts.json");
const users = load("users.json");
var walls = load("walls.json");

var drops = [];

const MAP_X_OFFSET = -150;
const MAP_Y_OFFSET = -150;
const MAP_SIZE = 301;

const SPAWN = { col: 0, row: 0 };
const SPAWN_PROTECTION_TICKS = 10;
const TIERS = [
    { kind: "wanderer", maxDist: 15,       hp: 30,   xp: 50,   damage: 0,  ai: "wander",    moveChance: 0.3 },
    { kind: "crawler",  maxDist: 30,       hp: 50,   xp: 80,   damage: 0,  ai: "skittish",  moveChance: 0.4, fleeRadius: 3 },
    { kind: "skulker",  maxDist: 45,       hp: 80,   xp: 130,  damage: 0,  ai: "skittish",  moveChance: 0.5, fleeRadius: 4 },
    { kind: "brute",    maxDist: 60,       hp: 120,  xp: 200,  damage: 6,  ai: "retaliate", moveChance: 0.3, leash: 10, chaseEvery: 3, attackEvery: 6 },
    { kind: "stalker",  maxDist: 75,       hp: 180,  xp: 320,  damage: 9,  ai: "retaliate", moveChance: 0.3, leash: 12, chaseEvery: 2, attackEvery: 5 },
    { kind: "warden",   maxDist: 90,       hp: 260,  xp: 500,  damage: 12, ai: "aggro",     moveChance: 0.3, leash: 12, chaseEvery: 3, attackEvery: 5, aggroRadius: 5 },
    { kind: "reaver",   maxDist: 105,      hp: 380,  xp: 800,  damage: 16, ai: "aggro",     moveChance: 0.3, leash: 14, chaseEvery: 2, attackEvery: 5, aggroRadius: 6 },
    { kind: "revenant", maxDist: 120,      hp: 550,  xp: 1250, damage: 21, ai: "hunter",    moveChance: 0.3, leash: 20, chaseEvery: 2, attackEvery: 4, aggroRadius: 9 },
    { kind: "colossus", maxDist: 135,      hp: 800,  xp: 2000, damage: 27, ai: "guard",     leash: 6,  chaseEvery: 2, attackEvery: 8, aggroRadius: 4 },
    { kind: "horror",   maxDist: Infinity, hp: 1200, xp: 3200, damage: 35, ai: "hunter",    moveChance: 0.3, leash: 25, chaseEvery: 1, attackEvery: 4, aggroRadius: 12 },
];

const SAFE_RADIUS = 6;   // no bots right on top of the player spawn

const tierFor = (col, row) => {
    const d = Math.hypot(col - SPAWN.col, row - SPAWN.row);
    return TIERS.find(t => d <= t.maxDist);
};

const bots = load("bots.json")
    .filter(b => Math.hypot(b.col - SPAWN.col, b.row - SPAWN.row) > SAFE_RADIUS)
        .map((b, i) => {
        const { maxDist, ...stats } = tierFor(b.col, b.row);
        return { id: b.id, col: b.col, row: b.row, spawn: { col: b.col, row: b.row },
                ...stats, maxHp: stats.hp, phase: i };
    });;

if (!Array.isArray(walls) || walls.length !== MAP_SIZE || walls.some(r => !Array.isArray(r) || r.length !== MAP_SIZE)) {
    walls = [];
    for (let y = 0; y < MAP_SIZE; y++) {
        const row = [];
        for (let x = 0; x < MAP_SIZE; x++) {
            const isBorder = y === 0 || y === MAP_SIZE - 1 || x === 0 || x === MAP_SIZE - 1;
            row.push(isBorder ? 1 : 0);
        }
        walls.push(row);
    }
}

const GEN_WALL_CHANCE = 0.45;
const GEN_SMOOTH_ITER = 3;

function regenMap() {
    var grid = [];

    function countWallsAround(grid, x, y) {
        let count = 0;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;

            if (nx < 0 || ny < 0 || nx >= MAP_SIZE || ny >= MAP_SIZE) {
                count++;
            } else {
                count += grid[ny][nx];
            }
            }
        }
        return count;
    }

    function smooth() {
        return grid.map((row, y) =>
            row.map((_, x) => {
                const walls = countWallsAround(grid, x, y);
                return walls >= 5 ? 1 : 0;
            })
        );
    }

    for (var y = 0; y < MAP_SIZE; y++) {
        const row = [];
        for (let x = 0; x < MAP_SIZE; x++) {
            row.push((Math.random() < GEN_WALL_CHANCE) ? 1 : 0);
        }
        grid.push(row);
    }

    for (var i = 0; i < GEN_SMOOTH_ITER; i++) {
        grid = smooth(grid);
    }

    return grid;
}

function finalizeMap(grid) {
    const sx = SPAWN.col - MAP_X_OFFSET, sy = SPAWN.row - MAP_Y_OFFSET;
    for (let dy = -3; dy <= 3; dy++)
        for (let dx = -3; dx <= 3; dx++) grid[sy + dy][sx + dx] = 0;

    for (let i = 0; i < MAP_SIZE; i++)
        grid[0][i] = grid[MAP_SIZE-1][i] = grid[i][0] = grid[i][MAP_SIZE-1] = 1;

    const seen = Array.from({ length: MAP_SIZE }, () => new Uint8Array(MAP_SIZE));
    const stack = [[sx, sy]];
    seen[sy][sx] = 1;
    while (stack.length) {
        const [x, y] = stack.pop();
        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
            const nx = x + dx, ny = y + dy;
            if (grid[ny]?.[nx] !== 0 || seen[ny][nx]) continue;
            seen[ny][nx] = 1;
            stack.push([nx, ny]);
        }
    }
    for (let y = 0; y < MAP_SIZE; y++)
        for (let x = 0; x < MAP_SIZE; x++)
            if (!seen[y][x]) grid[y][x] = 1;
    return grid;
}

const RESPAWN_TICKS = 25;
const liveBots = () => bots.filter(b => !b.dead);

const XP_PER_LEVEL = 50;
const levelFor = (xp) => 1 + Math.floor(Math.sqrt((xp ?? 0) / XP_PER_LEVEL));
const damageFor = (user) => 10 + 2 * (levelFor(user.data.xp) - 1);

const BASE_HP = 100;
const maxHpFor = (user) => BASE_HP + 10 * (levelFor(user.data.xp) - 1);
const hpOf = (user) => user.data.hp ?? maxHpFor(user);
const colOf = (u) => u.data.col ?? 0;
const rowOf = (u) => u.data.row ?? 0;

const statsOf = (user) => {
    const xp = user.data.xp ?? 0, level = levelFor(xp);
    return { xp, level, next: XP_PER_LEVEL * level ** 2, hp: hpOf(user), maxHp: maxHpFor(user) };
};
const sendStats = (user) => io.to(user.username).emit("stats", statsOf(user));

function giveXp(user, amount) {
    const beforeLevel = levelFor(user.data.xp);
    user.data.xp = (user.data.xp ?? 0) + amount;
    const nowLevel = levelFor(user.data.xp);
    if (nowLevel > beforeLevel) {
        io.to(user.username).emit("notify", {
            header: `You leveled up!`,
            body: `Level ${beforeLevel} -> Level ${nowLevel}`,
        });
    }
    dirty = true;
    sendStats(user);
}

const DEATH_XP_LOSS = 0.10;                          // fraction of in-level progress
const levelFloor = (level) => XP_PER_LEVEL * (level - 1) ** 2;   // XP where a level starts

function applyDeathPenalty(victim) {
    const xp = victim.data.xp ?? 0;
    const lost = Math.floor((xp - levelFloor(levelFor(xp))) * DEATH_XP_LOSS);
    victim.data.xp = xp - lost;                      // always stays >= the level's floor
    return lost;
}

const nearestPlayer = (b, radius) => {
    let best = null, bestD = radius;
    for (const u of users) {
        if (!isActive(u)) continue;
        if ((protectedUntil.get(u.username) ?? 0) > tick) continue;
        const d = Math.hypot(colOf(u) - b.col, rowOf(u) - b.row);
        if (d <= bestD) { best = u; bestD = d; }
    }
    return best;
};

function stepToward(b, tc, tr) {
    const dx = Math.sign(tc - b.col), dy = Math.sign(tr - b.row);

    const options = Math.abs(tc - b.col) >= Math.abs(tr - b.row)
        ? [[dx, 0], [0, dy]] : [[0, dy], [dx, 0]];
    for (const [sx, sy] of options) {
        if (!sx && !sy) continue;
        const nc = b.col + sx, nr = b.row + sy;
        if (!isWall(nc, nr) && !occupied(nc, nr)) { b.col = nc; b.row = nr; return true; }
    }
    return false;
}

function formatBot(b) {
    return b[0].toUpperCase() + b.slice(1);
}

function killPlayer(victim, killerLabel) {
    const lost = applyDeathPenalty(victim);
    createDrop(colOf(victim), rowOf(victim), getDrops("user"));
    io.to(victim.username).emit("notify", {
        header: `Killed by ${killerLabel}`,
        body: lost > 0 ? `-${lost} XP` : "You were killed",
    });
    dirty = true;
    respawn(victim);
}

function hurt(victim, dmg, attacker) {
    if (!victim) return false;
    if ((protectedUntil.get(victim.username) ?? 0) > tick) return false;

    victim.data.hp = hpOf(victim) - dmg;
    victim.lastHit = Date.now();
    dirty = true;

    if (victim.data.hp <= 0) {
        killPlayer(victim, `${formatBot(attacker.kind)} (Bot)`);
    } else {
        sendStats(victim);
    }
    return true;
}

const distFromSpawn = (b) => Math.hypot(b.col - b.spawn.col, b.row - b.spawn.row);
const adjacent = (b, u) => Math.abs(colOf(u) - b.col) + Math.abs(rowOf(u) - b.row) === 1;
const stepsNow = (b, every) => (tick + b.phase) % (every ?? 1) === 0;

function heal(b) {
    if (tick % 5 === 0 && b.hp < b.maxHp) b.hp = Math.min(b.maxHp, b.hp + Math.ceil(b.maxHp * 0.05));
}

function idleStep(b) {
    if (Math.random() > (b.moveChance ?? 0.3)) return;
    const d = Object.values(DIRS)[Math.floor(Math.random() * 4)];
    const nc = b.col + d[0], nr = b.row + d[1];
    if (Math.abs(nc - b.spawn.col) > 6 || Math.abs(nr - b.spawn.row) > 6) return;
    if (isWall(nc, nr) || occupied(nc, nr)) return;
    b.col = nc; b.row = nr;
}

// returns true once home. Walks at full speed and heals on the way.
function goHome(b, tol = 1.5) {
    if (distFromSpawn(b) <= tol) return true;
    heal(b);
    if (!stepToward(b, b.spawn.col, b.spawn.row)) idleStep(b);   // unstick if blocked
    return false;
}

function chase(b, target) {
    if (adjacent(b, target)) {
        if (tick >= (b.nextAttack ?? 0)) { hurt(target, b.damage, b); b.nextAttack = tick + (b.attackEvery ?? 5); }
    } else if (stepsNow(b, b.chaseEvery ?? 2)) {
        stepToward(b, colOf(target), rowOf(target));
    }
}

const BOT_AI = {
    idle() {},

    wander(b) { idleStep(b); },

    skittish(b) {
        const threat = nearestPlayer(b, b.fleeRadius ?? 3);
        if (threat && distFromSpawn(b) <= (b.leash ?? 8)) {
            if (stepsNow(b, b.chaseEvery ?? 2))
                stepToward(b, 2 * b.col - colOf(threat), 2 * b.row - rowOf(threat));;
            return;
        }
        if (distFromSpawn(b) > 6) return void goHome(b);
        idleStep(b);
    },

    retaliate(b) {
        if (b.returning) { if (goHome(b)) b.returning = false; return; }
        const target = b.lastAttacker && tick < (b.aggroUntil ?? 0)
            ? users.find(u => u.username === b.lastAttacker && isActive(u)) : null;
        if (!target) return idleStep(b);
        if (distFromSpawn(b) > (b.leash ?? 10)) { b.returning = true; b.lastAttacker = null; return; }
        chase(b, target);
    },

    aggro(b) {
        if (b.returning) { if (goHome(b)) b.returning = false; return; }
        const target = nearestPlayer(b, b.aggroRadius ?? 6);
        if (!target) return idleStep(b);
        if (distFromSpawn(b) > (b.leash ?? 12)) { b.returning = true; return; }
        chase(b, target);
    },

    hunter(b) {
        if (b.returning) { if (goHome(b)) b.returning = false; return; }
        let target = nearestPlayer(b, b.aggroRadius ?? 10);
        if (target) { b.hunting = target.username; b.huntUntil = tick + 25; }
        else if (tick < (b.huntUntil ?? 0)) target = users.find(u => u.username === b.hunting && isActive(u));
        if (!target) return idleStep(b);
        if (distFromSpawn(b) > (b.leash ?? 20)) { b.returning = true; b.huntUntil = 0; return; }
        chase(b, target);
    },

    guard(b) {
        const target = nearestPlayer(b, b.aggroRadius ?? 4);
        if (target && distFromSpawn(b) <= (b.leash ?? 6)) return chase(b, target);
        goHome(b, 0.5);
    },
};

for (const u of users) for (const s of u.data?.scripts ?? []) { s.status.running = false; s.status.error = null; }

let dirty = false;

// for (const u of users) for (const s of u.data?.scripts ?? []) {
//     if (s.id === "0") { s.id = crypto.randomUUID(); dirty = true; }
// }

function writeAtomic(name, data) {
    const p = path.join(DATA_DIR, name);
    fs.writeFileSync(p + ".tmp", JSON.stringify(data));
    fs.renameSync(p + ".tmp", p);
}
function flush() {
    if (!dirty) return;
    dirty = false;
    writeAtomic("accounts.json", accounts);
    writeAtomic("users.json", users);
    writeAtomic("walls.json", walls);
}

setInterval(flush, 1000);

let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, saving and exiting`);

    try {
        flush();
    } catch (e) {
        console.error("Failed to save on shutdown:", e);
    }

    io.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("uncaughtException", (e) => {
    console.error(e);
    try { flush(); } catch {}
    process.exit(1);
});

const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
    return { salt, hash: crypto.scryptSync(password, salt, 64).toString("hex") };
}
function checkPassword(password, account) {
    const { hash } = hashPassword(password, account.salt);
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(account.hash, "hex"));
}

function startSession(res, account) {
    const token = crypto.randomBytes(32).toString("base64url");
    account.sessionHash = sha256(token);
    account.sessionExpires = Date.now() + 10 * 24 * 60 * 60 * 1000;
    dirty = true;
    res.cookie("session", token, {
        maxAge: 10 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
    });
}

function accountFromToken(token) {
    if (!token) return null;
    const h = sha256(token);
    return accounts.find(a => a.sessionHash === h && a.sessionExpires > Date.now()) || null;
}

let tick = 0;

function nearby(user, radius, type) {
    const px = user.data.col ?? 0, py = user.data.row ?? 0;
    return [
        ...(type === "bot" ? [] : users.filter(u => u !== user && isActive(u)).map(u => ({
            type: "user", name: u.username, x: u.data.col ?? 0, y: u.data.row ?? 0, hp: hpOf(u) }))),
        ...(type === "user" ? [] : liveBots().map(b => ({
            type: "bot", kind: b.kind, name: b.id, x: b.col, y: b.row, hp: b.hp }))),
    ]
        .map(e => ({ ...e, dist: Math.hypot(e.x - px, e.y - py) }))
        .filter(e => e.dist <= radius)
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 20);
}

function nearbyDrops(user, radius) {
    const px = colOf(user), py = rowOf(user);
    return drops
        .map(d => ({ kind: d.kind, x: d.x, y: d.y, dist: Math.hypot(d.x - px, d.y - py) }))
        .filter(d => d.dist <= radius)
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 20);
}

function makeApi(user) {
    const pos = () => [user.data.col ?? 0, user.data.row ?? 0];
    return {
        log: (msg) => console.log(`[${user.username}]`, msg),
        scan: (radius, type) => nearby(user, radius, type),
        wall: (dx, dy) => { const [c, r] = pos(); return isWall(c + dx, r + dy); },
        tiles: (radius) => {
            const [c, r] = pos();
            const out = [];
            for (let dy = -radius; dy <= radius; dy++) {
                const row = [];
                for (let dx = -radius; dx <= radius; dx++) row.push(isWall(c + dx, r + dy) ? 1 : 0);
                out.push(row);
            }
            return out;
        },
        drops: (radius) => nearbyDrops(user, radius),
    };
}

const makeSnapshot = (user) => () => {
    const near = nearby(user, 5);
    return {
        tick,
        player: { x: user.data.col ?? 0, y: user.data.row ?? 0, hp: hpOf(user), maxHp: maxHpFor(user), xp: user.data.xp ?? 0, level: levelFor(user.data.xp) },
        vision: near,
        nearestPlayerDistance: near.find(e => e.type === "user")?.dist ?? null,
        drops: nearbyDrops(user, 5),
    };
};

const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

function isWall(col, row) {
    const x = col - MAP_X_OFFSET;
    const y = row - MAP_Y_OFFSET;
    if (x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE) return true;
    return walls[y][x] !== 0;
}

function nearestTileOpen(row, col, { avoidOccupied = true } = {}) {
    const lo = MAP_X_OFFSET, hi = MAP_X_OFFSET + MAP_SIZE - 1;
    col = Math.min(hi, Math.max(lo, col));
    row = Math.min(hi, Math.max(lo, row));

    const seen = new Set([`${col},${row}`]);
    const queue = [[col, row]];

    for (let i = 0; i < queue.length; i++) {
        const [c, r] = queue[i];
        if (!isWall(c, r) && !(avoidOccupied && occupied(c, r))) return [c, r];

        for (const [dx, dy] of Object.values(DIRS)) {
            const nc = c + dx, nr = r + dy;
            if (nc < lo || nc > hi || nr < lo || nr > hi) continue;
            const k = `${nc},${nr}`;
            if (seen.has(k)) continue;
            seen.add(k);
            queue.push([nc, nr]);
        }
    }
    return null;
}

const KILL_XP_BASE = 10;
const protectedUntil = new Map();

function occupied(col, row, except) {
    return liveBots().some(b => b.col === col && b.row === row)
        || users.some(u => u !== except && isActive(u) && colOf(u) === col && rowOf(u) === row);
}

function freeTileNear(col, row) {
    for (let r = 0; r <= 10; r++)
        for (let dy = -r; dy <= r; dy++)
            for (let dx = -r; dx <= r; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                if (!isWall(col + dx, row + dy) && !occupied(col + dx, row + dy)) return [col + dx, row + dy];
            }
    return [col, row];
}

const HEART_BOT_DROP_CHANCE = 0.2;
const HEART_USER_DROP_CHANCE = 0.5;

function getDrops(type, kind) {
    return (Math.random() < ((type == "bot") ? HEART_BOT_DROP_CHANCE : HEART_USER_DROP_CHANCE)) ? "heart" : null;
}

const DROP_TTL_MS = 60_000;
const MAX_DROPS = 200;
const HEART_HEAL = 25;

function createDrop(col, row, kind) {
    if (!kind) return;
    if (drops.length >= MAX_DROPS) drops.shift();
    drops.push({ x: col, y: row, kind, expires: Date.now() + DROP_TTL_MS });
}

function respawn(user) {
    const [c, r] = nearestTileOpen(SPAWN.row, SPAWN.col) ?? [SPAWN.col, SPAWN.row];
    user.data.hp = maxHpFor(user);
    user.data.col = c;
    user.data.row = r;
    protectedUntil.set(user.username, tick + SPAWN_PROTECTION_TICKS);
    dirty = true;
    io.to(user.username).emit("playerMove", { col: c, row: r });
    sendStats(user);
}

function strike(user, tx, ty) {
    const bot = liveBots().find(b => b.col === tx && b.row === ty);
    if (bot) {
        bot.hp -= damageFor(user);
        bot.lastHit = Date.now();
        bot.lastAttacker = user.username;
        bot.aggroUntil = tick + 40;
        if (bot.hp <= 0) {
            io.to(user.username).emit("notify", { header: `Killed ${formatBot(bot.kind)}`, body: `+${bot.xp ?? 0} XP` });
            bot.dead = true;
            bot.respawnAt = tick + RESPAWN_TICKS;
            giveXp(user, bot.xp ?? 0);
            createDrop(tx, ty, getDrops("bot", bot.kind));
        }
        return true;
    }

    const victim = users.find(u => u !== user && isActive(u) && colOf(u) === tx && rowOf(u) === ty);
    if (!victim) return false;
    if ((protectedUntil.get(victim.username) ?? 0) > tick) return false;

    victim.data.hp = hpOf(victim) - damageFor(user);
    victim.lastHit = Date.now();
    dirty = true;
    if (victim.data.hp <= 0) {
        const xp = KILL_XP_BASE + Math.floor((victim.data.xp ?? 0) * 0.1);   // computed BEFORE the penalty
        giveXp(user, xp);
        io.to(user.username).emit("notify", { header: `Killed ${victim.username}`, body: `+${xp} XP` });
        killPlayer(victim, user.username);
    } else {
        sendStats(victim);
    }
    return true;
}

const ACTIONS = {
    move(user, arg) {
        const d = DIRS[arg];
        if (!d) return false;
        const nc = colOf(user) + d[0], nr = rowOf(user) + d[1];
        if (isWall(nc, nr) || occupied(nc, nr, user)) return false;
        user.data.col = nc;
        user.data.row = nr;
        dirty = true;
        io.to(user.username).emit("playerMove", { col: nc, row: nr });
        return true;
    },
    attackClosest(user) {
        for (const d of Object.values(DIRS))
            if (strike(user, colOf(user) + d[0], rowOf(user) + d[1])) return true;
        return false;
    },
    attack(user, arg) {
        const d = DIRS[arg];
        if (!d) return false;
        return strike(user, colOf(user) + d[0], rowOf(user) + d[1]);
    },
    wait() {},
};

setInterval(() => {
    tick++;

    if (tick % 10 === 0) for (const u of users) if (isActive(u) && hpOf(u) < maxHpFor(u)) { u.data.hp = hpOf(u) + 1; sendStats(u); }

    const n = users.length;
    for (let k = 0; k < n; k++) {
        const u = users[(tick + k) % n];
        for (const s of u.data?.scripts ?? []) {
            if (!s.status.running) continue;
            const a = nextAction(s.id);
            if (!a) continue;
            if (Object.hasOwn(ACTIONS, a.type)) {
                try { ACTIONS[a.type](u, a.arg); }
                catch (e) { console.error(`action ${a.type} failed:`, e); }
            }
            break;
        }
    }

    for (const id of [...runtimes.keys()]) tickRuntime(id);

    for (const b of bots) {
        if (b.dead && tick >= b.respawnAt) {
            const t = nearestTileOpen(b.spawn.row, b.spawn.col);
            if (t) { b.dead = false; [b.col, b.row] = t; b.hp = b.maxHp; b.lastAttacker = null; b.returning = false; b.nextAttack = 0; }
        }
    }
    
    for (const b of liveBots()) {
        if (!Object.hasOwn(BOT_AI, b.ai)) continue;
        try { BOT_AI[b.ai](b); }
        catch (e) { console.error(`bot ${b.id} (${b.ai}) failed:`, e); }
    }

    io.emit("entities", [
        ...liveBots().map(b => ({ type: "bot", kind: b.kind, ai: b.ai, name: b.id, col: b.col, row: b.row, hp: b.hp, maxHp: b.maxHp, lastHit: b.lastHit || 0 })),
        ...users.filter(isActive).map(u => ({ type: "user", name: u.username, col: u.data.col ?? 0, lastHit: u.lastHit || 0, row: u.data.row ?? 0, hp: hpOf(u), maxHp: maxHpFor(u) })),
    ]);

    const now = Date.now();
    drops = drops.filter(d => d.expires > now);

    for (const u of users) {
        if (!isActive(u) || hpOf(u) >= maxHpFor(u)) continue;   // full HP: leave it on the floor
        const i = drops.findIndex(d => d.x === colOf(u) && d.y === rowOf(u));
        if (i === -1) continue;
        drops.splice(i, 1);
        u.data.hp = Math.min(maxHpFor(u), hpOf(u) + HEART_HEAL);
        dirty = true;
        sendStats(u);
    }

    io.emit("drops", drops);
}, 200);

const LEADERBOARD_SIZE = 3;

function buildLeaderboard() {
    return users
        .map(u => ({ name: u.username, xp: u.data.xp ?? 0 }))
        .sort((a, b) => b.xp - a.xp || a.name.localeCompare(b.name))
        .map((e, i) => ({ ...e, level: levelFor(e.xp), rank: i + 1 }));
}

function leaderboardPayload(name, board = buildLeaderboard()) {
    return {
        top: board.slice(0, LEADERBOARD_SIZE),
        me: board.find(e => e.name === name) ?? null,
        total: board.length,
    };
}

setInterval(() => {
    if (online.size === 0) return;
    const board = buildLeaderboard();
    for (const name of online.keys()) {
        io.to(name).emit("leaderboard", leaderboardPayload(name, board));
    }
}, 4000);

app.post("/login", (req, res) => {
    const { username, password } = req.body;
    if (typeof username !== "string" || typeof password !== "string") return res.redirect("/");

    const account = accounts.find(a => a.username === username);
    if (!account || !checkPassword(password, account)) fail(res, "Invalid username or password");

    startSession(res, account);
    res.redirect("/");
});

const STARTER = `function init() {\n}\n\nfunction loop() {\n    if (player.queued > 0) return;\n    player.move("right");\n}\n`;
const STARTER2 = `const R = 20;
const SIZE = 2 * R + 1;
const DIRS = [[1, 0, "right"], [-1, 0, "left"], [0, 1, "down"], [0, -1, "up"]];

let lastX = null, lastY = null, moved = false, stuck = 0;

function pathStep(tx, ty) {
    const grid = world.tiles(R);
    if (!grid.length) return null;

    const gx = tx - player.x + R, gy = ty - player.y + R;
    const start = R * SIZE + R;
    const parent = new Int32Array(SIZE * SIZE).fill(-2);
    parent[start] = -1;

    const queue = [start];
    let best = start, bestD = Infinity;

    for (let i = 0; i < queue.length; i++) {
        const cur = queue[i];
        const cx = cur % SIZE, cy = (cur - cx) / SIZE;

        const d = Math.abs(cx - gx) + Math.abs(cy - gy);
        if (d < bestD) { bestD = d; best = cur; if (d === 0) break; }

        for (const [dx, dy] of DIRS) {
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
            const n = ny * SIZE + nx;
            if (parent[n] !== -2 || grid[ny][nx] !== 0) continue;
            parent[n] = cur;
            queue.push(n);
        }
    }

    if (best === start) return null;
    let c = best;
    while (parent[c] !== start) c = parent[c];
    const sx = (c % SIZE) - R, sy = Math.floor(c / SIZE) - R;
    return DIRS.find(([dx, dy]) => dx === sx && dy === sy)[2];
}

function walkTo(tx, ty) {
    const dir = pathStep(tx, ty);
    if (!dir) return false;
    moved = true;
    player.move(dir);
    return true;
}

function wander() {
    moved = true;
    player.move(DIRS[Math.floor(Math.random() * 4)][2]);
}

function loop() {
    if (player.queued > 0) return;

    stuck = moved && player.x === lastX && player.y === lastY ? stuck + 1 : 0;
    lastX = player.x; lastY = player.y; moved = false;
    if (stuck >= 2) return wander();

    if (player.hp < player.maxHp * 0.5) {
        const [d] = world.drops(20);
        if (d && walkTo(d.x, d.y)) return;
    }

    const [b] = world.bots(20);
    if (b) {
        if (b.dist <= 1) return player.attackClosest();
        if (walkTo(b.x, b.y)) return;
    }

    wander();
}`;
const STARTER3 = `function m(d) {
    if(player.queued >= 1) return;
    player.move(d);
}

function init() {
    ui.onKey((key) => {
        if (key == "w") m("up");
        else if (key == "a") m("left");
        else if (key == "s") m("down");
        else if (key == "d") m("right");
        else if (key == " ") player.attackClosest();
    });
}

function loop() {
}`;
const STARTER4 = `function init() {}

function loop() {
    player.move(["up", "down", "left", "right"][Math.floor(Math.random() * 4)]);
}`

const fail = (res, msg) => res.redirect("/?error=" + encodeURIComponent(msg));

app.post("/register", (req, res) => {
    const { username, password } = req.body;
    if (typeof username !== "string" || typeof password !== "string") return fail(res, "Missing fields");
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return fail(res, "Username must be 3-20 letters, digits or _");
    if (password.length < 8) return fail(res, "Password must be at least 8 characters");
    if (accounts.some(a => a.username.toLowerCase() === username.toLowerCase())) return fail(res, "Username taken");

    const { salt, hash } = hashPassword(password);
    const account = { username, salt, hash };
    accounts.push(account);

    const user = { username, data: {
        scripts: [
            {
                id: crypto.randomUUID(),
                name: "Hello World",
                script: STARTER,
                status: { running: false, error: null }
            },
            {
                id: crypto.randomUUID(),
                name: "Auto Kill",
                script: STARTER2,
                status: { running: false, error: null }
            },
            {
                id: crypto.randomUUID(),
                name: "Controls",
                script: STARTER3,
                status: { running: false, error: null }
            },
            {
                id: crypto.randomUUID(),
                name: "Random",
                script: STARTER4,
                status: { running: false, error: null }
            }
        ]
    } };

    if (!users.some(u => u.username === username)) users.push(user);

    startSession(res, account);
    res.redirect("/");
});

function getUser(username) {
    let u = users.find(u => u.username === username);
    if (!u) {
        u = { username, data: { scripts: [] } };
        users.push(u);
        dirty = true;
    }
    return u;
}

app.get("/me", (req, res) => {
    const account = accountFromToken(parseCookies(req.headers.cookie).session);
    if (!account) return res.status(401).json({ success: false });
    res.json({ success: true, username: account.username, data: getUser(account.username).data });
});

app.post("/logout", (req, res) => {
    const account = accountFromToken(parseCookies(req.headers.cookie).session);
    if (account) { delete account.sessionHash; delete account.sessionExpires; dirty = true; }
    res.clearCookie("session").redirect("/");
});

function parseCookies(header = "") {
    const out = {};
    for (const part of header.split(";")) {
        const i = part.indexOf("=");
        if (i < 0) continue;
        try { out[decodeURIComponent(part.slice(0, i).trim())] = decodeURIComponent(part.slice(i + 1).trim()); }
        catch {}
    }
    return out;
}

io.use((socket, next) => {
    const account = accountFromToken(parseCookies(socket.handshake.headers.cookie).session);
    if (!account) return next(new Error("unauthorized"));
    socket.account = account;
    next();
});

const MAX_SCRIPTS = 20;
const MAX_SCRIPT_CHARS = 10_000;

function newMap() {
    walls = finalizeMap(regenMap());
    io.emit("walls", walls);
}

for (const b of bots) {
    if (!isWall(b.spawn.col, b.spawn.row)) continue;
    const t = nearestTileOpen(b.spawn.row, b.spawn.col, { avoidOccupied: false });
    if (t) { b.spawn = { col: t[0], row: t[1] }; b.col = t[0]; b.row = t[1]; }
}

io.on("connection", (socket) => {
    const user = getUser(socket.account.username);
    const scripts = user.data.scripts;

    socket.join(user.username);

    const list = userSockets.get(user.username) ?? [];
    list.push(socket);
    userSockets.set(user.username, list);

    if (user.data.col == null) respawn(user);

    online.set(user.username, (online.get(user.username) ?? 0) + 1)

    socket.emit("leaderboard", leaderboardPayload(user.username));

    socket.emit("stats", statsOf(user));

    socket.emit("stats", statsOf(user));

    socket.emit("walls", walls);

    socket.on("toggleScript", async (id) => {
        const s = typeof id === "string" && scripts.find(s => s.id === id);
        if (!s || starting.has(s.id)) return;

        const finish = (error) => {
            s.status.running = false;
            s.status.error = error ?? null;
            dirty = true;
            io.to(user.username).emit("scriptData", s);
        };

        if (s.status.running) { stopRuntime(s.id); return; }

        if (scripts.filter(x => x.status.running).length >= 3) return finish("max 3 running scripts");

        starting.add(s.id);
        try {
            await startRuntime(s, makeApi(user), makeSnapshot(user), finish);
            s.status.running = true;
            s.status.error = null;
            dirty = true;
            io.to(user.username).emit("scriptData", s);
        } catch (e) {
            finish(e.message);
        } finally {
            starting.delete(s.id);
        }
    });

    const EVENT_TYPES = new Set(["key"]);

    socket.on("event", (type, data) => {
        if (!EVENT_TYPES.has(type)) return;
        if (typeof data !== "string" || data.length > 16) return;

        for (const s of scripts) {
            if (!s.status.running) continue;
            sendEvent(s.id, type, data);
        }
    });

    socket.on("saveScript", (msg) => {
        if (!msg || typeof msg.id !== "string" || typeof msg.script !== "string") return;
        if (msg.script.length > MAX_SCRIPT_CHARS) return;
        const s = scripts.find(s => s.id === msg.id);
        if (!s) return;
        s.script = msg.script;
        if (s.status.running) stopRuntime(s.id);
        dirty = true;
        io.to(user.username).emit("scriptData", s);
    });

    socket.on("createScript", () => {
        if (scripts.length >= MAX_SCRIPTS) return;
        const s = { id: crypto.randomUUID(), name: "Untitled", script: "",
                    status: { running: false, error: null } };
        scripts.push(s);
        dirty = true;
        io.to(user.username).emit("scriptData", s);
    });

    socket.on("renameScript", (msg) => {
        if (!msg || typeof msg.id !== "string" || typeof msg.name !== "string") return;
        const name = msg.name.trim().slice(0, 40);
        const s = scripts.find(s => s.id === msg.id);
        if (!s || !name) return;
        s.name = name;
        dirty = true;
        io.to(user.username).emit("scriptData", s);
    });

    socket.on("deleteScript", (id) => {
        if (typeof id !== "string") return;
        const i = scripts.findIndex(s => s.id === id);
        if (i === -1) return;
        scripts.splice(i, 1);
        dirty = true;
        stopRuntime(id);
        io.to(user.username).emit("scriptDeleted", id);
    });

    socket.on("disconnect", () => {
        const n = (online.get(user.username) ?? 1) - 1;
        if (n <= 0) online.delete(user.username); else online.set(user.username, n);

        const rest = (userSockets.get(user.username) ?? []).filter(s => s !== socket);
        if (rest.length) userSockets.set(user.username, rest);
        else userSockets.delete(user.username);

        console.log(`${user.username} disconnected`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));