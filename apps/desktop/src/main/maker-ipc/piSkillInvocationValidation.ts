import fs from 'node:fs';
import path from 'node:path';

import type {
  AgentSkillCommand,
  PiRuntimeCapabilityManifest,
} from '@cindy/maker-core';
import {
  piCanonicalPathIsWithin,
  piCanonicalPathsEqual,
} from '@cindy/maker-core';

import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';

function canonicalLocalPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) {
    return null;
  }
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    // Runtime provenance can describe a path that disappeared after capture.
    // Keep the fallback case-sensitive so uncertainty produces false negatives,
    // never a case-folded match on a case-sensitive Windows directory.
    return resolved;
  }
}

function existingPhysicalPath(value: unknown): string | null {
  if (
    typeof value !== 'string'
    || !value
    || value.includes('\0')
    || !path.isAbsolute(value)
  ) return null;
  try {
    return fs.realpathSync.native(path.resolve(value));
  } catch {
    return null;
  }
}

function runtimeProjectSkillMatchesSource(
  sourcePath: string,
  skill: NonNullable<NonNullable<
    PiRuntimeCapabilityManifest['projectResources']
  >['loadedSkills']>[number],
): boolean {
  const selected = existingPhysicalPath(sourcePath);
  const loadedSource = existingPhysicalPath(skill.sourcePath);
  const repoRoot = existingPhysicalPath(skill.canonicalRepoRoot);
  const identity = skill.pathComparisonIdentity;
  if (!selected || !loadedSource || !repoRoot || !identity) return false;
  return piCanonicalPathIsWithin(identity, repoRoot, selected)
    && piCanonicalPathIsWithin(identity, repoRoot, loadedSource)
    && piCanonicalPathsEqual(identity, selected, loadedSource);
}

function runtimeUserSkillMatchesSource(
  sourcePath: string,
  command: PiRuntimeCapabilityManifest['commands'][number],
): boolean {
  const selected = canonicalLocalPath(sourcePath);
  const baseDir = canonicalLocalPath(command.sourceInfo.baseDir);
  if (
    !selected
    || !baseDir
    || command.sourceInfo.scope !== 'user'
    || command.sourceInfo.source !== 'auto'
  ) return false;

  const selectedName = path.basename(selected);
  const derivedFromBase = canonicalLocalPath(path.join(baseDir, 'skills', selectedName));
  if (derivedFromBase !== selected) return false;

  if (command.sourceInfo.path === undefined) return true;
  const runtimePath = canonicalLocalPath(command.sourceInfo.path);
  if (!runtimePath) return false;
  const runtimeSkillDir = path.basename(runtimePath) === 'SKILL.md'
    ? canonicalLocalPath(path.dirname(runtimePath))
    : runtimePath;
  return runtimeSkillDir === selected;
}

/**
 * Revalidate renderer-provided Pi Skill routing against this exact runtime.
 * Discovery and persisted queue data are never sufficient authority.
 */
export function isCurrentPiSkillInvocation(
  item: Pick<AgentInputQueuedMessage, 'agentSkillInvocation' | 'createOpts'>,
  manifest: PiRuntimeCapabilityManifest | undefined,
  currentSkills: readonly AgentSkillCommand[],
): boolean {
  const invocation = item.agentSkillInvocation;
  if (!invocation) return true;
  if (item.createOpts.agentKind !== 'pi' || manifest?.status !== 'loaded') return false;
  if (!invocation.name || !/^skill:[^\s/]+$/i.test(invocation.runtimeCommandName)) {
    return false;
  }
  if (!invocation.sourcePath || (invocation.scope !== 'repo' && invocation.scope !== 'user')) {
    return false;
  }
  const invocationSourcePath = invocation.sourcePath;
  const currentMatches = currentSkills.filter((skill) => (
    skill.name === invocation.name
    && skill.scope === invocation.scope
    && skill.path === invocation.sourcePath
    && skill.runtimeCommandName === invocation.runtimeCommandName
    && (invocation.scope !== 'repo' || skill.runtimeStatus === 'loaded')
  ));
  if (currentMatches.length !== 1) return false;

  if (invocation.scope === 'repo') {
    const loadedMatches = manifest.projectResources?.loadedSkills?.filter((skill) => (
      skill.commandName === invocation.runtimeCommandName
      && runtimeProjectSkillMatchesSource(invocationSourcePath, skill)
    )) ?? [];
    return loadedMatches.length === 1;
  }
  const runtimeMatches = manifest.commands.filter((command) => (
    command.name === invocation.runtimeCommandName
    && command.source === 'skill'
    && runtimeUserSkillMatchesSource(invocationSourcePath, command)
  ));
  return runtimeMatches.length === 1;
}

export function stalePiSkillInvocationError(): Error & { code: string } {
  return Object.assign(
    new Error('Skill is not loaded from the selected source by the current Pi runtime. Restart or reselect it.'),
    { code: 'PI_SKILL_INVOCATION_STALE' },
  );
}

export function isStalePiSkillInvocationError(error: unknown): boolean {
  return !!error && typeof error === 'object'
    && (error as { code?: unknown }).code === 'PI_SKILL_INVOCATION_STALE';
}

/**
 * Run the last runtime proof and bind it to the exact Session that will receive
 * the message. Callers must not cross another async boundary before delivery.
 */
export async function assertCurrentPiSkillInvocationSession<T>(
  expectedSession: T,
  getCurrentSession: () => T | undefined,
  validate?: () => boolean | void | Promise<boolean | void>,
): Promise<void> {
  try {
    if (validate && await validate() === false) throw stalePiSkillInvocationError();
    if (getCurrentSession() !== expectedSession) throw stalePiSkillInvocationError();
  } catch (error) {
    if (isStalePiSkillInvocationError(error)) throw error;
    throw stalePiSkillInvocationError();
  }
}
