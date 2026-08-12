import type {
  AgentSkillCommand,
  PiRuntimeCapabilityManifest,
} from '@cindy/maker-core';

import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';

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
      && skill.sourcePath === invocation.sourcePath
    )) ?? [];
    return loadedMatches.length === 1;
  }
  const runtimeMatches = manifest.commands.filter((command) => (
    command.name === invocation.runtimeCommandName
    && command.source === 'skill'
    && command.sourceInfo.scope === 'user'
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
