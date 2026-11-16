import * as THREE from './vendor/three.module.js';

/* =====================================================================
   18:52 — день рождения
   Три отрезка, фиксированная изометрия, 320x180, без ассетов.
   ===================================================================== */

const VIEW_W = 320;
const VIEW_H = 180;

const LANE = 3.2;              // ширина полосы
const LANES = [-LANE, 0, LANE]; // центры полос: авто-возврат руля
const ROAD_HALF = 5.2;
const SPEED_MAX = 46;          // единиц/сек
const CLOCK_RATE = 0.94;       // игровых секунд на реальную (480 игровых ≈ 8.5 реальных минут)
const CLOCK_MAX = 480;         // 18:52 → 19:00
const HIT_CLOCK = 30;          // штраф за столкновение
const ROUTE = 18500;           // ~6.7 минут при полном ходу
const MOOD_WIN = 50;           // меньше — финал-провал, даже если доехал
const STEER_ACC = 20;          // боковое ускорение руля, ед/с²
const POLICE_TRAIL = 5.6;      // патрульная машина держится позади игрока
const POLICE_FOLLOW = 18;      // насколько жёстко она держит дистанцию
const SHOULDER_EDGE = 4.35;    // |lat| больше — машина на обочине
const SHOULDER_MAX_SPEED = 30; // потолок скорости на обочине, ед/с

const SEGMENTS = [
  { name: 'ДВОР', start: 0, end: 5850 },
  { name: 'ШОССЕ', start: 5850, end: 12050 },
  { name: 'ГОРОД', start: 12050, end: 18500 },
];

/* сюжетные точки (в единицах маршрута) */
const COW_P = 1000;
const MOWER_P = 2050;
const BRIDE_P = 3300;          // первая треть первого отрезка, ~18% маршрута
const HIGHWAY_PIGEON_P = SEGMENTS[1].start + 2800;
const CITY_FUNERAL_P = SEGMENTS[2].start + 2010;
const CITY_INSPECTOR_P = SEGMENTS[2].start + 3600;

const PAL = {
  burgundy: 0x5b1f27,
  burgundyDeep: 0x3d151c,
  cream: 0xe6e2d8,
  char: 0x26262a,
  lamp: 0xffd9a0,
  asphalt: 0x3b3a3e,
  curb: 0xefe9dd,
  concrete: 0x9b968c,
  concreteDark: 0x6f6b64,
  birch: 0xf0eee7,
  leaf: 0x4d6b3c,
  grass: 0x3a4030,
  metal: 0x8a8f96,
};

/* ---------- мелкие утилиты ---------- */
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

/* ---------- модель трассы: центр дороги — кривая ----------
   curv[] — кривизна на шаг 5 единиц; поворот собран из двух половин
   (+k, затем −k), поэтому касательная возвращается к прямой, а дорога
   остаётся сдвинутой. Знак следующего поворота выбирается так, чтобы
   боковой унос центра не уходил далеко. */
const CURVE_STEP = 5;
const CURVE_N = Math.ceil((ROUTE + 1400) / CURVE_STEP);
const CURVE_OFF = new Float32Array(CURVE_N);
const CURVE_HEAD = new Float32Array(CURVE_N);
const CURVE_K = new Float32Array(CURVE_N);
const BENDS = [];

const BENDS_PER_SEGMENT = 6;

function buildCurveModel() {
  const bends = [];
  let off = 0;
  for (const seg of SEGMENTS) {
    const span = seg.end - seg.start;
    for (let k = 0; k < BENDS_PER_SEGMENT; k++) {
      const p = seg.start + span * ((k + 0.5) / BENDS_PER_SEGMENT + rnd(-0.02, 0.02));
      const half = rnd(70, 110);
      const steep = rnd(0.0009, 0.00125);
      let dir = Math.random() < 0.5 ? -1 : 1;
      if (off > 12) dir = -1;
      if (off < -12) dir = 1;
      bends.push({ start: p, mid: p + half, end: p + half * 2, dir, steep, half });
      off += dir * steep * half * half;
      off = clamp(off, -30, 30);
    }
  }
  for (const b of bends) {
    const a = Math.max(1, Math.ceil(b.start / CURVE_STEP));
    const m = Math.min(CURVE_N - 1, Math.floor(b.mid / CURVE_STEP));
    const e = Math.min(CURVE_N - 1, Math.floor(b.end / CURVE_STEP));
    for (let i = a; i <= m; i++) CURVE_K[i] = b.steep * b.dir;
    for (let i = m + 1; i <= e; i++) CURVE_K[i] = -b.steep * b.dir;
  }
  let h = 0;
  let o = 0;
  for (let i = 0; i < CURVE_N; i++) {
    CURVE_OFF[i] = o;
    CURVE_HEAD[i] = h;
    const hm = h + CURVE_K[i] * CURVE_STEP * 0.5;
    o += hm * CURVE_STEP;
    h += CURVE_K[i] * CURVE_STEP;
  }
  BENDS.length = 0;
  for (const b of bends) BENDS.push(b);
}

function curveAt(arr, p) {
  const f = clamp(p / CURVE_STEP, 0, CURVE_N - 1.001);
  const i = f | 0;
  return arr[i] + (arr[i + 1] - arr[i]) * (f - i);
}
const roadOff = (p) => curveAt(CURVE_OFF, p);
const roadHead = (p) => curveAt(CURVE_HEAD, p);
const roadCurv = (p) => curveAt(CURVE_K, p);
const worldX = (p, lat) => roadOff(p) + lat;
buildCurveModel();

/* ближайший поворот впереди (для щита и подсветки HUD) */
function bendNear(p, ahead) {
  for (const b of BENDS) {
    if (p > b.start - ahead && p < b.end + 30) return b;
  }
  return null;
}

/* ---------- рендерер ---------- */
const viewEl = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({
  antialias: false,
  alpha: false,
  powerPreference: 'high-performance',
  stencil: false,
});
renderer.setPixelRatio(1);
renderer.setSize(VIEW_W, VIEW_H, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x2a1318, 1);
viewEl.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x4a2029, 96, 190);

const BASE_VIEW_SPAN = 27.5;  // высота кадра на большом экране
const CLOSE_VIEW_SPAN = 20;   // на телефоне/узком экране: машина крупнее
let VIEW_SPAN = BASE_VIEW_SPAN;
let CAM_LOOKAHEAD = 21;       // камера смотрит вперёд по дороге

const camera = new THREE.OrthographicCamera(
  (-VIEW_SPAN / 2) * (VIEW_W / VIEW_H),
  (VIEW_SPAN / 2) * (VIEW_W / VIEW_H),
  VIEW_SPAN / 2,
  -VIEW_SPAN / 2,
  1,
  400
);

const IS_COARSE = () =>
  matchMedia('(pointer: coarse)').matches ||
  (navigator.maxTouchPoints || 0) > 0;

/* Кадр подстраивается под экран: на телефоне/в портрете камера ближе,
   но горизонт по-прежнему вмещает дорогу с обочинами целиком. */
function applyCameraFraming() {
  const vw = Math.max(1, window.innerWidth);
  const vh = Math.max(1, window.innerHeight);
  const aspect = vw / vh;
  const close = IS_COARSE() || aspect < 1.2;
  VIEW_SPAN = close ? CLOSE_VIEW_SPAN : BASE_VIEW_SPAN;
  CAM_LOOKAHEAD = close ? 17.5 : 19;
  const spanW = VIEW_SPAN * (VIEW_W / VIEW_H);
  camera.left = -spanW / 2;
  camera.right = spanW / 2;
  camera.top = VIEW_SPAN / 2;
  camera.bottom = -VIEW_SPAN / 2;
  camera.updateProjectionMatrix();
  document.body.classList.toggle('touch', IS_COARSE());
}
applyCameraFraming();
window.addEventListener('resize', applyCameraFraming);
window.addEventListener('orientationchange', applyCameraFraming);

/* фиксированная изометрия: небольшой yaw, чтобы видеть боковые фасады,
   но дорога при этом уходит вверх экрана */
const CAM_YAW = THREE.MathUtils.degToRad(9);
const CAM_PITCH = THREE.MathUtils.degToRad(18);
const CAM_RADIUS = 64;
const CAM_OFFSET = new THREE.Vector3(
  Math.sin(CAM_YAW) * Math.cos(CAM_PITCH) * CAM_RADIUS,
  Math.sin(CAM_PITCH) * CAM_RADIUS,
  Math.cos(CAM_YAW) * Math.cos(CAM_PITCH) * CAM_RADIUS
);
const camLook = new THREE.Vector3(0, 1, -6);
let camYawNow = CAM_YAW;
/* камера подстраивает yaw под касательную трассы с запаздыванием */
function camOffsetFor(yaw) {
  const cp = Math.cos(CAM_PITCH) * CAM_RADIUS;
  return CAM_OFFSET.set(Math.sin(yaw) * cp, Math.sin(CAM_PITCH) * CAM_RADIUS, Math.cos(yaw) * cp);
}

/* ---------- свет (плоский, без теней) ---------- */
scene.add(new THREE.AmbientLight(0xc0b6b6, 1.35));
const hemi = new THREE.HemisphereLight(0xffd9a0, 0x3a2c30, 0.7);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffe6c4, 0.95);
sun.position.set(14, 30, 18);
scene.add(sun);
const fill = new THREE.DirectionalLight(0xa9b7d9, 0.28);
fill.position.set(-20, 12, -14);
scene.add(fill);

/* ---------- материалы ---------- */
const matCache = new Map();
function mat(color) {
  let m = matCache.get(color);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color });
    matCache.set(color, m);
  }
  return m;
}
const basicCache = new Map();
function basic(color, opacity) {
  const key = color + ':' + (opacity === undefined ? 1 : opacity);
  let m = basicCache.get(key);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color });
    if (opacity !== undefined && opacity < 1) {
      m.transparent = true;
      m.opacity = opacity;
    }
    basicCache.set(key, m);
  }
  return m;
}

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
/* общий кэш геометрий: динамические объекты пересобираются на каждом отрезке
   и ретрае, поэтому геометрия не должна создаваться заново */
const geoCache = new Map();
function torusGeo2(r, t) {
  const k = `T${r}|${t}`;
  let g = geoCache.get(k);
  if (!g) { g = new THREE.TorusGeometry(r, t, 4, 10); geoCache.set(k, g); }
  return g;
}
const wheelCache = new Map();
function flatWheel(r, w, seg) {
  const k = `w${r}|${w}|${seg}`;
  let g = wheelCache.get(k);
  if (!g) {
    g = new THREE.CylinderGeometry(r, r, w, seg);
    g.rotateZ(Math.PI / 2);
    wheelCache.set(k, g);
  }
  return g;
}
let _cap = null;
function capGeo() {
  if (!_cap) _cap = new THREE.SphereGeometry(0.185, 8, 4, 0, Math.PI * 2, 0, Math.PI * 0.6);
  return _cap;
}
let _cone = null;
function coneGeo() {
  if (!_cone) _cone = new THREE.ConeGeometry(0.22, 0.6, 6);
  return _cone;
}
function torusGeo(r, t) {
  const k = `t${r}|${t}`;
  let g = geoCache.get(k);
  if (!g) { g = new THREE.TorusGeometry(r, t, 4, 8); geoCache.set(k, g); }
  return g;
}
function cylGeo(rTop, rBot, h, seg) {
  const k = `${rTop}|${rBot}|${h}|${seg}`;
  let g = geoCache.get(k);
  if (!g) { g = new THREE.CylinderGeometry(rTop, rBot, h, seg); geoCache.set(k, g); }
  return g;
}
function sphGeo(r, seg) {
  const k = `s${r}|${seg}`;
  let g = geoCache.get(k);
  if (!g) { g = new THREE.SphereGeometry(r, seg, seg > 6 ? 6 : 4); geoCache.set(k, g); }
  return g;
}
function box(parent, w, h, d, color, x, y, z, opts) {
  const m = new THREE.Mesh(UNIT_BOX, opts && opts.basic ? basic(color) : mat(color));
  m.scale.set(w, h, d);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}
function cyl(parent, rTop, rBot, h, seg, color, x, y, z) {
  const m = new THREE.Mesh(cylGeo(rTop, rBot, h, seg), mat(color));
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}
function sph(parent, r, color, x, y, z, seg = 8) {
  const m = new THREE.Mesh(sphGeo(r, seg), mat(color));
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

/* ---------- процедурные текстуры (без файлов-картинок) ---------- */
function texFromCanvas(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = 1;
  return t;
}

function cloneChecker(len) {
  const t = checkerTex.clone();
  t.needsUpdate = true;
  t.repeat.set(1.55, len / 2.6);
  return t;
}

const checkerTex = texFromCanvas(32, 32, (g) => {
  g.fillStyle = '#e6e2d8';
  g.fillRect(0, 0, 32, 32);
  g.fillStyle = '#2f2f35';
  g.fillRect(0, 0, 16, 16);
  g.fillRect(16, 16, 16, 16);
});

const roadTex = texFromCanvas(128, 128, (g) => {
  g.fillStyle = '#3b3a3e';
  g.fillRect(0, 0, 128, 128);
  // фактура асфальта
  for (let i = 0; i < 220; i++) {
    const v = 52 + ((Math.random() * 22) | 0);
    g.fillStyle = `rgb(${v},${v},${v + 2})`;
    g.fillRect((Math.random() * 128) | 0, (Math.random() * 128) | 0, 2, 2);
  }
  // две прерывистые линии: полосы по 3.4 при ширине 10.4
  g.fillStyle = '#e6e2d8';
  g.fillRect(42, 0, 3, 47);
  g.fillRect(84, 0, 3, 47);
});

const facadeTex = texFromCanvas(64, 96, (g) => {
  g.fillStyle = '#a2988a';
  g.fillRect(0, 0, 64, 96);
  // панельные швы
  g.fillStyle = '#8b8172';
  for (let y = 0; y < 96; y += 16) g.fillRect(0, y, 64, 1);
  for (let x = 0; x < 64; x += 32) g.fillRect(x, 0, 1, 96);
  // окна 4x6
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 4; x++) {
      const lit = Math.random() < 0.26;
      const px = 5 + x * 15;
      const py = 6 + y * 15;
      g.fillStyle = '#34343a';
      g.fillRect(px - 1, py - 1, 11, 12);
      g.fillStyle = lit ? '#ffd9a0' : '#4a5560';
      g.fillRect(px, py, 9, 10);
      g.fillStyle = 'rgba(0,0,0,0.4)';
      g.fillRect(px + 4, py, 1, 10);
      if (!lit) {
        g.fillStyle = 'rgba(255,255,255,0.06)';
        g.fillRect(px, py, 9, 3);
      }
    }
  }
});

const fenceTex = texFromCanvas(64, 32, (g) => {
  g.fillStyle = '#9b968c';
  g.fillRect(0, 0, 64, 32);
  for (let i = 0; i < 120; i++) {
    g.fillStyle = Math.random() > 0.5 ? '#948f85' : '#a29d93';
    g.fillRect((Math.random() * 64) | 0, (Math.random() * 32) | 0, 2, 2);
  }
  g.fillStyle = '#6a665f';
  g.fillRect(0, 0, 2, 32);       // вертикальный шов
  g.fillRect(32, 0, 2, 32);
  g.fillStyle = '#7b776f';
  g.fillRect(0, 0, 64, 2);
});

const birchTex = texFromCanvas(16, 64, (g) => {
  g.fillStyle = '#f0eee7';
  g.fillRect(0, 0, 16, 64);
  g.fillStyle = '#26262a';
  for (let i = 0; i < 16; i++) {
    const y = (Math.random() * 64) | 0;
    const w = 2 + ((Math.random() * 4) | 0);
    g.fillRect((Math.random() * (16 - w)) | 0, y, w, 2);
  }
});

function signTex(text, bg = '#5b1f27', fg = '#e6e2d8') {
  return texFromCanvas(128, 64, (g, w, h) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = fg;
    g.lineWidth = 3;
    g.strokeRect(4, 4, w - 8, h - 8);
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    let size = 26;
    g.font = `bold ${size}px monospace`;
    while (g.measureText(text).width > w - 16 && size > 7) {
      size -= 1;
      g.font = `bold ${size}px monospace`;
    }
    g.fillText(text, w / 2, h / 2 + 1);
  });
}

const noticeTex = texFromCanvas(64, 48, (g, w, h) => {
  g.fillStyle = '#e9e4d6';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#5b1f27';
  g.fillRect(0, 0, w, 9);
  g.fillStyle = '#e9e4d6';
  g.font = 'bold 7px monospace';
  g.textAlign = 'center';
  g.fillText('ОБЪЯВЛЕНИЕ', w / 2, 7);
  g.fillStyle = '#4a4640';
  for (let i = 0; i < 6; i++) {
    const ww = 18 + ((Math.random() * 34) | 0);
    g.fillRect(5, 13 + i * 5, ww, 2);
  }
});

function garageTex(num) {
  return texFromCanvas(64, 64, (g, w, h) => {
    g.fillStyle = '#7d7d78';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#6a6a66';
    for (let y = 0; y < h; y += 5) g.fillRect(0, y, w, 2);
    g.fillStyle = '#3b3a3e';
    g.fillRect(4, 44, w - 8, 14);
    g.fillStyle = '#e6e2d8';
    g.font = 'bold 13px monospace';
    g.textAlign = 'center';
    g.fillText(num, w / 2, 55);
  });
}

/* ---------- небо ---------- */
function makeSky() {
  const t = texFromCanvas(8, 96, (g, w, h) => {
    const grd = g.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, '#1b0d12');
    grd.addColorStop(0.5, '#33171f');
    grd.addColorStop(1, '#5b1f27');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
  });
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}
scene.background = makeSky();

/* =====================================================================
   СТРОИТЕЛИ
   ===================================================================== */

/* ---- машина игрока ---- */
function makeCar(bodyColor, roofColor, opts = {}) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  box(body, 1.92, 0.5, 3.9, bodyColor, 0, 0.62, 0);
  box(body, 1.86, 0.22, 3.4, bodyColor, 0, 0.38, 0.1);
  // кабина
  box(body, 1.66, 0.56, 1.86, roofColor, 0, 1.12, 0.28);
  // стёкла
  box(body, 1.52, 0.4, 0.06, 0x20242c, 0, 1.12, -0.66);
  box(body, 1.52, 0.34, 0.06, 0x20242c, 0, 1.1, 1.22);
  box(body, 0.06, 0.34, 1.6, 0x20242c, -0.85, 1.12, 0.3);
  box(body, 0.06, 0.34, 1.6, 0x20242c, 0.85, 1.12, 0.3);
  // крыша
  box(body, 1.6, 0.08, 1.7, roofColor, 0, 1.42, 0.3);
  // бамперы
  box(body, 1.9, 0.16, 0.18, PAL.cream, 0, 0.5, -1.98);
  box(body, 1.9, 0.16, 0.18, PAL.cream, 0, 0.5, 1.98);
  // фары
  const head = [box(body, 0.34, 0.16, 0.08, 0xfff3d0, -0.62, 0.68, -1.97, { basic: true }),
    box(body, 0.34, 0.16, 0.08, 0xfff3d0, 0.62, 0.68, -1.97, { basic: true })];
  // задние фонари
  const tails = [box(body, 0.3, 0.16, 0.08, 0xd83a3a, -0.66, 0.7, 1.97, { basic: true }),
    box(body, 0.3, 0.16, 0.08, 0xd83a3a, 0.66, 0.7, 1.97, { basic: true })];
  // номер
  box(body, 0.5, 0.16, 0.04, 0xe6e2d8, 0, 0.5, 1.99);

  const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.22, 10);
  wheelGeo.rotateZ(Math.PI / 2);
  const wheels = [];
  for (const wx of [-0.94, 0.94]) {
    for (const wz of [-1.24, 1.3]) {
      const w = new THREE.Mesh(wheelGeo, mat(0x1b1b1e));
      w.position.set(wx, 0.34, wz);
      body.add(w);
      wheels.push(w);
      // ступица — видно вращение
      const hub = box(body, 0.24, 0.12, 0.12, 0x9a9a94, wx, 0.34, wz);
      wheels[wheels.length - 1].userData.hub = hub;
    }
  }
  root.userData = { body, wheels, head, tails, roofColor };
  return root;
}

/* ---- полиция ---- */
function makePoliceCar() {
  const root = makeCar(0xdcdad2, 0xe8e6de);
  const body = root.userData.body;
  // синяя полоса
  box(body, 1.94, 0.16, 3.2, 0x2f4f8a, 0, 0.72, 0);
  // надпись на борту (полоска «ДПС»)
  box(body, 0.9, 0.1, 0.04, 0xe6e2d8, 0, 0.86, -1.96);
  // мигалки
  const mkMat = (c) => new THREE.MeshBasicMaterial({ color: c });
  const redM = mkMat(0xd93a3a);
  const blueM = mkMat(0x3a6ad9);
  const red = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 0.26), redM);
  red.position.set(-0.36, 1.55, 0.1);
  const blue = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 0.26), blueM);
  blue.position.set(0.36, 1.55, 0.1);
  body.add(red, blue);
  root.userData.beacons = { redM, blueM, red, blue };
  return root;
}

/* ---- человек ---- */
function makePerson(opt = {}) {
  const g = new THREE.Group();
  const shirt = opt.shirt ?? 0x3e4a5a;
  const pants = opt.pants ?? 0x2a2a30;
  const skin = opt.skin ?? 0xd9b49a;
  const hair = opt.hair ?? 0x3a2a22;
  const scale = opt.scale ?? 1;

  box(g, 0.18, 0.74, 0.22, pants, -0.14, 0.37, 0);
  box(g, 0.18, 0.74, 0.22, pants, 0.14, 0.37, 0);
  box(g, 0.52, 0.66, 0.3, shirt, 0, 1.06, 0);
  sph(g, 0.18, skin, 0, 1.55, 0);
  const cap = new THREE.Mesh(capGeo(), mat(hair));
  cap.position.set(0, 1.56, 0);
  g.add(cap);

  const mkArm = (side) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.32, 1.34, 0);
    box(pivot, 0.15, 0.64, 0.18, shirt, 0, -0.32, 0);
    box(pivot, 0.14, 0.14, 0.16, skin, 0, -0.68, 0);
    g.add(pivot);
    return pivot;
  };
  g.userData.armL = mkArm(-1);
  g.userData.armR = mkArm(1);

  if (opt.dress) {
    const skirt = new THREE.Mesh(cylGeo(0.2, 0.62, 1.2, 8), mat(opt.dressColor ?? 0xece9e2));
    skirt.position.y = 0.62;
    g.add(skirt);
    g.userData.armL.children.forEach(() => {});
  }
  if (opt.hat) {
    box(g, 0.5, 0.06, 0.5, opt.hat, 0, 1.72, 0);
    box(g, 0.3, 0.16, 0.3, opt.hat, 0, 1.62, 0);
  }
  g.scale.setScalar(scale);
  return g;
}

function makeBride() {
  const g = makePerson({ shirt: 0xf2efe8, pants: 0xf2efe8, dress: true, dressColor: 0xf2efe8, hair: 0xd8c9a8 });
  // фата
  box(g, 0.44, 0.5, 0.06, 0xf6f4ee, 0, 1.42, 0.2);
  // букет
  sph(g, 0.12, 0xd05a6a, 0.26, 1.0, -0.24, 6);
  sph(g, 0.09, 0xf0ece0, 0.32, 1.12, -0.26, 6);
  return g;
}

function makePigeon() {
  const g = new THREE.Group();
  box(g, 0.24, 0.18, 0.34, 0x8f96a3, 0, 0, 0);
  sph(g, 0.11, 0x717886, 0, 0.1, -0.18);
  box(g, 0.06, 0.05, 0.1, 0xd9a441, 0, 0.08, -0.28);
  const wingL = box(g, 0.06, 0.12, 0.28, 0x7a8290, -0.14, 0.04, 0.02);
  const wingR = box(g, 0.06, 0.12, 0.28, 0x7a8290, 0.14, 0.04, 0.02);
  box(g, 0.16, 0.05, 0.18, 0x6d7480, 0, 0.02, 0.2);
  g.userData.wings = [wingL, wingR];
  return g;
}

function makeCow() {
  const g = new THREE.Group();
  box(g, 1.3, 0.95, 2.1, 0xf1ede4, 0, 1.15, 0);
  // пятна
  box(g, 1.32, 0.36, 0.44, 0x2c2a2a, 0, 1.3, -0.4);
  box(g, 1.32, 0.3, 0.5, 0x2c2a2a, 0, 1.02, 0.45);
  box(g, 0.06, 0.4, 0.4, 0x2c2a2a, 0.66, 1.1, 0.15);
  // голова
  box(g, 0.62, 0.56, 0.72, 0xf1ede4, 0, 1.3, -1.28);
  box(g, 0.46, 0.28, 0.3, 0xe2b7ae, 0, 1.14, -1.66);
  sph(g, 0.06, 0x1b1b1e, -0.2, 1.45, -1.62, 5);
  sph(g, 0.06, 0x1b1b1e, 0.2, 1.45, -1.62, 5);
  box(g, 0.2, 0.1, 0.1, 0xd8cfc0, -0.26, 1.6, -1.15);
  box(g, 0.2, 0.1, 0.1, 0xd8cfc0, 0.26, 1.6, -1.15);
  // ноги
  for (const sx of [-0.44, 0.44]) {
    for (const sz of [-0.7, 0.72]) {
      box(g, 0.2, 0.72, 0.2, 0xe8e3d8, sx, 0.36, sz);
      box(g, 0.22, 0.14, 0.22, 0x2c2a2a, sx, 0.07, sz);
    }
  }
  // хвост
  box(g, 0.08, 0.6, 0.08, 0x2c2a2a, 0, 1.1, 1.1).rotation.x = 0.3;
  g.position.y = 0;
  return g;
}

function makeTractor() {
  const g = new THREE.Group();
  box(g, 1.7, 0.8, 3.2, 0x2f5d8a, 0, 1.05, 0);
  box(g, 1.5, 1.1, 1.5, 0x2f5d8a, 0, 1.9, 0.5);
  box(g, 1.2, 0.6, 0.1, 0x20242c, 0, 2.15, -0.26);
  box(g, 1.8, 0.2, 2.6, 0x8a8f96, 0, 2.55, 0.5);
  // столб
  cyl(g, 0.08, 0.08, 1.1, 6, 0x3c3c40, 0.55, 2.4, -0.9);
  // капот
  box(g, 1.4, 0.6, 1.2, 0x2f5d8a, 0, 1.5, -1.7);
  box(g, 0.9, 0.25, 0.1, 0xfff3d0, 0, 1.6, -2.25, { basic: true });
  // колёса: задние большие, передние маленькие
  const bigGeo = flatWheel(0.85, 0.4, 10);
  const smallGeo = flatWheel(0.45, 0.3, 10);
  for (const sx of [-0.95, 0.95]) {
    const b = new THREE.Mesh(bigGeo, mat(0x1e1e21));
    b.position.set(sx, 0.85, 0.9);
    g.add(b);
    const s = new THREE.Mesh(smallGeo, mat(0x1e1e21));
    s.position.set(sx, 0.45, -1.75);
    g.add(s);
  }
  return g;
}

function makeLawnmower() {
  const g = new THREE.Group();
  box(g, 0.9, 0.3, 1.1, 0x4d6b3c, 0, 0.35, 0);
  box(g, 0.7, 0.2, 0.5, 0x8a8f96, 0, 0.6, -0.2);
  box(g, 0.7, 0.06, 0.06, 0x2c2c30, 0, 0.9, 0.5);
  for (const sx of [-0.52, 0.52]) {
    const w = new THREE.Mesh(flatWheel(0.24, 0.16, 8), mat(0x1e1e21));
    w.rotation.z = Math.PI / 2;
    w.position.set(sx, 0.24, 0.2);
    g.add(w);
  }
  const neighbour = makePerson({ shirt: 0x8a6a3a, pants: 0x3a4452, hat: 0xd8cfc0, scale: 1.05 });
  neighbour.position.set(0, 0, 1.3);
  g.add(neighbour);
  g.userData.armR = neighbour.userData.armR;
  g.userData.person = neighbour;
  return g;
}

const signMatCache = new Map();
function signMaterial(text, bg) {
  const key = text + '|' + bg;
  let m = signMatCache.get(key);
  if (!m) {
    const t = signTex(text, bg);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    m = new THREE.MeshLambertMaterial({ map: t, side: THREE.DoubleSide });
    signMatCache.set(key, m);
  }
  return m;
}
const PLANE1 = new THREE.PlaneGeometry(1, 1);
function makeSign(text, w = 2.6, h = 1.3, bg) {
  const g = new THREE.Group();
  const panel = new THREE.Mesh(PLANE1, signMaterial(text, bg));
  panel.scale.set(w, h, 1);
  panel.position.set(0, 0, 0.06);
  const back = box(g, w, h, 0.12, 0x3a2a2c, 0, 0, 0);
  g.add(panel);
  return g;
}

function makePoleSign(text) {
  const g = new THREE.Group();
  cyl(g, 0.07, 0.07, 3.4, 6, 0x5b5b5f, 0, 1.7, 0);
  const sign = makeSign(text, 2.2, 1.05);
  sign.position.set(0, 3.3, 0);
  g.add(sign);
  return g;
}

function makeStreetLamp() {
  const g = new THREE.Group();
  cyl(g, 0.09, 0.11, 4.2, 6, 0x4a4a4f, 0, 2.1, 0);
  box(g, 1.5, 0.1, 0.1, 0x4a4a4f, 0.7, 4.2, 0);
  const lamp = box(g, 0.5, 0.16, 0.3, PAL.lamp, 1.4, 4.1, 0, { basic: true });
  lamp.scale.set(0.5, 0.16, 0.3);
  return g;
}

function makeGarage(num, w = 4.6) {
  const g = new THREE.Group();
  const t = garageTex(num);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  const door = new THREE.Mesh(
    new THREE.PlaneGeometry(w * 0.8, 2.4),
    new THREE.MeshLambertMaterial({ map: t })
  );
  door.position.set(0, 1.2, w * 0.05);
  g.add(door);
  box(g, w, 2.8, 4.2, 0x8b8578, 0, 1.4, 0);
  // крыша
  box(g, w + 0.3, 0.18, 4.4, 0x5a5550, 0, 2.85, 0);
  // пристройка
  box(g, 0.2, 2.76, 4.2, 0x7b766a, -w / 2 + 0.05, 1.4, 0);
  return g;
}

function makeBirch() {
  const g = new THREE.Group();
  const t = birchTex;
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.15, 0.22, 5.4, 7),
    new THREE.MeshLambertMaterial({ map: t, color: 0xffffff })
  );
  trunk.position.y = 2.7;
  g.add(trunk);
  const s1 = new THREE.Mesh(new THREE.SphereGeometry(1.5, 7, 5), mat(PAL.leaf));
  s1.position.set(0.2, 5.4, 0);
  s1.scale.set(1, 0.8, 1);
  const s2 = new THREE.Mesh(new THREE.SphereGeometry(1.1, 7, 5), mat(0x547a41));
  s2.position.set(-0.9, 4.8, 0.4);
  g.add(s1, s2);
  return g;
}

function makeDandelion() {
  const g = new THREE.Group();
  cyl(g, 0.025, 0.03, 0.42, 4, 0x5b7a3a, 0, 0.21, 0);
  sph(g, 0.11, 0xf2d24a, 0, 0.46, 0, 5);
  return g;
}

function makeFenceSection(side = 1) {
  const g = new THREE.Group();
  const mk = (w, d, x, z, rotY) => {
    const t = fenceTex.clone();
    t.needsUpdate = true;
    t.repeat.set(Math.max(1, Math.round(w / 3.6)), 1);
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(w, 2.3, d),
      new THREE.MeshLambertMaterial({ map: t })
    );
    m.position.set(x, 1.15, z);
    if (rotY) m.rotation.y = rotY;
    g.add(m);
    // бетонный оголовок — чтобы забор читался сверху
    const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.1, 0.16, d + 0.16), mat(0xb0a99c));
    cap.position.set(x, 2.33, z);
    cap.rotation.y = rotY || 0;
    g.add(cap);
  };
  mk(11, 0.22, 0, 0, 0);          // пролёт вдоль дороги
  mk(0.22, 5.2, 0, side * 2.6, 0); // возврат в сторону — поперёк, от дороги
  return g;
}

const buildingGeoCache = new Map();
const facadeMatCache = new Map();
function facadeMaterial(w, h) {
  const rx = Math.max(1, Math.round(w / 5.2));
  const ry = Math.max(1, Math.round(h / 7.6));
  const key = rx + '|' + ry;
  let m = facadeMatCache.get(key);
  if (!m) {
    const t = facadeTex.clone();
    t.needsUpdate = true;
    t.repeat.set(rx, ry);
    m = new THREE.MeshLambertMaterial({ map: t });
    facadeMatCache.set(key, m);
  }
  return m;
}
function makeBuilding(w, h, d) {
  const gk = `${w.toFixed(2)}|${h.toFixed(2)}|${d.toFixed(2)}`;
  let bg = buildingGeoCache.get(gk);
  if (!bg) { bg = new THREE.BoxGeometry(w, h, d); buildingGeoCache.set(gk, bg); }
  const m = new THREE.Mesh(bg, facadeMaterial(w, h));
  m.position.y = h / 2;
  const g = new THREE.Group();
  g.add(m);
  // технический этаж
  box(g, w * 0.4, 1.2, d * 0.5, 0x6f6a62, 0, h + 0.6, 0);
  return g;
}

function makeCake() {
  const g = new THREE.Group();
  cyl(g, 0.42, 0.45, 0.34, 10, 0xf4e6c8, 0, 0.17, 0);
  cyl(g, 0.3, 0.32, 0.24, 10, 0xd8707c, 0, 0.44, 0);
  cyl(g, 0.31, 0.31, 0.04, 10, 0xfbf5e6, 0, 0.56, 0);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    box(g, 0.05, 0.26, 0.05, 0xe8dcc0, Math.cos(a) * 0.16, 0.7, Math.sin(a) * 0.16);
    const f = box(g, 0.07, 0.09, 0.07, 0xffb347, Math.cos(a) * 0.16, 0.86, Math.sin(a) * 0.16, { basic: true });
    f.userData.flame = true;
  }
  return g;
}

/* =====================================================================
   ПРЕПЯТСТВИЯ И ПОПЕРЕЧНЫЙ ТРАФИК
   ===================================================================== */

function makePotholeObj() {
  const g = new THREE.Group();
  const pit = cyl(g, 1.2, 1.0, 0.06, 12, 0x121214, 0, 0.03, 0);
  pit.scale.z = 0.7;
  const rim = new THREE.Mesh(torusGeo2(1.15, 0.07), mat(0x6a6a66));
  rim.rotation.x = -Math.PI / 2;
  rim.scale.z = 0.7;
  rim.position.y = 0.06;
  g.add(rim);
  return g;
}

function makeBrickObj() {
  const g = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const b = box(g, 0.36, 0.18, 0.22, 0x9c4a2f, rnd(-0.5, 0.5), 0.09, rnd(-0.3, 0.3));
    b.rotation.y = rnd(0, Math.PI);
  }
  return g;
}

function makeManholeObj() {
  const g = new THREE.Group();
  const hole = cyl(g, 0.85, 0.85, 0.05, 12, 0x101012, 0, 0.03, 0);
  hole.scale.z = 0.85;
  const rim = new THREE.Mesh(torusGeo2(0.88, 0.1), mat(0x8a8f96));
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = 0.07;
  g.add(rim);
  // откинутая крышка
  const lid = cyl(g, 0.8, 0.8, 0.08, 12, 0x777c82, 1.35, 0.55, 0);
  lid.rotation.z = 1.15;
  box(g, 0.7, 0.6, 0.7, 0x1b1b1e, 0, 0.02, 0);
  return g;
}

function makeHumpObj() {
  const g = new THREE.Group();
  const body = cyl(g, 0.28, 0.34, 3.6, 8, 0xd8b33a, 0, 0.14, 0);
  body.rotation.z = Math.PI / 2;
  body.scale.set(1, 1, 0.55);
  for (let i = -1; i <= 1; i++) {
    box(g, 0.34, 0.02, 1.9, 0x26262a, i * 1.05, 0.3, 0);
  }
  return g;
}

function makePuddleObj() {
  const g = new THREE.Group();
  const p = cyl(g, 1.9, 1.9, 0.02, 14, 0x59697a, 0, 0.03, 0);
  p.scale.z = 0.62;
  p.material = new THREE.MeshBasicMaterial({ color: 0x6a7b8c, transparent: true, opacity: 0.86 });
  const shine = cyl(g, 1.1, 1.1, 0.01, 10, 0x93a6b4, -0.25, 0.045, 0);
  shine.scale.z = 0.4;
  shine.material = new THREE.MeshBasicMaterial({ color: 0xa9bccb, transparent: true, opacity: 0.5 });
  return g;
}

function makeChickensObj() {
  const g = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const sx = -0.8 + i * 0.8;
    box(g, 0.34, 0.3, 0.42, 0xf2efe8, sx, 0.3, rnd(-0.2, 0.2));
    sph(g, 0.15, 0xf2efe8, sx, 0.55, -0.22, 6);
    box(g, 0.08, 0.06, 0.12, 0xd97b2a, sx, 0.52, -0.34);
    box(g, 0.1, 0.1, 0.06, 0xd03a3a, sx, 0.68, -0.2);
    box(g, 0.07, 0.2, 0.07, 0xd8a03a, sx - 0.08, 0.1, 0.05);
    box(g, 0.07, 0.2, 0.07, 0xd8a03a, sx + 0.08, 0.1, 0.05);
  }
  return g;
}

function makeGrannyObj() {
  const g = new THREE.Group();
  const p = makePerson({
    shirt: 0x8a6a7a, pants: 0x4a4450, dress: true, dressColor: 0x7a5a6a,
    hair: 0xd8d2c8, scale: 0.92,
  });
  g.add(p);
  box(g, 0.5, 0.44, 0.34, 0x9c7b4a, 0.46, 0.5, 0.1);   // сумка
  box(g, 0.08, 0.3, 0.08, 0x6d6459, 0.34, 0.86, 0.1);
  return g;
}

function makeGazelleObj() {
  const g = new THREE.Group();
  box(g, 2.0, 1.7, 4.4, 0xdcdad2, 0, 1.0, 0);
  box(g, 1.9, 0.8, 1.2, 0xdcdad2, 0, 2.2, -1.5);
  box(g, 1.7, 0.62, 0.1, 0x243040, 0, 2.2, -2.1);
  box(g, 0.1, 0.7, 1.6, 0x243040, 1.01, 2.15, -1.5);
  box(g, 0.04, 0.6, 3.4, 0x2f4f8a, 1.01, 1.1, 0.2);
  // распахнутая дверь
  const door = box(g, 0.09, 1.5, 1.1, 0xbfbcb4, 1.5, 1.0, -0.7);
  door.rotation.y = -1.15;
  box(g, 1.1, 0.7, 1.0, 0x1b1b1e, 0.36, 1.0, -0.7);
  // аварийка
  box(g, 0.18, 0.18, 0.1, 0xffb347, -0.7, 1.0, 2.22, { basic: true });
  return g;
}

function makeOncomingKamazObj() {
  const g = new THREE.Group();
  // камаз едет на игрока: кабина смотрит в +z
  box(g, 2.4, 2.0, 5.6, 0x8a5a34, 0, 1.6, 0.6);
  box(g, 2.3, 1.7, 1.8, 0x9a6440, 0, 1.5, 3.4);
  box(g, 2.0, 0.75, 0.1, 0x243040, 0, 1.95, 4.3);
  box(g, 2.5, 0.3, 0.3, 0xd8d2c4, 0, 0.55, 4.35);
  for (const sx of [-0.9, 0.9]) {
    box(g, 0.34, 0.3, 0.1, 0xfff3d0, sx, 0.95, 4.32, { basic: true });
  }
  for (const sz of [-1.6, 0.6, 2.6]) {
    for (const sx of [-1.25, 1.25]) {
      box(g, 0.34, 0.72, 0.72, 0x1b1b1e, sx, 0.36, sz);
    }
  }
  return g;
}

const OB_META = {
  pothole: { hw: 1.15, hl: 0.9, sec: 6, mood: 4 },
  brick: { hw: 0.7, hl: 0.6, sec: 4, mood: 3 },
  manhole: { hw: 0.9, hl: 0.9, sec: 6, mood: 4 },
  hump: { hw: 1.7, hl: 0.9, sec: 8, mood: 5 },
  puddle: { hw: 1.9, hl: 1.6, slip: true },
  chickens: { hw: 1.3, hl: 0.8, sec: 5, mood: 4 },
  granny: { hw: 0.9, hl: 0.8, sec: 8, mood: 6 },
  gazelle: { hw: 1.6, hl: 2.3, sec: 12, mood: 8 },
  oncoming: { hw: 1.45, hl: 2.8, sec: 20, mood: 10 },
};
const OB_BUILDERS = {
  pothole: makePotholeObj,
  brick: makeBrickObj,
  manhole: makeManholeObj,
  hump: makeHumpObj,
  puddle: makePuddleObj,
  chickens: makeChickensObj,
  granny: makeGrannyObj,
  gazelle: makeGazelleObj,
  oncoming: makeOncomingKamazObj,
};
const OB_HINT = {
  pothole: 'ЯМА впереди. Объехать.',
  brick: 'КИРПИЧИ на дороге. Не по центру.',
  manhole: 'ОТКРЫТЫЙ ЛЮК. Колесо туда не надо.',
  hump: 'ЛЕЖАЧИЙ ПОЛИЦЕЙСКИЙ. Притормози.',
  puddle: 'ЛУЖА. На скорости понесёт.',
  chickens: 'КУРЫ. Они не спешат.',
  granny: 'Бабушка с сумкой. Пропусти.',
  gazelle: 'ГАЗЕЛЬ с распахнутой дверью.',
  oncoming: 'ВСТРЕЧНЫЙ КАМАЗ на твоей стороне!',
};

/* ---------- поперечный трафик ---------- */
function makeCrossKamaz() {
  const g = new THREE.Group();
  box(g, 7.4, 2.3, 2.5, 0x8a5a34, 0, 1.55, 0);
  box(g, 2.0, 2.1, 2.4, 0x9a6440, 3.7, 1.5, 0);
  box(g, 1.7, 0.8, 2.2, 0x243040, 3.7, 2.0, 0);
  box(g, 8.0, 0.3, 2.7, 0xd8d2c4, 0, 0.55, 0);
  for (const wx of [-3.0, -1.0, 3.2]) {
    for (const wz of [-1.1, 1.1]) box(g, 0.8, 0.8, 0.4, 0x1b1b1e, wx, 0.4, wz);
  }
  return g;
}
function makeCrossTram() {
  const g = new THREE.Group();
  box(g, 13.0, 2.5, 2.6, 0xe6e2d8, 0, 1.6, 0);
  box(g, 13.0, 0.5, 2.7, 0x8f2f38, 0, 0.9, 0);
  for (let i = -5; i <= 5; i++) {
    box(g, 0.9, 0.8, 0.1, 0x243040, i * 1.1, 2.1, -1.32);
    box(g, 0.9, 0.8, 0.1, 0x243040, i * 1.1, 2.1, 1.32);
  }
  box(g, 13.4, 0.16, 0.18, 0x9a9a94, 0, 0.06, -1.0);
  box(g, 13.4, 0.16, 0.18, 0x9a9a94, 0, 0.06, 1.0);
  return g;
}
function makeCrossMarshrutka() {
  const g = new THREE.Group();
  box(g, 5.4, 2.0, 2.2, 0xf0ece2, 0, 1.3, 0);
  box(g, 5.4, 0.5, 2.24, 0x2f5fa0, 0, 0.85, 0);
  for (const wx of [-1.4, 0, 1.4]) {
    box(g, 1.1, 0.7, 0.1, 0x243040, wx, 1.85, 1.12);
  }
  box(g, 1.2, 0.7, 0.1, 0x243040, -1.4, 1.85, -1.12);
  for (const wx of [-1.7, 1.7]) {
    for (const wz of [-1.0, 1.0]) box(g, 0.7, 0.7, 0.3, 0x1b1b1e, wx, 0.36, wz);
  }
  return g;
}
function makeCrossGranny() {
  const g = new THREE.Group();
  g.add(makeGrannyObj());
  g.rotation.y = Math.PI / 2;
  return g;
}

const CROSS_KINDS = [
  { id: 'kamaz', hw: 5.6, sp: 21, hint: 'КАМАЗ поперёк дороги. Тормози.', build: makeCrossKamaz },
  { id: 'tram', hw: 4.6, sp: 18, hint: 'ТРАМВАЙ. Его не объедешь — только стоять.', build: makeCrossTram },
  { id: 'marshrutka', hw: 3.0, sp: 26, hint: 'МАРШРУТКА. Она уже не тормозит.', build: makeCrossMarshrutka },
  { id: 'granny', hw: 0.65, sp: 2.0, hint: 'БАБУШКА переходит. Пропусти.', build: makeCrossGranny },
];

const CROSS_COUNT = 12;        // 20 перекрёстков на 30000 → 12 на 18500
const CROSS_AVOID = [COW_P, MOWER_P, BRIDE_P, CITY_FUNERAL_P, CITY_INSPECTOR_P];
const crossings = [];
function initCrossings() {
  const step = (ROUTE - 1600) / CROSS_COUNT;
  const positions = [];
  for (let k = 0; k < CROSS_COUNT; k++) {
    let p = 900 + (k + 0.5) * step + rnd(-130, 130);
    // не ставим перекрёсток на сюжетную сцену и не лепим их друг к другу
    for (let guard = 0; guard < 8; guard++) {
      let moved = false;
      if (positions.length && p - positions[positions.length - 1] < 640) {
        p = positions[positions.length - 1] + 640;
        moved = true;
      }
      const near = CROSS_AVOID.find((a) => Math.abs(p - a) < 430);
      if (near !== undefined) {
        p = near + 430 + rnd(0, 90);
        moved = true;
      }
      if (!moved) break;
    }
    if (p > ROUTE - 450) p = ROUTE - 450;
    positions.push(p);
  }
  for (let k = 0; k < CROSS_COUNT; k++) {
    const p = positions[k];
    const kind = CROSS_KINDS[k % CROSS_KINDS.length];
    // поперечная улица
    const street = new THREE.Mesh(new THREE.PlaneGeometry(90, 10), mat(0x45444a));
    street.rotation.x = -Math.PI / 2;
    street.position.set(roadOff(p), 0.018, -p);
    scene.add(street);
    for (const sz of [-5.2, 5.2]) {
      const curb = box(scene, 90, 0.12, 0.3, PAL.curb, roadOff(p), 0.06, -p + sz);
      curb.userData.static = true;
    }
    // знак заранее
    const sg = new THREE.Group();
    const s = makeSign('ПЕРЕКРЁСТОК', 3.4, 1.0, '#3d151c');
    cyl(sg, 0.1, 0.1, 3.0, 6, 0x5b5b5f, 0, 1.5, 0);
    s.position.y = 2.9;
    s.rotation.y = -0.5;
    sg.add(s);
    sg.position.set(roadOff(p - 130) + 7.6, 0, -(p - 130));
    scene.add(sg);

    const veh = kind.build();
    veh.visible = false;
    scene.add(veh);
    const dir = Math.random() < 0.5 ? 1 : -1;
    veh.rotation.y = dir > 0 ? 0 : Math.PI;
    const relX = -dir * (kind.id === 'granny' ? 6 : 21);
    veh.position.set(roadOff(p) + relX, 0, -p);
    crossings.push({
      p, kind, veh, dir, relX,
      hw: kind.hw, sp: kind.sp,
      started: false, warned: false, done: false,
    });
  }
}

function updateCrossings(dt) {
  for (const c of crossings) {
    if (c.done) continue;
    const d = c.p - S.p;
    if (d < -70) {
      c.done = true;
      c.veh.visible = false;
      continue;
    }
    if (d > 0 && d < 85 && !c.warned) {
      c.warned = true;
      S.warnT = Math.max(S.warnT, clamp(d / Math.max(S.speed, 12), 1.2, 2.0));
      audio.sfx.warning();
      if (!S.seen['cross_' + c.kind.id]) {
        S.seen['cross_' + c.kind.id] = true;
        say('ПЕРЕКРЁСТОК · ' + c.kind.hint, 3.2);
      }
    }
    if (!c.started) {
      // выезд рассчитан так, чтобы корпус пересёк центр ровно к приезду игрока
      // и был виден в кадре >= 1 с до удара
      // на узкой камере поперечная машина должна быть видна в кадре
      // не меньше секунды до удара: выпускаем её раньше и плавнее
      const trig = Math.max(100, S.speed * 1.9);
      if (d > 0 && d < trig) {
        c.started = true;
        c.veh.visible = true;
        const tArrive = Math.max(d / Math.max(S.speed, 8), 0.35);
        if (c.kind.id === 'granny') {
          // она уже на дороге, идёт медленно
          c.relX = -c.dir * 2.5;
          c.spEff = c.sp;
        } else {
          // передняя кромка корпуса — в кадре, центр дороги — к приезду игрока
          const dist = 24 - c.hw;
          c.relX = -c.dir * dist;
          c.spEff = dist / tArrive;
        }
        c.veh.position.x = roadOff(c.p) + c.relX;
      }
    }
    if (c.started) {
      c.relX += c.dir * (c.spEff || c.sp) * dt;
      c.veh.position.x = roadOff(c.p) + c.relX;
      if (Math.abs(c.relX) > 34) c.veh.visible = false;
      // столкновение
      if (S.invuln <= 0 && Math.abs(d) < 2.4 && Math.abs(c.veh.position.x - S.x) < c.hw + 0.95) {
        hit('crossing', HIT_CLOCK, 14);
        c.done = true;
        c.veh.visible = false;
      }
    }
  }
}

/* =====================================================================
   МИР
   ===================================================================== */

const WORLD_LEN = ROUTE + 900;

/* ---------- лента вдоль кривой: полоса между latA и latB ---------- */
function stripGeo(p0, p1, latA, latB, yA, yB, step, uvV) {
  // нормаль вверх: слева-направо, иначе лента смотрит в землю
  if (latA > latB) {
    let t = latA; latA = latB; latB = t;
    t = yA; yA = yB; yB = t;
  }
  const n = Math.max(1, Math.ceil((p1 - p0) / step));
  const pos = new Float32Array((n + 1) * 6);
  const uvs = new Float32Array((n + 1) * 4);
  const idx = [];
  for (let i = 0; i <= n; i++) {
    const p = p0 + (p1 - p0) * (i / n);
    const c = roadOff(p);
    const z = -p;
    pos[i * 6] = c + latA;
    pos[i * 6 + 1] = yA;
    pos[i * 6 + 2] = z;
    pos[i * 6 + 3] = c + latB;
    pos[i * 6 + 4] = yB;
    pos[i * 6 + 5] = z;
    uvs[i * 4] = 0;
    uvs[i * 4 + 1] = p / uvV;
    uvs[i * 4 + 2] = 1;
    uvs[i * 4 + 3] = p / uvV;
  }
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function ribbon(matOrTex, p0, p1, latA, latB, yA, yB, uvV, step = 8) {
  const m = matOrTex.isMaterial
    ? matOrTex
    : new THREE.MeshLambertMaterial({ map: matOrTex });
  const mesh = new THREE.Mesh(stripGeo(p0, p1, latA, latB, yA, yB, step, uvV || 6), m);
  scene.add(mesh);
  return mesh;
}

/* ---------- дорога, тротуары и газоны по кривой ---------- */
{
  const P0 = -300;
  const P1 = ROUTE + 1100;

  // асфальт: разметка из текстуры, uv по длине
  ribbon(roadTex, P0, P1, -5.2, 5.2, 0.01, 0.01, 6, 6);

  // бордюр: наклонная полка, читается как приподнятый край
  for (const sx of [-1, 1]) {
    ribbon(mat(PAL.curb), P0, P1, sx * 5.15, sx * 5.6, 0.14, 0.03, 6, 6);
  }

  const GRASS = 0x474a3a;
  const zones = [
    { len: SEGMENTS[0].end + 80, sh: 3.9, walk: 0xb3aca0, border: true },
    { len: SEGMENTS[1].end - SEGMENTS[1].start + 40, sh: 2.2, walk: 0xa89f8f, border: false },
    { len: SEGMENTS[2].end - SEGMENTS[2].start - 100, sh: 3.9, walk: 0xb3aca0, border: true },
  ];
  let dCursor = -40;
  for (const zone of zones) {
    const p0 = dCursor;
    const p1 = dCursor + zone.len;
    const walkW = zone.sh + 0.2;
    const walkInner = 5.6;
    const walkOuter = walkInner + walkW;
    const borderOuter = walkOuter + (zone.border ? 1.6 : 0);
    const grassW = 46 - borderOuter;
    const walkMat = new THREE.MeshLambertMaterial({ color: zone.walk });
    for (const sx of [-1, 1]) {
      ribbon(walkMat, p0, p1, sx * walkInner, sx * walkOuter, 0.03, 0.03, 6, 8);
      if (zone.border) {
        ribbon(checkerTex, p0, p1, sx * walkOuter, sx * borderOuter, 0.04, 0.04, 3.2, 8);
      }
      ribbon(mat(GRASS), p0, p1, sx * borderOuter, sx * (borderOuter + grassW), 0.0, 0.0, 8, 12);
    }
    dCursor += zone.len;
  }

  // земля
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(700, WORLD_LEN + 400),
    mat(0x3a3d30)
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, -0.6, -WORLD_LEN / 2 + 300);
  scene.add(ground);
}

/* ---------- потоки реквизита ---------- */
const streams = [];
function stream(count, spacing, build) {
  const items = [];
  for (let i = 0; i < count; i++) {
    const o = build(i);
    o.position.z = -i * spacing;
    o.userData.baseX = o.position.x;
    scene.add(o);
    items.push(o);
  }
  const len = count * spacing;
  const s = {
    items,
    update(playerZ) {
      for (const o of items) {
        if (o.position.z > playerZ + 48) {
          // после ретрая/телепорта догоняем сразу, а не по одному шагу за кадр
          o.position.z -= len * Math.ceil((o.position.z - playerZ - 48) / len);
        }
        o.position.x = o.userData.baseX + roadOff(-o.position.z);
      }
    },
  };
  streams.push(s);
  return s;
}

const SIGN_TEXTS = ['ПРОДУКТЫ', 'РЕМОНТ ОБУВИ', 'ШИНЫ', 'ХЛЕБ', 'ГАРАЖИ', 'АПТЕКА'];

stream(12, 34, () => {
  const g = makeBuilding(rnd(9, 15), rnd(11, 19), rnd(8, 12));
  g.position.x = rnd(19, 28) * (Math.random() > 0.5 ? 1 : -1);
  g.rotation.y = Math.random() > 0.5 ? 0 : Math.PI;
  return g;
});

stream(18, 11, (i) => {
  // забор идёт сплошными пролётами: попеременно то справа, то слева
  const side = i % 2 === 0 ? 1 : -1;
  const g = makeFenceSection(side);
  g.position.x = side * rnd(9.9, 10.3);
  g.rotation.y = Math.PI / 2;
  return g;
});

stream(24, 12, () => {
  const g = makeBirch();
  const side = Math.random() > 0.5 ? 1 : -1;
  g.position.x = side * rnd(10.8, 13.8);
  g.scale.setScalar(rnd(0.8, 1.25));
  g.rotation.y = rnd(0, Math.PI);
  return g;
});

stream(48, 4.5, () => {
  const g = new THREE.Group();
  const n = 2 + ((Math.random() * 4) | 0);
  for (let i = 0; i < n; i++) {
    const d = makeDandelion();
    d.position.set(rnd(-0.5, 0.5), 0, rnd(-0.5, 0.5));
    d.rotation.y = rnd(0, Math.PI);
    g.add(d);
  }
  g.position.x = (Math.random() > 0.5 ? 1 : -1) * rnd(10.3, 13.0);
  return g;
});

stream(9, 40, () => {
  const g = makeGarage(String(1 + ((Math.random() * 40) | 0)));
  const side = Math.random() > 0.5 ? 1 : -1;
  g.position.x = side * rnd(12.6, 14.6);
  g.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
  return g;
});

stream(16, 21, () => {
  const g = makeStreetLamp();
  const side = Math.random() > 0.5 ? 1 : -1;
  g.position.x = side * 5.9;
  g.rotation.y = side > 0 ? 0 : Math.PI;
  return g;
});

stream(7, 62, () => {
  const g = new THREE.Group();
  const side = Math.random() > 0.5 ? 1 : -1;
  cyl(g, 0.09, 0.12, 3.4, 6, 0x6b6660, 0, 1.7, 0);
  const paper = new THREE.Mesh(
    new THREE.PlaneGeometry(1.05, 0.72),
    new THREE.MeshLambertMaterial({ map: noticeTex, side: THREE.DoubleSide })
  );
  paper.position.set(0, 2.2, 0.14);
  paper.rotation.y = side > 0 ? -0.35 : 0.35;
  g.add(paper);
  g.position.x = side * rnd(7.6, 8.6);
  return g;
});

stream(8, 52, () => {
  const g = makePoleSign(pick(SIGN_TEXTS));
  const side = Math.random() > 0.5 ? 1 : -1;
  g.position.x = side * 7.2;
  g.rotation.y = side > 0 ? -0.25 : 0.25;
  return g;
});

/* таблички-чекпоинты на началах отрезков */
for (const seg of SEGMENTS) {
  const s = makeSign(`ОТРЕЗОК · ${seg.name}`, 4.0, 1.1, '#5b1f27');
  const g = new THREE.Group();
  cyl(g, 0.1, 0.1, 3.2, 6, 0x5b5b5f, 0, 1.6, 0);
  s.position.y = 3.1;
  s.rotation.y = -0.5;
  g.add(s);
  g.position.set(worldX(seg.start, 7.6), 0, -seg.start);
  scene.add(g);
}

/* ---------- финальный двор ---------- */
const YARD_Z = -(ROUTE + 7);   // створ ворот
const yardGroup = new THREE.Group();
yardGroup.position.z = YARD_Z;
yardGroup.position.x = roadOff(ROUTE + 7);
{
  const g = yardGroup;
  // подъездная дорожка во двор
  const drive = new THREE.Mesh(new THREE.PlaneGeometry(10.4, 34), mat(0x45444a));
  drive.rotation.x = -Math.PI / 2;
  drive.position.set(0, 0.012, 0);
  g.add(drive);
  // асфальт двора + шахматная дорожка к дому
  const court = new THREE.Mesh(new THREE.PlaneGeometry(20, 14), mat(0x47464c));
  court.rotation.x = -Math.PI / 2;
  court.position.set(0, 0.014, -14);
  g.add(court);
  const pathT = checkerTex.clone();
  pathT.needsUpdate = true;
  pathT.repeat.set(2, 1.2);
  const path = new THREE.Mesh(new THREE.PlaneGeometry(7, 4.5), new THREE.MeshLambertMaterial({ map: pathT }));
  path.rotation.x = -Math.PI / 2;
  path.position.set(0, 0.018, -13.5);
  g.add(path);

  // ворота
  for (const sx of [-1, 1]) {
    box(g, 0.85, 3.1, 0.85, 0x9d9385, sx * 4.9, 1.55, 0);
    box(g, 1.1, 0.2, 1.1, 0x7b7268, sx * 4.9, 3.2, 0);
    box(g, 0.34, 0.34, 0.34, 0xffd9a0, sx * 4.9, 3.5, 0, { basic: true });
  }
  box(g, 10.6, 0.34, 0.5, 0x6d6459, 0, 3.32, 0);
  // створки, распахнутые внутрь
  for (const sx of [-1, 1]) {
    const leaf = box(g, 4.4, 2.4, 0.12, 0x5f6b4a, sx * 2.5, 1.2, -0.1);
    leaf.rotation.y = sx * 0.5;
    box(g, 4.4, 0.1, 0.2, 0x4b553b, sx * 2.4, 1.85, -0.15).rotation.y = sx * 0.5;
  }
  // дом за воротами
  {
    const t = facadeTex.clone();
    t.needsUpdate = true;
    t.repeat.set(3, 1);
    const house = new THREE.Mesh(
      new THREE.BoxGeometry(13, 7.2, 8),
      new THREE.MeshLambertMaterial({ map: t, color: 0xe8ddd0 })
    );
    house.position.set(0, 3.6, -20);
    g.add(house);
  }
  box(g, 14, 0.8, 8.8, 0x5a4a44, 0, 7.5, -20);
  box(g, 0.9, 1.5, 0.9, 0x8a5a4a, -3.6, 8.4, -20);
  box(g, 1.7, 3.0, 0.18, 0x5b1f27, 0, 1.5, -15.9);
  box(g, 2.1, 0.18, 0.26, 0x6d6459, 0, 3.1, -16);
  for (const sx of [-1, 1]) {
    const lamp = box(g, 0.34, 0.5, 0.3, PAL.lamp, sx * 1.6, 2.4, -15.9, { basic: true });
    lamp.scale.set(0.34, 0.5, 0.3);
  }
  // гараж во дворе
  box(g, 5.4, 2.9, 3.6, 0x8b8578, -9.2, 1.45, -9);
  box(g, 4.4, 2.3, 0.14, 0x6a6a66, -9.2, 1.15, -7.15);
  // забор по краям двора
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      box(g, 0.2, 2.1, 7, 0x8f8a80, sx * 11.2, 1.05, -4 - i * 7);
    }
  }
  // шарики на воротах
  const balloonColors = [0xd05a6a, 0xf2d24a, 0x6aa0d0, 0xe6e2d8, 0x9ad06a];
  for (let i = 0; i < 7; i++) {
    const bx = -6.2 + i * 2.07;
    const b = sph(g, 0.44, balloonColors[i % balloonColors.length], bx, 4.0 + Math.sin(i * 1.7) * 0.5, 0.5, 8);
    b.scale.y = 1.18;
    box(g, 0.03, 1.0, 0.03, 0x9a9a94, bx, 3.4, 0.5);
  }
  // стол с угощением
  box(g, 2.8, 0.12, 1.2, 0xd8d2c4, 7.6, 0.92, -5);
  box(g, 0.12, 0.92, 0.12, 0x6d6459, 6.5, 0.46, -5);
  box(g, 0.12, 0.92, 0.12, 0x6d6459, 8.7, 0.46, -5);
  scene.add(g);
}

/* ---------- игрок ---------- */
const playerCar = makeCar(0x7a2a35, 0x8f3340);
scene.add(playerCar);
const playerBody = playerCar.userData.body;

/* пассажиры (появляются по сюжету) */
const brideSeat = new THREE.Group();
{
  const b = makeBride();
  b.scale.setScalar(0.62);
  b.position.set(0.38, 0.78, 0.25);
  b.rotation.y = Math.PI;
  brideSeat.add(b);
  brideSeat.visible = false;
  playerBody.add(brideSeat);
}
const pigeonSeat = new THREE.Group();
{
  const p = makePigeon();
  p.scale.setScalar(1.1);
  p.position.set(-0.32, 1.5, -0.5);
  pigeonSeat.add(p);
  pigeonSeat.visible = false;
  playerBody.add(pigeonSeat);
}

/* ---------- полиция ---------- */
const police = makePoliceCar();
police.position.set(0, 0, 8.6);
scene.add(police);

/* ---------- жених: красная машина с сердцем и надписью ---------- */
function makeGroomSignTex() {
  return texFromCanvas(128, 96, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    // сердце
    g.fillStyle = '#ffd9a0';
    g.beginPath();
    g.moveTo(64, 80);
    g.bezierCurveTo(10, 48, 20, 12, 64, 34);
    g.bezierCurveTo(108, 12, 118, 48, 64, 80);
    g.fill();
    g.fillStyle = '#5b1f27';
    g.font = 'bold 22px monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('ЖЕНИХ', 64, 92);
  });
}

const groom = makeCar(0xb32b2b, 0xc93a3a);
{
  const signMat = new THREE.MeshLambertMaterial({
    map: makeGroomSignTex(),
    transparent: true,
    side: THREE.DoubleSide,
  });
  const roofSign = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.1), signMat);
  roofSign.rotation.x = -Math.PI / 2;
  roofSign.rotation.z = Math.PI;
  roofSign.position.set(0, 1.52, 0.3);
  groom.userData.body.add(roofSign);

  const sideSign = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.95), signMat);
  sideSign.position.set(0, 0.95, 1.99);
  groom.userData.body.add(sideSign);

  // сердце на капоте
  const heart = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.7), signMat);
  heart.rotation.x = -Math.PI / 2;
  heart.position.set(0, 0.9, -1.1);
  groom.userData.body.add(heart);

  // объёмное сердце над крышей — читается даже в 320×180
  const hg = new THREE.Group();
  const hm = basic(0xff5a7a);
  for (const sx of [-0.19, 0.19]) {
    const s1 = new THREE.Mesh(sphGeo(0.24, 8), hm);
    s1.position.set(sx, 0, 0);
    s1.scale.set(1, 1, 0.7);
    hg.add(s1);
  }
  const cone = new THREE.Mesh(coneGeo(), hm);
  cone.position.set(0, -0.28, 0);
  cone.rotation.z = Math.PI;
  cone.scale.set(1.5, 1.1, 0.9);
  hg.add(cone);
  hg.position.set(0, 2.05, 0.3);
  hg.scale.setScalar(1.5);
  groom.userData.body.add(hg);
}
groom.visible = false;
scene.add(groom);

/* =====================================================================
   СОСТОЯНИЕ
   ===================================================================== */

const S = {
  phase: 'start',      // start | play | finale | lost | won
  p: 0,
  x: 0,
  lat: 0,              // боковое смещение от центра дороги, вещественное
  latV: 0,             // боковая скорость
  speed: 0,
  clock: 0,
  mood: 100,
  seg: 0,
  invuln: 0,
  shake: 0,
  slowT: 0,
  slip: 0,             // занос после лужи
  invert: 0,
  hintUsed: false,
  controlHintOn: false,
  warnT: 0,
  turnT: 0,
  kerbT: -9,
  moodDrain: null,
  capQueue: [],
  capTimer: 0,
  finaleT: 0,
  checkpoint: { p: 0, clock: 0, mood: 100, seg: 0 },
  startedAt: 0,
  time: 0,
  funeralShown: false,
  seen: {},
  hitKinds: {},
};

let colliders = [];
let obstacles = [];         // препятствия текущего отрезка
let movers = [];            // встречный транспорт, который едет сам
let E = {};                 // объекты текущего отрезка
const dynGroup = new THREE.Group();
scene.add(dynGroup);

function clearDyn() {
  while (dynGroup.children.length) dynGroup.remove(dynGroup.children[0]);
  colliders = [];
  obstacles = [];
  movers = [];
  E = {};
}

/* =====================================================================
   ЗВУК — синтез в WebAudio, без файлов и без сборки
   ===================================================================== */

const audio = (() => {
  const BPM = 92;
  const STEP_BASE = 60 / BPM / 4;   // 16-я нота
  const SWING_EVEN = 1.16;          // лёгкий свинг: длинная-короткая пара
  const SWING_ODD = 0.84;
  const MUSIC_LEVEL = 0.22;
  const SFX_LEVEL = 0.62;
  const MASTER_LEVEL = 1;
  const BAR_STEPS = 16;
  const DUCK_DB = -3.5;             // музыка под салютом: 3–4 дБ вниз

  // слои бита: каждый живёт в своей шине, чтобы мерить вклад соло
  const LAYERS = [
    'kick', 'snare', 'clap', 'hatClosed', 'hatOpen', 'shaker',
    'rim', 'tom', 'bass', 'stab', 'hook', 'crash', 'pad',
  ];
  const BASS_ROOTS = [82.41, 82.41, 98.0, 73.42];   // E2 E2 G2 D2
  const HOOK_A = [
    [0, 659.25, 0.16, 1], [3, 783.99, 0.14, 0.82], [6, 880.0, 0.12, 0.7],
    [8, 659.25, 0.16, 0.95], [11, 587.33, 0.12, 0.72], [14, 783.99, 0.2, 0.85],
  ];
  const HOOK_B = [
    [0, 659.25, 0.16, 1], [3, 880.0, 0.14, 0.82], [6, 987.77, 0.12, 0.7],
    [8, 783.99, 0.16, 0.95], [11, 987.77, 0.12, 0.7], [14, 659.25, 0.22, 0.85],
  ];
  const KICK_A = [0, 3, 8, 11, 14];      // полный такт
  const KICK_B = [0, 3, 7, 8, 11, 14];
  const KICK_A_SPARSE = [0, 8, 14];      // соседний такт — разреженный
  const KICK_B_SPARSE = [0, 8, 14];
  // бас: [шаг, множитель к корню, длительность, громкость] — 2–3 ноты на такт
  const BASS_A = [
    [[0, 1, 0.26, 1], [3, 1, 0.12, 0.7], [8, 1, 0.22, 0.95], [11, 1.5, 0.14, 0.7], [14, 2, 0.12, 0.6]],
    [[0, 1, 0.2, 0.95], [6, 1.5, 0.16, 0.8], [8, 1, 0.24, 0.9], [13, 2, 0.12, 0.6]],
    [[0, 1, 0.24, 1], [3, 1.5, 0.12, 0.7], [8, 1, 0.2, 0.9], [10, 2, 0.12, 0.65], [14, 1.5, 0.14, 0.7]],
    [[0, 1, 0.22, 0.95], [5, 1.5, 0.14, 0.75], [8, 2, 0.16, 0.75], [12, 1, 0.18, 0.85], [15, 1.5, 0.1, 0.6]],
  ];
  const BASS_B = [
    [[0, 1, 0.26, 1], [3, 2, 0.1, 0.65], [7, 1.5, 0.14, 0.75], [8, 1, 0.22, 0.9], [14, 2, 0.12, 0.6]],
    [[0, 1, 0.2, 0.95], [4, 1.5, 0.12, 0.7], [8, 1, 0.22, 0.9], [11, 2, 0.12, 0.6], [14, 1.5, 0.14, 0.65]],
    [[0, 1, 0.24, 1], [6, 1.5, 0.16, 0.8], [8, 2, 0.18, 0.8], [12, 1, 0.16, 0.75]],
    [[0, 1, 0.2, 0.9], [2, 1.5, 0.12, 0.65], [8, 1.5, 0.18, 0.8], [10, 1, 0.16, 0.8], [14, 2, 0.12, 0.6]],
  ];

  let ctx = null;
  let master = null;
  let comp = null;
  let analyser = null;
  let music = null;
  let sfx = null;
  let buf = null;
  let started = false;
  let step = 0;
  let nextAt = 0;
  let lastEvent = 'none';
  let muted = false;
  let sirenUntil = 0;
  let timer = null;
  let LIVE = null;               // движок живого графа {ctx, music, sfx, buses, noise}
  let duckUntil = 0;
  let duckDb = 0;
  let lastFireworkDur = 0;

  // состояние разблокировки: диагностика и честный индикатор
  let contextCount = 0;
  let unlockAttempts = 0;
  let stateBeforeGesture = 'idle';
  let stateAfterGesture = 'idle';
  let lastError = '';
  let gestureSource = 'none';
  let lastPointerAt = -1e9;
  let zeroBuf = null;
  let sessionEl = null;
  let silentUri = null;
  let startedAt = 0;
  let silentFor = 0;
  let lastTickAt = 0;
  let lastRmsAt = 0;
  let hintText = null;
  let hintOn = false;
  let hintBad = false;
  let hintStart = null;
  let hintEl = null;

  const hash = (n) => {
    const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  };

  function errText(e) {
    return String((e && (e.message || e.name)) || e || 'unknown');
  }

  function setPlaybackSession() {
    const s = navigator.audioSession;
    if (!s) return;
    try {
      // iOS: playback игнорирует бесшумный переключатель, ambient — нет
      if (s.type !== 'playback') s.type = 'playback';
    } catch (e) {
      lastError = 'audioSession: ' + errText(e);
    }
  }

  function sessionType() {
    const s = navigator.audioSession;
    return s ? String(s.type) : 'none';
  }

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      lastError = 'WebAudio недоступен';
      return null;
    }
    setPlaybackSession();
    try {
      ctx = new AC();
    } catch (e) {
      ctx = null;
      lastError = 'AudioContext: ' + errText(e);
      return null;
    }
    contextCount++;
    resumeSync();                 // не ждём сборки графа: жест ещё активен
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 8;
    comp.ratio.value = 5;
    comp.attack.value = 0.004;
    comp.release.value = 0.18;

    analyser = ctx.createAnalyser();
    analyser.fftSize = 8192;          // ~186 мс: RMS не прыгает между шагами
    analyser.smoothingTimeConstant = 0;
    buf = new Float32Array(analyser.fftSize);

    master = ctx.createGain();
    // контекст можно создать первым касанием на стартовом экране:
    // до start() мастер молчит, чтобы пад не играл под заголовком
    master.gain.value = (muted || !started) ? 0 : MASTER_LEVEL;
    music = ctx.createGain();
    music.gain.value = MUSIC_LEVEL;
    sfx = ctx.createGain();
    sfx.gain.value = SFX_LEVEL;

    music.connect(master);
    sfx.connect(master);
    master.connect(comp);
    comp.connect(analyser);
    analyser.connect(ctx.destination);

    LIVE = {
      ctx,
      music,
      sfx,
      buses: buildBuses(ctx, music, null),
      noise: makeNoise(ctx),
      seg: null,
    };
    buildPad(LIVE);
    return ctx;
  }

  function makeNoise(c) {
    // один буфер шума на все хэты, клэпы и салют
    const n = Math.floor(c.sampleRate * 2);
    const b = c.createBuffer(1, n, c.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  function buildBuses(c, dest, solo) {
    const out = {};
    for (const name of LAYERS) {
      const g = c.createGain();
      // соло-замер глушит всё, кроме одного слоя
      g.gain.value = solo && solo !== name ? 0 : 1;
      g.connect(dest);
      out[name] = g;
    }
    return out;
  }

  function outOf(en, name) {
    return (en.buses && en.buses[name]) || en.music;
  }

  function buildPad(en) {
    const c = en.ctx;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1300;
    lp.Q.value = 0.4;
    const pad = c.createGain();
    pad.gain.value = 0.07;
    const lfo = c.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.11;
    const lfoG = c.createGain();
    lfoG.gain.value = 0.008;
    lfo.connect(lfoG);
    lfoG.connect(pad.gain);
    lp.connect(pad);
    pad.connect(outOf(en, 'pad'));
    for (const f of [220, 261.63, 329.63]) {
      const o = c.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const og = c.createGain();
      og.gain.value = 0.34;
      o.connect(og);
      og.connect(lp);
      o.start();
    }
    lfo.start();
  }


  function resumeSync() {
    if (!ctx || ctx.state === 'running') return null;
    let p = null;
    try {
      // строго синхронно внутри обработчика жеста: без await до этой строки
      p = ctx.resume();
    } catch (e) {
      lastError = 'resume: ' + errText(e);
      return null;
    }
    if (p && p.then) {
      p.then(
        () => { lastError = ''; stateAfterGesture = ctx ? ctx.state : 'idle'; updateHint(); },
        (e) => { lastError = 'resume: ' + errText(e); stateAfterGesture = ctx ? ctx.state : 'idle'; updateHint(); }
      );
    }
    return p;
  }

  function primeOutput() {
    if (!ctx) return;
    try {
      if (!zeroBuf || zeroBuf.sampleRate !== ctx.sampleRate) {
        zeroBuf = ctx.createBuffer(1, Math.max(32, Math.floor(ctx.sampleRate * 0.03)), ctx.sampleRate);
      }
      // стандартная разблокировка: проиграть буфер из нулей на running-контексте
      const src = ctx.createBufferSource();
      src.buffer = zeroBuf;
      src.connect(ctx.destination);
      src.onended = dispose([src]);
      src.start(0);
    } catch (e) {
      lastError = 'unlock buffer: ' + errText(e);
    }
  }

  function silentWavUri() {
    if (silentUri) return silentUri;
    const rate = 8000;
    const dataLen = Math.floor(rate * 0.2);      // 0.2 с тишины
    const bytes = new Uint8Array(44 + dataLen);
    const v = new DataView(bytes.buffer);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i); };
    str(0, 'RIFF');
    v.setUint32(4, 36 + dataLen, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, rate, true);
    v.setUint32(28, rate, true);
    v.setUint16(32, 1, true);
    v.setUint16(34, 8, true);
    str(36, 'data');
    v.setUint32(40, dataLen, true);
    bytes.fill(128, 44);                          // 8-bit PCM: 128 = тишина
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    silentUri = 'data:audio/wav;base64,' + btoa(bin);
    return silentUri;
  }

  function ensureSessionEl() {
    if (!sessionEl) sessionEl = document.getElementById('soundloop');
    if (sessionEl && !sessionEl.getAttribute('src')) sessionEl.setAttribute('src', silentWavUri());
    return sessionEl;
  }

  function playSessionEl() {
    const el = ensureSessionEl();
    if (!el || !el.paused) return;
    try {
      // на iOS это переводит аудиосессию в playback и обходит бесшумный переключатель
      const p = el.play();
      if (p && p.catch) p.catch((e) => {
        if (!e || e.name !== 'AbortError') lastError = 'audio el: ' + errText(e);
      });
    } catch (e) {
      if (!e || e.name !== 'AbortError') lastError = 'audio el: ' + errText(e);
    }
  }

  function unlock(source) {
    const now = performance.now();
    // Safari считает активацией не каждый pointerdown: touchend и click
    // всегда проходят полный путь, даже если pointerdown уже был
    const repeat = (source === 'touchend' || source === 'click') && now - lastPointerAt < 700;
    if (source === 'pointerdown' || source === 'keydown') lastPointerAt = now;
    gestureSource = source;
    if (!repeat) {
      unlockAttempts++;
      stateBeforeGesture = ctx ? ctx.state : 'idle';
    }
    if (!ensure()) {
      stateAfterGesture = 'idle';
      updateHint();
      return false;
    }
    setPlaybackSession();
    resumeSync();
    primeOutput();
    playSessionEl();
    stateAfterGesture = ctx.state;
    updateHint();
    return true;
  }

  function resumeOnReturn(source) {
    if (!ctx) return;
    gestureSource = source;
    setPlaybackSession();
    resumeSync();
    if (ctx.state === 'running') {
      primeOutput();
      playSessionEl();
    }
    updateHint();
  }

  function start() {
    if (!ensure()) { updateHint(); return false; }
    if (!started) {
      started = true;
      startedAt = performance.now();
      silentFor = 0;
      lastRmsAt = startedAt;
      nextAt = ctx.currentTime + 0.06;
      timer = setInterval(schedule, 25);
      lastEvent = 'start';
    }
    setPlaybackSession();
    resumeSync();
    if (ctx.state === 'running') {
      const t = ctx.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setTargetAtTime(muted ? 0 : MASTER_LEVEL, t, 0.02);
    } else if (!muted) {
      master.gain.value = MASTER_LEVEL;
    }
    primeOutput();
    playSessionEl();
    schedule();
    updateHint();
    return true;
  }

  function setMuted(v) {
    muted = !!v;
    if (ctx && master) {
      const t = ctx.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setTargetAtTime((muted || !started) ? 0 : MASTER_LEVEL, t, 0.012);
    }
    if (!muted) resumeOnReturn('unmute');
    lastEvent = muted ? 'mute' : 'unmute';
    updateHint();
    return muted;
  }

  function toggleMute() {
    return setMuted(!muted);
  }

  function dispose(nodes) {
    return () => {
      for (const n of nodes) {
        try { n.disconnect(); } catch (_) { /* уже отключён */ }
      }
    };
  }

  /* ---------- ударные и слои ---------- */

  // общий шумовой удар: фильтры + огибающая, всё в шину слоя
  function noiseBurst(en, layer, t, opts) {
    const c = en.ctx;
    const src = c.createBufferSource();
    src.buffer = en.noise;
    const chain = [src];
    let node = src;
    if (opts.hp) {
      const f = c.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = opts.hp;
      f.Q.value = opts.hpQ || 0.7;
      node.connect(f);
      node = f;
      chain.push(f);
    }
    if (opts.bp) {
      const f = c.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = opts.bp;
      f.Q.value = opts.bpQ || 0.9;
      node.connect(f);
      node = f;
      chain.push(f);
    }
    if (opts.pk) {
      const f = c.createBiquadFilter();
      f.type = 'peaking';
      f.frequency.value = opts.pk;
      f.Q.value = opts.pkQ || 1;
      f.gain.value = opts.pkGain || 8;
      node.connect(f);
      node = f;
      chain.push(f);
    }
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(opts.peak, t + (opts.attack || 0.003));
    g.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
    node.connect(g);
    g.connect(opts.dest || outOf(en, layer));
    chain.push(g);
    src.start(t, Math.random() * 0.4);
    src.stop(t + opts.dur + 0.02);
    src.onended = dispose(chain);
  }

  function tone(en, layer, t, type, f0, f1, peak, dur, attack = 0.004) {
    const c = en.ctx;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.7);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(outOf(en, layer));
    o.start(t);
    o.stop(t + dur + 0.02);
    o.onended = dispose([o, g]);
    return o;
  }

  function skipLayer(en, name) {
    return !!(en.solo && en.solo !== name);
  }

  function kick(en, t, vel = 1) {
    if (skipLayer(en, 'kick')) return;
    // тело 240→180 Гц — то, что реально слышно на телефоне
    tone(en, 'kick', t, 'sine', 240, 180, 0.58 * vel, 0.16, 0.003);
    // саб для больших колонок, на телефоне почти не слышен — не основной
    tone(en, 'kick', t, 'sine', 105, 58, 0.3 * vel, 0.24, 0.006);
    // панч 1–2 кГц: атака бочки на маленьком динамике
    noiseBurst(en, 'kick', t, { hp: 1100, bp: 1900, bpQ: 0.8, peak: 0.3 * vel, dur: 0.035 });
  }

  function snare(en, t, vel = 1, ghost = false) {
    if (skipLayer(en, 'snare')) return;
    const k = ghost ? 0.42 : 1;
    noiseBurst(en, 'snare', t, {
      hp: 700, bp: 2000, bpQ: 1.1,
      peak: 0.36 * vel * k, dur: ghost ? 0.09 : 0.17,
    });
    // тело снейра: два тона, чтобы читался не только шипением
    tone(en, 'snare', t, 'triangle', 185, 165, 0.15 * vel * k, ghost ? 0.07 : 0.1);
    tone(en, 'snare', t, 'triangle', 330, 300, 0.09 * vel * k, ghost ? 0.06 : 0.09);
  }

  function clap(en, t, vel = 1) {
    if (skipLayer(en, 'clap')) return;
    // три быстрых хлопка + хвост
    const offs = [0, 0.011, 0.024];
    for (const off of offs) {
      noiseBurst(en, 'clap', t + off, {
        hp: 700, bp: 1600, bpQ: 1.3, peak: 0.36 * vel, dur: 0.055,
      });
    }
    noiseBurst(en, 'clap', t + 0.036, {
      hp: 900, bp: 2100, bpQ: 0.8, peak: 0.22 * vel, dur: 0.17,
    });
  }

  function hatClosed(en, t, vel = 1) {
    if (skipLayer(en, 'hatClosed')) return;
    noiseBurst(en, 'hatClosed', t, {
      hp: 6200, pk: 8600, pkQ: 1.1, pkGain: 9,
      peak: 0.2 * vel, dur: 0.045, attack: 0.0015,
    });
  }

  function hatOpen(en, t, vel = 1) {
    if (skipLayer(en, 'hatOpen')) return;
    noiseBurst(en, 'hatOpen', t, {
      hp: 5800, pk: 8200, pkQ: 0.9, pkGain: 7,
      peak: 0.15 * vel, dur: 0.24, attack: 0.002,
    });
  }

  function shaker(en, t, vel = 1) {
    if (skipLayer(en, 'shaker')) return;
    noiseBurst(en, 'shaker', t, {
      hp: 3400, bp: 6000, bpQ: 0.8,
      peak: 0.24 * vel, dur: 0.06, attack: 0.006,
    });
  }

  function rim(en, t, vel = 1) {
    if (skipLayer(en, 'rim')) return;
    // деревянный римшот: короткий тон + щелчок
    tone(en, 'rim', t, 'square', 1700, 1500, 0.1 * vel, 0.03, 0.001);
    tone(en, 'rim', t, 'square', 2460, 2200, 0.08 * vel, 0.025, 0.001);
    noiseBurst(en, 'rim', t, { hp: 1500, bp: 2600, bpQ: 1.4, peak: 0.11 * vel, dur: 0.025 });
  }

  function tom(en, t, low = 0, vel = 1) {
    if (skipLayer(en, 'tom')) return;
    const f0 = low ? 180 : 255;
    const f1 = low ? 108 : 155;
    tone(en, 'tom', t, 'sine', f0, f1, 0.34 * vel, low ? 0.26 : 0.2, 0.003);
    noiseBurst(en, 'tom', t, { hp: 1200, bp: 1800, peak: 0.09 * vel, dur: 0.03 });
  }

  function bass(en, t, freq, dur = 0.14, vel = 1) {
    if (skipLayer(en, 'bass')) return;
    const c = en.ctx;
    const dest = outOf(en, 'bass');
    // пила с фильтром: гармоники 2f/3f слышны на телефоне, саб — на колонках
    const saw = c.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.setValueAtTime(freq, t);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 3;
    lp.frequency.setValueAtTime(1500, t);
    lp.frequency.exponentialRampToValueAtTime(700, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.17 * vel, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.03);
    saw.connect(lp);
    lp.connect(g);
    g.connect(dest);
    saw.start(t);
    saw.stop(t + dur + 0.05);
    saw.onended = dispose([saw, lp, g]);

    // октава сверху: тело баса в 160–250 Гц
    const tri = c.createOscillator();
    tri.type = 'triangle';
    tri.frequency.setValueAtTime(freq * 2, t);
    const tg = c.createGain();
    tg.gain.setValueAtTime(0.0001, t);
    tg.gain.linearRampToValueAtTime(0.075 * vel, t + 0.01);
    tg.gain.exponentialRampToValueAtTime(0.0001, t + Math.min(dur, 0.18) + 0.03);
    tri.connect(tg);
    tg.connect(dest);
    tri.start(t);
    tri.stop(t + 0.23);
    tri.onended = dispose([tri, tg]);

    tone(en, 'bass', t, 'sine', freq, freq, 0.1 * vel, Math.min(dur, 0.22), 0.008);
  }

  function stab(en, t, vel = 1) {
    if (skipLayer(en, 'stab')) return;
    const c = en.ctx;
    const dest = outOf(en, 'stab');
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2200;
    lp.Q.value = 1.2;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.15 * vel, t + 0.014);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    const oscs = [];
    for (const f of [220, 261.63, 329.63]) {
      for (const det of [-7, 7]) {
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = det;
        o.connect(lp);
        oscs.push(o);
      }
    }
    lp.connect(g);
    g.connect(dest);
    for (const o of oscs) {
      o.start(t);
      o.stop(t + 0.36);
    }
    oscs[0].onended = dispose([...oscs, lp, g]);
  }

  function hookNote(en, t, freq, dur = 0.16, vel = 1) {
    if (skipLayer(en, 'hook')) return;
    tone(en, 'hook', t, 'triangle', freq, freq, 0.15 * vel, dur + 0.05, 0.004);
    tone(en, 'hook', t, 'square', freq, freq, 0.038 * vel, dur, 0.003);
  }

  function crash(en, t, vel = 1) {
    if (skipLayer(en, 'crash')) return;
    noiseBurst(en, 'crash', t, {
      hp: 3200, pk: 7600, pkQ: 0.7, pkGain: 6,
      peak: 0.22 * vel, dur: 0.55, attack: 0.004,
    });
  }

  /* ---------- секвенсор ---------- */

  function stepLen(i) {
    return STEP_BASE * (i % 2 === 0 ? SWING_EVEN : SWING_ODD);
  }

  function barPattern(bar) {
    return Math.floor(bar / 4) % 2 === 0 ? 'A' : 'B';
  }

  function hasStab(bar, seg) {
    return seg === 2 && (bar % 8 === 4 || bar % 8 === 6);
  }

  // какие слои звучат в этом такте — для dbg и честного списка инструментов
  function layersFor(bar, seg) {
    const set = ['kick', 'snare', 'hatClosed', 'pad'];
    const odd = bar % 2 === 1;
    const bip = bar % 4;
    if (bar % 2 === 0) set.push('hook');
    if (seg === 0) {
      if (odd) set.push('hatOpen');
      return set;
    }
    set.push('hatOpen', 'bass');
    if (!odd) set.push('clap', 'shaker');
    else if (seg === 2) set.push('shaker');
    if ((!odd && (bip === 0 || bip === 2)) || (seg === 2 && bip === 3 && bar % 8 !== 7)) set.push('rim');
    if (seg === 2) {
      if (bar % 8 === 0 || bar % 8 === 7) set.push('crash');
      if (bar % 8 === 7) set.push('tom');
      if (hasStab(bar, seg)) set.push('stab');
    }
    return set;
  }

  function scheduleStep(en, i, t) {
    const seg = en.seg == null ? clamp(S.seg, 0, 2) : en.seg;
    const s = i % BAR_STEPS;
    const bar = Math.floor(i / BAR_STEPS);
    const bip = bar % 4;
    const pat = barPattern(bar);
    const fill = bar % 8 === 7;
    const odd = bar % 2 === 1;
    const h = hash(i * 1.73 + bar * 0.37);

    // ---- бочка: тело 180–250 Гц + панч, без опоры на саб
    if (seg === 0) {
      if (s === 0 || s === 8) kick(en, t, 1);
      else if (s === 11 && odd) kick(en, t, 0.7);
    } else {
      const kicks = pat === 'A'
        ? (odd ? KICK_A_SPARSE : KICK_A)
        : (odd ? KICK_B_SPARSE : KICK_B);
      if (kicks.includes(s)) {
        const kv = (s === 0 || s === 8) ? 1 : 0.72;
        kick(en, t, kv * (odd ? 0.85 : 1));
      }
      if (pat === 'B' && bip === 2 && s === 6) kick(en, t, 0.55);
      if (fill && s === 15) kick(en, t, 0.62);
    }

    // ---- снейр с телом и призрачными нотами
    if (s === 4 || s === 12) snare(en, t, 1);
    else if (!fill && (s === 7 || s === 15) && h > 0.5) snare(en, t, 0.34, true);
    else if (!fill && pat === 'B' && s === 14 && h > 0.35) snare(en, t, 0.3, true);
    else if (!fill && odd && s === 14 && h > 0.55) snare(en, t, 0.28, true);
    if (fill && s >= 12) snare(en, t, 0.28 + (s - 12) * 0.16);

    // ---- клэп поверх снейра на 2 и 4: только в полных тактах
    if (seg >= 1 && !odd && (s === 4 || s === 12)) clap(en, t, 0.95);
    else if (seg >= 1 && pat === 'B' && bip === 1 && s === 15 && h > 0.45) clap(en, t, 0.4);

    // ---- закрытые хэты: двор — восьмые, полные такты — шестнадцатые
    if (seg === 0) {
      if (s % 2 === 0) hatClosed(en, t, s % 4 === 0 ? 0.9 : 0.55);
    } else if (!odd) {
      if (s % 4 === 0) hatClosed(en, t, 1);
      else if (s % 2 === 0) hatClosed(en, t, 0.7);
      else hatClosed(en, t, 0.45);
    } else if (s % 2 === 0) {
      hatClosed(en, t, (s % 4 === 0 ? 1 : 0.62) * 0.7);
    }
    if (seg === 2 && odd && pat === 'B' && h > 0.3) hatClosed(en, t, 0.3);
    const openStep = pat === 'A' ? (odd ? 6 : 14) : (odd ? 14 : 6);
    if (s === openStep && (seg >= 1 || odd)) hatOpen(en, t, 0.9);

    // ---- перкуссия: полные такты плотнее, разреженные дышат
    if (seg >= 1) {
      if (!odd) shaker(en, t, s % 4 === 2 ? 0.75 : 0.5);
      else if (seg === 2 && s % 4 === 3) shaker(en, t, 0.35);
      const rimStep = pat === 'A' ? 2 : 10;
      if (!odd && (bip === 0 || bip === 2) && s === rimStep) rim(en, t, 0.8);
      if (seg === 2 && bip === 3 && s === 5 && !fill) rim(en, t, 0.55);
    }
    if (seg >= 1 && fill && s >= 12) tom(en, t, s % 2 === 0 ? 0 : 1, 0.85);
    else if (seg === 2 && bip === 2 && !fill && (s === 14 || s === 15) && h > 0.45) {
      tom(en, t, s === 14 ? 0 : 1, 0.45);
    }

    // ---- бас: 2–3 ноты на такт, ход по корню/квинте/октаве
    if (seg >= 1) {
      const root = BASS_ROOTS[bar % 4];
      const notes = (pat === 'A' ? BASS_A : BASS_B)[bip];
      for (const n of notes) {
        if (n[0] === s) bass(en, t, root * n[1], n[2], n[3]);
      }
    }

    // ---- хук: короткая фраза раз в 2 такта
    if (bar % 2 === 0) {
      const hook = pat === 'A' ? HOOK_A : HOOK_B;
      for (const n of hook) {
        if (n[0] === s) hookNote(en, t, n[1], n[2], n[3]);
      }
    }

    // ---- редкие аккордовые стабы и краши в городе
    if (hasStab(bar, seg) && ((bar % 8 === 4 && s === 8) || (bar % 8 === 6 && s === 10))) {
      stab(en, t, 0.9);
    }
    if (seg === 2 && bar % 8 === 0 && s === 0) crash(en, t, 1);
    if (seg === 2 && bar % 8 === 7 && s === 8) crash(en, t, 0.5);
  }

  function schedule() {
    if (!ctx || !started || ctx.state !== 'running') return;
    const horizon = ctx.currentTime + 0.18;
    let guard = 0;
    while (nextAt < horizon && guard < 40) {
      // после фонового таба не выстреливаем пачкой в прошлое
      if (nextAt < ctx.currentTime - 0.08) nextAt = ctx.currentTime + 0.01;
      scheduleStep(LIVE, step, nextAt);
      nextAt += stepLen(step);
      step++;
      guard++;
    }
  }

  /* ---------- эффекты ---------- */

  function siren(dur = 2.6, level = 1) {
    lastEvent = 'siren';
    if (!ensure() || !ctx || ctx.state !== 'running') return false;
    const now = ctx.currentTime;
    if (now < sirenUntil - 0.15) return false; // не накладываем две сирены
    sirenUntil = now + dur;
    const t = now + 0.02;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.linearRampToValueAtTime(0.34 * level, t + 0.1);
    out.gain.setValueAtTime(0.34 * level, t + Math.max(0.12, dur - 0.3));
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2100;
    lp.Q.value = 0.8;

    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    const sq = ctx.createOscillator();
    sq.type = 'square';
    const sqg = ctx.createGain();
    sqg.gain.value = 0.34;
    for (const o of [saw, sq]) {
      o.frequency.setValueAtTime(690, t);
      for (let when = t + 0.27, k = 1; when < t + dur - 0.05; when += 0.27, k++) {
        o.frequency.linearRampToValueAtTime(k % 2 ? 920 : 690, when);
      }
    }
    saw.connect(lp);
    sq.connect(sqg);
    sqg.connect(lp);
    lp.connect(out);
    out.connect(sfx);
    saw.start(t);
    sq.start(t);
    saw.stop(t + dur + 0.02);
    sq.stop(t + dur + 0.02);
    saw.onended = dispose([saw, sq, sqg, lp, out]);
    return true;
  }

  function woop(level = 1) {
    lastEvent = 'woop';
    if (!ensure() || !ctx || ctx.state !== 'running') return false;
    const t = ctx.currentTime + 0.01;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(420, t);
    o.frequency.exponentialRampToValueAtTime(980, t + 0.16);
    o.frequency.exponentialRampToValueAtTime(380, t + 0.42);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 950;
    bp.Q.value = 1.1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.28 * level, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    o.connect(bp);
    bp.connect(g);
    g.connect(sfx);
    o.start(t);
    o.stop(t + 0.46);
    o.onended = dispose([o, bp, g]);
    return true;
  }

  function warning() {
    woop(0.9);
    siren(2.6, 1);
  }

  function granny() {
    lastEvent = 'granny';
    if (!ensure() || !ctx || ctx.state !== 'running') return false;
    const t = ctx.currentTime + 0.01;

    // «Ай!»: пила с падением высоты и вибрато, две форманты
    const voice = ctx.createOscillator();
    voice.type = 'sawtooth';
    voice.frequency.setValueAtTime(430, t);
    voice.frequency.linearRampToValueAtTime(560, t + 0.09);
    voice.frequency.exponentialRampToValueAtTime(215, t + 0.7);

    const vib = ctx.createOscillator();
    vib.type = 'sine';
    vib.frequency.value = 6.4;
    const vibG = ctx.createGain();
    vibG.gain.value = 16;
    vib.connect(vibG);
    vibG.connect(voice.frequency);

    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.value = 700;
    f1.Q.value = 6;
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.value = 1200;
    f2.Q.value = 8;
    const f2g = ctx.createGain();
    f2g.gain.value = 0.85;
    const mix = ctx.createGain();
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.65, t + 0.03);
    g.gain.setValueAtTime(0.65, t + 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.82);
    voice.connect(f1);
    voice.connect(f2);
    f2.connect(f2g);
    f1.connect(mix);
    f2g.connect(mix);
    mix.connect(g);
    g.connect(sfx);
    voice.start(t);
    vib.start(t);
    voice.stop(t + 0.84);
    vib.stop(t + 0.84);
    voice.onended = dispose([voice, vib, vibG, f1, f2, f2g, mix, g]);

    // короткое ворчание ниже — «…чтоб тебя», заходит под крик без провала
    const low = ctx.createOscillator();
    low.type = 'sawtooth';
    low.frequency.setValueAtTime(128, t + 0.34);
    low.frequency.exponentialRampToValueAtTime(92, t + 0.78);
    const lf1 = ctx.createBiquadFilter();
    lf1.type = 'bandpass';
    lf1.frequency.value = 320;
    lf1.Q.value = 5;
    const lf2 = ctx.createBiquadFilter();
    lf2.type = 'bandpass';
    lf2.frequency.value = 620;
    lf2.Q.value = 6;
    const lg = ctx.createGain();
    lg.gain.setValueAtTime(0.0001, t + 0.34);
    lg.gain.linearRampToValueAtTime(0.26, t + 0.39);
    lg.gain.exponentialRampToValueAtTime(0.0001, t + 0.86);
    low.connect(lf1);
    low.connect(lf2);
    lf1.connect(lg);
    lf2.connect(lg);
    lg.connect(sfx);
    low.start(t + 0.34);
    low.stop(t + 0.88);
    low.onended = dispose([low, lf1, lf2, lg]);
    return true;
  }

  /* ---------- салют ---------- */

  const FIREWORK_BOOMS = [0.55, 1.9, 3.25];   // залпы относительно запуска

  function duckMusicFor(launchT) {
    if (!ctx || !music) return;
    const g = music.gain;
    const duck = MUSIC_LEVEL * Math.pow(10, DUCK_DB / 20);
    const now = ctx.currentTime;
    g.cancelScheduledValues(Math.max(now, launchT - 0.02));
    for (const b of FIREWORK_BOOMS) {
      const t = launchT + b;
      // 3.5 дБ вниз на залп, возврат за ~0.7 с
      g.setTargetAtTime(duck, t, 0.05);
      g.setTargetAtTime(MUSIC_LEVEL, t + 0.62, 0.1);
    }
    duckDb = DUCK_DB;
    const until = launchT + FIREWORK_BOOMS[FIREWORK_BOOMS.length - 1] + 1.05;
    duckUntil = performance.now() + Math.max(0, until - now) * 1000;
  }

  function fireworkRocket(en, t, level) {
    const c = en.ctx;
    const o = c.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(420, t);
    o.frequency.exponentialRampToValueAtTime(1750, t + 0.5);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1200;
    bp.Q.value = 1.4;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.055 * level, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    o.connect(bp);
    bp.connect(g);
    g.connect(en.sfx);
    o.start(t);
    o.stop(t + 0.57);
    o.onended = dispose([o, bp, g]);

    noiseBurst(en, null, t, {
      dest: en.sfx, hp: 900, bp: 1800, bpQ: 0.9,
      peak: 0.028 * level, dur: 0.5, attack: 0.05,
    });
  }

  function fireworkBoom(en, t, level) {
    const c = en.ctx;
    const dest = en.sfx;
    // низкий «бум»: пила даёт гармоники, которые слышит телефонный динамик
    const saw = c.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.setValueAtTime(95, t);
    saw.frequency.exponentialRampToValueAtTime(42, t + 0.5);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    lp.Q.value = 1.2;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.4 * level, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    saw.connect(lp);
    lp.connect(g);
    g.connect(dest);
    saw.start(t);
    saw.stop(t + 0.62);
    saw.onended = dispose([saw, lp, g]);

    // тело бума в 150–300 Гц: то, что слышно на динамике телефона
    const body = c.createOscillator();
    body.type = 'triangle';
    body.frequency.setValueAtTime(260, t);
    body.frequency.exponentialRampToValueAtTime(110, t + 0.4);
    const bg = c.createGain();
    bg.gain.setValueAtTime(0.0001, t);
    bg.gain.linearRampToValueAtTime(0.2 * level, t + 0.006);
    bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    body.connect(bg);
    bg.connect(dest);
    body.start(t);
    body.stop(t + 0.47);
    body.onended = dispose([body, bg]);

    // саб-синус тоже в sfx, а не в музыкальную шину
    const sub = c.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(72, t);
    sub.frequency.exponentialRampToValueAtTime(38, t + 0.4);
    const sg = c.createGain();
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.linearRampToValueAtTime(0.26 * level, t + 0.008);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    sub.connect(sg);
    sg.connect(dest);
    sub.start(t);
    sub.stop(t + 0.57);
    sub.onended = dispose([sub, sg]);
    // воздушный хлопок
    noiseBurst(en, null, t, {
      dest, hp: 220, bp: 900, bpQ: 0.6,
      peak: 0.28 * level, dur: 0.32, attack: 0.004,
    });
  }

  function fireworkCrackle(en, t, level, seed) {
    const grains = 12;
    for (let k = 0; k < grains; k++) {
      const h1 = hash(seed + k * 1.7);
      const h2 = hash(seed * 3.1 + k * 2.3);
      const at = t + 0.06 + (k / grains) * 1.0 + h1 * 0.05;
      noiseBurst(en, null, at, {
        dest: en.sfx,
        hp: 2400,
        bp: 4200 + h2 * 2600,
        bpQ: 1.6,
        peak: (0.045 + 0.07 * h1) * level,
        dur: 0.018 + 0.03 * h2,
        attack: 0.001,
      });
    }
  }

  function fireworksAt(en, launchT, level) {
    for (let i = 0; i < FIREWORK_BOOMS.length; i++) {
      const bt = launchT + FIREWORK_BOOMS[i];
      fireworkRocket(en, bt - 0.55, level);
      fireworkBoom(en, bt, level);
      fireworkCrackle(en, bt + 0.06, level, i * 13 + 5);
    }
    return FIREWORK_BOOMS[FIREWORK_BOOMS.length - 1] + 1.35;
  }

  function fireworks(level = 1) {
    lastEvent = 'firework';
    if (!ensure() || !ctx || ctx.state !== 'running') return false;
    // залпы поверх музыки, но в шине sfx: бит не глушится
    const launchT = ctx.currentTime + 0.2;
    lastFireworkDur = Math.round(fireworksAt(LIVE, launchT, level) * 100) / 100;
    duckMusicFor(launchT);
    return true;
  }

  /* ---------- замер и отладка ---------- */

  function rms() {
    if (!analyser) return 0;
    let sum = 0;
    if (analyser.getFloatTimeDomainData) {
      analyser.getFloatTimeDomainData(buf);
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i];
        sum += v * v;
      }
      return Math.sqrt(sum / buf.length);
    }
    const b = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(b);
    for (let i = 0; i < b.length; i++) {
      const v = (b[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / b.length);
  }

  function peak() {
    if (!analyser) return 0;
    let max = 0;
    if (analyser.getFloatTimeDomainData) {
      analyser.getFloatTimeDomainData(buf);
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i]);
        if (v > max) max = v;
      }
      return max;
    }
    const b = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(b);
    for (let i = 0; i < b.length; i++) {
      const v = Math.abs((b[i] - 128) / 128);
      if (v > max) max = v;
    }
    return max;
  }

  /* ---------- офлайн-замер: соло слоёв, такты, полосы, пик ---------- */

  function monoMix(buffer) {
    const n = buffer.length;
    const out = new Float32Array(n);
    const chs = buffer.numberOfChannels;
    for (let ch = 0; ch < chs; ch++) {
      const d = buffer.getChannelData(ch);
      for (let i = 0; i < n; i++) out[i] += d[i] / chs;
    }
    return out;
  }

  function rmsRange(data, from, to) {
    let sum = 0;
    let n = 0;
    for (let i = Math.max(0, from); i < Math.min(data.length, to); i++) {
      sum += data[i] * data[i];
      n++;
    }
    return n ? Math.sqrt(sum / n) : 0;
  }

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang);
      const wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1;
        let ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ar = re[i + k];
          const ai = im[i + k];
          const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ar + br;
          im[i + k] = ai + bi;
          re[i + k + len / 2] = ar - br;
          im[i + k + len / 2] = ai - bi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
  }

  function spectrumShare(data, sr) {
    const N = 2048;
    const half = N / 2;
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    const pow = new Float64Array(half + 1);
    const win = new Float64Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    for (let start = 0; start + N <= data.length; start += N) {
      for (let i = 0; i < N; i++) {
        re[i] = data[start + i] * win[i];
        im[i] = 0;
      }
      fft(re, im);
      for (let k = 0; k <= half; k++) pow[k] += re[k] * re[k] + im[k] * im[k];
    }
    let low = 0, mid = 0, high = 0, total = 0;
    for (let k = 1; k <= half; k++) {
      const f = k * sr / N;
      if (f < 20 || f > 20000) continue;
      const p = pow[k];
      total += p;
      if (f < 200) low += p;
      else if (f <= 8000) mid += p;
      else high += p;
    }
    return {
      share200_8k: +(mid / total).toFixed(4),
      shareLow: +(low / total).toFixed(4),
      shareHigh: +(high / total).toFixed(4),
    };
  }

  async function renderPiece(opts) {
    const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OC) throw new Error('OfflineAudioContext недоступен');
    const sr = opts.sampleRate || 44100;
    const bars = Math.max(1, Math.min(32, opts.bars || 8));
    const seg = opts.seg == null ? clamp(S.seg, 0, 2) : opts.seg;
    const barDur = BAR_STEPS * STEP_BASE;
    const dur = bars * barDur + 1.9;
    const oc = new OC(1, Math.ceil(dur * sr), sr);
    const fullGraph = opts.fullGraph !== false;
    const musicGain = oc.createGain();
    musicGain.gain.value = opts.musicMuted ? 0 : MUSIC_LEVEL;
    const sfxGain = oc.createGain();
    sfxGain.gain.value = SFX_LEVEL;
    if (fullGraph) {
      const masterGain = oc.createGain();
      masterGain.gain.value = MASTER_LEVEL;
      const compNode = oc.createDynamicsCompressor();
      compNode.threshold.value = -14;
      compNode.knee.value = 8;
      compNode.ratio.value = 5;
      compNode.attack.value = 0.004;
      compNode.release.value = 0.18;
      musicGain.connect(masterGain);
      sfxGain.connect(masterGain);
      masterGain.connect(compNode);
      compNode.connect(oc.destination);
    } else {
      musicGain.connect(oc.destination);
      sfxGain.connect(oc.destination);
    }
    const en = {
      ctx: oc,
      music: musicGain,
      sfx: sfxGain,
      buses: buildBuses(oc, musicGain, opts.solo || null),
      noise: makeNoise(oc),
      seg,
      solo: opts.solo || null,
    };
    if (!opts.solo || opts.solo === 'pad') buildPad(en);
    if (opts.fireworks) fireworksAt(en, 0.2, 1);

    let at = 0.05;
    for (let i = 0; i < bars * BAR_STEPS; i++) {
      scheduleStep(en, i, at);
      at += stepLen(i);
    }

    const rendered = await oc.startRendering();
    const mono = monoMix(rendered);
    let peak = 0;
    for (let i = 0; i < mono.length; i++) {
      const v = Math.abs(mono[i]);
      if (v > peak) peak = v;
    }
    if (opts.solo) {
      return { bars, seg, peak: +peak.toFixed(4), rms: +rmsRange(mono, 0, mono.length).toFixed(5) };
    }
    const barRms = [];
    for (let b = 0; b < bars; b++) {
      const from = Math.round((0.05 + b * barDur) * sr);
      const to = Math.round((0.05 + (b + 1) * barDur) * sr);
      barRms.push(+rmsRange(mono, from, to).toFixed(5));
    }
    const diffs = [];
    for (let b = 1; b < barRms.length; b++) {
      const a = barRms[b - 1];
      const c = barRms[b];
      diffs.push(+((Math.abs(a - c) / Math.max(a, c, 1e-9)) * 100).toFixed(1));
    }
    let fireworkDur = 0;
    if (opts.fireworks) {
      let last = 0;
      for (let i = 0; i < mono.length; i++) if (Math.abs(mono[i]) > 0.0015) last = i;
      fireworkDur = +(last / sr - 0.2).toFixed(2);
    }
    return {
      bars,
      seg,
      peak: +peak.toFixed(4),
      rms: +rmsRange(mono, 0, mono.length).toFixed(5),
      barRms,
      diffs,
      pairsOver15: diffs.filter((d) => d >= 15).length,
      spectrum: spectrumShare(mono, sr),
      fireworkDur,
      samples: mono.length,
    };
  }

  // Полный замер: микс, вариативность тактов, полосы и соло каждого слоя.
  async function offline(opts = {}) {
    const bars = Math.max(1, Math.min(32, opts.bars || 8));
    const seg = opts.seg == null ? clamp(S.seg, 0, 2) : opts.seg;
    const mix = await renderPiece({ bars, seg, fullGraph: true });
    const union = new Set();
    for (let b = 0; b < bars; b++) for (const name of layersFor(b, seg)) union.add(name);
    const out = { ...mix, instruments: LAYERS.filter((n) => union.has(n)) };
    if (opts.solos !== false) {
      const soloRms = {};
      const soloBars = bars;
      for (const name of LAYERS) {
        const one = await renderPiece({ bars: soloBars, seg, solo: name, fullGraph: false });
        soloRms[name] = one.rms;
      }
      out.soloRms = soloRms;
      out.audible = Object.keys(soloRms).filter((k) => soloRms[k] >= 0.0015);
      out.audibleCount = out.audible.length;
    }
    if (opts.fireworks) {
      const fw = await renderPiece({ bars: 1, seg, fireworks: true, musicMuted: true, fullGraph: true });
      out.fireworks = {
        duration: fw.fireworkDur,
        peak: fw.peak,
        rms: fw.rms,
        spectrum: fw.spectrum,
      };
    }
    return out;
  }

  /* ---------- подсказка о звуке ---------- */

  function hintNode() {
    if (!hintEl) hintEl = document.getElementById('soundhint');
    return hintEl;
  }

  function updateHint() {
    const el = hintNode();
    if (!el) return;
    const startEl = document.getElementById('start');
    const atStart = !!startEl && !startEl.classList.contains('hidden');
    if (atStart !== hintStart) {
      hintStart = atStart;
      el.classList.toggle('atstart', atStart);
    }
    let text = '';
    let bad = false;
    if (muted) {
      text = 'ЗВУК ВЫКЛ\nнажми «ЗВУК ВКЛ» в правом верхнем углу';
    } else if (!ctx) {
      text = started
        ? 'ЗВУК НЕДОСТУПЕН\nбраузер не дал создать WebAudio'
        : 'ЗВУК: ЖДЁМ КАСАНИЯ\nтапни по экрану или нажми пробел';
      bad = started;
    } else if (ctx.state !== 'running') {
      text = started
        ? 'НАЖМИ ЕЩЁ РАЗ ДЛЯ ЗВУКА\nбраузер не запустил звук с первого касания'
        : 'ЗВУК: ЖДЁМ КАСАНИЯ\nтапни по экрану или нажми пробел';
      bad = true;
    } else if (silentFor >= 2) {
      text = 'ТИХИЙ РЕЖИМ ИЛИ ВЫКЛЮЧЕН ЗВУК\nпроверь переключатель звука на телефоне';
      bad = true;
    }
    if (text !== hintText) {
      el.textContent = text;
      hintText = text;
    }
    const on = text !== '';
    if (on !== hintOn) {
      hintOn = on;
      el.classList.toggle('on', on);
    }
    if (bad !== hintBad) {
      hintBad = bad;
      el.classList.toggle('bad', bad);
    }
  }

  // вызывается из кадра, не чаще 4 раз в секунду
  function tick(now) {
    if (now - lastTickAt < 250) return;
    lastTickAt = now;
    if (!ctx || !started || muted || document.hidden || ctx.state !== 'running') {
      silentFor = 0;
      lastRmsAt = now;
      updateHint();
      return;
    }
    const dt = Math.min(1, Math.max(0, (now - lastRmsAt) / 1000));
    lastRmsAt = now;
    if (rms() >= 0.004) silentFor = 0;
    else silentFor += dt;
    updateHint();
  }

  function dbg() {
    const segNow = clamp(S.seg, 0, 2);
    const barNow = Math.floor(step / BAR_STEPS);
    return {
      state: ctx ? ctx.state : 'idle',
      sampleRate: ctx ? ctx.sampleRate : 0,
      sessionType: sessionType(),
      unlockAttempts,
      lastError,
      gestureSource,
      contextCount,
      stateBeforeGesture,
      stateAfterGesture,
      started,
      runningFor: started ? Math.round((performance.now() - startedAt) / 100) / 10 : 0,
      silentFor: Math.round(silentFor * 10) / 10,
      master: (muted || !started) ? 0 : MASTER_LEVEL,
      music: MUSIC_LEVEL,
      sfx: SFX_LEVEL,
      musicGain: music ? Math.round(music.gain.value * 1000) / 1000 : 0,
      ducking: performance.now() < duckUntil,
      duckDb: performance.now() < duckUntil ? duckDb : 0,
      lastFireworkDur,
      muted,
      bpm: BPM,
      step,
      bar: barNow,
      barPattern: barPattern(barNow),
      instruments: layersFor(barNow, segNow),
      lastEvent,
    };
  }

  // жесты: создание/резюм строго синхронно в обработчике первого касания
  window.addEventListener('pointerdown', () => unlock('pointerdown'), true);
  window.addEventListener('touchend', () => unlock('touchend'), true);
  window.addEventListener('click', () => unlock('click'), true);
  window.addEventListener('keydown', (e) => { if (!e.repeat) unlock('keydown'); }, true);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) resumeOnReturn('visibilitychange');
  });
  window.addEventListener('pageshow', () => resumeOnReturn('pageshow'));

  return {
    start, setMuted, toggleMute, isMuted: () => muted,
    rms, peak, dbg, tick, unlock, context: () => ctx,
    offline, layers: LAYERS.slice(),
    sfx: { siren, woop, warning, granny, fireworks },
  };
})();

/* ---------- кнопка звука в HUD ---------- */
const sndEl = document.getElementById('snd');
function syncSndUI() {
  const m = audio.isMuted();
  sndEl.textContent = m ? 'ЗВУК ВЫКЛ' : 'ЗВУК ВКЛ';
  sndEl.setAttribute('aria-pressed', m ? 'true' : 'false');
  sndEl.setAttribute('aria-label', m ? 'Включить звук' : 'Выключить звук');
}
sndEl.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  audio.toggleMute();
  syncSndUI();
});
syncSndUI();

/* ---------- HUD ---------- */
const clockEl = document.getElementById('clock');
const moodPctEl = document.getElementById('moodpct');
const moodFillEl = document.getElementById('moodfill');
const captionEl = document.getElementById('caption');
const subEl = document.getElementById('sub');
const segEl = document.getElementById('seg');
const speedValEl = document.getElementById('speedval');
const warnEl = document.getElementById('warn');
const turnEl = document.getElementById('turn');
const invertEl = document.getElementById('invert');
const invertSEl = document.getElementById('inverts');
const brakepadEl = document.getElementById('brakepad');

let lastClockText = '';
let lastMoodText = '';
let lastSegText = '';

const CAP_MIN = 2.5;      // каждая подпись видна не меньше 2.5 с независимо от новых
const CAP_QUEUE_MAX = 3;  // больше не копим: важное вытесняет мелочь

function say(text, dur = 3.4, important = false) {
  const item = { text, dur: Math.max(CAP_MIN, dur), prio: important ? 2 : 1 };
  if (S.capQueue.length >= CAP_QUEUE_MAX) {
    let lowIdx = -1;
    for (let i = S.capQueue.length - 1; i >= 0; i--) {
      if (S.capQueue[i].prio === 1) { lowIdx = i; break; }
    }
    if (item.prio === 2) {
      // важное вытесняет мелочь, иначе самую старую
      if (lowIdx >= 0) S.capQueue.splice(lowIdx, 1);
      else S.capQueue.shift();
    } else {
      // мелочь клеим к последней мелочи, а если её нет — выбрасываем
      const last = S.capQueue[S.capQueue.length - 1];
      if (last.prio === 1) {
        last.text += '\n' + text;
        last.dur = Math.max(last.dur, item.dur);
      }
      return;
    }
  }
  S.capQueue.push(item);
}

function showNextCaption() {
  const c = S.capQueue.shift();
  captionEl.textContent = c.text;
  captionEl.classList.add('on');
  S.capTimer = c.dur;
}

function tickCaptions(dt) {
  if (S.capTimer > 0) {
    S.capTimer -= dt;
    if (S.capTimer > 0) return;
    S.capTimer = 0;
    if (S.capQueue.length) showNextCaption();
    else captionEl.classList.remove('on');
  } else if (S.capQueue.length) {
    showNextCaption();
  }
}

/* подсказка управления живёт только до первого реального ввода */
function showControlHint() {
  if (S.hintUsed || S.phase !== 'play') return;
  S.controlHintOn = true;
  subEl.textContent = IS_COARSE() ? 'руль — половины экрана · тормоз — держи низ' : '← → руль · ↓ тормоз';
  subEl.classList.add('on');
}

function markControlUsed() {
  if (S.hintUsed) return;
  S.hintUsed = true;
  if (S.controlHintOn) {
    S.controlHintOn = false;
    subEl.classList.remove('on');
    subEl.textContent = '';
  }
}

function fmtClock(seconds) {
  const total = 18 * 3600 + 52 * 60 + Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600) % 24;
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function updateHUD() {
  const ct = fmtClock(Math.min(S.clock, CLOCK_MAX));
  if (ct !== lastClockText) {
    clockEl.textContent = ct;
    lastClockText = ct;
    clockEl.classList.toggle('late', S.clock > 400);
  }
  const mt = Math.round(S.mood) + '%';
  if (mt !== lastMoodText) {
    moodPctEl.textContent = mt;
    moodFillEl.style.width = clamp(S.mood, 0, 100) + '%';
    lastMoodText = mt;
  }
  const st = `ОТРЕЗОК ${S.seg + 1}/3 · ${SEGMENTS[S.seg].name}`;
  if (st !== lastSegText) {
    segEl.textContent = st;
    lastSegText = st;
  }
  if (speedValEl) speedValEl.textContent = String(Math.round(S.speed * 2.2));
  if (S.invert > 0) {
    invertEl.classList.add('on');
    invertSEl.textContent = S.invert.toFixed(1);
  } else {
    invertEl.classList.remove('on');
  }
  if (warnEl) warnEl.classList.toggle('on', S.warnT > 0);
  if (brakepadEl) {
    brakepadEl.classList.toggle('on', S.phase === 'play');
    brakepadEl.classList.toggle('braking', S.phase === 'play' && !!S.braking);
  }
  if (turnEl) {
    turnEl.classList.toggle('on', S.turnT > 0);
    if (S.curvNow !== undefined && S.turnT > 0) {
      turnEl.textContent = S.curvNow > 0 ? 'ПОВОРОТ ↓ →' : 'ПОВОРОТ ↓ ←';
    }
  }
}

/* =====================================================================
   ОТРЕЗКИ
   ===================================================================== */

let obCycle = 0;
const OB_BAG = ['pothole', 'brick', 'manhole', 'puddle', 'chickens', 'hump', 'granny', 'gazelle', 'oncoming'];

/* расстановка препятствий: каждые 120–200 единиц, первые 20 секунд реже */
function spawnObstacles(fromP, toP) {
  let p = fromP + 150;
  while (p < toP - 140) {
    // не ставим препятствие в точку, где невеста выбегает на дорогу
    if (Math.abs(p - BRIDE_P) < 220) p += 240;
    const type = OB_BAG[obCycle % OB_BAG.length];
    obCycle++;
    const meta = OB_META[type];
    let lat = pick([-LANE, 0, LANE]) + rnd(-0.35, 0.35);
    if (type === 'granny' || type === 'chickens') lat = rnd(-2.6, 2.6);
    if (type === 'oncoming') lat = pick([-LANE, 0]);
    const obj = OB_BUILDERS[type]();
    const op = type === 'oncoming' ? p + 140 : p;
    obj.position.set(worldX(op, lat), 0, -op);
    if (type === 'chickens' || type === 'granny') obj.rotation.y = rnd(-0.4, 0.4);
    dynGroup.add(obj);
    obstacles.push({ type, p: op, lat, obj, hit: false, touched: false });
    p += p < 900 ? rnd(250, 350) : rnd(120, 200);
  }
  // следующий отрезок начинает с другого типа
  obCycle += 2;
}

function buildSegment(i) {
  clearDyn();
  if (i === 0) buildSegYard();
  else if (i === 1) buildSegHighway();
  else buildSegCity();
  spawnObstacles(SEGMENTS[i].start, SEGMENTS[i].end);
  // щиты «ПОВОРОТ» перед каждым изгибом отрезка
  for (const b of BENDS) {
    if (b.start < SEGMENTS[i].start - 400 || b.start > SEGMENTS[i].end + 400) continue;
    const sgn = makeSign(b.dir > 0 ? 'ПОВОРОТ →' : '← ПОВОРОТ', 3.2, 1.1);
    const g = new THREE.Group();
    cyl(g, 0.1, 0.1, 3.0, 6, 0x5b5b5f, 0, 1.5, 0);
    sgn.position.y = 2.9;
    sgn.rotation.y = -0.5;
    g.add(sgn);
    const sp = b.start - 90;
    g.position.set(worldX(sp, 7.4), 0, -sp);
    dynGroup.add(g);
  }
}

/* ---------- 1. ДВОР ---------- */
function buildSegYard() {
  const start = SEGMENTS[0].start;

  const cow = makeCow();
  cow.position.set(worldX(COW_P, LANES[0]), 0, -COW_P);
  cow.rotation.y = -0.375;
  dynGroup.add(cow);
  colliders.push({ obj: cow, hw: 1.1, hl: 1.5, kind: 'cow' });
  E.cow = cow;

  const mow = makeLawnmower();
  mow.position.set(worldX(MOWER_P, -(ROAD_HALF + 1.5)), 0, -MOWER_P);
  mow.rotation.y = Math.PI;
  dynGroup.add(mow);
  colliders.push({ obj: mow, hw: 1.0, hl: 1.3, kind: 'mower' });
  E.mower = { obj: mow, arm: mow.userData.armR, z: mow.position.z };

  // невеста голосует уже в первом отрезке — в первой трети маршрута
  const bride = makeBride();
  bride.position.set(worldX(BRIDE_P, 7.6), 0, -BRIDE_P);
  bride.rotation.y = Math.PI / 2;
  dynGroup.add(bride);
  E.bride = { obj: bride, state: 'wait', z: bride.position.z, t: 0 };

  // велосипед у забора
  const bike = new THREE.Group();
  for (const sz of [-0.4, 0.4]) {
    const w = new THREE.Mesh(torusGeo(0.3, 0.05), mat(0x2c2c30));
    w.position.set(0, 0.32, sz);
    w.rotation.y = Math.PI / 2;
    bike.add(w);
  }
  box(bike, 0.08, 0.08, 0.9, 0x8a3a3a, 0, 0.62, 0);
  bike.position.set(worldX(start + 430, -7.4), 0, -(start + 430));
  dynGroup.add(bike);
}

/* ---------- 2. ШОССЕ ---------- */
function buildSegHighway() {
  const start = SEGMENTS[1].start;

  // голубь
  const pigeon = makePigeon();
  pigeon.visible = false;
  dynGroup.add(pigeon);
  E.pigeon = { obj: pigeon, state: 'hidden', f: 0, from: new THREE.Vector3(), inflight: false };

  // дорожные работы (декор)
  const cone = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const c = new THREE.Mesh(coneGeo(), mat(0xd0703a));
    c.position.set(-4.4 + i * 0.9, 0.3, -i * 1.2);
    cone.add(c);
  }
  cone.position.set(worldX(start + 200, 0), 0, -(start + 200));
  dynGroup.add(cone);
}

/* ---------- 3. ГОРОД ---------- */
function buildSegCity() {
  const start = SEGMENTS[2].start;

  // трактор
  const tractor = makeTractor();
  tractor.position.set(worldX(start + 470, LANES[2]), 0, -(start + 470));
  dynGroup.add(tractor);
  colliders.push({ obj: tractor, hw: 1.5, hl: 2.3, kind: 'tractor' });
  E.tractor = tractor;

  // похороны
  const funeralZ = -CITY_FUNERAL_P;
  const fg = new THREE.Group();
  fg.position.z = funeralZ;
  fg.position.x = roadOff(CITY_FUNERAL_P);
  const mourners = [];
  const xs = [-3.6, -1.3, 1.0, 3.4];
  for (let i = 0; i < xs.length; i++) {
    const m = makePerson({
      shirt: 0x2c2a30,
      pants: 0x22222a,
      hair: 0x2a2420,
      skin: 0xc9a68c,
      scale: rnd(0.92, 1.05),
    });
    m.position.set(xs[i], 0, rnd(-0.6, 0.6));
    m.rotation.y = Math.PI + rnd(-0.4, 0.4);
    fg.add(m);
    mourners.push({ obj: m, x0: xs[i], dir: xs[i] < 0 ? -1 : 1 });
  }
  // гроб
  const coffin = box(fg, 0.6, 0.55, 1.9, 0x4a2028, 0, 0.85, -1.4);
  coffin.rotation.y = Math.PI / 2;
  // венок
  const ring = new THREE.Mesh(torusGeo2(0.5, 0.12), mat(0x3f5a35));
  ring.position.set(2.4, 1.2, -1.6);
  fg.add(ring);
  // грузовик на обочине
  const truck = new THREE.Group();
  box(truck, 1.9, 1.6, 3.4, 0x6a7078, 0, 1.1, 0);
  box(truck, 1.8, 0.9, 1.5, 0x59606a, 0, 1.4, -2.2);
  box(truck, 1.6, 0.1, 1.2, 0xd8d2c4, 0, 1.95, -2.2);
  truck.position.set(7.4, 0, -1.5);
  fg.add(truck);
  dynGroup.add(fg);
  E.funeral = {
    group: fg,
    z: funeralZ,
    zoneStart: CITY_FUNERAL_P - 35,
    zoneEnd: CITY_FUNERAL_P + 345,
    stopped: 0,
    done: false,
    paid: false,
    mourners,
  };

  // перекрёсток: полосы перехода
  for (let i = 0; i < 7; i++) {
    const cx = worldX(CITY_FUNERAL_P, -4.2 + i * 1.4);
    box(dynGroup, 1.0, 0.02, 0.5, PAL.cream, cx, 0.03, funeralZ + 4.2);
    box(dynGroup, 1.0, 0.02, 0.5, PAL.cream, cx, 0.03, funeralZ - 4.2);
  }

  // инспектор
  const insp = makePerson({ shirt: 0x2f3a4a, pants: 0x22262e, hair: 0x2a2a2a, hat: 0x2f3a4a, scale: 1.05 });
  insp.position.set(worldX(CITY_INSPECTOR_P, -7.2), 0, -CITY_INSPECTOR_P);
  insp.rotation.y = -Math.PI / 2;
  // жезл
  const baton = box(insp, 0.06, 0.5, 0.06, 0xe6e2d8, 0.34, 1.1, -0.3);
  baton.rotation.z = 0.4;
  dynGroup.add(insp);
  E.inspector = { obj: insp, arm: insp.userData.armR, talked: false };
}

/* =====================================================================
   УПРАВЛЕНИЕ
   ===================================================================== */

const held = { left: false, right: false, keyBrake: false };
const pointerRoles = new Map(); // pointerId -> { kind: 'steer'|'brake', side, downAt }
const BRAKE_ZONE = 0.75;        // нижняя четверть экрана — тормоз
const BRAKE_DELAY_MS = 120;     // короткий тап не тормозит

function tapSteer(dir) {
  if (S.phase !== 'play') return;
  markControlUsed();
  if (S.invert > 0) dir = -dir;
  S.latV = clamp(S.latV + dir * 7.5, -12, 12);
}

function setKey(code, down) {
  if (code === 'ArrowLeft' || code === 'KeyA') held.left = down;
  else if (code === 'ArrowRight' || code === 'KeyD') held.right = down;
  else if (code === 'ArrowDown' || code === 'KeyS') held.keyBrake = down;
  else return false;
  if (down && S.phase === 'play') markControlUsed();
  return true;
}

window.addEventListener('keydown', (e) => {
  if (['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'Space'].includes(e.code)) e.preventDefault();
  if (e.code === 'Space' || e.code === 'Enter') {
    if (S.phase === 'start') startRun(true);
    return;
  }
  const handled = setKey(e.code, true);
  if (handled && !e.repeat) {
    if (e.code === 'ArrowLeft' || e.code === 'KeyA') tapSteer(-1);
    if (e.code === 'ArrowRight' || e.code === 'KeyD') tapSteer(1);
  }
});

window.addEventListener('keyup', (e) => {
  setKey(e.code, false);
});

window.addEventListener('blur', () => {
  held.left = held.right = held.keyBrake = false;
  pointerRoles.clear();
});

function touchSteer() {
  let left = false;
  let right = false;
  for (const r of pointerRoles.values()) {
    if (r.kind !== 'steer') continue;
    if (r.side < 0) left = true;
    else right = true;
  }
  return { left, right };
}

function touchBrakeActive() {
  const now = performance.now();
  let steerFingers = 0;
  for (const r of pointerRoles.values()) {
    if (r.kind === 'brake' && now - r.downAt > BRAKE_DELAY_MS) return true;
    if (r.kind === 'steer') steerFingers++;
  }
  // два пальца по экрану — дубль тормоза
  return steerFingers >= 2;
}

viewEl.addEventListener('pointerdown', (e) => {
  if (S.phase !== 'play') return;
  e.preventDefault();
  markControlUsed();
  if (e.clientY / Math.max(1, window.innerHeight) > BRAKE_ZONE) {
    pointerRoles.set(e.pointerId, { kind: 'brake', downAt: performance.now() });
    return;
  }
  const side = e.clientX < window.innerWidth / 2 ? -1 : 1;
  pointerRoles.set(e.pointerId, { kind: 'steer', side, downAt: performance.now() });
  tapSteer(side);
}, { passive: false });

function releasePointer(e) {
  pointerRoles.delete(e.pointerId);
}
viewEl.addEventListener('pointerup', releasePointer);
viewEl.addEventListener('pointercancel', releasePointer);
viewEl.addEventListener('pointerleave', releasePointer);
window.addEventListener('pointerup', releasePointer);
window.addEventListener('pointercancel', releasePointer);
viewEl.addEventListener('contextmenu', (e) => e.preventDefault());

/* =====================================================================
   ЛОГИКА
   ===================================================================== */

function hit(kind, sec = HIT_CLOCK, moodLoss = 12) {
  if (S.invuln > 0) return;
  S.invuln = 1.7;
  S.shake = 0.55;
  S.slowT = 0.9;
  S.speed = Math.min(S.speed, SPEED_MAX * 0.42);
  S.clock += sec;
  S.mood = Math.max(0, S.mood - moodLoss);
  S.moodDrain = { src: `hit:${kind}`, value: moodLoss, at: S.time, until: S.time + 2 };
  S.hitKinds[kind] = (S.hitKinds[kind] || 0) + 1;
  if (kind === 'granny') audio.sfx.granny();
  else if (kind === 'crossing' || kind === 'oncoming') audio.sfx.siren(2.4);
  const captions = {
    cow: 'Корова. Она тут живёт.\nНастроение −12% · −30 секунд',
    mower: 'Сосед не остановился. Настроение −12% · −30 секунд',
    tractor: 'Трактор не виноват.\nНастроение −12% · −30 секунд',
    funeral: 'Похороны. Настроение −12% · −30 секунд',
    crossing: 'ПОПЕРЕЧНЫЙ ТРАФИК. Не успел.\n−30 секунд · настроение −14%',
    pothole: 'ЯМА. Подвеска жива, время нет.\n−6 секунд',
    brick: 'КИРПИЧИ. −4 секунды',
    manhole: 'ЛЮК. −6 секунд',
    hump: 'ЛЕЖАЧИЙ ПОЛИЦЕЙСКИЙ на скорости.\n−8 секунд',
    chickens: 'КУРЫ. Они были здесь раньше.\n−5 секунд',
    granny: 'Бабушка. Ты её толкнул.\n−8 секунд · настроение −6%',
    gazelle: 'ДВЕРЬ ГАЗЕЛИ. −12 секунд',
    oncoming: 'ВСТРЕЧНЫЙ КАМАЗ. Лоб в лоб почти.\n−20 секунд · настроение −10%',
  };
  say(captions[kind] || `Настроение −${moodLoss}% · −${sec} секунд`, 3.4, true);
  if (S.clock >= CLOCK_MAX) lose();
}

function checkCollisions() {
  if (S.invuln > 0) return;
  const pz = -S.p;
  for (const c of colliders) {
    const o = c.obj;
    const dz = Math.abs(o.position.z - pz);
    const dx = Math.abs(o.position.x - S.x);
    if (dz < c.hl + 1.95 && dx < c.hw + 0.95) {
      hit(c.kind);
      return;
    }
  }
}

/* препятствия: подпись при первом появлении, столкновение, лужа-занос */
function checkObstacles(dt) {
  const pz = -S.p;
  let nearest = null;
  let nearestD = 1e9;
  for (const o of obstacles) {
    if (o.type === 'oncoming' && !o.hit) {
      // встречный камаз едет сам, навстречу
      o.p -= 17 * dt;
      o.obj.position.z = -o.p;
      o.obj.position.x = worldX(o.p, o.lat);
    }
    if (o.hit) continue;
    const dz = o.obj.position.z - pz;      // >0 — впереди
    const meta = OB_META[o.type];
    if (!S.seen[o.type] && dz > 0 && dz < 190 && dz < nearestD) {
      nearestD = dz;
      nearest = o;
    }
    if (Math.abs(dz) > 9) continue;
    const dx = Math.abs(o.obj.position.x - S.x);
    if (meta.slip) {
      if (!o.touched && Math.abs(dz) < 1.9 && dx < 2.0) {
        o.touched = true;
        S.slip = 1.5;
        S.shake = Math.max(S.shake, 0.28);
        if (!S.seen.puddle) {
          S.seen.puddle = true;
          say('ЛУЖА. Машину понесло: руль скользит 1.5 секунды.', 3.4, true);
        }
      }
      continue;
    }
    if (S.invuln > 0) continue;
    if (Math.abs(dz) < meta.hl + 1.9 && dx < meta.hw + 0.95) {
      o.hit = true;
      if (o.type === 'hump') {
        if (S.speed > 26) hit('hump', meta.sec, meta.mood);
        else S.shake = Math.max(S.shake, 0.3);
      } else {
        hit(o.type, meta.sec, meta.mood);
      }
    }
  }
  if (nearest && !S.seen[nearest.type]) {
    S.seen[nearest.type] = true;
    say(OB_HINT[nearest.type] || '', 2.8);
  }
}

function resetCrossings(fromP) {
  for (const c of crossings) {
    if (c.p < fromP) continue;
    c.started = false;
    c.warned = false;
    c.done = false;
    c.relX = -c.dir * (c.kind.id === 'granny' ? 2.5 : 24 - c.hw);
    c.spEff = 0;
    c.veh.visible = false;
    c.veh.position.set(roadOff(c.p) + c.relX, 0, -c.p);
  }
}

let groomSpawned = false;
let groomNudgeT = 3;
function spawnGroom() {
  if (groomSpawned || S.phase !== 'play') return;
  groomSpawned = true;
  groom.visible = true;
  // сразу в кадре: справа и чуть впереди игрока
  groom.position.set(S.x + 4.9, 0, -S.p + 2.2);
  groomNudgeT = 3;
  say('Жених догнал и едет рядом.\nКрасная машина, сердце на крыше.', 4.5, true);
}

function updatePlay(dt) {
  const t = S.time;

  /* --- скорость --- */
  const touch = touchSteer();
  const braking = held.keyBrake || touchBrakeActive();
  S.braking = braking;
  const want = braking ? 0 : SPEED_MAX;
  // быстрый разгон: с 0 до максимума примерно за 1.3 секунды
  S.speed = damp(S.speed, want, braking ? 8 : 3.0, dt);
  if (S.slowT > 0) {
    S.slowT -= dt;
    S.speed = Math.min(S.speed, SPEED_MAX * 0.55);
  }

  /* --- руль: непрерывное латеральное смещение --- */
  let dir = (held.left ? -1 : 0) + (held.right ? 1 : 0) + (touch.left ? -1 : 0) + (touch.right ? 1 : 0);
  dir = clamp(dir, -1, 1);
  if (S.invert > 0) dir = -dir;
  const grip = S.slip > 0 ? 0.32 : 1;
  const curv = roadCurv(S.p);
  S.curvNow = curv;

  if (S.speed > 2) {
    if (dir !== 0) {
      S.latV += dir * STEER_ACC * grip * dt;
      // центробежная сила: в повороте подруливать приходится сильнее
      S.latV -= curv * S.speed * S.speed * 2.2 * dt;
      if (S.slip > 0) S.latV += Math.sin(t * 5.5) * 5 * dt;
      S.latV *= Math.exp(-1.9 * dt);
      S.latV = clamp(S.latV, -12, 12);
      S.lat += S.latV * dt;
    } else {
      /* руль отпущен: критически задемпфированная пружина к центру
         ближайшей полосы (перелёта нет), за кромкой асфальта — жёстче */
      const edge = Math.abs(S.lat) > 4.2;
      const target = edge ? clamp(S.lat, -LANE, LANE) : Math.round(S.lat / LANE) * LANE;
      const w = (edge ? 16 : 11) * (S.slip > 0 ? 0.5 : 1);
      S.latV += (-w * w * (S.lat - target) - 2 * w * S.latV) * dt;
      S.latV = clamp(S.latV, -12, 12);
      S.lat += S.latV * dt;
      if (Math.abs(S.lat - target) < 0.02 && Math.abs(S.latV) < 0.06) {
        S.lat = target;
        S.latV = 0;
      }
    }
    S.lat = clamp(S.lat, -6.4, 6.4);
  }

  if (S.slip > 0) S.slip -= dt;

  /* обочина: тряска и потолок скорости, но настроение не трогаем */
  if (Math.abs(S.lat) > SHOULDER_EDGE) {
    S.speed = Math.min(S.speed, SHOULDER_MAX_SPEED);
    S.shake = Math.max(S.shake, 0.24);
    if (t - S.kerbT > 3.5) {
      S.kerbT = t;
      say('ОБОЧИНА. Тут медленно и трясёт.', 2);
    }
  }

  /* поворот: щит и подсветка HUD */
  const bend = bendNear(S.p, 150);
  if (bend) {
    S.turnT = 0.25;
    S.curvNow = bend.dir * bend.steep;
  }

  /* --- движение --- */
  S.p += S.speed * dt;
  S.clock += dt * CLOCK_RATE;
  S.x = roadOff(S.p) + S.lat;

  /* --- тряска --- */
  if (S.shake > 0) S.shake -= dt;
  if (S.warnT > 0) S.warnT -= dt;
  if (S.turnT > 0) S.turnT -= dt;

  /* --- машина --- */
  playerCar.position.set(S.x, 0, -S.p);
  playerCar.rotation.y = -roadHead(S.p) + clamp(S.latV * 0.014, -0.16, 0.16);
  const shakeX = S.shake > 0 ? Math.sin(t * 60) * 0.14 * S.shake : 0;
  const shakeY = S.shake > 0 ? Math.abs(Math.sin(t * 47)) * 0.08 * S.shake : 0;
  playerBody.position.set(shakeX, shakeY, 0);
  playerBody.rotation.z = clamp(-S.latV * 0.012, -0.11, 0.11);

  /* --- полиция --- */
  police.position.x = damp(police.position.x, S.x * 0.94, 6, dt);
  police.position.z = damp(police.position.z, -S.p + POLICE_TRAIL, POLICE_FOLLOW, dt);

  /* --- жених: едет рядом в кадре, толкает в бок и сигналит --- */
  if (groom.visible) {
    groom.position.x = damp(groom.position.x, S.x + 4.9, 8, dt);
    groom.position.z = -S.p + 2.2;
    groom.rotation.y = -roadHead(S.p);
    groomNudgeT -= dt;
    if (groomNudgeT <= 0) {
      groomNudgeT = rnd(5.5, 8);
      // толчок в бок: игрока сносит влево
      S.latV = clamp(S.latV - 7, -12, 12);
      S.shake = Math.max(S.shake, 0.18);
      say(pick([
        'Жених сигналит: би-бип!\nИ толкает тебя в бок.',
        'Жених поравнялся. Би-бип.\nМашину ведёт влево.',
        'ЖЕНИХ: «Ну куда ты?!»\nСигнал и толчок в бок.',
      ]), 2.6);
    }
  }

  /* --- мигалки --- */
  const blink = Math.sin(t * 12) > 0;
  const bc = police.userData.beacons;
  bc.redM.color.setHex(blink ? 0xff3b3b : 0x501010);
  bc.blueM.color.setHex(blink ? 0x14286a : 0x4472ff);
  bc.red.scale.setScalar(blink ? 1.15 : 1);
  bc.blue.scale.setScalar(blink ? 1 : 1.15);

  /* --- счётчики --- */
  if (S.invuln > 0) S.invuln -= dt;
  /* --- отрезки / чекпоинты --- */
  if (S.seg < SEGMENTS.length - 1 && S.p >= SEGMENTS[S.seg + 1].start) {
    S.seg += 1;
    S.checkpoint = { p: S.p, clock: S.clock, mood: S.mood, seg: S.seg };
    buildSegment(S.seg);
    say(`ЧЕКПОИНТ · Отрезок ${S.seg + 1}: ${SEGMENTS[S.seg].name}`, 3.2);
    showControlHint();
  }

  /* --- объекты отрезка --- */
  updateSegmentObjects(dt);
  updateCrossings(dt);

  /* --- столкновения --- */
  checkCollisions();
  checkObstacles(dt);

  /* --- инверсия --- */
  if (S.invert > 0) {
    S.invert -= dt;
    if (S.invert <= 0) say('Голубь успокоился. Управление прежнее.', 3);
  }

  /* --- часы --- */
  if (S.clock >= CLOCK_MAX) {
    S.clock = CLOCK_MAX;
    lose();
    return;
  }

  /* --- победа: доехать мало, нужно ещё не быть злым --- */
  if (S.p >= ROUTE) {
    if (S.mood >= MOOD_WIN) win();
    else moodFail();
  }
}

function updateSegmentObjects(dt) {
  const t = S.time;

  if (E.mower) {
    const m = E.mower;
    if (m.obj.position.z < -S.p + 26) m.obj.position.z += 6.5 * dt;
    m.arm.rotation.x = 2.4 + Math.sin(t * 5) * 0.55;
    m.obj.userData.person.rotation.z = Math.sin(t * 5) * 0.04;
  }

  if (E.cow) {
    // корова жуёт и слегка покачивается
    E.cow.rotation.z = Math.sin(t * 1.4) * 0.012;
  }

  if (E.bride) {
    const b = E.bride;
    if (b.state === 'wait' && S.p > BRIDE_P - 60) {
      b.state = 'run';
      b.t = 0;
      say('Девушка в свадебном платье голосует.\nОна не сомневается.', 3.8);
    } else if (b.state === 'run') {
      b.t += dt;
      const tx = S.x + 0.9;
      b.obj.position.x = damp(b.obj.position.x, tx, 9, dt);
      b.obj.position.z = damp(b.obj.position.z, -S.p + 1.0, 9, dt);
      b.obj.rotation.y = Math.PI * 0.5;
      if (b.t > 0.75) {
        b.state = 'in';
        b.obj.visible = false;
        brideSeat.visible = true;
        say('Она села сама. Даже дверь не открывала.', 3.6, true);
        S.timers = S.timers || [];
        S.timers.push({ t: 15, fn: spawnGroom });
      }
    }
  }

  if (E.pigeon) {
    const p = E.pigeon;
    if (p.state === 'hidden' && S.p > HIGHWAY_PIGEON_P) {
      p.state = 'fly';
      p.f = 0;
      p.obj.visible = true;
      p.obj.position.set(S.x + 7.5, 4.2, -S.p - 30);
      p.from.copy(p.obj.position);
      say('Голубь. Он летит в салон.\n5 секунд всё наоборот.', 4.2);
    } else if (p.state === 'fly') {
      p.f += dt / 1.25;
      const to = new THREE.Vector3(S.x + 0.3, 1.5, -S.p + 0.4);
      p.obj.position.lerpVectors(p.from, to, Math.min(1, p.f));
      p.obj.position.y += Math.sin(Math.min(1, p.f) * Math.PI) * 1.4;
      p.obj.rotation.z = Math.sin(t * 22) * 0.5;
      p.obj.userData.wings.forEach((w, i) => {
        w.rotation.z = Math.sin(t * 26) * 0.9 * (i ? 1 : -1);
      });
      if (p.f >= 1) {
        p.state = 'in';
        p.obj.visible = false;
        pigeonSeat.visible = true;
        S.invert = 5;
        S.shake = 0.3;
        say('Голубь влетел в салон.\n5 секунд: влево — это вправо.', 4.5, true);
      }
    }
  }

  if (E.tractor) {
    E.tractor.position.z -= 3.33 * dt; // 12 км/ч
  }

  if (E.funeral) {
    const f = E.funeral;
    if (S.p > f.zoneStart && S.p < f.zoneEnd) {
      if (!f.done && S.speed < 1.2) {
        f.stopped += dt;
        if (f.stopped >= 2) {
          f.done = true;
          say('Похороны расступаются. Спасибо, что не посигналил.', 4, true);
        }
      }
    }
    if (!f.done && S.speed > 1.2 && Math.abs(f.z + S.p) < 26) {
      for (const m of f.mourners) m.obj.position.x = damp(m.obj.position.x, m.dir * 8.2, 3.2, dt);
    }
    if (f.done) {
      for (const m of f.mourners) {
        const tx = m.dir * 8.2;
        m.obj.position.x = damp(m.obj.position.x, tx, 1.8, dt);
        m.obj.rotation.z = Math.sin(t * 3) * 0.05;
      }
    }
    if (S.p >= f.zoneEnd && !f.done && !f.paid) {
      f.paid = true;
      S.clock += HIT_CLOCK;
      S.mood = Math.max(0, S.mood - 6);
      S.moodDrain = { src: 'funeral', value: 6, at: S.time, until: S.time + 2 };
      say('Похороны. Не дал пройти спокойно.\n−30 секунд', 3.6, true);
      for (const m of f.mourners) {
        m.obj.position.x = damp(m.obj.position.x, m.dir * 8.2, 1.8, dt);
      }
    }
    if (S.p > f.zoneStart && S.p < f.zoneEnd && !f.done) {
      S.controlHintOn = false;
      subEl.textContent = `СТОЯТЬ: ${clamp(2 - f.stopped, 0, 2).toFixed(1)} / 2.0`;
      subEl.classList.add('on');
    } else if (!f.done && S.p < f.zoneStart - 80 && S.p > f.zoneStart - 700) {
      // подсказка заранее
      if (!S.funeralShown) {
        S.funeralShown = true;
        say('Впереди перекрёсток. Похороны.\nНужно встать на 2 секунды.', 4.2);
      }
    } else if (!f.subCleared && S.p > f.zoneEnd) {
      f.subCleared = true;
      subEl.textContent = '';
      subEl.classList.remove('on');
    }
  }

  if (E.inspector) {
    const ins = E.inspector;
    if (!ins.talked && S.p > CITY_INSPECTOR_P - 50) {
      ins.talked = true;
      ins.arm.rotation.x = 2.2;
      say('— А вы вообще куда?\n— На день рождения.\n— Тогда счастливо. И не гоните.', 5.5, true);
      S.timers = S.timers || [];
      S.timers.push({ t: 2.5, fn: () => { ins.arm.rotation.x = 0; } });
    }
  }

  /* таймеры (секунды реальные) */
  if (S.timers && S.timers.length) {
    for (let i = S.timers.length - 1; i >= 0; i--) {
      S.timers[i].t -= dt;
      if (S.timers[i].t <= 0) {
        const fn = S.timers[i].fn;
        S.timers.splice(i, 1);
        fn();
      }
    }
  }
}

/* =====================================================================
   ФИНАЛЫ
   ===================================================================== */

const overEl = document.getElementById('over');
const wonEl = document.getElementById('won');
const startEl = document.getElementById('start');

function lose() {
  if (S.phase !== 'play') return;
  S.phase = 'lost';
  S.clock = CLOCK_MAX;
  held.keyBrake = true;
  pointerRoles.clear();
  document.getElementById('overtitle').textContent = '19:00';
  document.getElementById('oversub').textContent = 'приехали без тебя';
  document.getElementById('overtext').textContent =
    `Ты проехал ${Math.round(S.p / ROUTE * 100)}% дороги. ` +
    `Отрезок ${S.seg + 1} из 3 — ${SEGMENTS[S.seg].name}.\n` +
    'Двор уже виден. Ты почти успел.';
  document.getElementById('retry').textContent = `с начала отрезка ${S.seg + 1}`;
  overEl.classList.remove('hidden');
  captionEl.classList.remove('on');
}

function moodFail() {
  if (S.phase !== 'play') return;
  S.phase = 'lost';
  held.keyBrake = true;
  pointerRoles.clear();
  S.capQueue.length = 0;
  S.capTimer = 0;
  captionEl.classList.remove('on');
  const pct = Math.round(S.mood);
  document.getElementById('overtitle').textContent = 'ДОЕХАЛ';
  document.getElementById('oversub').textContent = 'но злой';
  document.getElementById('overtext').textContent =
    `Настроение ${pct}% — меньше ${MOOD_WIN}%. Торт не помог: ` +
    'во дворе тебя встретили, а ты только ругался.\n' +
    `Переиграй отрезок ${S.seg + 1}: ${SEGMENTS[S.seg].name} — и довези хорошее настроение.`;
  document.getElementById('retry').textContent = `с начала отрезка ${S.seg + 1}`;
  overEl.classList.remove('hidden');
}

function win() {
  if (S.phase !== 'play') return;
  S.phase = 'finale';
  S.finaleT = 0;
  S.winClock = Math.min(S.clock, CLOCK_MAX);
  S.controlHintOn = false;
  subEl.classList.remove('on');
  S.capQueue.length = 0;
  S.capTimer = 0;
  captionEl.classList.remove('on');
  S.invert = 0;
  // салют в момент, когда полиция перекрывает въезд и открывается багажник
  audio.sfx.fireworks();
  say('Двор. Ворота. Наконец-то.', 3);
}

let wonShown = false;

function updateFinale(dt) {
  S.finaleT += dt;
  const t = S.finaleT;

  // игрок останавливается у ворот
  S.speed = damp(S.speed, 0, 2.6, dt);
  S.p += S.speed * dt;
  if (S.p > ROUTE - 6) S.p = ROUTE - 6;
  S.lat = damp(S.lat, 0, 2.2, dt);
  S.x = roadOff(S.p) + S.lat;
  playerCar.position.set(S.x, 0, -S.p);
  playerCar.rotation.y = -roadHead(S.p);
  playerBody.rotation.z = damp(playerBody.rotation.z, 0, 4, dt);
  playerBody.rotation.x = 0;
  playerBody.position.set(0, 0, 0);

  // полиция обгоняет и перекрывает въезд
  const k = clamp(t / 1.6, 0, 1);
  const ease = k * k * (3 - 2 * k);
  police.position.z = THREE.MathUtils.lerp(-ROUTE + POLICE_TRAIL, -(ROUTE + 2.5), ease);
  police.position.x = THREE.MathUtils.lerp(S.x * 0.92, roadOff(ROUTE) - 1.5, ease);
  police.rotation.y = THREE.MathUtils.lerp(0, 0.38, ease);

  // мигалки
  const blink = Math.sin(t * 12) > 0;
  const bc = police.userData.beacons;
  bc.redM.color.setHex(blink ? 0xff3b3b : 0x501010);
  bc.blueM.color.setHex(blink ? 0x14286a : 0x4472ff);
  bc.red.scale.setScalar(blink ? 1.2 : 1);
  bc.blue.scale.setScalar(blink ? 1 : 1.2);

  // багажник
  if (S.trunk) {
    const open = clamp((t - 1.5) / 0.8, 0, 1);
    S.trunk.rotation.x = -open * 0.55;
    if (S.cake) S.cake.visible = open > 0.35;
  }

  // девушка выходит
  if (brideSeat.visible && t > 2.0) {
    if (!S.brideOut) {
      S.brideOut = makeBride();
      S.brideOut.position.set(S.x + 1.4, 0, -S.p + 1.2);
      S.brideOut.rotation.y = Math.PI * 0.85;
      scene.add(S.brideOut);
      brideSeat.visible = false;
    }
    S.brideOut.position.x = damp(S.brideOut.position.x, S.x + 3.1, 2.4, dt);
    S.brideOut.position.z = damp(S.brideOut.position.z, -ROUTE + 0.5, 2.4, dt);
    S.brideOut.userData.armR.rotation.x = damp(S.brideOut.userData.armR.rotation.x, 2.7, 3, dt);
  }

  // голубь перелетает на багажник
  if (pigeonSeat.visible && t > 2.4) {
    if (!S.pigeonOut) {
      S.pigeonOut = makePigeon();
      S.pigeonOut.position.set(S.x, 1.4, -S.p);
      scene.add(S.pigeonOut);
      pigeonSeat.visible = false;
    }
    const px = -0.6, py = 1.5, pz = -(ROUTE + 0.6);
    S.pigeonOut.position.x = damp(S.pigeonOut.position.x, px, 1.6, dt);
    S.pigeonOut.position.y = damp(S.pigeonOut.position.y, py, 1.6, dt);
    S.pigeonOut.position.z = damp(S.pigeonOut.position.z, pz, 1.6, dt);
    S.pigeonOut.rotation.y = Math.sin(t) * 0.4;
    S.pigeonOut.userData.wings.forEach((w, i) => {
      w.rotation.z = Math.sin(t * 8) * 0.25 * (i ? 1 : -1);
    });
  }

  // камера чуть отъезжает на финальный кадр
  const look = new THREE.Vector3(S.x, 2.4, -(ROUTE + 5));
  camLook.lerp(look, 1 - Math.exp(-1.8 * dt));
  camera.zoom = damp(camera.zoom, 0.78, 1.6, dt);
  camera.updateProjectionMatrix();

  // финальный текст
  if (!wonShown && t > 4.2) {
    wonShown = true;
    document.getElementById('wontitle').textContent = 'Они ехали поздравить.';
    document.getElementById('wonsub').textContent = 'Торт был у них.';
    document.getElementById('wontext').textContent =
      `Ты доехал в ${fmtClock(S.winClock).slice(0, 5)}. ` +
      `Настроение ${Math.round(S.mood)}% — выше порога ${MOOD_WIN}%. ` +
      'Полиция обогнала тебя у самого двора и перекрыла въезд.\n' +
      'В багажнике — торт. Девушка в свадебном платье и голубь тоже здесь.\n' +
      'С днём рождения.';
    wonEl.classList.remove('hidden');
    wonEl.classList.add('show');
  }
}

/* =====================================================================
   ЗАПУСК / РЕТРАЙ
   ===================================================================== */

function resetPlayer() {
  S.lat = 0;
  S.latV = 0;
  S.slip = 0;
  S.x = roadOff(S.p);
  S.speed = SPEED_MAX * 0.5;
  playerCar.position.set(S.x, 0, -S.p);
  playerBody.position.set(0, 0, 0);
  playerBody.rotation.set(0, 0, 0);
  held.left = held.right = false;
  held.keyBrake = false;
  pointerRoles.clear();
}

function buildFinaleProps() {
  if (S.trunk) return;
  S.trunk = null;
  // крышка багажника полиции
  const lid = new THREE.Group();
  const lidMesh = box(lid, 1.9, 0.12, 0.9, 0xdcdad2, 0, 0, 0.45);
  lidMesh.position.set(0, 0, 0.45);
  lid.position.set(0, 1.02, 1.55);
  police.userData.body.add(lid);
  S.trunk = lid;

  // тёмная ниша багажника — чтобы торт читался
  box(police.userData.body, 1.5, 0.06, 1.0, 0x141416, 0, 0.92, 1.7);
  box(police.userData.body, 1.5, 0.5, 0.08, 0x141416, 0, 1.16, 1.22);
  // торт в багажнике
  const cake = makeCake();
  cake.scale.setScalar(2.2);
  cake.position.set(0, 1.02, 1.82);
  cake.visible = false;
  police.userData.body.add(cake);
  S.cake = cake;
}

function startRun(fromStart) {
  audio.start();
  if (fromStart) {
    S.p = 0;
    S.clock = 0;
    S.mood = 100;
    S.seg = 0;
    S.checkpoint = { p: 0, clock: 0, mood: 100, seg: 0 };
    S.funeralShown = false;
    S.seen = {};
    S.hitKinds = {};
    S.slip = 0;
    S.warnT = 0;
    S.turnT = 0;
    resetCrossings(0);
    if (groom.visible) groom.visible = false;
    groomSpawned = false;
    brideSeat.visible = false;
    pigeonSeat.visible = false;
    if (S.brideOut) { scene.remove(S.brideOut); S.brideOut = null; }
    if (S.pigeonOut) { scene.remove(S.pigeonOut); S.pigeonOut = null; }
    S.timers = [];
    wonShown = false;
    if (S.trunk) {
      S.trunk.rotation.x = 0;
      S.cake.visible = false;
    }
  }
  S.phase = 'play';
  camera.zoom = 1;
  camera.updateProjectionMatrix();
  S.invuln = 0;
  S.shake = 0;
  S.slowT = 0;
  S.invert = 0;
  S.finaleT = 0;
  S.capQueue.length = 0;
  S.capTimer = 0;
  captionEl.classList.remove('on');
  S.time = 0;
  resetPlayer();
  buildSegment(S.seg);
  police.position.set(S.x * 0.94, 0, -S.p + POLICE_TRAIL);
  police.rotation.y = 0;
  camLook.set(S.x * 0.9, 1, -S.p - CAM_LOOKAHEAD);
  camYawNow = CAM_YAW + roadHead(S.p) * 0.8;
  startEl.classList.add('hidden');
  overEl.classList.add('hidden');
  wonEl.classList.add('hidden');
  wonEl.classList.remove('show');
  showControlHint();
  segEl.textContent = '';
  lastSegText = '';
  if (S.seg === 0) {
    say('18:52. Ты выехал. Полиция уже сзади.', 4.5);
  }
}

function retrySegment() {
  audio.start();
  S.clock = S.checkpoint.clock;
  S.mood = S.checkpoint.mood;
  S.p = SEGMENTS[S.seg].start + 1;
  S.invert = 0;
  S.timers = [];
  groomSpawned = groom.visible;
  S.funeralShown = false;
  S.seen = {};
  S.warnT = 0;
  S.turnT = 0;
  resetCrossings(SEGMENTS[S.seg].start);
  cubeResetForRetry();
  S.phase = 'play';
  camera.zoom = 1;
  camera.updateProjectionMatrix();
  resetPlayer();
  buildSegment(S.seg);
  police.position.set(S.x * 0.94, 0, -S.p + POLICE_TRAIL);
  camLook.set(S.x * 0.9, 1, -S.p - CAM_LOOKAHEAD);
  camYawNow = CAM_YAW + roadHead(S.p) * 0.8;
  S.capQueue.length = 0;
  S.capTimer = 0;
  captionEl.classList.remove('on');
  overEl.classList.add('hidden');
  showControlHint();
  say(`Отрезок ${S.seg + 1}: ${SEGMENTS[S.seg].name}. Ещё раз.`, 3.4);
}

function cubeResetForRetry() {
  // пассажиры первого отрезка сбрасываются только при ретрае шоссе
  if (S.seg <= 1) {
    brideSeat.visible = false;
    pigeonSeat.visible = false;
    groom.visible = false;
    groomSpawned = false;
  }
}

document.getElementById('retry').addEventListener('click', retrySegment);
document.getElementById('again').addEventListener('click', () => {
  startRun(true);
  // «ещё раз» — снова салют поверх нового заезда
  audio.sfx.fireworks();
});
startEl.addEventListener('pointerdown', (e) => {
  if (S.phase === 'start') {
    e.preventDefault();
    startRun(true);
  }
});

/* =====================================================================
   ЦИКЛ
   ===================================================================== */

const STEP = 1 / 60;
let acc = 0;
let last = performance.now();

function step(dt) {
  S.time += dt;
  if (S.phase === 'play') updatePlay(dt);
  else if (S.phase === 'finale') updateFinale(dt);
  else if (S.phase === 'lost') {
    S.speed = damp(S.speed, 0, 4, dt);
  }

  // потоки реквизита
  for (const s of streams) s.update(-S.p);

  // камера
  if (S.phase === 'play' || S.phase === 'lost') {
    const look = new THREE.Vector3(S.x * 0.9, 1.0, -S.p - CAM_LOOKAHEAD);
    camLook.lerp(look, 1 - Math.exp(-5.5 * dt));
  }
  const headNow = (S.phase === 'play' || S.phase === 'lost') ? roadHead(S.p) : 0;
  camYawNow = damp(camYawNow, CAM_YAW + headNow * 0.8, 2.4, dt);
  camera.position.copy(camLook).add(camOffsetFor(camYawNow));
  camera.lookAt(camLook);

  tickCaptions(dt);
  updateHUD();
}

function render() {
  renderer.render(scene, camera);
}

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  if (!isFinite(dt) || dt < 0) dt = 0;
  if (dt > 0.25) dt = 0.25;
  acc += dt;
  let guard = 0;
  while (acc >= STEP && guard < 8) {
    step(STEP);
    acc -= STEP;
    guard++;
  }
  if (guard >= 8) acc = 0;
  audio.tick(now);
  render();
}

/* build finale props up front so win() can rely on them */
buildFinaleProps();
initCrossings();

requestAnimationFrame(frame);
document.getElementById('loading').textContent = 'три.js на месте · готово';

/* отладка для проверки (не мешает игре) */
window.__game = {
  S, scene, camera, renderer, LANES, ROUTE, MOOD_WIN, police, playerCar,
  audio: {
    dbg: () => audio.dbg(),
    rms: () => audio.rms(),
    peak: () => audio.peak(),
    start: () => audio.start(),
    unlock: (source) => audio.unlock(source || 'debug'),
    context: () => audio.context(),
    toggle: () => { const m = audio.toggleMute(); syncSndUI(); return m; },
    setMuted: (v) => { const m = audio.setMuted(v); syncSndUI(); return m; },
    siren: (dur) => audio.sfx.siren(dur),
    woop: () => audio.sfx.woop(),
    granny: () => audio.sfx.granny(),
    fireworks: (level) => audio.sfx.fireworks(level),
    offline: (opts) => audio.offline(opts),
    layers: () => audio.layers.slice(),
  },
  hit: (kind) => { S.invuln = 0; hit(kind); },
  get phase() { return S.phase; },
  start: () => startRun(true),
  snapCamera: () => {
    camLook.set(S.x * 0.9, 1, -S.p - CAM_LOOKAHEAD);
    camYawNow = CAM_YAW + roadHead(S.p) * 0.8;
    camera.position.copy(camLook).add(camOffsetFor(camYawNow));
    camera.lookAt(camLook);
  },
  forceWin: () => { S.p = ROUTE; },
  forceLose: () => { S.clock = CLOCK_MAX - 0.2; },
  setMood: (v) => { S.mood = clamp(v, 0, 100); },
  moodFailNow: () => { S.mood = Math.min(S.mood, MOOD_WIN - 1); S.p = ROUTE - 2; },
  layout: () => ({ VIEW_SPAN, CAM_LOOKAHEAD, w: window.innerWidth, h: window.innerHeight }),
  captionInfo: () => ({
    visible: captionEl.classList.contains('on'),
    text: captionEl.textContent,
    rect: (() => { const r = captionEl.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
    timer: S.capTimer,
    queue: S.capQueue.map((c) => c.text),
  }),
  say: (text, dur, important) => say(text, dur, important),
  brideInfo: () => E.bride ? {
    state: E.bride.state,
    seat: brideSeat.visible,
    p: +S.p.toFixed(0),
    t: +S.time.toFixed(1),
    x: +E.bride.obj.position.x.toFixed(1),
    z: +E.bride.obj.position.z.toFixed(1),
    screen: window.__game.project(E.bride.obj.position.x, 1.2, E.bride.obj.position.z),
    onScreen: window.__game.onScreen(E.bride.obj.position.x, 1.2, E.bride.obj.position.z),
  } : null,
  hudRects: () => {
    const ids = ['mood', 'clockbox', 'speed', 'seg', 'turn', 'warn', 'invert', 'brakepad', 'snd'];
    const out = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      out[id] = { x: r.x, y: r.y, w: r.width, h: r.height, shown: getComputedStyle(el).display !== 'none' && r.width > 0 };
    }
    return out;
  },
  playerRect: () => {
    const pts = [];
    const car = playerCar;
    car.updateMatrixWorld(true);
    car.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox;
      const V = o.position.constructor;
      const cs = [
        [bb.min.x, bb.min.y, bb.min.z], [bb.min.x, bb.min.y, bb.max.z],
        [bb.min.x, bb.max.y, bb.min.z], [bb.min.x, bb.max.y, bb.max.z],
        [bb.max.x, bb.min.y, bb.min.z], [bb.max.x, bb.min.y, bb.max.z],
        [bb.max.x, bb.max.y, bb.min.z], [bb.max.x, bb.max.y, bb.max.z],
      ];
      for (const c of cs) {
        const v = new V(c[0], c[1], c[2]);
        o.localToWorld(v);
        v.project(camera);
        pts.push([(v.x * 0.5 + 0.5) * window.innerWidth, (-v.y * 0.5 + 0.5) * window.innerHeight]);
      }
    });
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  },
  crossingInfo: () => {
    let best = null;
    for (const c of crossings) {
      const d = c.p - S.p;
      if (d > -5 && (best === null || d < best.d)) best = { d, kind: c.kind.id, started: c.started, veh: c.veh.visible, onScreen: c.veh.visible ? window.__game.onScreen(c.veh.position.x, 1.0, c.veh.position.z) : false };
    }
    return best;
  },
  skipTo: (seg) => {
    S.seg = seg;
    S.p = SEGMENTS[seg].start + 1;
    S.checkpoint = { p: S.p, clock: S.clock, mood: S.mood, seg };
    buildSegment(seg);
    resetPlayer();
  },
  teleport: (p) => {
    S.p = p;
    S.x = roadOff(S.p) + S.lat;
    camLook.set(S.x * 0.9, 1, -p - 7);
    camYawNow = CAM_YAW + roadHead(S.p) * 0.8;
  },
  roadOff, roadHead, roadCurv, BENDS, crossings, obstacles: () => obstacles,
  setLat: (v) => { S.lat = v; S.latV = 0; },
  hold: (side, on) => { held[side] = !!on; },
  spawnGroom: () => spawnGroom(),
  advance: (sec) => { const n = Math.round(sec * 60); for (let i = 0; i < n; i++) step(1 / 60); return n; },
  crossingsList: () => crossings,
  project: (x, y, z) => {
    const v = new THREE.Vector3(x, y, z).project(camera);
    return [Math.round((v.x * 0.5 + 0.5) * 320), Math.round((-v.y * 0.5 + 0.5) * 180)];
  },
  onScreen: (x, y, z) => {
    const v = new THREE.Vector3(x, y, z).project(camera);
    return v.z < 1 && v.x > -1 && v.x < 1 && v.y > -1 && v.y < 1;
  },
  marks: () => ({
    cake: S.cake && S.cake.visible ? window.__game.project(S.cake.getWorldPosition(new THREE.Vector3()).x, S.cake.getWorldPosition(new THREE.Vector3()).y, S.cake.getWorldPosition(new THREE.Vector3()).z) : null,
    bride: S.brideOut ? window.__game.project(S.brideOut.position.x, 1.2, S.brideOut.position.z) : null,
    pigeon: S.pigeonOut ? window.__game.project(S.pigeonOut.position.x, 1.4, S.pigeonOut.position.z) : null,
    police: window.__game.project(police.position.x, 0.9, police.position.z),
    player: window.__game.project(playerCar.position.x, 0.9, playerCar.position.z),
  }),
  dbg: () => {
    const pz = -S.p;
    let gap = null;
    let nextType = null;
    for (const o of obstacles) {
      const d = o.obj.position.z - pz;
      if (d > 0 && (gap === null || d < gap)) { gap = d; nextType = o.type; }
    }
    let cross = null;
    for (const c of crossings) {
      const d = c.p - S.p;
      if (d > -30 && (cross === null || Math.abs(d) < Math.abs(cross.d))) {
        cross = {
          d: +d.toFixed(1),
          kind: c.kind.id,
          started: c.started,
          warned: c.warned,
          veh: c.veh.visible
            ? {
                x: +c.veh.position.x.toFixed(2),
                screen: window.__game.project(c.veh.position.x, 1.2, c.veh.position.z),
              }
            : null,
        };
      }
    }
    return {
      bride: E.bride && E.bride.state,
      brideSeat: brideSeat.visible,
      pigeon: E.pigeon && E.pigeon.state,
      pigeonSeat: pigeonSeat.visible,
      groom: {
        vis: groom.visible,
        x: +groom.position.x.toFixed(2),
        z: +groom.position.z.toFixed(2),
        screen: groom.visible
          ? window.__game.project(groom.position.x, 1.2, groom.position.z)
          : null,
        onScreen: groom.visible
          ? window.__game.onScreen(groom.position.x, 1.2, groom.position.z)
          : false,
      },
      lat: +S.lat.toFixed(2),
      latV: +S.latV.toFixed(2),
      onShoulder: Math.abs(S.lat) > SHOULDER_EDGE,
      shoulderEdge: SHOULDER_EDGE,
      moodDrain: S.moodDrain && S.time < S.moodDrain.until
        ? { src: S.moodDrain.src, value: S.moodDrain.value, at: +S.moodDrain.at.toFixed(2) }
        : null,
      policeView: {
        onScreen: window.__game.onScreen(police.position.x, police.position.y + 0.9, police.position.z),
        center: window.__game.project(police.position.x, police.position.y + 0.9, police.position.z),
        top: window.__game.project(police.position.x, police.position.y + 1.65, police.position.z),
      },
      speed: +S.speed.toFixed(1),
      roadOffset: +roadOff(S.p).toFixed(2),
      curvature: +roadCurv(S.p).toFixed(5),
      heading: +roadHead(S.p).toFixed(4),
      x: +S.x.toFixed(2),
      nextObstacleGap: gap === null ? null : +gap.toFixed(1),
      nextObstacle: nextType,
      crossroad: cross,
      warnT: +S.warnT.toFixed(2),
      turnT: +S.turnT.toFixed(2),
      slip: +S.slip.toFixed(2),
      obstacles: obstacles.length,
      hits: S.hitKinds,
      funeral: E.funeral && {
        stopped: +E.funeral.stopped.toFixed(2),
        done: E.funeral.done,
        paid: E.funeral.paid,
        x: E.funeral.mourners.map(m => +m.obj.position.x.toFixed(1)),
      },
      colliders: colliders.map(c => [c.kind, +c.obj.position.x.toFixed(1), +c.obj.position.z.toFixed(0)]),
      caps: S.capQueue.map(c => c.text.slice(0, 24)),
    };
  },
};
