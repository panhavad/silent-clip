// The heavy part of making a server clip: speech-to-text, streamer-cam detection and the 9:16 render. Pure media
// work on files (no database), so it runs in the clip worker process (clip-worker.js), away from the server.
import { renderServer, extractAudioServer } from './render.js';
import { transcribeServer } from './transcribe.js';
import { detectCamServer } from './facecam.js';
import { needsDetection, resolvePlan, describePlan } from '../../public/js/engine/facecam.js';

/**
 * @param job { dir, input, offsetSec, durationSec, subtitles: boolean, language, layout, camStored, camPosition,
 *              resolution, captions, caption, thumbAt }
 * @param hooks { stage(name), note(message) }
 * @returns { subtitles, transcript, detected, cam, out }
 */
export async function processClipMedia(job, { stage = () => {}, note = () => {} } = {}) {
  let subtitles = [];
  let transcript = '';
  if (job.subtitles) {
    stage('transcribing');
    try {
      const audio = await extractAudioServer(job.input, job.offsetSec, job.durationSec);
      const sub = await transcribeServer(audio, job.durationSec, job.language);
      subtitles = sub.phrases;
      transcript = sub.text;
    } catch (e) {
      note(`Subtitles skipped: ${e.message}`);
    }
  }
  let cam = null;
  let detected = null;
  if (job.layout === 'facecam') {
    stage('finding the streamer cam');
    if (needsDetection(job.camStored)) {
      try {
        detected = await detectCamServer(job.input, job.offsetSec, job.durationSec);
      } catch (e) {
        note(`Streamer cam detection failed: ${e.message}`);
      }
    }
    cam = resolvePlan(job.camStored, detected);
    note(describePlan(cam));
  }
  stage('rendering');
  const out = await renderServer({
    dir: job.dir, input: job.input, offsetSec: job.offsetSec, durationSec: job.durationSec,
    layout: job.layout, cam, camPosition: job.camPosition, resolution: job.resolution, captions: job.captions,
    caption: job.caption, subtitles, thumbAt: job.thumbAt,
  });
  return { subtitles, transcript, detected, cam, out };
}
