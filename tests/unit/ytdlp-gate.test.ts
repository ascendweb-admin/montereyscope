import { describe, expect, it } from "vitest";

import { createExecutionGate } from "@/lib/ytdlp/gate";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("createExecutionGate", () => {
  it("runs at most `limit` tasks at once and queues the rest", async () => {
    const gate = createExecutionGate(2);
    const gates = [deferred<string>(), deferred<string>(), deferred<string>(), deferred<string>()];
    const started: number[] = [];

    const runs = gates.map((d, index) =>
      gate.run(async () => {
        started.push(index);
        return d.promise;
      }),
    );

    await Promise.resolve();
    expect(gate.activeCount).toBe(2);
    expect(gate.queuedCount).toBe(2);
    expect(started).toEqual([0, 1]);

    gates[0].resolve("a");
    // Microtask hops: release → queued task starts.
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);
    expect(gate.activeCount).toBe(2);
    expect(gate.queuedCount).toBe(1);

    gates[1].resolve("b");
    gates[2].resolve("c");
    gates[3].resolve("d");
    expect(await Promise.all(runs)).toEqual(["a", "b", "c", "d"]);
  });

  it("releases capacity as tasks settle until the queue drains", async () => {
    const gate = createExecutionGate(1);
    expect(gate.activeCount).toBe(0);

    const first = deferred<void>();
    const runningFirst = gate.run(() => first.promise);
    const runningSecond = gate.run(async () => "second");

    await Promise.resolve();
    expect(gate.activeCount).toBe(1);
    expect(gate.queuedCount).toBe(1);

    first.resolve(undefined);
    await runningFirst;
    expect(await runningSecond).toBe("second");
    expect(gate.activeCount).toBe(0);
    expect(gate.queuedCount).toBe(0);
  });

  it("propagates task failures without leaking slots", async () => {
    const gate = createExecutionGate(1);
    await expect(
      gate.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Slot must be free again after a failure.
    const probe = deferred<string>();
    const running = gate.run(() => probe.promise);
    await Promise.resolve();
    expect(gate.activeCount).toBe(1);
    probe.resolve("ok");
    expect(await running).toBe("ok");
  });

  it("treats non-positive limits as a single slot", async () => {
    const gate = createExecutionGate(0);
    const probe = deferred<string>();
    const a = gate.run(() => probe.promise);
    const b = gate.run(async () => "b");

    await Promise.resolve();
    expect(gate.activeCount).toBe(1);
    expect(gate.queuedCount).toBe(1);

    probe.resolve("a");
    expect(await a).toBe("a");
    expect(await b).toBe("b");
  });
});
