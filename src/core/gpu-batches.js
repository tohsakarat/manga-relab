/* Registration embeds this helper in each editable GPU filter script. */
'use strict';

function createGPUBatchRunner(device) {
  const channel = new MessageChannel();
  let resume;
  channel.port1.onmessage = () => resume();
  function yieldToWorker() {
    return new Promise(resolve => {
      resume = resolve;
      channel.port2.postMessage(null);
    });
  }

  async function run({ count, batchSize, maxBatchSize, minBatchSize = 64, submit, progress }) {
    const targetMs = 16;
    const pending = [];
    let next = 0, completed = 0, sampledPixels = 0;
    let sampleStart = performance.now();
    function enqueue() {
      const size = Math.min(batchSize, count - next);
      submit(next, size);
      next += size;
      // Capture this submission's fence before adding work for the next batch.
      pending.push(device.queue.onSubmittedWorkDone().then(() => ({ size, finishedAt: performance.now() })));
    }
    while (next < count && pending.length < 2) enqueue();
    while (pending.length) {
      const { size, finishedAt } = await pending.shift();
      completed += size;
      sampledPixels += size;
      progress(completed);
      const elapsed = finishedAt - sampleStart;
      if (elapsed >= targetMs) {
        // Completion notifications estimate throughput, including scheduling overhead.
        // Limit each adjustment so one timing sample cannot suddenly fill the queue.
        const estimate = sampledPixels * targetMs / elapsed;
        const adjusted = Math.max(batchSize / 2, Math.min(batchSize * 2, estimate));
        const aligned = adjusted < 64 ? Math.floor(adjusted) : Math.floor(adjusted / 64) * 64;
        batchSize = Math.max(minBatchSize, Math.min(maxBatchSize, aligned));
        sampledPixels = 0;
        sampleStart = finishedAt;
      }
      // A queued batch can keep computing while cancellation messages are handled.
      await yieldToWorker();
      while (next < count && pending.length < 2) enqueue();
    }
  }

  function close() {
    channel.port1.close();
    channel.port2.close();
  }
  return { run, close };
}
