// Carpeta de grabaciones: <dir>/record_AAAA-MM-DD/HH_MM_SS.mp4 (fecha y hora de inicio).
// Cada archivo dura como máximo 6 h; al cumplirlas ffmpeg lo cierra y abre uno nuevo.
// Crea de antemano las carpetas de hoy y mañana (el muxer de ffmpeg no crea directorios)
// y borra lo que tenga más de N días.
const fs = require('fs');
const path = require('path');

const SEGMENT_SECONDS = 6 * 3600;
const PREFIX = 'record_';
const DAY_RE = /^record_(\d{4}-\d{2}-\d{2})$/;
// Formato anterior: AAAA-MM-DD/AAAA-MM-DD_HH-MM-SS.mp4
const OLD_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const OLD_FILE_RE = /^\d{4}-\d{2}-\d{2}_(\d{2})-(\d{2})-(\d{2})(\.mp4)$/;

function dayName(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

class Recorder {
  constructor(getConfig) {
    this.getConfig = getConfig;
    this.timer = null;
  }

  get dir() {
    return this.getConfig().dir;
  }

  pattern() {
    return path.join(this.dir, `${PREFIX}%Y-%m-%d`, '%H_%M_%S.mp4');
  }

  ensureDirs() {
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
    for (const d of [now, tomorrow]) fs.mkdirSync(path.join(this.dir, PREFIX + dayName(d)), { recursive: true });
  }

  // Pasa las grabaciones del formato anterior al nuevo (carpeta record_… y archivos HH_MM_SS).
  migrate() {
    let entries = [];
    try { entries = fs.readdirSync(this.dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || !OLD_DAY_RE.test(e.name)) continue;
      const from = path.join(this.dir, e.name);
      const to = path.join(this.dir, PREFIX + e.name);
      fs.mkdirSync(to, { recursive: true });
      for (const f of fs.readdirSync(from)) {
        const m = f.match(OLD_FILE_RE);
        const name = m ? `${m[1]}_${m[2]}_${m[3]}${m[4]}` : f;
        try {
          if (!fs.existsSync(path.join(to, name))) fs.renameSync(path.join(from, f), path.join(to, name));
        } catch (err) {
          console.error('recorder: no se pudo migrar', f, err.message);
        }
      }
      try { fs.rmdirSync(from); } catch { /* quedó algo adentro */ }
    }
  }

  cleanup() {
    const days = this.getConfig().days;
    const limit = Date.now() - days * 24 * 3600 * 1000;
    const today = PREFIX + dayName(new Date());
    let removed = 0;
    let entries = [];
    try { entries = fs.readdirSync(this.dir, { withFileTypes: true }); } catch { return 0; }
    for (const e of entries) {
      if (!e.isDirectory() || !DAY_RE.test(e.name)) continue;
      const dayDir = path.join(this.dir, e.name);
      for (const f of fs.readdirSync(dayDir)) {
        const file = path.join(dayDir, f);
        try {
          if (fs.statSync(file).mtimeMs < limit) { fs.unlinkSync(file); removed++; }
        } catch { /* en uso o ya borrado */ }
      }
      try {
        if (!fs.readdirSync(dayDir).length && e.name < today) fs.rmdirSync(dayDir);
      } catch { /* no vacía */ }
    }
    return removed;
  }

  // Revisa cada 10 min: carpetas del día siguiente y limpieza.
  startMaintenance() {
    try { this.migrate(); } catch (e) { console.error('recorder:', e.message); }
    const tick = () => {
      try { this.ensureDirs(); this.cleanup(); } catch (e) { console.error('recorder:', e.message); }
    };
    tick();
    clearInterval(this.timer);
    this.timer = setInterval(tick, 10 * 60 * 1000);
  }

  stopMaintenance() {
    clearInterval(this.timer);
  }

  async info() {
    let bytes = 0;
    let files = 0;
    let oldest = null;
    let entries = [];
    try { entries = await fs.promises.readdir(this.dir, { withFileTypes: true }); } catch { /* sin carpeta */ }
    for (const e of entries) {
      const m = e.isDirectory() && e.name.match(DAY_RE);
      if (!m) continue;
      for (const f of await fs.promises.readdir(path.join(this.dir, e.name))) {
        try {
          const st = await fs.promises.stat(path.join(this.dir, e.name, f));
          bytes += st.size;
          files++;
          if (!oldest || m[1] < oldest) oldest = m[1];
        } catch { /* ignorar */ }
      }
    }
    let free = null;
    try {
      const s = await fs.promises.statfs(this.dir);
      free = s.bavail * s.bsize;
    } catch { /* no disponible */ }
    return { dir: this.dir, bytes, files, oldest, free };
  }
}

module.exports = { Recorder, SEGMENT_SECONDS };
