import { RequestError } from "@agentclientprotocol/sdk";
import { getAuthMethods } from "./auth.js";

/**
 * Best-effort detection of missing credentials / not-configured errors from pi/providers.
 *
 * We can't do a full provider-specific check here, so we look for common substrings.
 */
export function maybeAuthRequiredError(err: unknown): RequestError | null {
  const msg = String((err as any)?.message ?? err ?? "");
  const s = msg.toLowerCase();

  const patterns = [
    "api key",
    "apikey",
    "missing key",
    "no key",
    "not configured",
    "not authenticated",
    "unauthorized",
    "authentication",
    "authentication_error",
    "auth failed",
    "x-api-key",
    "invalid key",
    "permission denied",
    "forbidden",
    "401",
    "403",
  ];

  const hit = patterns.some((p) => s.includes(p));
  if (!hit) return null;

  return RequestError.authRequired(
    {
      authMethods: getAuthMethods(),
    },
    "Configure an API key or log in with an OAuth provider.",
  );
}

export function mapPiRpcError(err: unknown, context?: string): RequestError {
  const authErr = maybeAuthRequiredError(err);
  if (authErr) return authErr;

  const message = String((err as any)?.message ?? err ?? "Unknown pi RPC error");
  return RequestError.internalError({}, context ? `${context}: ${message}` : message);
}
