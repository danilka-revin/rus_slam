const state = {
  view: "dash",
  estop: false,
  crab: false,
  vmax: 5,
  clearance: 0.70,
  spdVx: 0, spdVy: 0, spdWz: 0,
  vx: 0, vy: 0, wz: 0,
  x: 0, y: 0, yaw: 0,
  bat: 51.2, soc: 78, current: 4.1,
  watchdogMs: 42,
  crc: 0,
  mission: "IDLE",
  keys: {},
  detections: [
    { t: "нет детекций", conf: 0, src: "камера offline" },
  ],
  modules: [
    { id: "FL", steer: 0, rpm: 0, temp: 36, homed: true },
    { id: "FR", steer: 0, rpm: 0, temp: 37, homed: true },
    { id: "RL", steer: 0, rpm: 0, temp: 35, homed: true },
    { id: "RR", steer: 0, rpm: 0, temp: 36, homed: true },
  ],
  logs: [],
  scan: [],
  waypoints: [],
  wpIndex: 0,
  auto: false,
  explore: false,
  navPath: [],
  planAt: 0,
  events: [],
  pause: false,
  loop: false,
  docking: false,
  trail: [],
  beacon: true,
  cargoLock: true,
  payload: 80,
  lightGreen: true,
  lastSign: 0,
  cargo: false,
  program: [],
  progI: 0,
  progRun: false,
  placeMode: null,
  waitConfirm: null,
  chargeTo: 80,
  charging: false,
};

const FSM = ["IDLE", "READY", "NAVIGATE", "YIELD_SIGN", "WAIT_LIGHT", "DELIVER", "RETURN", "FAULT"];

function log(level, msg) {
  const ts = new Date().toLocaleTimeString("ru-RU", { hour12: false });
  state.logs.unshift({ level, msg, ts });
  if (state.logs.length > 200) state.logs.pop();
  renderLogs();
}

function emit(type, msg) {
  state.events.unshift({ type, msg, ts: Date.now() });
  if (state.events.length > 50) state.events.pop();
  const box = document.getElementById("events");
  if (box) {
    box.innerHTML = state.events.slice(0, 6).map((e) =>
      `<div class="ev ${e.type}">${e.msg}</div>`).join("");
  }
  log(type === "err" || type === "collision" ? "err" : type === "warn" ? "warn" : "ok", msg);
}

function toast(text) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 2200);
}

function setMission(m) {
  state.mission = m;
  const badge = document.getElementById("mission-badge");
  if (badge) badge.textContent = m;
  const ml = document.getElementById("mission-label");
  if (ml) ml.textContent = m;
  const md = document.getElementById("mission-delta");
  if (md) md.textContent = `${state.waypoints.length} точек · ${state.progRun ? 'программа А→Б' : 'ручной режим'}`;
  const hm = document.getElementById("hud-mode");
  if (hm) hm.textContent = m==="FAULT" ? "FAULT" : state.auto ? "AUTO" : "TELEOP";
  const modeLab = document.getElementById("mode-label");
  if (modeLab && !state.estop) {
    modeLab.textContent = state.auto ? `AUTO · ${m}` : `TELEOP · ${m}`;
  }
  renderFsm();
  log("ok", "FSM → " + m);
}

function publishCmd() {
  if (state.estop) {
    state.vx = state.vy = state.wz = 0;
  }
  const lin = document.getElementById("cmd-lin");
  if (lin) lin.textContent = `vx ${state.vx.toFixed(2)}`;
  const ang = document.getElementById("cmd-ang");
  if (ang) ang.textContent = `wz ${state.wz.toFixed(2)}`;
  const lat = document.getElementById("cmd-lat");
  if (lat) lat.textContent = `vy ${state.vy.toFixed(2)}`;

  const hvx = document.getElementById("hud-vx");
  if (hvx) hvx.textContent = state.spdVx.toFixed(2);
  const hvy = document.getElementById("hud-vy");
  if (hvy) hvy.textContent = state.spdVy.toFixed(2);
  const hwz = document.getElementById("hud-wz");
  if (hwz) hwz.textContent = state.spdWz.toFixed(2);
  const hyaw = document.getElementById("hud-yaw");
  if (hyaw) hyaw.textContent = `${(state.yaw*180/Math.PI).toFixed(0)}°`;

  const crabTag = document.getElementById("crab-tag");
  if (crabTag) crabTag.textContent = state.crab ? "КРАБ" : "4WIS";
}

const DRIVE_KEYS = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space",
]);

function driveKeyDown() {
  return ["KeyW","KeyA","KeyS","KeyD","KeyQ","KeyE","ArrowUp","ArrowDown","ArrowLeft","ArrowRight"]
    .some((c) => state.keys[c]);
}

function applyKeys() {
  if (state.estop) {
    state.vx = state.vy = state.wz = 0;
    return;
  }
  if (dragging) return;
  if (state.auto && !driveKeyDown()) return;
  if (state.explore && !driveKeyDown()) return;
  if (!driveKeyDown()) {
    if (!state.auto) { state.vx = 0; state.vy = 0; state.wz = 0; }
    return;
  }
  state.auto = false;
  const k = state.keys;
  const v = state.vmax;
  let vx = 0, vy = 0, wz = 0;
  if (k.KeyW || k.ArrowUp) vx += v;
  if (k.KeyS || k.ArrowDown) vx -= v;
  if (k.KeyA || k.ArrowLeft) wz += 1.25;
  if (k.KeyD || k.ArrowRight) wz -= 1.25;
  if (k.KeyQ) vy += v;
  if (k.KeyE) vy -= v;
  if (state.crab) {
    if (k.KeyA || k.ArrowLeft) { vy += v; wz = 0; }
    if (k.KeyD || k.ArrowRight) { vy -= v; wz = 0; }
  }
  state.vx = vx; state.vy = vy; state.wz = wz;
}

window.addEventListener("keydown", (e) => {
  if (!DRIVE_KEYS.has(e.code)) return;
  e.preventDefault();
  if (e.code === "Space") {
    state.vx = state.vy = state.wz = 0;
    state.keys = {};
    state.auto = false;
    state.explore = false;
    dragging = false;
    const ba = document.getElementById("btn-auto");
    if (ba) ba.textContent = "Старт маршрута";
    const be = document.getElementById("btn-explore");
    if (be) be.textContent = "Автоскан";
    publishCmd();
    return;
  }
  if (e.code === "KeyH") { homeModules(); return; }
  state.keys[e.code] = true;
  applyKeys();
  publishCmd();
});
window.addEventListener("keyup", (e) => {
  if (!DRIVE_KEYS.has(e.code)) return;
  state.keys[e.code] = false;
  applyKeys();
  publishCmd();
});

function safeOn(id, ev, fn){
  const el = document.getElementById(id);
  if (el) el.addEventListener(ev, fn);
}

safeOn("crab","change",(e)=>{
  state.crab = e.target.checked;
  log("ok","crab "+(state.crab?"on":"off"));
  const ct = document.getElementById("crab-tag");
  if (ct) ct.textContent = state.crab ? "КРАБ" : "4WIS";
});
safeOn("vmax","input",(e)=>{
  state.vmax = Number(e.target.value);
  const lab = document.getElementById("vmax-label");
  if (lab) lab.textContent = state.vmax.toFixed(1)+" м/с";
});
safeOn("clearance","input",(e)=>{
  state.clearance = Number(e.target.value);
  const el = document.getElementById("clr-val");
  if (el) el.textContent = state.clearance.toFixed(2)+" м";
});

safeOn("btn-estop","click",()=>{
  state.estop = !state.estop;
  if (state.estop) { state.auto = false; state.explore = false; }
  const btn = document.getElementById("btn-estop");
  if (btn) btn.classList.toggle("on", state.estop);
  const es = document.getElementById("estop-state");
  if (es) es.textContent = state.estop ? "ВКЛ" : "ВЫКЛ";
  const sl = document.getElementById("statusline");
  if (sl) sl.classList.toggle("danger", state.estop);
  const ml = document.getElementById("mode-label");
  if (ml) ml.textContent = state.estop ? "E-STOP · гейт закрыт" : "TELEOP · симуляция";
  const gate = document.getElementById("gate");
  if (gate) gate.textContent = state.estop ? "HOLD" : "OK";
  const pulse = document.getElementById("link-pulse");
  if (pulse) pulse.className = "pulse" + (state.estop ? " off" : "");
  if (state.estop) setMission("FAULT");
  else if (state.mission === "FAULT") setMission("IDLE");
  toast(state.estop ? "Аварийный стоп включён" : "E-stop снят");
  log(state.estop ? "err" : "ok", state.estop ? "E-STOP asserted" : "E-STOP cleared");
  publishCmd();
});

function homeModules() {
  state.modules.forEach((m) => { m.steer = 0; m.homed = true; });
  renderModules();
  const hs = document.getElementById("homing-status");
  if (hs) hs.textContent = "HOMED";
  toast("Хоминг отправлен на 4 модуля");
  log("ok", "homing command → UART ×4");
}
safeOn("btn-home","click",homeModules);
safeOn("btn-recenter","click",()=>{
  mapView.follow = true;
  mapView.camX = state.x;
  mapView.camY = state.y;
});

safeOn("btn-auto","click",()=>{
  if (state.estop) { toast("Снимите E-stop"); return; }
  if (!state.waypoints.length) { toast("Сначала кликните точки на карте"); return; }
  state.auto = !state.auto;
  if (state.auto) {
    state.wpIndex = 0;
    setMission("NAVIGATE");
    const ml = document.getElementById("mode-label");
    if (ml) ml.textContent = "AUTO · маршрут";
    const ba = document.getElementById("btn-auto");
    if (ba) ba.textContent = "Стоп авто";
    toast("Едем по точкам");
  } else {
    state.vx = state.vy = state.wz = 0;
    const ml = document.getElementById("mode-label");
    if (ml) ml.textContent = "TELEOP · симуляция";
    const ba = document.getElementById("btn-auto");
    if (ba) ba.textContent = "Старт маршрута";
  }
});
safeOn("btn-clear-route","click",()=>{
  state.waypoints = [];
  state.wpIndex = 0;
  state.auto = false;
  state.vx = state.vy = state.wz = 0;
  const ba = document.getElementById("btn-auto");
  if (ba) ba.textContent = "Старт маршрута";
  toast("Точки сброшены");
});

const mapCanvas = document.getElementById("map");
let mapDrag = null;
if (mapCanvas){
  mapCanvas.style.cursor = "grab";
  mapCanvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    mapDrag = { x: e.clientX, y: e.clientY, camX: mapView.camX, camY: mapView.camY, moved: false };
    mapCanvas.style.cursor = "grabbing";
    try { mapCanvas.setPointerCapture(e.pointerId); } catch (_) {}
  });
  mapCanvas.addEventListener("pointermove", (e) => {
    if (!mapDrag) return;
    const dx = e.clientX - mapDrag.x, dy = e.clientY - mapDrag.y;
    if (Math.hypot(dx, dy) < 8) return;
    mapDrag.moved = true;
    mapView.follow = false;
    const r = mapCanvas.getBoundingClientRect();
    mapView.camX = mapDrag.camX - (dx * mapCanvas.width / r.width) / mapView.scale;
    mapView.camY = mapDrag.camY + (dy * mapCanvas.height / r.height) / mapView.scale;
  });
  mapCanvas.addEventListener("pointerup", (e) => {
    const drag = mapDrag && mapDrag.moved;
    mapDrag = null;
    mapCanvas.style.cursor = "grab";
    if (drag || e.button !== 0) return;
    const p = screenToWorld(e);
    const s = snapToDriveable(p.x, p.y) || p;
    if (state.placeMode) {
      if (state.placeMode === "start") {
        state.x = s.x; state.y = s.y;
        state.bubble = "старт";
        emit("ok", "старт: " + s.x.toFixed(1) + ", " + s.y.toFixed(1));
      } else {
        const st = stationOf(state.placeMode);
        if (st) { st.x = s.x; st.y = s.y; }
        seedStationPads();
        emit("ok", (state.placeMode === "load" ? "А" : state.placeMode === "unload" ? "Б" : "база") + " поставлена");
      }
      state.placeMode = null;
      toast("Точка на карте");
      return;
    }
    if (!s || occupied(s.x, s.y)) { toast("Сюда нельзя — только проезд"); return; }
    state.waypoints.push(s);
  });
  mapCanvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    mapView.scale = Math.max(8, Math.min(50, mapView.scale * (e.deltaY > 0 ? 0.9 : 1.12)));
  }, { passive: false });
  mapCanvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    state.waypoints.pop();
  });
}

safeOn("btn-start-mission","click",()=>{
  if (state.estop) { toast("Снимите E-stop"); return; }
  setMission("NAVIGATE");
  toast("Nav2: цель доставки");
});
safeOn("btn-pause-mission","click",()=>setMission("YIELD_SIGN"));
safeOn("btn-abort","click",()=>setMission("IDLE"));

document.querySelectorAll("nav button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("nav button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const v = btn.dataset.view;
    const viewEl = document.getElementById("view-" + v);
    if (viewEl) {
      document.querySelectorAll(".view").forEach((s) => s.classList.add("hidden"));
      viewEl.classList.remove("hidden");
    }
  });
});

function renderModules() {
  const mk = (m)=>{
    const steerDeg = m.steer || 0;
    const rpm = m.rpm || 0;
    const temp = m.temp || 36;
    const rpmPct = Math.min(100, Math.abs(rpm)/8);
    const tempPct = Math.min(100, (temp-20)/60*100);
    const steerNorm = ((steerDeg+90)/180*100);
    const circ = 2*Math.PI*18;
    const steerOffset = circ - (Math.max(0,Math.min(100,steerNorm))/100)*circ;
    return `
    <div class="mod">
      <div class="mod-id">${m.id}</div>
      <div class="mod-dial"><svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="18" class="dial-bg"/><circle cx="26" cy="26" r="18" class="dial-fg" stroke-dasharray="${circ}" stroke-dashoffset="${steerOffset}"/></svg><div class="mod-dial-center"><b>${steerDeg.toFixed(0)}°</b></div></div>
      <div class="mod-bars">
        <div class="mod-bar"><span>RPM</span><div class="bar-track"><i class="rpm" style="width:${rpmPct}%"></i></div><b>${rpm.toFixed(0)}</b></div>
        <div class="mod-bar"><span>°C</span><div class="bar-track"><i class="temp" style="width:${tempPct}%"></i></div><b>${temp.toFixed(0)}</b></div>
      </div>
    </div>`;
  };
  const slots = {FL:'card-FL', FR:'card-FR', RL:'card-RL', RR:'card-RR'};
  // also support old ids
  const oldSlots = {FL:'mod-FL-slot', FR:'mod-FR-slot', RL:'mod-RL-slot', RR:'mod-RR-slot'};
  for (const m of state.modules){
    const id = slots[m.id] || oldSlots[m.id];
    const el = id ? document.getElementById(id) : null;
    if (el) el.innerHTML = mk(m);
  }
  // fallback for generic container
  const container = document.getElementById("modules");
  if (container && container.children.length===0){
    container.innerHTML = state.modules.map(m=>mk(m)).join("");
  }
}
document.addEventListener('DOMContentLoaded', ()=>{ try{renderModules();}catch(e){} });
setTimeout(()=>{ try{renderModules();}catch(e){} }, 150);
setTimeout(()=>{ try{renderModules();}catch(e){} }, 600);

function renderFsm() {
  const fsmEl = document.getElementById("fsm");
  if (fsmEl) {
    fsmEl.innerHTML = FSM.map((s) =>
      `<span class="${s === state.mission ? "on" : ""}">${s}</span>`).join("");
  }
}

function renderDets() {
  const detsEl = document.getElementById("dets");
  if (!detsEl) return;
  detsEl.innerHTML =
    `<div class="tr th" style="display:grid;grid-template-columns:1.4fr .6fr .6fr;padding:8px 16px;font-size:8px;color:#8e9994;text-transform:uppercase">Класс · conf · источник</div>` +
    state.detections.map((d) =>
      `<div style="display:grid;grid-template-columns:1.4fr .6fr .6fr;padding:10px 16px;border-top:1px solid #edf0ee">
        <b style="font-size:11px">${d.t}</b><span>${(d.conf*100).toFixed(0)}%</span><small>${d.src}</small>
      </div>`).join("");
}

function renderLogs() {
  const box = document.getElementById("logs");
  if (!box) return;
  box.innerHTML = state.logs.map((l) =>
    `<div class="log-line ${l.level}">${l.ts}  ${l.msg}</div>`).join("");
}

function drawStick() {
  const c = document.getElementById("stick");
  if (!c) return;
  const ctx = c.getContext("2d");
  const w = c.width, h = c.height, cx = w/2, cy = h/2;
  ctx.clearRect(0,0,w,h);
  const dark = document.body.classList.contains("dark");
  const bg = dark ? "#101b17" : "#f5f7f6";
  const border = dark ? "#2a3a32" : "#dfe5e2";
  const grid = dark ? "#203029" : "#edf0ee";
  ctx.fillStyle = bg;
  ctx.beginPath(); ctx.arc(cx,cy,Math.min(w,h)/2-4,0,Math.PI*2); ctx.fill();
  ctx.strokeStyle = border; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(cx- (w/2-10),cy); ctx.lineTo(cx+(w/2-10),cy); ctx.moveTo(cx,cy-(h/2-10)); ctx.lineTo(cx,cy+(h/2-10)); ctx.stroke();
  const nx = cx + ((state.crab ? state.vy : -state.wz * 0.7) / state.vmax) * (w*0.35);
  const ny = cy - (state.vx / state.vmax) * (h*0.35);
  ctx.fillStyle = "#16241e";
  ctx.beginPath(); ctx.arc(nx, ny, 12, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = "#d5ff45";
  ctx.beginPath(); ctx.arc(nx, ny, 5, 0, Math.PI*2); ctx.fill();
}

const CHASSIS = [
  { id: "FL", x: 0.34, y: 0.22 },
  { id: "FR", x: 0.34, y: -0.22 },
  { id: "RL", x: -0.34, y: 0.22 },
  { id: "RR", x: -0.34, y: -0.22 },
];

function compute4WIS(vx, vy, wz) {
  if (state.crab) wz = 0;
  const out = [];
  for (const w of CHASSIS) {
    const vix = vx - wz * w.y;
    const viy = vy + wz * w.x;
    const spd = Math.hypot(vix, viy);
    let steer = Math.abs(vx) + Math.abs(vy) + Math.abs(wz) < 0.04 ? 0 : Math.atan2(viy, vix);
    if (steer > Math.PI / 2) { steer -= Math.PI; }
    if (steer < -Math.PI / 2) { steer += Math.PI; }
    out.push({ id: w.id, x: w.x, y: w.y, steer, rpm: spd * 180 });
  }
  return out;
}

function angDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function cellXY(ix, iy) {
  return { x: GRID_OX + (ix + 0.5) * GRID_RES, y: GRID_OY + (iy + 0.5) * GRID_RES };
}
function xyCell(x, y) {
  return {
    ix: Math.max(0, Math.min(GRID_W - 1, Math.floor((x - GRID_OX) / GRID_RES))),
    iy: Math.max(0, Math.min(GRID_H - 1, Math.floor((y - GRID_OY) / GRID_RES))),
  };
}
function wallCost(ix, iy) {
  const want = state.clearance || 0.7;
  const d = distM(ix, iy);
  if (d < want * 0.4) return 80;
  if (d < want * 0.65) return 22;
  if (d < want) return 8;
  if (d < want * 1.25) return 2.5;
  return 1;
}
function inflateRadius() {
  const r = Math.min(0.5, (state.clearance || 0.7) * 0.55);
  return Math.max(1, Math.round(r / GRID_RES));
}
function inflatedOcc(ix, iy) {
  const r = inflateRadius();
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r + 1) continue;
      const x = ix + dx, y = iy + dy;
      if (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) return true;
      if (grid[y * GRID_W + x] === OCC) return true;
    }
  }
  return false;
}
function canDrive(ix, iy) {
  if (ix < 2 || iy < 2 || ix >= GRID_W - 2 || iy >= GRID_H - 2) return false;
  if (grid[iy * GRID_W + ix] !== FREE) return false;
  if (inflatedOcc(ix, iy)) return false;
  if (cellClearance(ix, iy) < 0.36) return false;
  return true;
}
function planPath(gx, gy) {
  const s = xyCell(state.x, state.y);
  const g = xyCell(gx, gy);
  if (!canDrive(g.ix, g.iy) && grid[g.iy * GRID_W + g.ix] !== FREE) return [];
  const W = GRID_W, H = GRID_H;
  const N = W * H;
  const came = new Int32Array(N).fill(-1);
  const gScore = new Float32Array(N).fill(1e9);
  const open = [];
  const start = s.iy * W + s.ix;
  const goal = g.iy * W + g.ix;
  gScore[start] = 0;
  open.push(start);
  const closed = new Uint8Array(N);
  const nbr = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  let found = false, guard = 0;
  while (open.length && guard++ < 8000) {
    let bi = 0, bv = 1e18;
    for (let i = 0; i < open.length; i++) {
      const k = open[i];
      const ix = k % W, iy = (k / W) | 0;
      const f = gScore[k] + Math.hypot(ix - g.ix, iy - g.iy);
      if (f < bv) { bv = f; bi = i; }
    }
    const cur = open.splice(bi, 1)[0];
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === goal) { found = true; break; }
    const cx = cur % W, cy = (cur / W) | 0;
    for (const [dx, dy] of nbr) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 1 || ny < 1 || nx >= W - 1 || ny >= H - 1) continue;
      const nk = ny * W + nx;
      if (nk !== goal && !canDrive(nx, ny)) continue;
      if (nk === goal && grid[nk] === OCC) continue;
      const step = (dx && dy) ? 1.41 : 1;
      const ng = gScore[cur] + step * wallCost(nx, ny);
      if (ng < gScore[nk]) {
        gScore[nk] = ng;
        came[nk] = cur;
        open.push(nk);
      }
    }
  }
  const path = [];
  if (!found) return path;
  let k = goal;
  while (k >= 0) {
    path.push(cellXY(k % W, (k / W) | 0));
    k = came[k];
  }
  path.reverse();
  return path;
}
function lookAhead(path) {
  if (!path.length) return null;
  const c = Math.cos(state.yaw), s = Math.sin(state.yaw);
  const want = (state.clearance || 0.7) * 0.55;
  let best = null;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    const dx = p.x - state.x, dy = p.y - state.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.7 || d > 3.5) continue;
    const ahead = dx * c + dy * s;
    if (ahead < 0.2) continue;
    const cell = xyCell(p.x, p.y);
    if (cellClearance(cell.ix, cell.iy) < want) continue;
    best = p;
    if (d >= 1.4) return p;
  }
  return best || path[Math.min(path.length - 1, 4)];
}
function cellClearance(ix, iy) { return distM(ix, iy); }
function snapToDriveable(x, y) {
  const minClear = Math.max(0.55, state.clearance || 0.7);
  const ok = (px, py) => {
    const c = xyCell(px, py);
    if (occupied(px, py)) return false;
    if (grid[c.iy * GRID_W + c.ix] !== FREE) return false;
    if (inflatedOcc(c.ix, c.iy)) return false;
    return cellClearance(c.ix, c.iy) >= minClear;
  };
  let best = null, bestScore = 1e9;
  const consider = (px, py) => {
    if (!ok(px, py)) return;
    const c = xyCell(px, py);
    const wall = cellClearance(c.ix, c.iy);
    const d = Math.hypot(px - x, py - y);
    const score = d - wall * 2.4;
    if (score < bestScore) { bestScore = score; best = { x: px, y: py }; }
  };
  consider(x, y);
  for (let rad = 1; rad <= 48; rad++) {
    const n = Math.max(12, rad * 4);
    for (let a = 0; a < n; a++) {
      consider(
        x + Math.cos((a / n) * Math.PI * 2) * rad * GRID_RES,
        y + Math.sin((a / n) * Math.PI * 2) * rad * GRID_RES
      );
    }
    if (best && rad >= 6) break;
  }
  if (best) return best;
  let fb = null, fbW = -1;
  for (let rad = 1; rad <= 40; rad++) {
    for (let a = 0; a < 16; a++) {
      const px = x + Math.cos((a / 16) * Math.PI * 2) * rad * GRID_RES;
      const py = y + Math.sin((a / 16) * Math.PI * 2) * rad * GRID_RES;
      const c = xyCell(px, py);
      if (grid[c.iy * GRID_W + c.ix] !== FREE) continue;
      if (occupied(px, py) || inflatedOcc(c.ix, c.iy)) continue;
      const w = cellClearance(c.ix, c.iy);
      if (w > fbW) { fbW = w; fb = { x: px, y: py }; }
    }
    if (fb && fbW >= 0.55) break;
  }
  return fb;
}
function pickFrontier() {
  const skip = state.skipFront || [];
  let best = null, bestScore = 1e9;
  const step = 4;
  for (let iy = 3; iy < GRID_H - 3; iy += step) {
    for (let ix = 3; ix < GRID_W - 3; ix += step) {
      if (grid[iy * GRID_W + ix] !== FREE) continue;
      if (inflatedOcc(ix, iy)) continue;
      let unk = 0;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          if (grid[(iy + dy) * GRID_W + (ix + dx)] === UNK) unk++;
        }
      }
      if (unk < 3) continue;
      const p = cellXY(ix, iy);
      const d = Math.hypot(p.x - state.x, p.y - state.y);
      if (d < 2.8) continue;
      if (Math.abs(p.x) > 15.2 || Math.abs(p.y) > 9.4) continue;
      if (skip.some((s) => Math.hypot(s.x - p.x, s.y - p.y) < 2.2)) continue;
      const score = d * 0.2 - unk * 0.45 - distM(ix, iy);
      if (score < bestScore) { bestScore = score; best = p; }
    }
  }
  if (!best) return null;
  return snapToDriveable(best.x, best.y) || best;
}
function mapCoverage() { return explored / grid.length; }
function lidarSectors() {
  let fwd = 99, left = 99, right = 99, rear = 99;
  for (const p of state.scan) {
    const rel = angDiff(p.a, state.yaw);
    if (Math.abs(rel) < 0.55) fwd = Math.min(fwd, p.r);
    else if (rel > 0 && rel < 1.4) left = Math.min(left, p.r);
    else if (rel < 0 && rel > -1.4) right = Math.min(right, p.r);
    else if (Math.abs(rel) > 2.45) rear = Math.min(rear, p.r);
  }
  return { fwd, left, right, rear };
}
function stationOf(kind) { return (WORLD.stations || []).find((s) => s.kind === kind); }
function nearStation(kind, r = 1.8) {
  const st = stationOf(kind);
  return st && Math.hypot(st.x - state.x, st.y - state.y) < r;
}
function seedStationPads() {
  for (const st of WORLD.stations || []) {
    for (let dx = -8; dx <= 8; dx++) {
      for (let dy = -8; dy <= 8; dy++) {
        const wx = st.x + dx * GRID_RES, wy = st.y + dy * GRID_RES;
        if (occupied(wx, wy)) continue;
        const i = gi(wx, wy);
        if (i >= 0 && grid[i] !== OCC) setCell(i, FREE);
      }
    }
  }
}
function goToStation(kind) {
  const st = stationOf(kind);
  if (!st) return false;
  seedStationPads();
  const g = { x: st.x, y: st.y };
  const cur = state.waypoints[0];
  if (!cur || Math.hypot(cur.x - g.x, cur.y - g.y) > 0.25) {
    state.waypoints = [g];
    state.wpIndex = 0;
    state.navPath = [];
  }
  state.auto = true;
  const need = kind === "dock" ? 0.5 : 0.85;
  return Math.hypot(st.x - state.x, st.y - state.y) < need;
}
function confirmLoad() {
  if (!nearStation("load")) { toast("Сначала площадка А"); return; }
  if (!doLoad()) return;
  if (state.waitConfirm === "load") {
    state.waitConfirm = null;
    state.progI++;
    state.progRun = true;
    state.auto = true;
    renderProg();
    emit("ok", "загрузка подтверждена — еду дальше");
  }
}
function confirmUnload() {
  if (!nearStation("unload")) { toast("Сначала площадка Б"); return; }
  if (!doUnload()) return;
  if (state.waitConfirm === "unload") {
    state.waitConfirm = null;
    state.progI++;
    state.progRun = true;
    state.auto = true;
    renderProg();
    emit("ok", "выгрузка подтверждена — еду дальше");
  }
}
function doLoad() {
  if (state.cargo) { toast("Уже загружен"); return false; }
  if (!nearStation("load")) { toast("Подъедьте к площадке А"); return false; }
  state.cargo = true;
  state.payload = Math.min(250, (state.payload || 0) + 40);
  const pv = document.getElementById("pay-val");
  if (pv) pv.textContent = state.payload + " кг";
  setMission("NAVIGATE");
  emit("ok", "загрузка на А");
  const cs = document.getElementById("cargo-state");
  if (cs) cs.textContent = "груз: " + state.payload + " кг";
  return true;
}
function doUnload() {
  if (!state.cargo) { toast("Отсек пуст"); return false; }
  if (!nearStation("unload")) { toast("Подъедьте к площадке Б"); return false; }
  state.cargo = false;
  state.delivered = (state.delivered || 0) + 1;
  setMission("DELIVER");
  emit("ok", "выгрузка на Б");
  const cs = document.getElementById("cargo-state");
  if (cs) cs.textContent = "груз: пусто";
  return true;
}
function renderProg() {
  const ol = document.getElementById("prog-list");
  if (!ol) return;
  const info = {
    goA: { t: "Ехать на площадку А", d: "Подъезжает к точке загрузки" },
    goB: { t: "Ехать на площадку Б", d: "Везёт туда, куда нужно сдать" },
    load: { t: "Взять груз", d: "Стоит на А, пока не нажмёте «груз взят»" },
    unload: { t: "Сдать груз", d: "Стоит на Б, пока не нажмёте «груз сдан»" },
    goP: { t: "Ехать по точкам P", d: "Маршрут, который вы кликали" },
    wait: { t: "Пауза 2 сек", d: "Стоит на месте" },
    dock: { t: "На базу", d: "Возвращается на зарядку" },
    charge: { t: "Зарядиться", d: "Только на базе, до %" },
    loop: { t: "Повторить с начала", d: "Бесконечный рейс" },
  };
  if (!state.program.length) {
    ol.innerHTML = `<li class="empty">Очередь пустая. Добавьте шаги сверху и нажмите Пуск.</li>`;
  } else {
    ol.innerHTML = state.program.map((b, i) => {
      const inf = info[b] || { t: b, d: "" };
      const cls = state.progRun && i === state.progI ? "on" : (state.progRun && i < state.progI ? "done" : "");
      return `<li class="${cls}"><span class="n">${i + 1}</span><span><span class="t">${inf.t}</span><span class="d">${inf.d}</span></span><button type="button" data-del="${i}" title="убрать">×</button></li>`;
    }).join("");
  }
  ol.querySelectorAll("[data-del]").forEach((btn) => {
    btn.onclick = () => { state.program.splice(Number(btn.dataset.del), 1); renderProg(); };
  });
  const now = document.getElementById("prog-now");
  if (now) {
    now.textContent = state.progRun && state.program[state.progI]
      ? " · шаг " + (state.progI + 1)
      : (state.progRun ? " · готово" : "");
  }
  const cs = document.getElementById("cargo-state");
  if (cs) cs.textContent = state.cargo ? "в отсеке груз" : "отсек пустой";
}
function runProgram() {
  if (!state.progRun || !state.program.length) return false;
  if (state.waitUntil && performance.now() < state.waitUntil) {
    state.vx = state.vy = state.wz = 0;
    return true;
  }
  const b = state.program[state.progI];
  if (!b) {
    if (state.program.includes("loop")) { state.progI = 0; return true; }
    state.progRun = false;
    state.auto = false;
    emit("ok", "программа выполнена");
    renderProg();
    return true;
  }
  const goSt = (kind) => {
    if (goToStation(kind)) {
      state.progI++;
      renderProg();
    }
  };
  const names = { goA: "еду на А", goB: "еду на Б", load: "загрузка", unload: "выгрузка", goP: "по точкам", wait: "жду 2с", dock: "на базу", charge: "заряжаюсь", loop: "цикл" };
  state.bubble = names[b] || b;
  if (b === "goA") goSt("load");
  else if (b === "goB") goSt("unload");
  else if (b === "load") {
    if (nearStation("load")) {
      state.auto = false;
      state.vx = state.vy = state.wz = 0;
      state.waitConfirm = "load";
      state.bubble = "подтвердите загрузку";
      return true;
    }
    goToStation("load");
  } else if (b === "unload") {
    if (nearStation("unload")) {
      state.auto = false;
      state.vx = state.vy = state.wz = 0;
      state.waitConfirm = "unload";
      state.bubble = "подтвердите выгрузку";
      renderProg();
      toast("На Б: нажмите жёлтую кнопку, когда груз сняли");
      return true;
    }
    goToStation("unload");
  } else if (b === "goP") {
    if (!state.waypoints.length) { state.progI++; renderProg(); }
    else {
      state.auto = true;
      if (state.wpIndex >= state.waypoints.length) { state.progI++; state.wpIndex = 0; renderProg(); }
    }
  } else if (b === "wait") {
    state.waitUntil = performance.now() + 2000;
    state.vx = state.vy = state.wz = 0;
    state.progI++;
    renderProg();
    return true;
  } else if (b === "dock") {
    const dock = stationOf("dock");
    if (dock && Math.hypot(dock.x - state.x, dock.y - state.y) < 0.5) {
      state.progI++;
      state.docking = false;
      state.auto = false;
      state.vx = state.vy = state.wz = 0;
      renderProg();
    } else if (!state.docking) {
      goDock();
    }
  } else if (b === "charge") {
    const dock = stationOf("dock");
    const near = dock && Math.hypot(dock.x - state.x, dock.y - state.y) < 3.2;
    if (near && !state.charging && state.soc >= (state.chargeTo || 80) - 1) {
      state.progI++;
      renderProg();
    } else if (!state.charging) {
      goCharge();
    }
  } else if (b === "loop") {
    state.progI = 0;
    renderProg();
  }
  return true;
}

function followRoute() {
  if (state.estop) return;
  if (state.pause) {
    state.vx = state.vy = state.wz = 0;
    return;
  }
  if (state.waitConfirm) {
    state.vx = state.vy = state.wz = 0;
    state.bubble = state.waitConfirm === "load" ? "подтвердите загрузку" : "подтвердите выгрузку";
    return;
  }
  if (state.charging) {
    const dock = stationOf("dock");
    if (dock && Math.hypot(dock.x - state.x, dock.y - state.y) < 1.15) {
      state.vx = state.vy = state.wz = 0;
      return;
    }
  }
  if (state.progRun) runProgram();
  const s = lidarSectors();
  const atEdge = Math.abs(state.x) > 15.6 || Math.abs(state.y) > 9.7;
  if (atEdge && state.auto) {
    const inward = Math.atan2(-state.y, -state.x);
    const err = angDiff(inward, state.yaw);
    state.vy = 0;
    state.spinClear = false;
    if (Math.abs(err) > 0.35) {
      state.vx = 0;
      state.wz = Math.max(-2, Math.min(2, err * 2.2));
    } else {
      state.vx = 1.2;
      state.wz = 0;
    }
    if (state.explore) {
      state.waypoints = [];
      state.wpIndex = 0;
      state.navPath = [];
    }
    return;
  }
  if (state.spinClear) {
    state.spinT = (state.spinT || 0) + 0.05;
    state.vx = 0;
    state.vy = 0;
    if (!state.spinDir) state.spinDir = s.left >= s.right ? 1 : -1;
    state.wz = state.spinDir * 1.7;
    if (s.fwd > 1.3 || state.spinT > 2.2) {
      state.spinClear = false;
      state.spinT = 0;
      state.spinDir = 0;
      if (s.fwd > 1.0) { state.vx = 0.9; state.wz = 0; }
    }
    return;
  }
  state.spinT = 0;
  const dead = s.fwd < 0.85 && s.left < 1.15 && s.right < 1.15;
  if (state.backingUntil && performance.now() < state.backingUntil) {
    state.auto = true;
    state.vy = 0;
    if (s.rear < 0.55) { state.vx = 0; state.wz = s.left > s.right ? 2.2 : -2.2; }
    else { state.vx = -1.7; state.wz = 0; }
    if (s.fwd > 2.0 && (s.left > 2.2 || s.right > 2.2)) {
      state.backingUntil = 0;
      state.wz = s.left > s.right ? 1.6 : -1.6;
    }
    return;
  }
  if (dead && state.auto) {
    state.backingUntil = performance.now() + 2800;
    state.navPath = [];
    if (state.explore) {
      if (state.waypoints[state.wpIndex]) {
        state.skipFront = (state.skipFront || []).concat(state.waypoints[state.wpIndex]).slice(-16);
      }
      state.waypoints = [];
      state.wpIndex = 0;
    }
    state.vx = -1.7;
    state.wz = 0;
    return;
  }
  if (state.explore) {
    const cov = mapCoverage();
    const needNew = !state.waypoints.length || state.wpIndex >= state.waypoints.length;
    if (needNew) {
      const f = pickFrontier();
      if (f) {
        state.exploreSpin = 0;
        state.waypoints = [f];
        state.wpIndex = 0;
        state.navPath = [];
      } else {
        state.waypoints = [];
        state.wpIndex = 0;
        state.navPath = [];
        state.exploreSpin = (state.exploreSpin || 0) + 0.05;
        if (cov > 0.62 && state.exploreSpin > 10) {
          state.explore = false;
          state.auto = false;
          state.vx = state.vy = state.wz = 0;
          const ml = document.getElementById("mode-label");
          if (ml) ml.textContent = "TELEOP · карта собрана";
          const be = document.getElementById("btn-explore");
          if (be) be.textContent = "Автоскан";
          toast("Карта просмотрена (" + (cov * 100).toFixed(0) + "%)");
          return;
        }
        const s2 = lidarSectors();
        state.vy = 0;
        if (s2.fwd > 1.4) { state.vx = 0.9; state.wz = (s2.left - s2.right) * 0.5; }
        else { state.vx = 0; state.wz = 1.2; }
        state.auto = true;
        return;
      }
    }
    state.auto = true;
  }
  if (!state.auto) return;
  const wps = state.waypoints;
  if (!wps.length || state.wpIndex >= wps.length) {
    if (state.explore) return;
    if (state.loop && wps.length) {
      state.wpIndex = 0;
      state.navPath = [];
      state.auto = true;
      emit("nav", "цикл: круг сначала");
      return;
    }
    state.auto = false;
    state.vx = state.vy = state.wz = 0;
    setMission("IDLE");
    const ml = document.getElementById("mode-label");
    if (ml) ml.textContent = "TELEOP · симуляция";
    const ba = document.getElementById("btn-auto");
    if (ba) ba.textContent = "Старт маршрута";
    toast("Маршрут пройден");
    return;
  }
  const g = wps[state.wpIndex];
  const dist = Math.hypot(g.x - state.x, g.y - state.y);
  const arrive = state.docking ? 0.42 : 0.9;
  if (!state.docking && dist < 1.15) {
    state.nearWpT = (state.nearWpT || 0) + 0.05;
  } else {
    state.nearWpT = 0;
  }
  if (dist < arrive || (!state.docking && state.nearWpT > 1.2)) {
    state.skipFront = (state.skipFront || []).concat(g).slice(-16);
    emit("nav", "точка P" + (state.wpIndex + 1) + " пройдена");
    state.wpIndex++;
    if (state.loop && state.wpIndex >= wps.length) state.wpIndex = 0;
    state.navPath = [];
    state.nearWpT = 0;
    state.vx = 0;
    state.wz = 0;
    if (state.docking && state.wpIndex >= state.waypoints.length) {
      state.docking = false;
      emit("ok", "прибыл на базу");
    }
    return;
  }
  const stopD = Math.max(0.95, (state.clearance || 0.7) + 0.28);
  if (s.fwd < stopD || state.spinClear) {
    state.vx = 0;
    state.vy = 0;
    if (!state.spinDir) state.spinDir = s.left >= s.right ? 1 : -1;
    state.wz = state.spinDir * 1.9;
    state.spinClear = s.fwd < stopD + 0.4;
    if (!state.spinClear) state.spinDir = 0;
    return;
  }
  const now = performance.now();
  if (!state.navPath.length || now - state.planAt > 700) {
    state.navPath = planPath(g.x, g.y);
    state.planAt = now;
  }
  if (!state.navPath.length) {
    state.vx = 0.4;
    state.wz = s.left > s.right ? 0.8 : -0.8;
    if (state.explore) { state.wpIndex++; state.waypoints = []; }
    return;
  }
  const look = lookAhead(state.navPath);
  if (!look) {
    state.navPath = [];
    return;
  }
  const desired = Math.atan2(look.y - state.y, look.x - state.x);
  const err = angDiff(desired, state.yaw);
  const tunnel = s.left < 4.5 && s.right < 4.5 && s.fwd > 1.2;
  let wz = err * 1.4;
  if (tunnel) {
    const mid = s.left - s.right;
    wz = err * 1.1 + mid * 0.45;
    state.vy = 0;
  } else {
    state.vy = 0;
  }
  wz = Math.max(-1.5, Math.min(1.5, wz));
  if (Math.abs(err) > 1.4 && !tunnel) {
    state.vx = 0;
    state.wz = Math.max(-1.6, Math.min(1.6, err * 1.6));
    return;
  }
  state.wz = (state.wz || 0) * 0.4 + wz * 0.6;
  const turnSlow = Math.abs(err) > 0.6 ? 0.45 : 1;
  state.vx = Math.min(state.vmax, 1.4) * turnSlow * (s.fwd < 1.6 ? 0.5 : 1);
}

function screenToWorld(ev) {
  const c = document.getElementById("map");
  const r = c.getBoundingClientRect();
  const u = (ev.clientX - r.left) * (c.width / r.width);
  const v = (ev.clientY - r.top) * (c.height / r.height);
  return {
    x: mapView.camX + (u - mapView.ox) / mapView.scale,
    y: mapView.camY - (v - mapView.oy) / mapView.scale,
  };
}

function sim(dt) {
  followRoute();
  function approach(cur, tgt, acc, dec, dt) {
    const a = (Math.abs(tgt) > Math.abs(cur) && Math.sign(tgt) === Math.sign(cur || tgt)) ? acc : dec;
    const d = tgt - cur;
    const step = a * dt;
    if (Math.abs(d) <= step) return tgt;
    return cur + Math.sign(d) * step;
  }
  const loadK = 1 - Math.min(0.55, (state.payload || 0) / 500);
  state.spdVx = approach(state.spdVx, state.estop ? 0 : state.vx, 2.6 * loadK, 5.5, dt);
  state.spdVy = approach(state.spdVy, state.estop ? 0 : state.vy, 2.0, 5.0, dt);
  state.spdWz = approach(state.spdWz, state.estop ? 0 : state.wz, 3.2, 6.0, dt);
  if (!state.estop) {
    const c = Math.cos(state.yaw), s = Math.sin(state.yaw);
    const nx = state.x + (state.spdVx * c - state.spdVy * s) * dt;
    const ny = state.y + (state.spdVx * s + state.spdVy * c) * dt;
    const nyaw = state.yaw + state.spdWz * dt;
    if (bodyFree(nx, ny, nyaw)) {
      state.x = nx;
      state.y = ny;
      state.yaw = nyaw;
    } else if (bodyFree(state.x, state.y, nyaw)) {
      state.yaw = nyaw;
      state.spdVx = 0;
      state.spdVy = 0;
    } else {
      state.spdVx = 0;
      state.spdVy = 0;
      state.vx = 0;
      state.vy = 0;
      if (bodyFree(state.x, state.y, state.yaw + 0.12)) state.yaw += 0.12;
      else if (bodyFree(state.x, state.y, state.yaw - 0.12)) state.yaw -= 0.12;
      state.spinClear = true;
      state.navPath = [];
    }
  }
  const spd = Math.hypot(state.spdVx, state.spdVy);
  state.current = 2.2 + spd * 6 + Math.abs(state.wz) * 2;
  if (!state.charging) {
    state.bat = Math.max(44, state.bat - dt * 0.0008 * state.current);
    state.soc = ((state.bat - 44) / (54.6 - 44)) * 100;
  }
  if (!state.trail) state.trail = [];
  const lastT = state.trail[state.trail.length - 1];
  if (!lastT || Math.hypot(state.x - lastT.x, state.y - lastT.y) > 0.35) {
    state.trail.push({ x: state.x, y: state.y });
    if (state.trail.length > 400) state.trail.shift();
  }
  state.lightGreen = true;
  const nowMs = performance.now();
  if (nowMs - (state.lastSign || 0) > 2500) {
    for (const sg of WORLD.signs || []) {
      if (sg.kind === "light") continue;
      if (Math.hypot(sg.x - state.x, sg.y - state.y) > 1.05) continue;
      state.lastSign = nowMs;
      if (sg.kind === "stop") state.bubble = "СТОП";
      else if (sg.kind === "cross") { state.bubble = "переход"; state.vx = Math.min(state.vx, 0.6); }
      else if (sg.kind === "bump") { state.bubble = "неровность"; state.vx = Math.min(state.vx, 0.45); }
    }
  }
  if (state.charging) {
    const dock = stationOf("dock") || { x: 0, y: -1.2 };
    const onPad = Math.hypot(dock.x - state.x, dock.y - state.y) < 1.15;
    if (onPad) {
      state.vx = state.vy = state.wz = 0;
      state.spdVx = state.spdVy = state.spdWz = 0;
      state.auto = false;
      state.docking = false;
      state.soc = Math.min(100, state.soc + dt * 7);
      state.bat = 44 + (state.soc / 100) * (54.6 - 44);
      state.bubble = "заряд " + state.soc.toFixed(0) + "% → " + (state.chargeTo || 80) + "%";
      if (state.soc >= (state.chargeTo || 80) - 0.2) {
        state.soc = state.chargeTo || 80;
        state.bat = 44 + (state.soc / 100) * (54.6 - 44);
        state.charging = false;
        state.bubble = "заряд готов";
        emit("ok", "заряжен до " + state.soc.toFixed(0) + "%");
        toast("Зарядка завершена");
      }
    }
  }
  if (state.soc < 18 && !state.docking && !state.charging && !state.estop) {
    emit("warn", "низкий SOC — возврат на базу");
    goCharge();
  }
  state.watchdogMs = 28 + Math.random() * 18;
  const kin = compute4WIS(state.spdVx, state.spdVy, state.spdWz);
  state.kin = kin;
  state.modules.forEach((m) => {
    const k = kin.find((q) => q.id === m.id);
    m.rpm = k ? k.rpm : spd * 180;
    m.steer = k ? k.steer * 180 / Math.PI : 0;
    m.temp = 34 + spd * 4 + Math.random();
  });
  const hint = document.getElementById("crab-hint");
  if (hint) {
    hint.textContent = state.crab
      ? "краб: все колёса " + (kin[0] ? (kin[0].steer * 180 / Math.PI).toFixed(0) : "0") + "°"
      : "4WIS: рули от vx/vy/wz";
  }
  state.scan = [];
  for (let i = 0; i < LIDAR_BEAMS; i++) {
    const a = state.yaw + (i / LIDAR_BEAMS) * Math.PI * 2;
    state.scan.push({ a, r: raycast(state.x, state.y, a, LIDAR_MAX) });
  }
  integrateScan();

  // --- BATTERY UI ---
  const soc = Math.max(0, Math.min(100, state.soc));
  const pctEl = document.getElementById("bat-percent");
  if (pctEl) pctEl.textContent = soc.toFixed(0)+"%";
  const vEl = document.getElementById("bat-v");
  if (vEl) vEl.textContent = state.bat.toFixed(1)+" В";
  const vDet = document.getElementById("bat-volt-detail");
  if (vDet) vDet.textContent = state.bat.toFixed(1)+" В";
  const socEl = document.getElementById("bat-soc");
  if (socEl) socEl.textContent = soc.toFixed(0)+"%";
  const curEl = document.getElementById("bat-current");
  if (curEl) curEl.textContent = state.current.toFixed(1)+" А";
  const tgtEl = document.getElementById("bat-target");
  if (tgtEl) tgtEl.textContent = (state.chargeTo||80)+"%";
  const remain = document.getElementById("bat-remain");
  if (remain) {
    const hours = soc>5 ? (state.bat*18.6/1000) / Math.max(0.1,state.current) : 0;
    remain.textContent = state.charging ? `→ ${state.chargeTo}%` : `${hours.toFixed(1)} ч`;
  }
  const bar = document.getElementById("bat-bar");
  if (bar) bar.style.width = soc.toFixed(0)+"%";
  const circle = document.getElementById("bat-circle");
  if (circle) {
    const circ = 2*Math.PI*40;
    const offset = circ - (soc/100)*circ;
    circle.style.strokeDasharray = circ;
    circle.style.strokeDashoffset = offset;
    circle.classList.toggle("low", soc<20);
    circle.classList.toggle("charging", !!state.charging);
  }
  const chIcon = document.getElementById("bat-charging-icon");
  if (chIcon) chIcon.classList.toggle("on", !!state.charging);
  const chInd = document.getElementById("charge-indicator");
  if (chInd) {
    chInd.classList.toggle("on", !!state.charging);
    const ct = document.getElementById("charge-text");
    if (ct) ct.textContent = state.charging ? `ЗАРЯДКА ${soc.toFixed(0)}% → ${state.chargeTo}%` : "ЗАРЯДКА";
  }
  const bStat = document.getElementById("bat-status");
  if (bStat) bStat.textContent = state.charging ? `зарядка до ${state.chargeTo}% · ${state.bat.toFixed(1)}В · BMS балансировка` : `разряд · ${state.bat.toFixed(1)}В · 18.6 А·ч · BMS OK · 34°C`;
  const bDelta = document.getElementById("bat-delta");
  if (bDelta) bDelta.textContent = state.charging ? `заряд ${soc.toFixed(0)}%` : `ток ${state.current.toFixed(1)} А`;
  const batChip = document.getElementById("bat-chip");
  if (batChip) batChip.textContent = `● АКБ ${soc.toFixed(0)}% ${state.charging?'⚡':''}`;

  // top metrics & HUD
  const odom = document.getElementById("odom-xy");
  if (odom) odom.textContent = Math.hypot(state.x, state.y).toFixed(2)+" м";
  const odomD = document.getElementById("odom-delta");
  if (odomD) odomD.textContent = `x ${state.x.toFixed(2)} · y ${state.y.toFixed(2)} · yaw ${(state.yaw*180/Math.PI).toFixed(0)}°`;
  const legX = document.getElementById("leg-x");
  if (legX) legX.textContent = state.x.toFixed(2)+" м";
  const legY = document.getElementById("leg-y");
  if (legY) legY.textContent = state.y.toFixed(2)+" м";
  const legYaw = document.getElementById("leg-yaw");
  if (legYaw) legYaw.textContent = (state.yaw*180/Math.PI).toFixed(0)+"°";
  const legV = document.getElementById("leg-v");
  if (legV) legV.textContent = spd.toFixed(2)+" м/с";
  const hudMode = document.getElementById("hud-mode");
  if (hudMode) hudMode.textContent = state.estop ? "E-STOP" : state.auto ? "AUTO" : "TELEOP";
  const spdEl = document.getElementById("spd");
  if (spdEl) spdEl.textContent = (spd * 3.6).toFixed(1)+" км/ч";
  const spdD = document.getElementById("spd-delta");
  if (spdD) spdD.textContent = `${spd.toFixed(2)} м/с · max 18 км/ч`;
  const gateD = document.getElementById("gate-delta");
  if (gateD) gateD.textContent = `e-stop ${state.estop ? "вкл" : "выкл"} · вотчдог ${state.watchdogMs.toFixed(0)} мс`;
  const gate = document.getElementById("gate");
  if (gate) gate.textContent = state.estop ? "HOLD" : "OK";
  const cov = document.getElementById("map-coverage");
  if (cov) cov.textContent = `${(mapCoverage()*100).toFixed(1)}% изучено`;
  const covBar = document.getElementById("coverage-bar");
  if (covBar) covBar.style.width = (mapCoverage()*100).toFixed(0)+"%";
  const hudCov = document.getElementById("hud-coverage");
  if (hudCov) hudCov.textContent = (mapCoverage()*100).toFixed(1)+"%";
  const hudWp = document.getElementById("hud-wp");
  if (hudWp) hudWp.textContent = state.waypoints.length;
  const mapCoords = document.getElementById("map-coords");
  if (mapCoords) mapCoords.textContent = `x ${state.x.toFixed(2)} · y ${state.y.toFixed(2)} · yaw ${(state.yaw*180/Math.PI).toFixed(0)}° · масштаб ${mapView.scale.toFixed(0)} px/м · ${state.waypoints.length} точек`;
  const camYawF = document.getElementById("cam-yaw-f");
  if (camYawF) camYawF.textContent = (state.yaw*180/Math.PI).toFixed(0)+"°";
  const sectors = lidarSectors();
  const detF = document.getElementById("det-front");
  if (detF) {
    if (sectors.fwd < 1.0) detF.textContent = `препятствие ${sectors.fwd.toFixed(2)}м`;
    else detF.textContent = state.bubble || "нет · проезд свободен";
  }
  const distF = document.getElementById("cam-dist-f");
  if (distF) distF.textContent = sectors.fwd < 9 ? sectors.fwd.toFixed(2)+" м" : "свободно";
  const distR = document.getElementById("cam-dist-r");
  if (distR) distR.textContent = sectors.rear < 9 ? sectors.rear.toFixed(2)+" м" : "свободно";
  const camStatR = document.getElementById("cam-status-r");
  if (camStatR) camStatR.textContent = sectors.rear < 0.8 ? "СТОП" : "OK";
  const camSpeedR = document.getElementById("cam-speed-r");
  if (camSpeedR) camSpeedR.textContent = (spd*3.6).toFixed(1)+" км/ч";
  const payloadMetric = document.getElementById("payload-metric");
  if (payloadMetric) payloadMetric.textContent = state.payload+" кг";
  const payDetail = document.getElementById("pay-detail");
  if (payDetail) payDetail.textContent = state.cargo ? `в отсеке ${state.payload} кг · доставлено ${state.delivered||0}` : "отсек пустой · IP65";
  const logCount = document.getElementById("log-count");
  if (logCount) logCount.textContent = `${state.logs.length} строк`;
  const camHud = document.getElementById("cam-hud");
  if (camHud) camHud.textContent = `${state.beacon?'маяк вкл':'маяк выкл'} · ${state.payload}кг · ${state.cargo?'груз': 'пусто'} · ${sectors.fwd.toFixed(1)}м`;
  const camTs = document.getElementById("cam-ts");
  if (camTs) camTs.textContent = `${new Date().toLocaleTimeString("ru-RU")} · ROS2 · /camera/front · ${spd.toFixed(2)} м/с`;

  renderModules();
}

let last = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  try {
    applyKeys();
    publishCmd();
    sim(dt);
    drawStick();
    drawMap();
    drawChassisPanel();
    drawCam(now);
    drawLidar();
  } catch (err) {
    console.error(err);
  }
  requestAnimationFrame(loop);
}

const stick = document.getElementById("stick");
function stickFromEvent(ev) {
  if (!stick) return;
  const r = stick.getBoundingClientRect();
  const x = (ev.clientX - r.left) / r.width * 2 - 1;
  const y = (ev.clientY - r.top) / r.height * 2 - 1;
  state.vy = Math.max(-1, Math.min(1, x)) * state.vmax * (state.crab ? 1 : 0);
  state.vx = Math.max(-1, Math.min(1, -y)) * state.vmax;
  if (!state.crab) state.wz = Math.max(-1, Math.min(1, -x)) * state.vmax * 1.1;
}
let dragging = false;
if (stick){
  stick.addEventListener("pointerdown", (e) => { dragging = true; stick.setPointerCapture(e.pointerId); stickFromEvent(e); });
  stick.addEventListener("pointermove", (e) => { if (dragging) stickFromEvent(e); });
  stick.addEventListener("pointerup", () => { dragging = false; state.vx = state.vy = state.wz = 0; });
}

const ROUTES_KEY = "rus_slam_route_groups";
function loadGroups() {
  try { return JSON.parse(localStorage.getItem(ROUTES_KEY) || "[]"); }
  catch { return []; }
}
function saveGroups(list) {
  localStorage.setItem(ROUTES_KEY, JSON.stringify(list));
  fillRouteSelect();
}
function fillRouteSelect() {
  const sel = document.getElementById("route-list");
  if (!sel) return;
  const list = loadGroups();
  sel.innerHTML = list.length
    ? list.map((g, i) => `<option value="${i}">${g.name} (${g.points.length})</option>`).join("")
    : `<option value="">нет групп</option>`;
}
const saveBtn = document.getElementById("btn-save-route");
if (saveBtn) {
  saveBtn.addEventListener("click", () => {
    if (!state.waypoints.length) { toast("Нет точек для сохранения"); return; }
    const name = (document.getElementById("route-name").value || "").trim()
      || ("группа " + new Date().toLocaleTimeString("ru-RU", { hour12: false }));
    const list = loadGroups();
    const i = list.findIndex((g) => g.name === name);
    const rec = { name, points: state.waypoints.map((p) => ({ x: p.x, y: p.y })) };
    if (i >= 0) list[i] = rec; else list.push(rec);
    saveGroups(list);
    toast("Сохранено: " + name);
  });
  safeOn("btn-load-route","click",()=>{
    const list = loadGroups();
    const i = Number(document.getElementById("route-list").value);
    if (!list[i]) { toast("Выберите группу"); return; }
    state.waypoints = list[i].points.map((p) => ({ x: p.x, y: p.y }));
    state.wpIndex = 0;
    state.auto = false;
    toast("Загружено: " + list[i].name);
  });
  safeOn("btn-del-route","click",()=>{
    const list = loadGroups();
    const i = Number(document.getElementById("route-list").value);
    if (!list[i]) return;
    const n = list[i].name;
    list.splice(i, 1);
    saveGroups(list);
    toast("Удалено: " + n);
  });
  fillRouteSelect();
}

safeOn("btn-explore","click",()=>{
  if (state.estop) { toast("Снимите E-stop"); return; }
  state.explore = !state.explore;
  if (state.explore) {
    state.auto = true;
    state.wpIndex = 0;
    const f = pickFrontier();
    state.waypoints = f ? [f] : [];
    state.navPath = [];
    setMission("NAVIGATE");
    const ml = document.getElementById("mode-label");
    if (ml) ml.textContent = "AUTO · сканирование до полной карты";
    const be = document.getElementById("btn-explore");
    if (be) be.textContent = "Стоп скана";
    toast("Едем, пока не откроем всю карту");
  } else {
    state.auto = false;
    state.vx = state.vy = state.wz = 0;
    const ml = document.getElementById("mode-label");
    if (ml) ml.textContent = "TELEOP · симуляция";
    const be = document.getElementById("btn-explore");
    if (be) be.textContent = "Автоскан";
  }
});

function goCharge() {
  state.chargeTo = Number(document.getElementById("chg-target")?.value || state.chargeTo || 80);
  state.charging = true;
  state.bubble = "еду зарядиться";
  goDock();
  emit("nav", "база · заряд до " + state.chargeTo + "%");
}
function goDock() {
  seedStationPads();
  const dock = stationOf("dock") || { x: 0, y: -1.2 };
  const s = snapToDriveable(dock.x, dock.y) || dock;
  state.docking = true;
  state.explore = false;
  state.pause = false;
  state.bubble = "на базу";
  state.waypoints = [s];
  state.wpIndex = 0;
  state.navPath = [];
  state.auto = true;
  setMission("RETURN");
  const ml = document.getElementById("mode-label");
  if (ml) ml.textContent = "AUTO · на базу";
  const be = document.getElementById("btn-explore");
  if (be) be.textContent = "Автоскан";
  emit("nav", "еду на базу");
}

safeOn("btn-pause","click",()=>{
  const elPause = document.getElementById("btn-pause");
  state.pause = !state.pause;
  if (elPause) {
    elPause.classList.toggle("on", state.pause);
    elPause.textContent = state.pause ? "Продолжить" : "Пауза";
  }
  state.vx = state.vy = state.wz = 0;
  emit(state.pause ? "warn" : "ok", state.pause ? "пауза" : "продолжили");
});
safeOn("btn-skip","click",()=>{
  state.wpIndex++;
  state.navPath = [];
  emit("warn", "пропуск точки");
});
safeOn("btn-dock","click",goDock);
safeOn("btn-loop","click",()=>{
  const elLoop = document.getElementById("btn-loop");
  state.loop = !state.loop;
  if (elLoop) elLoop.classList.toggle("on", state.loop);
  emit("ok", state.loop ? "цикл вкл — едем по кругу" : "цикл выкл");
  if (state.loop && state.waypoints.length) {
    state.auto = true;
    state.pause = false;
    if (state.wpIndex >= state.waypoints.length) state.wpIndex = 0;
    const ba = document.getElementById("btn-auto");
    if (ba) ba.textContent = "Стоп авто";
    const ml = document.getElementById("mode-label");
    if (ml) ml.textContent = "AUTO · цикл";
    setMission("NAVIGATE");
  }
});
safeOn("btn-reverse","click",()=>{
  state.waypoints.reverse();
  state.wpIndex = 0;
  state.navPath = [];
  emit("ok", "точки в обратном порядке");
});
safeOn("btn-from-trail","click",()=>{
  const t = state.trail || [];
  if (t.length < 4) { toast("Сначала поездите — след пустой"); return; }
  const pts = [];
  for (let i = 0; i < t.length; i += 6) pts.push({ x: t[i].x, y: t[i].y });
  state.waypoints = pts;
  state.wpIndex = 0;
  emit("ok", "маршрут из следа: " + pts.length + " точек");
  toast("Точки со следа");
});
safeOn("btn-lights","click",()=>{
  state.lights = !state.lights;
  emit("ok", state.lights ? "фары вкл" : "фары выкл");
});
safeOn("btn-shot","click",()=>{
  const a = document.createElement("a");
  a.download = "rus_slam_map.png";
  const mc = document.getElementById("map");
  if (!mc) return;
  a.href = mc.toDataURL("image/png");
  a.click();
  emit("ok", "снимок карты");
});
safeOn("payload","input",(e)=>{
  state.payload = Number(e.target.value);
  const pv = document.getElementById("pay-val");
  if (pv) pv.textContent = state.payload + " кг";
});
const elChg = document.getElementById("chg-target");
function syncChargeTarget() {
  const v = Math.max(40, Math.min(100, Number(elChg?.value || 80)));
  state.chargeTo = v;
  const lab = document.getElementById("chg-val");
  if (lab) lab.textContent = v + "%";
  const tgt = document.getElementById("bat-target");
  if (tgt) tgt.textContent = v+"%";
}
if (elChg) {
  elChg.addEventListener("input", syncChargeTarget);
  elChg.addEventListener("change", syncChargeTarget);
  syncChargeTarget();
}
safeOn("btn-charge","click",()=>{
  if (state.estop) { toast("Снимите E-stop"); return; }
  syncChargeTarget();
  goCharge();
  toast("Еду на базу, заряд до " + state.chargeTo + "%");
});
safeOn("beacon","change",(e)=>{ state.beacon = e.target.checked; });
safeOn("cargo","change",(e)=>{ state.cargoLock = e.target.checked; });
safeOn("btn-horn","click",()=>{ toast("Бип 85 дБ"); emit("warn", "зуммер"); });
safeOn("btn-clear-logs","click",()=>{ state.logs=[]; renderLogs(); });

document.querySelectorAll(".prog-btns [data-blk]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.program.push(btn.dataset.blk);
    renderProg();
  });
});
// fallback for any data-blk elsewhere
document.querySelectorAll("[data-blk]").forEach((btn)=>{
  if (btn.closest(".prog-btns")) return;
  btn.addEventListener("click", () => {
    state.program.push(btn.dataset.blk);
    renderProg();
  });
});
safeOn("btn-prog-run","click",()=>{
  if (!state.program.length) {
    state.program = ["goA", "load", "goB", "unload", "dock"];
  }
  state.progI = 0;
  state.progRun = true;
  state.pause = false;
  setMission("NAVIGATE");
  const ml = document.getElementById("mode-label");
  if (ml) ml.textContent = "AUTO · программа А→Б";
  emit("nav", "старт программы");
  renderProg();
});
safeOn("btn-prog-stop","click",()=>{
  state.progRun = false;
  state.auto = false;
  state.vx = state.vy = state.wz = 0;
  emit("warn", "программа стоп");
});
safeOn("btn-prog-clear","click",()=>{
  state.program = [];
  state.progRun = false;
  renderProg();
});
safeOn("btn-load-act","click",confirmLoad);
safeOn("btn-unload-act","click",confirmUnload);
safeOn("place-A","click",()=>{ state.placeMode = "load"; toast("Клик по карте → А"); });
safeOn("place-B","click",()=>{ state.placeMode = "unload"; toast("Клик по карте → Б"); });
safeOn("place-D","click",()=>{ state.placeMode = "dock"; toast("Клик по карте → база"); });
safeOn("place-S","click",()=>{ state.placeMode = "start"; toast("Клик по карте → старт"); });
renderProg();

function applyTheme(dark) {
  document.body.classList.toggle("dark", !!dark);
  try { localStorage.setItem("rus_slam_theme", dark ? "dark" : "light"); } catch (_) {}
  const b = document.getElementById("btn-theme");
  if (b) b.textContent = dark ? "☀" : "◐";
}
try { applyTheme(localStorage.getItem("rus_slam_theme") !== "light"); } catch (_) { applyTheme(true); }
safeOn("btn-theme","click",()=>{
  applyTheme(!document.body.classList.contains("dark"));
});
safeOn("btn-refresh","click",()=>location.reload());

renderModules();
renderFsm();
renderDets();
log("ok", "пульт RUS SLAM онлайн · ZMK дизайн");
log("warn", "CAM-F / CAM-R симуляция");
log("ok", "4WIS · LiDAR LDC01 · батарея LiFePO4 12S3P · 250 кг");
seedStationPads();
requestAnimationFrame(loop);
