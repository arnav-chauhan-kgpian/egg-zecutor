import { env, executorKind } from '../../config/env';
import { dockerBackend } from './dockerBackend';
import { judge0Backend } from './judge0Backend';
import type { ExecutionBackend } from './types';

/**
 * The configured backend.
 *
 * Judge0 is the intended engine. The Docker backend is the fallback for hosts
 * where Judge0 physically cannot run (cgroup v2), and implements the identical
 * contract so nothing above this line changes.
 */
export const backend: ExecutionBackend = executorKind === 'judge0' ? judge0Backend : dockerBackend;

export const engineInfo = {
  kind: backend.kind,
  usesCallback: backend.usesCallback,
  endpoint: backend.kind === 'judge0' ? env.JUDGE0_API_URL ?? null : 'local-docker',
  callbackUrl: env.JUDGE0_CALLBACK_URL || null,
};

export * from './types';
export * from './languages';
export * from './artifacts';
export { toOutcome as judge0ToOutcome, isTerminal as judge0IsTerminal } from './judge0Backend';
export type { Judge0Submission } from './judge0Backend';
