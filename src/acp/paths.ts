import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Storage owned by the ACP adapter.
 *
 * We intentionally keep this separate from pi's own ~/.pi/agent/* directory.
 */
export function getPiAcpDir(): string {
  return process.env.PI_ACP_DIR
    ? resolve(process.env.PI_ACP_DIR)
    : join(homedir(), ".pi", "pi-acp");
}

export function getPiAcpSessionMapPath(): string {
  return join(getPiAcpDir(), "session-map.json");
}
