// Cliente mínimo del protocolo DVRIP/Sofia (cámaras Xiongmai/XMEye, TCP 34567).
// Paquete: encabezado de 20 bytes + JSON terminado en "\n\0".
//   u8 0xFF | u8 versión | 2 reservados | u32 sesión | u32 secuencia | 2 reservados | u16 msgId | u32 largo
const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const MSG = {
  LOGIN: 1000,
  KEEPALIVE: 1006,
  SYSINFO: 1020,
  ABILITY: 1360,
  PTZ: 1400,
};

// Códigos de login de Xiongmai. En la práctica 205 aparece también con un usuario que no existe.
const LOGIN_ERRORS = {
  106: 'usuario o contraseña incorrectos',
  203: 'contraseña incorrecta',
  204: 'usuario inválido',
  205: 'usuario bloqueado o inexistente',
  206: 'usuario en lista negra',
};

function sofiaHash(password) {
  const d = crypto.createHash('md5').update(password, 'utf8').digest();
  let out = '';
  for (let i = 0; i < 8; i++) {
    const n = (d[2 * i] + d[2 * i + 1]) % 62;
    out += String.fromCharCode(n < 10 ? 48 + n : n < 36 ? 55 + n : 61 + n);
  }
  return out;
}

class DvripClient extends EventEmitter {
  constructor({ host, port = 34567, user = 'admin', password = '', timeout = 5000 } = {}) {
    super();
    Object.assign(this, { host, port, user, password, timeout });
    this.session = 0;
    this.seq = 0;
    this.buf = Buffer.alloc(0);
    this.pending = [];
    this.socket = null;
    this.keepaliveTimer = null;
  }

  get sessionHex() {
    return '0x' + this.session.toString(16).toUpperCase().padStart(8, '0');
  }

  connect() {
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host: this.host, port: this.port });
      s.setNoDelay(true);
      const onErr = (e) => { s.destroy(); reject(e); };
      s.setTimeout(this.timeout, () => onErr(new Error('timeout de conexión')));
      s.once('error', onErr);
      s.once('connect', () => {
        s.setTimeout(0);
        s.off('error', onErr);
        s.on('error', (e) => this.emit('error', e));
        s.on('close', () => this._onClose());
        s.on('data', (d) => this._onData(d));
        this.socket = s;
        resolve();
      });
    });
  }

  async login() {
    const r = await this.request(MSG.LOGIN, {
      EncryptType: 'MD5',
      LoginType: 'DVRIP-Web',
      PassWord: sofiaHash(this.password),
      UserName: this.user,
    });
    if (r.Ret !== 100) {
      const why = LOGIN_ERRORS[r.Ret] || 'login rechazado';
      throw new Error(`${why} (usuario "${this.user}", código ${r.Ret})`);
    }
    this.session = parseInt(r.SessionID, 16);
    const interval = (r.AliveInterval || 20) * 1000;
    this.keepaliveTimer = setInterval(() => {
      this.request(MSG.KEEPALIVE, { Name: 'KeepAlive', SessionID: this.sessionHex })
        .catch((e) => this.emit('error', e));
    }, interval);
    return r;
  }

  getInfo(name, msgId = MSG.SYSINFO) {
    return this.request(msgId, { Name: name, SessionID: this.sessionHex });
  }

  // cmd: DirectionUp/Down/Left/Right, DirectionLeftUp..., ZoomTile/ZoomWide, SetPreset/GotoPreset/ClearPreset
  ptz(cmd, { preset = -1, step = 5, channel = 0 } = {}) {
    return this.request(MSG.PTZ, {
      Name: 'OPPTZControl',
      SessionID: this.sessionHex,
      OPPTZControl: {
        Command: cmd,
        Parameter: {
          AUX: { Number: 0, Status: 'On' },
          Channel: channel,
          MenuOpts: 'Enter',
          POINT: { bottom: 0, left: 0, right: 0, top: 0 },
          Pattern: 'SetBegin',
          Preset: preset,
          Step: step,
          Tour: 0,
        },
      },
    });
  }

  // Preset 65535 arranca el movimiento y sigue hasta recibir el mismo comando con Preset -1.
  // Verificado en la cámara: -1 sin un inicio previo también puede mover, así que nunca
  // mandar "stops de seguridad" con 65535.
  startMove(dir, step = 5) { return this.ptz(dir, { preset: 65535, step }); }
  stopMove(dir, step = 5) { return this.ptz(dir, { preset: -1, step }); }
  gotoPreset(n, step = 5) { return this.ptz('GotoPreset', { preset: n, step }); }
  setPreset(n) { return this.ptz('SetPreset', { preset: n }); }
  clearPreset(n) { return this.ptz('ClearPreset', { preset: n }); }

  request(msgId, payload) {
    if (!this.socket) return Promise.reject(new Error('no conectado'));
    const body = Buffer.concat([Buffer.from(JSON.stringify(payload)), Buffer.from([0x0a, 0x00])]);
    const head = Buffer.alloc(20);
    head.writeUInt8(0xff, 0);
    head.writeUInt8(0x00, 1);
    head.writeUInt32LE(this.session, 4);
    head.writeUInt32LE(this.seq++, 8);
    head.writeUInt16LE(msgId, 14);
    head.writeUInt32LE(body.length, 16);
    return new Promise((resolve, reject) => {
      const entry = { reply: msgId + 1, resolve, reject };
      entry.timer = setTimeout(() => {
        this.pending = this.pending.filter((p) => p !== entry);
        reject(new Error(`sin respuesta a msg ${msgId}`));
      }, this.timeout);
      this.pending.push(entry);
      this.socket.write(Buffer.concat([head, body]));
    });
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 20) {
      const len = this.buf.readUInt32LE(16);
      if (this.buf.length < 20 + len) break;
      const msgId = this.buf.readUInt16LE(14);
      const raw = this.buf.subarray(20, 20 + len).toString('utf8').replace(/[\n\0]+$/, '');
      this.buf = this.buf.subarray(20 + len);
      let data;
      try { data = JSON.parse(raw); } catch { data = { raw }; }
      const i = this.pending.findIndex((p) => p.reply === msgId);
      if (i >= 0) {
        const [p] = this.pending.splice(i, 1);
        clearTimeout(p.timer);
        p.resolve(data);
      } else {
        this.emit('message', msgId, data);
      }
    }
  }

  _onClose() {
    clearInterval(this.keepaliveTimer);
    this.socket = null;
    this.pending.forEach((p) => { clearTimeout(p.timer); p.reject(new Error('conexión cerrada')); });
    this.pending = [];
    this.emit('close');
  }

  close() {
    clearInterval(this.keepaliveTimer);
    if (this.socket) this.socket.end();
  }
}

module.exports = { DvripClient, sofiaHash, MSG };
