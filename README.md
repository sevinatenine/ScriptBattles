# ScriptBattles

ScriptBattles is an online combat game. You control a player who can move around and attack other bots and players. But, you can't control him yourself - you have to make scripts to. Your scripts can control the players attacks and movements and can receive input from the world as well. The server for the game is written in NodeJS and is accesible [here](https://scriptbattles.simon312.hackclub.app).

## Testing

Login with the username: `test_account` and password: `test_account!`.

## Writing scripts

Every script must define `loop()`, which runs every tick. It can also define `init()`, which runs once at startup.

```js
function loop() {
    if (world.bots(5).length) player.attackClosest();
    else player.wait();
}
```

| API | What it does |
|---|---|
| `player.x`, `y`, `hp`, `maxHp`, `xp`, `level`, `queued` | Your player's current state |
| `player.move(dir)`, `attack(dir)`, `attackClosest()`, `wait()` | Queue an action; returns `false` if the queue is full |
| `world.tick`, `vision`, `nearestPlayerDistance` | Free information about the current tick |
| `world.wall(dx, dy)` | `true` if the tile is solid |
| `world.tiles(radius)` | The surrounding tile grid |
| `world.scan(radius)`, `players()`, `bots()`, `entities()`, `drops()` | Find nearby things |
| `ui.onKey(fn)` | React to keyboard input (returns an unsubscribe function) |
| `log(...)`, `console.log` | Print to your script's log |

Directions are `"up"`, `"down"`, `"left"`, and `"right"`. Without a radius, `players`, `bots`, and `entities` read `world.vision` for free. With a radius they run a scan.

### Limits

| Limit | Value |
|---|---|
| `loop()` time per tick | 50 ms |
| `init()` time | 500 ms |
| Memory per script | 32 MB |
| Queued actions | 10 |
| Scans, tile reads, and drop scans per tick | 2 each |
| Max scan radius | 20 |
| Key listeners | 8 |
| Scripts per account | 20 (10,000 characters each) |
| Scripts running at once | 3 |

A script that exceeds a limit, throws, or has no `loop()` is stopped, and the error is shown next to it.

## The world

- The map is a 301×301 cave, with a safe zone around spawn where bots can't hurt you.
- Bots get tougher and give more XP the farther they are from spawn, from wanderers near the start to horrors at the edge.
- Killing things earns XP. Higher levels deal more damage and have more HP.
- Dying costs you a fraction of your progress toward the next level, and you get a few ticks of spawn protection when you come back.

## Running your own server

```bash
npm install
node --no-node-snapshot src/main.js
```

The `--no-node-snapshot` flag is needed by `isolated-vm`, which runs player scripts in a sandbox. The server listens on `PORT` (default 3000) and stores accounts, scripts, and the map in `data/`, saving about once a second and again on shutdown.

For production, run it as a systemd service with `NODE_ENV=production` if you're serving over HTTPS.

## Controls

You make them with your scripts!

## Connecting

Go to [scriptbattles.simon312.hackclub.app](https://scriptbattles.simon312.hackclub.app).