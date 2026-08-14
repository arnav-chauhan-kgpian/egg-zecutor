#!/usr/bin/env node
/**
 * One-command local development.
 *
 *   npm run dev
 *
 * Takes a fresh clone to a running API + playground with no other steps. Every
 * stage is idempotent, so this is also the right command on the second run and
 * the hundredth — it skips whatever is already done.
 *
 *   1. check Docker is up          (Postgres and code execution both need it)
 *   2. generate .env* if missing   (delegates to setup.sh / setup.ps1)
 *   3. start Postgres, wait healthy
 *   4. prisma generate + migrate deploy + seed
 *   5. install web dependencies if missing
 *   6. run the API and the playground together until Ctrl+C
 *
 * Deliberately dependency-free: adding `concurrently` to run two processes
 * would mean an npm install before the script that performs the npm install.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';

const colour = process.stdout.isTTY && !process.env.NO_COLOR;
const ESC = String.fromCharCode(27); // ANSI escape, kept out of the source as a literal
const paint = (code, text) => (colour ? `${ESC}[${code}m${text}${ESC}[0m` : text);
const step = (msg) => console.log(`${paint('36;1', '▸')} ${paint('1', msg)}`);
const info = (msg) => console.log(`  ${paint('90', msg)}`);
const warn = (msg) => console.log(`${paint('33;1', '!')} ${msg}`);

function die(msg, hint) {
  console.error(`\n${paint('31;1', '✗')} ${msg}`);
  if (hint) console.error(`\n${hint}\n`);
  process.exit(1);
}

/**
 * On Windows `npm` and `npx` are .cmd shims, which Node refuses to spawn
 * without a shell. Passing an args ARRAY alongside `shell: true` is deprecated
 * (DEP0190) because the arguments are concatenated rather than escaped, so the
 * command is pre-joined into a single string instead. Every argument used here
 * is a literal flag or a relative path with no spaces.
 */
const needsShell = (command) => isWindows && (command === 'npm' || command === 'npx');
const asShellCommand = (command, args) => [command, ...args].join(' ');

/** Runs a command to completion. Returns its exit code and captured output. */
function run(command, args, options = {}) {
  const shell = needsShell(command);
  const result = spawnSync(shell ? asShellCommand(command, args) : command, shell ? [] : args, {
    cwd: root,
    stdio: options.quiet ? 'pipe' : 'inherit',
    shell,
    encoding: 'utf8',
    ...options,
  });
  return { code: result.status ?? 1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

// --- 1. Docker ---------------------------------------------------------------

step('Checking Docker');
if (run('docker', ['info'], { quiet: true }).code !== 0) {
  die(
    'Docker is not running.',
    'This project needs Docker for two things: the PostgreSQL container, and\n' +
      'the sandbox that executes submitted code.\n\n' +
      '  • Windows / macOS — start Docker Desktop and re-run `npm run dev`\n' +
      '  • Linux           — `sudo systemctl start docker`',
  );
}
info('Docker is running');

// --- 2. Environment ----------------------------------------------------------

// .env is what plain `docker compose` and the host-side Prisma CLI read;
// .env.docker is what the containerised stack reads. setup generates both,
// plus deploy/judge0.conf, with freshly random secrets.
if (existsSync(path.join(root, '.env')) && existsSync(path.join(root, '.env.docker'))) {
  step('Environment already configured');
  info('.env and .env.docker present — leaving them alone');
} else {
  step('Generating .env files with fresh secrets (first run only)');

  // SKIP_PULL keeps first start fast; language images are pulled on first use.
  const env = { ...process.env, SKIP_PULL: '1' };
  const setup = isWindows
    ? run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'setup.ps1'], { env })
    : run('bash', ['setup.sh'], { env });

  if (setup.code !== 0) die('setup failed — see the output above.');
}

// --- 3. Postgres -------------------------------------------------------------

step('Starting PostgreSQL');
// --wait blocks until the healthcheck passes, so migrations below cannot race
// a database that is still starting up.
if (run('docker', ['compose', 'up', '-d', '--wait', 'postgres']).code !== 0) {
  die(
    'Could not start the postgres container.',
    'If the port is already taken, change POSTGRES_PORT in .env and .env.docker.',
  );
}
info('PostgreSQL is healthy');

// --- 4. Database schema ------------------------------------------------------

step('Preparing the database');

const generate = run('npx', ['prisma', 'generate'], { quiet: true });
if (generate.code !== 0) {
  console.error(generate.out);
  die(
    '`prisma generate` failed.',
    'On Windows this is usually a file lock: another `npm run dev` (or a stray\n' +
      'tsx/next process from one) still holds the Prisma query engine. Close it,\n' +
      'or kill leftover node processes, then try again.',
  );
}
info('Prisma client generated');

// migrate deploy (not dev): applies the checked-in migrations without ever
// prompting or offering to reset, which is the right behaviour for a script
// somebody is running for the first time.
const migrate = run('npx', ['prisma', 'migrate', 'deploy'], { quiet: true });
if (migrate.code !== 0) {
  console.error(migrate.out);
  die('`prisma migrate deploy` failed.');
}
info('Migrations applied');

// The seed upserts two accounts, so re-running it is harmless.
const seed = run('npx', ['prisma', 'db', 'seed'], { quiet: true });
if (seed.code === 0) info('Seed accounts ready');
else warn('Seeding failed — the app will still run, but the demo logins may be missing.');

// --- 5. Web dependencies -----------------------------------------------------

if (existsSync(path.join(root, 'web', 'node_modules'))) {
  step('Playground dependencies already installed');
} else {
  step('Installing playground dependencies (first run only — this takes a minute)');
  if (run('npm', ['install'], { cwd: path.join(root, 'web') }).code !== 0) {
    die('Installing the web dependencies failed.');
  }
}

// --- 6. Run both -------------------------------------------------------------

console.log(`
${paint('32;1', '✓ Ready')}

  ${paint('1', 'Playground')}  ${paint('4', 'http://localhost:3000/playground')}
  ${paint('1', 'API')}         ${paint('4', 'http://localhost:4000')}

  Sign in with either seeded account:
    coder@example.com / Password123!
    admin@example.com / Admin123!

  Press ${paint('1', 'Ctrl+C')} to stop both.
`);

const children = [];

function start(label, colourCode, command, args, cwd) {
  const shell = needsShell(command);
  const child = spawn(shell ? asShellCommand(command, args) : command, shell ? [] : args, {
    cwd,
    shell,
    env: process.env,
  });
  const tag = paint(colourCode, `[${label}]`);

  // Line-buffer so a prefix is never stamped mid-line.
  const pipe = (stream) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) console.log(`${tag} ${line}`);
    });
  };

  pipe(child.stdout);
  pipe(child.stderr);

  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      warn(`${label} exited (${signal ?? code}) — shutting the other process down too.`);
      shutdown();
    }
  });

  children.push(child);
  return child;
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGINT');
  }
  // Don't leave the terminal hanging if something ignores SIGINT.
  setTimeout(() => process.exit(0), 4000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start('api', '36', 'npx', ['tsx', 'watch', 'src/server.ts'], root);
start('web', '35', 'npm', ['run', 'dev'], path.join(root, 'web'));
