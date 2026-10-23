const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { update } = require('./update.cjs');

const names = ['GeoLite2-City.mmdb', 'GeoLite2-ASN.mmdb'];
const commit = '9cee0e9007ecb574533a4a2f28623b78f84b18a1';
const hash = buffer => createHash('sha256').update(buffer).digest('hex');
const blobHash = buffer => createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');
const repo = path.resolve(__dirname, '../..');
const buffers = Promise.all(names.map(async file => [file, await fs.readFile(path.join(repo, 'server', file))])).then(Object.fromEntries);
let old;
function originals(data) {
  // Make older, valid MMDB fixtures by changing only their build timestamp.
  // This keeps the tests independent of Git history and future data refreshes.
  old ??= Object.fromEntries(names.map(file => {
    const buffer = Buffer.from(data[file]);
    let offset = buffer.lastIndexOf(Buffer.from('build_epoch')) + 11;
    assert.ok(offset > 11);
    const size = buffer[offset] & 31;
    let type = buffer[offset++] >> 5;
    if (type === 0) type = buffer[offset++] + 7;
    assert.ok(type === 6 || type === 9);
    assert.ok(size >= 4 && size <= 8);
    buffer.fill(0, offset, offset + size);
    buffer.writeUInt32BE(1_600_000_000, offset + size - 4);
    return [file, buffer];
  }));
  return old;
}

async function fixture(t, data) {
  data ??= await buffers;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rybbit-geoip-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const file of names) await fs.writeFile(path.join(root, file), data[file]);
  return root;
}

function upstream(data, { badChecksum = false } = {}) {
  const urls = [];
  const fetchImpl = async url => {
    urls.push(url);
    const file = names.find(name => url.includes(name));
    if (!file) throw new Error(`Unexpected URL: ${url}`);
    if (url.includes('/commits?')) return Response.json([{ sha: commit }]);
    if (url.includes('/contents/')) return Response.json({ sha: badChecksum ? '0'.repeat(40) : blobHash(data[file]) });
    return new Response(data[file]);
  };
  return { fetchImpl, urls };
}

test('unchanged databases do not restart workers; subsequent checks skip downloads', async t => {
  const data = await buffers;
  const root = await fixture(t, data);
  const source = upstream(data);
  let reloads = 0;
  const options = { root, fetchImpl: source.fetchImpl, reload: async () => reloads++, log() {} };
  await update(options);
  const first = source.urls.length;
  await update(options);
  assert.equal(reloads, 0);
  assert.equal(first, 6);
  assert.equal(source.urls.length - first, 2);
});

test('installs both newer databases before reloading once', async t => {
  const data = await buffers;
  const root = await fixture(t, originals(data));
  let reloads = 0;
  await update({ root, ...upstream(data), log() {}, reload: async () => {
    reloads++;
    for (const file of names) assert.equal(hash(await fs.readFile(path.join(root, file))), hash(data[file]));
  } });
  assert.equal(reloads, 1);
  assert.ok(await fs.readFile(path.join(root, '.geoip-update.json'), 'utf8'));
});

test('checksum failures preserve installed databases and release the lock', async t => {
  const data = await buffers;
  const root = await fixture(t, data);
  await assert.rejects(update({ root, ...upstream(data, { badChecksum: true }), log() {} }), /checksum mismatch/);
  for (const file of names) assert.equal(hash(await fs.readFile(path.join(root, file))), hash(data[file]));
  await assert.rejects(fs.stat(path.join(root, '.geoip-update.lock')), { code: 'ENOENT' });
});

test('refuses older upstream data without restarting or changing files', async t => {
  const data = await buffers;
  const root = await fixture(t, data);
  let reloads = 0;
  await assert.rejects(update({ root, ...upstream(originals(data)), log() {}, reload: async () => reloads++ }), /Refusing to downgrade/);
  assert.equal(reloads, 0);
  assert.equal(hash(await fs.readFile(path.join(root, names[0]))), hash(data[names[0]]));
});

test('failed reload restores both databases and retries loading the originals', async t => {
  const data = await buffers;
  const previous = originals(data);
  const root = await fixture(t, previous);
  let reloads = 0;
  await assert.rejects(update({ root, ...upstream(data), log() {}, reload: async () => {
    if (++reloads === 1) throw new Error('Worker readiness failed');
    for (const file of names) assert.equal(hash(await fs.readFile(path.join(root, file))), hash(previous[file]));
  } }), /Worker readiness failed/);
  assert.equal(reloads, 2);
  await assert.rejects(fs.stat(path.join(root, '.geoip-update.json')), { code: 'ENOENT' });
});

test('skips an overlapping execution', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, '.geoip-update.lock'));
  await update({ root, fetchImpl: async () => { throw new Error('Must not fetch'); }, log() {} });
  assert.ok(await fs.stat(path.join(root, '.geoip-update.lock')));
});
