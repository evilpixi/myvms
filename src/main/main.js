const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const settings = require('./settings');
const { LiveStream } = require('./stream');
const { PtzController } = require('./ptz/controller');
const { Recorder, SEGMENT_SECONDS } = require('./recorder');
const { Patrol, MIN_INTERVAL, MAX_INTERVAL } = require('./patrol');

let win = null;
let live = null;
let ptz = null;
let recorder = null;
let patrol = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 820,
    minWidth: 760,
    minHeight: 460,
    backgroundColor: '#0f1115',
    title: 'myvms',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
  // Si la ventana pierde el foco con una flecha apretada, no queremos la cámara girando.
  win.on('blur', () => ptz && ptz.stop().catch(() => {}));

  if (process.env.MYVMS_DEBUG) {
    win.webContents.on('console-message', (e) => console.log('[renderer]', e.message));
  }

  // Modo de verificación: captura la ventana tras N ms y cierra la app.
  if (process.env.MYVMS_CAPTURE) {
    const delay = Number(process.env.MYVMS_CAPTURE_DELAY || 12000);
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      if (process.env.MYVMS_CAPTURE_JS) {
        await win.webContents.executeJavaScript(process.env.MYVMS_CAPTURE_JS);
        await new Promise((r) => setTimeout(r, 1500));
      }
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.MYVMS_CAPTURE, img.toPNG());
      app.quit();
    }, delay));
  }
}

// ---------- Vista en vivo + grabación ----------
function recordingTarget() {
  const rec = settings.get().recording;
  if (!rec.enabled) return null;
  try {
    recorder.ensureDirs();
  } catch (e) {
    send('rec:error', `No se puede escribir en ${rec.dir}: ${e.message}`);
    return null;
  }
  // MYVMS_SEGMENT_SECONDS solo para pruebas (cortes cortos en vez de 6 h).
  return { pattern: recorder.pattern(), segmentSeconds: Number(process.env.MYVMS_SEGMENT_SECONDS) || SEGMENT_SECONDS };
}

function setupLive() {
  recorder = new Recorder(() => settings.get().recording);
  recorder.startMaintenance();
  live = new LiveStream(settings.rtspUrl(), recordingTarget);
  live.on('init', (m) => send('live:init', m));
  live.on('segment', (data) => send('live:data', data));
  live.on('status', (s) => {
    if (process.env.MYVMS_DEBUG) console.log('[live]', JSON.stringify(s));
    send('live:status', s);
  });
}

ipcMain.on('live:start', (_e, mode) => live.restart(mode === 'h264' ? 'h264' : 'copy'));

// ---------- Ajustes ----------
ipcMain.handle('settings:get', () => settings.publicView());

ipcMain.handle('settings:set', (_e, patch = {}) => {
  const allowed = {};
  if ([0, 90, 180, 270].includes(patch.rotation)) allowed.rotation = patch.rotation;
  if (patch.ptz) {
    const cur = settings.get().ptz;
    allowed.ptz = {
      speed: Math.max(1, Math.min(8, Number(patch.ptz.speed ?? cur.speed) || cur.speed)),
      invertX: !!(patch.ptz.invertX ?? cur.invertX),
      invertY: !!(patch.ptz.invertY ?? cur.invertY),
    };
  }
  settings.set(allowed);
  return settings.publicView();
});

ipcMain.handle('camera:set', (_e, { host, user, pass }) => {
  if (!host || !user) throw new Error('Faltan host o usuario');
  settings.setCamera({ host: String(host).trim(), user: String(user).trim(), pass: pass === undefined ? undefined : String(pass) });
  ptz.reset();
  live.url = settings.rtspUrl();
  live.restart();
  syncPresets();
  return settings.publicView();
});

// ---------- Grabación ----------
ipcMain.handle('rec:set', (_e, patch = {}) => {
  const cur = settings.get().recording;
  const next = {
    ...cur,
    enabled: patch.enabled ?? cur.enabled,
    days: Math.max(1, Math.min(365, Math.round(Number(patch.days ?? cur.days) || cur.days))),
  };
  const restart = next.enabled !== cur.enabled;
  settings.set({ recording: next });
  if (restart) live.restart();
  else recorder.cleanup();
  return settings.publicView();
});

ipcMain.handle('rec:chooseDir', async () => {
  const cur = settings.get().recording;
  const r = await dialog.showOpenDialog(win, {
    title: 'Carpeta de grabaciones',
    defaultPath: cur.dir,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return settings.publicView();
  settings.set({ recording: { ...cur, dir: r.filePaths[0] } });
  live.restart();
  return settings.publicView();
});

ipcMain.handle('rec:info', async () => ({ ...(await recorder.info()), active: live.recording }));
ipcMain.handle('rec:open', async () => {
  fs.mkdirSync(recorder.dir, { recursive: true });
  return shell.openPath(recorder.dir);
});

// ---------- Vigilancia ----------
function setupPatrol() {
  patrol = new Patrol({
    ptz,
    getPresets: () => settings.get().presets,
    getConfig: () => settings.get().patrol,
  });
  patrol.on('status', (s) => send('patrol:status', s));
  patrol.on('error', (e) => send('patrol:error', e.message));
  // Al frenarse (manual o sin posiciones) queda guardado como inactiva.
  patrol.on('stopped', () => settings.set({ patrol: { ...settings.get().patrol, active: false } }));
}

// Cualquier acción manual sobre la cámara pasa a control manual.
function takeManualControl() {
  if (patrol && patrol.active) patrol.stop('manual');
}

ipcMain.handle('patrol:status', () => patrol.status());

ipcMain.handle('patrol:set', (_e, patch = {}) => {
  const cur = settings.get().patrol;
  const next = {
    active: patch.active ?? cur.active,
    interval: Math.max(MIN_INTERVAL, Math.min(MAX_INTERVAL, Math.round(Number(patch.interval ?? cur.interval) || cur.interval))),
    speed: Math.max(1, Math.min(8, Math.round(Number(patch.speed ?? cur.speed) || cur.speed))),
    mode: ['loop', 'yoyo'].includes(patch.mode) ? patch.mode : cur.mode,
  };
  settings.set({ patrol: next });
  if (next.active && !patrol.active) {
    try {
      patrol.start();
    } catch (e) {
      settings.set({ patrol: { ...next, active: false } });
      throw e;
    }
  } else if (!next.active && patrol.active) {
    patrol.stop();
  } else if (next.interval !== cur.interval) {
    patrol.reschedule();
  }
  return settings.publicView();
});

// ---------- PTZ ----------
ipcMain.handle('ptz:move', (_e, dir) => {
  takeManualControl();
  return ptz.move(dir, settings.get().ptz.speed);
});
ipcMain.handle('ptz:stop', () => ptz.stop());

// ---------- Presets ----------
const presets = () => settings.get().presets;
const savePresets = (list) => { settings.set({ presets: list }); send('presets:changed', list); return list; };

function freeNumber(taken) {
  for (let n = 1; n < 256; n++) if (!taken.has(n)) return n;
  throw new Error('No quedan posiciones de preset libres en la cámara');
}

// Agrega a la lista local los presets que la cámara tiene y la app no conoce.
async function syncPresets() {
  try {
    const onCam = await ptz.listPresets();
    const list = [...presets()];
    const known = new Set(list.map((p) => p.number));
    let changed = false;
    for (const p of onCam) {
      if (!known.has(p.number)) {
        list.push({ id: crypto.randomUUID(), name: p.name, number: p.number });
        changed = true;
      }
    }
    if (changed) savePresets(list);
    return onCam;
  } catch (e) {
    console.error('syncPresets:', e.message);
    return null;
  }
}

ipcMain.handle('presets:goto', (_e, id) => {
  const p = presets().find((x) => x.id === id);
  if (!p) throw new Error('Preset inexistente');
  takeManualControl();
  return ptz.gotoPreset(p.number, settings.get().patrol.speed);
});

ipcMain.handle('presets:setPatrol', (_e, id, on) => {
  const list = savePresets(presets().map((p) => (p.id === id ? { ...p, patrol: !!on } : p)));
  patrol.reschedule();
  return list;
});

ipcMain.handle('presets:add', async (_e, name) => {
  const onCam = (await ptz.listPresets().catch(() => [])) || [];
  const taken = new Set([...presets().map((p) => p.number), ...onCam.map((p) => p.number)]);
  const number = freeNumber(taken);
  await ptz.setPreset(number);
  const clean = String(name || '').trim() || `Preset ${number}`;
  return savePresets([...presets(), { id: crypto.randomUUID(), name: clean.slice(0, 40), number }]);
});

ipcMain.handle('presets:overwrite', async (_e, id) => {
  const p = presets().find((x) => x.id === id);
  if (!p) throw new Error('Preset inexistente');
  await ptz.setPreset(p.number);
  return presets();
});

ipcMain.handle('presets:rename', (_e, id, name) => {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) return presets();
  return savePresets(presets().map((p) => (p.id === id ? { ...p, name: clean } : p)));
});

ipcMain.handle('presets:delete', async (_e, id) => {
  const p = presets().find((x) => x.id === id);
  if (!p) return presets();
  await ptz.clearPreset(p.number).catch((e) => console.error('ClearPreset:', e.message));
  return savePresets(presets().filter((x) => x.id !== id));
});

ipcMain.handle('presets:move', (_e, id, delta) => {
  const list = [...presets()];
  const i = list.findIndex((p) => p.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return list;
  [list[i], list[j]] = [list[j], list[i]];
  return savePresets(list);
});

ipcMain.handle('presets:sync', async () => {
  const r = await syncPresets();
  if (!r) throw new Error('No se pudo leer la lista de la cámara');
  return presets();
});

// ---------- Ciclo de vida ----------
app.whenReady().then(() => {
  settings.load();
  ptz = new PtzController(() => settings.get().camera);
  ptz.on('status', (s) => {
    // Con un login fallido, decir de dónde salieron las credenciales y cómo arreglarlo.
    if (s.state === 'error' && /usuario|contraseña/.test(s.message)) {
      s = { ...s, message: `${s.message}. Credenciales tomadas de: ${settings.describeSource()}. ` +
        'Cargalas en ⚙ Ajustes o poné un .env junto al ejecutable.' };
    }
    send('ptz:status', s);
  });
  setupPatrol();
  setupLive();
  createWindow();
  syncPresets().finally(() => {
    // Retoma la vigilancia si estaba activa al cerrar la app.
    if (settings.get().patrol.active) {
      try { patrol.start(); } catch { settings.set({ patrol: { ...settings.get().patrol, active: false } }); }
    }
  });
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  recorder && recorder.stopMaintenance();
  // Frena el timer sin marcarla inactiva: al reabrir la app retoma.
  if (patrol) { patrol.removeAllListeners('stopped'); patrol.stop(); }
  Promise.allSettled([
    ptz ? ptz.stop() : null,
    live ? live.stopGracefully() : null,
  ]).finally(() => {
    if (ptz) ptz.reset();
    app.exit(0);
  });
});

app.on('window-all-closed', () => app.quit());
