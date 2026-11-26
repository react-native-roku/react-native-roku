import { expect, it, vi } from "vitest";
import { createCanvasFontRegistry } from "./CanvasResources";

it("shares exact font identities, retains active leases and retires bounded idle entries", async () => {
  const register = vi.fn((uri: string, family: string) => ({ uri, family })),
    unregister = vi.fn();
  const fonts = createCanvasFontRegistry({ register, unregister, limit: 1 });
  const first = fonts.createOwner(),
    second = fonts.createOwner();
  await Promise.all([first.ready("font:/one", "Body"), second.ready("font:/one", "Body")]);
  expect(register).toHaveBeenCalledOnce();
  first.dispose();
  fonts.retireUnused();
  expect(unregister).not.toHaveBeenCalled();
  expect(fonts.snapshot()).toMatchObject({ registrations: 1, owners: 1 });
  await expect(second.ready("font:/two", "Other")).rejects.toThrow("budget");
  second.dispose();
  second.dispose();
  const third = fonts.createOwner();
  await third.ready("font:/two", "Other");
  expect(unregister).toHaveBeenCalledOnce();
  third.dispose();
  fonts.retireUnused();
  expect(unregister).toHaveBeenCalledTimes(2);
  expect(fonts.snapshot()).toMatchObject({ registrations: 0, pending: 0, owners: 0 });
});

it("releases late font completion after disposal without publishing an owner", async () => {
  let complete!: (key: object) => void;
  const unregister = vi.fn(),
    fonts = createCanvasFontRegistry({
      register: () =>
        new Promise<object>((done) => {
          complete = done;
        }),
      unregister,
    });
  const owner = fonts.createOwner(),
    ready = owner.ready("font:/late", "Late");
  const failed = expect(ready).rejects.toThrow("retired");
  await Promise.resolve();
  owner.dispose();
  complete({ id: "late" });
  await failed;
  fonts.retireUnused();
  expect(unregister).toHaveBeenCalledOnce();
  expect(fonts.snapshot().registrations).toBe(0);
});

it("does not invoke a font factory after immediate retirement or pre-abort", async () => {
  const register = vi.fn(),
    fonts = createCanvasFontRegistry({ register, unregister() {} });
  const owner = fonts.createOwner(),
    ready = owner.ready("font:/queued", "Queued");
  owner.dispose();
  await expect(ready).rejects.toThrow("retired");
  const next = fonts.createOwner(),
    controller = new AbortController(),
    original = Error("cancel");
  controller.abort(original);
  await expect(next.ready("font:/aborted", "Aborted", controller.signal)).rejects.toBe(original);
  expect(register).not.toHaveBeenCalled();
  expect(fonts.snapshot().registrations).toBe(0);
});

it("preserves failed preparation, permits a new attempt and releases an aborted registration", async () => {
  const original = Error("font preparation"),
    register = vi.fn().mockRejectedValueOnce(original).mockResolvedValue("key");
  const unregister = vi.fn(),
    fonts = createCanvasFontRegistry({ register, unregister });
  const owner = fonts.createOwner();
  await expect(owner.ready("font:/bad", "Bad")).rejects.toBe(original);
  expect(fonts.snapshot().registrations).toBe(0);
  await owner.ready("font:/good", "Good");
  const controller = new AbortController();
  const pending = owner.ready("font:/aborted", "Aborted", controller.signal);
  controller.abort(original);
  await expect(pending).rejects.toBe(original);
  expect(unregister).toHaveBeenCalledOnce();
  owner.dispose();
  fonts.retireUnused();
  expect(fonts.snapshot().registrations).toBe(0);
});

it("attempts every idle unregister and retains failed releases for an explicit retry", async () => {
  let fail = true;
  const unregister = vi.fn((key: string) => {
    if (key === "bad" && fail) throw Error("unregister");
  });
  const fonts = createCanvasFontRegistry({ register: (uri) => uri, unregister });
  const owner = fonts.createOwner();
  await owner.ready("bad", "Bad");
  await owner.ready("good", "Good");
  owner.dispose();
  expect(() => fonts.retireUnused()).toThrow("unregister");
  expect(unregister.mock.calls.map(([key]) => key)).toEqual(["bad", "good"]);
  expect(fonts.snapshot().registrations).toBe(1);
  fail = false;
  fonts.retireUnused();
  expect(unregister.mock.calls.map(([key]) => key)).toEqual(["bad", "good", "bad"]);
  expect(fonts.snapshot().registrations).toBe(0);
});

it("keeps a successful same-owner font lease when a parallel size preparation aborts", async () => {
  const unregister = vi.fn(),
    fonts = createCanvasFontRegistry({ register: () => "shared", unregister });
  const owner = fonts.createOwner(),
    controller = new AbortController();
  const ready = owner.ready("font:/shared", "Body");
  const aborted = owner.ready("font:/shared", "Body", controller.signal);
  controller.abort();
  await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
  await ready;
  fonts.retireUnused();
  expect(unregister).not.toHaveBeenCalled();
  expect(fonts.snapshot().owners).toBe(1);
  owner.dispose();
  fonts.retireUnused();
  expect(unregister).toHaveBeenCalledOnce();
});
