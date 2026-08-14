import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  BCRYPT_SALT_ROUNDS: z.coerce.number().int().min(4).max(15).default(10),
  CORS_ORIGIN: z.string().default('*'),
  /// Express body limit. Must exceed ADDITIONAL_FILES_MAX_BASE64_BYTES or a
  /// dataset upload is rejected by the parser before the route ever sees it.
  REQUEST_BODY_LIMIT: z.string().default('64mb'),

  JUDGE0_API_URL: z
    .string()
    .url('JUDGE0_API_URL must be a valid URL')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  // RapidAPI-hosted instances need a key; self-hosted ones usually don't.
  JUDGE0_API_KEY: z.string().optional(),
  JUDGE0_API_HOST: z.string().optional(),
  // Self-hosted Judge0 with JUDGE0_AUTHN_TOKEN set expects X-Auth-Token.
  JUDGE0_AUTH_TOKEN: z.string().optional(),

  // Default per-run limits. Raised well above competitive-programming values:
  // research workloads train models and crunch datasets, and the old 5s/128MB
  // killed anything real. Individual requests may override both.
  JUDGE0_CPU_TIME_LIMIT: z.coerce.number().positive().max(900).default(120), // seconds
  JUDGE0_MEMORY_LIMIT: z.coerce.number().int().positive().max(4_096_000).default(1_024_000), // KB
  // Judge0 enforces a wall-clock limit independently of CPU time; an I/O-bound
  // job needs headroom above its CPU allowance or it dies early.
  JUDGE0_WALL_TIME_MARGIN: z.coerce.number().positive().default(60), // seconds
  JUDGE0_WALL_TIME_MAX: z.coerce.number().positive().default(1_800), // seconds

  // Callback URL handed to Judge0 as `callback_url`. Must be reachable FROM
  // the judge0-server container, so inside Compose it is the service name —
  // http://api:4000/api/v1/executions/callback. Empty disables the webhook and
  // falls back to polling.
  JUDGE0_CALLBACK_URL: z.string().optional().or(z.literal('').transform(() => undefined)),
  // Shared secret checked on the callback route. Strongly recommended: the
  // route mutates execution records based on an unauthenticated request.
  JUDGE0_CALLBACK_SECRET: z.string().optional(),

  JUDGE0_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  // Reconciler: sweeps PROCESSING rows whose callback never arrived.
  JUDGE0_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  // How long a run may stay PROCESSING before it is marked FAILED.
  JUDGE0_MAX_WAIT_MS: z.coerce.number().int().positive().default(1_900_000),

  // Ceilings a single request may ask for, independent of the defaults above.
  JUDGE0_CPU_TIME_LIMIT_MAX: z.coerce.number().positive().default(900), // seconds
  JUDGE0_MEMORY_LIMIT_MAX: z.coerce.number().int().positive().default(4_096_000), // KB
  /// Largest base64 `additional_files` payload accepted (characters).
  ADDITIONAL_FILES_MAX_BASE64_BYTES: z.coerce.number().int().positive().default(32 * 1024 * 1024),

  // --- artifacts ------------------------------------------------------------
  ARTIFACT_MAX_TOTAL_BYTES: z.coerce.number().int().positive().default(8 * 1024 * 1024),
  ARTIFACT_MAX_COUNT: z.coerce.number().int().positive().max(200).default(20),

  // --- abuse controls -------------------------------------------------------
  // Sized for a shared demo: one person hammering Run must not starve the box.
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  /// Runs a single user may queue per window.
  RATE_LIMIT_MAX_RUNS: z.coerce.number().int().positive().default(20),
  /// Auth attempts per window per IP.
  RATE_LIMIT_MAX_AUTH: z.coerce.number().int().positive().default(20),
  /// Runs one user may have in flight at once.
  MAX_CONCURRENT_RUNS_PER_USER: z.coerce.number().int().positive().default(3),
  /// Runs anyone may have in flight at once — the real backstop on the host.
  MAX_CONCURRENT_RUNS_TOTAL: z.coerce.number().int().positive().default(12),

  // --- execution backend ----------------------------------------------------
  // judge0 — the intended engine; requires JUDGE0_API_URL and a cgroup v1 host
  // docker — run locally in throwaway containers; works on cgroup v2
  // auto   — judge0 when JUDGE0_API_URL is set, otherwise docker
  EXECUTOR: z.enum(['auto', 'docker', 'judge0']).default('auto'),
  EXECUTOR_IMAGE_PYTHON: z.string().default('python:3.11-alpine'),
  EXECUTOR_IMAGE_NODE: z.string().default('node:20-alpine'),
  EXECUTOR_IMAGE_CPP: z.string().default('gcc:13'),
  EXECUTOR_CPUS: z.coerce.number().positive().max(8).default(1),
  EXECUTOR_PIDS_LIMIT: z.coerce.number().int().positive().max(4096).default(128),
  EXECUTOR_TMPFS_MB: z.coerce.number().int().positive().max(1024).default(64),
  // The in-container time limit is wall-clock, so oversubscribing the CPU makes
  // correct solutions time out under load. Keep concurrency * CPUS at or below
  // the cores you are willing to give the judge.
  EXECUTOR_CONCURRENCY: z.coerce.number().int().positive().max(32).default(2),
  // Compilation gets its own budget: g++ on <bits/stdc++.h> needs far more
  // memory than a submission is allowed at run time.
  EXECUTOR_COMPILE_MEMORY_MB: z.coerce.number().int().positive().max(8192).default(1024),
  EXECUTOR_COMPILE_CPUS: z.coerce.number().positive().max(8).default(2),
  EXECUTOR_COMPILE_TIMEOUT_S: z.coerce.number().int().positive().max(300).default(30),
  // Research runs are chatty; 256KB truncated real logs. Still bounded so a
  // runaway print loop can't exhaust the API's heap.
  EXECUTOR_MAX_OUTPUT_BYTES: z.coerce.number().int().positive().default(4 * 1024 * 1024),
  // Allowance for image start-up before the outer watchdog fires; the
  // in-container `timeout` is the real time limit.
  EXECUTOR_STARTUP_GRACE_MS: z.coerce.number().int().positive().default(15_000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  // Fail fast: a misconfigured secret is worse than a server that refuses to boot.
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

export const env = parsed.data;

/** Which backend runs the code. */
export const executorKind: 'docker' | 'judge0' =
  env.EXECUTOR === 'auto' ? (env.JUDGE0_API_URL ? 'judge0' : 'docker') : env.EXECUTOR;

if (executorKind === 'judge0' && !env.JUDGE0_API_URL) {
  console.error('Invalid environment configuration:\n  - EXECUTOR=judge0 requires JUDGE0_API_URL');
  process.exit(1);
}

export const corsOrigins =
  env.CORS_ORIGIN === '*'
    ? '*'
    : env.CORS_ORIGIN.split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
