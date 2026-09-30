// PiCode — preload: typed bridge exposed to the renderer.
import { contextBridge, ipcRenderer } from 'electron';

const invoke = (channel: string, ...args: any[]) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('picode', {
  // app info / prefs / dialogs
  appInfo: () => invoke('picode:app-info'),
  getPrefs: () => invoke('prefs:get'),
  setPrefs: (patch: any) => invoke('prefs:set', patch),
  pickFolder: () => invoke('dialog:pick-folder'),
  openPath: (p: string) => invoke('shell:open-path', p),
  showItem: (p: string) => invoke('shell:show-item', p),

  // pi subprocess
  piStart: (opts: { cwd: string; sessionPath?: string | null; extraArgs?: string[] }) => invoke('pi:start', opts),
  piStop: () => invoke('pi:stop'),
  piCommand: (cmd: any) => invoke('pi:command', cmd),
  piExtRespond: (record: any) => invoke('pi:ext-respond', record),

  // sessions
  sessionsList: (cwd?: string) => invoke('sessions:list', cwd),
  sessionsTree: (file: string) => invoke('sessions:tree', file),
  sessionsDelete: (file: string) => invoke('sessions:delete', file),

  // pi config
  configRead: () => invoke('pi-config:read'),
  configSetKey: (provider: string, key: string) => invoke('pi-config:set-key', provider, key),
  configClearKey: (provider: string) => invoke('pi-config:clear-key', provider),
  configWriteSettings: (patch: any) => invoke('pi-config:write-settings', patch),

  // MCP extension config/status
  mcpConfigRead: () => invoke('mcp:config-read'),
  mcpConfigWrite: (cfg: any) => invoke('mcp:config-write', cfg),
  mcpStatusRead: () => invoke('mcp:status-read'),

  // pi resource inventory
  skillsList: (cwd?: string) => invoke('resources:list-skills', cwd),
  extensionsList: (cwd?: string) => invoke('resources:list-extensions', cwd),

  // diagnostics
  diagLog: () => invoke('diag:log'),

  // event subscriptions
  on: (channel: 'pi:event' | 'pi:ext-ui' | 'pi:status', cb: (payload: any) => void) => {
    const handler = (_e: unknown, payload: any) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
