/** The same completion-based pacing contract delivered by the Yandex Search
 * and Google AI Search skills. The owning browser worker keeps ONE controller
 * for the logical search session; short CLI calls must not reset its clock.
 *
 * Only the model can decide whether a fresh observation contains the completed
 * result of the new request. Everything else (serialization, random interval,
 * remaining wait and ambiguous-outcome fence) is enforced here, not by a prompt.
 * Injected clocks/timers are test dependencies, never browser/model arguments.
 */
export function createBrowserRequestPacing({
  now = () => performance.now(),
  random = () => Math.random(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  let state = 'initial', observedAt = null, nextRequestAt = 0;
  return Object.freeze({
    get state() { return state; },
    async submit(sendOnce) {
      if (state !== 'initial' && state !== 'ready') throw new Error('BROWSER_REQUEST_PREVIOUS_RESULT_NOT_REVIEWED');
      const needsPause = state === 'ready';
      // Claim the submission before the first await: a concurrent caller must
      // not race the same ready state or obtain its own independent timer.
      state = 'waiting';
      try {
        if (needsPause) {
          let remainingMs = nextRequestAt - now();
          while (remainingMs > 0) {
            await sleep(Math.ceil(remainingMs));
            // Timers can fire early. A monotonic deadline, not a single sleep,
            // owns the interval. Thinking/reading time already counts toward it.
            remainingMs = nextRequestAt - now();
          }
        }
        observedAt = null;
        state = 'submitting';
        const result = await sendOnce();
        state = 'awaiting-results';
        return result;
      } catch (error) {
        // A thrown UI action may already have reached the service. Never replay
        // it here or return to ready merely because the caller caught an error.
        state = 'unknown';
        throw error;
      }
    },
    async observe(readState) {
      observedAt = null;
      const result = await readState();
      observedAt = now();
      return result;
    },
    resultsReady() {
      if (!['awaiting-results', 'unknown'].includes(state) || observedAt === null) throw new Error('BROWSER_REQUEST_NO_RESULT_TO_REVIEW');
      // Inclusive integer range [2000, 15000], selected once per reviewed new
      // result. Timestamp is the observation time, before semantic model review.
      nextRequestAt = observedAt + 2000 + Math.floor(random() * 13001);
      state = 'ready';
    },
  });
}
