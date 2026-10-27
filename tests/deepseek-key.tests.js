'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { makeTempDir } = require('./temp-dir');
const { keyPath, readKey } = require('../bin/deepseek-key');

const script = path.join(__dirname, '..', 'bin', 'deepseek-key.js');

function world() {
  const root = makeTempDir('fleet-deepseek-key-');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(home, '.fleet-secrets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'deepseek.json'), JSON.stringify({ baseUrl: 'https://api.deepseek.com/anthropic', keyFile: '.fleet-secrets/deepseek-api-key' }));
  return { root, home, env: { USERPROFILE: home } };
}

test('the key file sits under the user profile at config/deepseek.json keyFile', () => {
  const w = world();
  assert.equal(keyPath(w.root, w.env), path.join(w.home, '.fleet-secrets', 'deepseek-api-key'));
});

test('readKey returns the trimmed key and refuses a missing or blank one', () => {
  const w = world();
  assert.throws(() => readKey(w.root, w.env), /no DeepSeek API key at/);
  fs.writeFileSync(keyPath(w.root, w.env), '   \n');
  assert.throws(() => readKey(w.root, w.env), /no DeepSeek API key at/);
  fs.writeFileSync(keyPath(w.root, w.env), 'sk-test-123\r\n');
  assert.equal(readKey(w.root, w.env), 'sk-test-123');
});

test('the checked-in config names the DeepSeek Anthropic endpoint, a key file, and no key', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'deepseek.json'), 'utf8'));
  assert.equal(config.baseUrl, 'https://api.deepseek.com/anthropic');
  assert.ok(config.keyFile && !path.isAbsolute(config.keyFile));
  assert.ok(!Object.keys(config).some((key) => /^(key|apiKey|token)$/i.test(key)));
});

test('as the apiKeyHelper it prints the checked-in key file, or exits 1 naming the path', () => {
  const home = makeTempDir('fleet-deepseek-home-');
  const env = { ...process.env, USERPROFILE: home, HOME: home };
  const missing = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /no DeepSeek API key at .*deepseek-api-key/);
  fs.mkdirSync(path.join(home, '.fleet-secrets'), { recursive: true });
  fs.writeFileSync(path.join(home, '.fleet-secrets', 'deepseek-api-key'), 'sk-live-456\n');
  const found = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
  assert.equal(found.status, 0);
  assert.equal(found.stdout, 'sk-live-456');
});
