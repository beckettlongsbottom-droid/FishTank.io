// Fishtank.io server: serves /public and runs the authoritative game state over WebSocket.
const express = require('express'), http = require('http'), fs = require('fs'), crypto = require('crypto'), { WebSocketServer } = require('ws');
const app = express();
app.use(express.static(__dirname + '/public'));
const server = http.createServer(app), wss = new WebSocketServer({ server });

const ARENA = { x: 36, z: 22, h: 18 };            // half-width, half-depth, height of the tank
const WEAPONS = {                                  // add new guns here; the client picks them up automatically
  pistol:   { name: 'Bubble Pistol',   dmg: 24, pellets: 1, spread: 0.008, rate: 100,  mag: 16, reload: 1200, range: 60,  splash: 0,   boost: 2, crack: 1, color: 0x4fc3f7, len: 0.5 },
  puffer:   { name: 'Pufferfish SMG',  dmg: 9,  pellets: 1, spread: 0.045, rate: 90,   mag: 20, reload: 1800, range: 35,  splash: 0,   boost: 4, crack: .5, auto: true, color: 0x2fd3c4, len: 0.45 },
  shotgun:  { name: 'Clam Shotgun',    dmg: 18, pellets: 8, spread: 0.09,  rate: 900,  mag: 4,  reload: 2000, range: 22,  splash: 0,   boost: 6, crack: .7, color: 0xff9ecb, len: 0.55 },
  squid:    { name: 'Squid Launcher',  dmg: 200, pellets: 1, spread: 0.004, rate: 700, mag: 1, reload: 2200, range: 60, splash: 4.5, splashMin: 60, splashMax: 95, autoReload: true, proj: 26, boost: 8, crack: 8, color: 0xb39ddb, len: 0.7 },
  seahorse: { name: 'Seahorse Sniper', dmg: 90, pellets: 1, spread: 0,     rate: 1500, mag: 3,  reload: 2400, range: 120, splash: 0,   boost: 10, crack: 3, scope: 20, color: 0xffd23f, len: 0.9 }
};
const OBST = [                                     // x,z = center, w/d = footprint, h = height (all sit on the gravel); t = look ('hidden' = collider only)
  { x: 0, z: 0, w: 7, h: 4.5, d: 7, t: 'castle' },
  { x: 0, z: -15, w: 12, h: 2, d: 3.5, t: 'ship' }, { x: 0, z: 15, w: 12, h: 2, d: 3.5, t: 'ship' },
  { x: -3.6, z: -15, w: 4.2, h: 3.6, d: 3.15, t: 'hidden' }, { x: -3.6, z: 15, w: 4.2, h: 3.6, d: 3.15, t: 'hidden' },   // ship cabins (walkable roofs)
  { x: 1.2, z: -15, w: 1.6, h: 8, d: 1.6, t: 'hidden' }, { x: 1.2, z: 15, w: 1.6, h: 8, d: 1.6, t: 'hidden' },             // masts + crow's nests (the very top of the ship)
  { x: 1.4, z: -15, w: .7, h: 6.5, d: 4, t: 'hidden' }, { x: 1.4, z: 15, w: .7, h: 6.5, d: 4, t: 'hidden' },                 // sails
  { x: -2, z: -17.05, w: .7, h: 1.9, d: 1.2, t: 'hidden' }, { x: 2, z: -17.05, w: .7, h: 1.9, d: 1.2, t: 'hidden' }, { x: -2, z: -12.95, w: .7, h: 1.9, d: 1.2, t: 'hidden' }, { x: 2, z: -12.95, w: .7, h: 1.9, d: 1.2, t: 'hidden' },   // cannons poking out of the hull
  { x: -2, z: 12.95, w: .7, h: 1.9, d: 1.2, t: 'hidden' }, { x: 2, z: 12.95, w: .7, h: 1.9, d: 1.2, t: 'hidden' }, { x: -2, z: 17.05, w: .7, h: 1.9, d: 1.2, t: 'hidden' }, { x: 2, z: 17.05, w: .7, h: 1.9, d: 1.2, t: 'hidden' },
  { x: -2.6, z: -2.6, w: 2.2, h: 5.9, d: 2.2, t: 'hidden' }, { x: 2.6, z: -2.6, w: 2.2, h: 5.9, d: 2.2, t: 'hidden' }, { x: -2.6, z: 2.6, w: 2.2, h: 5.9, d: 2.2, t: 'hidden' }, { x: 2.6, z: 2.6, w: 2.2, h: 5.9, d: 2.2, t: 'hidden' },   // castle corner towers
  { x: -14, z: 8, w: 4, h: 2.2, d: 3, t: 'chest' }, { x: 14, z: -8, w: 4, h: 2.2, d: 3, t: 'chest' },
  { x: -10, z: -10, w: 4.2, h: 6, d: 4.2, t: 'coral', thru: true }, { x: 10, z: 10, w: 4.2, h: 6, d: 4.2, t: 'coral', thru: true },
  { x: -24, z: 12, w: 4.2, h: 5, d: 4.2, t: 'coral', thru: true }, { x: 24, z: -12, w: 4.2, h: 5, d: 4.2, t: 'coral', thru: true },
  { x: -24, z: -3, w: 3, h: 4, d: 8, t: 'rock' }, { x: 24, z: 3, w: 3, h: 4, d: 8, t: 'rock' },
  { x: -14, z: -3, w: 2, h: 7, d: 2, t: 'pillar' }, { x: 14, z: 3, w: 2, h: 7, d: 2, t: 'pillar' },
  { x: -28, z: -14, w: 4, h: 2, d: 4, t: 'lego' }, { x: 28, z: 14, w: 4, h: 2, d: 4, t: 'lego' },
  { x: -6, z: 10, w: 3, h: 1.2, d: 3, t: 'lego' }, { x: 6, z: -10, w: 3, h: 1.2, d: 3, t: 'lego' },
  { x: -20, z: 16, w: 5, h: 2, d: 4, t: 'shell' }, { x: 20, z: -16, w: 5, h: 2, d: 4, t: 'shell' },
  // jellyfish parkour: bouncy steps climbing up, one on each side of the tank
  { x: -33, z: 16, w: 3.2, h: 1.5, d: 3.2, t: 'jelly' }, { x: -31, z: 6, w: 3, h: 2.6, d: 3, t: 'jelly' }, { x: -33, z: -1.5, w: 3, h: 3.7, d: 3, t: 'jelly' },     // spread out along the walls: ~10 apart
  { x: -32, z: -14.5, w: 3, h: 4.8, d: 3, t: 'jelly' }, { x: -20, z: -18.5, w: 3, h: 5.9, d: 3, t: 'jelly' },
  { x: 33, z: -16, w: 3.2, h: 1.5, d: 3.2, t: 'jelly' }, { x: 31, z: -6, w: 3, h: 2.6, d: 3, t: 'jelly' }, { x: 33, z: 4.5, w: 3, h: 3.7, d: 3, t: 'jelly' },
  { x: 32, z: 14.5, w: 3, h: 4.8, d: 3, t: 'jelly' }, { x: 20, z: 18.5, w: 3, h: 5.9, d: 3, t: 'jelly' }
];
const GEYSERS = [{ x: -18, z: -12 }, { x: 18, z: 12 }, { x: -9, z: 19 }, { x: 9, z: -19 }, { x: 30, z: 0 }, { x: -30, z: -6 }];   // bubble geysers launch you upward
const SPAWNS = [[-32, -18], [32, 18], [-32, 18], [32, -18], [0, -19.5], [0, 19.5], [-19, 0], [19, 0]];
const players = new Map(); let nextId = 1;
const rnd = (a, b) => a + Math.random() * (b - a), T0 = Date.now(), srvT = () => (Date.now() - T0) / 1000;

// ----- decorative fish are real targets: shoot them all and the kid comes in -----
const FISH = [];
function newFish() { FISH.length = 0; for (let s = 0; s < 3; s++) for (let k = 0; k < 5; k++) FISH.push({ cx: rnd(-8, 8), cz: rnd(-5, 5), rx: ARENA.x * .7 - s * 4, rz: ARENA.z * .65 - s * 3, y: 4 + s * 3, sp: .02 + s * .005, ph: k * .35 + s * 2, s, dead: false }); }
const fishPos = (f, t) => { const a = t * f.sp * 6.283 + f.ph; return [f.cx + Math.cos(a) * f.rx, f.y + Math.sin(a * 2) * .8, f.cz + Math.sin(a) * f.rz]; };
function fishHit(o, d, tMax) {
  let best = null; const t0 = srvT();
  FISH.forEach((f, i) => { if (f.dead) return; const t = raySphere(o, d, fishPos(f, t0), .8); if (t !== null && t < tMax) { tMax = t; best = i; } });
  return best === null ? null : { i: best, t: tMax };
}
function killFish(i) { const f = FISH[i]; if (!f || f.dead) return; f.dead = true; bcast({ t: 'fish', i, p: fishPos(f, srvT()) }); if (FISH.every(x => x.dead)) kidEvent(); }
let kidOn = false, kidKO = false, kidHp = 200, kidStart = 0, kidTimers = [];
const KID = { floor: -16.5, dx: -18, z0: 117, zS: 35 };
const kidPos = () => { const w = Math.max(0, Math.min(1, ((Date.now() - kidStart) / 1000 - 1.5) / 3.5)); return [KID.dx * (1 - w), KID.z0 + (KID.zS - KID.z0) * w]; };
function kidHit(o, d, tMax) {                    // the kid is 43 units tall: head, torso and leg spheres
  if (!kidOn || kidKO) return null; const [x, z] = kidPos(), fy = KID.floor; let best = null;
  for (const [cy, r, head] of [[fy + 36.9, 6.6, true], [fy + 23.4, 9, false], [fy + 8.1, 7, false]]) { const t = raySphere(o, d, [x, cy, z], r); if (t !== null && t < tMax) { tMax = t; best = { t, head }; } }
  return best;
}
function hurtKid(att, dmg, head) {               // once the glass is gone you can shoot him: 200 hp = one squid launcher
  if (!kidOn || kidKO || inter) return; kidHp -= dmg; send(att.ws, { t: 'hit', head }); bcast({ t: 'kidhurt', hp: Math.max(0, kidHp) });
  if (kidHp <= 0) {
    kidKO = true; kidTimers.forEach(clearTimeout); giveXp(att, 300); bcast({ t: 'kidko' }); bcast({ t: 'kill', k: att.name, v: 'The kid', w: WEAPONS[att.w].name, head, self: false });
    kidTimers = [setTimeout(endKidEvent, 23500)];   // his mother needs about 21 s to find him, weep, and soak herself
  }
}
function endKidEvent() { kidTimers.forEach(clearTimeout); kidTimers = []; newFish(); if (drained) FISH.forEach(f => f.dead = true); bcast({ t: 'fishreset', fish: FISH }); kidOn = false; kidKO = false; }
function kidEvent() {                            // easter egg: the kid walks in, cries, gets mad, and smashes the tank (the glass breaks and the water pours as everybody is popped)
  if (kidOn) return; kidOn = true; kidKO = false; kidHp = 200; kidStart = Date.now(); bcast({ t: 'kid' });
  kidTimers = [setTimeout(() => { if (!kidKO && !drained) forceDrain('z+'); }, 15100), setTimeout(() => {
    if (kidKO) return;
    for (const q of players.values()) if (!q.dead) { q.dead = true; q.deaths++; burst(q); send(q.ws, { t: 'dead', by: 'a very sad kid', byId: 0 }); }
    bcast({ t: 'kill', k: 'The kid', v: 'everyone', w: 'a tantrum', self: false });
    endKidEvent();
  }, 16500)];
}
newFish();

// ----- glass: shots that hit the tank walls crack it (bigger guns = bigger cracks); enough cracks and the tank bursts and drains -----
let drained = false, CRACKS = [], crackTotal = 0;
const CRACK_BREAK = +process.env.CRACK_BREAK || 150, REFILL_MS = 60000;   // durability: total crack size that shatters the tank
const MATCH_MS = +process.env.MATCH_MS || 8 * 60 * 1000, INTER_MS = +process.env.INTER_MS || 10000; let matchEnd = Date.now() + MATCH_MS, inter = false, interEnd = 0, refillT = null, drainFace = 'z+', FACETALLY = {};       // tune: total crack size that bursts the tank, and how long until it is refilled
function glassHit(o, d) {                        // first side wall a ray hits (floor and surface don't crack); face = x+ x- z+ z-, u = along the wall, v = height
  let best = null;
  for (const [axis, side] of [[0, 1], [0, -1], [2, 1], [2, -1]]) {
    if (Math.abs(d[axis]) < 1e-8) continue; const lim = (axis === 0 ? ARENA.x : ARENA.z) * side, t = (lim - o[axis]) / d[axis]; if (t <= 0) continue;
    const y = o[1] + d[1] * t, other = axis === 0 ? o[2] + d[2] * t : o[0] + d[0] * t, span = axis === 0 ? ARENA.z : ARENA.x;
    if (y < 0 || y > ARENA.h || Math.abs(other) > span) continue;
    if (!best || t < best.t) best = { t, face: (axis === 0 ? 'x' : 'z') + (side > 0 ? '+' : '-'), u: other, v: y };
  }
  return best;
}
function addCrack(gh, size) {
  if (drained || !gh || !size) return;
  const c = { face: gh.face, u: +gh.u.toFixed(2), v: +gh.v.toFixed(2), s: size }; CRACKS.push(c); crackTotal += size; FACETALLY[gh.face] = (FACETALLY[gh.face] || 0) + size; bcast(Object.assign({ t: 'crack' }, c));
  if (crackTotal >= CRACK_BREAK) drain();
}
function drain() {                               // the tank bursts: the water and every fish pour out into the room, then the match carries on in a dry tank
  drained = true; drainFace = Object.keys(FACETALLY).sort((a, b) => FACETALLY[b] - FACETALLY[a])[0] || 'z+'; for (const f of FISH) f.dead = true; bcast({ t: 'drain', face: drainFace }); clearTimeout(refillT); refillT = setTimeout(refill, REFILL_MS);
}
function forceDrain(face) { if (drained) return; FACETALLY[face] = (FACETALLY[face] || 0) + 1e5; crackTotal = Math.max(crackTotal, CRACK_BREAK); drain(); }
function refill() {
  if (!drained) return; clearTimeout(refillT); drained = false; CRACKS = []; crackTotal = 0; FACETALLY = {}; newFish(); bcast({ t: 'refill', fish: FISH });
  for (const p of players.values()) if (!p.dead && (Math.abs(p.x) > ARENA.x || Math.abs(p.z) > ARENA.z)) { const [x, z] = SPAWNS[Math.floor(Math.random() * SPAWNS.length)]; p.x = x; p.y = 0; p.z = z; send(p.ws, { t: 'tp', x, y: 0, z }); }   // anyone still out on the desk gets put back in
}
function fallDeath(p) {                          // jumped off the table and hit the bedroom floor
  if (p.dead) return; p.dead = true; p.deaths++; burst(p); bcast({ t: 'kill', k: p.name, v: p.name, w: 'a big fall', self: true }); send(p.ws, { t: 'dead', by: 'the bedroom floor', byId: 0 });
}
function endMatch() {                            // 8:00 matches repeat forever: results screen, then everything resets
  inter = true; interEnd = Date.now() + INTER_MS; const board = [...players.values()].map(p => ({ n: p.name, k: p.kills, d: p.deaths })).sort((a, b) => b.k - a.k || a.d - b.d).slice(0, 5);
  const top = [...players.values()].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)[0]; if (top && top.kills > 0) giveXp(top, 100);   // winner bonus
  bcast({ t: 'matchend', board, next: (interEnd - T0) / 1000 });
}
function startMatch() {
  if (kidOn) { kidTimers.forEach(clearTimeout); kidTimers = []; kidOn = false; kidKO = false; }
  inter = false; matchEnd = Date.now() + MATCH_MS; clearTimeout(refillT); drained = false; CRACKS = []; crackTotal = 0; FACETALLY = {}; newFish();
  for (const p of players.values()) { p.kills = 0; p.deaths = 0; p.lastHit = null; if (!p.dead) spawn(p); }
  bcast({ t: 'matchstart', end: (matchEnd - T0) / 1000, fish: FISH });
}
setInterval(() => { const now = Date.now(); if (!inter && now >= matchEnd) endMatch(); else if (inter && now >= interEnd) startMatch(); }, 500);

// ----- accounts, XP and cosmetics (saved to data/accounts.json; on free hosts without a disk this resets on redeploy) -----
const DB = __dirname + '/data/accounts.json'; let ACC = {}, dirty = false;
try { ACC = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch {}
setInterval(() => { if (!dirty) return; dirty = false; try { fs.mkdirSync(__dirname + '/data', { recursive: true }); fs.writeFileSync(DB, JSON.stringify(ACC)); } catch (e) { console.log('save failed', e.message); } }, 5000);
const levelCost = L => Math.round(80 + 6 * Math.pow(L, 1.4));    // XP from level L to L+1: gets steadily harder (tune here)
function levelOf(xp) { let L = 1, need = levelCost(1); while (L < 100 && xp >= need) { xp -= need; L++; need = levelCost(L); } return { level: L, into: L >= 100 ? 0 : xp, need: L >= 100 ? 0 : need }; }
const COSMETICS = [                              // one unlock per milestone, least cool to coolest
  { id: 'duck', name: 'Rubber Duck Buddy', slot: 'hat', lvl: 5 }, { id: 'wig', name: 'Seaweed Wig', slot: 'hat', lvl: 10 },
  { id: 'clown', name: 'Clownfish Paint', slot: 'paint', lvl: 15 }, { id: 'pirate', name: 'Pirate Captain Hat', slot: 'hat', lvl: 25 },
  { id: 'pearl', name: 'Pearl Bubble Trail', slot: 'trail', lvl: 35 }, { id: 'crab', name: 'Crab On Your Head', slot: 'hat', lvl: 50 },
  { id: 'scales', name: 'Mermaid Scale Suit', slot: 'suit', lvl: 65 }, { id: 'rainbow', name: 'Rainbow Bubble Trail', slot: 'trail', lvl: 75 },
  { id: 'narwhal', name: 'Narwhal Horn', slot: 'hat', lvl: 90 }, { id: 'golden', name: 'THE GOLDEN DIVER', slot: 'suit', lvl: 100 }
];
const sessions = new Map(), hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const progOf = a => Object.assign({ xp: a.xp, eq: a.eq }, levelOf(a.xp));
function auth(ws, m) {
  const fail = e => send(ws, { t: 'auth', ok: false, error: e });
  const busy = u => [...wss.clients].some(c => c !== ws && c.acct === u && c.readyState === 1);   // one login per account at a time
  if (m.token && sessions.has(m.token)) { const u0 = sessions.get(m.token); if (busy(u0)) return fail('That account is already logged in somewhere else.'); ws.acct = u0; const a = ACC[ws.acct]; return send(ws, Object.assign({ t: 'auth', ok: true, token: m.token, user: a.user, admin: a.user === ADMIN }, progOf(a))); }
  const user = String(m.user || '').trim().toLowerCase(), pass = String(m.pass || '');
  if (!/^[a-z0-9_]{3,14}$/.test(user) || pass.length < 4 || pass.length > 64) return fail('Username: 3-14 letters/numbers. Password: 4+ characters.');
  let a = ACC[user];
  if (m.mode === 'register') { if (a) return fail('That username is taken.'); const salt = crypto.randomBytes(8).toString('hex'); a = ACC[user] = { user, salt, hash: hashPw(pass, salt), xp: 0, eq: {} }; dirty = true; }
  else if (!a || a.hash !== hashPw(pass, a.salt)) return fail('Wrong username or password.');
  if (busy(user)) return fail('That account is already logged in somewhere else.');
  const token = crypto.randomBytes(16).toString('hex'); sessions.set(token, user); ws.acct = user;
  send(ws, Object.assign({ t: 'auth', ok: true, token, user: a.user, admin: a.user === ADMIN }, progOf(a)));
}

// ---------- secret admin panel: only the account named buddyboy32 (logged in with its password) may send these ----------
const ADMIN = 'buddyboy32';
function refreshAcct(u) {                        // after an admin edit: drop cosmetics above the new level and push the new numbers to anyone who is logged in as that account
  const a = ACC[u]; if (!a) return; const lv = levelOf(a.xp).level;
  for (const k of Object.keys(a.eq)) { const c = COSMETICS.find(x => x.id === a.eq[k]); if (!c || c.lvl > lv) delete a.eq[k]; }
  for (const c of wss.clients) if (c.acct === u) send(c, Object.assign({ t: 'prog' }, progOf(a)));
  for (const p of players.values()) if (p.acct === u) { p.lv = lv; p.eq = a.eq; }
  dirty = true;
}
function adminList(ws) {
  const on = new Set([...wss.clients].map(c => c.acct).filter(Boolean));
  send(ws, { t: 'adminlist', accts: Object.values(ACC).map(a => ({ user: a.user, xp: a.xp, level: levelOf(a.xp).level, on: on.has(a.user) })).sort((x, y) => (y.on - x.on) || (y.xp - x.xp)) });
}
function admin(ws, m) {
  if (ws.acct !== ADMIN || !ACC[ADMIN]) return;
  const u = String(m.user || '').toLowerCase(), a = ACC[u], n = Math.floor(+m.n);
  switch (m.cmd) {
    case 'list': break;
    case 'setxp': if (a && Number.isFinite(n)) { a.xp = Math.max(0, Math.min(1e9, n)); refreshAcct(u); } break;
    case 'addxp': if (a && Number.isFinite(n)) { a.xp = Math.max(0, Math.min(1e9, a.xp + n)); refreshAcct(u); } break;
    case 'wipe': if (a) { a.xp = 0; a.eq = {}; refreshAcct(u); } break;
    case 'setpw': if (a && typeof m.pw === 'string' && m.pw.length >= 4 && m.pw.length <= 64) { a.salt = crypto.randomBytes(8).toString('hex'); a.hash = hashPw(m.pw, a.salt); for (const [t, v] of sessions) if (v === u && u !== ADMIN) sessions.delete(t); dirty = true; } break;
    case 'kick': if (a && u !== ADMIN) for (const c of [...wss.clients]) if (c.acct === u) { send(c, { t: 'announce', text: 'You were removed by the admin.' }); try { c.close(); } catch (e) {} } break;
    case 'delete': if (a && u !== ADMIN) { for (const c of [...wss.clients]) if (c.acct === u) { send(c, { t: 'announce', text: 'Your account was deleted by the admin.' }); try { c.close(); } catch (e) {} } for (const [t, v] of sessions) if (v === u) sessions.delete(t); delete ACC[u]; dirty = true; } break;
    case 'announce': { const text = String(m.text || '').slice(0, 120); if (text) bcast({ t: 'announce', text }); break; }
    case 'drain': if (!drained) forceDrain('z+'); break;
    case 'refill': refill(); break;
    case 'kid': if (!kidOn && !drained) kidEvent(); break;
    default: return;
  }
  adminList(ws);
}
function equip(ws, m) {
  const a = ws.acct && ACC[ws.acct]; if (!a) return; const lv = levelOf(a.xp), c = COSMETICS.find(x => x.id === m.id && x.slot === m.slot);
  if (m.id === null && ['hat', 'paint', 'trail', 'suit'].includes(m.slot)) delete a.eq[m.slot]; else if (c && lv.level >= c.lvl) a.eq[c.slot] = c.id; else return;
  dirty = true; send(ws, Object.assign({ t: 'prog' }, progOf(a)));
}
function giveXp(p, n) { if (!p.acct || !ACC[p.acct]) return; const a = ACC[p.acct]; a.xp += n; dirty = true; p.lv = levelOf(a.xp).level; send(p.ws, Object.assign({ t: 'prog' }, progOf(a))); }

const send = (ws, m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
const burst = p => bcast({ t: 'burst', p: [p.x, p.y + 1, p.z] });   // the death bubble-pop effect
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
const faceOpen = (axis, side) => drained && axis !== 1 && drainFace === (axis === 0 ? 'x' : 'z') + (side > 0 ? '+' : '-');   // the broken pane lets bullets out
function tankLimit(o, d, open) {                   // distance until the ray hits the glass, floor or surface (open = no ceiling, for squids)
  const lo = [-ARENA.x, 0, -ARENA.z], hi = [ARENA.x, ARENA.h, ARENA.z]; let t = 1e9;
  for (let i = 0; i < 3; i++) {
    if (d[i] > 1e-8) { if (!(open && i === 1) && !faceOpen(i, 1)) t = Math.min(t, (hi[i] - o[i]) / d[i]); }
    else if (d[i] < -1e-8) { if (!faceOpen(i, -1)) t = Math.min(t, (lo[i] - o[i]) / d[i]); }
  }
  return Math.max(0, t);
}

function spawn(p) {
  const [x, z] = SPAWNS[Math.floor(Math.random() * SPAWNS.length)];
  Object.assign(p, { x, y: 0, z, hp: 100, dead: false, reloadAt: 0, safe: Date.now() + 2000, boostAt: 0 });  // 2s spawn shield
  for (const k in WEAPONS) p.am[k] = WEAPONS[k].mag;
  send(p.ws, { t: 'spawn', x, y: 0, z });
}
function hurt(victim, att, dmg, head) {
  if (victim.dead || inter || Date.now() < victim.safe) return;
  victim.hp -= dmg; send(victim.ws, { t: 'hurt' });
  if (victim !== att) { send(att.ws, { t: 'hit', head }); victim.lastHit = { id: att.id, t: Date.now() }; }
  if (victim.hp <= 0) {
    victim.dead = true; victim.deaths++; burst(victim);
    if (victim !== att) { att.kills++; if (!att.dead) att.hp = 100; giveXp(att, 50 + (head ? 25 : 0)); }   // siphon: every kill refills your health
    bcast({ t: 'kill', k: att.name, v: victim.name, w: WEAPONS[att.w].name, head, self: victim === att });
    send(victim.ws, { t: 'dead', by: victim === att ? 'your own blast' : att.name, byId: victim === att ? 0 : att.id });
  }
}
function shoot(p, dir) {
  const W = WEAPONS[p.w], now = Date.now();
  if (p.dead || inter || p.reloadAt || now - p.last < W.rate) return;
  if (p.am[p.w] <= 0) { p.reloadAt = now + W.reload; return; }   // no auto-reload: pulling the trigger on an empty gun (or pressing R) starts it
  p.last = now; p.am[p.w]--;
  if (W.autoReload && p.am[p.w] === 0) p.reloadAt = now + W.reload;       // single-shot launcher reloads after every shot
  const o = [p.x, p.y + 1.7, p.z], outside = Math.abs(p.x) >= ARENA.x || Math.abs(p.z) >= ARENA.z;
  if (W.proj) return launch(p, W, o, dir);       // projectile weapons (the squid) fly instead of hitting instantly
  for (let i = 0; i < W.pellets; i++) {
    const d = norm(dir.map(v => v + (Math.random() - 0.5) * 2 * W.spread));
    let tMax = outside ? W.range : Math.min(W.range, tankLimit(o, d));
    for (const b of OBST) { if (b.thru) continue; const t = rayBox(o, d, b); if (t !== null && t < tMax) tMax = t; }   // coral is see-through for bullets
    let best = null, head = false;
    for (const q of players.values()) {
      if (q === p || q.dead) continue;
      let t = raySphere(o, d, [q.x, q.y + 1.72, q.z], 0.45);
      if (t !== null && t < tMax) { tMax = t; best = q; head = true; }
      t = raySphere(o, d, [q.x, q.y + 0.9, q.z], 0.7);
      if (t !== null && t < tMax) { tMax = t; best = q; head = false; }
    }
    const fh = fishHit(o, d, tMax); if (fh) { tMax = fh.t; best = null; }      // shoot a fish and it floats to the surface
    const kh = kidHit(o, d, tMax); if (kh) { tMax = kh.t; best = null; }
    if (!best && !fh && !kh && W.crack && !outside) { const gh = glassHit(o, d); if (gh && gh.t <= tMax + 1e-4) addCrack(gh, W.crack); }   // hit the glass: crack it
    const e = o.map((v, k) => v + d[k] * tMax);
    bcast({ t: 'shot', id: p.id, o, e, w: p.w });
    if (fh && !kh) killFish(fh.i);
    if (kh) hurtKid(p, W.dmg * (kh.head ? 1.5 : 1), kh.head);
    if (best) hurt(best, p, W.dmg * (head ? 1.5 : 1), head);
    if (W.splash) splash(p, W, e, best);
  }
}
function splash(p, W, e, skip) {                 // area damage that fades with distance
  for (const q of players.values()) {
    if (q === skip || q.dead) continue;               // the shooter is included: squid blasts hurt you too
    const dist = Math.hypot(q.x - e[0], q.y + 0.9 - e[1], q.z - e[2]);
    if (dist < W.splash) hurt(q, p, W.splashMin + (W.splashMax - W.splashMin) * (1 - dist / W.splash), false);   // 95 at the centre, 60 at the edge
  }
}
const projs = []; let nextPid = 1;
function launch(p, W, o, dir) {
  const d = norm(dir.map(v => v + (Math.random() - 0.5) * 2 * W.spread));
  const pr = { pid: nextPid++, p, W, pos: o.slice(), v: d.map(x => x * W.proj), left: W.range, ttl: 12 };
  projs.push(pr); bcast({ t: 'proj', pid: pr.pid, id: p.id, o, d, speed: W.proj, w: p.w });
}
const inTank = q => Math.abs(q[0]) < ARENA.x && Math.abs(q[2]) < ARENA.z && q[1] <= ARENA.h;
function stepProjs(dt) {                         // the tank is open on top: aim a squid up through the surface and it arcs out into the room
  for (let i = projs.length - 1; i >= 0; i--) {
    const pr = projs[i], W = pr.W, wasIn = inTank(pr.pos);
    if (!wasIn) pr.v[1] -= 18 * dt;                // out of the water: real gravity
    const sp = Math.hypot(...pr.v), d = pr.v.map(x => x / sp), len = sp * dt;
    let tMax = len, hit = null, head = false, hitWall = false, fishI = null;
    if (wasIn) {
      tMax = Math.min(tMax, tankLimit(pr.pos, d, true)); hitWall = tMax < len;
      for (const b of OBST) { if (b.thru) continue; const t = rayBox(pr.pos, d, b); if (t !== null && t < tMax) { tMax = t; hitWall = true; } }
      for (const q of players.values()) {
        if (q === pr.p || q.dead) continue;
        let t = raySphere(pr.pos, d, [q.x, q.y + 1.72, q.z], 0.6); if (t !== null && t < tMax) { tMax = t; hit = q; head = true; hitWall = false; }
        t = raySphere(pr.pos, d, [q.x, q.y + 0.9, q.z], 0.8); if (t !== null && t < tMax) { tMax = t; hit = q; head = false; hitWall = false; }
      }
      const fh = fishHit(pr.pos, d, tMax); if (fh) { tMax = fh.t; fishI = fh.i; hit = null; hitWall = true; }
    }
    const kh = kidHit(pr.pos, d, tMax); if (kh) { tMax = kh.t; hit = null; fishI = null; hitWall = true; }   // squids can hit the kid too
    if (wasIn && hit === null && fishI === null && !kh && W.crack && hitWall) { const gh = glassHit(pr.pos, d); if (gh && gh.t <= tMax + 1e-4) addCrack(gh, W.crack); }   // a squid smacking the glass makes a big crack
    const e = pr.pos.map((v, k) => v + d[k] * tMax);
    if (wasIn) pr.left -= tMax; else pr.ttl -= dt;
    let boom = !!hit || hitWall || pr.left <= 0.01 || pr.ttl <= 0;
    if (!wasIn) { const fl = Math.abs(e[0]) < ARENA.x + 6 && Math.abs(e[2]) < ARENA.z + 5 ? -0.2 : -16.5; if (e[1] <= fl) { e[1] = fl; boom = true; } }   // lands on the desk or the bedroom floor
    if (boom) {
      if (hit) hurt(hit, pr.p, W.dmg * (head ? 1.5 : 1), head);                 // a body hit is an instant kill
      if (fishI !== null) killFish(fishI);
      if (kh) hurtKid(pr.p, W.dmg * (kh.head ? 1.5 : 1), kh.head);
      splash(pr.p, W, e, hit); bcast({ t: 'pop', pid: pr.pid, e }); projs.splice(i, 1);
    } else { pr.pos = e; if (!wasIn && inTank(e)) pr.v = pr.v.map(x => x * 0.6); }   // splashes back into the water
  }
}
setInterval(() => stepProjs(0.033), 33);

wss.on('connection', ws => {
  ws.pid = nextId++;
  send(ws, { t: 'welcome', id: ws.pid, weapons: WEAPONS, obst: OBST, arena: ARENA, geysers: GEYSERS, fish: FISH, st: srvT(), cos: COSMETICS, drained, drainFace, cracks: CRACKS, match: { end: (matchEnd - T0) / 1000, inter, next: (interEnd - T0) / 1000 } });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    let p = players.get(ws.pid);
    if (m.t === 'auth') return auth(ws, m);
    if (m.t === 'logout') { ws.acct = null; return; }
    if (m.t === 'equip') return equip(ws, m);
    if (m.t === 'admin') return admin(ws, m);
    if (m.t === 'join') {                          // first dive, or a re-dive after being popped
      const w = WEAPONS[m.w] ? m.w : 'pistol', a = ws.acct ? ACC[ws.acct] : null, name = a ? a.user : String(m.name || 'Diver').slice(0, 14);
      const who = { name, w, acct: ws.acct || null, eq: a ? a.eq : {}, lv: a ? levelOf(a.xp).level : 0 };
      if (!p) { p = Object.assign({ id: ws.pid, ws, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hp: 100, am: {}, reloadAt: 0, last: 0, kills: 0, deaths: 0, dead: false, safe: 0, boostAt: 0, lastHit: null }, who); players.set(p.id, p); spawn(p); }
      else if (p.dead) { Object.assign(p, who); spawn(p); }
      return;
    }
    if (!p) return;
    if (m.t === 'state' && !p.dead && [m.x, m.y, m.z, m.yaw, m.pitch].every(Number.isFinite)) {
      let x0 = -ARENA.x + 0.5, x1 = ARENA.x - 0.5, z0 = -ARENA.z + 0.5, z1 = ARENA.z - 0.5, y0 = 0;
      if (drained) {                               // the broken side is open: you can climb out onto the desk (and fall off it)
        const fx = drainFace[0] === 'x', sg = drainFace[1] === '+' ? 1 : -1, out = fx ? sg * m.x > ARENA.x - 0.5 : sg * m.z > ARENA.z - 0.5; y0 = -16.5;
        if (fx) { if (sg > 0) x1 = 1e3; else x0 = -1e3; if (out) { z0 = -1e3; z1 = 1e3; } } else { if (sg > 0) z1 = 1e3; else z0 = -1e3; if (out) { x0 = -1e3; x1 = 1e3; } }
      }
      p.x = Math.max(x0, Math.min(x1, m.x)); p.z = Math.max(z0, Math.min(z1, m.z)); p.y = Math.max(y0, Math.min(ARENA.h - 2, m.y)); p.yaw = m.yaw; p.pitch = m.pitch;
      if (drained && p.y <= -16 && (Math.abs(p.x) > ARENA.x || Math.abs(p.z) > ARENA.z)) fallDeath(p);
    } else if (m.t === 'shoot' && Array.isArray(m.dir) && m.dir.length === 3 && m.dir.every(Number.isFinite)) shoot(p, norm(m.dir));
    else if (m.t === 'suicide' && !p.dead) { const la = p.lastHit && Date.now() - p.lastHit.t < 10000 && players.get(p.lastHit.id); p.safe = 0; hurt(p, la || p, 9999, false); }   // K: the last player to hit you gets the pop
    else if (m.t === 'boost' && !p.dead && !drained && Date.now() >= p.boostAt) { p.boostAt = Date.now() + WEAPONS[p.w].boost * 1000 - 300; bcast({ t: 'boost', id: p.id }); }
    else if (m.t === 'reload' && !p.reloadAt && p.am[p.w] < WEAPONS[p.w].mag) p.reloadAt = Date.now() + WEAPONS[p.w].reload;
  });
  ws.on('close', () => players.delete(ws.pid));
});

setInterval(() => {                                // 20 Hz world snapshot
  const now = Date.now();
  for (const p of players.values()) if (p.reloadAt && now >= p.reloadAt) { p.am[p.w] = WEAPONS[p.w].mag; p.reloadAt = 0; }
  const list = [...players.values()].map(p => ({ id: p.id, n: p.name, x: p.x, y: p.y, z: p.z, yw: p.yaw, pt: p.pitch, hp: p.hp, w: p.w, k: p.kills, d: p.deaths, dead: p.dead, lv: p.lv, c: p.eq, rl: !!p.reloadAt }));
  bcast({ t: 'snap', p: list });
  for (const p of players.values()) send(p.ws, { t: 'me', hp: p.hp, w: p.w, ammo: p.am[p.w], rel: !!p.reloadAt });
}, 50);

server.listen(process.env.PORT || 3000, () => console.log('Fishtank.io running on port ' + (process.env.PORT || 3000)));
