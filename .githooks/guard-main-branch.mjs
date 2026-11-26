#!/usr/bin/env node
/**
 * MAGA Repository Guardrail Thin Wrapper.
 * Delegates directly to `<repo>/studio/plugin/maga-git-workflow/hooks/git-guard.mjs`
 * with MAGA's strict worktree-only defaults (`protect-main` + primary worktree lock + `--tags` block).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PROTECTED_BRANCHES,
  evaluateHookPayload as baseEvaluateHookPayload,
  evaluateHookPayloadDetailed as baseEvaluateHookPayloadDetailed,
  extractGitInvocations,
  isInsideDir,
  recordConversationWorktree,
  resolveGitContext,
  runGuardCli,
  splitShellSegments,
  tokenizeSegment,
} from '../studio/plugin/maga-git-workflow/hooks/git-guard.mjs';

export const MAGA_FORCED_POLICY = {
  mode: 'worktree-only',
  blockForcePushProtected: true,
  blockPushTags: true,
  localOnlyPaths: ['AGENTS.md', 'docs/DEVELOPMENT_HISTORY.md', '.agents/skills'],
};

const WRAPPER_OPTS = {
  isLocalRepoHook: true,
  forcedPolicy: MAGA_FORCED_POLICY,
};

export {
  PROTECTED_BRANCHES,
  extractGitInvocations,
  isInsideDir,
  recordConversationWorktree,
  resolveGitContext,
  splitShellSegments,
  tokenizeSegment,
};

export function evaluateHookPayload(payload) {
  return baseEvaluateHookPayload(payload, WRAPPER_OPTS);
}

export function evaluateHookPayloadDetailed(payload) {
  return baseEvaluateHookPayloadDetailed(payload, WRAPPER_OPTS);
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    if (import.meta.url === pathToFileURL(process.argv[1]).href) return true;
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1]));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  runGuardCli(WRAPPER_OPTS);
}
