import { estimateFringe } from "./fringe.js";
self.onmessage = (event) => {
  try {
    const result = estimateFringe(event.data);
    self.postMessage(result, [result.alpha.buffer]);
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
