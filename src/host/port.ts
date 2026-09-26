/**
 * HostPort defines the seam between the Kiro plugin core and the host runtime.
 * This abstraction allows the same core logic to work under different hosts
 * (v1 OpenCode, v2 OpenCode, testing) without coupling to host-specific APIs.
 */
export interface HostPort {
  /**
   * Display a toast notification to the user.
   */
  notify(message: string, variant: 'info' | 'success' | 'warning' | 'error'): void

  /**
   * Trigger re-authorization flow.
   * The implementation handles all OAuth client calls behind this seam.
   */
  reauthorize(): Promise<void>
}
