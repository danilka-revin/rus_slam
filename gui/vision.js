/* RUS SLAM - Vision & SLAM rendering - ZMK redesign */
const WORLD = {
  walls: [
    { x: -18, y: -12, w: 36, h: 0.35 },
    { x: -18, y: 11.65, w: 36, h: 0.35 },
    { x: -18, y: -12, w: 0.35, h: 24 },
    { x: 17.65, y: -12, w: 0.35, h: 24 },
  ],
  racks: [
    { x: -16.5, y: -10.4, w: 15.2, h: 1.25, label: "ряд A1" },
    { x: 1.8, y: -10.4, w: 14.5, h: 1.25, label: "ряд A2" },
    { x: -16.5, y: -6.6, w: 15.2, h: 1.25, label: "ряд B1" },
    { x: 1.8, y: -6.6, w: 14.5, h: 1.25, label: "ряд B2" },
    { x: -16.5, y: 3.4, w: 15.2, h: 1.25, label: "ряд C1" },
    { x: 1.8, y: 3.4, w: 14.5, h: 1.25, label: "ряд C2" },
    { x: -16.5, y: 7.4, w: 15.2, h: 1.25, label: "ряд D1" },
    { x: 1.8, y: 7.4, w: 14.5, h: 1.25, label: "ряд D2" },
    { x: 14.8, y: -2.2, w: 2.4, h: 4.2, label: "ворота" },
  ],
  signs: [
    { x: -8, y: -8.4, kind: "stop", label: "СТОП" },
    { x: 6, y: -8.4, kind: "cross", label: "переход" },
    { x: -2, y: 5.4, kind: "bump", label: "неровность" },
  ],
  stations: [
    { id: "A", x: -9.5, y: -1.2, kind: "load", label: "А · загрузка" },
    { id: "B", x: 9.5, y: -1.2, kind: "unload", label: "Б · выгрузка" },
    { id: "D", x: 0, y: -1.2, kind: "dock", label: "база" },
  ],
};

const LIDAR_FOV = Math.PI * 2;
const LIDAR_BEAMS = 180;
const LIDAR_MAX = 10;
const GRID_RES = 0.12;
const GRID_W = 320;
const GRID_H = 240;
const GRID_OX = -18;
const GRID_OY = -12;
const UNK = 0, FREE = 1, OCC = 2;
const grid = new Uint8Array(GRID_W * GRID_H);
const distGrid = new Float32Array(GRID_W * GRID_H);
let explored = 0;
let distDirty = true;

function rebuildDist() {
  const W = GRID_W, H = GRID_H, INF = 1e6;
  for (let i = 0; i < W * H; i++) distGrid[i] = grid[i] === OCC ? 0 : INF;
  for (let y = 1; y < H; y++) {
    for (let x = 1; x < W; x++) {
      const i = y * W + x;
      const a = distGrid[(y - 1) * W + x] + 1;
      const b = distGrid[y * W + (x - 1)] + 1;
      const c = distGrid[(y - 1) * W + (x - 1)] + 1.414;
      if (a < distGrid[i]) distGrid[i] = a;
      if (b < distGrid[i]) distGrid[i] = b;
      if (c < distGrid[i]) distGrid[i] = c;
    }
  }
  for (let y = H - 2; y >= 0; y--) {
    for (let x = W - 2; x >= 0; x--) {
      const i = y * W + x;
      const a = distGrid[(y + 1) * W + x] + 1;
      const b = distGrid[y * W + (x + 1)] + 1;
      const c = distGrid[(y + 1) * W + (x + 1)] + 1.414;
      if (a < distGrid[i]) distGrid[i] = a;
      if (b < distGrid[i]) distGrid[i] = b;
      if (c < distGrid[i]) distGrid[i] = c;
    }
  }
  distDirty = false;
}
function distM(ix, iy) {
  if (distDirty) rebuildDist();
  return distGrid[iy * GRID_W + ix] * GRID_RES;
}

function hitRect(x, y, r) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}
function occupied(x, y) {
  for (const w of WORLD.walls) if (hitRect(x, y, w)) return true;
  for (const w of WORLD.racks) if (hitRect(x, y, w)) return true;
  return false;
}
function bodyFree(x, y, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const hx = 0.46, hy = 0.28;
  for (const [lx, ly] of [[hx,0],[-hx,0],[0,hy],[0,-hy],[hx,hy],[hx,-hy],[-hx,hy],[-hx,-hy],[hx*0.5,hy],[hx*0.5,-hy],[-hx*0.5,hy],[-hx*0.5,-hy],[0,0]]) {
    const wx = x + c * lx - s * ly, wy = y + s * lx + c * ly;
    if (occupied(wx, wy)) return false;
    const i = gi(wx, wy);
    if (i >= 0 && grid[i] === OCC) return false;
  }
  return true;
}
function raycast(ox, oy, ang, maxR = LIDAR_MAX) {
  const cs = Math.cos(ang), sn = Math.sin(ang);
  for (let t = 0.2; t < maxR; t += 0.08) {
    if (occupied(ox + cs * t, oy + sn * t)) return t;
  }
  return maxR;
}

function gi(x, y) {
  const ix = Math.floor((x - GRID_OX) / GRID_RES);
  const iy = Math.floor((y - GRID_OY) / GRID_RES);
  if (ix < 0 || iy < 0 || ix >= GRID_W || iy >= GRID_H) return -1;
  return iy * GRID_W + ix;
}
function setCell(i, v) {
  if (i < 0) return;
  if (grid[i] === UNK && v !== UNK) explored++;
  if (v === OCC || grid[i] !== OCC) grid[i] = v;
}

function integrateScan() {
  const ox = state.x, oy = state.y;
  for (const p of state.scan) {
    const cs = Math.cos(p.a), sn = Math.sin(p.a);
    const hit = p.r < LIDAR_MAX - 0.15;
    const maxT = hit ? p.r : p.r;
    for (let t = 0.15; t < maxT; t += GRID_RES) {
      setCell(gi(ox + cs * t, oy + sn * t), FREE);
    }
    if (hit) {
      setCell(gi(ox + cs * p.r, oy + sn * p.r), OCC);
      setCell(gi(ox + cs * (p.r + 0.06), oy + sn * (p.r + 0.06)), OCC);
    }
  }
  distDirty = true;
}

function toBody(wx, wy) {
  const dx = wx - state.x, dy = wy - state.y;
  const c = Math.cos(state.yaw), s = Math.sin(state.yaw);
  return { fwd: dx * c + dy * s, left: -dx * s + dy * c };
}
function mapPt(wx, wy, ox, oy, scale) {
  return {
    u: ox + (wx - mapView.camX) * scale,
    v: oy - (wy - mapView.camY) * scale,
  };
}
const mapView = { scale: 22, ox: 0, oy: 0, camX: 0, camY: 0, follow: true };

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCamView(canvasId, yawOff, title, isRear) {
  const c = document.getElementById(canvasId);
  if (!c) return;
  const ctx = c.getContext("2d");
  const w = c.width, h = c.height;
  // sky gradient
  const sky = ctx.createLinearGradient(0,0,0,h);
  sky.addColorStop(0,"#1a2520");
  sky.addColorStop(0.45,"#0f1a15");
  sky.addColorStop(0.5,"#0b120f");
  sky.addColorStop(1,"#0b120f");
  ctx.fillStyle = sky;
  ctx.fillRect(0,0,w,h);

  const yaw = state.yaw + yawOff;
  // floor with perspective lines
  ctx.fillStyle = "rgba(213,255,69,0.06)";
  ctx.fillRect(0, h*0.52, w, h*0.48);
  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  ctx.lineWidth = 1;
  for (let i=0;i<w;i+=40){
    ctx.beginPath(); ctx.moveTo(i, h*0.52); ctx.lineTo(i + (i-w/2)*0.3, h); ctx.stroke();
  }
  for (let y=h*0.55;y<h;y+=18){
    ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke();
  }

  // raycast walls
  for (let col = 0; col < w; col += 2) {
    const ang = yaw + ((col / w) - 0.5) * 1.25;
    const r = raycast(state.x, state.y, ang, 10);
    const wallH = Math.min(h * 0.85, (220 / Math.max(0.35, r)));
    const y0 = (h - wallH) / 2 - (isRear?0: h*0.02);
    const shade = Math.max(20, 150 - r * 13);
    // rack vs wall color
    const isRack = r < 9 && Math.abs(Math.sin(ang*2))>0.2;
    if (r < LIDAR_MAX-0.2){
      ctx.fillStyle = isRack ? `rgb(${shade*0.7|0},${shade*0.55|0},${30})` : `rgb(${shade*0.5|0},${shade*0.55|0},${shade*0.6|0})`;
      ctx.fillRect(col, y0, 2, wallH);
      // highlight top
      ctx.fillStyle = `rgba(213,255,69,${Math.max(0,0.25 - r*0.02)})`;
      ctx.fillRect(col, y0, 2, 3);
    }
  }

  // stations as markers in cam view
  for (const st of WORLD.stations || []) {
    const dx = st.x - state.x, dy = st.y - state.y;
    const dist = Math.hypot(dx,dy);
    if (dist>9) continue;
    const ang = Math.atan2(dy,dx);
    let rel = ang - yaw;
    while (rel > Math.PI) rel -= Math.PI*2;
    while (rel < -Math.PI) rel += Math.PI*2;
    if (Math.abs(rel) > 0.65) continue;
    const col = (rel/1.25 + 0.5)*w;
    const size = Math.max(8, 60 / Math.max(0.5, dist));
    ctx.fillStyle = st.kind==="load" ? "#7ddc52" : st.kind==="unload" ? "#e4503e" : "#d5ff45";
    ctx.beginPath(); ctx.arc(col, h*0.52, size/2, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = "#101b17";
    ctx.font = `bold ${Math.max(8,size*0.6)}px Inter`;
    ctx.textAlign="center";
    ctx.fillText(st.id, col, h*0.52+3);
  }

  // vignette
  const vig = ctx.createRadialGradient(w/2,h/2,0,w/2,h/2,Math.max(w,h)*0.7);
  vig.addColorStop(0,"rgba(0,0,0,0)");
  vig.addColorStop(1,"rgba(0,0,0,0.45)");
  ctx.fillStyle = vig;
  ctx.fillRect(0,0,w,h);

  // title
  ctx.fillStyle = "#d5ff45";
  ctx.font = "bold 12px Inter, sans-serif";
  ctx.textAlign="left";
  ctx.fillText(title, 12, 20);
  // crosshair
  ctx.strokeStyle = "rgba(213,255,69,0.25)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(w/2-12, h/2); ctx.lineTo(w/2+12, h/2);
  ctx.moveTo(w/2, h/2-12); ctx.lineTo(w/2, h/2+12);
  ctx.stroke();
  ctx.strokeStyle = "rgba(213,255,69,0.12)";
  ctx.strokeRect(w/2-40, h/2-24, 80, 48);
}

function drawCam() {
  drawCamView("cam", 0, "CAM-F · ПЕРЕД · 120° FOV", false);
  drawCamView("cam-rear", Math.PI, "CAM-R · НАЗАД · 120° FOV", true);
  const hud = document.getElementById("cam-hud");
  if (hud) hud.textContent = `sim · ${state.beacon?'маяк вкл':'маяк выкл'} · ${state.payload}кг`;
}

function drawMap() {
  const c = document.getElementById("map");
  if (!c) return;
  const ctx = c.getContext("2d");
  const dw = Math.max(320, c.clientWidth | 0);
  const dh = Math.max(240, c.clientHeight | 0);
  if (c.width !== dw || c.height !== dh) { c.width = dw; c.height = dh; }
  const w = c.width, h = c.height;
  // background
  ctx.fillStyle = "#121a16";
  ctx.fillRect(0, 0, w, h);
  // grid
  ctx.strokeStyle = "rgba(255,255,255,0.03)";
  ctx.lineWidth = 1;
  const gs = mapView.scale;
  const ox0 = w*0.5 - (mapView.camX - GRID_OX)*gs;
  const oy0 = h*0.5 + (mapView.camY - GRID_OY)*gs;
  // subtle grid lines every 1m
  for (let x=-18;x<18;x++){
    const u = ox0 + (x - GRID_OX)*gs;
    if (u<0||u>w) continue;
    ctx.beginPath(); ctx.moveTo(u,0); ctx.lineTo(u,h); ctx.stroke();
  }
  for (let y=-12;y<12;y++){
    const v = oy0 - (y - GRID_OY)*gs;
    if (v<0||v>h) continue;
    ctx.beginPath(); ctx.moveTo(0,v); ctx.lineTo(w,v); ctx.stroke();
  }

  if (mapView.follow) {
    mapView.camX = state.x;
    mapView.camY = state.y;
  }
  const scale = mapView.scale;
  const ox = w * 0.5, oy = h * 0.5;
  mapView.ox = ox; mapView.oy = oy;

  const cell = GRID_RES * scale;
  const margin = 12;
  const ix0 = Math.max(0, Math.floor((mapView.camX - (w * 0.5) / scale - GRID_OX) / GRID_RES) - 2);
  const ix1 = Math.min(GRID_W, Math.ceil((mapView.camX + (w * 0.5) / scale - GRID_OX) / GRID_RES) + 2);
  const iy0 = Math.max(0, Math.floor((mapView.camY - (h * 0.5) / scale - GRID_OY) / GRID_RES) - 2);
  const iy1 = Math.min(GRID_H, Math.ceil((mapView.camY + (h * 0.5) / scale - GRID_OY) / GRID_RES) + 2);
  for (let iy = iy0; iy < iy1; iy++) {
    for (let ix = ix0; ix < ix1; ix++) {
      const v = grid[iy * GRID_W + ix];
      if (v === UNK) continue;
      const p = mapPt(GRID_OX + (ix + 0.5) * GRID_RES, GRID_OY + (iy + 0.5) * GRID_RES, ox, oy, scale);
      if (p.u < -margin || p.v < -margin || p.u > w + margin || p.v > h + margin) continue;
      if (v === OCC) {
        ctx.fillStyle = "#6b5a3a";
        ctx.fillRect(p.u - cell * 0.52, p.v - cell * 0.52, cell*1.04, cell*1.04);
        ctx.fillStyle = "rgba(213,255,69,0.08)";
        ctx.fillRect(p.u - cell*0.52, p.v - cell*0.52, cell*1.04, 2);
      } else {
        ctx.fillStyle = "#2a332e";
        ctx.fillRect(p.u - cell * 0.5, p.v - cell * 0.5, cell*0.95, cell*0.95);
      }
    }
  }

  // lidar range circle
  ctx.strokeStyle = "rgba(213,255,69,0.10)";
  ctx.lineWidth = 1;
  ctx.setLineDash([6,6]);
  ctx.beginPath();
  ctx.arc(ox, oy, LIDAR_MAX * scale, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  // inner circles
  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  for (let r=2;r<LIDAR_MAX;r+=2){
    ctx.beginPath(); ctx.arc(ox,oy,r*scale,0,Math.PI*2); ctx.stroke();
  }

  // scan polygon
  if (state.scan && state.scan.length){
    ctx.fillStyle = "rgba(255,90,74,0.08)";
    ctx.strokeStyle = "rgba(255,90,74,0.28)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    state.scan.forEach((p, i) => {
      const q = mapPt(state.x + Math.cos(p.a) * p.r, state.y + Math.sin(p.a) * p.r, ox, oy, scale);
      if (i === 0) ctx.moveTo(q.u, q.v); else ctx.lineTo(q.u, q.v);
    });
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#ff6a55";
    state.scan.forEach((p) => {
      if (p.r >= LIDAR_MAX - 0.15) return;
      const q = mapPt(state.x + Math.cos(p.a) * p.r, state.y + Math.sin(p.a) * p.r, ox, oy, scale);
      ctx.fillRect(q.u - 1.5, q.v - 1.5, 3, 3);
    });
  }

  // stations
  const rp = mapPt(state.x, state.y, ox, oy, scale);
  (WORLD.stations || []).forEach((st) => {
    const q = mapPt(st.x, st.y, ox, oy, scale);
    ctx.fillStyle = st.kind === "load" ? "rgba(125,220,82,0.22)" : st.kind === "unload" ? "rgba(228,80,62,0.22)" : "rgba(213,255,69,0.18)";
    ctx.beginPath(); ctx.arc(q.u, q.v, 20, 0, Math.PI*2); ctx.fill();
    ctx.strokeStyle = st.kind === "load" ? "#7ddc52" : st.kind === "unload" ? "#e4503e" : "#d5ff45";
    ctx.lineWidth = 2;
    ctx.strokeRect(q.u - 16, q.v - 16, 32, 32);
    ctx.fillStyle = "#101b17";
    ctx.fillRect(q.u-12, q.v-10, 24, 20);
    ctx.fillStyle = st.kind === "load" ? "#7ddc52" : st.kind === "unload" ? "#e4503e" : "#d5ff45";
    ctx.font = "bold 13px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(st.id === "D" ? "⌂" : st.id, q.u, q.v + 4);
    ctx.font = "8px Inter, sans-serif";
    ctx.fillStyle = "#dbe7e1";
    ctx.fillText(st.kind === "load" ? "ЗАГРУЗКА" : st.kind === "unload" ? "ВЫГРУЗКА" : "БАЗА", q.u, q.v + 24);
  });

  drawRobotTop(ctx, rp.u, rp.v, state.yaw, 0.48 * scale);

  if (state.charging) {
    const dock = (WORLD.stations || []).find((s) => s.kind === "dock");
    if (dock && Math.hypot(dock.x - state.x, dock.y - state.y) < 1.5) {
      const dq = mapPt(dock.x, dock.y, ox, oy, scale);
      ctx.strokeStyle = "#d5ff45";
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 6]);
      ctx.beginPath(); ctx.moveTo(rp.u, rp.v); ctx.lineTo(dq.u, dq.v); ctx.stroke();
      ctx.setLineDash([]);
      const pulse = 6 + (Math.sin(performance.now() / 140) * 0.5 + 0.5) * 12;
      ctx.strokeStyle = "rgba(213,255,69,0.65)";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(rp.u, rp.v, 26 + pulse, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = "rgba(213,255,69,0.15)";
      ctx.beginPath(); ctx.arc(rp.u, rp.v, 26 + pulse, 0, Math.PI*2); ctx.fill();
    }
  }

  // bubble for waitConfirm
  const bub = state.waitConfirm === "load" ? "подтвердите загрузку" : state.waitConfirm === "unload" ? "подтвердите выгрузку" : state.bubble || "";
  if (bub) {
    ctx.font = "bold 12px Inter, sans-serif";
    ctx.textAlign = "center";
    const tw = Math.max(80, ctx.measureText(bub).width + 20);
    ctx.fillStyle = "rgba(16,27,23,0.92)";
    roundRect(ctx, rp.u - tw / 2, rp.v - 54, tw, 24, 8);
    ctx.fill();
    ctx.strokeStyle = "rgba(213,255,69,0.4)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "#d5ff45";
    ctx.fillText(bub, rp.u, rp.v - 38);
  }

  if (state.navPath && state.navPath.length > 1) {
    ctx.strokeStyle = "#7ec8ff";
    ctx.lineWidth = 3;
    ctx.setLineDash([]);
    ctx.beginPath();
    state.navPath.forEach((p, i) => {
      const q = mapPt(p.x, p.y, ox, oy, scale);
      if (i === 0) ctx.moveTo(q.u, q.v); else ctx.lineTo(q.u, q.v);
    });
    ctx.stroke();
    // glow
    ctx.strokeStyle = "rgba(126,200,255,0.25)";
    ctx.lineWidth = 10;
    ctx.beginPath();
    state.navPath.forEach((p,i)=>{
      const q = mapPt(p.x,p.y,ox,oy,scale);
      if (i===0) ctx.moveTo(q.u,q.v); else ctx.lineTo(q.u,q.v);
    });
    ctx.stroke();
  }

  if (state.waypoints && state.waypoints.length) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(213,255,69,0.9)";
    ctx.setLineDash([8,6]);
    ctx.beginPath();
    const s0 = mapPt(state.x, state.y, ox, oy, scale);
    ctx.moveTo(s0.u, s0.v);
    if (state.navPath && state.navPath.length>1){
      state.navPath.forEach((p)=>{
        const q = mapPt(p.x,p.y,ox,oy,scale);
        ctx.lineTo(q.u,q.v);
      });
    } else {
      state.waypoints.forEach((wp) => {
        const q = mapPt(wp.x, wp.y, ox, oy, scale);
        ctx.lineTo(q.u, q.v);
      });
    }
    ctx.stroke();
    ctx.setLineDash([]);

    state.waypoints.forEach((wp, i) => {
      const q = mapPt(wp.x, wp.y, ox, oy, scale);
      const active = i === state.wpIndex && state.auto;
      const done = i < state.wpIndex;
      ctx.fillStyle = "rgba(16,27,23,0.55)";
      ctx.beginPath(); ctx.arc(q.u,q.v,18,0,Math.PI*2); ctx.fill();
      ctx.fillStyle = done ? "#7ddc52" : active ? "#e4503e" : "#d5ff45";
      ctx.beginPath(); ctx.arc(q.u,q.v,12,0,Math.PI*2); ctx.fill();
      ctx.strokeStyle = "#101b17"; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = "#101b17";
      ctx.font = "bold 12px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(String(i + 1), q.u, q.v + 4);
    });
    ctx.textAlign = "left";
  }

  // trail
  if (state.trail && state.trail.length>1){
    ctx.strokeStyle = "rgba(213,255,69,0.25)";
    ctx.lineWidth = 2;
    ctx.setLineDash([4,4]);
    ctx.beginPath();
    state.trail.forEach((p,i)=>{
      const q = mapPt(p.x,p.y,ox,oy,scale);
      if (i===0) ctx.moveTo(q.u,q.v); else ctx.lineTo(q.u,q.v);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // info panels
  const pct = ((explored / grid.length) * 100).toFixed(1);
  ctx.fillStyle = "rgba(16,27,23,0.9)";
  roundRect(ctx, 12, 12, 220, 62, 10); ctx.fill();
  ctx.strokeStyle = "rgba(213,255,69,0.2)"; ctx.lineWidth=1; ctx.stroke();
  ctx.fillStyle = "#d5ff45";
  ctx.font = "bold 11px Inter, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("СКЛАД НТЦ · SLAM КАРТА", 22, 30);
  ctx.fillStyle = "#dbe7e1";
  ctx.font = "10px JetBrains Mono, monospace";
  ctx.fillText(`исследовано ${pct}% · лидар 360°`, 22, 46);
  ctx.fillStyle = "#8aa198";
  ctx.font = "10px Inter, sans-serif";
  ctx.fillText("ряды стеллажей · проезды · ворота", 22, 60);

  // legend
  ctx.fillStyle = "rgba(16,27,23,0.9)";
  roundRect(ctx, 12, h - 62, 172, 50, 10); ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.08)"; ctx.stroke();
  [["#121a16","неизвестно"],["#2a332e","проезд"],["#6b5a3a","стеллаж"]].forEach((L,i)=>{
    ctx.fillStyle = L[0];
    ctx.strokeStyle = "#44554c";
    ctx.fillRect(22, h - 52 + i * 14, 10, 10);
    ctx.strokeRect(22, h - 52 + i * 14, 10, 10);
    ctx.fillStyle = "#dbe7e1";
    ctx.font = "10px Inter, sans-serif";
    ctx.fillText(L[1], 38, h - 43 + i * 14);
  });
}

function drawRobotTop(ctx, u, v, yaw, s) {
  const kin = state.kin || [
    { id: "FL", x: 0.34, y: 0.22, steer: 0 },
    { id: "FR", x: 0.34, y: -0.22, steer: 0 },
    { id: "RL", x: -0.34, y: 0.22, steer: 0 },
    { id: "RR", x: -0.34, y: -0.22, steer: 0 },
  ];
  ctx.save();
  ctx.translate(u, v);
  ctx.rotate(-yaw);
  const L = s * 1.15, W = s * 0.92, cut = s * 0.22;

  // shadow
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.beginPath();
  ctx.ellipse(0,0,L*1.1,W*1.05,0,0,Math.PI*2);
  ctx.fill();

  // chassis body with chamfer
  ctx.beginPath();
  ctx.moveTo(L - cut, -W);
  ctx.lineTo(L, -W + cut);
  ctx.lineTo(L, W - cut);
  ctx.lineTo(L - cut, W);
  ctx.lineTo(-L + cut, W);
  ctx.lineTo(-L, W - cut);
  ctx.lineTo(-L, -W + cut);
  ctx.lineTo(-L + cut, -W);
  ctx.closePath();
  const g = ctx.createLinearGradient(-L, -W, L, W);
  g.addColorStop(0, "#8e9693");
  g.addColorStop(0.35, "#d0d6d2");
  g.addColorStop(0.7, "#a8b0ad");
  g.addColorStop(1, "#6f7774");
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = "#2e3634";
  ctx.lineWidth = Math.max(1, s * 0.05);
  ctx.stroke();

  // top plate
  ctx.fillStyle = "#1a1f1d";
  roundRect(ctx, -L*0.7, -W*0.65, L*1.4, W*1.3, 4);
  ctx.fill();
  ctx.strokeStyle = "#2a3a32";
  ctx.lineWidth = 1;
  ctx.stroke();

  // lidar puck
  ctx.fillStyle = "#0b120f";
  ctx.beginPath(); ctx.arc(0,0,s*0.18,0,Math.PI*2); ctx.fill();
  ctx.strokeStyle = "#d5ff45"; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.fillStyle = "#d5ff45";
  ctx.beginPath(); ctx.arc(0,0,s*0.06,0,Math.PI*2); ctx.fill();
  // lidar sweep line
  const sweep = (performance.now()/600) % (Math.PI*2);
  ctx.strokeStyle = "rgba(213,255,69,0.35)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(Math.cos(sweep)*s*0.45, Math.sin(sweep)*s*0.45); ctx.stroke();

  // cargo
  if (state.cargo) {
    ctx.fillStyle = "#c4973a";
    roundRect(ctx, -L*0.45, -W*0.35, L*0.9, W*0.7, 3);
    ctx.fill();
    ctx.strokeStyle = "#5c4318"; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.fillStyle = "#101b17";
    ctx.font = `bold ${Math.max(7,s*0.18)}px Inter`;
    ctx.textAlign="center";
    ctx.fillText("ГРУЗ "+(state.payload||0)+"кг", 0, s*0.05);
  }

  // front marker
  ctx.fillStyle = "#d5ff45";
  ctx.beginPath();
  ctx.moveTo(L + s * 0.18, 0);
  ctx.lineTo(L - s * 0.08, s * 0.16);
  ctx.lineTo(L - s * 0.08, -s * 0.16);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#101b17"; ctx.lineWidth = 1; ctx.stroke();

  // wheels
  const layout = [
    { id: "FL", px: L * 0.72, py: -W * 0.82 },
    { id: "FR", px: L * 0.72, py: W * 0.82 },
    { id: "RL", px: -L * 0.72, py: -W * 0.82 },
    { id: "RR", px: -L * 0.72, py: W * 0.82 },
  ];
  for (const pos of layout) {
    const wh = kin.find((k) => k.id === pos.id) || { steer: 0, rpm:0 };
    const steerDeg = wh.steer * 180 / Math.PI;
    ctx.save();
    ctx.translate(pos.px, pos.py);
    // hub housing
    ctx.fillStyle = "#151515";
    ctx.beginPath(); ctx.arc(0, 0, s * 0.22, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#3a3a3a"; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(0, 0, s * 0.16, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "#c5c8c4";
    ctx.beginPath(); ctx.arc(0, 0, s * 0.05, 0, Math.PI * 2); ctx.fill();

    ctx.rotate(-wh.steer);
    // tire
    ctx.fillStyle = "#232323";
    roundRect(ctx, -s * 0.36, -s * 0.16, s * 0.72, s * 0.32, s * 0.09);
    ctx.fill();
    // red rim accent
    ctx.strokeStyle = "#c62828";
    ctx.lineWidth = Math.max(1.2, s * 0.05);
    roundRect(ctx, -s * 0.32, -s * 0.12, s * 0.64, s * 0.24, s * 0.07);
    ctx.stroke();
    // direction arrow
    ctx.fillStyle = "#d5ff45";
    ctx.beginPath();
    ctx.moveTo(s*0.22,0); ctx.lineTo(s*0.08, s*0.07); ctx.lineTo(s*0.08, -s*0.07);
    ctx.fill();
    // rpm ticks
    const rpmA = (performance.now()/200 + (wh.rpm||0)/40) % (Math.PI*2);
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(0,0,s*0.08, rpmA, rpmA+0.8); ctx.stroke();

    ctx.restore();

    // angle label outside wheel
    ctx.save();
    ctx.translate(pos.px, pos.py);
    ctx.fillStyle = "rgba(16,27,23,0.9)";
    const lbl = `${steerDeg.toFixed(0)}°`;
    ctx.font = `bold ${Math.max(7,s*0.16)}px JetBrains Mono, monospace`;
    const tw = ctx.measureText(lbl).width;
    roundRect(ctx, -tw/2-3, (pos.py>0? s*0.32 : -s*0.32-12), tw+6, 12, 4);
    ctx.fill();
    ctx.fillStyle = "#d5ff45";
    ctx.textAlign="center";
    ctx.fillText(lbl, 0, (pos.py>0? s*0.32+8.5 : -s*0.32-3.5));
    ctx.restore();
  }

  ctx.restore();
}

function drawChassisPanel() {
  const c = document.getElementById("chassis");
  if (!c) return;
  const ctx = c.getContext("2d");
  const w = c.width, h = c.height;
  // background with grid
  ctx.fillStyle = "#0b120f";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(213,255,69,0.06)";
  ctx.lineWidth = 1;
  for (let x=0;x<w;x+=20){ ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke(); }
  for (let y=0;y<h;y+=20){ ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }
  ctx.strokeStyle = "#1e2e26";
  ctx.lineWidth = 1.2;
  ctx.strokeRect(10,10,w-20,h-20);
  // inner border
  ctx.strokeStyle = "rgba(213,255,69,0.15)";
  ctx.strokeRect(12,12,w-24,h-24);

  drawRobotTop(ctx, w / 2, h / 2 + 6, Math.PI / 2, 58);

  // header
  ctx.fillStyle = "rgba(16,27,23,0.88)";
  roundRect(ctx, 0,0,w,28,0); ctx.fill();
  ctx.fillStyle = "#d5ff45";
  ctx.font = "bold 11px Inter, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(state.crab ? "КРАБОВЫЙ ХОД · ВСЕ 4 КОЛЕСА" : "4WIS / 4WID · ПОЛНОУПРАВЛЯЕМОЕ", w / 2, 18);

  // footer with battery hint
  ctx.fillStyle = "rgba(16,27,23,0.88)";
  roundRect(ctx, 0, h-24, w, 24, 0); ctx.fill();
  ctx.fillStyle = "#8aa198";
  ctx.font = "9px JetBrains Mono, monospace";
  ctx.textAlign = "center";
  const soc = state.soc ? state.soc.toFixed(0) : "78";
  ctx.fillText(`LiFePO4 12S3P · SOC ${soc}% ${state.charging?'· ЗАРЯДКА ⚡':''} · вид сверху`, w/2, h-9);
}

function drawLidar() {
  const c = document.getElementById("lidar");
  if (!c) return;
  const ctx = c.getContext("2d");
  const w = c.width, h = c.height, cx = w / 2, cy = h / 2;
  ctx.fillStyle = "#0b120f"; ctx.fillRect(0, 0, w, h);
  // grid
  ctx.strokeStyle = "rgba(213,255,69,0.08)";
  ctx.lineWidth = 1;
  for (let r = 24; r < Math.min(w,h)/2; r += 24) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); }
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.beginPath(); ctx.moveTo(0,cy); ctx.lineTo(w,cy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx,0); ctx.lineTo(cx,h); ctx.stroke();

  const k = 14;
  // free space faint
  ctx.fillStyle = "rgba(213,255,69,0.04)";
  ctx.beginPath();
  ctx.moveTo(cx,cy);
  state.scan.forEach((p)=>{
    const rel = p.a - state.yaw;
    ctx.lineTo(cx - Math.sin(rel) * p.r * k, cy - Math.cos(rel) * p.r * k);
  });
  ctx.closePath(); ctx.fill();

  // obstacles
  ctx.fillStyle = "#ff6a55";
  state.scan.forEach((p) => {
    if (p.r >= LIDAR_MAX-0.2) return;
    const rel = p.a - state.yaw;
    const x = cx - Math.sin(rel) * p.r * k;
    const y = cy - Math.cos(rel) * p.r * k;
    ctx.fillRect(x-1.5,y-1.5,3,3);
  });
  // robot
  ctx.fillStyle = "#d5ff45";
  ctx.beginPath(); ctx.arc(cx,cy,4,0,Math.PI*2); ctx.fill();
  ctx.strokeStyle = "#d5ff45";
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(cx,cy); ctx.lineTo(cx,cy-12); ctx.stroke();
  // range text
  ctx.fillStyle = "#8aa198";
  ctx.font = "9px JetBrains Mono, monospace";
  ctx.textAlign="left";
  ctx.fillText("10 м", cx+ 2, 14);
  ctx.fillText(`${LIDAR_BEAMS} лучей`, 8, h-8);
}
