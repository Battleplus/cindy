import { describe, expect, it } from 'vitest';
import type {
  AgentSkillCommand,
  PiRuntimeCapabilityManifest,
} from '@cindy/maker-core';

import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';
import {
  assertCurrentPiSkillInvocationSession,
  isCurrentPiSkillInvocation,
  isStalePiSkillInvocationError,
} from '../piSkillInvocationValidation.js';

const sourcePath = '/repo/.pi/skills/demo';

function item(
  patch: Partial<NonNullable<AgentInputQueuedMessage['agentSkillInvocation']>> = {},
): Pick<AgentInputQueuedMessage, 'agentSkillInvocation' | 'createOpts'> {
  return {
    agentSkillInvocation: {
      name: 'demo',
      runtimeCommandName: 'skill:demo',
      scope: 'repo',
      sourcePath,
      ...patch,
    },
    createOpts: {
      agentKind: 'pi',
      workingDir: '/repo',
      model: 'model',
    },
  };
}

function manifest(
  patch: Partial<PiRuntimeCapabilityManifest> = {},
): PiRuntimeCapabilityManifest {
  return {
    capturedAt: '2026-08-12T00:00:00.000Z',
    generation: 1,
    status: 'loaded',
    source: 'pi:get_commands',
    commands: [{
      name: 'skill:demo',
      source: 'skill',
      sourceInfo: {
        scope: 'temporary',
        source: 'local',
        baseDir: '/snapshot/demo',
        path: '/snapshot/demo/SKILL.md',
      },
    }],
    projectResources: {
      status: 'approved',
      reason: 'runtime-skills-confirmed',
      approvalRevision: 'revision',
      requestedSkillCount: 1,
      loadedSkillCount: 1,
      loadedSkills: [{
        sourcePath,
        runtimePath: '/snapshot/demo',
        commandName: 'skill:demo',
      }],
    },
    ...patch,
  };
}

function skills(patch: Partial<AgentSkillCommand> = {}): AgentSkillCommand[] {
  return [{
    kind: 'agent-skill',
    name: 'demo',
    source: 'skill',
    scope: 'repo',
    path: sourcePath,
    runtimeStatus: 'loaded',
    runtimeCommandName: 'skill:demo',
    ...patch,
  }];
}

describe('Pi Skill invocation validation', () => {
  it('accepts one exact current project Skill provenance match', () => {
    expect(isCurrentPiSkillInvocation(item(), manifest(), skills())).toBe(true);
  });

  it('rejects legacy, stale, renamed, changed, and ambiguous project receipts', () => {
    expect(isCurrentPiSkillInvocation(item({ scope: undefined }), manifest(), skills())).toBe(false);
    expect(isCurrentPiSkillInvocation(item({ sourcePath: undefined }), manifest(), skills())).toBe(false);
    expect(isCurrentPiSkillInvocation(item(), manifest({ status: 'unknown' }), skills())).toBe(false);
    expect(isCurrentPiSkillInvocation(item(), manifest(), skills({ path: '/repo/.pi/skills/other' }))).toBe(false);
    expect(isCurrentPiSkillInvocation(item(), manifest(), skills({ runtimeStatus: 'discovered' }))).toBe(false);
    expect(isCurrentPiSkillInvocation(item(), manifest({ projectResources: undefined }), skills())).toBe(false);
    expect(isCurrentPiSkillInvocation(item(), manifest(), [...skills(), ...skills()])).toBe(false);
  });

  it('requires exact current user Skill source provenance too', () => {
    const userSource = '/home/user/.agents/skills/demo';
    const userItem = item({ scope: 'user', sourcePath: userSource });
    const userSkills = skills({ scope: 'user', path: userSource, runtimeStatus: undefined });
    const userManifest = manifest({
      commands: [{
        name: 'skill:demo',
        source: 'skill',
        sourceInfo: {
          scope: 'user',
          source: 'auto',
          baseDir: '/home/user/.agents',
        },
      }],
    });
    expect(isCurrentPiSkillInvocation(userItem, userManifest, userSkills)).toBe(true);
    expect(isCurrentPiSkillInvocation(
      userItem,
      userManifest,
      skills({ scope: 'user', path: '/home/user/.agents/skills/other' }),
    )).toBe(false);

    expect(isCurrentPiSkillInvocation(
      userItem,
      manifest({
        commands: [{
          name: 'skill:demo',
          source: 'skill',
          sourceInfo: {
            scope: 'user',
            source: 'auto',
            baseDir: '/other/.agents',
            path: '/other/.agents/skills/demo',
          },
        }],
      }),
      [...userSkills, ...skills({
        scope: 'user',
        path: '/other/.agents/skills/demo',
        runtimeStatus: undefined,
      })],
    )).toBe(false);

    expect(isCurrentPiSkillInvocation(
      userItem,
      manifest({
        commands: [{
          name: 'skill:demo',
          source: 'skill',
          sourceInfo: {
            scope: 'user',
            source: 'auto',
            baseDir: '/home/user/.agents',
            path: '/other/.agents/skills/demo/SKILL.md',
          },
        }],
      }),
      userSkills,
    )).toBe(false);
  });

  it('rejects a replacement Session after the final async runtime proof', async () => {
    const sessionA = { id: 'session-a' };
    const sessionB = { id: 'session-b' };
    let currentSession = sessionA;
    let delivered = false;

    await expect((async () => {
      await assertCurrentPiSkillInvocationSession(
        sessionA,
        () => currentSession,
        async () => {
          currentSession = sessionB;
          return true;
        },
      );
      delivered = true;
    })()).rejects.toSatisfy(isStalePiSkillInvocationError);

    expect(delivered).toBe(false);
    expect(currentSession).toBe(sessionB);
  });
});
