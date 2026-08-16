import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';
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

const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-pi-skill-validation-'));
const sourcePath = path.join(repoRoot, '.pi', 'skills', 'demo');
const localPathComparisonIdentity = process.platform === 'win32'
  ? ({ platform: 'win32', windowsCaseComparison: 'case-sensitive' } as const)
  : ({ platform: 'posix' } as const);
fs.mkdirSync(sourcePath, { recursive: true });

afterAll(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

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
        canonicalRepoRoot: repoRoot,
        pathComparisonIdentity: localPathComparisonIdentity,
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
  it('accepts one exact current project Skill provenance match', async () => {
    expect(await isCurrentPiSkillInvocation(item(), manifest(), skills())).toBe(true);
  });

  it('accepts a loaded project Skill receipt through its stable in-repo symlink', async () => {
    const physicalSource = path.join(repoRoot, '.pi', 'skills', 'physical-demo');
    const otherSource = path.join(repoRoot, '.pi', 'skills', 'other-demo');
    const linkedSource = path.join(repoRoot, '.pi', 'skills', 'linked-demo');
    try {
      fs.mkdirSync(physicalSource);
      fs.mkdirSync(otherSource);
      fs.symlinkSync(
        physicalSource,
        linkedSource,
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      expect(await isCurrentPiSkillInvocation(
        item({ sourcePath: linkedSource }),
        manifest({
          projectResources: {
            ...manifest().projectResources!,
            loadedSkills: [{
              sourcePath: physicalSource,
              runtimePath: '/snapshot/demo',
              commandName: 'skill:demo',
              canonicalRepoRoot: repoRoot,
              pathComparisonIdentity: localPathComparisonIdentity,
            }],
          },
        }),
        skills({ path: linkedSource }),
      )).toBe(true);

      fs.unlinkSync(linkedSource);
      fs.symlinkSync(
        otherSource,
        linkedSource,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      expect(await isCurrentPiSkillInvocation(
        item({ sourcePath: linkedSource }),
        manifest({
          projectResources: {
            ...manifest().projectResources!,
            loadedSkills: [{
              sourcePath: physicalSource,
              runtimePath: '/snapshot/demo',
              commandName: 'skill:demo',
              canonicalRepoRoot: repoRoot,
              pathComparisonIdentity: localPathComparisonIdentity,
            }],
          },
        }),
        skills({ path: linkedSource }),
      )).toBe(false);
    } finally {
      fs.rmSync(linkedSource, { recursive: true, force: true });
      fs.rmSync(physicalSource, { recursive: true, force: true });
      fs.rmSync(otherSource, { recursive: true, force: true });
    }
  });

  it('rejects legacy, stale, renamed, changed, and ambiguous project receipts', async () => {
    expect(await isCurrentPiSkillInvocation(item({ scope: undefined }), manifest(), skills())).toBe(false);
    expect(await isCurrentPiSkillInvocation(item({ sourcePath: undefined }), manifest(), skills())).toBe(false);
    expect(await isCurrentPiSkillInvocation(item(), manifest({ status: 'unknown' }), skills())).toBe(false);
    expect(await isCurrentPiSkillInvocation(item(), manifest(), skills({ path: '/repo/.pi/skills/other' }))).toBe(false);
    expect(await isCurrentPiSkillInvocation(item(), manifest(), skills({ runtimeStatus: 'discovered' }))).toBe(false);
    expect(await isCurrentPiSkillInvocation(item(), manifest({ projectResources: undefined }), skills())).toBe(false);
    expect(await isCurrentPiSkillInvocation(item(), manifest(), [...skills(), ...skills()])).toBe(false);
    expect(await isCurrentPiSkillInvocation(item(), manifest({
      projectResources: {
        ...manifest().projectResources!,
        loadedSkills: [{
          sourcePath,
          runtimePath: '/snapshot/demo',
          commandName: 'skill:demo',
          canonicalRepoRoot: repoRoot,
        }],
      },
    }), skills())).toBe(false);
    expect(await isCurrentPiSkillInvocation(item(), manifest({
      projectResources: {
        ...manifest().projectResources!,
        loadedSkills: [{
          sourcePath,
          runtimePath: '/snapshot/demo',
          commandName: 'skill:demo',
          canonicalRepoRoot: repoRoot,
          pathComparisonIdentity: {
            platform: 'invalid',
          } as never,
        }],
      },
    }), skills())).toBe(false);

    const unrelatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-pi-skill-other-repo-'));
    try {
      expect(await isCurrentPiSkillInvocation(item(), manifest({
        projectResources: {
          ...manifest().projectResources!,
          loadedSkills: [{
            sourcePath,
            runtimePath: '/snapshot/demo',
            commandName: 'skill:demo',
            canonicalRepoRoot: unrelatedRoot,
            pathComparisonIdentity: localPathComparisonIdentity,
          }],
        },
      }), skills())).toBe(false);
    } finally {
      fs.rmSync(unrelatedRoot, { recursive: true, force: true });
    }
  });

  it('requires exact current user Skill source provenance too', async () => {
    const userBaseDir = path.join(repoRoot, 'user-skill-provenance', '.agents');
    const userSource = path.join(userBaseDir, 'skills', 'demo');
    fs.mkdirSync(userSource, { recursive: true });
    const userItem = item({ scope: 'user', sourcePath: userSource });
    const userSkills = skills({ scope: 'user', path: userSource, runtimeStatus: undefined });
    const userManifest = manifest({
      commands: [{
        name: 'skill:demo',
        source: 'skill',
        sourceInfo: {
          scope: 'user',
          source: 'auto',
          baseDir: userBaseDir,
        },
      }],
    });
    expect(await isCurrentPiSkillInvocation(userItem, userManifest, userSkills)).toBe(true);
    expect(await isCurrentPiSkillInvocation(
      userItem,
      userManifest,
      skills({ scope: 'user', path: '/home/user/.agents/skills/other' }),
    )).toBe(false);

    expect(await isCurrentPiSkillInvocation(
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

    expect(await isCurrentPiSkillInvocation(
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

  it('rejects a user Skill whose physical source disappeared after scanning', async () => {
    const userBaseDir = path.join(repoRoot, 'deleted-user-skill', '.agents');
    const userSource = path.join(userBaseDir, 'skills', 'demo');
    fs.mkdirSync(userSource, { recursive: true });
    const userItem = item({ scope: 'user', sourcePath: userSource });
    const userSkills = skills({ scope: 'user', path: userSource, runtimeStatus: undefined });
    const userManifest = manifest({
      commands: [{
        name: 'skill:demo',
        source: 'skill',
        sourceInfo: {
          scope: 'user',
          source: 'auto',
          baseDir: userBaseDir,
        },
      }],
    });

    fs.rmSync(userSource, { recursive: true, force: true });

    expect(await isCurrentPiSkillInvocation(userItem, userManifest, userSkills)).toBe(false);
  });

  it('fails closed when repo or user source canonicalization exceeds the deadline', async () => {
    const blockedRealpath = vi.fn(() => new Promise<string>(() => {}));
    const dependencies = { realpath: blockedRealpath, deadlineMs: 10 };

    vi.useFakeTimers();
    try {
      const repoValidation = isCurrentPiSkillInvocation(
        item(),
        manifest(),
        skills(),
        dependencies,
      );
      await vi.advanceTimersByTimeAsync(10);
      await expect(repoValidation).resolves.toBe(false);

      const userSource = '/home/user/.agents/skills/demo';
      const userValidation = isCurrentPiSkillInvocation(
        item({ scope: 'user', sourcePath: userSource }),
        manifest({
          commands: [{
            name: 'skill:demo',
            source: 'skill',
            sourceInfo: {
              scope: 'user',
              source: 'auto',
              baseDir: '/home/user/.agents',
            },
          }],
        }),
        skills({ scope: 'user', path: userSource, runtimeStatus: undefined }),
        dependencies,
      );
      await vi.advanceTimersByTimeAsync(10);
      await expect(userValidation).resolves.toBe(false);
      expect(blockedRealpath).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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
