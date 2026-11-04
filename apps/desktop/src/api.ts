import type { CrewvaneCommand } from "../../../packages/core/src/index.js";
import type { HerdrStatus } from "../electron/herdr-install.js";
export interface DesktopApi {
  command(command: CrewvaneCommand): Promise<any>;
  selectWorkspace(): Promise<string | null>; selectProject(): Promise<string | null>;
  environment(): Promise<{ workspace?: string; version: string }>;
  herdrStatus(): Promise<HerdrStatus & { session: string }>;
  agentChoices(): Promise<{ kind: string; installed: boolean }[]>;
  installHerdr(): Promise<unknown>; cliStatus(): Promise<{ installed: boolean; path: string; directory: string }>;
  installCli(): Promise<{ output: string }>; prepareConcierge(): Promise<unknown>;
  dispatchGoal(goalId: string): Promise<unknown>;
  terminalSnapshot(): Promise<{ session: string; data: string; running: boolean; sequence: number; cols: number; rows: number; error?: string } | undefined>;
  writeTerminal(session: string, data: string): Promise<void>;
  resizeTerminal(session: string, cols: number, rows: number): Promise<void>;
  openHerdr(goalId?: string): Promise<void>; openUrl(url: string): Promise<void>; showCli(): Promise<void>;
  openTerminal(): Promise<void>;
  subscribe(listener: (event: any) => void): () => void;
}
declare global { interface Window { crewvane: DesktopApi } }
export const api = window.crewvane;
