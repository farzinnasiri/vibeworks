/** Keep the chip compact; the tooltip carries the full cause and human steps. */
export function rejectionLabel(code?: string): string {
  const labels: Record<string, string> = {
    BROWSER_ALREADY_CONNECTED: 'Held by another tab',
    VERSION_SKEW: 'Version mismatch',
    UNAUTHORIZED: 'Unauthorized / stale token',
    INVALID_RESPONSE: 'Invalid response',
    RESPONSE_MISMATCH: 'Mismatched response',
    INVALID_MESSAGE: 'Invalid bridge message',
    HELLO_TIMEOUT: 'Handshake timed out',
    HOST_REJECTED: 'Host rejected', ORIGIN_REJECTED: 'Origin rejected',
    FETCH_SITE_REJECTED: 'Origin rejected', BOOTSTRAP_REJECTED: 'Bootstrap rejected',
  };
  return code ? labels[code] ?? code : 'Connection rejected';
}
