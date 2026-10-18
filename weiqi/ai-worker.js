/* AI 在独立线程中计算，避免阻塞棋盘交互。 */
importScripts('engine.js', 'ai.js');

self.onmessage = function (event) {
  const payload = event.data || {};
  const id = payload.id;

  try {
    const result = payload.type === 'analyze'
      ? self.GoAI.analyzePosition(payload)
      : self.GoAI.chooseMove(payload);
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({
      id,
      error: error && error.message ? error.message : String(error),
    });
  }
};
