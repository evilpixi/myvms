// Proceso ffmpeg que convierte el RTSP en MP4 fragmentado para MediaSource.
// Emite 'init' ({ mime, data }) una vez por conexión, 'segment' (moof+mdat) y 'status'.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

const STALL_MS = 10000;
const MAX_BACKOFF_MS = 30000;

function hex(n) {
  return n.toString(16).toUpperCase().padStart(2, '0');
}

// Arma el string de códec RFC 6381 a partir de la caja hvcC/avcC del moov.
function codecFromMoov(moov) {
  let i = moov.indexOf('hvcC');
  if (i >= 0) {
    const p = i + 4;
    const b = moov[p + 1];
    const space = ['', 'A', 'B', 'C'][b >> 6];
    const tier = (b >> 5) & 1 ? 'H' : 'L';
    const profile = b & 0x1f;
    const compat = moov.readUInt32BE(p + 2);
    let rev = 0;
    for (let k = 0; k < 32; k++) rev = (rev << 1) | ((compat >>> k) & 1);
    const cons = [...moov.subarray(p + 6, p + 12)];
    while (cons.length && cons[cons.length - 1] === 0) cons.pop();
    const level = moov[p + 12];
    return ['hvc1', `${space}${profile}`, (rev >>> 0).toString(16).toUpperCase(), `${tier}${level}`,
      ...cons.map((c) => c.toString(16).toUpperCase())].join('.');
  }
  i = moov.indexOf('avcC');
  if (i >= 0) {
    const p = i + 4;
    return `avc1.${hex(moov[p + 1])}${hex(moov[p + 2])}${hex(moov[p + 3])}`;
  }
  return null;
}

class LiveStream extends EventEmitter {
  // getRecording() -> null o { pattern, segmentSeconds } para agregar la salida de grabación.
  constructor(url, getRecording = () => null) {
    super();
    this.url = url;
    this.getRecording = getRecording;
    this.mode = 'copy';
    this.proc = null;
    this.running = false;
    this.backoff = 2000;
  }

  start(mode = this.mode) {
    this.mode = mode;
    this.running = true;
    this._spawn();
  }

  stop() {
    this.running = false;
    clearTimeout(this.retryTimer);
    this._kill();
  }

  restart(mode = this.mode) {
    this._kill();
    this.start(mode);
  }

  // Cierre limpio: 'q' por stdin para que ffmpeg cierre el segmento que está grabando.
  stopGracefully(timeoutMs = 3000) {
    this.running = false;
    clearTimeout(this.retryTimer);
    clearInterval(this.watchdog);
    const proc = this.proc;
    this.proc = null;
    if (!proc) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, timeoutMs);
      proc.once('close', () => { clearTimeout(t); resolve(); });
      try { proc.stdin.write('q'); } catch { proc.kill('SIGKILL'); }
    });
  }

  get recording() {
    return !!(this.proc && this.recordingActive);
  }

  _args() {
    const video = this.mode === 'h264'
      ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-g', '12']
      : ['-c:v', 'copy', '-tag:v', 'hvc1'];
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-rtsp_transport', 'tcp', '-fflags', 'nobuffer', '-flags', 'low_delay',
      '-i', this.url,
      // Salida 1: vista en vivo.
      '-map', '0:v:0', '-an', ...video,
      '-f', 'mp4', '-movflags', 'empty_moov+default_base_moof', '-frag_duration', '200000',
      'pipe:1',
    ];
    const rec = this.getRecording();
    this.recordingActive = !!rec;
    if (rec) {
      // Salida 2: grabación sin recodificar el video; el audio G.711 pasa a AAC (MP4 no admite alaw).
      args.push(
        '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy', '-tag:v', 'hvc1', '-c:a', 'aac', '-b:a', '32k',
        '-f', 'segment', '-segment_time', String(rec.segmentSeconds),
        '-reset_timestamps', '1', '-strftime', '1', '-segment_format', 'mp4',
        '-segment_format_options', 'movflags=frag_keyframe+empty_moov+default_base_moof',
        rec.pattern,
      );
    }
    return args;
  }

  _spawn() {
    this.buf = Buffer.alloc(0);
    this.init = [];
    this.pending = [];
    this.gotInit = false;
    this.lastErr = '';
    this.emit('status', { state: 'connecting', mode: this.mode, recording: false });

    const proc = spawn(ffmpegPath, this._args(), { windowsHide: true });
    this.proc = proc;
    proc.stdout.on('data', (d) => this._onData(d));
    proc.stderr.on('data', (d) => { this.lastErr = String(d).trim().split('\n').pop(); });
    proc.on('error', (e) => { this.lastErr = e.message; });
    proc.on('close', (code) => {
      clearInterval(this.watchdog);
      if (this.proc !== proc) return;
      this.proc = null;
      if (!this.running) return;
      this.emit('status', {
        state: 'error', mode: this.mode, recording: false, message: this.lastErr || `ffmpeg salió (${code})`,
      });
      this.retryTimer = setTimeout(() => this.running && this._spawn(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    });

    this.lastData = Date.now();
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastData > STALL_MS) {
        this.lastErr = 'sin datos de la cámara';
        proc.kill('SIGKILL');
      }
    }, 2000);
  }

  _kill() {
    clearInterval(this.watchdog);
    const proc = this.proc;
    this.proc = null;
    if (proc) proc.kill('SIGKILL');
  }

  _onData(chunk) {
    this.lastData = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let off = 0;
    while (this.buf.length - off >= 8) {
      let size = this.buf.readUInt32BE(off);
      if (size === 1) {
        if (this.buf.length - off < 16) break;
        size = Number(this.buf.readBigUInt64BE(off + 8));
      }
      if (size < 8) {
        this.lastErr = 'MP4 inválido';
        this.proc && this.proc.kill('SIGKILL');
        return;
      }
      if (this.buf.length - off < size) break;
      const type = this.buf.toString('latin1', off + 4, off + 8);
      this._onBox(type, this.buf.subarray(off, off + size));
      off += size;
    }
    this.buf = this.buf.subarray(off);
  }

  _onBox(type, box) {
    if (!this.gotInit) {
      this.init.push(box);
      if (type === 'moov') {
        this.gotInit = true;
        this.backoff = 2000;
        const codec = codecFromMoov(box);
        this.emit('init', { mime: `video/mp4; codecs="${codec}"`, codec, mode: this.mode, data: Buffer.concat(this.init) });
        this.emit('status', { state: 'live', mode: this.mode, codec, recording: this.recordingActive });
      }
      return;
    }
    this.pending.push(box);
    if (type === 'mdat') {
      this.emit('segment', Buffer.concat(this.pending));
      this.pending = [];
    }
  }
}

module.exports = { LiveStream, codecFromMoov };
