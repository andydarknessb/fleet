'use strict';
// Spec fleet #93 (audit workstream 6), #153, ADR 0015: the fleet acts on GitHub
// under its own login, and Cory's shell stays Cory.
//
// The one secret location is a gh config directory outside the repo and outside
// state/ (default %USERPROFILE%\.fleet-identity\gh, FLEET_IDENTITY_DIR overrides
// it). bin/wizard-fleet-identity.sh writes it with `gh auth login --with-token
// --insecure-storage`, so the token sits in that directory's hosts.yml and
// never in Cory's keyring. Nothing here reads the token itself.
//
//   identityDir          where the secret directory is.
//   readIdentity         is it there, and which login does it name.
//   identityRequired     must a launch have it: yes once any tenant's
//                        fleetIdentity differs from its ownerLogin (#154's flip).
//                        Before the flip a missing directory keeps the keyring
//                        login, which then IS the fleet identity.
//   sessionEnv           the environment every fleet session and the Watchdog
//                        carry: gh reads GH_CONFIG_DIR, and git's credential
//                        helpers are reset to `gh auth git-credential` so an
//                        https push authenticates as the fleet too, not as the
//                        credential manager's stored login. No token and no
//                        author identity travel in it (ADR 0015: Cory stays the
//                        commit author).
//   launchPlan           the three facts above for one launch, plus the refusal
//                        (FLEET_IDENTITY_MISSING / FLEET_IDENTITY_MISMATCH).
//   checkSessionIdentity the premise check `fleet-identity-matches-session`.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CHECK_NAME = 'fleet-identity-matches-session';

class IdentityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
  }
}

function sameLogin(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function identityDir(env = process.env) {
  if (env.FLEET_IDENTITY_DIR && String(env.FLEET_IDENTITY_DIR).trim()) return String(env.FLEET_IDENTITY_DIR).trim();
  return path.join(env.USERPROFILE || env.HOME || '', '.fleet-identity', 'gh');
}

// gh's hosts.yml: `github.com:` then, indented four, `user: <login>` and (with
// --insecure-storage) `oauth_token: <token>`. Only the github.com block counts.
function githubBlock(text) {
  const lines = String(text || '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^github\.com:\s*$/.test(line));
  if (start < 0) return null;
  const block = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\S/.test(lines[index])) break;
    block.push(lines[index]);
  }
  return block;
}

function readIdentity(dir) {
  const hosts = path.join(dir, 'hosts.yml');
  let text;
  try { text = fs.readFileSync(hosts, 'utf8'); } catch (error) {
    return { dir, present: false, login: null, problem: `${hosts} is ${error.code === 'ENOENT' ? 'missing' : `unreadable (${error.code || error.message})`}` };
  }
  const block = githubBlock(text);
  const userLine = (block || []).map((line) => /^ {4}user:\s*(\S+)\s*$/.exec(line)).find(Boolean);
  if (!userLine) return { dir, present: false, login: null, problem: `${hosts} names no github.com user` };
  const hasToken = (block || []).some((line) => /^\s+oauth_token:\s*\S+/.test(line));
  if (!hasToken) return { dir, present: false, login: userLine[1], problem: `${hosts} holds no oauth_token (was it written without --insecure-storage?)` };
  return { dir, present: true, login: userLine[1], problem: null };
}

function readTenants(root) {
  const dir = path.join(root, 'tenants');
  let names = [];
  try { names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')); } catch { return []; }
  return names.sort().map((name) => {
    const raw = fs.readFileSync(path.join(dir, name), 'utf8');
    return { name: path.basename(name, '.json'), ...JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) };
  });
}

function identityRequired(tenants) {
  return (tenants || []).some((tenant) => tenant && tenant.fleetIdentity && tenant.ownerLogin && !sameLogin(tenant.fleetIdentity, tenant.ownerLogin));
}

// Windows drops an environment variable whose value is empty, so git's
// empty-helper reset cannot travel as GIT_CONFIG_VALUE_n="" (git then aborts
// every command: "missing config value"). The reset lives in a file instead:
// GIT_CONFIG_SYSTEM names <dir>/gitconfig, which includes the machine's real
// system config first (every other system setting still applies), then clears
// the helper list (the credential manager holding Cory's login) and names gh.
// The user's global config, where the commit author lives, is untouched.
function sessionEnv(dir) {
  return {
    GH_CONFIG_DIR: dir,
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_SYSTEM: path.join(dir, 'gitconfig'),
  };
}

function withoutFleetGitEnv(env) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) if (/^GIT_CONFIG_(SYSTEM|NOSYSTEM|COUNT|KEY_\d+|VALUE_\d+)$/i.test(key)) delete clean[key];
  return clean;
}

// The machine's own system gitconfig, asked of git itself with no fleet override.
function systemGitConfigPath({ env = process.env, runner = execFileSync } = {}) {
  let out = '';
  try { out = String(runner('git', ['config', '--system', '--list', '--show-origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 10000, env: withoutFleetGitEnv(env) })); } catch { return null; }
  const first = out.split(/\r?\n/).map((line) => /^file:(.+?)\t/.exec(line)).find(Boolean);
  return first ? first[1] : null;
}

function ghExecutable(env = process.env) {
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of ['gh.exe', 'gh']) {
      const candidate = path.join(dir, name);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* next */ }
    }
  }
  return null;
}

function gitConfigText({ systemPath, ghPath }) {
  const helper = ghPath ? `!'${ghPath.replace(/\\/g, '/')}' auth git-credential` : '!gh auth git-credential';
  return [
    '# Written by fleet bin/identity.js (ADR 0015). Fleet sessions and the Watchdog read this',
    '# as their system gitconfig: the real one first, then git credentials through gh only.',
    ...(systemPath ? ['[include]', `\tpath = ${systemPath.replace(/\\/g, '/')}`] : []),
    '[credential]',
    '\thelper =',
    `\thelper = ${helper}`,
    '',
  ].join('\n');
}

// Idempotent: rewritten only when its content would change.
function ensureGitConfig(dir, { env = process.env, runner } = {}) {
  const file = path.join(dir, 'gitconfig');
  const text = gitConfigText({ systemPath: systemGitConfigPath({ env, runner }), ghPath: ghExecutable(env) });
  let current = null;
  try { current = fs.readFileSync(file, 'utf8'); } catch { current = null; }
  if (current !== text) fs.writeFileSync(file, text, 'utf8');
  return file;
}

function launchPlan({ root, env = process.env } = {}) {
  const base = path.resolve(root || path.resolve(__dirname, '..'));
  const tenants = readTenants(base);
  const required = identityRequired(tenants);
  const dir = identityDir(env);
  const read = readIdentity(dir);
  const expected = [...new Set(tenants.filter((tenant) => tenant.fleetIdentity && tenant.ownerLogin && !sameLogin(tenant.fleetIdentity, tenant.ownerLogin)).map((tenant) => String(tenant.fleetIdentity)))];
  let refusal = null;
  if (required && !read.present) {
    refusal = { code: 'FLEET_IDENTITY_MISSING', message: `the fleet identity is required (tenant fleetIdentity ${expected.join(', ')} differs from ownerLogin) but ${read.problem}; run bin/wizard-fleet-identity.sh from Cory's shell (ADR 0015). There is no fallback to the keyring login` };
  } else if (required && !expected.some((login) => sameLogin(login, read.login))) {
    refusal = { code: 'FLEET_IDENTITY_MISMATCH', message: `${path.join(dir, 'hosts.yml')} names ${read.login}, but the tenant files name the fleet ${expected.join(', ')}; re-run bin/wizard-fleet-identity.sh with the right account (ADR 0015)` };
  }
  return {
    required, present: read.present, login: read.login, dir, problem: read.problem,
    refusal, env: read.present && !refusal ? (ensureGitConfig(dir, { env }), sessionEnv(dir)) : {},
  };
}

function checkSessionIdentity({ sessionLogin, tenant } = {}) {
  const fleetIdentity = tenant?.fleetIdentity || null;
  const ownerLogin = tenant?.ownerLogin || null;
  const base = { check: CHECK_NAME, tenant: tenant?.name || null, sessionLogin: sessionLogin || null, fleetIdentity, ownerLogin };
  if (!sessionLogin) return { ...base, status: 'red', detail: 'the session could not read its own GitHub login (gh api user)' };
  if (!fleetIdentity) return { ...base, status: 'red', detail: `tenant ${tenant?.name || '?'} names no fleetIdentity` };
  if (sameLogin(sessionLogin, fleetIdentity)) return { ...base, status: 'green', detail: `the session acts as ${sessionLogin}, the tenant's fleetIdentity` };
  if (ownerLogin && sameLogin(fleetIdentity, ownerLogin)) {
    return { ...base, status: 'expected-until-154', detail: `the session acts as ${sessionLogin} while tenant ${tenant?.name || '?'} still names the owner's login ${fleetIdentity} as fleetIdentity; fleet #154 flips the tenant file and this check goes green` };
  }
  return { ...base, status: 'red', detail: `the session acts as ${sessionLogin}, but tenant ${tenant?.name || '?'} names the fleet ${fleetIdentity}` };
}

function defaultGhUser() {
  return execFileSync(process.env.FLEET_GH || 'gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 20000 }).trim();
}

const FLAGS = { check: ['root', 'tenant', 'login'], plan: ['root'] };

function parseFlags(command, argv) {
  const allowed = FLAGS[command];
  if (!allowed) throw new IdentityError('USAGE', `unknown command '${command}'; commands: ${Object.keys(FLAGS).join(', ')}`);
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new IdentityError('USAGE', `unexpected argument '${token}'`);
    const name = token.slice(2);
    if (!allowed.includes(name)) throw new IdentityError('USAGE', `unknown flag --${name} for ${command}; accepted: ${allowed.map((flag) => `--${flag}`).join(', ')}`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) args[name] = 'true';
    else { args[name] = next; index += 1; }
  }
  return args;
}

function cli(argv, { ghUser = defaultGhUser, env = process.env } = {}) {
  const [command, ...rest] = argv;
  const args = parseFlags(command, rest);
  const root = path.resolve(args.root || path.resolve(__dirname, '..'));
  if (command === 'plan') {
    const plan = launchPlan({ root, env });
    return { ...plan, exitCode: plan.refusal ? 3 : 0 };
  }
  const tenantName = args.tenant || env.FLEET_TENANT;
  if (!tenantName) throw new IdentityError('USAGE', 'check needs --tenant <name> (or FLEET_TENANT)');
  const tenant = readTenants(root).find((entry) => entry.name === tenantName);
  if (!tenant) throw new IdentityError('USAGE', `unknown tenant '${tenantName}'`);
  let sessionLogin = args.login && args.login !== 'true' ? args.login : null;
  let readError = null;
  if (!sessionLogin) { try { sessionLogin = ghUser(); } catch (error) { readError = String(error.stderr || error.message || error).trim(); } }
  const result = checkSessionIdentity({ sessionLogin, tenant });
  if (readError) result.detail = `${result.detail}: ${readError.slice(0, 300)}`;
  return { ...result, exitCode: result.status === 'red' ? 1 : 0 };
}

if (require.main === module) {
  try {
    const result = cli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: error.code || 'ERROR', message: String(error.message || error) })}\n`);
    process.exitCode = error.code === 'USAGE' ? 2 : 1;
  }
}

module.exports = {
  CHECK_NAME, IdentityError, identityDir, ensureGitConfig, gitConfigText, systemGitConfigPath, readIdentity, readTenants, identityRequired, sessionEnv, launchPlan, checkSessionIdentity, sameLogin, cli,
};
