'use strict';
// Spec fleet #93 (audit workstream 6), #153: the fleet acts on GitHub as its own
// login (ADR 0015). bin/identity.js reads the fleet's gh config directory (the
// one secret location), decides whether a launch must have it, builds the
// session environment that routes gh AND git pushes through it, and answers the
// premise check `fleet-identity-matches-session`.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const identity = require('../bin/identity');
const { SESSION_CHECKS } = require('../bin/premises');

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function identityDir({ login = 'endzone-fleet', token = 'ghp_fixture' } = {}) {
  const dir = tmp('fleet-identity-');
  const lines = ['github.com:', '    users:'];
  if (login) lines.push(`        ${login}:`, ...(token ? [`            oauth_token: ${token}`] : []));
  lines.push('    git_protocol: https');
  if (token) lines.push(`    oauth_token: ${token}`);
  if (login) lines.push(`    user: ${login}`);
  fs.writeFileSync(path.join(dir, 'hosts.yml'), `${lines.join('\n')}\n`, 'utf8');
  return dir;
}

function fleetRoot(tenants) {
  const root = tmp('fleet-identity-root-');
  fs.mkdirSync(path.join(root, 'tenants'));
  for (const [name, config] of Object.entries(tenants)) fs.writeFileSync(path.join(root, 'tenants', `${name}.json`), JSON.stringify({ name, ...config }), 'utf8');
  return root;
}

test('identityDir: FLEET_IDENTITY_DIR overrides the default under the user profile', () => {
  assert.equal(identity.identityDir({ FLEET_IDENTITY_DIR: 'X:\\secret\\gh', USERPROFILE: 'C:\\Users\\a' }), 'X:\\secret\\gh');
  assert.equal(identity.identityDir({ USERPROFILE: 'C:\\Users\\a' }), path.join('C:\\Users\\a', '.fleet-identity', 'gh'));
});

test('readIdentity: a gh config dir with a user and a token is present and names the login', () => {
  const dir = identityDir({ login: 'endzone-fleet' });
  assert.deepEqual(identity.readIdentity(dir), { dir, present: true, login: 'endzone-fleet', problem: null });
});

test('readIdentity: absent dir, missing hosts.yml, no user, no token are each not present with the problem named', () => {
  const absent = path.join(os.tmpdir(), `fleet-identity-absent-${process.pid}-${Date.now()}`);
  assert.equal(identity.readIdentity(absent).present, false);
  assert.match(identity.readIdentity(absent).problem, /hosts\.yml/);
  const noUser = identityDir({ login: null });
  assert.equal(identity.readIdentity(noUser).present, false);
  assert.match(identity.readIdentity(noUser).problem, /no github\.com user/);
  const noToken = identityDir({ token: null });
  assert.equal(identity.readIdentity(noToken).present, false);
  assert.match(identity.readIdentity(noToken).problem, /no oauth_token/);
});

test('identityRequired: only a tenant whose fleetIdentity differs from its ownerLogin needs the fleet login', () => {
  assert.equal(identity.identityRequired([{ fleetIdentity: 'andydarknessb', ownerLogin: 'andydarknessb' }]), false);
  assert.equal(identity.identityRequired([{ name: 'bare' }]), false);
  assert.equal(identity.identityRequired([{ fleetIdentity: 'Andydarknessb', ownerLogin: 'andydarknessb' }]), false, 'logins compare case-insensitively');
  assert.equal(identity.identityRequired([{ fleetIdentity: 'andydarknessb', ownerLogin: 'andydarknessb' }, { fleetIdentity: 'endzone-fleet', ownerLogin: 'andydarknessb' }]), true);
});

test('sessionEnv: gh reads the fleet config dir, git reads the fleet system gitconfig, and no value is empty', () => {
  const env = identity.sessionEnv('X:\\secret\\gh');
  assert.equal(env.GH_CONFIG_DIR, 'X:\\secret\\gh');
  assert.equal(env.GIT_CONFIG_SYSTEM, path.join('X:\\secret\\gh', 'gitconfig'));
  assert.equal(env.GH_PROMPT_DISABLED, '1');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  // Windows deletes an env var set to "", and git then aborts on a GIT_CONFIG_COUNT gap.
  for (const [key, value] of Object.entries(env)) assert.notEqual(String(value), '', `${key} must not be empty`);
  for (const key of Object.keys(env)) assert.doesNotMatch(String(env[key]), /ghp_|gho_/, 'no token ever travels in the environment block');
  assert.equal(Object.keys(env).some((key) => /author|committer|GIT_CONFIG_GLOBAL/i.test(key)), false, 'ADR 0015: the fleet never touches the commit author or the global config');
});

test('gitConfigText: includes the real system config first, then resets the helper list to gh alone', () => {
  const text = identity.gitConfigText({ systemPath: 'C:\\Program Files\\Git\\etc\\gitconfig', ghPath: 'C:\\Program Files\\GitHub CLI\\gh.exe' });
  const lines = text.split('\n').map((line) => line.trim());
  assert.ok(lines.indexOf('path = C:/Program Files/Git/etc/gitconfig') < lines.indexOf('helper ='), 'the include precedes the reset');
  assert.ok(lines.indexOf('helper =') < lines.indexOf("helper = !'C:/Program Files/GitHub CLI/gh.exe' auth git-credential"));
  assert.doesNotMatch(identity.gitConfigText({ systemPath: null, ghPath: null }), /\[include\]/);
  assert.match(identity.gitConfigText({ systemPath: null, ghPath: null }), /helper = !gh auth git-credential/);
});

test('the session env routes a real `git credential fill` to the fleet token, bypassing the credential manager', () => {
  const dir = identityDir({ login: 'endzone-fleet', token: 'ghp_route_probe' });
  identity.ensureGitConfig(dir);
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', windowsHide: true,
    env: { ...process.env, ...identity.sessionEnv(dir) },
  });
  assert.match(out, /username=endzone-fleet/);
  assert.match(out, /password=ghp_route_probe/);
});

test('the fleet system gitconfig keeps every other system setting', () => {
  const systemPath = identity.systemGitConfigPath();
  if (!systemPath) return; // a machine with no system gitconfig has nothing to keep
  const clean = { ...process.env };
  delete clean.GIT_CONFIG_SYSTEM;
  const read = (env) => execFileSync('git', ['config', '--includes', '--system', '--list'], { encoding: 'utf8', windowsHide: true, env }).split(/\r?\n/).filter((line) => line && !/^credential\.helper=/i.test(line) && !/^include\.path=/i.test(line));
  const sysDir = identityDir();
  identity.ensureGitConfig(sysDir);
  const before = read(clean);
  const after = read({ ...clean, ...identity.sessionEnv(sysDir) });
  assert.deepEqual(after.filter((line) => before.includes(line)).length, before.length, 'every system setting other than the helper must still apply');
});

test('ADR 0015 authorship: the session environment leaves the commit author (global config) unchanged', () => {
  const repo = tmp('fleet-identity-author-');
  const globalFile = path.join(tmp('fleet-identity-global-'), '.gitconfig');
  fs.writeFileSync(globalFile, '[user]\n\tname = Cory Anderson\n\temail = cory@example.invalid\n', 'utf8');
  const clean = { ...process.env, GIT_CONFIG_GLOBAL: globalFile };
  for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete clean[key];
  const dir = identityDir();
  identity.ensureGitConfig(dir);
  const run = (args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, env: { ...clean, ...identity.sessionEnv(dir) } }).trim();
  run(['init', '-q']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a', 'utf8');
  run(['add', 'a.txt']);
  run(['commit', '-q', '-m', 'fixture']);
  assert.equal(run(['log', '-1', '--format=%an <%ae>']), 'Cory Anderson <cory@example.invalid>');
});

test('ensureGitConfig is idempotent and launchPlan writes it when the identity is present', () => {
  const dir = identityDir();
  const file = identity.ensureGitConfig(dir);
  const mtime = fs.statSync(file).mtimeMs;
  identity.ensureGitConfig(dir);
  assert.equal(fs.statSync(file).mtimeMs, mtime, 'unchanged content is not rewritten');
  const fresh = identityDir();
  const root = fleetRoot({ endzone: { fleetIdentity: 'andydarknessb', ownerLogin: 'andydarknessb' } });
  identity.launchPlan({ root, env: { ...process.env, FLEET_IDENTITY_DIR: fresh } });
  assert.ok(fs.existsSync(path.join(fresh, 'gitconfig')));
});

test('launchPlan: not required and absent keeps the keyring (pre-flip), no refusal', () => {
  const root = fleetRoot({ endzone: { fleetIdentity: 'andydarknessb', ownerLogin: 'andydarknessb' } });
  const plan = identity.launchPlan({ root, env: { FLEET_IDENTITY_DIR: path.join(root, 'nowhere') } });
  assert.equal(plan.required, false);
  assert.equal(plan.present, false);
  assert.equal(plan.refusal, null);
  assert.deepEqual(plan.env, {});
});

test('launchPlan: present injects the environment whether or not it is yet required', () => {
  const dir = identityDir();
  const root = fleetRoot({ endzone: { fleetIdentity: 'andydarknessb', ownerLogin: 'andydarknessb' } });
  const plan = identity.launchPlan({ root, env: { FLEET_IDENTITY_DIR: dir } });
  assert.equal(plan.present, true);
  assert.equal(plan.login, 'endzone-fleet');
  assert.equal(plan.env.GH_CONFIG_DIR, dir);
  assert.equal(plan.refusal, null);
});

test('launchPlan: required and absent refuses with FLEET_IDENTITY_MISSING, never a keyring fallback', () => {
  const root = fleetRoot({ endzone: { fleetIdentity: 'endzone-fleet', ownerLogin: 'andydarknessb' } });
  const plan = identity.launchPlan({ root, env: { FLEET_IDENTITY_DIR: path.join(root, 'nowhere') } });
  assert.equal(plan.required, true);
  assert.equal(plan.refusal.code, 'FLEET_IDENTITY_MISSING');
  assert.match(plan.refusal.message, /nowhere/);
  assert.deepEqual(plan.env, {});
});

test('launchPlan: required and present as the wrong login refuses with FLEET_IDENTITY_MISMATCH', () => {
  const root = fleetRoot({ endzone: { fleetIdentity: 'endzone-fleet', ownerLogin: 'andydarknessb' } });
  const plan = identity.launchPlan({ root, env: { FLEET_IDENTITY_DIR: identityDir({ login: 'someone-else' }) } });
  assert.equal(plan.refusal.code, 'FLEET_IDENTITY_MISMATCH');
  assert.match(plan.refusal.message, /someone-else/);
  assert.match(plan.refusal.message, /endzone-fleet/);
});

test('checkSessionIdentity: session login equal to fleetIdentity is green', () => {
  const result = identity.checkSessionIdentity({ sessionLogin: 'endzone-fleet', tenant: { name: 'endzone', fleetIdentity: 'endzone-fleet', ownerLogin: 'andydarknessb' } });
  assert.equal(result.check, 'fleet-identity-matches-session');
  assert.equal(result.status, 'green');
});

test('checkSessionIdentity: a mismatch before the tenant flip (#154) is expected, not red', () => {
  const result = identity.checkSessionIdentity({ sessionLogin: 'endzone-fleet', tenant: { name: 'endzone', fleetIdentity: 'andydarknessb', ownerLogin: 'andydarknessb' } });
  assert.equal(result.status, 'expected-until-154');
  assert.match(result.detail, /#154/);
});

test('checkSessionIdentity: a mismatch after the flip is red, and so is an unreadable login', () => {
  const tenant = { name: 'endzone', fleetIdentity: 'endzone-fleet', ownerLogin: 'andydarknessb' };
  assert.equal(identity.checkSessionIdentity({ sessionLogin: 'andydarknessb', tenant }).status, 'red');
  assert.equal(identity.checkSessionIdentity({ sessionLogin: '', tenant }).status, 'red');
});

test('the premise-check rig registers fleet-identity-matches-session', () => {
  assert.equal(typeof SESSION_CHECKS['fleet-identity-matches-session'], 'function');
  const result = SESSION_CHECKS['fleet-identity-matches-session']({ sessionLogin: 'x', tenant: { fleetIdentity: 'x', ownerLogin: 'y' } });
  assert.equal(result.status, 'green');
});

test('cli check: reads the session login through gh and exits nonzero only on red', () => {
  const root = fleetRoot({ endzone: { fleetIdentity: 'endzone-fleet', ownerLogin: 'andydarknessb' } });
  const green = identity.cli(['check', '--root', root, '--tenant', 'endzone'], { ghUser: () => 'endzone-fleet' });
  assert.equal(green.status, 'green');
  assert.equal(green.exitCode, 0);
  const red = identity.cli(['check', '--root', root, '--tenant', 'endzone'], { ghUser: () => 'andydarknessb' });
  assert.equal(red.status, 'red');
  assert.equal(red.exitCode, 1);
  const failing = identity.cli(['check', '--root', root, '--tenant', 'endzone'], { ghUser: () => { throw new Error('gh: not logged in'); } });
  assert.equal(failing.status, 'red');
  assert.match(failing.detail, /not logged in/);
});
