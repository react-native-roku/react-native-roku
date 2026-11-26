import { RokuHostError } from "../scene/sceneGraph.types";
import type { DeviceStorage } from "./DeviceServices";
export interface RegistrySectionPort {
  read(key: string): string | null;
  write(key: string, value: string): boolean;
  delete(key: string): boolean;
  exists(key: string): boolean;
}
export interface RegistryPort {
  create(section: string): RegistrySectionPort;
  flush(): Promise<boolean>;
}
export interface SecretCodec {
  encode(value: string): Promise<string>;
  decode(value: string): Promise<string>;
}
/** Serialized writes resolve only after the native registry confirms its durable flush. */
export class RegistryStorage implements DeviceStorage {
  private pending: Promise<unknown> = Promise.resolve();
  private failed = false;
  constructor(
    private readonly registry: RegistryPort,
    private readonly secrets?: SecretCodec,
    private readonly prefix = "react-native-roku",
  ) {}
  read(section: string, key: string): Promise<string | null> {
    return this.enqueue(async () => {
      const value = this.section(section).read(key);
      return value == null ? null : section === "secure" ? this.codec().decode(value) : value;
    });
  }
  write(section: string, key: string, value: string | null): Promise<void> {
    return this.enqueue(async () => {
      const port = this.section(section),
        previous = port.read(key);
      if (value === null && previous === null) return;
      let encoded = value;
      if (value !== null && section === "secure") encoded = await this.codec().encode(value);
      if (encoded === previous) return;
      const apply = (next: string | null) =>
        next === null ? !port.exists(key) || port.delete(key) : port.write(key, next);
      let failure: unknown;
      try {
        if (!apply(encoded) || !(await this.registry.flush()))
          throw new RokuHostError(
            "C21_STORAGE_FLUSH",
            "The native registry did not confirm persistence",
          );
        return;
      } catch (error) {
        failure = error;
      }
      try {
        if (!apply(previous) || !(await this.registry.flush()))
          throw new Error("rollback not confirmed");
      } catch {
        this.failed = true;
        throw new RokuHostError(
          "C21_STORAGE_RECOVERY",
          "A failed registry write could not be rolled back; reopen the app before using persistent state",
        );
      }
      throw failure;
    });
  }
  private section(name: string): RegistrySectionPort {
    if (!/^[a-z][a-z0-9-]*$/.test(name))
      throw new RokuHostError("C21_STORAGE_SECTION", "Storage section must be a stable namespace");
    return this.registry.create(`${this.prefix}-${name}`);
  }
  private codec(): SecretCodec {
    if (!this.secrets)
      throw new RokuHostError("C21_SECRET_STORAGE", "Device credential encryption is unavailable");
    return this.secrets;
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.pending.then(() => {
      if (this.failed)
        throw new RokuHostError("C21_STORAGE_RECOVERY", "Persistent storage awaits app recovery");
      return work();
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }
}
