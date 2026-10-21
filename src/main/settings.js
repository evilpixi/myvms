// Configuración: valores por defecto < .env (USER, PASS) < config.json en userData.
// La contraseña guardada desde la app se cifra con safeStorage (DPAPI en Windows).
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { parseEnv } = require('util');

const DEFAULTS = {
  camera: {
    host: '192.168.1.17',
    rtspPort: 554,
    dvripPort: 34567,
    user: 'admin',
    pass: '',
    channel: 1,
    stream: 0,
  },
  rotation: 0,
  ptz: { speed: 5, invertX: true, invertY: false },
  presets: [],
  recording: { enabled: true, dir: '', days: 7 },
  // Vigilancia: recorre los presets marcados con `patrol: true`, cada `interval` segundos.
  // mode: 'loop' (vuelve al primero) o 'yoyo' (ida y vuelta).
  patrol: { active: false, interval: 30, speed: 5, mode: 'loop' },
};

let current = null;

const configFile = () => path.join(app.getPath('userData'), 'config.json');
const defaultRecordDir = () => path.join(app.getPath('videos'), 'myvms');

// Dónde se busca el .env: junto al exe portable, al lado del ejecutable o en la raíz del proyecto (desarrollo).
function envDirs() {
  return [process.env.PORTABLE_EXECUTABLE_DIR, path.dirname(process.execPath), app.getAppPath()].filter(Boolean);
}

function readEnv() {
  for (const dir of envDirs()) {
    const file = path.join(dir, '.env');
    if (fs.existsSync(file)) {
      try {
        return { vars: parseEnv(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')), file };
      } catch (e) {
        console.error(`.env ilegible (${file}):`, e.message);
      }
    }
  }
  return { vars: {}, file: null };
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2));
}

function decodeCamera(stored = {}) {
  const { passEnc, ...rest } = stored;
  if (passEnc) {
    try {
      rest.pass = safeStorage.decryptString(Buffer.from(passEnc, 'base64'));
    } catch {
      // Config copiada desde otro usuario/equipo: se ignora la contraseña.
    }
  }
  return rest;
}

// De dónde salieron usuario/contraseña, para mostrarlo en Ajustes y en los errores.
let credSource = { kind: 'default' };

// Prioridad de credenciales: .env (si existe) > guardadas en config.json > por defecto.
// Lo que trae un .env se guarda cifrado, así el exe portable funciona en este equipo
// aunque no tenga un .env al lado (la config la comparten npm start y el exe).
function load() {
  const { vars: env, file: envFile } = readEnv();
  const cfg = readConfig();
  const stored = decodeCamera(cfg.camera);
  const camera = { ...DEFAULTS.camera, ...stored };
  if (envFile && env.USER) {
    camera.user = env.USER;
    camera.pass = env.PASS ?? '';
    credSource = { kind: 'env', file: envFile };
  } else if (stored.user) {
    credSource = { kind: 'config' };
  } else {
    credSource = { kind: 'default', searched: envDirs() };
  }
  current = {
    ...DEFAULTS,
    ...cfg,
    camera,
    ptz: { ...DEFAULTS.ptz, ...cfg.ptz },
    recording: { ...DEFAULTS.recording, ...cfg.recording },
    patrol: { ...DEFAULTS.patrol, ...cfg.patrol },
    presets: Array.isArray(cfg.presets) ? cfg.presets : [],
  };
  if (!current.recording.dir) current.recording.dir = defaultRecordDir();
  if (credSource.kind === 'env' && (stored.user !== camera.user || stored.pass !== camera.pass || stored.host !== camera.host)) {
    const file = credSource.file;
    setCamera({ host: camera.host, user: camera.user, pass: camera.pass });
    credSource = { kind: 'env', file };
  }
  return current;
}

function get() {
  return current || load();
}

// Persiste solo las claves recibidas (sin tocar lo demás del archivo).
function set(patch) {
  const cfg = { ...readConfig(), ...patch };
  writeConfig(cfg);
  current = { ...get(), ...patch };
  return current;
}

function setCamera({ host, user, pass }) {
  const cam = { ...get().camera, host, user };
  if (typeof pass === 'string') cam.pass = pass;
  const stored = { host: cam.host, user: cam.user };
  if (safeStorage.isEncryptionAvailable()) {
    stored.passEnc = safeStorage.encryptString(cam.pass).toString('base64');
  } else {
    stored.pass = cam.pass;
  }
  writeConfig({ ...readConfig(), camera: stored });
  current = { ...get(), camera: cam };
  credSource = { kind: 'config' };
  return cam;
}

function rtspUrl(cam = get().camera) {
  const q = (v) => encodeURIComponent(v);
  return `rtsp://${cam.host}:${cam.rtspPort}/user=${q(cam.user)}&password=${q(cam.pass)}` +
    `&channel=${cam.channel}&stream=${cam.stream}.sdp`;
}

// Vista segura para el renderer: nunca incluye la contraseña.
function publicView() {
  const s = get();
  return {
    rotation: s.rotation,
    ptz: s.ptz,
    presets: s.presets,
    recording: s.recording,
    patrol: s.patrol,
    camera: { host: s.camera.host, user: s.camera.user, hasPass: !!s.camera.pass, source: describeSource() },
  };
}

function describeSource() {
  if (credSource.kind === 'config') return 'guardadas en la app';
  if (credSource.kind === 'env') return `.env (${credSource.file}), también guardadas en la app`;
  // La primera carpeta es la del exe (o la del proyecto en desarrollo); las otras son internas.
  return `por defecto (usuario admin): no hay .env en ${(credSource.searched || [])[0] || '?'}`;
}

module.exports = { load, get, set, setCamera, rtspUrl, publicView, describeSource };
