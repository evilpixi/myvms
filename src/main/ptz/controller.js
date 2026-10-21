// Control PTZ de alto nivel sobre DvripClient: conexión perezosa, comandos en serie,
// un solo movimiento activo y stop de seguridad.
const { EventEmitter } = require('events');
const { DvripClient } = require('./dvrip');

const DIRECTIONS = new Set([
  'DirectionUp', 'DirectionDown', 'DirectionLeft', 'DirectionRight',
  'DirectionLeftUp', 'DirectionLeftDown', 'DirectionRightUp', 'DirectionRightDown',
]);
const MAX_MOVE_MS = 60000;

function check(r) {
  if (!r || r.Ret !== 100) throw new Error(`la cámara respondió Ret=${r && r.Ret}`);
  return r;
}

class PtzController extends EventEmitter {
  constructor(getCamera) {
    super();
    this.getCamera = getCamera;
    this.client = null;
    this.connecting = null;
    this.chain = Promise.resolve();
    this.active = null;
  }

  _client() {
    if (this.client) return Promise.resolve(this.client);
    if (!this.connecting) {
      const cam = this.getCamera();
      const c = new DvripClient({ host: cam.host, port: cam.dvripPort, user: cam.user, password: cam.pass });
      c.on('error', () => {});
      c.on('close', () => {
        if (this.client === c) {
          this.client = null;
          this.emit('status', { state: 'disconnected' });
        }
      });
      this.connecting = c.connect()
        .then(() => c.login())
        .then(() => {
          this.client = c;
          this.emit('status', { state: 'ok' });
          return c;
        })
        .catch((err) => {
          c.close();
          this.emit('status', { state: 'error', message: err.message });
          throw err;
        })
        .finally(() => { this.connecting = null; });
    }
    return this.connecting;
  }

  // Encola fn(client) detrás de los comandos anteriores para respetar el orden start/stop.
  _run(fn) {
    const p = this.chain.then(() => this._client()).then(fn);
    this.chain = p.catch(() => {});
    return p;
  }

  move(dir, step = 5) {
    if (!DIRECTIONS.has(dir)) return Promise.reject(new Error(`dirección inválida: ${dir}`));
    step = Math.max(1, Math.min(8, Math.round(step)));
    if (this.active && this.active.dir === dir) return Promise.resolve();
    const prev = this.active;
    const next = { dir, step, started: false };
    this.active = next;
    clearTimeout(this.safety);
    this.safety = setTimeout(() => this.stop(), MAX_MOVE_MS);
    return this._run(async (c) => {
      if (prev && prev.started) await c.stopMove(prev.dir, prev.step);
      check(await c.startMove(dir, step));
      next.started = true;
    });
  }

  // Solo manda stop si el start llegó: un "-1" suelto puede mover la cámara.
  stop() {
    const prev = this.active;
    if (!prev) return Promise.resolve();
    this.active = null;
    clearTimeout(this.safety);
    return this._run(async (c) => {
      if (prev.started) check(await c.stopMove(prev.dir, prev.step));
    });
  }

  gotoPreset(n, step = 5) {
    this.stop();
    step = Math.max(1, Math.min(8, Math.round(step)));
    return this._run(async (c) => check(await c.gotoPreset(n, step)));
  }

  setPreset(n) {
    this.stop();
    return this._run(async (c) => check(await c.setPreset(n)));
  }

  clearPreset(n) {
    return this._run(async (c) => check(await c.clearPreset(n)));
  }

  // Devuelve [{ number, name }] con los presets guardados en la cámara.
  listPresets() {
    return this._run(async (c) => {
      const r = check(await c.getInfo('Uart.PTZPreset', 1042));
      const list = (r['Uart.PTZPreset'] || [])[0] || [];
      return list.filter(Boolean).map((p) => ({ number: p.Id, name: p.PresetName || `Preset ${p.Id}` }));
    });
  }

  reset() {
    this.active = null;
    clearTimeout(this.safety);
    if (this.client) this.client.close();
    this.client = null;
  }
}

module.exports = { PtzController, DIRECTIONS };
