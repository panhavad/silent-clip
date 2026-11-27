// Clip worker process (forked by clip-runner.js). Speech-to-text, cam detection and rendering need several hundred
// MB at their peak; doing them here means that when the server runs short of memory, the system ends this process
// (it volunteers to go first) instead of the server, so watching and the chat baselines carry on.
import fs from 'node:fs';
import { processClipMedia } from './clip-job.js';

// Ask the Linux OOM killer to pick this process (and the ffmpeg it starts) before the server.
try { fs.writeFileSync('/proc/self/oom_score_adj', '1000'); } catch { /* not Linux, or not allowed */ }

const send = (msg) => { try { process.send(msg); } catch { /* parent gone */ } };

process.on('message', async ({ id, job }) => {
  if (job?.testCrash) process.exit(137); // tests: behave like a process killed for using too much memory
  try {
    const result = await processClipMedia(job, {
      stage: (stage) => send({ id, type: 'stage', stage }),
      note: (message) => send({ id, type: 'note', message }),
    });
    send({ id, type: 'done', result });
  } catch (e) {
    send({ id, type: 'error', message: e?.message || String(e) });
  }
});
process.on('disconnect', () => process.exit(0));
send({ type: 'ready' });
