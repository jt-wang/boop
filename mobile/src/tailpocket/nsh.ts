// The client for NSH apps: `import { tailPocket } from ".../sdk/js/nsh.ts"`. The embedding app registers
// the bridge (TailPocketNsh.attach on iOS and Android), and nsh.json lists the tailPocket.* names
// under capabilities.host.
import { host } from "nsh";
import { createTailPocket } from "./client.ts";

export * from "./client.ts";

export const tailPocket = createTailPocket({
  call: (name, args, timeoutMs) => host.call(name, args ?? null, timeoutMs === undefined ? null : { timeout: timeoutMs }),
  on: (event, listener) => host.on(event, listener),
});
