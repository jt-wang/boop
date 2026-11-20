// Node host SDK: spawns tailpocket-host and speaks its line-delimited JSON protocol
// (docs/HOST-IPC.md). Phones that pair can then reach `forward` (your server) from anywhere.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

/** An error event from the helper; `code` is from a fixed vocabulary (see docs/HOST-IPC.md). */
export class TailPocketHostError extends Error {
  constructor(code, message) {
    super(message ?? `tailpocket-host: ${code}`);
    this.code = code;
  }
}

const GOOS = { darwin: 'darwin', linux: 'linux', win32: 'windows' };
const GOARCH = { x64: 'amd64', arm64: 'arm64' };

/** Path of the helper binary bundled with this package for this platform. */
export function tailPocketHelperPath() {
  const name = `tailpocket-host-${GOOS[process.platform]}-${GOARCH[process.arch]}${process.platform === 'win32' ? '.exe' : ''}`;
  return fileURLToPath(new URL(`./bin/${name}`, import.meta.url));
}

function resolveHelper(helper) {
  if (helper && typeof helper === 'object') return helper;
  const path = helper ?? process.env.TAILPOCKET_HOST ?? tailPocketHelperPath();
  if (!existsSync(path)) throw new Error(`tailpocket-host not found at ${path}; set options.helper or TAILPOCKET_HOST`);
  return { command: path, args: [] };
}

let serial = 0;
const nextId = () => `n${++serial}`;

export class TailPocketHost extends EventEmitter {
  /**
   * Start the helper and wait until it is ready.
   * @param {import('./index.d.ts').HostOptions} options
   */
  static async start(options) {
    if (typeof options?.save !== 'function') throw new TypeError('options.save(state) is required');
    if (!options.forward) throw new TypeError('options.forward ("127.0.0.1:PORT" or "unix:/path") is required');
    const host = new TailPocketHost(options);
    await host.#ready;
    return host;
  }

  #child;
  #ready;
  #waiters = new Map(); // id -> { resolve, reject, kind }
  #pairings = new Map(); // id -> TailPocketPairing internals
  #closed = false;
  #exited;
  address = '';
  allowed = [];

  constructor(options) {
    super();
    this.options = options;
    this.allowed = [...(options.allowed ?? [])];
    const { command, args = [] } = resolveHelper(options.helper);
    this.#child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.#exited = new Promise((resolve) => this.#child.once('exit', resolve));
    this.#ready = new Promise((resolve, reject) => {
      this.#waiters.set('ready', { resolve, reject });
      this.#child.once('error', reject);
    });
    createInterface({ input: this.#child.stdout }).on('line', (line) => this.#onLine(line));
    this.#child.once('exit', () => this.#onExit());
    this.#send({
      v: 1, name: options.name, identity: options.identity ?? '', allowed: this.allowed, forward: options.forward,
      port: options.port, pairingPort: options.pairingPort, derpMapUrl: options.derpMapUrl, identifyPhone: !!options.identifyPhone,
      keys: options.keys, relays: options.relays, listen: options.listen, tailcatOnly: !!options.tailcatOnly, noLan: !!options.noLan,
      authorize: typeof options.authorize === 'function', audit: typeof options.audit === 'function',
    });
  }

  #send(value) {
    if (!this.#child.stdin.writable) return;
    this.#child.stdin.write(JSON.stringify(value) + '\n');
  }

  #request(command, kind) {
    if (this.#closed) return Promise.reject(new Error('host is closed'));
    const id = command.id ?? nextId();
    return new Promise((resolve, reject) => {
      this.#waiters.set(id, { resolve, reject, kind });
      this.#send({ ...command, id });
    });
  }

  async #onLine(line) {
    let e;
    try { e = JSON.parse(line); } catch { return; }
    switch (e.event) {
      case 'ready': this.address = e.address; this.#settle('ready', null, this); break;
      case 'save': {
        let ok = false;
        try { await this.options.save(e.state); ok = true; } catch (err) { this.emit('saveError', err); }
        if (ok) this.allowed = [...e.state.allowed];
        this.#send({ cmd: 'saved', id: e.id, ok });
        break;
      }
      case 'allowed': this.allowed = e.allowed; this.address = e.address; this.#settle(e.id, null, e.allowed); break;
      case 'authorize': {
        let ok = false;
        try { ok = !!(await this.options.authorize(e.phone, e.route)); } catch {}
        this.#send({ cmd: 'authorized', id: e.id, ok });
        break;
      }
      case 'audit': {
        try { this.options.audit?.({ kind: e.kind, phone: e.phone, route: e.route, reason: e.reason, time: new Date(e.time) }); } catch {}
        break;
      }
      case 'status': this.#settle(e.id, null, { address: e.address, routes: e.routes, relays: e.relays }); break;
      case 'disconnected': this.#settle(e.id, null); break;
      case 'pairing': this.#settle(e.id, null, e); break;
      case 'paired': {
        this.address = e.address;
        if (!this.allowed.includes(e.phone)) this.allowed.push(e.phone);
        this.#pairings.get(e.id)?.joined({ phone: e.phone, device: e.device });
        this.emit('paired', { phone: e.phone, device: e.device });
        break;
      }
      case 'pairingClosed': this.#pairings.get(e.id)?.ended(e.reason); this.#pairings.delete(e.id); break;
      case 'pairRequest': this.#pairings.get(e.id)?.request({ phone: e.phone, device: e.device, route: e.route, emoji: e.emoji ?? null }); break;
      case 'pairRequestCancelled': this.#pairings.get(e.id)?.requestCancelled(); break;
      case 'localCode': this.#pairings.get(e.id)?.code(e.code, e.device); break;
      case 'localCancelled': this.#pairings.get(e.id)?.cancelled(); break;
      case 'localDelivered': this.#pairings.get(e.id)?.delivered(); break;
      case 'error': {
        const err = new TailPocketHostError(e.code);
        if (e.id && this.#pairings.get(e.id)?.localError(err)) break;
        if (!e.id && this.#waiters.has('ready')) { this.#settle('ready', err); break; }
        if (e.id && this.#waiters.has(e.id)) { this.#settle(e.id, err); break; }
        if (this.listenerCount('error') > 0) this.emit('error', err);
        break;
      }
    }
  }

  #settle(id, err, value) {
    const w = this.#waiters.get(id);
    if (!w) return;
    this.#waiters.delete(id);
    err ? w.reject(err) : w.resolve(value);
  }

  #onExit() {
    this.#closed = true;
    const err = new Error('tailpocket-host exited');
    for (const [id, w] of this.#waiters) { this.#waiters.delete(id); w.reject(err); }
    for (const p of this.#pairings.values()) p.ended('stopped');
    this.#pairings.clear();
  }

  /**
   * Open a pairing window. Show `pairing.qr` (or, with `emoji: true`, `pairing.qr2`) as a QR code or
   * a link; `pairing.paired` resolves with the phone that joined. With `emoji: true` every phone that
   * pairs first comes as a `request` event: show its emoji, then `pairing.confirm(true | false)`.
   * @param {import('./index.d.ts').TailPocketPairOptions} [options]
   */
  async pair(options = {}) {
    const id = nextId();
    let joined, failed, closedResolve, local;
    const paired = new Promise((resolve, reject) => { joined = resolve; failed = reject; });
    paired.catch(() => {});
    const closed = new Promise((resolve) => { closedResolve = resolve; });
    let didJoin = false;
    const pairing = new EventEmitter();
    this.#pairings.set(id, {
      // Delivered after pair() has returned, so a listener added right after `await host.pair()` sees it.
      // Nobody listening means nobody can compare the emoji: refuse at once rather than let it time out.
      request: (req) => setImmediate(() => {
        if (pairing.listenerCount('request') === 0) this.#send({ cmd: 'confirm', id, approve: false });
        else pairing.emit('request', req);
      }),
      requestCancelled: () => setImmediate(() => pairing.emit('requestCancelled')),
      joined: (phone) => { didJoin = true; joined(phone); },
      ended: (reason) => {
        if (!didJoin) failed(new TailPocketHostError(reason === 'expired' ? 'expired' : reason));
        local?.reject(new TailPocketHostError('local-not-approved'));
        closedResolve(reason);
      },
      code: async (code, device) => {
        let approve = false;
        try { approve = !!(await local?.confirm(code, device)); } catch {}
        this.#send({ cmd: 'confirm', id, approve });
      },
      cancelled: () => local?.onCancel?.(),
      delivered: () => { local?.resolve(); local = undefined; },
      localError: (err) => { if (!local) return false; local.reject(err); local = undefined; return true; },
    });
    const e = await this.#request({ cmd: 'pair', id, ttl: options.ttl, payload: options.payload, qrPrefix: options.qrPrefix, qrPrefix2: options.qrPrefix2,
      emoji: !!options.emoji }).catch((err) => {
      this.#pairings.delete(id);
      throw err;
    });
    const host = this;
    return Object.assign(pairing, {
      id, qr: e.qr, invite: e.invite, qr2: e.qr2, invite2: e.invite2, expiresAt: new Date(e.expiresAt * 1000), paired, closed,
      /** Answer the current `request`: true once the computer's user saw the same emoji as the phone. */
      confirm(approve) { host.#send({ cmd: 'confirm', id, approve: !!approve }); },
      /** Advertise this window on the Wi-Fi; resolves once a phone you approved has the invite. */
      local({ service, confirm, label, instance, onCancel }) {
        if (typeof confirm !== 'function') return Promise.reject(new TypeError('confirm(code, device) is required'));
        return new Promise((resolve, reject) => {
          local = { confirm, resolve, reject, onCancel };
          host.#send({ cmd: 'local', id, service, label, instance });
        });
      },
      cancel() { host.#send({ cmd: 'cancel', id }); },
    });
  }

  /** Replace the paired phones (removing one restarts the node; other phones reconnect). */
  async setAllowed(phones) { await this.#request({ cmd: 'setAllowed', allowed: phones }); }

  /** Remove one phone: its connections close; other phones stay connected. */
  async revoke(phone) { await this.#request({ cmd: 'revoke', phone }); }

  /** Close one phone's connections and keep it paired, e.g. when its sign-in ran out. */
  async disconnect(phone) { await this.#request({ cmd: 'disconnect', phone }); }

  /** The address, the routes phones use, and each relay: "up" or why not. */
  async status() { return this.#request({ cmd: 'status' }); }

  /** Stop the helper. */
  async close() {
    if (!this.#closed) {
      this.#closed = true;
      this.#child.stdin.end();
      const timer = setTimeout(() => this.#child.kill(), 5000);
      await this.#exited;
      clearTimeout(timer);
    }
  }
}
