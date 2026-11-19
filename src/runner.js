const ivm = require("isolated-vm");

const runtimes = new Map();

const INIT_TIMEOUT = 500;
const LOOP_TIMEOUT = 50;
const SCANS_PER_TICK = 2;
const MAX_SCAN_RADIUS = 20;
const MAX_QUEUE = 10;

const BOOTSTRAP = `
(function () {
    const ac = __act, lg = __log, sc = __scan;
    delete global.__act; delete global.__log; delete global.__scan;
    let state = { tick: 0, player: {}, vision: [], nearestPlayerDistance: null };

    global.__setState = (s) => { state = s; };

    global.player = Object.freeze({
        get x()      { return state.player.x; },
        get y()      { return state.player.y; },
        get hp()     { return state.player.hp; },
        get queued() { return state.player.queued; },
        move(dir)   { return ac("move", String(dir)); },
        attack(dir) { return ac("attack", String(dir)); },
        attackClosest() { return ac("attackClosest", "") },
        wait()      { return ac("wait", ""); },
        get xp()    { return state.player.xp; },
        get level() { return state.player.level; },
    });

    const listeners = { key: [] };
    const MAX_LISTENERS = 8;

    function on(type, fn) {
        if (typeof fn !== "function") throw new TypeError("listener must be a function");
        const list = listeners[type];
        if (list.length >= MAX_LISTENERS) throw new Error("too many " + type + " listeners");
        list.push(fn);
        return () => {
            const i = list.indexOf(fn);
            if (i >= 0) list.splice(i, 1);
        };
    }

    global.ui = Object.freeze({
        onKey(fn) { return on("key", fn); },
    });

    global.__dispatch = (type, payload) => {
        const list = listeners[type];
        if (!list) return;
        for (const fn of list.slice()) {
            try { fn(payload); }
            catch (e) { lg("listener error: " + e.message); }
        }
    };

    const scan = (r, t) => JSON.parse(sc(Number(r), t));
    const pick = (t, r) => r === undefined
        ? state.vision.filter(e => !t || e.type === t)
        : scan(r, t);

    global.world = Object.freeze({
        get vision() { return state.vision; },
        get nearestPlayerDistance() { return state.nearestPlayerDistance; },
        get tick() { return state.tick; },
        scan(radius) { return scan(radius); },
        players(radius)  { return pick("user", radius); },
        bots(radius)     { return pick("bot", radius); },
        entities(radius) { return pick(undefined, radius); },
    });

    global.log = (...a) => lg(a.join(" "));
    global.console = Object.freeze({ log: global.log, warn: global.log, error: global.log });
})();
`;

function pushState(rt) {
    const snap = rt.getSnapshot();
    snap.player.queued = rt.queue.length;
    return rt.setState.apply(undefined, [snap], { arguments: { copy: true } });
}

async function startRuntime(s, api, getSnapshot, onStop) {
    const isolate = new ivm.Isolate({ memoryLimit: 32 });
    const rt = { isolate, init: null, loop: null, setState: null, dispatch: null,
             getSnapshot, onStop, busy: false, stopped: false,
             scansLeft: SCANS_PER_TICK, queue: [], pendingEvents: 0 };

    try {
        const context = await isolate.createContext();
        const jail = context.global;
        await jail.set("global", jail.derefInto());

        await jail.set("__log", new ivm.Callback((m) => api.log(String(m).slice(0, 200))));
        await jail.set("__act", new ivm.Callback((type, arg) => {
            if (rt.queue.length >= MAX_QUEUE) return false;
            rt.queue.push({ type: String(type).slice(0, 16), arg: String(arg).slice(0, 16) });
            return true;
        }));
        await jail.set("__scan", new ivm.Callback((r, t) => {
            if (rt.scansLeft <= 0) return "[]";
            rt.scansLeft--;
            const radius = Math.min(Math.max(Number(r) || 0, 0), MAX_SCAN_RADIUS);
            const type = t === "user" || t === "bot" ? t : undefined;
            return JSON.stringify(api.scan(radius, type));
        }));

        await (await isolate.compileScript(BOOTSTRAP)).run(context);

        rt.setState = await jail.get("__setState", { reference: true });
        rt.dispatch = await jail.get("__dispatch", { reference: true });
        await context.eval("delete global.__setState; delete global.__dispatch");

        await pushState(rt); 

        await (await isolate.compileScript(s.script)).run(context, { timeout: INIT_TIMEOUT });

        rt.init = await jail.get("init", { reference: true });
        rt.loop = await jail.get("loop", { reference: true });

        if (rt.init.typeof === "function") {
            await rt.init.apply(undefined, [], { timeout: INIT_TIMEOUT });
        }
        if (rt.loop.typeof !== "function") throw new Error("no loop() function defined");
    } catch (e) {
        disposeRuntime(rt);
        throw e;
    }

    runtimes.set(s.id, rt);
    return rt;
}

async function tickRuntime(id) {
    const rt = runtimes.get(id);
    if (!rt || rt.busy || rt.stopped) return;
    rt.busy = true;
    try {
        rt.scansLeft = SCANS_PER_TICK;
        await pushState(rt);
        await rt.loop.apply(undefined, [], { timeout: LOOP_TIMEOUT });
    } catch (e) {
        stopRuntime(id, e.message);
    } finally {
        rt.busy = false;
    }
}

function disposeRuntime(rt) {
    rt.stopped = true;
    try { rt.init?.release(); rt.loop?.release(); rt.setState?.release(); rt.dispatch?.release(); } catch {}
    try { if (!rt.isolate.isDisposed) rt.isolate.dispose(); } catch {}
}

function stopRuntime(id, error) {
    const rt = runtimes.get(id);
    if (!rt) return;
    runtimes.delete(id);
    disposeRuntime(rt);
    rt.onStop?.(error);
}

function nextAction(id) {
    return runtimes.get(id)?.queue.shift() ?? null;
}

const MAX_PENDING_EVENTS = 10;

async function sendEvent(id, type, payload) {
    const rt = runtimes.get(id);
    if (!rt || rt.stopped || !rt.dispatch) return;
    if (rt.pendingEvents >= MAX_PENDING_EVENTS) return;
    rt.pendingEvents++;
    try {
        await rt.dispatch.apply(undefined, [type, String(payload).slice(0, 16)], {
            arguments: { copy: true },
            timeout: LOOP_TIMEOUT,
        });
    } catch (e) {
        stopRuntime(id, e.message);
    } finally {
        rt.pendingEvents--;
    }
}

module.exports = { startRuntime, tickRuntime, stopRuntime, nextAction, sendEvent, runtimes };