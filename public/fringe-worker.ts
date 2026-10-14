import { estimateFringe } from "./fringe.js";
type WorkerScope = { onmessage: ((event: MessageEvent<Parameters<typeof estimateFringe>[0]>) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void };
const worker = self as unknown as WorkerScope;
worker.onmessage = (event) => {
  try {
    const result = estimateFringe(event.data);
    worker.postMessage(result, [result.alpha.buffer as ArrayBuffer]);
  } catch (error) {
    worker.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
