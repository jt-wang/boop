import { EventEmitter } from 'node:events';

export interface TailPocketHostState {
  /** Contains the node's private keys: store it like a password. */
  identity: string;
  allowed: string[];
  /** Each phone's Noise key for the end-to-end encrypted routes (v0.3). Pass it back as options.keys. */
  keys?: Record<string, string>;
}

/** A tailpocket-relay the host registers with. */
export interface TailPocketRelay {
  /** wss://…; ws:// only to a loopback address. */
  url: string;
  token: string;
  /** Pass the phone's bytes to `forward` without TailPocket's encryption (your app runs its own pinned TLS). Needs `appAuth`. */
  opaque?: boolean;
  /**
   * Required with `opaque`: you declare that your app authenticates every connection itself (pinned TLS
   * plus a per-device credential, for example), since anyone who knows the room reaches `forward` through
   * an opaque relay. An opaque relay without it fails start with `invalid-config`.
   */
  appAuth?: boolean;
}

export interface TailPocketRoute {
  t: 'tailcat' | 'relay' | 'lan' | string;
  a?: string[];
  p?: number;
  u?: string;
  r?: string;
  m?: 'opaque';
}

export interface TailPocketAuditEvent {
  kind: 'paired' | 'revoked' | 'conn-open' | 'conn-close' | 'denied' | string;
  phone: string;
  route: string;
  reason?: string;
  time: Date;
}

export interface TailPocketHostOptions {
  /** Where each phone connection goes: "127.0.0.1:PORT" or "unix:/path". */
  forward: string;
  /** Store state; throw to refuse the change. Called before a change takes effect. */
  save(state: TailPocketHostState): Promise<void> | void;
  /** Restore a previous TailPocketHostState. */
  identity?: string;
  allowed?: string[];
  keys?: Record<string, string>;
  relays?: TailPocketRelay[];
  /**
   * Addresses ("192.168.1.20:7681") phones reach directly, end-to-end encrypted. Not 0.0.0.0. Empty: every
   * private address of the computer's Wi-Fi and Ethernet, on a port derived from the host's key.
   */
  listen?: string[];
  /** No local network route: no listener, and invites and routes list none. Not with `listen`. */
  noLan?: boolean;
  /** Tailcat only, as before v0.3: no local network listener, no relay; invites and routes list only Tailcat. Not with `relays` or `listen`. */
  tailcatOnly?: boolean;
  /** Decide each connection from a paired phone; false (or no answer in 5 s) closes it. */
  authorize?(phone: string, route: string): Promise<boolean> | boolean;
  /** Pairings, revokes, sessions and refusals. Never keys, codes or payloads. */
  audit?(event: TailPocketAuditEvent): void;
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
  /** Prefix of the v2 QR text (default "tailpocket2:"). */
  qrPrefix2?: string;
  /**
   * A v2 window (v0.3 phones): the pairing has `qr2`/`invite2` and no v1 `qr`/`invite`, and every phone
   * that pairs comes as a `request` event to answer with `confirm`. Without it the window is v1 (`qr`, `invite`).
   */
  emoji?: boolean;
}

export interface TailPocketPhone { phone: string; device: string }

/** A phone asking to pair through an emoji window. */
export interface TailPocketPairRequest {
  phone: string;
  /** The name the phone gave. */
  device: string;
  route: 'tailcat' | 'relay' | 'lan' | string;
  /**
   * The four emoji the phone shows: show them with `device` and ask whether the phone shows the same.
   * null for a phone pairing with the v1 invite of `local()`: it shows none, so go by the name.
   */
  emoji: string[] | null;
}

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

export interface TailPocketPairing extends EventEmitter {
  id: string;
  /** v1 text for a QR code or link (windows without `emoji`). Anyone holding it can pair until it expires. */
  qr?: string;
  invite?: Record<string, unknown>;
  /** v2 text for a QR code or link (`emoji` windows): every route, the host's Noise key. */
  qr2?: string;
  invite2?: Record<string, unknown>;
  expiresAt: Date;
  paired: Promise<TailPocketPhone>;
  closed: Promise<'paired' | 'expired' | 'stopped' | string>;
  /**
   * `request`: a phone asks to pair (`emoji` windows); answer with `confirm` within 55 s. With no
   * `request` listener it is refused at once. `requestCancelled`: the phone left or the time ran out
   * before the answer. A refusal, a timeout or a phone that left closes the window: open a new one.
   */
  on(event: 'request', listener: (request: TailPocketPairRequest) => void): this;
  on(event: 'requestCancelled', listener: () => void): this;
  once(event: 'request', listener: (request: TailPocketPairRequest) => void): this;
  once(event: 'requestCancelled', listener: () => void): this;
  /** Answers the current `request`: true once the computer's user saw the same emoji as the phone. */
  confirm(approve: boolean): void;
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
  disconnect(phone: string): Promise<void>;
  status(): Promise<{ address: string; routes: TailPocketRoute[]; relays: Record<string, string> }>;
  close(): Promise<void>;
}
