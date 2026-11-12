'use strict';
// Runway Digital Twin simulation - game engine (pure logic, no I/O).
const crypto = require('crypto');

const C = {
  MAX_ROOMS: 8, START_ROOMS: 4, SESSION: 1200, FIRST: 30, READY: 60, APPROACH: 60, EMERG_APPROACH: 45,
  PTS: { ok: 10, emerg: 20, abortWrong: -5, abortRight: 10, declWrong: -5, crash: -20 },
};

const ROLES = [
  { id: 'atc', name: 'ATC Controller', job: 'Answers every aircraft call: ACCEPT or DECLINE the runway within 60 seconds. Owns the final go / no-go decision.' },
  { id: 'monitor', name: 'Sensor Monitor', job: 'Watches all sensor panels and trends. Runs a CROSS-CHECK against a reference instrument to prove whether a sensor is telling the truth.' },
  { id: 'analyst', name: 'Data Quality Analyst', job: 'Filters the data: switches SMOOTHING on to remove spikes, and FLAGS a faulty sensor so it is excluded from the runway assessment.' },
  { id: 'maint', name: 'Maintenance Engineer', job: 'RECALIBRATES faulty sensors and sends crews to the runway: inspect, de-ice, plough snow, sweep debris, repair lights.' },
  { id: 'weather', name: 'Weather Officer', job: 'Requests a MANUAL WEATHER OBSERVATION from a human observer to confirm what the weather really is and when it will change.' },
  { id: 'comms', name: 'Communicator', job: 'Talks to the aircraft: requests a PILOT REPORT and transmits GO-AROUND / ABORT when the runway becomes unsafe.' },
];
const LEVEL = { easy: 0.5, normal: 1, hard: 1.7 }; // difficulty: scales hazards and sensor faults
const NATO = { A: 'Alfa', D: 'Delta', E: 'Echo', I: 'India', L: 'Lima', M: 'Mike', N: 'November', O: 'Oscar', Q: 'Quebec', S: 'Sierra', T: 'Tango', W: 'Whiskey' };
const NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'niner'];
const spoken = cs => cs.split('').map(c => NATO[c] || NUM[+c] || c).join(' '); // DTW456 -> Delta Tango Whiskey four five six
const ACT_ROLE = { respond: 'atc', abort: 'comms', pirep: 'comms', xcheck: 'monitor', smooth: 'analyst', flag: 'analyst', recal: 'maint', work: 'maint', observe: 'weather' };

const rnd = (a, b) => a + Math.random() * (b - a);
const ri = (a, b) => Math.floor(rnd(a, b + 1));
const pick = a => a[Math.floor(Math.random() * a.length)];
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Sensor definitions. tv = true value, haz = fault pushing reading toward "hazard", safe = fault hiding a hazard.
const S = {
  cam: { name: 'Runway Camera (CCTV)', unit: '% reflectivity', dec: 0, jit: 3, min: 0, max: 100, thr: 70,
    tv: r => ({ dry: 12, wet: 50, ice: 78, snow: 93 })[r.truth.surface], haz: v => Math.max(v, 50) + 30, safe: v => Math.min(v, 50) },
  hum: { name: 'Humidity Sensor', unit: '% RH', dec: 0, jit: 2, min: 0, max: 100, thr: null,
    tv: r => r.truth.hum, haz: v => v + 35, safe: v => v - 35 },
  st: { name: 'Surface Temperature Sensor', unit: '°C', dec: 1, jit: 0.5, min: -15, max: 20, thr: 0,
    tv: r => r.truth.surfT, haz: v => v - 6, safe: v => v + 6 },
  fp: { name: 'Freezing Point & Solution Sensor', unit: 'mm ice', dec: 1, jit: 0.08, min: 0, max: 3, thr: 0.5,
    tv: r => r.truth.surface === 'ice' ? 1.6 : 0, haz: v => Math.max(v, 1.3), safe: () => 0 },
  tr: { name: 'Transmissometer (RVR)', unit: 'm', dec: 0, jitRel: 0.06, min: 0, max: 2000, thr: 550,
    tv: r => Math.min(r.truth.vis, 2000), haz: v => Math.min(v, 300), safe: v => v + 1500 },
  fs: { name: 'Forward-Scatter Visibility Sensor', unit: 'm', dec: 0, jitRel: 0.06, min: 0, max: 10000, thr: 550,
    tv: r => r.truth.vis, haz: v => Math.min(v, 280), safe: v => v + 4000 },
  ws: { name: 'Weather Station (AWOS) - crosswind', unit: 'kt', dec: 0, jit: 2.2, min: 0, max: 60, thr: 30,
    tv: r => r.truth.xw, haz: v => v + 26, safe: v => Math.max(0, v - 30) },
  smr: { name: 'Surface Movement Radar / MLAT', unit: 'targets', dec: 0, jit: 0, min: 0, max: 3, thr: 0.5,
    tv: r => (r.truth.obstruction ? 1 : 0) + (r.job ? 1 : 0) + (r.wreckUntil ? 1 : 0), haz: v => v + 1, safe: () => 0 },
};
const SIDS = Object.keys(S);
const FAULT_LABEL = { spike: 'random spikes', biasHaz: 'false alarm (bias / contamination / glare)', biasSafe: 'under-reading (hides a hazard)', stuck: 'stuck / frozen value', dropout: 'data dropout' };
const WORK = {
  inspect: { d: 15, label: 'Runway inspection' }, deice: { d: 8, label: 'De-icing' }, plow: { d: 10, label: 'Snow ploughing' },
  sweep: { d: 10, label: 'Debris sweep / runway clearing' }, lights: { d: 5, label: 'Lighting repair' },
};

function alarmOf(id, x) {
  if (x == null) return null;
  if (id === 'cam') return x >= 86 ? 'SNOW' : x >= 70 ? 'ICE' : null;
  if (id === 'fp') return x >= 0.5 ? 'ICE' : null;
  if (id === 'tr' || id === 'fs') return x < 550 ? 'LOW VISIBILITY' : null;
  if (id === 'ws') return x > 30 ? 'CROSSWIND' : null;
  if (id === 'smr') return x >= 0.5 ? 'OBSTRUCTION' : null;
  return null;
}
const shown = s => s.hist.length ? s.hist[s.hist.length - 1] : null;
const camSeesObject = r => r.truth.obstruction && r.truth.vis >= 550 && shown(r.sensors.cam) != null;

function autoHaz(r) { // what the sensors (after the team's filtering) claim
  const h = new Set();
  for (const id of SIDS) { const s = r.sensors[id]; if (s.flagged) continue; const a = alarmOf(id, shown(s)); if (a) h.add(a); }
  if (!r.sensors.cam.flagged && camSeesObject(r)) h.add('OBSTRUCTION');
  if (!r.truth.lights) h.add('LIGHTING FAILURE');
  if (r.job) h.add('RUNWAY WORK');
  if (r.wreckUntil) h.add('WRECKAGE');
  return [...h];
}
function truthHaz(r) { // what is really happening
  const h = [], w = r.truth;
  if (w.vis < 550) h.push('LOW VISIBILITY');
  if (w.surface === 'ice') h.push('ICE');
  if (w.surface === 'snow') h.push('SNOW');
  if (w.xw > 30) h.push('CROSSWIND');
  if (w.obstruction) h.push('OBSTRUCTION');
  if (!w.lights) h.push('LIGHTING FAILURE');
  if (r.job) h.push('RUNWAY WORK');
  if (r.wreckUntil) h.push('WRECKAGE');
  return h;
}

function newWeather(r, t, calm) { // calm = chance to replace hazardous weather with clear
  const w = r.truth;
  let wx = pick(['clear', 'clear', 'clear', 'clear', 'clear', 'clear', 'rain', 'rain', 'rain', 'fog', 'snow', 'wind']);
  if (calm && wx !== 'clear' && wx !== 'rain' && Math.random() < calm) wx = 'clear';
  w.wx = wx; w.wxUntil = t + (wx === 'clear' || wx === 'rain' ? ri(70, 130) : ri(40, 70)); w.precip = 'none';
  if (wx === 'clear') { w.vis = ri(9000, 10000); w.hum = ri(40, 60); w.xw = ri(3, 12); w.airT = ri(-2, 12); }
  if (wx === 'wind') { w.vis = ri(8000, 10000); w.hum = ri(40, 60); w.xw = ri(33, 45); w.airT = ri(-2, 12); }
  if (wx === 'rain') { w.vis = ri(3000, 6000); w.hum = ri(85, 93); w.xw = ri(5, 18); w.precip = 'rain';
    if (!calm && Math.random() < 0.2) { w.airT = ri(-3, -1); w.surface = 'ice'; w.wx = 'freezing rain'; } else { w.airT = ri(2, 9); } }
  if (wx === 'fog') { w.vis = ri(150, 450); w.hum = ri(97, 100); w.xw = ri(0, 5); w.airT = ri(0, 5); }
  if (wx === 'snow') { w.vis = ri(900, 2000); w.hum = ri(85, 95); w.xw = ri(4, 15); w.airT = ri(-7, -1); w.precip = 'snow'; w.surface = 'snow'; }
  if ((w.surface === 'ice' || w.surface === 'snow') && w.airT >= 4 && wx !== 'snow') w.surface = 'wet';
  if (w.surface === 'dry' && (wx === 'rain' || wx === 'fog')) w.surface = 'wet';
  if (w.surface === 'wet' && (wx === 'clear' || wx === 'wind')) w.surface = 'dry';
  w.surfT = w.airT - 1;
  if (w.surface === 'ice' || w.surface === 'snow') w.surfT = Math.min(w.surfT, -1);
}

function sample(r, id, t) {
  const d = S[id], s = r.sensors[id], v = d.tv(r), f = s.fault;
  const j = () => gauss() * (d.jitRel ? d.jitRel * v : d.jit);
  let raw = v + j();
  if (s.cal) raw = null;
  else if (f) {
    if (f.type === 'spike') { if (Math.random() < 0.25) raw = d.haz(v); }
    else if (f.type === 'biasHaz') raw = d.haz(v) + j();
    else if (f.type === 'biasSafe') raw = d.safe(v) + j();
    else if (f.type === 'stuck') raw = f.frozen;
    else if (f.type === 'dropout') raw = null;
  } else if (Math.random() < 0.025) raw = d.haz(v); // even a healthy sensor glitches now and then: one-sample outlier
  if (raw != null) { raw = clamp(raw, d.min, d.max); if (id === 'smr') raw = Math.round(raw); }
  s.raw.push(raw); if (s.raw.length > 40) s.raw.shift();
  let out = raw;
  const lvl = Number(s.smooth) || 0; // 0 = off ... 4 = full; window of 3, 5, 7, 9 samples
  if (lvl && raw != null) {
    const w = s.raw.slice(-(1 + 2 * lvl)).filter(x => x != null).sort((a, b) => a - b);
    out = w[Math.floor(w.length / 2)];
  }
  if (lvl && raw != null && alarmOf(id, raw) && !alarmOf(id, out)) s.removed = (s.removed || 0) + 1; // false spike kept out of the assessment
  s.hist.push(out); if (s.hist.length > 40) s.hist.shift();
}

function newRoom(n) {
  const r = { n, truth: { surface: 'dry', obstruction: null, lights: true }, sensors: {}, nextFault: ri(60, 80), job: null, wreckUntil: 0,
    xc: null, obs: null, obsNext: 0, pirepNext: 0, crit: null, log: [], score: 0, assigned: null, lastOp: null,
    stats: { success: 0, crash: 0, goRight: 0, goWrong: 0, declWrong: 0, declRight: 0, emerg: 0 },
    dq: { match: 0, total: 0 }, faults: 0, fixed: 0 };
  for (const id of SIDS) r.sensors[id] = { fault: null, raw: [], hist: [], smooth: false, flagged: false, cal: 0 };
  newWeather(r, 0, 1); // every runway starts safe: warm-up for the first aircraft
  for (let i = 0; i < 20; i++) for (const id of SIDS) sample(r, id, 0);
  return r;
}

function create() {
  const st = { level: 'normal', status: 'lobby', t: 0, acc: 0, lastTick: 0, participants: {}, rooms: [], aircraft: [], nextSpawn: C.FIRST, acSeq: 0, kind: 'landing', events: [], evSeq: 0, radio: [] };
  for (let n = 1; n <= C.MAX_ROOMS; n++) st.rooms.push(newRoom(n));
  return st;
}
function resetGame(st, wipe) {
  const p = wipe ? {} : st.participants, lvl = st.level, f = create();
  Object.assign(st, f, { participants: p, level: lvl || 'normal' });
}

const members = (st, n) => Object.values(st.participants).filter(p => p.room === n);
const activeRooms = st => st.rooms.filter(r => members(st, r.n).length > 0);
function openCount(st) {
  let o = C.START_ROOMS;
  while (o < C.MAX_ROOMS && st.rooms.slice(0, o).every(r => members(st, r.n).length >= ROLES.length)) o++;
  return o;
}
const fmt = t => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
function log(st, r, m, c) { r.log.push({ t: fmt(st.t), m, c: c || '' }); if (r.log.length > 40) r.log.shift(); }
function radio(st, m, c) { st.radio.push({ t: fmt(st.t), m, c: c || '' }); if (st.radio.length > 30) st.radio.shift(); }
function event(st, type, room, say) { st.events.push({ seq: ++st.evSeq, type, room, say: say || '' }); if (st.events.length > 40) st.events.shift(); }
const acById = (st, id) => st.aircraft.find(a => a.id === id);

function inject(st, r, id, type) {
  const s = r.sensors[id];
  type = type || pick(['spike', 'spike', 'spike', 'biasHaz', 'biasHaz', 'biasHaz', 'biasSafe', 'biasSafe', 'stuck', 'stuck', 'dropout']);
  s.fault = { type, since: st.t };
  if (type === 'stuck') { const last = s.raw.filter(x => x != null).pop(); s.fault.frozen = last != null ? last : S[id].tv(r); }
  if (type === 'dropout') s.fault.until = st.t + ri(15, 25);
  r.faults++;
}

function stepRoom(st, r) {
  const t = st.t, w = r.truth, f = LEVEL[st.level] || 1;
  if (t >= w.wxUntil && !r.assigned) newWeather(r, t, f < 1 ? 0.5 : 0); // weather holds steady during an approach
  if (!w.obstruction && t > 120 && Math.random() < f / 420) w.obstruction = pick(['debris (FOD)', 'a stray vehicle', 'wildlife']);
  if (w.lights && t > 150 && Math.random() < f / 900) { w.lights = false; log(st, r, 'Lighting monitor: runway edge lights FAILED. Repair needed.', 'bad'); }
  if (r.wreckUntil && t >= r.wreckUntil) { r.wreckUntil = 0; log(st, r, 'Wreckage removed. Runway released.', 'ok'); }
  // sensor faults
  if (t >= r.nextFault) {
    const healthy = SIDS.filter(id => !r.sensors[id].fault && !r.sensors[id].cal);
    if (SIDS.length - healthy.length < (f < 1 ? 1 : f > 1 ? 3 : 2) && healthy.length) inject(st, r, pick(healthy));
    r.nextFault = t + Math.round(ri(45, 75) / f);
  }
  // critical moment during an approach: a real hazard or a false alarm
  if (r.crit && t >= r.crit.at) {
    if (r.assigned) {
      if (r.crit.real) { if (!w.obstruction) w.obstruction = pick(['a vehicle incursion', 'wildlife', 'debris (FOD)']); }
      else { const id = pick(['smr', 'tr', 'fp', 'ws']); if (!r.sensors[id].cal) inject(st, r, id, 'biasHaz'); }
    }
    r.crit = null;
  }
  for (const id of SIDS) {
    const s = r.sensors[id];
    if (s.fault && s.fault.until && t >= s.fault.until) s.fault = null;
    if (s.cal && t >= s.cal) { s.cal = 0; if (s.fault) r.fixed++; s.fault = null; s.raw = []; log(st, r, S[id].name + ': recalibration complete.', 'ok'); }
  }
  if (r.job && t >= r.job.until) {
    const k = r.job.type; r.job = null;
    if (k === 'deice') { if (w.surface === 'ice') { w.surface = 'wet'; log(st, r, 'De-icing complete: ice removed.', 'ok'); } else log(st, r, 'De-icing complete: crew found NO ice. Time wasted.', 'warn'); }
    if (k === 'plow') { if (w.surface === 'snow') { w.surface = 'wet'; log(st, r, 'Ploughing complete: snow removed.', 'ok'); } else log(st, r, 'Plough crew found NO snow. Time wasted.', 'warn'); }
    if (k === 'sweep') { if (w.obstruction) { log(st, r, 'Runway cleared: removed ' + w.obstruction + '.', 'ok'); w.obstruction = null; } else log(st, r, 'Sweep complete: runway was already clear. Time wasted.', 'warn'); }
    if (k === 'lights') { if (!w.lights) { w.lights = true; log(st, r, 'Runway lights repaired.', 'ok'); } else log(st, r, 'Lights were already working. Time wasted.', 'warn'); }
    if (k === 'inspect') log(st, r, 'Inspection report: surface is ' + w.surface.toUpperCase() + '; ' + (w.obstruction ? 'FOUND ' + w.obstruction + ' on the runway.' : 'no objects on the runway.'), 'info');
    event(st, 'workdone', r.n);
  }
  if (r.xc && t >= r.xc.until) {
    const id = r.xc.sensor, d = S[id], s = r.sensors[id], ref = d.tv(r); r.xc = null;
    const rec = s.hist.slice(-5).filter(x => x != null).sort((a, b) => a - b), sh = rec.length ? rec[Math.floor(rec.length / 2)] : null;
    const tol = Math.max((d.max - d.min) * 0.08, d.jitRel ? ref * 0.22 : d.jit * 3.5);
    if (sh == null) log(st, r, 'Cross-check ' + d.name + ': sensor gives no data; reference reads ' + ref.toFixed(d.dec) + ' ' + d.unit + '.', 'info');
    else if (Math.abs(sh - ref) > tol) log(st, r, 'Cross-check ' + d.name + ': DISAGREES. Sensor shows ' + sh.toFixed(d.dec) + ', reference reads ' + ref.toFixed(d.dec) + ' ' + d.unit + '.', 'bad');
    else log(st, r, 'Cross-check ' + d.name + ': agrees with reference (' + ref.toFixed(d.dec) + ' ' + d.unit + ').', 'ok');
  }
  if (r.obs && t >= r.obs.until) {
    r.obs = null;
    log(st, r, 'Observer report: ' + w.wx.toUpperCase() + ', visibility about ' + (w.vis >= 1000 ? (w.vis / 1000).toFixed(1) + ' km' : w.vis + ' m') + ', crosswind about ' + w.xw + ' kt, air temp ' + w.airT + ' °C. Next weather change in about ' + Math.max(5, Math.round((w.wxUntil - t) / 10) * 10) + ' s.', 'info');
  }
  if (t % 2 === 0) for (const id of SIDS) sample(r, id, t);
  r.dq.total++;
  if ((autoHaz(r).length === 0) === (truthHaz(r).length === 0)) r.dq.match++;
}

function assign(st, ac, r) {
  ac.state = 'assigned'; ac.room = r.n; ac.assignT = st.t; ac.resolveAt = st.t + (ac.emergency ? C.EMERG_APPROACH : C.APPROACH);
  r.assigned = ac.id;
  const roll = Math.random();
  const f = LEVEL[st.level] || 1;
  r.crit = roll < 0.37 * f ? { at: st.t + ri(20, ac.emergency ? 30 : 42), real: roll < 0.12 * f } : null;
  const verb = ac.kind === 'landing' ? 'cleared to land' : 'cleared for take-off';
  radio(st, (ac.emergency ? 'MAYDAY ' : '') + ac.cs + ' ' + verb + ' on Runway ' + r.n + '.', ac.emergency ? 'bad' : 'info');
  log(st, r, ac.cs + ' is ' + verb + ' on YOUR runway. Operation in ' + (ac.resolveAt - st.t) + ' s. Keep watching the sensors.', 'info');
  event(st, 'approach', r.n, 'Runway ' + r.n + ' control room. ' + spoken(ac.cs) + ' is ' + verb + ' on your runway. ' + (ac.kind === 'landing' ? 'Touchdown' : 'Departure') + ' in ' + (ac.resolveAt - st.t) + ' seconds. Monitor your sensors.');
}
function finish(st, ac, outcome) { ac.state = 'done'; ac.outcome = outcome; }

function resolve(st, ac) {
  const r = st.rooms[ac.room - 1], bad = truthHaz(r);
  r.assigned = null; r.crit = null;
  r.lastOp = { kind: ac.kind, cs: ac.cs, at: st.t, outcome: bad.length ? 'crash' : 'success' };
  if (!bad.length) {
    const pts = ac.emergency ? C.PTS.emerg : C.PTS.ok;
    r.score += pts; r.stats.success++; if (ac.emergency) r.stats.emerg++;
    log(st, r, ac.cs + (ac.kind === 'landing' ? ' landed safely' : ' departed safely') + '. +' + pts + ' points.', 'ok');
    radio(st, ac.cs + (ac.kind === 'landing' ? ' landed safely on Runway ' : ' departed safely from Runway ') + r.n + '.', 'ok');
    event(st, ac.kind === 'landing' ? 'land' : 'takeoff', r.n); finish(st, ac, 'success');
  } else {
    r.score += C.PTS.crash; r.stats.crash++; r.wreckUntil = st.t + 20;
    log(st, r, 'ACCIDENT: ' + ac.cs + ' crashed. Actual runway condition: ' + bad.join(', ') + '. ' + C.PTS.crash + ' points. Runway blocked for 20 s.', 'bad');
    radio(st, 'ACCIDENT on Runway ' + r.n + ': ' + ac.cs + ' (' + bad.join(', ') + ').', 'bad');
    event(st, 'crash', r.n); finish(st, ac, 'crash');
  }
}

function abort(st, r) {
  const ac = acById(st, r.assigned), bad = truthHaz(r);
  const p = (st.t - ac.assignT) / (ac.resolveAt - ac.assignT);
  r.assigned = null; r.crit = null;
  r.lastOp = { kind: ac.kind, cs: ac.cs, at: st.t, outcome: 'goaround', p };
  if (bad.length) { r.score += C.PTS.abortRight; r.stats.goRight++; log(st, r, 'Correct abort for ' + ac.cs + ': runway really was unsafe (' + bad.join(', ') + '). +' + C.PTS.abortRight + ' points.', 'ok'); }
  else { r.score += C.PTS.abortWrong; r.stats.goWrong++; log(st, r, 'Unnecessary abort for ' + ac.cs + ': the runway was actually safe. The warning was noise. ' + C.PTS.abortWrong + ' points.', 'bad'); }
  event(st, 'goaround', r.n);
  if (ac.kind === 'landing' && !ac.emergency) {
    const others = activeRooms(st).length > 1;
    Object.assign(ac, { state: 'calling', emergency: true, t0: st.t, responses: {}, exclude: others ? [r.n] : [], room: null });
    radio(st, 'MAYDAY MAYDAY - ' + ac.cs + ' went around from Runway ' + r.n + ', low fuel, needs a runway NOW.', 'bad');
    event(st, 'mayday', 0, 'Mayday, mayday, mayday. ' + spoken(ac.cs) + ' has gone around from runway ' + r.n + ', fuel is low. Requesting immediate emergency landing. Any available runway, respond now.');
  } else if (ac.kind === 'landing') { radio(st, ac.cs + ' went around again and diverted to another airport.', 'warn'); finish(st, ac, 'diverted'); }
  else { radio(st, ac.cs + ' take-off aborted on Runway ' + r.n + ', returning to stand.', 'warn'); finish(st, ac, 'rejected'); }
}

function stepAircraft(st) {
  const act = activeRooms(st);
  if (act.length && st.t >= st.nextSpawn && st.t <= C.SESSION - C.READY - C.APPROACH) {
    const cs = pick(['DTW', 'IOT', 'SIM', 'NSE', 'TWN', 'QAL']) + ri(100, 999);
    const ac = { id: ++st.acSeq, cs, kind: st.kind, emergency: false, t0: st.t, state: 'calling', responses: {}, exclude: [], holds: 0 };
    st.kind = st.kind === 'landing' ? 'takeoff' : 'landing';
    st.aircraft.push(ac);
    radio(st, ac.kind === 'landing' ? 'Aircraft ' + cs + ' is going to land within 2 minutes. First runway to accept gets it.' : 'Aircraft ' + cs + ' requests take-off within 2 minutes. First runway to accept gets it.', 'info');
    event(st, 'call', 0, 'Tower to all runway control rooms. ' + (ac.kind === 'landing' ? 'Flight ' + spoken(cs) + ' is inbound for landing, two minutes out. Requesting runway clearance.' : 'Flight ' + spoken(cs) + ' is ready for departure and requests take-off clearance.') + ' The first runway to accept gets the flight.');
    st.nextSpawn = st.t + clamp(Math.round(150 / act.length), 20, 60);
  }
  for (const ac of st.aircraft) {
    if (ac.state === 'calling' && st.t >= ac.t0 + C.READY) {
      if (ac.emergency) { radio(st, ac.cs + ' got no runway and diverted to another airport.', 'warn'); finish(st, ac, 'diverted'); continue; }
      for (const r of act) { // judge every free room's answer against the real runway state
        if (r.assigned) continue;
        const bad = truthHaz(r), what = ac.responses[r.n] === 'decline' ? 'Declined ' : 'No answer to ';
        if (!bad.length) { r.score += C.PTS.declWrong; r.stats.declWrong++; log(st, r, what + ac.cs + ', but the runway was actually SAFE. ' + C.PTS.declWrong + ' points.', 'bad'); }
        else { r.stats.declRight++; log(st, r, what + ac.cs + ': correct, runway was unsafe (' + bad.join(', ') + ').', 'ok'); }
      }
      if (ac.kind === 'landing') { // an arrival nobody accepted cannot wait: it becomes an emergency for every runway
        Object.assign(ac, { emergency: true, t0: st.t, responses: {}, exclude: [] });
        radio(st, 'MAYDAY MAYDAY - ' + ac.cs + ' was not accepted by any runway, low fuel, needs a runway NOW.', 'bad');
        event(st, 'mayday', 0, 'Mayday, mayday, mayday. ' + spoken(ac.cs) + ' has not been accepted by any runway and fuel is low. Requesting immediate emergency landing. First available runway, respond now.');
      } else if (ac.holds < 1) { ac.holds++; ac.t0 = st.t; ac.responses = {}; radio(st, ac.cs + ': no runway confirmed. Holding, calling again - 60 seconds.', 'warn'); event(st, 'call', 0, 'Flight ' + spoken(ac.cs) + ' is holding. No runway has confirmed. Requesting clearance again. Which runway is ready?'); }
      else { radio(st, ac.cs + (ac.kind === 'landing' ? ' diverted to another airport.' : ' departure cancelled.'), 'warn'); finish(st, ac, 'diverted'); }
    } else if (ac.state === 'assigned' && st.t >= ac.resolveAt) resolve(st, ac);
  }
  if (st.aircraft.length > 60) st.aircraft = st.aircraft.filter(a => a.state !== 'done').concat(st.aircraft.filter(a => a.state === 'done').slice(-20));
}

function tick(st, now) {
  if (st.status !== 'running') return;
  const dt = Math.min(3, Math.max(0, (now - st.lastTick) / 1000));
  st.lastTick = now; st.acc += dt;
  while (st.acc >= 1 && st.status === 'running') {
    st.acc -= 1; st.t++;
    for (const r of activeRooms(st)) stepRoom(st, r);
    stepAircraft(st);
    if (st.t >= C.SESSION) { st.status = 'ended'; radio(st, 'Session complete. Thank you, all control rooms.', 'info'); }
  }
}

// ---------- participant actions ----------
function act(st, p, q) {
  if (st.status !== 'running') return { error: 'The simulation is not running.' };
  const need = ACT_ROLE[q.type]; if (!need) return { error: 'Unknown action.' };
  const team = members(st, p.room);
  if (p.role !== need && team.some(m => m.role === need)) return { error: 'Only the ' + ROLES.find(r => r.id === need).name + ' can do that.' };
  const r = st.rooms[p.room - 1], who = p.name, t = st.t;
  const s = q.sensor && Object.prototype.hasOwnProperty.call(S, q.sensor) ? r.sensors[q.sensor] : null;
  switch (q.type) {
    case 'respond': {
      const ac = acById(st, q.ac);
      if (ac && ac.state === 'assigned' && ac.room !== r.n) return { error: 'Runway ' + ac.room + ' accepted ' + ac.cs + ' first.' };
      if (!ac || ac.state !== 'calling') return { error: 'That aircraft is no longer calling.' };
      if (ac.exclude.includes(r.n)) return { error: 'This aircraft just went around from your runway.' };
      if (q.ans !== 'accept' && q.ans !== 'decline') return { error: 'Bad answer.' };
      if (q.ans === 'accept') { // the flight is locked to the first runway that accepts
        if (r.assigned) return { error: 'Your runway already has an aircraft.' };
        log(st, r, who + ' ACCEPTED ' + (ac.emergency ? 'emergency ' : '') + ac.cs + '.', 'info'); assign(st, ac, r); return { ok: 1 };
      }
      ac.responses[r.n] = 'decline';
      log(st, r, who + ' DECLINED ' + ac.cs + '.', 'info');
      return { ok: 1 };
    }
    case 'abort':
      if (!r.assigned) return { error: 'No aircraft is assigned to your runway.' };
      log(st, r, who + ' transmitted GO-AROUND / ABORT.', 'warn'); abort(st, r); return { ok: 1 };
    case 'pirep': {
      if (!r.assigned) return { error: 'No aircraft on approach to ask.' };
      if (t < r.pirepNext) return { error: 'Pilot is busy. Try again in ' + (r.pirepNext - t) + ' s.' };
      r.pirepNext = t + 20; const w = r.truth, ac = acById(st, r.assigned);
      log(st, r, 'Pilot report from ' + ac.cs + ': ' + (w.vis < 550 ? 'cannot see the runway, very poor visibility' : w.vis < 3000 ? 'runway in sight, reduced visibility' : 'runway in sight, good visibility') + '; ' + (w.xw > 30 ? 'strong crosswind, hard to hold the centreline' : 'wind manageable') + (w.precip !== 'none' ? '; ' + w.precip + ' on the windscreen' : '') + '.', 'info');
      return { ok: 1 };
    }
    case 'xcheck':
      if (!s) return { error: 'Pick a sensor.' };
      if (r.xc) return { error: 'A cross-check is already running.' };
      r.xc = { sensor: q.sensor, until: t + 8 }; log(st, r, who + ' started a cross-check of ' + S[q.sensor].name + ' (8 s).'); return { ok: 1 };
    case 'smooth':
      if (!s) return { error: 'Pick a sensor.' };
      s.smooth = clamp(Math.round(Number(q.level)) || 0, 0, 4);
      log(st, r, who + ' set smoothing to ' + (s.smooth ? s.smooth + '/4' : 'OFF') + ' for ' + S[q.sensor].name + '.'); return { ok: 1 };
    case 'flag':
      if (!s) return { error: 'Pick a sensor.' };
      s.flagged = !!q.on; log(st, r, who + (s.flagged ? ' FLAGGED ' : ' un-flagged ') + S[q.sensor].name + (s.flagged ? ' as faulty (excluded from assessment).' : '.'), s.flagged ? 'warn' : ''); return { ok: 1 };
    case 'recal':
      if (!s) return { error: 'Pick a sensor.' };
      if (s.cal) return { error: 'Already recalibrating.' };
      s.cal = t + 5; log(st, r, who + ' started recalibrating ' + S[q.sensor].name + ' (5 s, no data meanwhile).'); return { ok: 1 };
    case 'work': {
      const wk = Object.prototype.hasOwnProperty.call(WORK, q.work) ? WORK[q.work] : null;
      if (!wk) return { error: 'Unknown job.' };
      if (r.job) return { error: 'A crew is already on the runway.' };
      r.job = { type: q.work, label: wk.label, until: t + wk.d };
      log(st, r, who + ' sent a crew: ' + wk.label + ' (' + wk.d + ' s). Runway is occupied meanwhile.', 'warn'); event(st, 'work', r.n); return { ok: 1 };
    }
    case 'observe':
      if (r.obs) return { error: 'Observation already in progress.' };
      if (t < r.obsNext) return { error: 'Observer available again in ' + (r.obsNext - t) + ' s.' };
      r.obs = { until: t + 10 }; r.obsNext = t + 35; log(st, r, who + ' requested a manual weather observation (10 s).'); return { ok: 1 };
  }
}

// ---------- views ----------
function sensorView(r, id) {
  const d = S[id], s = r.sensors[id], x = shown(s), w = r.truth, f = [];
  if (x != null) {
    if (id === 'cam') { f.push(['Surface look', x >= 86 ? 'WHITE - snow cover' : x >= 70 ? 'GLOSSY - possible ICE' : x >= 30 ? 'WET' : 'DRY']); f.push(['Objects', w.vis < 550 ? 'view obscured' : w.obstruction ? 'OBJECT ON RUNWAY' : 'none seen']); }
    if (id === 'fp') f.push(['Surface state', x >= 0.5 ? 'ICE WARNING' : w.surface === 'dry' ? 'DRY' : 'WET']);
    if (id === 'tr') f.push(['Landing minimum 550 m', x < 550 ? 'BELOW minimum' : 'above minimum']);
    if (id === 'fs') f.push(['Present weather', x < 550 ? 'FG (fog)' : w.precip === 'rain' ? 'RA (rain)' : w.precip === 'snow' ? 'SN (snow)' : 'no significant weather']);
    if (id === 'ws') { f.push(['Air temperature', w.airT + ' °C']); f.push(['Precipitation gauge', w.precip]); }
    if (id === 'smr') f.push(['Runway', x >= 0.5 ? 'TARGET ON RUNWAY' : 'no targets']);
  }
  return { id, name: d.name, unit: d.unit, dec: d.dec, min: d.min, max: d.max, thr: d.thr, value: x, hist: s.hist, raw: s.raw, removed: s.removed || 0, fields: f,
    alarm: alarmOf(id, x) || (id === 'cam' && camSeesObject(r) ? 'OBSTRUCTION' : null), smooth: Number(s.smooth) || 0, flagged: s.flagged, cal: s.cal ? 1 : 0 };
}
function roomStatus(r) { return r.assigned || r.job || r.wreckUntil ? 'BUSY' : autoHaz(r).length ? 'UNCLEAR' : 'CLEAR'; }
function assignedView(st, r) {
  if (!r.assigned) return null; const ac = acById(st, r.assigned);
  return { cs: ac.cs, kind: ac.kind, emergency: ac.emergency, left: ac.resolveAt - st.t, p: (st.t - ac.assignT) / (ac.resolveAt - ac.assignT) };
}
const dqPct = r => r.dq.total ? Math.round(100 * r.dq.match / r.dq.total) : null;

const readyRooms = a => Object.keys(a.responses).filter(n => a.responses[n] === 'decline').map(Number).sort((x, y) => x - y); // rooms that declined this flight

function roomView(st, p) {
  const r = st.rooms[p.room - 1], team = members(st, p.room);
  const perms = {}; for (const ro of ROLES) perms[ro.id] = p.role === ro.id || !team.some(m => m.role === ro.id);
  return {
    me: { name: p.name, room: p.room, role: p.role }, roles: ROLES, team: team.map(m => ({ name: m.name, role: m.role })), perms,
    status: st.status, t: st.t, left: C.SESSION - st.t, evSeq: st.evSeq, events: st.events.slice(-8), radio: st.radio.slice(-10),
    calls: st.aircraft.filter(a => a.state === 'calling').map(a => ({ id: a.id, cs: a.cs, kind: a.kind, emergency: a.emergency, left: a.t0 + C.READY - st.t, resp: a.responses[r.n] || null, excluded: a.exclude.includes(r.n), declined: readyRooms(a) })),
    traffic: st.aircraft.filter(a => a.state === 'assigned' && a.room !== r.n).map(a => ({ cs: a.cs, kind: a.kind, emergency: a.emergency, room: a.room, left: a.resolveAt - st.t })),
    room: { n: r.n, status: roomStatus(r), auto: autoHaz(r), lights: r.truth.lights, sensors: SIDS.map(id => sensorView(r, id)),
      job: r.job ? { label: r.job.label, left: r.job.until - st.t } : null, wreck: r.wreckUntil ? r.wreckUntil - st.t : 0,
      assigned: assignedView(st, r), lastOp: r.lastOp ? Object.assign({ age: st.t - r.lastOp.at }, r.lastOp) : null, log: r.log.slice(-25), score: r.score, stats: r.stats, xc: r.xc ? r.xc.sensor : null,
      obsWait: r.obs ? -1 : Math.max(0, r.obsNext - st.t), work: Object.keys(WORK).map(k => ({ id: k, label: WORK[k].label, d: WORK[k].d })) },
    debrief: st.status === 'ended' ? { dq: dqPct(r), faults: r.faults, fixed: r.fixed } : null,
  };
}
function lobbyView(st) {
  const o = openCount(st);
  return { status: st.status, roles: ROLES, rooms: st.rooms.slice(0, o).map(r => { const m = members(st, r.n), roles = {}; for (const x of m) roles[x.role] = x.name; return { n: r.n, roles }; }), maxRooms: C.MAX_ROOMS };
}
function adminView(st) {
  const o = openCount(st);
  return {
    status: st.status, level: st.level || 'normal', t: st.t, left: C.SESSION - st.t, evSeq: st.evSeq, events: st.events.slice(-12), radio: st.radio.slice(-9),
    calls: st.aircraft.filter(a => a.state === 'calling').map(a => ({ cs: a.cs, kind: a.kind, emergency: a.emergency, left: a.t0 + C.READY - st.t, declined: readyRooms(a) })),
    participants: Object.keys(st.participants).length,
    rooms: st.rooms.slice(0, o).map(r => {
      const m = members(st, r.n);
      return { n: r.n, team: m.length, status: m.length ? roomStatus(r) : 'EMPTY', problems: autoHaz(r), truth: truthHaz(r), wx: r.truth.wx,
        faults: SIDS.filter(id => r.sensors[id].fault).map(id => S[id].name + ': ' + FAULT_LABEL[r.sensors[id].fault.type]),
        score: r.score, stats: r.stats, dq: dqPct(r), assigned: assignedView(st, r),
        lastOp: r.lastOp ? Object.assign({ age: st.t - r.lastOp.at }, r.lastOp) : null,
        job: r.job ? { label: r.job.label, left: r.job.until - st.t } : null, wreck: r.wreckUntil ? r.wreckUntil - st.t : 0 };
    }),
  };
}

// ---------- single entry point ----------
function handle(st, q, now, adminKey) {
  q = q || {};
  if (q.op === 'lobby') return lobbyView(st);
  if (q.op === 'register') {
    const name = String(q.name || '').trim().slice(0, 24), n = Number(q.room), role = String(q.role || '');
    if (!name) return { error: 'Please enter your name.' };
    if (st.status === 'ended') return { error: 'The session has ended.' };
    if (!(n >= 1 && n <= openCount(st))) return { error: 'That room is not open yet.' };
    if (!ROLES.some(r => r.id === role)) return { error: 'Unknown role.' };
    if (members(st, n).some(m => m.role === role)) return { error: 'That role was just taken. Pick another.' };
    const token = crypto.randomBytes(18).toString('hex');
    st.participants[token] = { name, room: n, role };
    return { token };
  }
  if (q.op === 'state' || q.op === 'act' || q.op === 'leave') {
    const p = typeof q.token === 'string' && Object.prototype.hasOwnProperty.call(st.participants, q.token) ? st.participants[q.token] : null;
    if (!p) return { error: 'not-registered' };
    if (q.op === 'leave') { delete st.participants[q.token]; return { ok: 1 }; }
    if (q.op === 'act') { const res = act(st, p, q); if (res.error) return res; }
    return roomView(st, p);
  }
  if (q.op === 'admin') {
    if (q.key !== adminKey) return { error: 'bad-key' };
    if (q.cmd === 'start' && (st.status === 'lobby' || st.status === 'paused')) { st.status = 'running'; st.lastTick = now; }
    if (q.cmd === 'pause' && st.status === 'running') st.status = 'paused';
    if (typeof q.cmd === 'string' && q.cmd.slice(0, 6) === 'level:' && Object.prototype.hasOwnProperty.call(LEVEL, q.cmd.slice(6))) st.level = q.cmd.slice(6);
    if (q.cmd === 'reset') resetGame(st, false);
    if (q.cmd === 'wipe') resetGame(st, true);
    tick(st, now);
    return adminView(st);
  }
  return { error: 'Unknown request.' };
}

module.exports = { create, handle, C, ROLES };
