import type { SandboxDriver } from "./driver.js";
import type { DriverName } from "./schema.js";
import { DriverNotFoundError } from "./errors.js";
import { OrbStackDriver } from "../drivers/orbstack/index.js";
import { AppleDriver } from "../drivers/apple/index.js";

/**
 * Driver factories keyed by name. `auto` is not a real driver — it triggers
 * detection. Order matters for auto-detect: earlier = preferred. OrbStack first
 * because its persistent-VM + cheap-clone model is the better fit for repeated
 * agent sessions; Apple `container` is the fallback.
 */
const factories = new Map<string, () => SandboxDriver>([
  ["orbstack", () => new OrbStackDriver()],
  ["apple", () => new AppleDriver()],
]);

/** Register a custom driver factory. Lets consumers add Docker/etc. out of tree. */
export function registerDriver(name: string, factory: () => SandboxDriver): void {
  factories.set(name, factory);
}

export function listDriverNames(): string[] {
  return [...factories.keys()];
}

/**
 * Resolve a driver by name. "auto" probes each registered driver in priority
 * order and returns the first available one. An explicit name is returned
 * without an availability probe — `preflight()` is the caller's job and gives a
 * better error.
 */
export async function resolveDriver(name: DriverName | string = "auto"): Promise<SandboxDriver> {
  if (name !== "auto") {
    const factory = factories.get(name);
    if (!factory) {
      throw new DriverNotFoundError(`unknown driver "${name}". Available: ${listDriverNames().join(", ")}`);
    }
    return factory();
  }

  for (const factory of factories.values()) {
    const driver = factory();
    if (await driver.isAvailable()) return driver;
  }
  throw new DriverNotFoundError(
    `no sandbox backend available. Install OrbStack (https://orbstack.dev) or Apple's container CLI (https://github.com/apple/container), or pass an explicit { driver }.`,
  );
}
