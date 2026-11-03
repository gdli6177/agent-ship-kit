import { contextBridge, ipcRenderer } from "electron";
import type { ServiceCommand } from "../../../packages/orchestrator/src/service.js";
contextBridge.exposeInMainWorld("crewvane", {
  command: (command: ServiceCommand) =>
    ipcRenderer.invoke("crewvane:command", command),
  selectWorkspace: () => ipcRenderer.invoke("crewvane:workspace"),
  selectProject: () => ipcRenderer.invoke("crewvane:project"),
  environment: () => ipcRenderer.invoke("crewvane:environment"),
  openEvidence: (taskId: string) =>
    ipcRenderer.invoke("crewvane:evidence", taskId),
  openPR: (taskId: string) => ipcRenderer.invoke("crewvane:pr", taskId),
  terminalBackends: () => ipcRenderer.invoke("crewvane:terminal-backends"),
  terminalStart: (options: {
    backend: string;
    cwd?: string;
    cols: number;
    rows: number;
  }) => ipcRenderer.invoke("crewvane:terminal-start", options),
  terminalWrite: (id: string, data: string) =>
    ipcRenderer.invoke("crewvane:terminal-write", id, data),
  terminalResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke("crewvane:terminal-resize", id, cols, rows),
  terminalStop: (id: string) => ipcRenderer.invoke("crewvane:terminal-stop", id),
  herdrStatus: () => ipcRenderer.invoke("crewvane:herdr-status"),
  installHerdr: () => ipcRenderer.invoke("crewvane:install-herdr"),
  openHerdrDocs: () => ipcRenderer.invoke("crewvane:open-herdr-docs"),
  subscribe: (listener: (event: unknown) => void) => {
    const handler = (_: unknown, data: unknown) => listener(data);
    ipcRenderer.on("crewvane:event", handler);
    return () => ipcRenderer.removeListener("crewvane:event", handler);
  },
});
