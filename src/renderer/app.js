// `api` es el global que expone el preload (window.api).
const $ = (id) => document.getElementById(id);
const video = $('video');
const stage = $('stage');
const overlay = $('overlay');
const statusEl = $('status');
const statsEl = $('stats');

let cfg = null;

// ---------- Avisos ----------
let toastTimer;
function toast(msg, kind = 'err') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 4000);
}
const errMsg = (e) => String(e && e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const report = (e) => toast(errMsg(e));

// ---------- Estado de conexión / grabación ----------
const STATUS_TEXT = { connecting: 'Conectando…', live: 'En vivo', error: 'Sin señal' };

api.live.onStatus((s) => {
  statusEl.className = `status ${s.state}`;
  statusEl.textContent = STATUS_TEXT[s.state] || s.state;
  statusEl.title = s.message || '';
  const recOn = s.state === 'live' && s.recording;
  $('rec-badge').className = `rec-badge ${recOn ? 'on' : 'off'}`;
  $('float-rec').className = `float-rec ${recOn ? '' : 'off'}`;
  if (s.state === 'error') {
    overlay.textContent = `Sin señal: ${s.message || 'error'} — reintentando…`;
    overlay.classList.remove('hidden');
  } else if (s.state === 'connecting' && !video.videoWidth) {
    overlay.textContent = 'Conectando con la cámara…';
    overlay.classList.remove('hidden');
  }
  refreshRecInfo();
});
api.rec.onError((m) => toast(m));

video.addEventListener('playing', () => overlay.classList.add('hidden'));

const player = new window.LivePlayer(video, {
  onState: (s) => { if (s.fallback) overlay.textContent = 'Cambiando a H.264…'; },
});

setInterval(() => {
  if (!video.videoWidth) { statsEl.textContent = ''; return; }
  const q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : {};
  statsEl.textContent = `${video.videoWidth}x${video.videoHeight} · ${player.codec} · ` +
    `${player.mode === 'copy' ? 'directo' : 'recodificado'} · búfer ${player.latency.toFixed(1)}s · ` +
    `cuadros ${q.totalVideoFrames ?? '?'}`;
}, 1000);

// ---------- Rotación ----------
let rotation = 0;

function layoutVideo() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const sideways = rotation % 180 !== 0;
  // De costado, el <video> se dimensiona con los lados intercambiados para que entre al rotar.
  video.style.width = `${sideways ? h : w}px`;
  video.style.height = `${sideways ? w : h}px`;
  video.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
  $('rot-value').textContent = `${rotation}°`;
}

function rotate(delta) {
  rotation = (rotation + delta + 360) % 360;
  layoutVideo();
  api.settings.set({ rotation }).catch(report);
}

$('rot-left').addEventListener('click', () => rotate(-90));
$('rot-right').addEventListener('click', () => rotate(90));
new ResizeObserver(layoutVideo).observe(stage);

// ---------- PTZ ----------
// Convierte una dirección en pantalla (x derecha, y abajo) a un comando de la cámara,
// deshaciendo la rotación de la vista y aplicando la inversión de ejes de la instalación.
function cameraDirection(sx, sy) {
  const t = (-rotation * Math.PI) / 180;
  let x = Math.round(sx * Math.cos(t) - sy * Math.sin(t));
  let y = Math.round(sx * Math.sin(t) + sy * Math.cos(t));
  if (cfg.ptz.invertX) x = -x;
  if (cfg.ptz.invertY) y = -y;
  const h = x < 0 ? 'Left' : x > 0 ? 'Right' : '';
  const v = y < 0 ? 'Up' : y > 0 ? 'Down' : '';
  return h || v ? `Direction${h}${v}` : null;
}

let moving = null;
function setMove(vec) {
  const dir = vec ? cameraDirection(vec[0], vec[1]) : null;
  if (dir === moving) return;
  moving = dir;
  $('ptz-state').textContent = dir ? 'moviendo…' : '';
  (dir ? api.ptz.move(dir) : api.ptz.stop()).catch(report);
}

// Vale para las flechas del panel y para las de los controles flotantes.
for (const btn of document.querySelectorAll('.dpad button')) {
  const vec = [Number(btn.dataset.x), Number(btn.dataset.y)];
  btn.addEventListener('pointerdown', (e) => {
    btn.setPointerCapture(e.pointerId);
    btn.classList.add('pressed');
    setMove(vec);
  });
  const release = () => { btn.classList.remove('pressed'); setMove(null); };
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
  btn.addEventListener('lostpointercapture', release);
}

const ARROWS = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
const held = new Set();
function arrowsChanged() {
  let x = 0;
  let y = 0;
  for (const k of held) { x += ARROWS[k][0]; y += ARROWS[k][1]; }
  setMove(x || y ? [Math.sign(x), Math.sign(y)] : null);
}

const speed = $('speed');
speed.addEventListener('input', () => { $('speed-value').textContent = speed.value; });
speed.addEventListener('change', () => {
  api.settings.set({ ptz: { speed: Number(speed.value) } }).then((s) => { cfg = s; }).catch(report);
});

api.ptz.onStatus((s) => {
  if (s.state === 'error') toast(`PTZ: ${s.message}`);
});

// Si se pierde el foco con una flecha apretada, frenar.
window.addEventListener('blur', () => { held.clear(); setMove(null); });

// ---------- Presets ----------
let presets = [];

function renderPresets() {
  const ul = $('presets');
  ul.replaceChildren();
  presets.forEach((p, i) => {
    const li = document.createElement('li');
    li.className = 'preset';
    if (isPatrolTarget(p)) li.classList.add('current');

    const chk = document.createElement('button');
    chk.className = `patrol-check ${p.patrol ? 'on' : ''}`;
    chk.textContent = p.patrol ? '◉' : '○';
    chk.title = p.patrol ? 'En la vigilancia (clic para quitar)' : 'Agregar a la vigilancia';
    chk.addEventListener('click', () => api.presets.setPatrol(p.id, !p.patrol).then(setPresets).catch(report));

    const go = document.createElement('button');
    go.className = 'go';
    go.title = `Ir a "${p.name}" (posición ${p.number} en la cámara)`;
    const key = document.createElement('span');
    key.className = 'key';
    key.textContent = i < 9 ? String(i + 1) : '';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = p.name;
    go.append(key, name);
    go.addEventListener('click', () => gotoPreset(p));

    const tools = document.createElement('span');
    tools.className = 'tools';
    const tool = (label, title, fn, cls = '') => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      if (cls) b.className = cls;
      b.addEventListener('click', fn);
      tools.append(b);
    };
    tool('✎', 'Renombrar', () => startRename(li, p));
    tool('⌖', 'Reemplazar con la posición actual', () => {
      api.presets.overwrite(p.id).then(() => toast(`"${p.name}" actualizado`, 'info')).catch(report);
    });
    tool('↑', 'Subir', () => api.presets.move(p.id, -1).then(setPresets).catch(report));
    tool('↓', 'Bajar', () => api.presets.move(p.id, 1).then(setPresets).catch(report));
    tool('✕', 'Borrar', () => {
      if (confirm(`¿Borrar el preset "${p.name}"? También se borra de la cámara.`)) {
        api.presets.remove(p.id).then(setPresets).catch(report);
      }
    }, 'danger');

    li.append(chk, go, tools);
    ul.append(li);
  });
  renderFloatPresets();
  renderPatrol();
}

// Versión solo-ir de los presets para los controles flotantes.
function renderFloatPresets() {
  const box = $('float-presets');
  box.replaceChildren();
  presets.forEach((p, i) => {
    const b = document.createElement('button');
    b.title = `Ir a "${p.name}"`;
    if (isPatrolTarget(p)) b.className = 'current';
    const key = document.createElement('span');
    key.className = 'key';
    key.textContent = i < 9 ? String(i + 1) : '';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = p.name;
    b.append(key, name);
    b.addEventListener('click', () => gotoPreset(p));
    box.append(b);
  });
}

function setPresets(list) {
  presets = list || [];
  renderPresets();
}

function gotoPreset(p) {
  setMove(null);
  api.presets.goto(p.id).catch(report);
}

function startRename(li, p) {
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 40;
  input.value = p.name;
  li.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v && v !== p.name) api.presets.rename(p.id, v).then(setPresets).catch(report);
    else renderPresets();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

$('preset-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('preset-name');
  const btn = e.submitter;
  btn.disabled = true;
  api.presets.add(input.value)
    .then((list) => { setPresets(list); input.value = ''; toast('Posición guardada', 'info'); })
    .catch(report)
    .finally(() => { btn.disabled = false; });
});

$('presets-sync').addEventListener('click', () => {
  api.presets.sync().then((list) => { setPresets(list); toast('Presets sincronizados con la cámara', 'info'); }).catch(report);
});

api.presets.onChanged(setPresets);

// ---------- Vigilancia ----------
let patrolState = { active: false, currentId: null, nextAt: null, count: 0 };

function isPatrolTarget(p) {
  return patrolState.active && patrolState.currentId === p.id;
}

function renderPatrolInfo() {
  const marked = presets.filter((p) => p.patrol).length;
  let text;
  if (patrolState.active) {
    const cur = presets.find((p) => p.id === patrolState.currentId);
    const secs = patrolState.nextAt ? Math.max(0, Math.ceil((patrolState.nextAt - Date.now()) / 1000)) : 0;
    text = `En ${cur ? cur.name : '—'} · siguiente en ${secs} s · ${marked} posiciones`;
  } else {
    text = marked ? `${marked} posiciones marcadas.` : 'Marcá ◉ al menos una posición en Presets.';
  }
  $('patrol-info').textContent = text;
}

function renderPatrol() {
  const on = patrolState.active;
  $('patrol-on').className = on ? 'active' : '';
  $('patrol-off').className = on ? '' : 'active manual';
  const yoyo = cfg && cfg.patrol.mode === 'yoyo';
  $('patrol-loop').className = yoyo ? '' : 'active mode';
  $('patrol-yoyo').className = yoyo ? 'active mode' : '';
  const fb = $('float-patrol');
  fb.className = `float-patrol ${on ? 'on' : ''}`;
  fb.textContent = on ? '◉ Vigilancia activa' : '✋ Manual · iniciar vigilancia';
  renderPatrolInfo();
}

function setPatrol(active) {
  api.patrol.set({ active }).then((s) => { cfg = s; }).catch(report);
}
const togglePatrol = () => setPatrol(!patrolState.active);

$('patrol-on').addEventListener('click', () => setPatrol(true));
$('patrol-off').addEventListener('click', () => setPatrol(false));
$('float-patrol').addEventListener('click', togglePatrol);

function setPatrolMode(mode) {
  api.patrol.set({ mode }).then((s) => { cfg = s; renderPatrol(); }).catch(report);
}
$('patrol-loop').addEventListener('click', () => setPatrolMode('loop'));
$('patrol-yoyo').addEventListener('click', () => setPatrolMode('yoyo'));

$('patrol-interval').addEventListener('change', (e) => {
  api.patrol.set({ interval: Number(e.target.value) })
    .then((s) => { cfg = s; e.target.value = s.patrol.interval; })
    .catch(report);
});
const patrolSpeed = $('patrol-speed');
patrolSpeed.addEventListener('input', () => { $('patrol-speed-value').textContent = patrolSpeed.value; });
patrolSpeed.addEventListener('change', () => {
  api.patrol.set({ speed: Number(patrolSpeed.value) }).then((s) => { cfg = s; }).catch(report);
});

api.patrol.onStatus((s) => {
  const wasActive = patrolState.active;
  patrolState = s;
  if (wasActive && !s.active && s.reason) {
    toast(s.reason === 'manual' ? 'Vigilancia pausada: control manual' : `Vigilancia detenida: ${s.reason}`, 'info');
  }
  renderPresets();
});
api.patrol.onError((m) => toast(`Vigilancia: ${m}`));
setInterval(() => { if (patrolState.active) renderPatrolInfo(); }, 1000);

// ---------- Grabación ----------
function fmtBytes(n) {
  if (n == null) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i > 2 ? 1 : 0)} ${u[i]}`;
}

async function refreshRecInfo() {
  if (!cfg) return;
  try {
    const info = await api.rec.info();
    const on = cfg.recording.enabled;
    $('rec-info').innerHTML = '';
    const lines = [
      ['Estado', on ? (info.active ? 'grabando' : 'esperando señal') : 'en pausa'],
      ['Usado', `${fmtBytes(info.bytes)} en ${info.files} archivos`],
      ['Libre', fmtBytes(info.free)],
      ['Desde', info.oldest || '—'],
      ['Se borra después de', `${cfg.recording.days} días`],
    ];
    for (const [k, v] of lines) {
      const div = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = v;
      div.append(`${k}: `, b);
      $('rec-info').append(div);
    }
  } catch (e) {
    report(e);
  }
  updateRecButtons();
}
setInterval(refreshRecInfo, 30000);

function updateRecButtons() {
  const on = !!(cfg && cfg.recording.enabled);
  $('rec-start').disabled = on;
  $('rec-stop').disabled = !on;
}

function setRecording(enabled) {
  $('rec-start').disabled = true;
  $('rec-stop').disabled = true;
  api.rec.set({ enabled })
    .then((s) => { cfg = s; toast(enabled ? 'Grabación iniciada' : 'Grabación detenida', 'info'); })
    .catch(report)
    .finally(refreshRecInfo);
}

$('rec-start').addEventListener('click', () => setRecording(true));
$('rec-stop').addEventListener('click', () => setRecording(false));
$('rec-folder').addEventListener('click', () => api.rec.open().catch(report));

// ---------- Ajustes ----------
const dlg = $('settings');
const form = $('settings-form');

$('open-settings').addEventListener('click', () => {
  form.host.value = cfg.camera.host;
  form.user.value = cfg.camera.user;
  form.pass.value = '';
  form.pass.placeholder = cfg.camera.hasPass ? '(sin cambios)' : '(vacía)';
  $('cred-source').textContent = `Credenciales tomadas de: ${cfg.camera.source}`;
  form.invertX.checked = cfg.ptz.invertX;
  form.invertY.checked = cfg.ptz.invertY;
  form.dir.value = cfg.recording.dir;
  form.days.value = cfg.recording.days;
  dlg.showModal();
});
$('settings-cancel').addEventListener('click', () => dlg.close());
$('choose-dir').addEventListener('click', () => {
  api.rec.chooseDir().then((s) => { cfg = s; form.dir.value = s.recording.dir; refreshRecInfo(); }).catch(report);
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const camChanged = form.host.value.trim() !== cfg.camera.host ||
      form.user.value.trim() !== cfg.camera.user || form.pass.value !== '';
    if (camChanged) {
      cfg = await api.settings.setCamera({
        host: form.host.value,
        user: form.user.value,
        pass: form.pass.value === '' ? undefined : form.pass.value,
      });
    }
    cfg = await api.settings.set({ ptz: { invertX: form.invertX.checked, invertY: form.invertY.checked } });
    cfg = await api.rec.set({ days: Number(form.days.value) });
    dlg.close();
    refreshRecInfo();
  } catch (err) {
    report(err);
  }
});

// ---------- Panel / pantalla completa ----------
function togglePanel() {
  $('panel').classList.toggle('hidden');
}
$('toggle-panel').addEventListener('click', togglePanel);

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else stage.requestFullscreen();
}
$('fullscreen').addEventListener('click', toggleFullscreen);
stage.addEventListener('dblclick', toggleFullscreen);

// ---------- Video maximizado + controles flotantes ----------
const floatEl = $('float');
const FLOAT_KEY = 'myvms.float';

function loadFloatState() {
  try { return JSON.parse(localStorage.getItem(FLOAT_KEY)) || {}; } catch { return {}; }
}
function saveFloatState(patch) {
  try { localStorage.setItem(FLOAT_KEY, JSON.stringify({ ...loadFloatState(), ...patch })); } catch { /* sin storage */ }
}

// Mantiene el panel dentro del video; sin posición guardada va arriba a la derecha.
function placeFloat(x, y) {
  const maxX = Math.max(0, stage.clientWidth - floatEl.offsetWidth - 8);
  const maxY = Math.max(0, stage.clientHeight - floatEl.offsetHeight - 8);
  const st = loadFloatState();
  const nx = x ?? st.x ?? maxX - 8;
  const ny = y ?? st.y ?? 16;
  floatEl.style.left = `${Math.min(Math.max(8, nx), maxX)}px`;
  floatEl.style.top = `${Math.min(Math.max(8, ny), maxY)}px`;
}

function setImmersive(on) {
  document.body.classList.toggle('immersive', on);
  // El layout cambia de tamaño: reacomodar video y panel en el próximo frame.
  requestAnimationFrame(() => { layoutVideo(); placeFloat(); });
}
const toggleImmersive = () => setImmersive(!document.body.classList.contains('immersive'));

$('maximize').addEventListener('click', toggleImmersive);
$('float-exit').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  setImmersive(false);
});
$('float-collapse').addEventListener('click', () => {
  const collapsed = floatEl.classList.toggle('collapsed');
  $('float-collapse').textContent = collapsed ? '+' : '–';
  saveFloatState({ collapsed });
  placeFloat();
});
floatEl.addEventListener('dblclick', (e) => e.stopPropagation());
document.addEventListener('fullscreenchange', () => requestAnimationFrame(() => placeFloat()));
new ResizeObserver(() => { if (floatEl.offsetWidth) placeFloat(); }).observe(stage);

// Arrastre desde la cabecera.
const head = $('float-head');
head.addEventListener('pointerdown', (e) => {
  if (e.target.closest('button')) return;
  head.setPointerCapture(e.pointerId);
  floatEl.classList.add('dragging');
  const startX = e.clientX - floatEl.offsetLeft;
  const startY = e.clientY - floatEl.offsetTop;
  const onMove = (ev) => placeFloat(ev.clientX - startX, ev.clientY - startY);
  const onUp = () => {
    head.removeEventListener('pointermove', onMove);
    floatEl.classList.remove('dragging');
    saveFloatState({ x: floatEl.offsetLeft, y: floatEl.offsetTop });
  };
  head.addEventListener('pointermove', onMove);
  head.addEventListener('lostpointercapture', onUp, { once: true });
});

if (loadFloatState().collapsed) {
  floatEl.classList.add('collapsed');
  $('float-collapse').textContent = '+';
}

// ---------- Teclado ----------
document.addEventListener('keydown', (e) => {
  if (dlg.open || e.target.closest('input, textarea')) return;
  if (ARROWS[e.key]) {
    e.preventDefault();
    if (!e.repeat && !held.has(e.key)) { held.add(e.key); arrowsChanged(); }
    return;
  }
  if (e.repeat) return;
  if (e.code === 'KeyR') rotate(e.shiftKey ? -90 : 90);
  else if (e.code === 'KeyF') toggleFullscreen();
  else if (e.code === 'KeyM') toggleImmersive();
  else if (e.code === 'KeyV') togglePatrol();
  else if (e.key === 'Escape' && document.body.classList.contains('immersive')) setImmersive(false);
  else if (e.code === 'KeyP') togglePanel();
  else if (/^Digit[1-9]$/.test(e.code) || /^Numpad[1-9]$/.test(e.code)) {
    const p = presets[Number(e.code.slice(-1)) - 1];
    if (p) gotoPreset(p);
  }
});
document.addEventListener('keyup', (e) => {
  if (ARROWS[e.key] && held.delete(e.key)) arrowsChanged();
});

// ---------- Arranque ----------
(async () => {
  cfg = await api.settings.get();
  rotation = cfg.rotation || 0;
  speed.value = cfg.ptz.speed;
  $('speed-value').textContent = cfg.ptz.speed;
  $('patrol-interval').value = cfg.patrol.interval;
  patrolSpeed.value = cfg.patrol.speed;
  $('patrol-speed-value').textContent = cfg.patrol.speed;
  patrolState = await api.patrol.status();
  setPresets(cfg.presets);
  layoutVideo();
  refreshRecInfo();
  player.start();
})();
