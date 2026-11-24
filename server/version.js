// Build identity shown in the UI and /healthz so you can tell which release is deployed.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
// Written by the Docker build (.git is not copied into the image).
const stamp = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'build.json'), 'utf8')); } catch { return {}; } })();

function gitCommit() {
  if (process.env.APP_COMMIT) return process.env.APP_COMMIT;
  if (stamp.commit) return stamp.commit;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim();
  } catch {
    return '';
  }
}

const commit = gitCommit();
const builtAt = process.env.APP_BUILD_TIME || stamp.builtAt || '';

export const buildInfo = {
  version,
  commit: commit.slice(0, 7),
  commitFull: commit,
  builtAt,
  startedAt: new Date().toISOString(),
  label: `v${version}${commit ? ` (${commit.slice(0, 7)})` : ''}`,
};
