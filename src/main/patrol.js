// Vigilancia: recorre en orden los presets marcados, uno cada `interval` segundos.
// Vive en la app (no usa los recorridos de la cámara) y solo manda GotoPreset,
// así que no toca la grabación.
const { EventEmitter } = require('events');

const MIN_INTERVAL = 5;
const MAX_INTERVAL = 3600;

class Patrol extends EventEmitter {
  // getPresets() -> [{ id, name, number, patrol }], getConfig() -> { interval, speed }
  constructor({ ptz, getPresets, getConfig }) {
    super();
    this.ptz = ptz;
    this.getPresets = getPresets;
    this.getConfig = getConfig;
    this.active = false;
    this.currentId = null;
    this.nextAt = null;
    this.timer = null;
    this.lastError = null;
  }

  stops() {
    return this.getPresets().filter((p) => p.patrol);
  }

  start() {
    if (!this.stops().length) throw new Error('Marcá al menos una posición para la vigilancia');
    this.active = true;
    this._next();
  }

  stop(reason = null) {
    const was = this.active;
    this.active = false;
    this.nextAt = null;
    clearTimeout(this.timer);
    if (was) this.emit('stopped', reason);
    this._emit(reason);
  }

  // Si cambió el intervalo, reprograma el próximo salto sin repetir la posición actual.
  reschedule() {
    if (!this.active) return;
    clearTimeout(this.timer);
    this._schedule();
  }

  _schedule() {
    const ms = interval(this.getConfig()) * 1000;
    this.nextAt = Date.now() + ms;
    this.timer = setTimeout(() => this._next(), ms);
    this._emit();
  }

  _next() {
    if (!this.active) return;
    const list = this.stops();
    if (!list.length) {
      this.stop('no quedan posiciones marcadas');
      return;
    }
    const target = list[this._nextIndex(list)];
    this.currentId = target.id;
    this.ptz.gotoPreset(target.number, this.getConfig().speed)
      .then(() => { this.lastError = null; })
      .catch((e) => {
        // Si la cámara no responde se sigue intentando en el próximo salto; avisa una vez.
        if (this.lastError !== e.message) this.emit('error', e);
        this.lastError = e.message;
      });
    this._schedule();
  }

  // Sigue después de la última visitada; si se desmarcó, vuelve al principio.
  // 'loop': A B C A B C…   'yoyo': A B C B A B… (sin repetir los extremos)
  _nextIndex(list) {
    const n = list.length;
    const i = list.findIndex((p) => p.id === this.currentId);
    if (i < 0 || n === 1) {
      this.direction = 1;
      return 0;
    }
    if (this.getConfig().mode !== 'yoyo') return (i + 1) % n;
    if (this.direction !== -1) this.direction = 1;
    if (i + this.direction >= n || i + this.direction < 0) this.direction = -this.direction;
    return i + this.direction;
  }

  status(reason = null) {
    return {
      active: this.active,
      currentId: this.currentId,
      nextAt: this.nextAt,
      count: this.stops().length,
      reason,
    };
  }

  _emit(reason = null) {
    this.emit('status', this.status(reason));
  }
}

function interval(cfg) {
  return Math.max(MIN_INTERVAL, Math.min(MAX_INTERVAL, Number(cfg.interval) || 30));
}

module.exports = { Patrol, MIN_INTERVAL, MAX_INTERVAL };
