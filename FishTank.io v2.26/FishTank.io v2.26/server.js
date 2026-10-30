// Fishtank.io server: serves /public and runs the authoritative game state over WebSocket.
const express = require('express'), http = require('http'), fs = require('fs'), crypto = require('crypto'), { WebSocketServer } = require('ws');
const app = express();
const GOOGLE_ID = process.env.GOOGLE_CLIENT_ID || '', PAY = { key: process.env.STRIPE_SECRET_KEY || '', hook: process.env.STRIPE_WEBHOOK_SECRET || '', url: (process.env.PUBLIC_URL || '').replace(/\/$/, '') };
// Real money is only ever taken by Stripe's own checkout page; we never see card numbers. A payment adds sand dollars only when Stripe's signed webhook says it was paid.
const BUNDLES = { s1: { name: 'Handful of Sand Dollars', sd: 100, cents: 199 }, s2: { name: 'Pouch of Sand Dollars', sd: 550, cents: 999 }, s3: { name: 'Chest of Sand Dollars', sd: 1200, cents: 1999 } };
app.post('/api/stripe-webhook', express.raw({ type: '*/*' }), (req, res) => {
  if (!PAY.hook) return res.status(404).end();
  const sig = String(req.headers['stripe-signature'] || ''), parts = Object.fromEntries(sig.split(',').map(x => x.split('='))), body = req.body.toString('utf8');
  const want = crypto.createHmac('sha256', PAY.hook).update(parts.t + '.' + body).digest('hex');
  let ok = false; try { ok = parts.v1 && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(parts.v1)) && Math.abs(Date.now() / 1000 - Number(parts.t)) < 600; } catch (e) {}
  if (!ok) return res.status(400).end();
  let ev; try { ev = JSON.parse(body); } catch (e) { return res.status(400).end(); }
  if (ev.type === 'checkout.session.completed' && ev.data.object.payment_status === 'paid') {
    const o = ev.data.object, md = o.metadata || {}, b = BUNDLES[md.bundle];
    if (b && md.user) for (const r of rooms.values()) { if (r.grantSD(md.user, b.sd, o.id)) break; }
  }
  res.json({ received: true });
});
app.use(express.json());
app.post('/api/checkout', async (req, res) => {
  if (!PAY.key || !PAY.url) return res.status(503).json({ error: 'Payments are not set up on this server.' });
  const sess = sessions.get(String(req.body.token || '')), b = BUNDLES[req.body.bundle];
  if (!sess || !b) return res.status(400).json({ error: 'Log in first.' });
  const f = new URLSearchParams({ mode: 'payment', 'success_url': PAY.url + '/?paid=1', 'cancel_url': PAY.url + '/', 'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': String(b.cents), 'line_items[0][price_data][product_data][name]': b.name, 'metadata[user]': sess, 'metadata[bundle]': req.body.bundle });
  try { const r = await fetch('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { Authorization: 'Bearer ' + PAY.key, 'Content-Type': 'application/x-www-form-urlencoded' }, body: f }); const j = await r.json(); if (!r.ok) throw new Error('stripe'); res.json({ url: j.url }); }
  catch (e) { res.status(502).json({ error: 'Could not start checkout.' }); }
});
app.use(express.static(__dirname + '/public'));
const server = http.createServer(app), wss = new WebSocketServer({ server });

const ARENA_BED = { x: 36, z: 22, h: 18 };        // half-width, half-depth, height of the bedroom tank
const WEAPONS = {                                  // add new guns here; the client picks them up automatically
  pistol:   { name: 'Bubble Pistol',   dmg: 20, fall: 22, dmgMin: 8, pellets: 1, spread: 0.012, rate: 110,  mag: 14, reload: 1200, range: 60,  splash: 0,   boost: 2, crack: 1, color: 0x4fc3f7, len: 0.5 },
  puffer:   { name: 'Pufferfish SMG',  dmg: 10.5, pellets: 1, spread: 0.034, rate: 95,   mag: 25, reload: 1900, range: 30,  splash: 0,   boost: 4, crack: .5, auto: true, color: 0x2fd3c4, len: 0.45 },
  shotgun:  { name: 'Clam Shotgun',    dmg: 14, pellets: 8, spread: 0.10,  rate: 1000, mag: 4,  reload: 2200, range: 18,  splash: 0,   boost: 3, crack: .7, color: 0xff9ecb, len: 0.55 },
  squid:    { name: 'Squid Launcher',  dmg: 200, pellets: 1, spread: 0.004, rate: 700, mag: 1, reload: 2200, range: 60, splash: 6.5, splashMin: 80, splashMax: 125, autoReload: true, proj: 26, boost: 8, crack: 8, pad: true, color: 0xb39ddb, len: 0.7 },
  crab:     { name: 'Crabfish Burst Rifle', dmg: 13, pellets: 1, spread: 0.02, rate: 600, burst: 3, burstGap: 75, mag: 18, reload: 1900, range: 55, splash: 0, boost: 4, crack: .6, color: 0xff6b4a, len: 0.6 },   // quick three-round bursts, 13 damage each
  seahorse: { name: 'Seahorse Sniper', dmg: 80, pellets: 1, spread: 0,     rate: 1600, mag: 3,  reload: 2600, range: 110, splash: 0,   boost: 5, crack: 3, scope: 20, color: 0xffd23f, len: 0.9 },
  noodle:   { name: 'Pool Noodle',     dmg: 50, pellets: 1, spread: 0,     rate: 450,  mag: 99, reload: 0,    range: 3.8, splash: 0,   boost: 1.3, crack: 0, melee: true, color: 0x39d98a, len: 0.9 },   // flimsy green melee: 2 slaps pop a diver, dash cooldown is only 1 s
  longshot: { name: 'Anglerfish Longshot', dmg: 110, dmgMin: 45, charge: 1000, pellets: 1, spread: 0, rate: 500, mag: 3, reload: 2600, range: 140, splash: 0, boost: 6, crack: 4, rail: true, pad: true, color: 0x7df9ff, len: 0.95 },   // hold to charge from the angler bulb: tap = 30, full charge (1 s) = 90, shoots through every diver in line
  soaker:   { name: 'Super Soaker',    dmg: 8.5,  pellets: 1, spread: 0.05,  rate: 60,   mag: 150, reload: 3200, range: 38, splash: 0,   boost: 6, crack: .3, auto: true, spin: 450, pad: true, color: 0xff7043, len: 0.8 }   // minigun: spins up for 0.45 s before it fires
};
const PAD_MS = +process.env.PAD_MS || 60000, PADS = ['squid', 'longshot', 'soaker'];   // the castle pad swaps its gun every minute (set PAD_MS=90000 for 1:30)
const EMOTES = [];   // emotes were removed in FIX 16 (the list stays so old clients never crash)   // Fortnite-style dances; each level costs more XP than the last, so the top ones are a real grind
const TOWERS = [[-3.5, -3.5], [3.5, -3.5], [-3.5, 3.5], [3.5, 3.5]].map(([x, z]) => ({ x, z, w: 2, h: 6.4, d: 2, t: 'hidden' }));   // castle corner towers (flat battlement tops you can stand on)
const OBST_BED = [                                 // x,z = center, w/d = footprint, h = height (all sit on the gravel); t = look ('hidden' = collider only)
  { x: 0, z: 0, w: 9, h: 4.5, d: 9, t: 'castle', tun: { w: 2.6, h: 3 } }, ...TOWERS,   // the gate passage runs north-south straight through the castle
  { x: 0, z: -15, w: 12, h: 2, d: 3.5, t: 'ship' }, { x: 0, z: 15, w: 12, h: 2, d: 3.5, t: 'ship' },
  { x: -3.6, z: -15, w: 4.2, h: 3.6, d: 3.15, t: 'hidden' }, { x: -3.6, z: 15, w: 4.2, h: 3.6, d: 3.15, t: 'hidden' },   // ship cabins (walkable roofs)
  { x: 1.2, z: -15, w: 1.6, h: 8, d: 1.6, t: 'hidden' }, { x: 1.2, z: 15, w: 1.6, h: 8, d: 1.6, t: 'hidden' },             // masts + crow's nests (the very top of the ship)
  { x: 1.4, z: -15, w: .7, h: 6.5, d: 4, t: 'hidden' }, { x: 1.4, z: 15, w: .7, h: 6.5, d: 4, t: 'hidden' },                 // sails
  { x: -2, z: -17.05, w: .7, h: 1.9, d: 1.2, t: 'hidden' }, { x: 2, z: -17.05, w: .7, h: 1.9, d: 1.2, t: 'hidden' }, { x: -2, z: -12.95, w: .7, h: 1.9, d: 1.2, t: 'hidden' }, { x: 2, z: -12.95, w: .7, h: 1.9, d: 1.2, t: 'hidden' },   // cannons poking out of the hull
  { x: -2, z: 12.95, w: .7, h: 1.9, d: 1.2, t: 'hidden' }, { x: 2, z: 12.95, w: .7, h: 1.9, d: 1.2, t: 'hidden' }, { x: -2, z: 17.05, w: .7, h: 1.9, d: 1.2, t: 'hidden' }, { x: 2, z: 17.05, w: .7, h: 1.9, d: 1.2, t: 'hidden' },
  { x: -14, z: 8, w: 4, h: 2.2, d: 3, t: 'chest' }, { x: 14, z: -8, w: 4, h: 2.2, d: 3, t: 'chest' },
  { x: -10, z: -10, w: 4.2, h: 6, d: 4.2, t: 'coral' }, { x: 10, z: 10, w: 4.2, h: 6, d: 4.2, t: 'coral' },
  { x: -24, z: 12, w: 4.2, h: 5, d: 4.2, t: 'coral' }, { x: 24, z: -12, w: 4.2, h: 5, d: 4.2, t: 'coral' },
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
const GEYSERS_BED = [{ x: -18, z: -12 }, { x: 18, z: 12 }, { x: -9, z: 19 }, { x: 9, z: -19 }, { x: 30, z: 0 }, { x: -30, z: -6 }];   // bubble geysers launch you upward
const SPAWNS_BED = [[-32, -18], [32, 18], [-32, 18], [32, -18], [0, -19.5], [0, 19.5], [-19, 0], [19, 0]];

// ---------- maps: the arena (always a box, or a round bowl), its obstacles, geysers, spawns and the castle (where the special-gun pad sits) ----------
const OBST_KIT = [                               // a roomy bowl (radius 27.5): a castle, two chests, taller corals, a reef, and a ring of jellyfish up the glass
  { x: 0, z: 0, w: 22.4, h: 14, d: 10, t: 'rockery' },                    // the centrepiece: a stack of slate slabs on legs, with tunnels to swim through (the pad sits on the top slab)
  { x: -12, z: 10, w: 4, h: 2.2, d: 3, t: 'chest' }, { x: 12, z: -10, w: 4, h: 2.2, d: 3, t: 'chest' },
  { x: -10, z: -11, w: 4.2, h: 7.5, d: 4.2, t: 'coral' }, { x: 10, z: 11, w: 4.2, h: 6.5, d: 4.2, t: 'coral' },
  { x: -18, z: 7, w: 5.5, h: 8.5, d: 4.5, t: 'reef' }, { x: 18, z: -7, w: 5.5, h: 8.5, d: 4.5, t: 'reef' },       // the reef: a tall cluster of branches to hide behind
  { x: -21, z: -3, w: 3, h: 5, d: 5, t: 'rock' }, { x: 21, z: 3, w: 3, h: 5, d: 5, t: 'rock' },
  { x: -15, z: -16, w: 4, h: 2.2, d: 4, t: 'lego' }, { x: 15, z: 16, w: 4, h: 2.2, d: 4, t: 'lego' },
  { x: 6, z: -13, w: 3, h: 3.4, d: 3, t: 'marble' }, { x: -6, z: 13, w: 3, h: 3.4, d: 3, t: 'marble' },
  { x: -20, z: -10, w: 3.2, h: 1.5, d: 3.2, t: 'jelly' }, { x: -11, z: -21, w: 3, h: 3, d: 3, t: 'jelly' }, { x: 3, z: -23.5, w: 3, h: 4.5, d: 3, t: 'jelly' },
  { x: 20, z: 10, w: 3.2, h: 1.5, d: 3.2, t: 'jelly' }, { x: 11, z: 21, w: 3, h: 3, d: 3, t: 'jelly' }, { x: -3, z: 23.5, w: 3, h: 4.5, d: 3, t: 'jelly' }
];

// ---------- Pirates Cove: a sunken wreck in the middle (walk up the crates or bounce on a jellyfish to reach the deck), barrels, chests, broken masts and ribs for cover ----------
const OBST_PIR = [
  { x: 0, z: 0, w: 26, h: 4.5, d: 9, t: 'wreck', tun: { x: 2, w: 3.4, h: 3.2 } },   // a swim-through tunnel runs across the hull                                                                            // the hull; its deck is where the special-gun pad sits
  { x: -8.6, z: 0, w: 8, h: 8.2, d: 8.4, t: 'hidden' },                                                                      // stern castle (walkable roof)
  { x: 4.5, z: 0, w: 1.6, h: 13, d: 1.6, t: 'hidden' }, { x: 10.5, z: .5, w: 1.3, h: 8.5, d: 1.3, t: 'hidden' },               // broken main and fore masts
  { x: 15.5, z: 9, w: 15, h: 1.8, d: 1.8, t: 'mast' },                                                                       // a fallen mast
  { x: -18, z: -9.5, w: 9, h: 3.4, d: 2.2, t: 'ribs' }, { x: 20, z: -9, w: 7, h: 2.8, d: 2.2, t: 'ribs' },                    // hull ribs sticking out of the sand
  { x: -14.5, z: -6.6, w: 3, h: 1.8, d: 3, t: 'crate' }, { x: -11.2, z: -6.4, w: 3, h: 3.6, d: 3, t: 'crate' },              // stairs up to the deck
  { x: -15, z: 13, w: 4, h: 2.2, d: 3, t: 'chest' }, { x: 16, z: -15, w: 4, h: 2.2, d: 3, t: 'chest' },
  { x: -22, z: 7, w: 2.3, h: 2.7, d: 2.3, t: 'barrel' }, { x: -19.6, z: 8.3, w: 2.3, h: 2.7, d: 2.3, t: 'barrel' }, { x: -21, z: 10, w: 2.3, h: 2.7, d: 2.3, t: 'barrel' },
  { x: 23, z: 13, w: 2.3, h: 2.7, d: 2.3, t: 'barrel' }, { x: 25.2, z: 14.3, w: 2.3, h: 2.7, d: 2.3, t: 'barrel' }, { x: -4, z: -15.5, w: 2.3, h: 2.7, d: 2.3, t: 'barrel' }, { x: -1.6, z: -16.5, w: 2.3, h: 2.7, d: 2.3, t: 'barrel' },
  { x: 6, z: 17, w: 2.4, h: 4.8, d: 1.4, t: 'anchor' },
  { x: -27, z: -2, w: 4, h: 4, d: 6, t: 'rock' }, { x: 28, z: 3, w: 4, h: 4.6, d: 6, t: 'rock' }, { x: -8, z: 18.5, w: 5, h: 3, d: 4, t: 'rock' }, { x: 10, z: -18.5, w: 5, h: 3.4, d: 4, t: 'rock' }, { x: 31, z: -15, w: 4, h: 2.6, d: 4, t: 'rock' }, { x: -31, z: 16, w: 4, h: 2.6, d: 4, t: 'rock' },
  { x: -24, z: -15, w: 3.2, h: 1.4, d: 3.2, t: 'jelly' }, { x: 27, z: 8, w: 3.2, h: 1.4, d: 3.2, t: 'jelly' },
  { x: -23, z: -3, w: 2, h: 7, d: 2, t: 'kelp', nocol: true }, { x: 22, z: -3, w: 2, h: 8, d: 2, t: 'kelp', nocol: true }, { x: -7, z: 10, w: 2, h: 6, d: 2, t: 'kelp', nocol: true }, { x: 14, z: 13, w: 2, h: 7, d: 2, t: 'kelp', nocol: true }, { x: -30, z: 8, w: 2, h: 6, d: 2, t: 'kelp', nocol: true }, { x: 33, z: -8, w: 2, h: 7, d: 2, t: 'kelp', nocol: true },
  { x: -10, z: -16, w: 4.2, h: 5, d: 4.2, t: 'coral' }, { x: 4, z: 7, w: 4.2, h: 4.5, d: 4.2, t: 'coral' }
];
const GEYSERS_PIR = [{ x: -18, z: -14 }, { x: 18, z: 14 }, { x: -29, z: 8 }, { x: 29, z: -8 }];
const SPAWNS_PIR = [[-32, -18], [32, 18], [-33, 20.5], [32, -18], [0, -19.5], [0, 19.5], [-23, 2], [26, -2]];

// ---------- collision shapes: every prop is a handful of boxes that follow its real faces (part = [dx, dz, w, d, y0, h], relative to the prop's centre) ----------
// Props without parts are one plain box. nocol props (kelp, pirate coral) are decoration only: no walking into them, no bullets stopped.
const srand = (x, z) => { let q = (Math.round(x * 7 + 1000) * 7919 + Math.round(z * 13 + 1000) * 104729) >>> 0 || 1; return () => (q = (q * 1664525 + 1013904223) >>> 0) / 4294967296; };
function ell(cx, cy, cz, a, hb, c, lo = 0, n = 4) {      // an ellipsoid as n stacked boxes that sit inside the shape (a little smaller than it, never bigger)
  const out = [], ya0 = Math.max(cy - hb, lo), yb1 = cy + hb; if (yb1 - ya0 < .1) return out;
  for (let i = 0; i < n; i++) {
    const ya = ya0 + (yb1 - ya0) * i / n, yb = ya0 + (yb1 - ya0) * (i + 1) / n, mid = (ya + yb) / 2, far = Math.abs(ya - cy) > Math.abs(yb - cy) ? ya : yb, ref = mid + (far - mid) * .5;
    const k = Math.sqrt(Math.max(0, 1 - ((ref - cy) / hb) ** 2)); if (k < .12) continue;
    out.push([cx, cz, Math.max(.3, 1.7 * a * k), Math.max(.3, 1.7 * c * k), +ya.toFixed(2), +yb.toFixed(2)]);
  }
  return out;
}
function rockBlobs(b) {                          // three overlapping boulders along the long side; the client draws exactly these
  const long = b.d >= b.w, L = long ? b.d : b.w, S = long ? b.w : b.d;
  return [[0, 1], [L * .24, .75], [-L * .24, .7]].map(([o, k]) => { const cy = b.h * k * .45; return long ? [0, cy, o, S * .47, b.h * k * .6, L * .26] : [o, cy, 0, L * .26, b.h * k * .6, S * .47]; });
}
function genRockery() {                         // kitchen centrepiece, built from the slate rock-stack photo: legs, bridges and stacked slabs with tunnels between them. The boxes ARE the rock slabs, so hit boxes match what you see.
  const RK = [                                    // [x0, x1, y0, y1, z0, z1]
    [-11, -6.4, 0, 1.3, -3.6, 3.0], [5.6, 11.2, 0, 1.5, -3.8, 3.6],                               // low plates at both ends
    [-6.2, -2.4, 0, 3.0, -3.0, 3.0], [-8.4, -2.2, 3.0, 5.0, -4.0, 3.8],                           // left leg + overhanging shelf
    [0.2, 2.2, 0, 1.6, -2.6, 2.8], [-0.3, 2.8, 1.6, 3.4, -3.0, 3.2], [-0.6, 3.1, 3.4, 5.0, -3.4, 3.4],   // centre pillar, narrow foot widening upward
    [5.8, 9.6, 1.5, 3.2, -3.0, 3.0], [5.2, 10.4, 3.2, 5.0, -3.4, 3.3],                           // right leg group
    [-4.8, 9.4, 5.0, 6.9, -4.6, 4.6],                                                              // the long bridge slab
    [-7.6, -5.2, 5.0, 6.6, -2.8, 2.6], [-8.2, -2.8, 6.6, 8.0, -3.8, 3.6],                         // upper-left shelf
    [-4.2, -1.0, 6.9, 9.5, -3.2, 3.2], [1.8, 6.6, 6.9, 9.5, -3.4, 3.4],                           // two upper legs with a swim-through gap
    [-4.6, 5.4, 9.5, 11.2, -4.4, 4.4], [-5.6, 5.6, 11.2, 12.4, -4.8, 4.8],                       // third and fourth slabs
    [-6.4, 5.4, 12.4, 14.0, -5.0, 5.0]                                                             // the top slab: the pad sits here
  ];
  return RK.map(([x0, x1, y0, y1, z0, z1]) => [+((x0 + x1) / 2).toFixed(2), +((z0 + z1) / 2).toFixed(2), +(x1 - x0).toFixed(2), +(z1 - z0).toFixed(2), y0, y1]);
}
function genParts(b) {
  const w = b.w, h = b.h, d = b.d;
  switch (b.t) {
    case 'rock': b.blobs = rockBlobs(b); b.parts = b.blobs.flatMap(([cx, cy, cz, a, hb, c]) => ell(cx, cy, cz, a * .9, hb * .9, c * .9, 0, 4)); break;
    case 'shell': b.parts = ell(0, 0, 0, w / 2 * .95, h, d / 2 * .95, 0, 4); break;
    case 'marble': b.parts = ell(0, w / 2, 0, w / 2, w / 2, w / 2, 0, 5); break;
    case 'jelly': b.parts = ell(0, h * .4, 0, w / 2, h * .6, d / 2, h * .4, 4); break;
    case 'pillar': b.parts = [[0, 0, w * .98, d * .98, 0, .6], [0, 0, w * .62, d * .62, .6, h - .6], [0, 0, w * .98, d * .98, h - .6, h]]; break;
    case 'chest': { const bh = h * .5, o = [[0, 0, w, d, 0, bh]]; for (let i = 0; i < 3; i++) { const ya = bh + (h - bh) * i / 3, yb = bh + (h - bh) * (i + 1) / 3, ref = ya + (yb - ya) * .6, k = Math.sqrt(Math.max(0, 1 - ((ref - bh) / (h - bh)) ** 2)); o.push([0, 0, w * .95, +(d * .95 * k).toFixed(2), +ya.toFixed(2), +yb.toFixed(2)]); } b.parts = o; break; }
    case 'coral': b.parts = [[0, 0, +(w * .7).toFixed(2), +(w * .7).toFixed(2), 0, +(h * .3).toFixed(2)]]; break;   // only the rocky base is solid: branches are for looking at
    case 'reef': {
      const R = srand(b.x, b.z), a0 = R() * 6.283, br = []; for (let i = 0; i < 7; i++) br.push([+(i / 7 * 6.283 + a0).toFixed(3), i ? +(Math.min(w, d) * .27).toFixed(2) : 0, +(h * (i ? .55 + R() * .3 : .95)).toFixed(2), i % 5, i % 2]);   // [angle, radius from the middle, length, colour, has a plate]
      b.br = br; const P = ell(0, h * .09, 0, w * .5 * .9, h * .16 * .9, d * .5 * .9, 0, 2);
      for (const [a, r, len, , pl] of br) { const bx = Math.cos(a) * r, bz = Math.sin(a) * r; P.push([+bx.toFixed(2), +bz.toFixed(2), .62, .62, h * .1, +(len * .98).toFixed(2)]); if (pl) P.push([+bx.toFixed(2), +bz.toFixed(2), 2, 2, +(len * .55 - .1).toFixed(2), +(len * .55 + .1).toFixed(2)]); }
      b.parts = P; break; }
    case 'ship': { const o = [[-1.5, 0, 9, d, 0, h]]; [[3.5, 1, .667], [4.5, 1, .333], [5.35, .7, .1]].forEach(([dx, ww, f]) => o.push([dx, 0, ww, Math.max(.3, +(d * f).toFixed(2)), 0, h])); b.parts = o; break; }
    case 'wreck': { const t = b.tun, hw = w / 2, o = []; const x0 = t.x - t.w / 2, x1 = t.x + t.w / 2;
      o.push([+((-hw + x0) / 2).toFixed(2), 0, +(x0 + hw).toFixed(2), d, 0, h]); o.push([t.x, 0, t.w, d, t.h, h]);               // stern block, roof over the tunnel
      o.push([+((x1 + hw - 4) / 2).toFixed(2), 0, +(hw - 4 - x1).toFixed(2), d, 0, h]);                                           // midship block
      [[hw - 4, hw - 3, .75], [hw - 3, hw - 2, .5], [hw - 2, hw - 1, .25], [hw - 1, hw - .2, .08]].forEach(([xa, xb, f]) => o.push([+((xa + xb) / 2).toFixed(2), 0, +(xb - xa).toFixed(2), Math.max(.3, +(d * f).toFixed(2)), 0, h]));   // the tapering bow
      b.parts = o; break; }
    case 'castle': { const t = b.tun, sd = (w - t.w) / 2; b.parts = [[-(t.w / 2 + sd / 2), 0, sd, d, 0, h], [t.w / 2 + sd / 2, 0, sd, d, 0, h], [0, 0, t.w, d, t.h, h]]; break; }
    case 'rockery': b.parts = genRockery(); break;
    case 'ribs': { const n = Math.max(3, Math.round(w / 1.8)), o = []; for (let i = 0; i < n; i++) { const x = +((i - (n - 1) / 2) * (w / n)).toFixed(2), k = .8 + ((i * 5) % 3) * .1, zz = +(d / 2 * .96).toFixed(2); [-1, 1].forEach(sd => o.push([x, sd * zz, .45, .5, 0, +(h * k * .6).toFixed(2)])); o.push([x, 0, .4, +(d * .55).toFixed(2), +(h * k * .88).toFixed(2), +(h * k).toFixed(2)]); }
      o.push([0, 0, w, .3, +(h * .78 - .15).toFixed(2), +(h * .78 + .15).toFixed(2)]); o.push([0, +(d * .34).toFixed(2), w, .28, +(h * .38 - .14).toFixed(2), +(h * .38 + .14).toFixed(2)]); b.parts = o; break; }
    case 'barrel': b.parts = [[0, 0, +(w * .84).toFixed(2), +(w * .84).toFixed(2), 0, h]]; break;
    case 'anchor': b.parts = [[0, 0, .6, .6, 0, +(h * .97).toFixed(2)], [0, 0, +(w * .7).toFixed(2), .5, +(h * .78).toFixed(2), +(h * .98).toFixed(2)], [0, 0, +(w * .8).toFixed(2), .6, 0, +(h * .2).toFixed(2)]]; break;
    case 'mast': b.parts = [[0, 0, +(w * .96).toFixed(2), 1.5, .05, 1.85]]; break;
  }
}
const colsOf = list => { const out = []; for (const b of list) { if (b.nocol || b.thru) continue; for (const p of b.parts || [[0, 0, b.w, b.d, 0, b.h]]) out.push({ x: b.x + p[0], z: b.z + p[1], w: p[2], d: p[3], y0: p[4], h: p[5], t: b.t }); } return out; };

const ring = (r, n, off) => Array.from({ length: n }, (_, i) => [+(r * Math.cos(off + i / n * 6.2832)).toFixed(1), +(r * Math.sin(off + i / n * 6.2832)).toFixed(1)]);
const MAPS = {
  bedroom: { name: 'The Bedroom Tank', arena: ARENA_BED, obst: OBST_BED, geysers: GEYSERS_BED, spawns: SPAWNS_BED, hill: { x: 0, z: 0, hw: 3.4, hd: 3.4, y: 4.3, name: 'the castle' }, glass: true, kid: true },
  kitchen: { name: 'The Kitchen Fish Bowl', arena: { x: 27.5, z: 27.5, h: 23, round: true }, obst: OBST_KIT, geysers: [{ x: -14, z: -2 }, { x: 14, z: 2 }], spawns: ring(24.5, 8, .38), hill: { x: 0, z: 0, hw: 3.4, hd: 3.4, y: 4.3, py: 14, name: 'the top of the rocks' }, glass: true, kid: false, cat: true }
};
MAPS.pirate = { name: 'Pirates Cove', arena: ARENA_BED, obst: OBST_PIR, geysers: GEYSERS_PIR, spawns: SPAWNS_PIR, hill: { x: 0, z: 0, hw: 3.4, hd: 3.4, y: 4.3, name: 'the ship deck' }, glass: true, kid: false };
MAPS.night = Object.assign({}, MAPS.bedroom, { name: 'The Bedroom Tank at Night', kid: false, night: true });   // a carbon copy of the bedroom, lights out, the kid asleep in bed (no kid event)
[OBST_BED, OBST_KIT, OBST_PIR].forEach(l => l.forEach(genParts));
// ---------- shared by every room: the account database and login sessions ----------
const DB = __dirname + '/data/accounts.json'; let ACC = {}, dirty = false;
try { ACC = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch {}
setInterval(() => { if (!dirty) return; dirty = false; try { fs.mkdirSync(__dirname + '/data', { recursive: true }); fs.writeFileSync(DB, JSON.stringify(ACC)); } catch (e) { console.log('save failed', e.message); } }, 5000);
const sessions = new Map(), hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
let nextId = 1;
const MAX_PLAYERS = 12, PUBLIC_ROOMS = 4, rooms = new Map();

// ---------- one game room: everything below is a separate world (players, fish, match, tank glass, votes) ----------
function makeRoom(code, pub) {
  const clients = new Set(), timers = [];
  const setInterval = (f, ms) => { const h = global.setInterval(f, ms); timers.push(h); return h; };
  const roomInfo = () => ({ code, pub, name: pub ? 'Tank ' + code.slice(1) : 'Private ' + code, n: players.size, max: MAX_PLAYERS });
  let MAPID = 'bedroom', MAP = MAPS.bedroom, ARENA = MAP.arena, OBST = MAP.obst, COLS = colsOf(OBST), GEYSERS = MAP.geysers, SPAWNS = MAP.spawns, HILL = MAP.hill;
  const mapPayload = () => ({ id: MAPID, name: MAP.name, arena: ARENA, obst: OBST, geysers: GEYSERS, pad: SETGUNS() ? null : { x: HILL.x, z: HILL.z, y: HILL.py || 4.5 }, glass: MAP.glass, kid: MAP.kid, cat: !!MAP.cat, night: !!MAP.night });
  function setMap(id) { MAPID = id; MAP = MAPS[id]; ARENA = MAP.arena; OBST = MAP.obst; COLS = colsOf(OBST); GEYSERS = MAP.geysers; SPAWNS = MAP.spawns; HILL = MAP.hill; }
  const outsideXZ = (x, z) => ARENA.round ? Math.hypot(x, z) >= ARENA.x : Math.abs(x) >= ARENA.x || Math.abs(z) >= ARENA.z;
  const onPad = p => Math.abs(p.x - HILL.x) < 1.9 && Math.abs(p.z - HILL.z) < 1.9 && Math.abs(p.y - (HILL.py || 4.5)) < 1.6;
  const players = new Map();
  const rnd = (a, b) => a + Math.random() * (b - a), T0 = Date.now(), srvT = () => (Date.now() - T0) / 1000;
  
  // ----- decorative fish are real targets: shoot them all and the kid comes in -----
  const FISH = [];
  function newFish() { FISH.length = 0; for (let s = 0; s < 3; s++) for (let k = 0; k < 5; k++) FISH.push({ cx: rnd(-ARENA.x * .2, ARENA.x * .2), cz: rnd(-ARENA.z * .2, ARENA.z * .2), rx: ARENA.x * .7 - s * 4, rz: ARENA.z * .65 - s * 3, y: 4 + s * 3, sp: .02 + s * .005, ph: k * .35 + s * 2, s, dead: false }); }
  const fishPos = (f, t) => { const a = t * f.sp * 6.283 + f.ph; return [f.cx + Math.cos(a) * f.rx, f.y + Math.sin(a * 2) * .8, f.cz + Math.sin(a) * f.rz]; };
  function fishHit(o, d, tMax) {
    let best = null; const t0 = srvT();
    FISH.forEach((f, i) => { if (f.dead) return; const t = raySphere(o, d, fishPos(f, t0), .8); if (t !== null && t < tMax) { tMax = t; best = i; } });
    return best === null ? null : { i: best, t: tMax };
  }
  function killFish(i, by) { const f = FISH[i]; if (!f || f.dead) return; f.dead = true; bcast({ t: 'fish', i, p: fishPos(f, srvT()) }); if (FISH.every(x => x.dead)) { if (by) stat(by, 'fish_last'); if (MAP.kid) { kidEvent(); if (by) stat(by, 'kid'); } else if (MAP.cat) { catEvent(); if (by) stat(by, 'cat'); } } }
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
    if (kidOn || JUG.on) return; kidOn = true; kidKO = false; kidHp = 200; kidStart = Date.now(); bcast({ t: 'kid' });
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
  const MATCH_MS = +process.env.MATCH_MS || 8 * 60 * 1000, INTER_MS = +process.env.INTER_MS || 20000; let matchEnd = Date.now() + MATCH_MS, inter = false, interEnd = 0, refillT = null, drainFace = 'z+', FACETALLY = {};       // tune: total crack size that bursts the tank, and how long until it is refilled
  const FACE4 = ['z+', 'x+', 'z-', 'x-'], wrapA = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  function roundFace(x, z) { const ph = Math.atan2(x, z), k = ((Math.round(ph / (Math.PI / 2)) % 4) + 4) % 4; return { face: FACE4[k], u: ARENA.x * wrapA(ph - k * Math.PI / 2) }; }   // the bowl glass is four curved panes: z+ (towards +z), x+, z-, x-; u = arc length from the middle of the pane
  function glassHit(o, d) {                        // first side wall a ray hits (floor and surface don't crack); face = x+ x- z+ z-, u = along the wall, v = height
    if (ARENA.round) {
      const R = ARENA.x, A = d[0] * d[0] + d[2] * d[2]; if (A < 1e-10) return null; const B = o[0] * d[0] + o[2] * d[2], Cc = o[0] * o[0] + o[2] * o[2] - R * R, disc = B * B - A * Cc; if (disc < 0) return null;
      const t = (-B + Math.sqrt(disc)) / A; if (t <= 0) return null; const y = o[1] + d[1] * t; if (y < 0 || y > ARENA.h) return null;
      const rf = roundFace(o[0] + d[0] * t, o[2] + d[2] * t); return { t, face: rf.face, u: rf.u, v: y };
    }
    let best = null;
    for (const [axis, side] of [[0, 1], [0, -1], [2, 1], [2, -1]]) {
      if (Math.abs(d[axis]) < 1e-8) continue; const lim = (axis === 0 ? ARENA.x : ARENA.z) * side, t = (lim - o[axis]) / d[axis]; if (t <= 0) continue;
      const y = o[1] + d[1] * t, other = axis === 0 ? o[2] + d[2] * t : o[0] + d[0] * t, span = axis === 0 ? ARENA.z : ARENA.x;
      if (y < 0 || y > ARENA.h || Math.abs(other) > span) continue;
      if (!best || t < best.t) best = { t, face: (axis === 0 ? 'x' : 'z') + (side > 0 ? '+' : '-'), u: other, v: y };
    }
    return best;
  }
  function addCrack(gh, size, by, weight) {
    if (drained || !gh || !size || !MAP.glass) return;
    const c = { face: gh.face, u: +gh.u.toFixed(2), v: +gh.v.toFixed(2), s: size }; CRACKS.push(c); crackTotal += weight || size; FACETALLY[gh.face] = (FACETALLY[gh.face] || 0) + (weight || size); bcast(Object.assign({ t: 'crack' }, c));
    if (crackTotal >= CRACK_BREAK) { drain(); if (by) stat(by, 'glass'); }
  }
  function drain() {                               // the tank bursts: the water and every fish pour out into the room, then the match carries on in a dry tank
    drained = true; drainFace = Object.keys(FACETALLY).sort((a, b) => FACETALLY[b] - FACETALLY[a])[0] || 'z+'; for (const f of FISH) f.dead = true; bcast({ t: 'drain', face: drainFace }); clearTimeout(refillT); refillT = setTimeout(refill, REFILL_MS);
  }
  function forceDrain(face) { if (drained || !MAP.glass) return; FACETALLY[face] = (FACETALLY[face] || 0) + 1e5; crackTotal = Math.max(crackTotal, CRACK_BREAK); drain(); }
  function refill() {
    if (!drained || !MAP.glass) return; clearTimeout(refillT); drained = false; CRACKS = []; crackTotal = 0; FACETALLY = {}; newFish(); bcast({ t: 'refill', fish: FISH });
    for (const p of players.values()) p.out = false;
    for (const p of players.values()) if (!p.dead && outsideXZ(p.x, p.z)) { const [x, z] = SPAWNS[Math.floor(Math.random() * SPAWNS.length)]; p.x = x; p.y = 0; p.z = z; send(p.ws, { t: 'tp', x, y: 0, z }); }   // anyone still out on the desk gets put back in
  }
  function fallDeath(p) {                          // jumped off the table and hit the bedroom floor
    if (p.dead) return; p.dead = true; p.deaths++; burst(p); bcast({ t: 'kill', k: p.name, v: p.name, w: 'a big fall', self: true }); send(p.ws, { t: 'dead', by: MAPID === 'kitchen' ? 'the kitchen floor' : 'the bedroom floor', byId: 0 }); p.streak = 0; stat(p, 'falls');
    if (JUG.on) { if (p.id === JUG.id) jugEnd('players'); else jugCheck(); }
  }
  const scoreOf = p => p.kills;
  function endMatch() {                            // 8:00 matches repeat forever: short results screen with a map + mode vote, then the winning pair
    if (inter) return; if (JUG.on) { const jp = players.get(JUG.id); JUG.on = false; if (jp) { jp.jug = false; jp.hp = Math.min(jp.hp, 100); } }
    inter = true; interEnd = Date.now() + INTER_MS; const all = [...players.values()]; catStop(); VOTES.clear();
    const endMode = MODE, gg = endMode === 'gungame';
    const sorted = all.sort((a, b) => gg ? ggScore(b) - ggScore(a) || a.deaths - b.deaths : a.kills === b.kills ? a.deaths - b.deaths : b.kills - a.kills);
    const board = sorted.map(p => ({ n: p.name, k: p.kills, d: p.deaths, sc: gg ? Math.min(GG.length, p.gl | 0) + (p === GGWIN ? 1 : 0) : p.kills, tm: endMode === 'tdm' ? (p.team | 0) : -1, id: p.id })).slice(0, 8), top = sorted[0];
    let winTeam = -1;
    if (endMode === 'tdm') { winTeam = TEAMK[0] === TEAMK[1] ? -1 : TEAMK[0] > TEAMK[1] ? 0 : 1; if (winTeam >= 0) for (const q of all) if ((q.team | 0) === winTeam) { giveXp(q, 100); stat(q, 'wins'); } }
    else if (top && (gg ? ggScore(top) > 0 : top.kills > 0)) { giveXp(top, 100); stat(top, 'wins'); }   // winner bonus
    for (const q of all) stat(q, 'matches');
    FORCED_MAP = !!(FORCE.map && MAPS[FORCE.map]);
    NEXTMAP = FORCED_MAP ? FORCE.map : ({ bedroom: 'kitchen', kitchen: 'night', night: 'pirate', pirate: 'bedroom' }[MAPID] || 'bedroom'); FORCE.map = null;
    VOTEOPTS = { maps: pick3(Object.keys(MAPS), NEXTMAP), modes: pick3(Object.keys(MODES)) };
    bcast({ t: 'matchend', board, mode: endMode, teams: TEAMK.slice(), winTeam, ggWin: GGWIN ? GGWIN.name : null, next: (interEnd - T0) / 1000, nextMap: MAPS[NEXTMAP].name, forced: FORCED_MAP,
      opts: voteOpts() });
    bcast(voteMsg());
  }
  let NEXTMAP = 'kitchen'; const FORCE = {};
  function startMatch() {
    if (kidOn) { kidTimers.forEach(clearTimeout); kidTimers = []; kidOn = false; kidKO = false; }
    catStop(); catCool = 0; { const v = resolveVotes(); NEXTMAP = v.map; NEXTMODE = v.mode; } VOTES.clear(); MODE = NEXTMODE; GGWIN = null; JUG.on = false; assignTeams();
    const changed = NEXTMAP !== MAPID; if (changed) setMap(NEXTMAP);
    inter = false; matchEnd = Date.now() + MATCH_MS * (MODE === 'gungame' ? 1.25 : 1);   // gun game gets 10 minutes
    clearTimeout(refillT); drained = false; CRACKS = []; crackTotal = 0; FACETALLY = {}; newFish();
    for (const p of players.values()) { p.kills = 0; p.deaths = 0; p.sc = 0; p.gl = 0; p.gk = 0; p.streak = 0; p.jug = false; p.lastHit = null; if (!p.dead) spawn(p); }
    PAD.taken = false; PAD.at = Date.now() + PAD_MS; PAD.i = 0; PAD.w = PADS[0];
    bcast({ t: 'map', map: Object.assign(mapPayload(), { fish: FISH }) });
    bcast({ t: 'matchstart', end: (matchEnd - T0) / 1000, fish: FISH, map: MAPID, mode: MODE, modeName: MODES[MODE].name, gg: GG }); bcast(padMsg());
  }
  // ----- the special-gun pad on top of the castle: one gun at a time (squid launcher, anglerfish longshot, super soaker), swapped on a timer -----
  const PAD = { w: PADS[0], taken: false, at: Date.now() + PAD_MS, i: 0 };
  const padMsg = () => SETGUNS() ? { t: 'pad', off: true } : { t: 'pad', w: PAD.w, taken: PAD.taken, next: (PAD.at - T0) / 1000 };
  function giveSpecial(p, id) { if (!p.sp) p.base = p.w; p.sp = id; p.w = id; p.am[id] = WEAPONS[id].mag; p.reloadAt = 0; p.chStart = 0; send(p.ws, { t: 'got', w: id }); }
  // ----- the family cat (kitchen): shoot every fish in the bowl and the cat comes to swat it off the counter: gravity tips, the bowl falls, everybody pops, nobody scores, everyone respawns -----
  let catOn = false, catCool = 0, catTimers = [], catVictims = [];
  function catEvent() {
    if (catOn || !MAP.cat || inter || JUG.on || drained || Date.now() < catCool) return; catOn = true; catVictims = [];
    for (const [s, ms] of [['flick', 0], ['stare', 2600], ['tap', 5600], ['tap', 7200], ['swat', 9000], ['fall', 9600], ['smash', 14400]]) catTimers.push(setTimeout(() => bcast({ t: 'cat', s }), ms));
    catTimers.push(setTimeout(catPop, 14400), setTimeout(catRespawn, 18000));
  }
  function catPop() {                              // no kill credit, no deaths counted
    for (const q of players.values()) if (!q.dead) { q.dead = true; catVictims.push(q); burst(q); send(q.ws, { t: 'dead', by: 'the cat', byId: 0, auto: true }); }
    bcast({ t: 'kill', k: 'The cat', v: 'everyone', w: 'a big swat', self: false });
  }
  function catRespawn() { for (const q of catVictims) if (players.get(q.id) === q && q.dead) spawn(q); catVictims = []; newFish(); bcast({ t: 'fishreset', fish: FISH }); catEnd(); }
  function catEnd() { catOn = false; catCool = Date.now() + 180000; bcast({ t: 'cat', s: 'end' }); }
  function catStop() { catTimers.forEach(clearTimeout); catTimers = []; catVictims = []; if (catOn) { catOn = false; bcast({ t: 'cat', s: 'end' }); } }
  setInterval(() => {                              // 10 Hz: pad swap + pickups
    if (inter || SETGUNS()) return; const now = Date.now();
    if (now >= PAD.at) { PAD.i = (PAD.i + 1) % PADS.length; PAD.w = PADS[PAD.i]; PAD.taken = false; PAD.at = now + PAD_MS; bcast(padMsg()); }
    if (!PAD.taken) for (const p of players.values()) if (!p.dead && !p.sp && onPad(p)) { PAD.taken = true; giveSpecial(p, PAD.w); bcast(padMsg()); break; }
  }, 100);
  setInterval(() => { const now = Date.now(); if (!inter && JUG.on && now - JUG.t0 > JUG_MAX_MS) jugEnd('jug'); else if (!inter && !JUG.on && now >= matchEnd) endMatch(); else if (inter && now >= interEnd) startMatch(); }, 500);
  
  // ----- accounts, XP and cosmetics (saved to data/accounts.json; on free hosts without a disk this resets on redeploy) -----
  const levelCost = L => Math.round(80 + 6 * Math.pow(L, 1.4));    // XP from level L to L+1: gets steadily harder (tune here)
  function levelOf(xp) { let L = 1, need = levelCost(1); while (L < 100 && xp >= need) { xp -= need; L++; need = levelCost(L); } return { level: L, into: L >= 100 ? 0 : xp, need: L >= 100 ? 0 : need }; }
  // rarity: default (grey), common (green), rare (blue), epic (purple), legendary (yellow). Price in sand dollars follows the rarity. lvl / quest = free unlock; shop = buy-only
  const RARITY = { common: 100, rare: 250, epic: 600, legendary: 1500 };
  const COSMETICS = [
    { id: 'duck', name: 'Rubber Duck Buddy', slot: 'hat', lvl: 5, rarity: 'common' }, { id: 'mustache', name: 'Handlebar Mustache', slot: 'face', lvl: 8, rarity: 'common' },
    { id: 'mullet', name: 'Rad Mullet', slot: 'hair', lvl: 10, rarity: 'rare' }, { id: 'cape', name: 'Royal Cape', slot: 'back', lvl: 14, rarity: 'rare' },
    { id: 'wizard', name: 'Deep Sea Wizard Hat', slot: 'hat', lvl: 15, rarity: 'rare' }, { id: 'clown', name: 'Clownfish Paint', slot: 'paint', lvl: 15, rarity: 'rare' },
    { id: 'googly', name: 'Googly Eyes', slot: 'face', lvl: 18, rarity: 'common' }, { id: 'pirate', name: 'Pirate Captain Hat', slot: 'hat', lvl: 25, rarity: 'epic' },
    { id: 'mohawk', name: 'Neon Mohawk', slot: 'hair', lvl: 30, rarity: 'epic' }, { id: 'pearl', name: 'Pearl Bubble Trail', slot: 'trail', lvl: 35, rarity: 'epic' },
    { id: 'shark', name: 'Shark Grin', slot: 'face', lvl: 40, rarity: 'epic' }, { id: 'scales', name: 'Mermaid Scale Suit', slot: 'suit', lvl: 65, rarity: 'legendary' },
    { id: 'rainbow', name: 'Rainbow Bubble Trail', slot: 'trail', lvl: 75, rarity: 'legendary' }, { id: 'narwhal', name: 'Narwhal Horn', slot: 'hat', lvl: 90, rarity: 'legendary' },
    { id: 'golden', name: 'THE GOLDEN DIVER', slot: 'suit', lvl: 100, rarity: 'legendary' },
    { id: 'jelly', name: 'Jellyfish Hat', slot: 'hat', quest: 'm_head25', rarity: 'epic' }, { id: 'mermaid', name: 'Mermaid Locks', slot: 'hair', quest: 'm_win5', rarity: 'legendary' },
    { id: 'jet', name: 'Bubble Jet Pack', slot: 'back', quest: 'm_play240', rarity: 'legendary' },
    { id: 'cowboy', name: 'Deep Sea Cowboy Hat', slot: 'hat', shop: true, rarity: 'legendary' }
  ];
  // one legendary skin per gun (slot g_<gun>); the models are built on the client
  const SKINS = [['pistol', 'pistol_kraken', 'Kraken Flintlock'], ['puffer', 'puffer_lion', 'Lionfish Gatling'], ['shotgun', 'shotgun_dragon', "Dragon's Breath"], ['squid', 'squid_abyss', 'Abyssal Kraken'], ['crab', 'crab_king', 'King Crab Royale'], ['seahorse', 'seahorse_ghost', 'Ghost Seahorse'], ['noodle', 'noodle_neon', 'Neon Saber'], ['longshot', 'longshot_lantern', 'Lantern of the Deep'], ['soaker', 'soaker_poseidon', "Poseidon's Cannon"]]
    .map(([gun, id, name]) => ({ id, name, slot: 'g_' + gun, gun, rarity: 'legendary', shop: true }));
  const ITEMS = [...COSMETICS, ...SKINS], ITEM = new Map(ITEMS.map(c => [c.id, c])), priceOf = c => RARITY[c.rarity] || 0;
  const SD_DAILY = 8, SD_ALL3 = 10;                 // sand dollars are scarce: 8 per daily quest, +10 for all three
  const COLORS = ['brass', 'green', 'blue', 'red'];     // preset diver colours, everybody has all four (brass is the default)
  const SLOTS = ['hat', 'paint', 'trail', 'suit', 'hair', 'face', 'back', 'color', ...SKINS.map(k => k.slot)];
  const unlocked = (a, c) => !!(a.own && a.own[c.id]) || (!c.shop && (c.quest ? !!(a.qd && a.qd[c.quest]) : levelOf(a.xp).level >= (c.lvl || 0)));
  
  // ----- achievements: counters saved on the account; each achievement unlocks when its counter reaches the goal, and pays a little XP -----
  const ACHS = [
    { id: 'first_pop', name: 'First Pop', desc: 'Pop your first diver', stat: 'kills', goal: 1, xp: 50 },
    { id: 'pops_25', name: 'Bubble Buster', desc: 'Pop 25 divers', stat: 'kills', goal: 25, xp: 100 },
    { id: 'pops_100', name: 'Reef Menace', desc: 'Pop 100 divers', stat: 'kills', goal: 100, xp: 250 },
    { id: 'pops_500', name: 'Terror of the Tank', desc: 'Pop 500 divers', stat: 'kills', goal: 500, xp: 600 },
    { id: 'head_10', name: 'Headhunter', desc: 'Land 10 headshot pops', stat: 'heads', goal: 10, xp: 150 },
    { id: 'head_100', name: 'Eagle Eye', desc: 'Land 100 headshot pops', stat: 'heads', goal: 100, xp: 500 },
    { id: 'noodle_10', name: 'Noodle Knight', desc: 'Pop 10 divers with the Pool Noodle', stat: 'k_noodle', goal: 10, xp: 200 },
    { id: 'shotgun_10', name: 'Clam Slammer', desc: 'Pop 10 divers with the Clam Shotgun', stat: 'k_shotgun', goal: 10, xp: 150 },
    { id: 'seahorse_10', name: 'Seahorse Rider', desc: 'Pop 10 divers with the Seahorse Sniper', stat: 'k_seahorse', goal: 10, xp: 150 },
    { id: 'special_1', name: 'Special Delivery', desc: 'Pop a diver with a pad gun', stat: 'k_special', goal: 1, xp: 100 },
    { id: 'soaker_10', name: 'Soaked', desc: 'Pop 10 divers with the Super Soaker', stat: 'k_soaker', goal: 10, xp: 200 },
    { id: 'squid_5', name: 'Squid Pro Quo', desc: 'Pop 5 divers with the Squid Launcher', stat: 'k_squid', goal: 5, xp: 150 },
    { id: 'angler_5', name: 'Gone Fishing', desc: 'Pop 5 divers with the Anglerfish Longshot', stat: 'k_longshot', goal: 5, xp: 200 },
    { id: 'skewer', name: 'Skewered', desc: 'Pop two divers with one Longshot beam', stat: 'multi_rail', goal: 2, xp: 250 },
    { id: 'streak_5', name: 'On a Roll', desc: 'Pop 5 divers without getting popped', stat: 'streak', goal: 5, xp: 150 },
    { id: 'streak_10', name: 'Unstoppable', desc: 'Pop 10 divers without getting popped', stat: 'streak', goal: 10, xp: 400 },
    { id: 'fish_last', name: 'Fish Wipeout', desc: 'Shoot the last fish in a tank', stat: 'fish_last', goal: 1, xp: 100 },
    { id: 'cat', name: 'Cat Caller', desc: 'Call the cat in the kitchen', stat: 'cat', goal: 1, xp: 150 },
    { id: 'kid', name: 'Kid Bother', desc: 'Call the kid in the bedroom', stat: 'kid', goal: 1, xp: 150 },
    { id: 'glass', name: 'Glass Breaker', desc: 'Land the shot that breaks a tank', stat: 'glass', goal: 1, xp: 200 },
    { id: 'falls', name: 'Gravity Check', desc: 'Fall off the edge of a broken tank', stat: 'falls', goal: 1, xp: 50 },
    { id: 'oops', name: 'Oops', desc: 'Pop yourself with K', stat: 'suicides', goal: 1, xp: 25 },
    { id: 'regular', name: 'Regular', desc: 'Play 10 matches', stat: 'matches', goal: 10, xp: 100 },
    { id: 'win_1', name: 'Top Diver', desc: 'Win a match', stat: 'wins', goal: 1, xp: 150 },
    { id: 'win_10', name: 'Champion', desc: 'Win 10 matches', stat: 'wins', goal: 10, xp: 500 },
    { id: 'lv_10', name: 'Getting Wet', desc: 'Reach level 10', stat: 'level', goal: 10, xp: 100 },
    { id: 'lv_50', name: 'Deep Diver', desc: 'Reach level 50', stat: 'level', goal: 50, xp: 400 },
    { id: 'time_1', name: 'Hooked', desc: 'Spend 1 hour in the tank', stat: 'secs', goal: 3600, xp: 300 },
    { id: 'time_5', name: 'Tank Regular', desc: 'Spend 5 hours in the tank', stat: 'secs', goal: 18000, xp: 1000 },
    { id: 'time_20', name: 'Part of the Furniture', desc: 'Spend 20 hours in the tank', stat: 'secs', goal: 72000, xp: 3000 },
    { id: 'pops_2500', name: 'Apex Predator', desc: 'Pop 2,500 divers', stat: 'kills', goal: 2500, xp: 1500 },
    { id: 'pops_10000', name: 'Sea of Bubbles', desc: 'Pop 10,000 divers', stat: 'kills', goal: 10000, xp: 5000 },
    { id: 'head_1000', name: 'Never Misses', desc: 'Land 1,000 headshot pops', stat: 'heads', goal: 1000, xp: 2000 },
    { id: 'win_50', name: 'Undisputed', desc: 'Win 50 matches', stat: 'wins', goal: 50, xp: 2500 },
    { id: 'matches_250', name: 'Tank Veteran', desc: 'Play 250 matches', stat: 'matches', goal: 250, xp: 2000 },
    { id: 'streak_20', name: 'Legend of the Deep', desc: 'Pop 20 divers without getting popped', stat: 'streak', goal: 20, xp: 1500 },
    { id: 'multi_4', name: 'Quad Pop', desc: 'Pop 4 divers within a few seconds of each other', stat: 'multi', goal: 4, xp: 800 },
    { id: 'noodle_250', name: 'Noodle Master', desc: 'Pop 250 divers with the Pool Noodle', stat: 'k_noodle', goal: 250, xp: 1500 },
    { id: 'glass_25', name: 'Insurance Claim', desc: 'Break 25 tanks', stat: 'glass', goal: 25, xp: 1500 },
    { id: 'special_250', name: 'Pad Addict', desc: 'Pop 250 divers with pad guns', stat: 'k_special', goal: 250, xp: 2000 },
    { id: 'harp_1', name: 'Gotcha!', desc: 'Harpoon a diver', stat: 'harp_hits', goal: 1, xp: 100 },
    { id: 'harp_25', name: 'Reel Deal', desc: 'Harpoon 25 divers', stat: 'harp_hits', goal: 25, xp: 400 },
    { id: 'harp_100', name: 'Ahab', desc: 'Harpoon 100 divers', stat: 'harp_hits', goal: 100, xp: 1500 },
    { id: 'swing_50', name: 'Web Slinger', desc: 'Stick the harpoon in 50 walls, props or floors', stat: 'harps', goal: 50, xp: 500 },
    { id: 'quest_1', name: 'Quest Taker', desc: 'Finish a quest', stat: 'quests', goal: 1, xp: 100 },
    { id: 'quest_5', name: 'Errand Runner', desc: 'Finish 5 quests', stat: 'quests', goal: 5, xp: 300 },
    { id: 'quest_15', name: 'Quest Master', desc: 'Finish 15 quests', stat: 'quests', goal: 15, xp: 1000 },
    { id: 'daily_3', name: 'Daily Habit', desc: 'Finish 3 daily quests', stat: 'dailies', goal: 3, xp: 300 },
    { id: 'daily_10', name: 'Regular Customer', desc: 'Finish 10 daily quests', stat: 'dailies', goal: 10, xp: 800 },
    { id: 'daily_30', name: 'Dedicated Diver', desc: 'Finish 30 daily quests', stat: 'dailies', goal: 30, xp: 2500 },
    { id: 'qa_champ', name: 'Crowned', desc: 'Finish the Champion quest', stat: 'q_m_win5', goal: 1, xp: 300 },
    { id: 'qa_eye', name: 'Sharp Shooter', desc: 'Finish the Dead Eye quest', stat: 'q_m_head100', goal: 1, xp: 800 },
    { id: 'qa_deep', name: 'Deep Sea Legend', desc: 'Finish the Deep Sea Resident quest', stat: 'q_m_play240', goal: 1, xp: 1000 },
    { id: 'qa_terror', name: 'Feared Everywhere', desc: 'Finish the Terror of the Tank quest', stat: 'q_m_pop500', goal: 1, xp: 1500 },
    { id: 'lv_100', name: 'The Golden Diver', desc: 'Reach level 100', stat: 'level', goal: 100, xp: 1000 }
  ];
  function checkAch(a, ws) {
    a.st = a.st || {}; a.ach = a.ach || {}; let again = true, pay = false;
    while (again) {
      again = false; a.st.level = levelOf(a.xp).level;
      for (const A of ACHS) if (!a.ach[A.id] && (a.st[A.stat] || 0) >= A.goal) { a.ach[A.id] = Date.now(); a.xp += A.xp; again = pay = true; dirty = true; if (ws) send(ws, { t: 'ach', id: A.id, name: A.name, desc: A.desc, xp: A.xp }); }
    }
    if (pay && ws) { const p = [...players.values()].find(q => q.ws === ws); if (p) p.lv = levelOf(a.xp).level; send(ws, Object.assign({ t: 'prog' }, progOf(a))); }
  }
  setInterval(() => { for (const p of players.values()) if (p.acct && !p.dead) stat(p, 'secs', 10); }, 10000);   // time played, for the hours-long achievements
  function stat(p, key, n = 1, max = false) {        // bump one counter (max = keep the best so far) on the player's account
    if (!p || !p.acct || !ACC[p.acct]) return; const a = ACC[p.acct]; a.st = a.st || {};
    a.st[key] = max ? Math.max(a.st[key] || 0, n) : (a.st[key] || 0) + n; dirty = true; qCheck(a, p.ws); checkAch(a, p.ws);
  }
  
  // ----- quests: three daily quests (same for everybody, new every UTC day) plus a long list of bigger ones. They count the same stats as achievements, from the moment the quest starts -----
  const Q = (id, name, desc, stat, goal, xp) => ({ id, name, desc, stat, goal, xp });
  const QDAILY = [   // one from each group a day: some pops, something skilful, something that takes time
    [Q('d_pop20', 'Pop Squad', 'Pop 20 divers', 'kills', 20, 300), Q('d_pop25', 'Bubble Buster', 'Pop 25 divers', 'kills', 25, 350), Q('d_pop30', 'Tank Terror', 'Pop 30 divers', 'kills', 30, 400)],
    [Q('d_head6', 'Aim High', 'Land 6 headshot pops', 'heads', 6, 350), Q('d_noodle3', 'Noodle Time', 'Pop 3 divers with the Pool Noodle', 'k_noodle', 3, 350), Q('d_harp4', 'Hook Shot', 'Harpoon 4 divers', 'harp_hits', 4, 350), Q('d_shot6', 'Clam Jam', 'Pop 6 divers with the Clam Shotgun', 'k_shotgun', 6, 300), Q('d_sea5', 'Seahorse Rider', 'Pop 5 divers with the Seahorse Sniper', 'k_seahorse', 5, 350), Q('d_special2', 'Special Delivery', 'Pop 2 divers with pad guns', 'k_special', 2, 350)],
    [Q('d_play20', 'Stay Awhile', 'Spend 20 minutes in the tank', 'secs', 1200, 400), Q('d_win1', 'Winner Winner', 'Win a match', 'wins', 1, 450), Q('d_matches2', 'Two Rounds', 'Finish 2 matches', 'matches', 2, 350)]
  ];
  const QMORE = [   // easy to very hard (hours of play); finishing a few of these unlocks cosmetics and achievements
    Q('m_pop10', 'Warm Up', 'Pop 10 divers', 'kills', 10, 150), Q('m_play10', 'Getting Wet', 'Spend 10 minutes in the tank', 'secs', 600, 150), Q('m_head5', 'Aim High', 'Land 5 headshot pops', 'heads', 5, 200),
    Q('m_matches3', 'Regular', 'Finish 3 matches', 'matches', 3, 250), Q('m_harp5', 'Hook, Line and Sinker', 'Harpoon 5 divers', 'harp_hits', 5, 300), Q('m_glass1', 'Oops!', 'Break a tank', 'glass', 1, 600),
    Q('m_noodle10', 'Noodle Fighter', 'Pop 10 divers with the Pool Noodle', 'k_noodle', 10, 500), Q('m_pop50', 'Bubble Popper', 'Pop 50 divers', 'kills', 50, 600), Q('m_win3', 'Hot Streak', 'Win 3 matches', 'wins', 3, 800),
    Q('m_head25', 'Headhunter', 'Land 25 headshot pops (unlocks the Jellyfish Hat)', 'heads', 25, 900), Q('m_play60', 'Tank Time', 'Spend 1 hour in the tank', 'secs', 3600, 1200), Q('m_win5', 'Champion', 'Win 5 matches (unlocks Mermaid Locks)', 'wins', 5, 1500),
    Q('m_special20', 'Pad Master', 'Pop 20 divers with pad guns', 'k_special', 20, 1500), Q('m_pop200', 'Reef Menace', 'Pop 200 divers', 'kills', 200, 2500), Q('m_head100', 'Dead Eye', 'Land 100 headshot pops', 'heads', 100, 4000),
    Q('m_play240', 'Deep Sea Resident', 'Spend 4 hours in the tank (unlocks the Bubble Jet Pack)', 'secs', 14400, 5000), Q('m_pop500', 'Terror of the Tank', 'Pop 500 divers', 'kills', 500, 6000), Q('m_win15', 'Undefeated', 'Win 15 matches', 'wins', 15, 6000)
  ];
  const QALL = new Map([...QDAILY.flat(), ...QMORE].map(q => [q.id, q]));
  const qDay = () => new Date().toISOString().slice(0, 10);
  function qPickDaily(day) {                         // the same three for everyone on the same day
    let h = 0; for (const ch of day) h = (h * 31 + ch.charCodeAt(0)) >>> 0; const rnd = () => (h = (h * 1664525 + 1013904223) >>> 0) / 4294967296; return QDAILY.map(g => g[Math.floor(rnd() * g.length)]);
  }
  function qEnsure(a) {
    a.st = a.st || {}; a.qd = a.qd || {}; a.qb = a.qb || {}; const day = qDay(); let fresh = false;
    if (!a.dq || a.dq.day !== day) { a.dq = { day, ids: qPickDaily(day).map(q => q.id), base: {}, done: {} }; for (const id of a.dq.ids) a.dq.base[id] = a.st[QALL.get(id).stat] || 0; fresh = true; dirty = true; }
    for (const q of QMORE) if (a.qb[q.id] === undefined) { a.qb[q.id] = a.st[q.stat] || 0; dirty = true; }
    return fresh;
  }
  const qProg = (a, q, daily) => Math.max(0, Math.min(q.goal, (a.st[q.stat] || 0) - (daily ? a.dq.base[q.id] : a.qb[q.id]) || 0));
  function qView(a) {
    const f = (q, daily) => ({ id: q.id, name: q.name, desc: q.desc, xp: q.xp, sd: daily ? SD_DAILY : 0, goal: q.goal, p: qProg(a, q, daily), done: daily ? !!a.dq.done[q.id] : !!a.qd[q.id], unlock: COSMETICS.filter(c => c.quest === q.id).map(c => c.name) });
    return { t: 'quests', day: a.dq.day, resetIn: 86400000 - (Date.now() % 86400000), daily: a.dq.ids.map(id => f(QALL.get(id), true)), more: QMORE.map(q => f(q, false)) };
  }
  function qSend(a, ws, force) {
    if (!ws || ws.readyState !== 1) return; const now = Date.now();
    if (!force && now - (ws._qs || 0) < 2000) { if (!ws._qt) ws._qt = setTimeout(() => { ws._qt = 0; qSend(a, ws, true); }, 2100); return; }
    ws._qs = now; send(ws, qView(a));
  }
  function qCheck(a, ws) {                           // called whenever a counter moves: finish anything that reached its goal
    const fresh = qEnsure(a); let any = false;
    const fin = (q, daily) => {
      if (daily ? a.dq.done[q.id] : a.qd[q.id]) return; if (qProg(a, q, daily) < q.goal) return;
      if (daily) a.dq.done[q.id] = Date.now(); else a.qd[q.id] = Date.now(); a.xp += q.xp; a.st.quests = (a.st.quests || 0) + 1; if (daily) a.st.dailies = (a.st.dailies || 0) + 1; a.st['q_' + q.id] = 1; any = true; dirty = true;
      let sdGain = 0; if (daily) { sdGain = SD_DAILY; if (!a.dq.bonus && a.dq.ids.every(id => a.dq.done[id])) { a.dq.bonus = 1; sdGain += SD_ALL3; } a.sd = (a.sd | 0) + sdGain; }
      if (ws) send(ws, { t: 'qdone', id: q.id, name: q.name, xp: q.xp, sd: sdGain, daily, unlock: ITEMS.filter(c => c.quest === q.id).map(c => c.name) });
    };
    for (const id of a.dq.ids) fin(QALL.get(id), true); for (const q of QMORE) fin(q, false);
    if (any) { const p = [...players.values()].find(x => x.ws === ws); if (p) p.lv = levelOf(a.xp).level; if (ws) send(ws, Object.assign({ t: 'prog' }, progOf(a))); checkAch(a, ws); }
    if (ws) qSend(a, ws, fresh || any);
  }
  const progOf = a => Object.assign({ xp: a.xp, eq: a.eq, ach: Object.keys(a.ach || {}), st: a.st || {}, qd: a.qd || {}, sd: a.sd | 0, own: Object.keys(a.own || {}), google: !!a.google }, levelOf(a.xp));
  function auth(ws, m) {
    const fail = e => send(ws, { t: 'auth', ok: false, error: e });
    const busy = u => [...wss.clients].some(c => c !== ws && c.acct === u && c.readyState === 1);   // one login per account at a time
    if (m.token && sessions.has(m.token)) { const u0 = sessions.get(m.token); if (busy(u0)) return fail('That account is already logged in somewhere else.'); ws.acct = u0; const a = ACC[ws.acct]; qEnsure(a); fixEq(a); checkAch(a, ws); send(ws, Object.assign({ t: 'auth', ok: true, token: m.token, user: a.user, admin: a.user === ADMIN }, progOf(a))); return qCheck(a, ws); }
    const user = String(m.user || '').trim().toLowerCase(), pass = String(m.pass || '');
    if (!/^[a-z0-9_]{3,14}$/.test(user) || pass.length < 4 || pass.length > 64) return fail('Username: 3-14 letters/numbers. Password: 4+ characters.');
    let a = ACC[user];
    if (m.mode === 'register') { if (a) return fail('That username is taken.'); const salt = crypto.randomBytes(8).toString('hex'); a = ACC[user] = { user, salt, hash: hashPw(pass, salt), xp: 0, eq: {} }; dirty = true; }
    else if (!a || a.hash !== hashPw(pass, a.salt)) return fail('Wrong username or password.');
    if (busy(user)) return fail('That account is already logged in somewhere else.');
    loginAs(ws, a);
  }
  function loginAs(ws, a) {
    const token = crypto.randomBytes(16).toString('hex'); sessions.set(token, a.user); ws.acct = a.user;
    qEnsure(a); fixEq(a); checkAch(a, ws); send(ws, Object.assign({ t: 'auth', ok: true, token, user: a.user, admin: a.user === ADMIN }, progOf(a))); qCheck(a, ws);
  }
  
  // ---------- secret admin panel: only the account named buddyboy32 (logged in with its password) may send these ----------
  const ADMIN = 'buddyboy32';
  function fixEq(a) {                                // drop equipped things that no longer exist or are not unlocked
    a.eq = a.eq || {}; for (const k of Object.keys(a.eq)) { if (k === 'color') { if (!COLORS.includes(a.eq[k])) delete a.eq[k]; continue; } const c = ITEM.get(a.eq[k]); if (!c || c.slot !== k || !unlocked(a, c)) delete a.eq[k]; }
  }
  function refreshAcct(u) {                        // after an admin edit: drop cosmetics above the new level and push the new numbers to anyone who is logged in as that account
    const a = ACC[u]; if (!a) return; const lv = levelOf(a.xp).level;
    fixEq(a);
    for (const c of wss.clients) if (c.acct === u) send(c, Object.assign({ t: 'prog' }, progOf(a)));
    for (const p of players.values()) if (p.acct === u) { p.lv = lv; p.eq = a.eq; }
    dirty = true;
  }
  function adminList(ws) {
    const on = new Set([...wss.clients].map(c => c.acct).filter(Boolean));
    send(ws, { t: 'adminlist', accts: Object.values(ACC).map(a => ({ user: a.user, xp: a.xp, level: levelOf(a.xp).level, on: on.has(a.user) })).sort((x, y) => (y.on - x.on) || (y.xp - x.xp)) });
  }
  const adminP = ws => [...players.values()].find(q => q.ws === ws);
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
      case 'kid': if (!kidOn && !drained && MAP.kid) kidEvent(); break;
      case 'endmatch': if (!inter) endMatch(); break;
      case 'force': if (MAPS[m.map]) FORCE.map = m.map; break;
      case 'jug': { const t = players.get(+m.id) || players.get(ws.pid); if (t && !t.dead) jugStart(t); break; }   // decides the next map instead of the usual back-and-forth
      case 'cat': if (MAP.cat && !catOn && !inter) catEvent(); break;
      case 'cheat': { const me = adminP(ws); if (!me) return; const K = { god: 'b', ammo: 'b', nospread: 'b', one: 'b', invis: 'b', fly: 'b', keepsp: 'b', noharpcd: 'b', norel: 'b', esp: 'b', aimbot: 'b', hpmax: [1, 100000], dmg: [.1, 1000], rate: [.1, 30], speed: [.3, 8], jump: [.3, 8], grav: [0, 3], reach: [1, 12], harprange: [.5, 6], harpboost: [.2, 5] }, kk = String(m.k), spec = K[kk]; if (!spec) return;
        me.cheat = me.cheat || {}; if (spec === 'b') me.cheat[kk] = !!m.v; else { const v = +m.v; if (!Number.isFinite(v)) return; me.cheat[kk] = Math.max(spec[0], Math.min(spec[1], v)); if (kk === 'hpmax') { me.hp = Math.max(me.hp, 0); } }
        send(ws, { t: 'cheats', c: me.cheat, hpmax: hpMax(me) }); return; }
      case 'reset': { const me = adminP(ws); if (!me) return; me.cheat = {}; me.hp = Math.min(me.hp, 100); send(ws, { t: 'cheats', c: {}, hpmax: 100 }); return; }
      case 'heal': { const me = adminP(ws); if (me && !me.dead) { me.hp = hpMax(me); me.am[me.w] = WEAPONS[me.w].mag; me.reloadAt = 0; } return; }
      case 'give': { const me = adminP(ws); if (me && !me.dead && WEAPONS[m.w]) { if (WEAPONS[m.w].pad || WEAPONS[m.w].melee || true) giveSpecial(me, m.w); } return; }
      case 'killall': { const me = adminP(ws); if (me) for (const q of [...players.values()]) if (q !== me && !q.dead) { q.safe = 0; hurt(q, me, 99999, false); } return; }
      case 'killp': { const me = adminP(ws), q = players.get(+m.id); if (me && q && q !== me && !q.dead) { q.safe = 0; hurt(q, me, 99999, false); } return; }
      case 'tpto': { const me = adminP(ws), q = players.get(+m.id); if (me && q) { me.x = q.x; me.y = q.y; me.z = q.z; send(ws, { t: 'tp', x: q.x, y: q.y, z: q.z }); } return; }
      case 'bring': { const me = adminP(ws), q = players.get(+m.id); if (me && q) { q.x = me.x; q.y = me.y; q.z = me.z; send(q.ws, { t: 'tp', x: me.x, y: me.y, z: me.z }); } return; }
      case 'bringall': { const me = adminP(ws); if (me) for (const q of players.values()) if (q !== me) { q.x = me.x + rnd(-2, 2); q.y = me.y; q.z = me.z + rnd(-2, 2); send(q.ws, { t: 'tp', x: q.x, y: q.y, z: q.z }); } return; }
      case 'timeleft': { const sec = Math.max(5, Math.min(3600, +m.n || 0)); if (!inter) matchEnd = Date.now() + sec * 1000; return; }
      case 'mapnow': { if (MAPS[m.map]) { FORCE.map = m.map; if (!inter) endMatch(); } return; }
      case 'fish': { newFish(); bcast({ t: 'fishreset', fish: FISH }); return; }
      case 'respawnall': { for (const q of players.values()) if (q.dead) spawn(q); return; }
      case 'clearcracks': { if (!drained) { CRACKS = []; crackTotal = 0; FACETALLY = {}; bcast({ t: 'cracksclear' }); } return; }
      default: return;
    }
    adminList(ws);
  }
  function equip(ws, m) {
    const a = ws.acct && ACC[ws.acct]; if (!a) return; a.eq = a.eq || {}; const c = ITEM.get(m.id); if (c && c.slot !== m.slot) return;
    if (m.slot === 'color') { if (m.id === null || m.id === 'brass') delete a.eq.color; else if (COLORS.includes(m.id)) a.eq.color = m.id; else return; }
    else if (m.id === null && SLOTS.includes(m.slot)) delete a.eq[m.slot]; else if (c && unlocked(a, c)) a.eq[c.slot] = c.id; else return;
    dirty = true; send(ws, Object.assign({ t: 'prog' }, progOf(a))); for (const p of players.values()) if (p.ws === ws) p.eq = a.eq;
  }

  // ----- the item shop: eight things a day (3 gun skins + 5 cosmetics) picked the same for everybody, paid in sand dollars -----
  const mulberry = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const shopToday = () => { const day = qDay(), seed = [...day].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7), r = mulberry(seed), shuf = arr => arr.map(v => [r(), v]).sort((x, y) => x[0] - y[0]).map(x => x[1]);
    return [...shuf(SKINS).slice(0, 3), ...shuf(COSMETICS.filter(c => !c.quest)).slice(0, 5)]; };
  function shopSend(ws) {
    const a = ws.acct && ACC[ws.acct], list = shopToday(), left = Math.max(60, Math.round((new Date(qDay() + 'T00:00:00Z').getTime() + 86400000 - Date.now()) / 1000));
    send(ws, { t: 'shop', sd: a ? a.sd | 0 : 0, resetIn: left, pay: !!PAY.key, bundles: Object.keys(BUNDLES).map(id => Object.assign({ id }, BUNDLES[id])),
      items: list.map(c => ({ id: c.id, name: c.name, slot: c.slot, gun: c.gun || null, rarity: c.rarity, price: priceOf(c), owned: !!(a && unlocked(a, c)) })) });
  }
  function buy(ws, m) {
    const a = ws.acct && ACC[ws.acct]; if (!a) return send(ws, { t: 'buyerr', error: 'Log in to buy things.' });
    const c = ITEM.get(m.id); if (!c || !shopToday().includes(c)) return send(ws, { t: 'buyerr', error: 'That is not in the shop today.' });
    if (unlocked(a, c)) return send(ws, { t: 'buyerr', error: 'You already have that.' });
    const price = priceOf(c); if ((a.sd | 0) < price) return send(ws, { t: 'buyerr', error: 'Not enough sand dollars.' });
    a.sd -= price; a.own = a.own || {}; a.own[c.id] = Date.now(); dirty = true;
    send(ws, { t: 'bought', id: c.id, name: c.name, rarity: c.rarity }); send(ws, Object.assign({ t: 'prog' }, progOf(a))); shopSend(ws);
  }
  function grantSD(user, n, ref) {                  // called by the payment webhook (once per payment) and by nothing else
    const a = ACC[user]; if (!a || !(n > 0)) return false; a.paid = a.paid || {}; if (ref) { if (a.paid[ref]) return true; a.paid[ref] = Date.now(); }
    a.sd = (a.sd | 0) + n; dirty = true; for (const c of wss.clients) if (c.acct === user) { send(c, Object.assign({ t: 'prog' }, progOf(a))); send(c, { t: 'sdgift', n }); } return true;
  }
  // ----- Google sign-in (only when GOOGLE_CLIENT_ID is set): the browser sends Google's signed ID token, we ask Google whether it is real -----
  async function googleLogin(ws, m) {
    const fail = e => send(ws, { t: 'auth', ok: false, error: e }); if (!GOOGLE_ID) return fail('Google sign-in is not set up on this server.');
    let info; try { const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(String(m.credential || ''))); info = await r.json(); if (!r.ok) throw new Error('bad'); } catch (e) { return fail('Google could not verify you.'); }
    if (info.aud !== GOOGLE_ID || !info.sub || (info.email_verified !== 'true' && info.email_verified !== true)) return fail('Google could not verify you.');
    const owner = Object.values(ACC).find(x => x.google === info.sub);
    if (ws.acct && ACC[ws.acct]) {                      // already signed in: link this Google account to it
      const me = ACC[ws.acct]; if (owner && owner !== me) return send(ws, { t: 'linked', ok: false, error: 'That Google account is already linked to another diver.' });
      me.google = info.sub; dirty = true; send(ws, { t: 'linked', ok: true }); return send(ws, Object.assign({ t: 'prog' }, progOf(me)));
    }
    let a = owner;
    if (!a) { let base = String(info.email || 'diver').split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 10); if (base.length < 3) base = 'diver' + base; let user = base; while (ACC[user]) user = base.slice(0, 10) + Math.floor(100 + Math.random() * 900);
      const salt = crypto.randomBytes(8).toString('hex'); a = ACC[user] = { user, salt, hash: hashPw(crypto.randomBytes(16).toString('hex'), salt), xp: 0, eq: {}, google: info.sub }; dirty = true; }
    if ([...wss.clients].some(c => c !== ws && c.acct === a.user && c.readyState === 1)) return fail('That account is already logged in somewhere else.');
    loginAs(ws, a);
  }
  function giveXp(p, n) { if (!p.acct || !ACC[p.acct]) return; const a = ACC[p.acct]; a.xp += n; dirty = true; p.lv = levelOf(a.xp).level; checkAch(a, p.ws); send(p.ws, Object.assign({ t: 'prog' }, progOf(a))); }
  
  const send = (ws, m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
  const burst = p => bcast({ t: 'burst', p: [p.x, p.y + 1, p.z] });   // the death bubble-pop effect
  const bcast = m => { const s = JSON.stringify(m); for (const c of clients) if (c.readyState === 1) c.send(s); };  // everyone in this room, including players sitting in the menu
  const norm = v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
  
  function raySphere(o, d, c, r) {
    const m = [o[0] - c[0], o[1] - c[1], o[2] - c[2]], b = m[0] * d[0] + m[1] * d[1] + m[2] * d[2];
    const cc = m[0] * m[0] + m[1] * m[1] + m[2] * m[2] - r * r;
    if (cc > 0 && b > 0) return null;
    const disc = b * b - cc; if (disc < 0) return null;
    return Math.max(0, -b - Math.sqrt(disc));
  }
  function rayBox(o, d, B, shrink) {                   // shrink = bullets pass through the very edges of decor (the boxes are a bit fat)
    const k = shrink ? Math.min(shrink, B.w * .2, B.d * .2) : 0, mn = [B.x - B.w / 2 + k, B.y0 || 0, B.z - B.d / 2 + k], mx = [B.x + B.w / 2 - k, B.h, B.z + B.d / 2 - k];
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
    let t = 1e9; const lo = [-ARENA.x, 0, -ARENA.z], hi = [ARENA.x, ARENA.h, ARENA.z];
    if (ARENA.round) {                               // the fish bowl is a cylinder
      const R = ARENA.x, A = d[0] * d[0] + d[2] * d[2];
      if (A > 1e-10) { const B = o[0] * d[0] + o[2] * d[2], Cc = o[0] * o[0] + o[2] * o[2] - R * R, disc = B * B - A * Cc; if (disc >= 0) { const tt = (-B + Math.sqrt(disc)) / A; if (tt > 0) { let lim = tt; if (drained && MAP.glass) { const yy = o[1] + d[1] * tt; if (yy >= 0 && yy <= ARENA.h && roundFace(o[0] + d[0] * tt, o[2] + d[2] * tt).face === drainFace) lim = 1e9; } t = Math.min(t, lim); } } }
      if (d[1] > 1e-8) { if (!open) t = Math.min(t, (ARENA.h - o[1]) / d[1]); } else if (d[1] < -1e-8) t = Math.min(t, -o[1] / d[1]);
      return Math.max(0, t);
    }
    for (let i = 0; i < 3; i++) {
      if (d[i] > 1e-8) { if (!(open && i === 1) && !faceOpen(i, 1)) t = Math.min(t, (hi[i] - o[i]) / d[i]); }
      else if (d[i] < -1e-8) { if (!faceOpen(i, -1)) t = Math.min(t, (lo[i] - o[i]) / d[i]); }
    }
    return Math.max(0, t);
  }
  
  // ----- game modes: Free for All (10 pops in a row summons the Juggernaut), Team Deathmatch, Gun Game; the next map + mode are voted on during the results screen -----
  const MODES = {
    ffa:     { name: 'Free for All',     desc: 'Everyone for themselves. Pop 10 divers in a row and you become the Juggernaut.' },
    tdm:     { name: 'Team Deathmatch',  desc: 'Two random teams. Most pops after 8 minutes wins.' },
    lucky:   { name: 'Lucky Dip',        desc: 'No gun picking: every life you get a random gun and keep it until you are popped. Most pops wins.' },
    gungame: { name: 'Gun Game',         desc: '10 minutes. Three pops with each gun to move up. No pad. Finish the pool noodle to win.' }
  };
  const GG = ['soaker', 'longshot', 'squid', 'seahorse', 'shotgun', 'crab', 'puffer', 'pistol', 'noodle'], GG_KILLS = 3;   // super soaker, anglerfish, squid launcher, sniper, shotgun, burst rifle, smg, pistol, melee
  const JUG_HP = 2500, JUG_NEED = 10, JUG_MAX_MS = 5 * 60 * 1000;
  const SETGUNS = () => MODE === 'gungame' || MODE === 'lucky';   // modes that hand you your gun: no gun choice, no pad pickups
  let MODE = 'ffa', NEXTMODE = 'ffa', TEAMK = [0, 0], FORCED_MAP = false, GGWIN = null; const VOTES = new Map(), JUG = { on: false, id: 0, name: '', t0: 0, parts: [] };
  const teamOf = p => JUG.on ? (p.id === JUG.id ? 1 : 0) : MODE === 'tdm' ? (p.team | 0) : -1;   // the juggernaut is alone against everybody else
  const friendly = (a, b) => a !== b && teamOf(a) >= 0 && teamOf(a) === teamOf(b);
  const ggScore = p => (p === GGWIN ? GG.length : (p.gl | 0)) * GG_KILLS + (p.gk | 0);
  function assignTeams() { const l = [...players.values()].sort(() => Math.random() - .5); l.forEach((p, i) => { p.team = i % 2; }); TEAMK = [0, 0]; }
  const smallTeam = () => { let a = 0, b = 0; for (const p of players.values()) (p.team | 0) ? b++ : a++; return a <= b ? 0 : 1; };
  const pick3 = (arr, must) => { const a = arr.slice().sort(() => Math.random() - .5), out = must && arr.includes(must) ? [must] : []; for (const x of a) if (out.length < 3 && !out.includes(x)) out.push(x); return out.sort(() => Math.random() - .5); };
  let VOTEOPTS = { maps: Object.keys(MAPS), modes: Object.keys(MODES) };   // the three maps and three modes up for a vote this intermission (random each time)
  const MAPDESC = { bedroom: 'The classic: a castle in the middle, kid and cat events, a big old bookcase.', kitchen: 'A round glass fish bowl on the counter. Watch out for cracks.', pirate: 'Shipwreck, treasure and corals to hide behind.', night: 'The bedroom with the lights out and the kid asleep. Spooky.' };
  const voteOpts = () => ({ maps: VOTEOPTS.maps.map(id => ({ id, name: MAPS[id].name, desc: MAPDESC[id] || '' })), modes: VOTEOPTS.modes.map(id => ({ id, name: MODES[id].name, desc: MODES[id].desc })) });
  function tally() { const maps = {}, modes = {}; for (const id of VOTEOPTS.maps) maps[id] = 0; for (const id of VOTEOPTS.modes) modes[id] = 0; for (const v of VOTES.values()) { if (v.map) maps[v.map]++; if (v.mode) modes[v.mode]++; } return { maps, modes }; }
  function pickTop(counts, dflt) { let best = -1, top = []; for (const id in counts) { if (counts[id] > best) { best = counts[id]; top = [id]; } else if (counts[id] === best) top.push(id); } return best <= 0 ? dflt : top[Math.floor(Math.random() * top.length)]; }
  function resolveVotes() { const t = tally(); return { map: FORCED_MAP ? NEXTMAP : pickTop(t.maps, VOTEOPTS.maps.includes(NEXTMAP) ? NEXTMAP : VOTEOPTS.maps[0]), mode: pickTop(t.modes, VOTEOPTS.modes[Math.floor(Math.random() * VOTEOPTS.modes.length)]) }; }
  const voteMsg = () => { const t = tally(); return { t: 'votes', maps: t.maps, modes: t.modes }; };
  function jugStart(p, victim) {                          // 10 pops in a row: a thick diver with 2,500 HP and a super soaker against everybody else
    if (JUG.on || inter || MODE !== 'ffa') return; const others = [...players.values()].filter(q => q !== p); if (!others.length) return;
    catStop(); JUG.on = true; JUG.id = p.id; JUG.name = p.name; JUG.t0 = Date.now(); JUG.parts = others.map(q => q.id);
    p.jug = true; giveSpecial(p, 'soaker'); p.hp = JUG_HP; p.safe = Date.now() + 1500; stat(p, 'juggernauts');
    bcast({ t: 'jug', s: 'start', id: p.id, name: p.name, hp: JUG_HP });
    if (victim && victim !== p && players.get(victim.id) === victim) { victim.jugOK = true; setTimeout(() => { if (JUG.on && victim.dead && players.get(victim.id) === victim) spawn(victim); }, 2500); }   // the diver whose pop started it all dives straight back in against the juggernaut
  }
  function jugCheck() { if (!JUG.on) return; const jp = players.get(JUG.id); if (!jp || jp.dead) return; if (![...players.values()].some(q => q.id !== JUG.id && (!q.dead || q.jugOK))) jugEnd('jug'); }
  function jugEnd(win, killer) {
    if (!JUG.on) return; const jp = players.get(JUG.id), dur = Date.now() - JUG.t0, name = JUG.name; JUG.on = false; matchEnd += dur;   // the match clock stands still during the event
    if (jp) { jp.jug = false; jp.hp = Math.min(jp.hp, 100); }
    if (win === 'players') { if (killer && killer !== jp) { giveXp(killer, 250); stat(killer, 'jugkills'); } for (const id of JUG.parts) { const q = players.get(id); if (q) giveXp(q, 100); } }
    else if (jp) giveXp(jp, 300);
    for (const q of players.values()) q.streak = 0;
    bcast({ t: 'jug', s: 'end', win, id: JUG.id, name, by: killer ? killer.name : null });
    setTimeout(() => { if (JUG.on) return; for (const q of players.values()) if (q.dead || q.id === JUG.id) spawn(q); }, 4000);   // after the banner everybody dives back in
  }
  function ggAdvance(p) {                         // gun game: three pops per gun
    p.gk = (p.gk | 0) + 1; if (p.gk < GG_KILLS) return; p.gk = 0; p.gl = (p.gl | 0) + 1;
    if (p.gl >= GG.length) { GGWIN = p; endMatch(); return; }
    const id = GG[p.gl]; p.w = p.base = id; p.sp = null; p.am[id] = WEAPONS[id].mag; p.reloadAt = 0; p.chStart = 0; send(p.ws, { t: 'got', w: id, gg: true });
  }
  function modeKill(victim, att) {
    if (victim === att) return;
    if (MODE === 'tdm' && !JUG.on) TEAMK[att.team | 0]++;
    if (MODE === 'gungame' && !att.dead && !inter) ggAdvance(att);
    if (MODE === 'ffa' && !JUG.on && !inter && !att.dead && att.streak === JUG_NEED) jugStart(att, victim);
  }
  const hpMax = p => p.jug ? JUG_HP : (p.cheat && p.cheat.hpmax) || 100;
  function spawn(p) {
    const [x, z] = SPAWNS[Math.floor(Math.random() * SPAWNS.length)];
    if (p.sp && !(p.cheat && p.cheat.keepsp)) { p.sp = null; p.w = p.base || 'pistol'; }                        // special guns are lost when you pop (unless the admin keeps them)
    if (MODE === 'gungame') { p.sp = null; p.w = p.base = GG[Math.min(p.gl | 0, GG.length - 1)]; }
    else if (MODE === 'lucky') { const keys = Object.keys(WEAPONS).filter(k => !WEAPONS[k].pad); p.sp = null; p.w = p.base = keys[Math.floor(Math.random() * keys.length)]; send(p.ws, { t: 'got', w: p.w, gg: true }); }   // a fresh random gun every life
    p.jug = false; p.jugOK = false; p.harp = null; Object.assign(p, { x, y: 0, z, hp: hpMax(p), dead: false, reloadAt: 0, chStart: 0, safe: Date.now() + 2000, boostAt: 0, hist: [] });  // 2s spawn shield
    for (const k in WEAPONS) p.am[k] = WEAPONS[k].mag;
    send(p.ws, { t: 'spawn', x, y: 0, z });
  }
  function hurt(victim, att, dmg, head, src, wn) {
    if (victim.dead || inter || Date.now() < victim.safe) return false;
    if (victim.cheat && victim.cheat.god) return false;                       // admin god mode
    if (victim !== att && friendly(victim, att)) return false;                // no friendly fire
    if (att !== victim && att.cheat) { if (att.cheat.one) dmg = 9999; else if (att.cheat.dmg) dmg *= att.cheat.dmg; }   // admin damage multiplier / one-shot
    victim.hp -= dmg; send(victim.ws, { t: 'hurt', hp: Math.max(0, Math.round(victim.hp)), from: victim === att ? null : (src ? [src[0], src[2]] : [att.x, att.z]) });
    if (victim !== att) { send(att.ws, { t: 'hit', head, dmg: Math.round(dmg), at: [+victim.x.toFixed(2), +(victim.y + (head ? 1.55 : 1.0)).toFixed(2), +victim.z.toFixed(2)], kill: victim.hp <= 0 }); victim.lastHit = { id: att.id, t: Date.now() }; }
    if (victim.hp <= 0) {
      victim.dead = true; harpEnd(victim); victim.deaths++; burst(victim);
      victim.streak = 0;
      if (victim !== att) {
        att.kills++; if (!att.dead && !att.jug) att.hp = Math.max(att.hp, hpMax(att)); { const kx = 30 + (head ? 10 : 0); giveXp(att, kx); send(att.ws, { t: 'xp', n: kx, head: !!head }); }   // siphon: every kill refills your health
        att.streak = (att.streak || 0) + 1; stat(att, 'kills'); if (head) stat(att, 'heads'); if (!wn) stat(att, 'k_' + att.w); if (att.sp && att.w === att.sp) stat(att, 'k_special'); stat(att, 'streak', att.streak, true);
        const nT = Date.now(); att.multi = nT - (att.lastKill || 0) < 4000 ? (att.multi || 1) + 1 : 1; att.lastKill = nT; send(att.ws, { t: 'streak', n: att.streak, multi: att.multi }); if (att.multi >= 2) stat(att, 'multi', att.multi, true);
      }
      bcast({ t: 'kill', k: att.name, v: victim.name, w: wn || WEAPONS[att.w].name, head, self: victim === att, ki: att.id, vi: victim.id });
      send(victim.ws, { t: 'dead', by: victim === att ? 'your own blast' : att.name, byId: victim === att ? 0 : att.id });
      modeKill(victim, att);
      if (JUG.on) { if (victim.id === JUG.id) jugEnd('players', att); else jugCheck(); }
      return true;
    }
    return false;
  }
  
  // ----- the harpoon (Q): a gauntlet on the left arm fires a spear on a rope. It sticks in walls, the floor, props and glass and reels you in (the client does the swing physics); on a diver it does 20 damage and drags him to you; on glass it does 1 damage to the tank. 5 s cooldown -----
  const HARP_RANGE = ARENA_BED.x, HARP_CD = 5000, harpCd = p => p.w === 'noodle' ? 3000 : HARP_CD;   // 3 s with the pool noodle
  const lidBars = A => A.round ? [] : [   // the black plastic rim around the top of a rectangular tank and its cross-braces (same sizes as the client draws)
    { x: 0, z: A.z, w: 2 * A.x + 1.2, d: 1.2, y0: A.h - .05, h: A.h + .55 }, { x: 0, z: -A.z, w: 2 * A.x + 1.2, d: 1.2, y0: A.h - .05, h: A.h + .55 },
    { x: A.x, z: 0, w: 1.2, d: 2 * A.z, y0: A.h - .05, h: A.h + .55 }, { x: -A.x, z: 0, w: 1.2, d: 2 * A.z, y0: A.h - .05, h: A.h + .55 },
    ...[-.5, -.17, .17, .5].map(k => ({ x: A.x * k * 1.9, z: 0, w: .3, d: 2 * A.z - 1.5, y0: A.h - .05, h: A.h + .5 }))];
  function harpoon(p, dir) {
    const now = Date.now(); if (p.dead || inter || now - (p.harpAt || 0) < ((p.cheat && p.cheat.noharpcd) ? 0 : harpCd(p))) return; p.harpAt = now;
    const o = [p.x, p.y + 1.5, p.z], d = norm(dir), outside = outsideXZ(p.x, p.z), range = HARP_RANGE * ((p.cheat && p.cheat.harprange) || 1);
    let tMax = range, kind = 'miss', victim = null, gh = null;
    if (!outside) { const tw = tankLimit(o, d); if (tw < tMax) { tMax = tw; kind = 'wall'; } }
    for (const b of COLS) { const t = rayBox(o, d, b, .06); if (t !== null && t < tMax) { tMax = t; kind = 'prop'; } }
    for (const q of players.values()) { if (q === p || q.dead || friendly(p, q) || (q.cheat && q.cheat.invis)) continue; const hp = hitPlayer(o, d, q, REWIND, true); if (hp && hp.t < tMax) { tMax = hp.t; kind = 'player'; victim = q; } }
    if (!outside) for (const b of lidBars(ARENA)) { const t = rayBox(o, d, b, 0); if (t !== null && t < tMax + .03) { tMax = Math.min(tMax, t); kind = 'prop'; } }   // the plastic rim and cross-braces across the top of the tank can be hooked
    let dropE = null;
    if (kind === 'miss' && !outside) {                // out of rope: the hook sags like a real grappling hook, so aiming a bit above a ledge still catches it
      let P = o.map((v, k) => v + d[k] * tMax), prev = P;
      for (let i = 1; i <= 28 && !dropE; i++) {
        const sg = i * .25, cur = [P[0] + d[0] * sg, P[1] + d[1] * sg - .16 * sg * sg, P[2] + d[2] * sg], sd = [cur[0] - prev[0], cur[1] - prev[1], cur[2] - prev[2]], len = Math.hypot(...sd) || 1e-6, sn = sd.map(v => v / len);
        let bt = len, hit = null;
        for (const b of COLS) { const t = rayBox(prev, sn, b, .06); if (t !== null && t < bt) { bt = t; hit = 'prop'; } }
        if (cur[1] <= .05 && prev[1] > .05) { const t = (prev[1] - .05) / Math.max(1e-6, prev[1] - cur[1]) * len; if (t < bt) { bt = t; hit = 'floor'; } }
        if (!hit && (Math.abs(cur[0]) > ARENA.x || Math.abs(cur[2]) > ARENA.z)) break;
        if (hit) { dropE = prev.map((v, k) => v + sn[k] * bt); kind = hit; } prev = cur;
      }
    }
    const e = dropE ? dropE.map(v => +v.toFixed(2)) : o.map((v, k) => +(v + d[k] * tMax).toFixed(2));
    if (kind === 'wall') {
      if (e[1] >= ARENA.h - .05) kind = 'miss';       // the water surface is nothing to hook onto
      else if (e[1] > .05 && MAP.glass && !drained) { gh = glassHit(o, d); if (gh && gh.t <= tMax + 1e-3) { kind = 'glass'; addCrack(gh, 6, p, 1); } }
      else if (e[1] <= .05) kind = 'floor';
    }
    if (kind === 'player') { const before = victim.hp; hurt(victim, p, 20, false, o, 'Harpoon'); if (now >= victim.safe && !(victim.cheat && victim.cheat.god)) send(victim.ws, { t: 'drag', by: p.id, ms: 900 }); stat(p, 'harp_hits'); void before; }
    if (kind !== 'miss' && kind !== 'player') stat(p, 'harps');
    p.harp = { until: now + (kind === 'player' ? 900 : kind === 'miss' ? 450 : 7000) };
    bcast({ t: 'harp', id: p.id, o, e, hit: kind, vid: victim ? victim.id : 0, cd: (p.cheat && p.cheat.noharpcd) ? 0 : harpCd(p), face: gh ? gh.face : null });
  }
  function harpEnd(p) { if (!p.harp) return; p.harp = null; bcast({ t: 'harpend', id: p.id }); }
  const REWIND = 100;                              // ms: shots are judged against where the target was when the shooter saw them
  function posAt(q, ago) {
    const h = q.hist; if (!h || !h.length) return [q.x, q.y, q.z]; const T = Date.now() - ago;
    for (let i = h.length - 1; i >= 0; i--) if (h[i].t <= T) { const a = h[i], b = h[i + 1]; if (!b) return [a.x, a.y, a.z]; const f = (T - a.t) / Math.max(1, b.t - a.t); return [a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, a.z + (b.z - a.z) * f]; }
    return [h[0].x, h[0].y, h[0].z];
  }
  function hitPlayer(o, d, q, ago, big) {              // head + chest + legs spheres (generous on purpose); returns { t, head } or null
    const c = ago === 0 ? [q.x, q.y, q.z] : posAt(q, ago), J = q.jug ? 1.25 : 1, k = (big ? 1.25 : 1) * (q.jug ? 1.45 : 1);   // the juggernaut is a big thick target
    const th = raySphere(o, d, [c[0], c[1] + 1.8 * J, c[2]], .5 * k);
    let tb = raySphere(o, d, [c[0], c[1] + 1.1 * J, c[2]], .68 * k), tl = raySphere(o, d, [c[0], c[1] + .45 * J, c[2]], .52 * k);
    if (tl !== null && (tb === null || tl < tb)) tb = tl;
    if (th !== null && (tb === null || th <= tb + 1)) return { t: th, head: true };
    return tb !== null ? { t: tb, head: false } : null;
  }
  function shoot(p, dir, sub) {                    // sub = the 2nd/3rd round of a burst
    const W = WEAPONS[p.w], now = Date.now();
    const rt = W.rate / ((p.cheat && p.cheat.rate) || 1), gap = now - p.last;   // jitter-tolerant gate: a shot that arrives up to 40% early still counts, and the schedule stays on the beat so the average rate never exceeds the gun's rate
    if (p.dead || inter || p.reloadAt || (!sub && gap < rt * .6)) return;
    if (W.spin) { if (now - (p.lastReq || 0) > 450) p.spinT = now; p.lastReq = now; if (now - p.spinT < W.spin) return; }   // minigun barrels still spinning up
    if (p.am[p.w] <= 0) { if (!sub) p.reloadAt = now + W.reload; return; }   // no auto-reload: pulling the trigger on an empty gun (or pressing R) starts it
    if (!sub) p.last = gap < rt * 1.6 ? p.last + rt : now;
    if (W.burst && !sub) { const wid = p.w; for (let k = 1; k < W.burst; k++) setTimeout(() => { if (p.w === wid && !p.dead && !inter) shoot(p, dir, true); }, k * W.burstGap); }
    if (!W.melee && !(p.cheat && p.cheat.ammo)) p.am[p.w]--;
    if (W.autoReload && p.am[p.w] === 0) p.reloadAt = now + W.reload;       // single-shot launcher reloads after every shot
    const o = [p.x, p.y + 1.7, p.z], outside = outsideXZ(p.x, p.z);
    if (W.melee) return melee(p, W, o, dir);
    if (W.rail) { const fr = W.charge && p.chStart ? Math.min(1, (now - p.chStart) / W.charge) : 0; p.chStart = 0; return rail(p, W, o, dir, outside, fr); }
    if (W.proj) return launch(p, W, o, dir);       // projectile weapons (the squid) fly instead of hitting instantly
    for (let i = 0; i < W.pellets; i++) {
      const d = norm(dir.map(v => v + (Math.random() - 0.5) * 2 * (p.cheat && p.cheat.nospread ? 0 : W.spread)));
      let tMax = outside ? W.range : Math.min(W.range, tankLimit(o, d));
      for (const b of COLS) { const t = rayBox(o, d, b, .06); if (t !== null && t < tMax) tMax = t; }   // coral is see-through for bullets
      let best = null, head = false;
      for (const q of players.values()) {
        if (q === p || q.dead || friendly(p, q) || (q.cheat && q.cheat.invis)) continue;
        const hp = hitPlayer(o, d, q, REWIND, false);
        if (hp && hp.t < tMax) { tMax = hp.t; best = q; head = hp.head; }
      }
      const fh = fishHit(o, d, tMax); if (fh) { tMax = fh.t; best = null; }      // shoot a fish and it floats to the surface
      const kh = kidHit(o, d, tMax); if (kh) { tMax = kh.t; best = null; }
      if (!best && !fh && !kh && W.crack && !outside && MAP.glass) { const gh = glassHit(o, d); if (gh && gh.t <= tMax + 1e-4) addCrack(gh, W.crack, p); }   // hit the glass: crack it
      const e = o.map((v, k) => v + d[k] * tMax);
      bcast({ t: 'shot', id: p.id, o, e, w: p.w });
      if (fh && !kh) killFish(fh.i, p);
      if (kh) hurtKid(p, W.dmg * (kh.head ? 1.5 : 1), kh.head);
      if (best) { const dm = W.fall && tMax > W.fall ? W.dmg - (W.dmg - W.dmgMin) * Math.min(1, (tMax - W.fall) / (W.range - W.fall)) : W.dmg; hurt(best, p, dm * (head ? 1.5 : 1), head); }   // the pistol loses damage past 22 m, down to 8 at its max range
      if (W.splash) splash(p, W, e, best);
    }
  }
  function meleeHit(o, d, q, reach) {              // swing = a wide cone, not a laser: any part of the body inside the arc within reach counts (same reach as before, measured to the body surface)
    const c = posAt(q, REWIND), J = q.jug ? 1.25 : 1, K = q.jug ? 1.45 : 1;
    let bestA = 9, bestT = null;
    for (const [h, r] of [[1.8, .5], [1.1, .68], [.45, .52], [1.45, .6]]) {   // head, chest, legs (+ upper chest)
      const v = [c[0] - o[0], c[1] + h * J - o[1], c[2] - o[2]], L = Math.hypot(v[0], v[1], v[2]), R = r * K * 1.25;
      const surf = L - R; if (surf > reach) continue;                     // out of reach
      const cos = (v[0] * d[0] + v[1] * d[1] + v[2] * d[2]) / (L || 1e-6), ang = Math.acos(Math.max(-1, Math.min(1, cos)));
      const lim = L <= R ? 3.2 : Math.min(1.2, Math.asin(Math.min(1, R / L)) + .42);   // ~24° of slack on top of the body's own size
      if (ang > lim) continue;
      if (ang < bestA) { bestA = ang; bestT = Math.max(0, surf); }
    }
    return bestT;
  }
  function melee(p, W, o, d) {                     // pool noodle swing: same reach, forgiving arc, walls block it
    let best = null, bt = W.range * ((p.cheat && p.cheat.reach) || 1), bd = 9;
    for (const q of players.values()) {
      if (q === p || q.dead || friendly(p, q) || (q.cheat && q.cheat.invis)) continue;
      const t = meleeHit(o, d, q, bt); if (t === null) continue;
      const c = posAt(q, REWIND), tgt = [c[0], c[1] + 1.2, c[2]], v = [tgt[0] - o[0], tgt[1] - o[1], tgt[2] - o[2]], L = Math.hypot(v[0], v[1], v[2]) || 1e-6, vd = v.map(x => x / L);
      let blocked = false; for (const b of COLS) { const tb = rayBox(o, vd, b, .06); if (tb !== null && tb < Math.max(0, L - .6)) { blocked = true; break; } }
      if (blocked) continue;
      const ang = Math.acos(Math.max(-1, Math.min(1, (vd[0] * d[0] + vd[1] * d[1] + vd[2] * d[2])))); if (ang < bd) { bd = ang; best = q; }
    }
    bcast({ t: 'melee', id: p.id, hit: !!best }); if (best) hurt(best, p, W.dmg, false);
  }
  function rail(p, W, o, d, outside, frac) {       // anglerfish longshot: instant beam through every diver in line, 30 dmg tapped up to 90 fully charged
    let tMax = outside ? W.range : Math.min(W.range, tankLimit(o, d));
    for (const b of COLS) { const t = rayBox(o, d, b, .06); if (t !== null && t < tMax) tMax = t; }
    const dmg = W.dmgMin + (W.dmg - W.dmgMin) * frac, hits = [];
    for (const q of players.values()) { if (q === p || q.dead || friendly(p, q) || (q.cheat && q.cheat.invis)) continue; const hp = hitPlayer(o, d, q, REWIND, false); if (hp && hp.t < tMax) hits.push([q, hp.head]); }
    if (!hits.length && !outside && MAP.glass) { const gh = glassHit(o, d); if (gh && gh.t <= tMax + 1e-4) addCrack(gh, W.crack * (.5 + frac), p); }
    bcast({ t: 'shot', id: p.id, o, e: o.map((v, k) => v + d[k] * tMax), w: p.w, rail: true, ch: +frac.toFixed(2) });
    let ks = 0; for (const [q, head] of hits) if (hurt(q, p, dmg * (head ? 1.5 : 1), head)) ks++; if (ks >= 2) stat(p, 'multi_rail', ks, true);
  }
  function splash(p, W, e, skip) {                 // area damage that fades with distance
    for (const q of players.values()) {
      if (q === skip || q.dead || friendly(p, q)) continue;               // the shooter is included: squid blasts hurt you too
      const dist = Math.hypot(q.x - e[0], q.y + 0.9 - e[1], q.z - e[2]);
      if (dist < W.splash) hurt(q, p, W.splashMin + (W.splashMax - W.splashMin) * (1 - dist / W.splash), false, e);   // 95 at the centre, 60 at the edge
    }
  }
  const projs = []; let nextPid = 1;
  function launch(p, W, o, dir) {
    const d = norm(dir.map(v => v + (Math.random() - 0.5) * 2 * W.spread)), dry = drained && MAP.glass, sp = dry ? W.proj * .3 : W.proj;   // no water in the tank: the squid only flops out a few metres and drops
    const pr = { pid: nextPid++, p, W, pos: o.slice(), v: d.map(x => x * sp), left: W.range, ttl: dry ? 3 : 12, dry };
    projs.push(pr); bcast({ t: 'proj', pid: pr.pid, id: p.id, o, d, speed: sp, w: p.w, dry });
  }
  const inTank = q => !outsideXZ(q[0], q[2]) && q[1] <= ARENA.h;
  function stepProjs(dt) {                         // the tank is open on top: aim a squid up through the surface and it arcs out into the room
    for (let i = projs.length - 1; i >= 0; i--) {
      const pr = projs[i], W = pr.W;
      if (pr.dry) {                                  // dry squid: ballistic, harmless, ends as a flopping squid on the floor
        pr.v[1] -= 18 * dt; pr.ttl -= dt; const np = pr.pos.map((v, k) => v + pr.v[k] * dt); pr.pos = np;
        if (np[1] <= .3 || pr.ttl <= 0 || Math.abs(np[0]) > ARENA.x || Math.abs(np[2]) > ARENA.z) { np[1] = Math.max(.3, Math.min(np[1], ARENA.h)); bcast({ t: 'pop', pid: pr.pid, e: np.map(v => +v.toFixed(2)), dry: true }); projs.splice(i, 1); }
        continue;
      }
      const wasIn = inTank(pr.pos);
      if (!wasIn) pr.v[1] -= 18 * dt;                // out of the water: real gravity
      const sp = Math.hypot(...pr.v), d = pr.v.map(x => x / sp), len = sp * dt;
      let tMax = len, hit = null, head = false, hitWall = false, fishI = null;
      if (wasIn) {
        tMax = Math.min(tMax, tankLimit(pr.pos, d, true)); hitWall = tMax < len;
        for (const b of COLS) { const t = rayBox(pr.pos, d, b, .06); if (t !== null && t < tMax) { tMax = t; hitWall = true; } }
        for (const q of players.values()) {
          if (q === pr.p || q.dead || friendly(pr.p, q)) continue;
          const hp = hitPlayer(pr.pos, d, q, 0, true); if (hp && hp.t < tMax) { tMax = hp.t; hit = q; head = hp.head; hitWall = false; }
        }
        const fh = fishHit(pr.pos, d, tMax); if (fh) { tMax = fh.t; fishI = fh.i; hit = null; hitWall = true; }
      }
      const kh = kidHit(pr.pos, d, tMax); if (kh) { tMax = kh.t; hit = null; fishI = null; hitWall = true; }   // squids can hit the kid too
      if (wasIn && hit === null && fishI === null && !kh && W.crack && hitWall) { const gh = glassHit(pr.pos, d); if (gh && gh.t <= tMax + 1e-4) addCrack(gh, W.crack, pr.p); }   // a squid smacking the glass makes a big crack
      const e = pr.pos.map((v, k) => v + d[k] * tMax);
      if (wasIn) pr.left -= tMax; else pr.ttl -= dt;
      let boom = !!hit || hitWall || pr.left <= 0.01 || pr.ttl <= 0;
      if (!wasIn) { const fl = Math.abs(e[0]) < ARENA.x + 6 && Math.abs(e[2]) < ARENA.z + 5 ? -0.2 : -16.5; if (e[1] <= fl) { e[1] = fl; boom = true; } }   // lands on the desk or the bedroom floor
      if (boom) {
        if (hit) hurt(hit, pr.p, W.dmg * (head ? 1.5 : 1), head);                 // a body hit is an instant kill
        if (fishI !== null) killFish(fishI, pr.p);
        if (kh) hurtKid(pr.p, W.dmg * (kh.head ? 1.5 : 1), kh.head);
        splash(pr.p, W, e, hit); bcast({ t: 'pop', pid: pr.pid, e }); projs.splice(i, 1);
      } else { pr.pos = e; if (!wasIn && inTank(e)) pr.v = pr.v.map(x => x * 0.6); }   // splashes back into the water
    }
  }
  setInterval(() => stepProjs(0.033), 33);
  
  setInterval(() => {                                // 20 Hz world snapshot
    const now = Date.now();
    for (const p of players.values()) { if (p.reloadAt && now >= p.reloadAt) { p.am[p.w] = WEAPONS[p.w].mag; p.reloadAt = 0; } if (p.harp && now >= p.harp.until) harpEnd(p); if (p.dead && p.harp) harpEnd(p); }
    const list = [...players.values()].map(p => ({ id: p.id, n: p.name, x: p.x, y: p.y, z: p.z, yw: p.yaw, pt: p.pitch, hp: p.hp, w: p.w, k: p.kills, d: p.deaths, sc: p.kills, dead: p.dead, sp: p.sp || null, lv: p.lv, c: p.eq, rl: !!p.reloadAt, inv: !!(p.cheat && p.cheat.invis), tm: teamOf(p), gl: MODE === 'gungame' ? (p.gl | 0) : undefined, jg: p.jug ? 1 : undefined, fc: p.face || undefined }));
    bcast({ t: 'snap', p: list, ts: MODE === 'tdm' ? TEAMK : undefined });
    for (const p of players.values()) send(p.ws, { t: 'me', hp: p.hp, w: p.w, ammo: p.am[p.w], rel: !!p.reloadAt, sp: p.sp || null, base: p.base || null, gl: MODE === 'gungame' ? (p.gl | 0) : undefined, gk: MODE === 'gungame' ? (p.gk | 0) : undefined, hpm: hpMax(p) });
  }, 50);
  
  function attach(ws) { clients.add(ws); ws.room = room;
    send(ws, { t: 'welcome', id: ws.pid, room: roomInfo(), weapons: WEAPONS, obst: OBST, arena: ARENA, geysers: GEYSERS, fish: FISH, map: mapPayload(), pad: padMsg(), emotes: EMOTES, achs: ACHS, st: srvT(), cos: ITEMS, rar: RARITY, gid: GOOGLE_ID, pay: !!PAY.key, drained, drainFace, cracks: CRACKS, match: { end: (matchEnd - T0) / 1000, inter, next: (interEnd - T0) / 1000, mode: MODE, modeName: MODES[MODE].name, gg: GG, jug: JUG.on ? { id: JUG.id, name: JUG.name, hp: JUG_HP } : null, votes: inter ? tally() : null, opts: inter ? voteOpts() : null } }); }
  function detach(ws) { clients.delete(ws); if (ws.room === room) ws.room = null; const gone = players.get(ws.pid); players.delete(ws.pid); if (VOTES.delete(ws.pid) && inter) bcast(voteMsg()); if (JUG.on && gone) { if (gone.id === JUG.id) jugEnd('players'); else jugCheck(); } }
  function onMessage(ws, m) {
      let p = players.get(ws.pid);
      if (m.t === 'auth') return auth(ws, m);
      if (m.t === 'logout') { ws.acct = null; return; }
      if (m.t === 'equip') return equip(ws, m);
      if (m.t === 'shop') return shopSend(ws);
      if (m.t === 'buy') return buy(ws, m);
      if (m.t === 'google') return googleLogin(ws, m);
      if (m.t === 'qreq') { const a = ws.acct && ACC[ws.acct]; if (a) { qEnsure(a); qSend(a, ws, true); } return; }
      if (m.t === 'admin') return admin(ws, m);
      if (m.t === 'face') { const f = m.f === 'logan' || m.f === 'alissa' ? m.f : ''; ws.face = f; if (p) p.face = f; return; }   // secret cosmetic: a friend's face on the helmet porthole
      if (m.t === 'join') {                          // first dive, or a re-dive after being popped
        const w = WEAPONS[m.w] && !WEAPONS[m.w].pad ? m.w : 'pistol', a = ws.acct ? ACC[ws.acct] : null, name = a ? a.user : String(m.name || 'Diver').slice(0, 14);
        const who = { name, w, base: w, face: ws.face || '', acct: ws.acct || null, eq: a ? a.eq : {}, lv: a ? levelOf(a.xp).level : 0 };
        if (!p && players.size >= MAX_PLAYERS) { send(ws, { t: 'full', room: roomInfo() }); return; }
      if (!p) { p = Object.assign({ id: ws.pid, ws, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hp: 100, am: {}, reloadAt: 0, last: 0, kills: 0, deaths: 0, dead: false, safe: 0, boostAt: 0, lastHit: null, sc: 0, gl: 0, gk: 0, team: smallTeam() }, who); players.set(p.id, p);
          if (JUG.on) { p.dead = true; send(ws, { t: 'spec', why: 'jug' }); return; }   // nobody joins the fight during the Juggernaut event: they get to watch
          if (MODE === 'gungame') { const lv = [...players.values()].filter(q => q !== p).map(q => q.gl | 0); p.gl = lv.length ? Math.min(...lv) : 0; }   // late joiners start level with the weakest player
          spawn(p); }
        else if (p.dead) { if (JUG.on && !p.jugOK) { send(ws, { t: 'spec', why: 'jug' }); return; } p.sp = null; Object.assign(p, who); spawn(p); }
        return;
      }
      if (m.t === 'vote') { if (!inter) return; const v = VOTES.get(ws.pid) || {}; if (VOTEOPTS.maps.includes(m.map)) v.map = m.map; if (VOTEOPTS.modes.includes(m.mode)) v.mode = m.mode; VOTES.set(ws.pid, v); bcast(voteMsg()); return; }
      if (!p) return;
      if (m.t === 'state' && !p.dead && [m.x, m.y, m.z, m.yaw, m.pitch].every(Number.isFinite)) {
        let x0 = -ARENA.x + 0.5, x1 = ARENA.x - 0.5, z0 = -ARENA.z + 0.5, z1 = ARENA.z - 0.5, y0 = 0;
        if (drained && ARENA.round && MAP.glass) { x0 = z0 = -1e3; x1 = z1 = 1e3; y0 = -16.5; }   // broken bowl: the open pane lets you walk out onto the counter (and off its edge)
        else if (drained) {                               // the broken side is open: you can climb out onto the desk (and fall off it)
          const fx = drainFace[0] === 'x', sg = drainFace[1] === '+' ? 1 : -1, out = fx ? sg * m.x > ARENA.x - 0.5 : sg * m.z > ARENA.z - 0.5; y0 = -16.5;
          if (fx) { if (sg > 0) x1 = 1e3; else x0 = -1e3; if (out) { z0 = -1e3; z1 = 1e3; } } else { if (sg > 0) z1 = 1e3; else z0 = -1e3; if (out) { x0 = -1e3; x1 = 1e3; } }
        }
        p.x = Math.max(x0, Math.min(x1, m.x)); p.z = Math.max(z0, Math.min(z1, m.z)); p.y = Math.max(y0, Math.min(ARENA.h - 2, m.y)); p.yaw = m.yaw; p.pitch = m.pitch;
        if (ARENA.round) { const r = Math.hypot(p.x, p.z), R = ARENA.x - .5, open = drained && MAP.glass; if (r < R - 1) p.out = false; else if (open && r > R && (p.out || roundFace(p.x, p.z).face === drainFace)) p.out = true; if (r > R && !(open && p.out)) { p.x *= R / r; p.z *= R / r; } }
        const nowT = Date.now(); (p.hist || (p.hist = [])).push({ t: nowT, x: p.x, y: p.y, z: p.z }); while (p.hist.length > 2 && p.hist[0].t < nowT - 700) p.hist.shift();
        if (drained && MAP.glass && p.y <= -16 && (ARENA.round || Math.abs(p.x) > ARENA.x || Math.abs(p.z) > ARENA.z)) fallDeath(p);
      } else if (m.t === 'shoot' && Array.isArray(m.dir) && m.dir.length === 3 && m.dir.every(Number.isFinite)) shoot(p, norm(m.dir));
      else if (m.t === 'charge') { const W = WEAPONS[p.w]; p.chStart = W.charge && !p.dead && !p.reloadAt && p.am[p.w] > 0 && !inter ? Date.now() : 0; }
      else if (m.t === 'emote') { const e = EMOTES.find(x => x.id === m.e), now = Date.now(); if (e && !p.dead && (p.lv || 0) >= e.lvl && now - (p.emoAt || 0) > 1200) { p.emoAt = now; bcast({ t: 'emote', id: p.id, e: e.id }); stat(p, 'emotes'); } }
      else if (m.t === 'suicide' && !p.dead) { stat(p, 'suicides'); const la = p.lastHit && Date.now() - p.lastHit.t < 10000 && players.get(p.lastHit.id); p.safe = 0; hurt(p, la || p, 9999, false); }   // K: the last player to hit you gets the pop
      else if (m.t === 'boost' && !p.dead && !(drained && MAP.glass) && Date.now() >= p.boostAt) { p.boostAt = Date.now() + WEAPONS[p.w].boost * 1000 - 300; bcast({ t: 'boost', id: p.id }); }
      else if (m.t === 'harp' && Array.isArray(m.dir) && m.dir.length === 3 && m.dir.every(Number.isFinite)) harpoon(p, m.dir);
      else if (m.t === 'harpend') harpEnd(p);
      else if (m.t === 'reload' && !p.reloadAt && p.am[p.w] < WEAPONS[p.w].mag) p.reloadAt = Date.now() + WEAPONS[p.w].reload;
  }
  const room = { grantSD, code, pub, clients, players, attach, detach, onMessage, info: roomInfo, destroy: () => timers.forEach(clearInterval), dbg: { players, hurt, spawn, get FISH() { return FISH; }, killFish: i => killFish(i), addCrack: (...a) => addCrack(...a), glassHit: (...a) => glassHit(...a), setMap: id => setMap(id), mapPayload: () => mapPayload(), MAPS, get crackTotal() { return crackTotal; }, get SPAWNS() { return SPAWNS; }, drainNow: () => forceDrain('z+'), jugNow: p => jugStart(p), endNow: () => endMatch(), get MODE() { return MODE; }, get mapId() { return MAPID; }, get TEAMK() { return TEAMK; }, get ARENA() { return ARENA; }, lidBars: () => lidBars(ARENA) } };
  return room;
}


const send = (ws, m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
// ---------- lobby: 4 public tanks and private rooms with a 4-character code ----------
for (let i = 1; i <= PUBLIC_ROOMS; i++) rooms.set('P' + i, makeRoom('P' + i, true));
const roomList = () => [...rooms.values()].filter(r => r.pub).map(r => r.info());
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() { for (;;) { let c = ''; for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; if (!rooms.has(c)) return c; } }
function pickPublic() { const l = [...rooms.values()].filter(r => r.pub), open = l.filter(r => r.players.size < MAX_PLAYERS); return (open.sort((a, b) => b.players.size - a.players.size)[0]) || l[0]; }   // fill the busiest tank that still has space so friends end up together
function moveTo(ws, room) { if (ws.room === room) return; const old = ws.room; if (old) { old.detach(ws); gcRoom(old); } room.attach(ws); }
function gcRoom(r) { if (r.pub || r.clients.size) return; setTimeout(() => { if (!r.clients.size && rooms.get(r.code) === r) { r.destroy(); rooms.delete(r.code); } }, 30000); }
wss.on('connection', ws => {
  ws.pid = nextId++; moveTo(ws, pickPublic());
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'rooms') return send(ws, { t: 'rooms', list: roomList(), cur: ws.room && ws.room.code });
    if (m.t === 'room') {                          // {mode:'public', code:'P2'} | {mode:'create'} | {mode:'join', code:'ABCD'}
      let target = null;
      if (m.mode === 'create') { const c = newCode(); target = makeRoom(c, false); rooms.set(c, target); }
      else { const c = String(m.code || '').toUpperCase().trim(); target = rooms.get(c); if (!target || (m.mode === 'public' && !target.pub)) return send(ws, { t: 'roomerr', error: 'No room with that code.' }); }
      moveTo(ws, target); return;
    }
    if (ws.room) ws.room.onMessage(ws, m);
  });
  ws.on('close', () => { const r = ws.room; if (r) { r.detach(ws); gcRoom(r); } });
});

server.listen(process.env.PORT || 3000, () => console.log('Fishtank.io running on port ' + (process.env.PORT || 3000)));
