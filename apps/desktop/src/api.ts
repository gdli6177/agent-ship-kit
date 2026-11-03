import type { ServiceCommand } from "../../../packages/orchestrator/src/service.js";
export interface TerminalBackend {
  id: string;
  name: string;
  status: "ready" | "missing" | "unavailable";
  reason: string;
}
export interface HerdrStatus {
  installed: boolean;
  executable?: string;
  version?: string;
  homebrew?: string;
  installAvailable: boolean;
  installCommand: "brew install herdr";
  docsUrl: "https://herdr.dev";
}
export interface DesktopApi {
  command(command: ServiceCommand): Promise<any>;
  selectWorkspace(): Promise<string | null>;
  selectProject(): Promise<string | null>;
  environment(): Promise<{ workspace?: string; version: string }>;
  openEvidence(taskId: string): Promise<void>;
  openPR(taskId: string): Promise<void>;
  terminalBackends(): Promise<TerminalBackend[]>;
  terminalStart(options: {
    backend: string;
    cwd?: string;
    cols: number;
    rows: number;
  }): Promise<{ id: string }>;
  terminalWrite(id: string, data: string): Promise<true>;
  terminalResize(id: string, cols: number, rows: number): Promise<true>;
  terminalStop(id: string): Promise<true>;
  herdrStatus(): Promise<HerdrStatus>;
  installHerdr(): Promise<HerdrStatus & { output: string }>;
  openHerdrDocs(): Promise<void>;
  subscribe(listener: (event: any) => void): () => void;
}
declare global {
  interface Window {
    crewvane: DesktopApi;
  }
}
export const api = window.crewvane;
