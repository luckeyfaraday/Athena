import assert from "node:assert/strict";
import test from "node:test";

import { memoizeAsyncWithTtl } from "../dist-electron/ttl-cache.js";

test("shares one in-flight promise and result within the TTL", async () => {
  let calls = 0;
  const cached = memoizeAsyncWithTtl(1000, async () => {
    calls += 1;
    return calls;
  });
  const inFlight = cached();
  assert.equal(cached(), inFlight, "concurrent callers receive the same promise");
  const [first, second] = await Promise.all([inFlight, cached()]);
  const third = await cached();
  assert.deepEqual([first, second, third], [1, 1, 1]);
  assert.equal(calls, 1);
});

test("re-invokes the factory after the TTL expires", async () => {
  let calls = 0;
  const cached = memoizeAsyncWithTtl(10, async () => {
    calls += 1;
    return calls;
  });
  assert.equal(await cached(), 1);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(await cached(), 2);
  assert.equal(calls, 2);
});

test("does not cache rejections", async () => {
  let calls = 0;
  const cached = memoizeAsyncWithTtl(1000, async () => {
    calls += 1;
    if (calls === 1) throw new Error("boom");
    return calls;
  });
  await assert.rejects(cached(), /boom/);
  assert.equal(await cached(), 2, "the next call retries instead of replaying the rejection");
  assert.equal(calls, 2);
});
