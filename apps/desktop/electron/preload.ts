import { contextBridge, ipcRenderer } from "electron";
import type { CrewvaneCommand } from "../../../packages/core/src/index.js";
contextBridge.exposeInMainWorld("crewvane", {
  command: (command: CrewvaneCommand) => ipcRenderer.invoke("crewvane:command", command),
  selectWorkspace: () => ipcRenderer.invoke("crewvane:workspace"), selectProject: () => ipcRenderer.invoke("crewvane:project"),
  environment: () => ipcRenderer.invoke("crewvane:environment"), herdrStatus: () => ipcRenderer.invoke("crewvane:herdr-status"),
  agentChoices: () => ipcRenderer.invoke("crewvane:agent-choices"),
  installHerdr: () => ipcRenderer.invoke("crewvane:install-herdr"), cliStatus: () => ipcRenderer.invoke("crewvane:cli-status"),
  openTerminal: () => ipcRenderer.invoke("crewvane:open-terminal"),
  installCli: () => ipcRenderer.invoke("crewvane:install-cli"), prepareConcierge: () => ipcRenderer.invoke("crewvane:prepare-concierge"),
  dispatchGoal: (goalId: string) => ipcRenderer.invoke("crewvane:dispatch-goal", goalId),
  terminalSnapshot: () => ipcRenderer.invoke("crewvane:terminal-snapshot"),
  writeTerminal: (session: string, data: string) => ipcRenderer.invoke("crewvane:terminal-write", session, data),
  resizeTerminal: (session: string, cols: number, rows: number) => ipcRenderer.invoke("crewvane:terminal-resize", session, cols, rows),
  openHerdr: (goalId?: string) => ipcRenderer.invoke("crewvane:open-herdr", goalId), openUrl: (url: string) => ipcRenderer.invoke("crewvane:open-url", url), showCli: () => ipcRenderer.invoke("crewvane:show-cli"),
  subscribe: (listener: (event: any) => void) => { const handler = (_: unknown, data: unknown) => listener(data); ipcRenderer.on("crewvane:event", handler); return () => ipcRenderer.removeListener("crewvane:event", handler); },
});
