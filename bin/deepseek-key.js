'use strict';
// Owner ruling 2026-10-26: a deepseek IC calls DeepSeek's Anthropic-format API. This is
// that session's apiKeyHelper (launch.ps1 writes it into the IC's settings): it prints
// the DeepSeek API key from config/deepseek.json's keyFile under the user profile, which
// sits outside the repo and outside state/ like the fleet identity (ADR 0015), so no key
// lands in a settings file. A missing or empty key exits 1 with the path, never a blank
// key the API would answer with an opaque 401.

const fs = require('node:fs');
const path = require('node:path');

function keyPath(root = path.join(__dirname, '..'), env = process.env) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config', 'deepseek.json'), 'utf8'));
  if (!config.keyFile) throw new Error('config/deepseek.json names no keyFile');
  return path.join(env.USERPROFILE || env.HOME || '', config.keyFile);
}

function readKey(root, env) {
  const file = keyPath(root, env);
  const key = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
  if (!key) throw new Error(`no DeepSeek API key at ${file}`);
  return key;
}

if (require.main === module) {
  try {
    process.stdout.write(readKey());
  } catch (error) {
    process.stderr.write(`deepseek-key: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = { keyPath, readKey };
