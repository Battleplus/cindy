import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cindy/maker-core', () => ({
  piProjectKey: (identity: {
    canonicalRepoRoot: string | null;
    canonicalWorkingDir: string | null;
    repoRootStatus: string;
    canonicalPathEncoding: string;
    windowsCaseComparison?: string;
  }) => identity.repoRootStatus === 'resolved'
    && (
      identity.canonicalPathEncoding === 'utf8-lossless'
      || identity.canonicalPathEncoding === 'utf16-lossless'
    )
    && identity.canonicalRepoRoot
    && identity.canonicalWorkingDir
    ? (identity.windowsCaseComparison === 'ordinal-insensitive'
      ? `${identity.canonicalRepoRoot}\0${identity.canonicalWorkingDir}`.toLowerCase()
      : `${identity.canonicalRepoRoot}\0${identity.canonicalWorkingDir}`)
    : null,
}));

import {
  __testing,
  resolveDesktopPiProjectIdentity,
  resolveDesktopPiProjectTrustInput,
  scanContainedDesktopPiProjectSkills,
} from '../pi-project-skill-admission-resolver.js';

let root = '';

function writeSkill(parent: string, name: string): string {
  const skill = path.join(parent, name);
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), `---\nname: ${name}\n---\n# ${name}\n`);
  return skill;
}

function makeProject(): { repo: string; first: string; second: string; skills: string[] } {
  const repo = path.join(root, 'repo');
  const first = path.join(repo, 'packages', 'first');
  const second = path.join(repo, 'packages', 'second');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(first, { recursive: true });
  fs.mkdirSync(second, { recursive: true });
  const skills = [
    writeSkill(path.join(first, '.pi', 'skills'), 'pi-skill'),
    writeSkill(path.join(first, '.agents', 'skills'), 'local-skill'),
    writeSkill(path.join(repo, '.agents', 'skills'), 'repo-skill'),
  ];
  fs.writeFileSync(path.join(first, '.pi', 'settings.json'), '{not-json');
  fs.writeFileSync(path.join(first, 'package.json'), '{"scripts":{"postinstall":"throw"}}');
  fs.mkdirSync(path.join(first, '.pi', 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(first, '.pi', 'extensions', 'must-not-run.ts'), 'throw 1');
  return { repo, first, second, skills };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-auto-skill-admission-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveDesktopPiProjectIdentity', () => {
  it('resolves the canonical working directory and nearest Git boundary', async () => {
    const project = makeProject();
    const alias = path.join(root, 'alias');
    fs.symlinkSync(project.first, alias);

    const identity = await resolveDesktopPiProjectIdentity(alias);

    expect(identity).toMatchObject({
      workingDir: path.resolve(alias),
      canonicalWorkingDir: fs.realpathSync(project.first),
      canonicalRepoRoot: fs.realpathSync(project.repo),
      repoRootStatus: 'resolved',
      platform: 'posix',
      canonicalPathEncoding: 'utf8-lossless',
    });
  });

  it('fails closed when the Git marker cannot be inspected', async () => {
    const project = makeProject();
    const gitMarker = path.join(fs.realpathSync(project.repo), '.git');
    const identity = await resolveDesktopPiProjectIdentity(project.first, {
      platform: 'posix',
      realpath: (candidate) => fs.promises.realpath(candidate),
      stat: async (candidate) => {
        if (candidate === gitMarker) {
          const error = new Error('denied') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        return fs.promises.stat(candidate);
      },
    });

    expect(identity).toBeNull();
  });
});

describe('canonical Windows comparison', () => {
  const insensitiveIdentity = {
    workingDir: 'C:\\Repo',
    canonicalWorkingDir: 'C:\\Repo',
    canonicalRepoRoot: 'C:\\Repo',
    repoRootStatus: 'resolved' as const,
    platform: 'win32' as const,
    canonicalPathEncoding: 'utf16-lossless' as const,
    windowsCaseComparison: 'ordinal-insensitive' as const,
  };

  it('handles drive/extended paths without prefix or sibling aliases', () => {
    expect(__testing.canonicalPathIsWithin(
      insensitiveIdentity,
      '\\\\?\\C:\\Repo',
      'c:\\repo\\.pi\\skills\\safe',
    )).toBe(true);
    expect(__testing.canonicalPathIsWithin(
      insensitiveIdentity,
      'C:\\Repo',
      'C:\\Repository\\escaped',
    )).toBe(false);
  });

  it('preserves case-sensitive identity and rejects non-ASCII ordinal folding', () => {
    expect(__testing.canonicalPathsEqual(
      { ...insensitiveIdentity, windowsCaseComparison: 'case-sensitive' },
      'C:\\Repo',
      'c:\\repo',
    )).toBe(false);
    expect(__testing.comparisonPath(
      insensitiveIdentity,
      'C:\\项目',
    )).toBeNull();
  });
});

describe('scanContainedDesktopPiProjectSkills', () => {
  it('finds only directory-form Pi skills from workingDir through the repo root', async () => {
    const project = makeProject();
    const identity = (await resolveDesktopPiProjectIdentity(project.first))!;

    const evidence = await scanContainedDesktopPiProjectSkills(identity);

    expect(evidence?.map((item) => item.discoveredPath)).toEqual(
      project.skills.map((skill) => fs.realpathSync(skill))
        .sort((left, right) => left.localeCompare(right)),
    );
    expect(evidence?.every((item) => item.canonicalPath === fs.realpathSync(item.discoveredPath)))
      .toBe(true);
  });

  it('fails closed when a skill or a skill source symlink escapes the repository', async () => {
    const project = makeProject();
    const identity = (await resolveDesktopPiProjectIdentity(project.first))!;
    const outside = writeSkill(path.join(root, 'outside'), 'escaped');
    fs.symlinkSync(outside, path.join(project.first, '.pi', 'skills', 'escaped'));

    expect(await scanContainedDesktopPiProjectSkills(identity)).toBeNull();

    fs.rmSync(path.join(project.first, '.pi', 'skills'), { recursive: true, force: true });
    fs.symlinkSync(path.dirname(outside), path.join(project.first, '.pi', 'skills'));
    expect(await scanContainedDesktopPiProjectSkills(identity)).toBeNull();
  });

  it('distinguishes absent sources from broken source or manifest symlinks', async () => {
    const project = makeProject();
    const identity = (await resolveDesktopPiProjectIdentity(project.first))!;
    const piSkillRoot = path.join(project.first, '.pi', 'skills');
    fs.rmSync(piSkillRoot, { recursive: true, force: true });
    fs.symlinkSync(path.join(root, 'missing-root'), piSkillRoot);
    expect(await scanContainedDesktopPiProjectSkills(identity)).toBeNull();

    fs.unlinkSync(piSkillRoot);
    const skill = writeSkill(piSkillRoot, 'broken-manifest');
    fs.unlinkSync(path.join(skill, 'SKILL.md'));
    fs.symlinkSync(path.join(root, 'missing-skill.md'), path.join(skill, 'SKILL.md'));
    expect(await scanContainedDesktopPiProjectSkills(identity)).toBeNull();
  });
});

describe('resolveDesktopPiProjectTrustInput', () => {
  it('automatically admits contained skills and hard-empties every non-skill surface', async () => {
    const project = makeProject();

    const snapshot = await resolveDesktopPiProjectTrustInput({
      sessionId: 'runtime-one',
      workingDir: project.first,
    });

    expect(snapshot?.approval).toMatchObject({
      status: 'approved',
      scope: 'working-dir',
      scopeKey: `${fs.realpathSync(project.repo)}\0${fs.realpathSync(project.first)}`,
    });
    expect(snapshot?.approval?.revision).toMatch(/^auto-skills-v1:[a-f0-9]{64}$/);
    expect(snapshot?.discovered.skills).toEqual(
      project.skills.map((skill) => fs.realpathSync(skill))
        .sort((left, right) => left.localeCompare(right)),
    );
    expect(snapshot?.discovered).toMatchObject({ settings: [], packages: [], extensions: [] });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.discovered.skills)).toBe(true);
  });

  it('re-evaluates each new runtime and isolates concurrent working directories', async () => {
    const project = makeProject();
    const secondSkill = writeSkill(path.join(project.second, '.pi', 'skills'), 'second-skill');
    const scanProjectSkills = vi.fn(scanContainedDesktopPiProjectSkills);
    const deps = { resolveIdentity: resolveDesktopPiProjectIdentity, scanProjectSkills };

    const [first, second] = await Promise.all([
      resolveDesktopPiProjectTrustInput(
        { sessionId: 'first', workingDir: project.first },
        deps,
      ),
      resolveDesktopPiProjectTrustInput(
        { sessionId: 'second', workingDir: project.second },
        deps,
      ),
    ]);
    const added = writeSkill(path.join(project.first, '.pi', 'skills'), 'new-runtime-skill');
    const restarted = await resolveDesktopPiProjectTrustInput(
      { sessionId: 'first-restarted', workingDir: project.first },
      deps,
    );

    expect(scanProjectSkills).toHaveBeenCalledTimes(6);
    expect(first?.approval?.revision).not.toBe(second?.approval?.revision);
    expect(restarted?.approval?.revision).not.toBe(first?.approval?.revision);
    expect(restarted?.discovered.skills).toContain(fs.realpathSync(added));
    expect(second?.discovered.skills).toEqual([
      fs.realpathSync(project.skills[2]),
      fs.realpathSync(secondSkill),
    ]);
  });

  it('fails closed for remote sessions and scan failures', async () => {
    const project = makeProject();
    const scanProjectSkills = vi.fn(scanContainedDesktopPiProjectSkills);

    expect(await resolveDesktopPiProjectTrustInput(
      { workingDir: project.first, remoteHostId: 'remote-one' },
      { resolveIdentity: resolveDesktopPiProjectIdentity, scanProjectSkills },
    )).toBeNull();
    expect(scanProjectSkills).not.toHaveBeenCalled();

    expect(await resolveDesktopPiProjectTrustInput(
      { workingDir: project.first },
      { resolveIdentity: resolveDesktopPiProjectIdentity, scanProjectSkills: async () => null },
    )).toBeNull();
  });

  it('invalidates if the repo identity or complete skill directory set changes mid-resolution', async () => {
    const project = makeProject();
    const firstIdentity = (await resolveDesktopPiProjectIdentity(project.first))!;
    const changedIdentity = { ...firstIdentity, canonicalWorkingDir: project.second };
    const resolveIdentity = vi.fn()
      .mockResolvedValueOnce(firstIdentity)
      .mockResolvedValueOnce(changedIdentity);
    expect(await resolveDesktopPiProjectTrustInput(
      { workingDir: project.first },
      { resolveIdentity, scanProjectSkills: scanContainedDesktopPiProjectSkills },
    )).toBeNull();

    const evidence = (await scanContainedDesktopPiProjectSkills(firstIdentity))!;
    const scanProjectSkills = vi.fn()
      .mockResolvedValueOnce(evidence)
      .mockResolvedValueOnce(evidence.slice(1));
    expect(await resolveDesktopPiProjectTrustInput(
      { workingDir: project.first },
      { resolveIdentity: async () => firstIdentity, scanProjectSkills },
    )).toBeNull();
  });

  it('fails closed when a skill symlink changes after the first scan', async () => {
    const project = makeProject();
    const firstTarget = writeSkill(path.join(project.repo, 'skill-targets'), 'first-target');
    const secondTarget = writeSkill(path.join(project.repo, 'skill-targets'), 'second-target');
    const skillLink = path.join(project.first, '.pi', 'skills', 'linked-skill');
    fs.symlinkSync(firstTarget, skillLink);
    let scans = 0;
    const scanProjectSkills = async (identity: Parameters<
      typeof scanContainedDesktopPiProjectSkills
    >[0]) => {
      const evidence = await scanContainedDesktopPiProjectSkills(identity);
      if (scans++ === 0) {
        fs.unlinkSync(skillLink);
        fs.symlinkSync(secondTarget, skillLink);
      }
      return evidence;
    };

    expect(await resolveDesktopPiProjectTrustInput(
      { workingDir: project.first },
      { resolveIdentity: resolveDesktopPiProjectIdentity, scanProjectSkills },
    )).toBeNull();
    expect(scans).toBe(2);
  });

  it('fails closed when Windows comparison identity changes with the same project key', async () => {
    const firstIdentity = {
      workingDir: 'c:\\repo',
      canonicalWorkingDir: 'c:\\repo',
      canonicalRepoRoot: 'c:\\repo',
      repoRootStatus: 'resolved' as const,
      platform: 'win32' as const,
      canonicalPathEncoding: 'utf16-lossless' as const,
      windowsCaseComparison: 'case-sensitive' as const,
    };
    const secondIdentity = {
      ...firstIdentity,
      windowsCaseComparison: 'ordinal-insensitive' as const,
    };
    const resolveIdentity = vi.fn()
      .mockResolvedValueOnce(firstIdentity)
      .mockResolvedValueOnce(secondIdentity);

    expect(await resolveDesktopPiProjectTrustInput(
      { workingDir: 'c:\\repo' },
      { resolveIdentity, scanProjectSkills: async () => [] },
    )).toBeNull();
  });
});
