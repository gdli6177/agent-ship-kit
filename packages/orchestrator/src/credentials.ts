import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activeGrant, newId, type CredentialReference, type Project } from "../../core/src/index.js";
import { containsSecret } from "../../../cli/src/hard-rules.js";

export interface CredentialCipher {
  available(): Promise<boolean>;
  encrypt(value: string): Promise<Buffer>;
  decrypt(value: Buffer): Promise<string>;
}
export interface TestEnvironment { env: Record<string, string>; secrets: string[]; credentialIds: string[] }
export function validateCredentialReference(reference: CredentialReference, project: Project) {
  if (!reference || Object.keys(reference).some(key => !["id", "projectId", "label", "env", "checkIndex", "createdAt"].includes(key)) ||
    !/^credential_[a-f0-9]{16}$/.test(reference.id) || reference.projectId !== project.id ||
    typeof reference.label !== "string" || !reference.label.trim() || reference.label.length > 100 ||
    containsSecret(reference.label) || !/^E2E_[A-Z][A-Z0-9_]{0,63}$/.test(reference.env) ||
    !Number.isInteger(reference.checkIndex) || reference.checkIndex < 0 || reference.checkIndex >= project.checks.length ||
    !Number.isFinite(Date.parse(reference.createdAt))) throw new Error("invalid test credential reference");
}

/** Values never enter workspace events. The desktop supplies an OS-backed cipher. */
export class CredentialVault {
  constructor(readonly directory: string, readonly cipher: CredentialCipher) {}
  private async prepare() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.directory)).isDirectory()) throw new Error("credential directory must not be a symlink or file");
    return realpath(this.directory);
  }
  async save(project: Project, input: { label: string; env: string; checkIndex: number; value: string }): Promise<CredentialReference> {
    const reference = { id: newId("credential"), projectId: project.id, label: input.label, env: input.env,
      checkIndex: input.checkIndex, createdAt: new Date().toISOString() };
    validateCredentialReference(reference, project);
    if (typeof input.value !== "string" || !input.value.length || input.value.length > 16000 || /\0/.test(input.value))
      throw new Error("credential value must be nonempty and at most 16000 characters");
    if (!await this.cipher.available()) throw new Error("系统安全存储暂不可用，请解锁系统钥匙串后重试");
    const encrypted = await this.cipher.encrypt(input.value);
    const path = join(await this.prepare(), `${reference.id}.json`);
    await writeFile(path, JSON.stringify({ reference, ciphertext: encrypted.toString("base64") }), { flag: "wx", mode: 0o600 });
    return reference;
  }
  async remove(id: string) {
    if (!/^credential_[a-f0-9]{16}$/.test(id)) throw new Error("invalid credential id");
    await rm(join(await this.prepare(), `${id}.json`), { force: true });
  }
  async environment(project: Project, checkIndex: number): Promise<TestEnvironment> {
    const grant = activeGrant(project);
    const selected = (project.credentials ?? []).filter(reference => reference.checkIndex === checkIndex && grant.credentials?.includes(reference.id));
    if (!selected.length) return { env: {}, secrets: [], credentialIds: [] };
    if (!grant.actions.includes("verify")) throw new Error("credential use requires verification authorization");
    if (!await this.cipher.available()) throw new Error("系统安全存储暂不可用，验证未执行");
    const directory = await this.prepare();
    const env: Record<string, string> = {};
    for (const reference of selected) {
      validateCredentialReference(reference, project);
      const file = join(directory, `${reference.id}.json`);
      if (!(await lstat(file)).isFile()) throw new Error("invalid credential file");
      const stored = JSON.parse(await readFile(file, "utf8"));
      if (Object.keys(reference).some(key => stored.reference?.[key] !== reference[key as keyof CredentialReference]))
        throw new Error("credential reference differs from secure storage");
      if (reference.env in env) throw new Error("duplicate test environment variable");
      env[reference.env] = await this.cipher.decrypt(Buffer.from(stored.ciphertext, "base64"));
    }
    return { env, secrets: Object.values(env), credentialIds: selected.map(reference => reference.id) };
  }
}

export function maskTestSecrets(text: string, values: string[]): string {
  const variants = [...new Set(values.flatMap(value => [value, encodeURIComponent(value), Buffer.from(value).toString("base64"), JSON.stringify(value).slice(1, -1)]))]
    .filter(Boolean).sort((a, b) => b.length - a.length);
  for (const value of variants) text = text.split(value).join("[redacted]");
  return text;
}
