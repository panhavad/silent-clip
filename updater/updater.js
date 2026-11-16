// Auto-updater sidecar: pulls the private GitHub repo (username + token from env) and
// rebuilds/restarts the app with docker compose when a push lands on the tracked branch.
// Triggers: GitHub "push" webhook (forwarded by the app at /hooks/github) and/or polling.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const {
  GITHUB_USERNAME = '', GITHUB_TOKEN = '', GITHUB_REPO = '', GITHUB_BRANCH = 'main',
  GITHUB_WEBHOOK_SECRET = '', UPDATE_POLL_INTERVAL = '60', REPO_DIR = '/repo',
  COMPOSE_PROJECT = 'slientclip', UPDATE_SERVICES = 'app', PORT = '9000',
} = process.env;

const repo = GITHUB_REPO || (GITHUB_USERNAME ? `${GITHUB_USERNAME}/slientclip` : '');
const redact = (s) => String(s).split(GITHUB_TOKEN || '\u0000').join('***');
const log = (...a) => console.log(new Date().toISOString(), ...a.map(redact));
const state = { lastCheck: null, lastUpdate: null, lastError: null, head: null, updating: false };

async function git(...args) {
  const { stdout } = await run('git', ['-C', REPO_DIR, ...args], { maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

async function setupRepo() {
  await run('git', ['config', '--global', '--add', 'safe.directory', '*']);
  const remote = process.env.GIT_REMOTE_URL ||
    `https://${encodeURIComponent(GITHUB_USERNAME)}:${encodeURIComponent(GITHUB_TOKEN)}@github.com/${repo}.git`;
  if (!fs.existsSync(`${REPO_DIR}/.git`)) {
    log(`Initialising git checkout in ${REPO_DIR}`);
    await git('init', '-q');
    await git('remote', 'add', 'origin', remote);
    await git('fetch', '-q', 'origin', GITHUB_BRANCH);
    await git('reset', '-q', '--hard', `origin/${GITHUB_BRANCH}`);
  } else {
    const remotes = await git('remote');
    await git('remote', remotes.split('\n').includes('origin') ? 'set-url' : 'add', 'origin', remote);
  }
  state.head = await git('rev-parse', 'HEAD').catch(() => null);
  log(`Tracking ${repo || 'custom remote'}@${GITHUB_BRANCH} at ${state.head?.slice(0, 7) || 'unknown'}`);
}

async function hostRepoPath() {
  // Host path of our /repo bind mount, so a helper container can recreate this updater.
  const self = (await run('hostname')).stdout.trim();
  const { stdout } = await run('docker', ['inspect', self, '--format', `{{range .Mounts}}{{if eq .Destination "${REPO_DIR}"}}{{.Source}}{{end}}{{end}}`]);
  return stdout.trim();
}

async function compose(args, env = {}) {
  const { stdout, stderr } = await run('docker', ['compose', '-p', COMPOSE_PROJECT, '--project-directory', REPO_DIR, '-f', `${REPO_DIR}/docker-compose.yml`, ...args],
    { maxBuffer: 50 * 1024 * 1024, env: { ...process.env, ...env } });
  return `${stdout}\n${stderr}`.trim();
}

let pending = false;
async function update(reason) {
  if (state.updating) { pending = true; return; }
  state.updating = true;
  state.lastCheck = new Date().toISOString();
  try {
    await git('fetch', '-q', 'origin', GITHUB_BRANCH);
    const remoteHead = await git('rev-parse', `origin/${GITHUB_BRANCH}`);
    const localHead = await git('rev-parse', 'HEAD');
    if (remoteHead === localHead) return;
    log(`Update (${reason}): ${localHead.slice(0, 7)} -> ${remoteHead.slice(0, 7)}`);
    const changed = (await git('diff', '--name-only', localHead, remoteHead)).split('\n');
    await git('reset', '-q', '--hard', remoteHead);
    const hostPath = await hostRepoPath().catch(() => '');
    const env = hostPath ? { REPO_HOST_PATH: hostPath } : {};
    log(await compose(['up', '-d', '--build', '--no-deps', '--remove-orphans', ...UPDATE_SERVICES.split(/[\s,]+/).filter(Boolean)], env));
    if (changed.some((f) => f.startsWith('updater/')) && hostPath) {
      // Recreating ourselves would kill this process mid-command, so hand off to a one-shot helper.
      log('Updater changed - rebuilding it via helper container');
      await run('docker', ['run', '-d', '--rm', '-v', '/var/run/docker.sock:/var/run/docker.sock', '-v', `${hostPath}:${REPO_DIR}`,
        '-e', `REPO_HOST_PATH=${hostPath}`, '--entrypoint', 'docker', `${COMPOSE_PROJECT}-updater`,
        'compose', '-p', COMPOSE_PROJECT, '--project-directory', REPO_DIR, '-f', `${REPO_DIR}/docker-compose.yml`, 'up', '-d', '--build', '--no-deps', 'updater']);
    }
    state.head = remoteHead;
    state.lastUpdate = { at: new Date().toISOString(), commit: remoteHead, reason };
    state.lastError = null;
    log('Update complete');
  } catch (e) {
    state.lastError = redact(e.stderr || e.message);
    log('Update failed:', state.lastError);
  } finally {
    state.updating = false;
    if (pending) { pending = false; setTimeout(() => update('queued'), 1000); }
  }
}

function verifySignature(body, signature) {
  if (!GITHUB_WEBHOOK_SECRET) return false;
  const expected = `sha256=${crypto.createHmac('sha256', GITHUB_WEBHOOK_SECRET).update(body).digest('hex')}`;
  const a = Buffer.from(expected), b = Buffer.from(String(signature || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ repo, branch: GITHUB_BRANCH, ...state }));
  }
  if (req.method !== 'POST' || req.url !== '/hooks/github') { res.writeHead(404); return res.end(); }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (!verifySignature(body, req.headers['x-hub-signature-256'])) {
      res.writeHead(401); return res.end('invalid signature');
    }
    const event = req.headers['x-github-event'];
    if (event === 'ping') { res.writeHead(200); return res.end('pong'); }
    let payload = {};
    try { payload = JSON.parse(body.toString('utf8')); } catch { /* form-encoded payloads not supported */ }
    if (event === 'push' && payload.ref === `refs/heads/${GITHUB_BRANCH}`) {
      update(`push by ${payload.pusher?.name || 'unknown'}`);
      res.writeHead(202); return res.end('update scheduled');
    }
    res.writeHead(200); res.end('ignored');
  });
});

if (!process.env.GIT_REMOTE_URL && (!GITHUB_USERNAME || !GITHUB_TOKEN || !repo)) {
  log('GITHUB_USERNAME / GITHUB_TOKEN / GITHUB_REPO not set - auto-update disabled.');
  setInterval(() => {}, 1 << 30);
} else {
  await setupRepo().catch((e) => log('Repo setup failed:', e.stderr || e.message));
  server.listen(Number(PORT), () => log(`Webhook listener on :${PORT}/hooks/github${GITHUB_WEBHOOK_SECRET ? '' : ' (disabled: set GITHUB_WEBHOOK_SECRET)'}`));
  const every = Number(UPDATE_POLL_INTERVAL);
  if (every > 0) setInterval(() => update('poll'), every * 1000);
}
