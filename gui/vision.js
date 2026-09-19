/* Скрытый цех даёт только лучи переднего лидара. Карта — то, что уже просканировали. */
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
const mapView = { scale: 20, ox: 0, oy: 0, camX: 0, camY: 0, follow: true };

function drawCrate(ctx, x, y, s, lid) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = "#c4a35a";
  ctx.strokeStyle = "#5c4318";
  ctx.lineWidth = 1.2;
  roundRect(ctx, -s, -s * 0.7, s * 2, s * 1.4, 2);
  ctx.fill(); ctx.stroke();
  ctx.strokeStyle = "#8a6a30";
  ctx.beginPath(); ctx.moveTo(-s, 0); ctx.lineTo(s, 0); ctx.stroke();
  ctx.fillStyle = lid ? "#d5ff45" : "#2a1c08";
  ctx.fillRect(-s * 0.35, -s * 0.35, s * 0.7, s * 0.7);
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCamView(canvasId, yawOff, title) {
  const c = document.getElementById(canvasId);
  if (!c) return;
  const ctx = c.getContext("2d");
  const w = c.width, h = c.height;
  ctx.fillStyle = "#0b120f";
  ctx.fillRect(0, 0, w, h);
  const yaw = state.yaw + yawOff;
  for (let col = 0; col < w; col += 3) {
    const ang = yaw + ((col / w) - 0.5) * 1.15;
    const r = raycast(state.x, state.y, ang, 8);
    const wallH = Math.min(h * 0.9, (180 / Math.max(0.35, r)));
    const y0 = (h - wallH) / 2;
    const shade = Math.max(30, 140 - r * 14);
    ctx.fillStyle = `rgb(${shade * 0.55|0},${shade * 0.5|0},${40})`;
    ctx.fillRect(col, y0, 3, wallH);
  }
  ctx.fillStyle = "rgba(213,255,69,0.12)";
  ctx.fillRect(0, h * 0.52, w, h * 0.48);
  ctx.fillStyle = "#d5ff45";
  ctx.font = "bold 11px Inter, sans-serif";
  ctx.fillText(title, 10, 16);
}

function drawCam() {
  drawCamView("cam", 0, "CAM-F перед");
  drawCamView("cam-rear", Math.PI, "CAM-R зад");
  const hud = document.getElementById("cam-hud");
  if (hud) hud.textContent = "sim 2×";
}

function drawMap() {
  const c = document.getElementById("map");
  const ctx = c.getContext("2d");
  const dw = Math.max(320, c.clientWidth | 0);
  const dh = Math.max(240, c.clientHeight | 0);
  if (c.width !== dw || c.height !== dh) { c.width = dw; c.height = dh; }
  const w = c.width, h = c.height;
  ctx.fillStyle = "#151c19";
  ctx.fillRect(0, 0, w, h);

  if (mapView.follow) {
    mapView.camX = state.x;
    mapView.camY = state.y;
  }
  const scale = mapView.scale;
  const ox = w * 0.5, oy = h * 0.5;
  mapView.ox = ox; mapView.oy = oy;

  /* occupancy: неизвестное = фон, free / occ по сетке */
  const cell = GRID_RES * scale;
  const margin = 8;
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
      ctx.fillStyle = v === OCC ? "#8a6a48" : "#3c433c";
      ctx.fillRect(p.u - cell * 0.55, p.v - cell * 0.55, cell + 0.5, cell + 0.5);
    }
  }

  /* кольцо 360° */
  ctx.strokeStyle = "rgba(213,255,69,0.12)";
  ctx.beginPath();
  ctx.arc(ox, oy, LIDAR_MAX * scale, 0, Math.PI * 2);
  ctx.stroke();

  /* текущий скан */
  ctx.strokeStyle = "rgba(255,90,74,0.35)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  state.scan.forEach((p, i) => {
    const q = mapPt(state.x + Math.cos(p.a) * p.r, state.y + Math.sin(p.a) * p.r, ox, oy, scale);
    if (i === 0) ctx.moveTo(q.u, q.v); else ctx.lineTo(q.u, q.v);
  });
  ctx.closePath();
  ctx.stroke();
  ctx.fillStyle = "#ff6a55";
  state.scan.forEach((p) => {
    if (p.r >= LIDAR_MAX - 0.2) return;
    const q = mapPt(state.x + Math.cos(p.a) * p.r, state.y + Math.sin(p.a) * p.r, ox, oy, scale);
    ctx.fillRect(q.u - 1.4, q.v - 1.4, 2.8, 2.8);
  });

  const rp = mapPt(state.x, state.y, ox, oy, scale);
  (WORLD.stations || []).forEach((st) => {
    const q = mapPt(st.x, st.y, ox, oy, scale);
    ctx.fillStyle = st.kind === "load" ? "rgba(125,220,82,0.35)" : st.kind === "unload" ? "rgba(228,80,62,0.35)" : "rgba(213,255,69,0.28)";
    ctx.fillRect(q.u - 16, q.v - 16, 32, 32);
    ctx.strokeStyle = st.kind === "load" ? "#7ddc52" : st.kind === "unload" ? "#e4503e" : "#d5ff45";
    ctx.lineWidth = 2;
    ctx.strokeRect(q.u - 16, q.v - 16, 32, 32);
    ctx.fillStyle = "#d5ff45";
    ctx.font = "bold 12px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(st.id === "D" ? "⌂" : st.id, q.u, q.v + 4);
    ctx.font = "9px Inter, sans-serif";
    ctx.fillText(st.kind === "load" ? "загрузка" : st.kind === "unload" ? "выгрузка" : "база", q.u, q.v + 22);
  });
  /* корпус ~0.92×0.56 м — в тех же пикселях, что и сетка (scale px/м) */
  drawRobotTop(ctx, rp.u, rp.v, state.yaw, 0.46 * scale);
  if (state.charging) {
    const dock = (WORLD.stations || []).find((s) => s.kind === "dock");
    if (dock && Math.hypot(dock.x - state.x, dock.y - state.y) < 1.2) {
      const dq = mapPt(dock.x, dock.y, ox, oy, scale);
      ctx.strokeStyle = "#d5ff45";
      ctx.lineWidth = 3;
      ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(rp.u, rp.v); ctx.lineTo(dq.u, dq.v); ctx.stroke();
      ctx.setLineDash([]);
      const pulse = 8 + (Math.sin(performance.now() / 120) * 0.5 + 0.5) * 10;
      ctx.strokeStyle = "rgba(213,255,69,0.7)";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(rp.u, rp.v, 28 + pulse, 0, Math.PI * 2); ctx.stroke();
    }
  }
  const bub = state.waitConfirm === "load" ? "подтвердите загрузку" : state.waitConfirm === "unload" ? "подтвердите выгрузку" : "";
  if (bub) {
    ctx.font = "bold 13px Inter, sans-serif";
    ctx.textAlign = "center";
    const tw = Math.max(72, ctx.measureText(bub).width + 18);
    ctx.fillStyle = "rgba(16,27,23,0.92)";
    roundRect(ctx, rp.u - tw / 2, rp.v - 52, tw, 22, 8);
    ctx.fill();
    ctx.fillStyle = "#d5ff45";
    ctx.fillText(bub, rp.u, rp.v - 36);
    ctx.beginPath();
    ctx.moveTo(rp.u - 6, rp.v - 30);
    ctx.lineTo(rp.u + 6, rp.v - 30);
    ctx.lineTo(rp.u, rp.v - 22);
    ctx.fillStyle = "rgba(16,27,23,0.92)";
    ctx.fill();
  }

  if (state.navPath && state.navPath.length > 1) {
    ctx.strokeStyle = "#7ec8ff";
    ctx.lineWidth = 3;
    ctx.beginPath();
    state.navPath.forEach((p, i) => {
      const q = mapPt(p.x, p.y, ox, oy, scale);
      if (i === 0) ctx.moveTo(q.u, q.v); else ctx.lineTo(q.u, q.v);
    });
    ctx.stroke();
  }

  if (state.waypoints && state.waypoints.length) {
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(213,255,69,0.95)";
    ctx.setLineDash([]);
    ctx.beginPath();
    if (state.navPath && state.navPath.length > 1) {
      const s0 = mapPt(state.navPath[0].x, state.navPath[0].y, ox, oy, scale);
      ctx.moveTo(s0.u, s0.v);
      state.navPath.forEach((p) => {
        const q = mapPt(p.x, p.y, ox, oy, scale);
        ctx.lineTo(q.u, q.v);
      });
    } else {
      const s0 = mapPt(state.x, state.y, ox, oy, scale);
      ctx.moveTo(s0.u, s0.v);
      state.waypoints.forEach((wp) => {
        const q = mapPt(wp.x, wp.y, ox, oy, scale);
        ctx.lineTo(q.u, q.v);
      });
    }
    ctx.stroke();
    state.waypoints.forEach((wp, i) => {
      const q = mapPt(wp.x, wp.y, ox, oy, scale);
      const active = i === state.wpIndex && state.auto;
      const done = i < state.wpIndex;
      ctx.beginPath();
      ctx.fillStyle = "rgba(16,27,23,0.55)";
      ctx.arc(q.u, q.v, 16, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.fillStyle = done ? "#7ddc52" : active ? "#e4503e" : "#d5ff45";
      ctx.arc(q.u, q.v, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#101b17";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = "#101b17";
      ctx.font = "bold 13px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(String(i + 1), q.u, q.v + 5);
      ctx.fillStyle = "#d5ff45";
      ctx.font = "bold 11px Inter, sans-serif";
      ctx.fillText("P" + (i + 1), q.u, q.v - 16);
    });
    ctx.textAlign = "left";
  }

  const pct = ((explored / grid.length) * 100).toFixed(1);
  ctx.fillStyle = "rgba(16,27,23,0.88)";
  roundRect(ctx, 10, 10, 210, 58, 8); ctx.fill();
  ctx.fillStyle = "#d5ff45";
  ctx.font = "bold 11px Inter, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("склад НТЦ · SLAM", 20, 28);
  ctx.fillStyle = "#dbe7e1";
  ctx.font = "10px Inter, sans-serif";
  ctx.fillText(`исследовано ${pct}%  ·  лидар 360°`, 20, 44);
  ctx.fillText("ряды стеллажей · проезды", 20, 58);

  ctx.fillStyle = "rgba(16,27,23,0.88)";
  roundRect(ctx, 10, h - 58, 168, 46, 8); ctx.fill();
  [["#151c19", "неизвестно"], ["#3c433c", "проезд"], ["#8a6a48", "стеллаж"]].forEach((L, i) => {
    ctx.fillStyle = L[0];
    ctx.strokeStyle = "#44554c";
    ctx.fillRect(20, h - 48 + i * 13, 8, 8);
    ctx.strokeRect(20, h - 48 + i * 13, 8, 8);
    ctx.fillStyle = "#dbe7e1";
    ctx.font = "10px sans-serif";
    ctx.fillText(L[1], 34, h - 41 + i * 13);
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
  const L = s * 1.05, W = s * 0.82, cut = s * 0.2;
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
  g.addColorStop(0.4, "#cfd6d2");
  g.addColorStop(1, "#6f7774");
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = "#3e4644";
  ctx.lineWidth = Math.max(1, s * 0.045);
  ctx.stroke();

  ctx.fillStyle = "#121816";
  roundRect(ctx, -s * 0.55, -s * 0.42, s * 1.1, s * 0.84, 3);
  ctx.fill();
  ctx.fillStyle = "#223038";
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 5; c++) {
      ctx.beginPath();
      ctx.arc(-s * 0.32 + c * s * 0.16, -s * 0.24 + r * s * 0.14, s * 0.05, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.fillStyle = "#3d8fd4";
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 5; c++) {
      ctx.beginPath();
      ctx.arc(-s * 0.32 + c * s * 0.16, -s * 0.24 + r * s * 0.14, s * 0.018, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (state.cargo) {
    ctx.fillStyle = "#d4a24a";
    roundRect(ctx, -s * 0.38, -s * 0.28, s * 0.76, s * 0.56, 3);
    ctx.fill();
    ctx.strokeStyle = "#5c4318";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = "#d5ff45";
    ctx.font = "bold " + Math.max(8, s * 0.22) + "px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("ГРУЗ", 0, s * 0.08);
  }

  ctx.fillStyle = "#1a1c1b";
  roundRect(ctx, -s * 0.28, -W + s * 0.08, s * 0.56, s * 0.28, 2);
  ctx.fill();
  roundRect(ctx, -s * 0.28, W - s * 0.36, s * 0.56, s * 0.28, 2);
  ctx.fill();

  if (state.lights) {
    ctx.fillStyle = "rgba(255,244,180,0.35)";
    ctx.beginPath();
    ctx.moveTo(L, -s * 0.18);
    ctx.lineTo(L + s * 1.1, -s * 0.55);
    ctx.lineTo(L + s * 1.1, s * 0.55);
    ctx.lineTo(L, s * 0.18);
    ctx.fill();
  }
  ctx.fillStyle = "#d5ff45";
  ctx.beginPath();
  ctx.moveTo(L + s * 0.22, 0);
  ctx.lineTo(L - s * 0.12, s * 0.2);
  ctx.lineTo(L - s * 0.12, -s * 0.2);
  ctx.fill();
  ctx.strokeStyle = "#101b17";
  ctx.lineWidth = 1;
  ctx.stroke();

  const layout = [
    { id: "FL", px: L * 0.72, py: -W * 0.78 },
    { id: "FR", px: L * 0.72, py: W * 0.78 },
    { id: "RL", px: -L * 0.72, py: -W * 0.78 },
    { id: "RR", px: -L * 0.72, py: W * 0.78 },
  ];
  for (const pos of layout) {
    const wh = kin.find((k) => k.id === pos.id) || { steer: 0 };
    ctx.save();
    ctx.translate(pos.px, pos.py);
    ctx.fillStyle = "#1a1a1a";
    ctx.beginPath(); ctx.arc(0, 0, s * 0.2, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#555";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, s * 0.14, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "#c5c8c4";
    ctx.beginPath(); ctx.arc(0, 0, s * 0.045, 0, Math.PI * 2); ctx.fill();
    ctx.rotate(-wh.steer);
    ctx.fillStyle = "#2a2a2a";
    roundRect(ctx, -s * 0.32, -s * 0.14, s * 0.64, s * 0.28, s * 0.08);
    ctx.fill();
    ctx.strokeStyle = "#c62828";
    ctx.lineWidth = Math.max(1.4, s * 0.045);
    roundRect(ctx, -s * 0.28, -s * 0.1, s * 0.56, s * 0.2, s * 0.06);
    ctx.stroke();
    ctx.fillStyle = "#777";
    ctx.beginPath(); ctx.arc(0, 0, s * 0.07, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

function drawChassisPanel() {
  const c = document.getElementById("chassis");
  if (!c) return;
  const ctx = c.getContext("2d");
  const w = c.width, h = c.height;
  ctx.fillStyle = "#101b17";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#2a3a32";
  ctx.strokeRect(8, 8, w - 16, h - 16);
  drawRobotTop(ctx, w / 2, h / 2, Math.PI / 2, 52);
  ctx.fillStyle = "#d5ff45";
  ctx.font = "bold 11px Inter, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(state.crab ? "КРАБ 4WIS" : "4WIS / 4WID", w / 2, 22);
  ctx.fillStyle = "#8aa198";
  ctx.font = "10px Inter, sans-serif";
  ctx.fillText("вид сверху · колёса по кинематике", w / 2, h - 14);
}

function drawLidar() {
  const c = document.getElementById("lidar");
  if (!c || document.getElementById("view-sensors").classList.contains("hidden")) return;
  const ctx = c.getContext("2d");
  const w = c.width, h = c.height, cx = w / 2, cy = h / 2;
  ctx.fillStyle = "#101a16"; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#2c3c35";
  for (let r = 40; r < 220; r += 40) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); }
  const k = 16;
  ctx.fillStyle = "#ff6a55";
  state.scan.forEach((p) => {
    const rel = p.a - state.yaw;
    ctx.fillRect(cx - Math.sin(rel) * p.r * k, cy - Math.cos(rel) * p.r * k, 2, 2);
  });
  ctx.fillStyle = "#d5ff45";
  ctx.beginPath(); ctx.moveTo(cx, cy - 12); ctx.lineTo(cx + 7, cy + 8); ctx.lineTo(cx - 7, cy + 8); ctx.fill();
}
