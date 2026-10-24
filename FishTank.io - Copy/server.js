// Fishtank.io server: serves /public and runs the authoritative game state over WebSocket.
const express = require('express'), http = require('http'), { WebSocketServer } = require('ws');
const app = express();
app.use(express.static(__dirname + '/public'));
const server = http.createServer(app), wss = new WebSocketServer({ server });

const ARENA = { x: 36, z: 22, h: 14 };            // half-width, half-depth, height of the tank
const WEAPONS = {                                  // add new guns here; the client picks them up automatically
  pistol:   { name: 'Bubble Pistol',   dmg: 20, pellets: 1, spread: 0.008, rate: 350,  mag: 12, reload: 1200, range: 60,  splash: 0,   boost: 2, color: 0x4fc3f7, len: 0.5 },
  puffer:   { name: 'Pufferfish SMG',  dmg: 9,  pellets: 1, spread: 0.045, rate: 90,   mag: 20, reload: 1800, range: 35,  splash: 0,   boost: 4, auto: true, color: 0xffa040, len: 0.45 },
  shotgun:  { name: 'Clam Shotgun',    dmg: 12, pellets: 8, spread: 0.09,  rate: 900,  mag: 4,  reload: 2000, range: 22,  splash: 0,   boost: 6, color: 0xff9ecb, len: 0.55 },
  squid:    { name: 'Squid Launcher',  dmg: 75, pellets: 1, spread: 0.004, rate: 1300, mag: 2,  reload: 2600, range: 50,  splash: 4.5, splashDmg: 110, proj: 26, boost: 8, color: 0xb39ddb, len: 0.7 },
  seahorse: { name: 'Seahorse Sniper', dmg: 90, pellets: 1, spread: 0,     rate: 1500, mag: 3,  reload: 2400, range: 120, splash: 0,   boost: 10, scope: 14, color: 0xffd23f, len: 0.9 }
};
const OBST = [                                     // x,z = center, w/d = footprint, h = height (all sit on the gravel); t = look
  { x: 0, z: 0, w: 7, h: 4.5, d: 7, t: 'castle' },
  { x: 0, z: -15, w: 12, h: 2, d: 3.5, t: 'ship' }, { x: 0, z: 15, w: 12, h: 2, d: 3.5, t: 'ship' },
  { x: -14, z: 8, w: 4, h: 2.2, d: 3, t: 'chest' }, { x: 14, z: -8, w: 4, h: 2.2, d: 3, t: 'chest' },
  { x: -10, z: -10, w: 3, h: 6, d: 3, t: 'coral' }, { x: 10, z: 10, w: 3, h: 6, d: 3, t: 'coral' },
  { x: -24, z: 12, w: 3, h: 5, d: 3, t: 'coral' }, { x: 24, z: -12, w: 3, h: 5, d: 3, t: 'coral' },
  { x: -24, z: -3, w: 3, h: 4, d: 8, t: 'rock' }, { x: 24, z: 3, w: 3, h: 4, d: 8, t: 'rock' },
  { x: -14, z: -3, w: 2, h: 7, d: 2, t: 'pillar' }, { x: 14, z: 3, w: 2, h: 7, d: 2, t: 'pillar' },
  { x: -28, z: -14, w: 4, h: 2, d: 4, t: 'lego' }, { x: 28, z: 14, w: 4, h: 2, d: 4, t: 'lego' },
  { x: -6, z: 10, w: 3, h: 1.2, d: 3, t: 'lego' }, { x: 6, z: -10, w: 3, h: 1.2, d: 3, t: 'lego' },
  { x: -20, z: 16, w: 5, h: 2, d: 4, t: 'shell' }, { x: 20, z: -16, w: 5, h: 2, d: 4, t: 'shell' }
];
const SPAWNS = [[-32, -18], [32, 18], [-32, 18], [32, -18], [0, -19.5], [0, 19.5], [-19, 0], [19, 0]];
const players = new Map(); let nextId = 1;

const send = (ws, m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
const bcast = m => { const s = JSON.stringify(m); for (const c of wss.clients) if (c.readyState === 1) c.send(s); };  // everyone, including players sitting in the menu
const norm = v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };

function raySphere(o, d, c, r) {
  const m = [o[0] - c[0], o[1] - c[1], o[2] - c[2]], b = m[0] * d[0] + m[1] * d[1] + m[2] * d[2];
  const cc = m[0] * m[0] + m[1] * m[1] + m[2] * m[2] - r * r;
  if (cc > 0 && b > 0) return null;
  const disc = b * b - cc; if (disc < 0) return null;
  return Math.max(0, -b - Math.sqrt(disc));
}
function rayBox(o, d, B) {
  const mn = [B.x - B.w / 2, 0, B.z - B.d / 2], mx = [B.x + B.w / 2, B.h, B.z + B.d / 2];
  let t0 = 0, t1 = 1e9;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-8) { if (o[i] < mn[i] || o[i] > mx[i]) return null; continue; }
    let a = (mn[i] - o[i]) / d[i], b = (mx[i] - o[i]) / d[i];
    if (a > b) { const t = a; a = b; b = t; }
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  return t0;
}
function tankLimit(o, d) {                         // distance until the ray hits the glass, floor or surface
  const lo = [-ARENA.x, 0, -ARENA.z], hi = [ARENA.x, ARENA.h, ARENA.z]; let t = 1e9;
  for (let i = 0; i < 3; i++) { if (d[i] > 1e-8) t = Math.min(t, (hi[i] - o[i]) / d[i]); else if (d[i] < -1e-8) t = Math.min(t, (lo[i] - o[i]) / d[i]); }
  return Math.max(0, t);
}

function spawn(p) {
  const [x, z] = SPAWNS[Math.floor(Math.random() * SPAWNS.length)];
  Object.assign(p, { x, y: 0, z, hp: 100, dead: false, reloadAt: 0, safe: Date.now() + 2000, boostAt: 0 });  // 2s spawn shield
  for (const k in WEAPONS) p.am[k] = WEAPONS[k].mag;
  send(p.ws, { t: 'spawn', x, y: 0, z });
}
function hurt(victim, att, dmg, head) {
  if (victim.dead || Date.now() < victim.safe) return;
  victim.hp -= dmg; send(victim.ws, { t: 'hurt' }); if (victim !== att) send(att.ws, { t: 'hit', head });
  if (victim.hp <= 0) {
    victim.dead = true; victim.deaths++; if (victim !== att) att.kills++;
    bcast({ t: 'kill', k: att.name, v: victim.name, w: WEAPONS[att.w].name, head, self: victim === att });
    send(victim.ws, { t: 'dead', by: victim === att ? 'your own blast' : att.name });   // client returns to the menu; they rejoin with a new "join"
  }
}
function shoot(p, dir) {
  const W = WEAPONS[p.w], now = Date.now();
  if (p.dead || p.reloadAt || now - p.last < W.rate) return;
  if (p.am[p.w] <= 0) { p.reloadAt = now + W.reload; return; }   // no auto-reload: pulling the trigger on an empty gun (or pressing R) starts it
  p.last = now; p.am[p.w]--;
  const o = [p.x, p.y + 1.7, p.z];
  if (W.proj) return launch(p, W, o, dir);       // projectile weapons (the squid) fly instead of hitting instantly
  for (let i = 0; i < W.pellets; i++) {
    const d = norm(dir.map(v => v + (Math.random() - 0.5) * 2 * W.spread));
    let tMax = Math.min(W.range, tankLimit(o, d));
    for (const b of OBST) { const t = rayBox(o, d, b); if (t !== null && t < tMax) tMax = t; }
    let best = null, head = false;
    for (const q of players.values()) {
      if (q === p || q.dead) continue;
      let t = raySphere(o, d, [q.x, q.y + 1.72, q.z], 0.45);
      if (t !== null && t < tMax) { tMax = t; best = q; head = true; }
      t = raySphere(o, d, [q.x, q.y + 0.9, q.z], 0.7);
      if (t !== null && t < tMax) { tMax = t; best = q; head = false; }
    }
    const e = o.map((v, k) => v + d[k] * tMax);
    bcast({ t: 'shot', id: p.id, o, e, w: p.w });
    if (best) hurt(best, p, W.dmg * (head ? 1.5 : 1), head);
    if (W.splash) splash(p, W, e, best);
  }
}
function splash(p, W, e, skip) {                 // area damage that fades with distance
  for (const q of players.values()) {
    if (q === skip || q.dead) continue;               // the shooter is included: squid blasts hurt you too
    const dist = Math.hypot(q.x - e[0], q.y + 0.9 - e[1], q.z - e[2]);
    if (dist < W.splash) hurt(q, p, (W.splashDmg || W.dmg) * (1 - 0.6 * dist / W.splash), false);
  }
}
const projs = []; let nextPid = 1;
function launch(p, W, o, dir) {
  const d = norm(dir.map(v => v + (Math.random() - 0.5) * 2 * W.spread));
  const pr = { pid: nextPid++, p, W, pos: o.slice(), d, left: W.range };
  projs.push(pr); bcast({ t: 'proj', pid: pr.pid, id: p.id, o, d, speed: W.proj, w: p.w });
}
function stepProjs(dt) {                         // swept movement so fast squids can't tunnel through walls or divers
  for (let i = projs.length - 1; i >= 0; i--) {
    const pr = projs[i], W = pr.W, d = pr.d, len = Math.min(W.proj * dt, pr.left);
    let tMax = Math.min(len, tankLimit(pr.pos, d)), hit = null, head = false, wall = tMax < len;
    for (const b of OBST) { const t = rayBox(pr.pos, d, b); if (t !== null && t < tMax) { tMax = t; wall = true; } }
    for (const q of players.values()) {
      if (q === pr.p || q.dead) continue;
      let t = raySphere(pr.pos, d, [q.x, q.y + 1.72, q.z], 0.6); if (t !== null && t < tMax) { tMax = t; hit = q; head = true; wall = false; }
      t = raySphere(pr.pos, d, [q.x, q.y + 0.9, q.z], 0.8); if (t !== null && t < tMax) { tMax = t; hit = q; head = false; wall = false; }
    }
    const e = pr.pos.map((v, k) => v + d[k] * tMax); pr.left -= tMax;
    if (hit || wall || pr.left <= 0.01) {
      if (hit) hurt(hit, pr.p, W.dmg * (head ? 1.5 : 1), head);
      splash(pr.p, W, e, hit);
      bcast({ t: 'pop', pid: pr.pid, e }); projs.splice(i, 1);
    } else pr.pos = e;
  }
}
setInterval(() => stepProjs(0.033), 33);

wss.on('connection', ws => {
  ws.pid = nextId++;
  send(ws, { t: 'welcome', id: ws.pid, weapons: WEAPONS, obst: OBST, arena: ARENA });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    let p = players.get(ws.pid);
    if (m.t === 'join') {                          // first dive, or a re-dive after being popped
      const w = WEAPONS[m.w] ? m.w : 'pistol', name = String(m.name || 'Diver').slice(0, 14);
      if (!p) { p = { id: ws.pid, ws, name, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hp: 100, w, am: {}, reloadAt: 0, last: 0, kills: 0, deaths: 0, dead: false, safe: 0, boostAt: 0 }; players.set(p.id, p); spawn(p); }
      else if (p.dead) { p.name = name; p.w = w; spawn(p); }
      return;
    }
    if (!p) return;
    if (m.t === 'state' && !p.dead && [m.x, m.y, m.z, m.yaw, m.pitch].every(Number.isFinite)) {
      p.x = Math.max(-ARENA.x + 0.5, Math.min(ARENA.x - 0.5, m.x)); p.z = Math.max(-ARENA.z + 0.5, Math.min(ARENA.z - 0.5, m.z));
      p.y = Math.max(0, Math.min(ARENA.h - 2, m.y)); p.yaw = m.yaw; p.pitch = m.pitch;
    } else if (m.t === 'shoot' && Array.isArray(m.dir) && m.dir.length === 3 && m.dir.every(Number.isFinite)) shoot(p, norm(m.dir));
    else if (m.t === 'boost' && !p.dead && Date.now() >= p.boostAt) { p.boostAt = Date.now() + WEAPONS[p.w].boost * 1000 - 300; bcast({ t: 'boost', id: p.id }); }
    else if (m.t === 'reload' && !p.reloadAt && p.am[p.w] < WEAPONS[p.w].mag) p.reloadAt = Date.now() + WEAPONS[p.w].reload;
  });
  ws.on('close', () => players.delete(ws.pid));
});

setInterval(() => {                                // 20 Hz world snapshot
  const now = Date.now();
  for (const p of players.values()) if (p.reloadAt && now >= p.reloadAt) { p.am[p.w] = WEAPONS[p.w].mag; p.reloadAt = 0; }
  const list = [...players.values()].map(p => ({ id: p.id, n: p.name, x: p.x, y: p.y, z: p.z, yw: p.yaw, pt: p.pitch, hp: p.hp, w: p.w, k: p.kills, d: p.deaths, dead: p.dead }));
  bcast({ t: 'snap', p: list });
  for (const p of players.values()) send(p.ws, { t: 'me', hp: p.hp, w: p.w, ammo: p.am[p.w], rel: !!p.reloadAt });
}, 50);

server.listen(process.env.PORT || 3000, () => console.log('Fishtank.io running on port ' + (process.env.PORT || 3000)));
