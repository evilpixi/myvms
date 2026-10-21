// Fase 0: detecta códec, resolución y fps del stream RTSP.
// Uso: node scripts/probe.js [url]
const { spawn } = require('child_process');
const ffmpeg = require('ffmpeg-static');

const url = process.argv[2] ||
  'rtsp://192.168.1.17:554/user=admin&password=&channel=1&stream=0.sdp';

const args = [
  '-hide_banner', '-rtsp_transport', 'tcp', '-i', url,
  '-t', '5', '-f', 'null', '-',
];

console.log(`Probando ${url} ...`);
const proc = spawn(ffmpeg, args);
let log = '';
proc.stderr.on('data', (d) => { log += d; });
const timer = setTimeout(() => proc.kill('SIGKILL'), 20000);

proc.on('close', (code) => {
  clearTimeout(timer);
  const streams = log.split('\n').filter((l) => /Stream #\d+:\d+/.test(l) && !/Output/.test(l));
  const input = log.split('Output #0')[0];
  const inStreams = input.split('\n').filter((l) => /Stream #\d+:\d+/.test(l));
  if (!inStreams.length) {
    console.error('No se pudieron leer streams. Log de ffmpeg:\n' + log);
    process.exit(1);
  }
  console.log('\nStreams de entrada:');
  inStreams.forEach((l) => console.log('  ' + l.trim()));
  const video = inStreams.find((l) => /Video:/.test(l)) || '';
  const codec = (video.match(/Video: (\w+)/) || [])[1];
  const res = (video.match(/(\d{3,5})x(\d{3,5})/) || [])[0];
  const fps = (video.match(/([\d.]+) fps/) || [])[1];
  const lastFrame = [...log.matchAll(/frame=\s*(\d+)/g)].pop();
  console.log('\nResumen:');
  console.log(`  códec:      ${codec}`);
  console.log(`  resolución: ${res}`);
  console.log(`  fps:        ${fps}`);
  console.log(`  frames 5s:  ${lastFrame ? lastFrame[1] : '?'}`);
  console.log(`  ffmpeg exit: ${code}`);
  void streams;
});
