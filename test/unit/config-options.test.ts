import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildConfigOptions } from "../../src/acp/agent.js";

describe("buildConfigOptions", () => {
  it("returns all three options", () => {
    const opts = buildConfigOptions({});
    assert.equal(opts.length, 3);
    const ids = opts.map((o) => o.id);
    assert.deepEqual(ids, ["auto_compaction", "steering_mode", "follow_up_mode"]);
  });

  it("auto_compaction: defaults to true when state is empty", () => {
    const opts = buildConfigOptions({});
    const ac = opts.find((o) => o.id === "auto_compaction")!;
    assert.equal(ac.type, "boolean");
    assert.equal((ac as any).currentValue, true);
  });

  it("auto_compaction: reflects false from state", () => {
    const opts = buildConfigOptions({ autoCompactionEnabled: false });
    const ac = opts.find((o) => o.id === "auto_compaction")!;
    assert.equal((ac as any).currentValue, false);
  });

  it("steering_mode: defaults to 'all' when missing from state", () => {
    const opts = buildConfigOptions({});
    const sm = opts.find((o) => o.id === "steering_mode")!;
    assert.equal(sm.type, "select");
    assert.equal((sm as any).currentValue, "all");
  });

  it("steering_mode: reflects state value", () => {
    const opts = buildConfigOptions({ steeringMode: "one-at-a-time" });
    const sm = opts.find((o) => o.id === "steering_mode")!;
    assert.equal((sm as any).currentValue, "one-at-a-time");
  });

  it("follow_up_mode: defaults to 'all' when missing from state", () => {
    const opts = buildConfigOptions({});
    const fm = opts.find((o) => o.id === "follow_up_mode")!;
    assert.equal((fm as any).currentValue, "all");
  });

  it("follow_up_mode: reflects state value", () => {
    const opts = buildConfigOptions({ followUpMode: "one-at-a-time" });
    const fm = opts.find((o) => o.id === "follow_up_mode")!;
    assert.equal((fm as any).currentValue, "one-at-a-time");
  });

  it("handles null/undefined state gracefully", () => {
    assert.doesNotThrow(() => buildConfigOptions(null));
    assert.doesNotThrow(() => buildConfigOptions(undefined));
    assert.doesNotThrow(() => buildConfigOptions("garbage"));
  });

  it("steering_mode and follow_up_mode expose exactly two options", () => {
    const opts = buildConfigOptions({});
    for (const id of ["steering_mode", "follow_up_mode"] as const) {
      const opt = opts.find((o) => o.id === id)!;
      const options = (opt as any).options as Array<{ value: string }>;
      assert.equal(options.length, 2);
      const values = options.map((o) => o.value);
      assert.ok(values.includes("all"));
      assert.ok(values.includes("one-at-a-time"));
    }
  });
});
