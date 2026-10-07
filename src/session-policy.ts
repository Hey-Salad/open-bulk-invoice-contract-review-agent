export const WORKER_NAME = "open-bulk-invoice-contract-review-agent";
export const MIN_SESSION_AUTH_SECRET_LENGTH = 32;
export const GLOBAL_SESSION_LIMIT = 10;
export const GLOBAL_SESSION_WINDOW_MS = 60_000;

export function sessionAttemptKey(request: Request): string {
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip == null || ip.length === 0) return "ip:unknown";
  return `ip:${ip}`;
}
