import { EventEmitter } from 'node:events';

export interface TailPocketHostState {
  /** Contains the node's private keys: store it like a password. */
  identity: string;
  allowed: string[];
}

export interface TailPocketHostOptions {
  /** Where each phone connection goes: "127.0.0.1:PORT" or "unix:/path". */
  forward: string;
  /** Store state; throw to refuse the change. Called before a change takes effect. */
  save(state: TailPocketHostState): Promise<void> | void;
  /** Restore a previous TailPocketHostState. */
  identity?: string;
  allowed?: string[];
  /** Shown on the phone while pairing. Default: the hostname. */
  name?: string;
  /** Write "nodekey:…\n" (the phone's key) as the first line of each forwarded connection. */
  identifyPhone?: boolean;
  /** Your own relay map instead of Tailcat's free, rate-limited default (https://tailcat.dev/derpmap.json). */
  derpMapUrl?: string;
  port?: number;
  pairingPort?: number;
  /** Helper binary path (default: bundled, or $TAILPOCKET_HOST), or a command to run. */
  helper?: string | { command: string; args?: string[] };
}

export interface TailPocketPairOptions {
  /** Seconds the window stays open (default 120, at most 900). */
  ttl?: number;
  /** Your data for the phone, delivered inside the tunnel (a token, settings…). */
  payload?: string;
  /** Prefix of the QR text (default "tailpocket1:"). The phone must use the same. */
  qrPrefix?: string;
}

export interface TailPocketPhone { phone: string; device: string }

export interface TailPocketLocalOptions {
  /** Bonjour type phones browse for, e.g. "_myapp._tcp". */
  service: string;
  /** Show code and device to the user; resolve true if the phone shows the same code. */
  confirm(code: string, device: string): Promise<boolean> | boolean;
  label?: string;
  instance?: string;
  /** The phone left before the user decided. */
  onCancel?(): void;
}

export interface TailPocketPairing {
  id: string;
  /** Text for a QR code or link. Anyone holding it can pair until it expires. */
  qr: string;
  invite: Record<string, unknown>;
  expiresAt: Date;
  paired: Promise<TailPocketPhone>;
  closed: Promise<'paired' | 'expired' | 'stopped' | string>;
  local(options: TailPocketLocalOptions): Promise<void>;
  cancel(): void;
}

export class TailPocketHostError extends Error { code: string }

export function tailPocketHelperPath(): string;

export class TailPocketHost extends EventEmitter {
  static start(options: TailPocketHostOptions): Promise<TailPocketHost>;
  readonly options: TailPocketHostOptions;
  /** The node's address, "" while no phone is paired. */
  address: string;
  allowed: string[];
  pair(options?: TailPocketPairOptions): Promise<TailPocketPairing>;
  setAllowed(phones: string[]): Promise<void>;
  revoke(phone: string): Promise<void>;
  close(): Promise<void>;
}
