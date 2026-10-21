// Fase 0: login DVRIP, info del equipo y prueba de movimiento con fotos antes/después.
// Uso: node scripts/ptz-test.js [info|move <dir> <ms>|preset <n>]
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const { DvripClient } = require('../src/main/ptz/dvrip');

const { parseEnv } = require('util');

// .env en la raíz (USER, PASS). Se parsea a mano porque USER suele existir ya en el entorno.
const envFile = path.join(__dirname, '..', '.env');
const env = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {};

const HOST = '192.168.1.17';
const USER = env.USER || 'admin';
const PASS = env.PASS ?? '';
const RTSP = `rtsp://${HOST}:554/user=${encodeURIComponent(USER)}&password=${encodeURIComponent(PASS)}&channel=1&stream=1.sdp`;
const OUT = process.env.SNAP_DIR || path.join(__dirname, '..', 'snapshots');

function snapshot(name) {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${name}.jpg`);
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', RTSP,
    '-frames:v', '1', '-q:v', '3', file], { timeout: 20000 });
  return file;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const [mode = 'info', a, b] = process.argv.slice(2);
  const cam = new DvripClient({ host: HOST, user: USER, password: PASS });
  cam.on('message', (id, d) => console.log(`(mensaje no pedido ${id})`, JSON.stringify(d)));
  await cam.connect();
  const login = await cam.login();
  console.log('Login OK:', JSON.stringify(login));

  if (mode === 'info') {
    for (const name of ['SystemInfo']) {
      console.log(`\n${name}:`, JSON.stringify(await cam.getInfo(name, 1020), null, 1));
    }
    for (const name of ['SystemFunction']) {
      console.log(`\n${name}:`, JSON.stringify(await cam.getInfo(name, 1360)));
    }
  } else if (mode === 'move') {
    const dir = a || 'DirectionLeft';
    const ms = Number(b) || 1500;
    console.log('Foto antes:', snapshot('before'));
    console.log(`start ${dir}:`, JSON.stringify(await cam.startMove(dir)));
    await sleep(ms);
    console.log(`stop ${dir}:`, JSON.stringify(await cam.stopMove(dir)));
    await sleep(1500);
    console.log('Foto después:', snapshot('after'));
  } else if (mode === 'preset') {
    console.log(`GotoPreset ${a}:`, JSON.stringify(await cam.gotoPreset(Number(a))));
  }
  cam.close();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
