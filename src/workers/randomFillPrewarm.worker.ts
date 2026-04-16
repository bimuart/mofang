import { randomFillRemainingByConstraintChainB } from '../cube/cubeConstraints';

export type RandomFillPrewarmIn = { type: 'compute'; gen: number; snapshot: string };
export type RandomFillPrewarmOut =
  | { type: 'done'; gen: number; snapshot: string; out: string }
  | { type: 'error'; gen: number; message: string };

self.onmessage = (ev: MessageEvent<RandomFillPrewarmIn>) => {
  const data = ev.data;
  if (data?.type !== 'compute') return;
  const { gen, snapshot } = data;
  try {
    const out = randomFillRemainingByConstraintChainB(snapshot);
    self.postMessage({ type: 'done', gen, snapshot, out } satisfies RandomFillPrewarmOut);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    self.postMessage({ type: 'error', gen, message } satisfies RandomFillPrewarmOut);
  }
};
