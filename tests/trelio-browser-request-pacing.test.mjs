import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createBrowserRequestPacing } from '../host-runtime/scripts/trelio-browser-policy.mjs';

function harness(factory, { random = () => 0, early = false, deferred = false } = {}) {
  let time = 100;
  const delays = [], timers = [];
  const now = () => time;
  const setTimer = (done, ms) => {
    delays.push(ms);
    const complete = () => { time += early && delays.length === 1 ? ms - 1 : ms; done(); };
    if (deferred) timers.push(complete); else complete();
  };
  return { controller: factory({ now, random, setTimer }), delays, advance: ms => { time += ms; }, release: () => timers.shift()() };
}
const nativeFactory = deps => createBrowserRequestPacing({ now: deps.now, random: deps.random, sleep: ms => new Promise(resolve => deps.setTimer(resolve, ms)) });

/** Read-only parity with the ACTUAL delivered controllers, not copied fixtures.
 * The exact public provider checkout is an explicit maintainer/CI input. No
 * browser or external search is invoked; the original snippets run in a VM
 * with synthetic monotonic time, randomness and timers.
 */
const factories = [['runtime', nativeFactory]];
const root = process.env.TRELIO_AGENT_SKILLS_ROOT;
if (root) for (const [skill, variable, ready] of [['yandex-search', 'yandexSearchPacing', 'resultsReady'], ['google-ai-search', 'googleAiPacing', 'answerReady']]) {
  const markdown = fs.readFileSync(path.join(root, 'platform-skills', skill, 'SKILL.md'), 'utf8');
  const snippet = [...markdown.matchAll(/```javascript\r?\n([\s\S]*?)```/gu)].map(match => match[1]).find(source => source.startsWith(`var ${variable} =`));
  assert.ok(snippet, `Missing exact ${skill} pacing source`);
  factories.push([skill, deps => {
    const scope = vm.createContext({ Math: { floor: Math.floor, ceil: Math.ceil, random: deps.random }, performance: { now: deps.now }, setTimeout: deps.setTimer });
    vm.runInContext(snippet, scope, { timeout: 1000 });
    const actual = scope[variable];
    return { submit: callback => actual.submit(callback), observe: callback => actual.observe(callback), resultsReady: () => actual[ready]() };
  }]);
}
const observeReady = async h => { await h.controller.observe(() => 'new completed result'); h.controller.resultsReady(); };

for (const [name, factory] of factories) {
  test(`${name}: first request is immediate; every follow-up uses inclusive 2–15s`, async () => {
    const randoms = [0, 1 - Number.EPSILON, 0.5];
    const h = harness(factory, { random: () => randoms.shift() });
    await h.controller.submit(() => 'first'); assert.deepEqual(h.delays, []);
    for (let i = 0; i < 3; i++) { await observeReady(h); await h.controller.submit(() => 'next'); }
    assert.deepEqual(h.delays, [2000, 15000, 8500]);
    assert.equal(randoms.length, 0);
  });
  test(`${name}: thinking before/after review counts; only the remainder is waited`, async () => {
    for (const before of [true, false]) {
      const h = harness(factory, { random: () => 8000 / 13001 });
      await h.controller.submit(() => undefined);
      await h.controller.observe(() => 'new result');
      if (before) h.advance(7000);
      h.controller.resultsReady();
      if (!before) h.advance(7000);
      await h.controller.submit(() => undefined);
      assert.deepEqual(h.delays, [3000]);
      await observeReady(h); h.advance(60_000); await h.controller.submit(() => undefined);
      assert.deepEqual(h.delays, [3000]);
    }
  });
  test(`${name}: early timers and concurrent callers cannot shorten the interval`, async () => {
    const h = harness(factory, { early: true });
    await h.controller.submit(() => undefined); await observeReady(h); await h.controller.submit(() => undefined);
    assert.deepEqual(h.delays, [2000, 1]);
    const queued = harness(factory, { deferred: true }); let sends = 0;
    await queued.controller.submit(() => ++sends); await observeReady(queued);
    const next = queued.controller.submit(() => ++sends);
    assert.equal(sends, 1); await assert.rejects(queued.controller.submit(() => ++sends));
    queued.release(); await next; assert.equal(sends, 2);
  });
  test(`${name}: unknown submission and failed observation cannot replay or reuse old evidence`, async () => {
    const h = harness(factory); let sends = 0;
    await assert.rejects(h.controller.submit(() => { sends++; throw Error('synthetic unknown outcome'); }));
    await assert.rejects(h.controller.submit(() => ++sends)); assert.equal(sends, 1);
    assert.throws(() => h.controller.resultsReady());
    await h.controller.observe(() => 'new completed result');
    await assert.rejects(h.controller.observe(() => { throw Error('synthetic observation failure'); }));
    assert.throws(() => h.controller.resultsReady());
    await observeReady(h); await h.controller.submit(() => ++sends); assert.equal(sends, 2);
  });
}
