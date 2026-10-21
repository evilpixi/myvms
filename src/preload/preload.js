const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};
const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  settings: {
    get: invoke('settings:get'),
    set: invoke('settings:set'),
    setCamera: invoke('camera:set'),
  },
  live: {
    start: (mode) => ipcRenderer.send('live:start', mode),
    onInit: on('live:init'),
    onData: on('live:data'),
    onStatus: on('live:status'),
  },
  ptz: {
    move: invoke('ptz:move'),
    stop: invoke('ptz:stop'),
    onStatus: on('ptz:status'),
  },
  presets: {
    goto: invoke('presets:goto'),
    add: invoke('presets:add'),
    overwrite: invoke('presets:overwrite'),
    rename: invoke('presets:rename'),
    remove: invoke('presets:delete'),
    move: invoke('presets:move'),
    sync: invoke('presets:sync'),
    setPatrol: invoke('presets:setPatrol'),
    onChanged: on('presets:changed'),
  },
  patrol: {
    set: invoke('patrol:set'),
    status: invoke('patrol:status'),
    onStatus: on('patrol:status'),
    onError: on('patrol:error'),
  },
  rec: {
    set: invoke('rec:set'),
    chooseDir: invoke('rec:chooseDir'),
    info: invoke('rec:info'),
    open: invoke('rec:open'),
    onError: on('rec:error'),
  },
});
