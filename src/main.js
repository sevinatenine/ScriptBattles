const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const fs = require("fs");

const crypto = require('node:crypto');

const { startRuntime, tickRuntime, stopRuntime, nextAction, runtimes } = require("./runner");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '../public')));

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

for (const u of users) for (const s of u.data?.scripts ?? []) { s.status.running = false; s.status.error = null; }

let dirty = false;
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

function makeApi(user) {
    return {
        log: (msg) => console.log(`[${user.username}]`, msg),
        scan: (radius) => {
            const px = user.data.col ?? 0, py = user.data.row ?? 0;
            return users
                .filter(u => u !== user)
                .map(u => {
                    const x = u.data.col ?? 0, y = u.data.row ?? 0;
                    return { name: u.username, x, y, dist: Math.hypot(x - px, y - py) };
                })
                .filter(e => e.dist <= radius)
                .sort((a, b) => a.dist - b.dist)
                .slice(0, 20);
        },
    };
}

const makeSnapshot = (user) => () => ({
    tick,
    player: { x: user.data.col ?? 0, y: user.data.row ?? 0, hp: user.data.hp ?? 100 },
    vision: [],
    nearestPlayerDistance: null,
});

const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

const ACTIONS = {
    move(user, arg) {
        const d = DIRS[arg];
        if (!d) return;
        user.data.col = (user.data.col ?? 0) + d[0];
        user.data.row = (user.data.row ?? 0) + d[1];
        dirty = true;
        io.to(user.username).emit("playerMove", { col: user.data.col, row: user.data.row });
    },
    attack(user, arg) {},
    wait() {},
};

setInterval(() => {
    tick++;

    for (const u of users) for (const s of u.data?.scripts ?? []) {
        if (!s.status.running) continue;
        const a = nextAction(s.id);
        if (a && Object.hasOwn(ACTIONS, a.type)) ACTIONS[a.type](u, a.arg);
    }

    for (const id of [...runtimes.keys()]) tickRuntime(id);
}, 200);

app.post("/login", (req, res) => {
    const { username, password } = req.body;
    if (typeof username !== "string" || typeof password !== "string") return res.redirect("/");

    const account = accounts.find(a => a.username === username);
    if (!account || !checkPassword(password, account)) return res.redirect("/");

    startSession(res, account);
    res.redirect("/");
});

app.post("/register", (req, res) => {
    const { username, password } = req.body;
    if (typeof username !== "string" || typeof password !== "string"
        || !username.trim() || password.length < 8) return res.redirect("/");

    if (accounts.some(a => a.username.toLowerCase() === username.toLowerCase()))
        return res.redirect("/");

    const { salt, hash } = hashPassword(password);
    const account = { username, salt, hash };
    accounts.push(account);

    const user = { username, data: {
        scripts: [
            {
                id: "0",
                name: "Hello World",
                script: "",
                status: { running: false, error: null }
            }
        ]
    } };
    users.push(user);

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
    return Object.fromEntries(header.split(";").map(c => c.trim().split("=").map(decodeURIComponent)));
}
io.use((socket, next) => {
    const account = accountFromToken(parseCookies(socket.handshake.headers.cookie).session);
    if (!account) return next(new Error("unauthorized"));
    socket.account = account;
    next();
});


const MAX_SCRIPTS = 20;
const MAX_SCRIPT_CHARS = 10_000;

io.on("connection", (socket) => {
    const user = getUser(socket.account.username);
    const scripts = user.data.scripts;

    socket.join(user.username);

    const starting = new Set();

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

    socket.on("disconnect", () => console.log(`${user.username} disconnected`));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));