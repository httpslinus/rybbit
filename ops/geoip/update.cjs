// Downloaded at a pinned revision by Coolify's scheduled and deployment tasks.
// Run from /app (or server/ locally) so MaxMind resolves from the application.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const http = require('node:http');
const { Reader } = createRequire(path.join(process.cwd(), 'package.json'))('@maxmind/geoip2-node');

const repository = 'rybbit-io/rybbit';
const files = ['GeoLite2-City.mmdb', 'GeoLite2-ASN.mmdb'];
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function metadata(buffer, file) {
  const result = Reader.openBuffer(buffer).mmdbReader.metadata;
  if (result.databaseType !== file.replace('.mmdb', '') || !Number.isFinite(+result.buildEpoch)) {
    throw new Error(`Invalid database metadata: ${file}`);
  }
  return result;
}

async function request(url, fetchImpl) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': 'Rybbit-Cyberia-GeoIP-Updater', Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`Download returned HTTP ${response.status}: ${url}`);
      // Consume the body while the timeout is still active.
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > 100 * 1024 * 1024) throw new Error('Database exceeds the download size limit');
      return buffer;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await delay(1_000 * (attempt + 1));
    }
  }
  throw lastError;
}

async function workers() {
  const parentCommand = await fs.readFile('/proc/1/cmdline', 'utf8');
  if (!parentCommand.includes('dist/cluster.js')) throw new Error('Expected the Rybbit cluster primary at PID 1');
  const children = (await fs.readFile('/proc/1/task/1/children', 'utf8')).trim().split(/\s+/).filter(Boolean).map(Number);
  const result = [];
  for (const pid of children) {
    const command = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
    if (command.includes('dist/cluster.js')) result.push(pid);
  }
  if (result.length < 2) throw new Error('Rolling GeoIP reload requires at least two Rybbit workers');
  return result;
}

async function healthyWorker(pid) {
  // Cluster workers share the primary's listening socket. Prove that this
  // particular worker served a health request by matching its accepted socket
  // to the health client's ephemeral port, keeping the connection open to inspect.
  const agent = new http.Agent({ keepAlive: true });
  try {
    const health = await new Promise((resolve, reject) => {
      const request = http.get({ host: '127.0.0.1', port: 3001, path: '/api/health', agent }, response => {
        const port = response.socket.localPort;
        response.resume();
        response.on('end', () => resolve({ port, ok: response.statusCode === 200 }));
        response.on('error', reject);
      });
      request.on('error', reject);
      request.setTimeout(5_000, () => request.destroy(new Error('Health check timed out')));
    });
    if (!health.ok || !health.port) return false;
    const remotePort = `:${health.port.toString(16).toUpperCase().padStart(4, '0')}`;
    const descriptors = await fs.readdir(`/proc/${pid}/fd`);
    const sockets = new Set(await Promise.all(descriptors.map(fd => fs.readlink(`/proc/${pid}/fd/${fd}`).catch(() => ''))));
    for (const table of ['tcp', 'tcp6']) {
      const rows = (await fs.readFile(`/proc/${pid}/net/${table}`, 'utf8')).trim().split('\n').slice(1);
      if (rows.some(row => {
        const columns = row.trim().split(/\s+/);
        return columns[1].endsWith(':0BB9') && columns[2].endsWith(remotePort) && columns[3] === '01' && sockets.has(`socket:[${columns[9]}]`);
      })) return true;
    }
  } catch { /* A worker can disappear while it is being replaced. */ }
  finally { agent.destroy(); }
  return false;
}

async function reloadWorkers() {
  const original = await workers();
  for (const pid of original) {
    const before = await workers();
    process.kill(pid, 'SIGTERM');
    const deadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < deadline) {
      await delay(500);
      const current = (await fs.readFile('/proc/1/task/1/children', 'utf8')).trim().split(/\s+/).filter(Boolean).map(Number);
      for (const replacement of current.filter(candidate => !before.includes(candidate))) {
        if (await healthyWorker(replacement)) ready = true;
      }
      if (ready) break;
    }
    if (!ready) throw new Error(`Replacement for worker ${pid} did not start listening`);
    const response = await fetch('http://127.0.0.1:3001/api/health', { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error('Rybbit health check failed after worker reload');
  }
}

async function update({ root = process.cwd(), fetchImpl = fetch, reload = reloadWorkers, log = console.log } = {}) {
  const lock = path.join(root, '.geoip-update.lock');
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = await fs.stat(lock);
    if (Date.now() - stat.mtimeMs < 30 * 60_000) { log('Another GeoIP update is running; skipped.'); return; }
    await fs.rm(lock, { recursive: true });
    await fs.mkdir(lock, { mode: 0o700 });
  }
  const staged = [];
  try {
    const statePath = path.join(root, '.geoip-update.json');
    const state = await fs.readFile(statePath, 'utf8').then(JSON.parse).catch(() => ({}));
    const nextState = {};
    for (const file of files) {
      const target = path.join(root, file);
      const installed = await fs.readFile(target);
      const currentHash = sha256(installed);
      const current = metadata(installed, file);
      const commits = JSON.parse(await request(`https://api.github.com/repos/${repository}/commits?path=server/${file}&per_page=1`, fetchImpl));
      const commit = commits[0]?.sha;
      if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error(`Invalid upstream revision for ${file}`);
      if (state[file]?.commit === commit && state[file]?.sha256 === currentHash) {
        nextState[file] = state[file];
        log(`${file}: already current (${current.buildEpoch.toISOString().slice(0, 10)})`);
        continue;
      }
      const contents = JSON.parse(await request(`https://api.github.com/repos/${repository}/contents/server/${file}?ref=${commit}`, fetchImpl));
      const buffer = await request(`https://raw.githubusercontent.com/${repository}/${commit}/server/${file}`, fetchImpl);
      const blobHash = createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');
      if (blobHash !== contents.sha) throw new Error(`Upstream checksum mismatch for ${file}`);
      const candidate = metadata(buffer, file);
      if (+candidate.buildEpoch < +current.buildEpoch) throw new Error(`Refusing to downgrade ${file}`);
      const hash = sha256(buffer);
      nextState[file] = { commit, sha256: hash, buildDate: candidate.buildEpoch.toISOString() };
      if (hash === currentHash) { log(`${file}: already current (${nextState[file].buildDate.slice(0, 10)})`); continue; }
      const temporary = `${target}.next`;
      await fs.writeFile(temporary, buffer, { mode: 0o644 });
      staged.push({ target, temporary, file, previous: `${target}.previous` });
    }

    // Validate every download before replacing either database. Keep a rollback
    // copy until all workers have loaded the new files successfully.
    const installed = [];
    try {
      for (const item of staged) {
        await fs.copyFile(item.target, item.previous);
        await fs.rename(item.temporary, item.target);
        installed.push(item);
      }
      if (installed.length) {
        await reload();
        for (const item of installed) log(`${item.file}: installed ${nextState[item.file].buildDate.slice(0, 10)}`);
      }
    } catch (error) {
      for (const item of installed) await fs.copyFile(item.previous, item.target);
      if (installed.length) await reload().catch(rollbackError => log(`Rollback reload failed: ${rollbackError.message}`));
      throw error;
    }
    await fs.writeFile(`${statePath}.next`, JSON.stringify(nextState, null, 2));
    await fs.rename(`${statePath}.next`, statePath);
    for (const item of staged) await fs.rm(item.previous, { force: true });
    log(staged.length ? 'GeoIP update complete; Rybbit is healthy.' : 'No newer GeoIP databases available.');
  } finally {
    for (const item of staged) await fs.rm(item.temporary, { force: true });
    await fs.rm(lock, { recursive: true, force: true });
  }
}

module.exports = { update, healthyWorker, reloadWorkers };
if (require.main === module) update().catch(error => { console.error(`GeoIP update failed: ${error.message}`); process.exitCode = 1; });
