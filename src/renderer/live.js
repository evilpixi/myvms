// Reproductor en vivo: MP4 fragmentado por IPC -> MediaSource -> <video>.
// Si el códec no se puede decodificar (p.ej. H.265 sin soporte), pide recodificar a H.264.
class LivePlayer {
  constructor(video, { onState } = {}) {
    this.video = video;
    this.onState = onState || (() => {});
    this.mode = 'copy';
    this.queue = [];
    this.sb = null;
    this.codec = '';

    window.api.live.onInit((m) => this._onInit(m));
    window.api.live.onData((d) => { this.queue.push(d); this._pump(); });
    video.addEventListener('error', () => this._fallback('error de decodificación'));
    setInterval(() => this._keepLive(), 500);
  }

  start() {
    window.api.live.start(this.mode);
  }

  get latency() {
    const b = this.video.buffered;
    return b.length ? b.end(b.length - 1) - this.video.currentTime : 0;
  }

  _fallback(reason) {
    if (this.mode === 'h264') return;
    console.warn(`No se puede reproducir ${this.codec} (${reason}); recodificando a H.264`);
    this.mode = 'h264';
    this.onState({ fallback: reason });
    this._reset();
    this.start();
  }

  _reset() {
    clearTimeout(this.frameCheck);
    this.sb = null;
    this.queue = [];
    if (this.ms && this.ms.readyState === 'open') {
      try { this.ms.endOfStream(); } catch { /* ya cerrado */ }
    }
    this.video.removeAttribute('src');
    this.video.load();
  }

  _onInit({ mime, codec, mode, data }) {
    this.codec = codec;
    this.mode = mode;
    if (!window.MediaSource || !MediaSource.isTypeSupported(mime)) {
      this._fallback(`${mime} no soportado`);
      return;
    }
    this._reset();
    this.queue = [data];
    const ms = new MediaSource();
    this.ms = ms;
    this.video.src = URL.createObjectURL(ms);
    ms.addEventListener('sourceopen', () => {
      URL.revokeObjectURL(this.video.src);
      this.sb = ms.addSourceBuffer(mime);
      this.sb.mode = 'segments';
      this.sb.addEventListener('updateend', () => this._pump());
      this._pump();
    }, { once: true });

    // Si llegan datos pero no se dibuja ningún cuadro, el decodificador no funciona.
    this.frameCheck = setTimeout(() => {
      if (!this.video.videoWidth) this._fallback('no se decodifican cuadros');
    }, 8000);
    this.onState({ codec, mode });
  }

  _pump() {
    const sb = this.sb;
    if (!sb || sb.updating || !this.queue.length) return;
    try {
      sb.appendBuffer(this.queue.shift());
    } catch (e) {
      if (e.name === 'QuotaExceededError') this._trim(true);
      else console.error('appendBuffer:', e.message);
    }
  }

  _trim(force) {
    const sb = this.sb;
    const v = this.video;
    if (!sb || sb.updating || !v.buffered.length) return;
    const start = v.buffered.start(0);
    if (force || v.currentTime - start > 30) {
      const end = Math.max(start, v.currentTime - 5);
      if (end > start) sb.remove(start, end);
    }
  }

  // Mantiene la reproducción pegada al borde en vivo.
  _keepLive() {
    const v = this.video;
    if (!this.sb || !v.buffered.length) return;
    const end = v.buffered.end(v.buffered.length - 1);
    const lag = end - v.currentTime;
    if (lag > 1.5 || v.currentTime < v.buffered.start(0)) {
      v.currentTime = Math.max(v.buffered.start(0), end - 0.3);
    }
    v.playbackRate = lag > 0.7 ? 1.1 : 1;
    if (v.paused) v.play().catch(() => {});
    this._trim(false);
  }
}

window.LivePlayer = LivePlayer;
