export class CommitGuard {
  constructor() {
    this.generation = 0;
    this.controller = null;
  }

  begin(reason = 'commit') {
    this.cancel();
    this.generation += 1;
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const token = {
      generation,
      reason,
      signal: controller.signal,
      isCurrent: () => this.generation === generation && !controller.signal.aborted
    };
    return token;
  }

  cancel() {
    if (this.controller && !this.controller.signal.aborted) this.controller.abort();
    this.controller = null;
  }

  commit(token, value) {
    if (!token || token.generation !== this.generation || token.signal?.aborted) {
      return { accepted: false, stale: true, generation: token?.generation ?? null, currentGeneration: this.generation };
    }
    this.controller = null;
    return { accepted: true, stale: false, value, generation: token.generation };
  }
}

export function createLatestTaskRunner(handler) {
  let generation = 0;
  let activeController = null;

  return function run(payload, options = {}) {
    generation += 1;
    const currentGeneration = generation;
    if (activeController && !activeController.signal.aborted) activeController.abort();
    activeController = new AbortController();
    const signal = activeController.signal;
    const isCurrent = () => currentGeneration === generation && !signal.aborted;

    return Promise.resolve()
      .then(() => handler(payload, { generation: currentGeneration, signal, isCurrent, ...options }))
      .then((result) => {
        if (!isCurrent()) return { stale: true, accepted: false, generation: currentGeneration };
        return { stale: false, accepted: true, result, generation: currentGeneration };
      })
      .catch((error) => {
        if (!isCurrent()) return { stale: true, accepted: false, generation: currentGeneration };
        throw error;
      });
  };
}

export const StaleCommitGuard = CommitGuard;
export const LatestTaskRunner = createLatestTaskRunner;
export function createCancellationToken() {
  const guard = new CommitGuard();
  return guard.begin('cancellation-token');
}
