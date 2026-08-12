import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  piProjectKey,
  type PiProjectCanonicalPathEvidence,
  type PiProjectIdentityResolution,
  type PiProjectTrustInputSnapshot,
} from '@cindy/maker-core';

type HostPlatform = PiProjectIdentityResolution['platform'];
type PathApi = typeof path.posix | typeof path.win32;
type WindowsCaseComparison = Exclude<
  PiProjectIdentityResolution['windowsCaseComparison'],
  undefined
>;

interface FsStatLike {
  isDirectory(): boolean;
  isFile(): boolean;
  dev?: number | bigint;
  ino?: number | bigint;
}

interface FsDirentLike {
  name: string;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

interface FsLstatLike extends FsStatLike {
  isSymbolicLink(): boolean;
}

export interface DesktopPiProjectIdentityDeps {
  platform: HostPlatform;
  stat: (candidate: string) => Promise<FsStatLike>;
  realpath: (candidate: string) => Promise<string>;
  resolveWindowsCaseComparison?: (
    canonicalWorkingDir: string,
  ) => Promise<WindowsCaseComparison>;
}

export interface PiProjectSkillAdmissionResolverDeps {
  resolveIdentity: (
    workingDir: string,
  ) => Promise<PiProjectIdentityResolution | null>;
  scanProjectSkills: (
    identity: PiProjectIdentityResolution,
  ) => Promise<PiProjectCanonicalPathEvidence[] | null>;
}

interface ProjectSkillScanDeps {
  readdir: (candidate: string) => Promise<FsDirentLike[]>;
  lstat: (candidate: string) => Promise<FsLstatLike>;
  stat: (candidate: string) => Promise<FsStatLike>;
  realpath: (candidate: string) => Promise<string>;
}

function losslessPosixPath(value: string): boolean {
  return value.startsWith('/')
    && !value.includes('\0')
    && !value.includes('\uFFFD')
    && Buffer.from(value, 'utf8').toString('utf8') === value;
}

function losslessUtf16Path(value: string): boolean {
  if (!value || value.includes('\0') || value.includes('\uFFFD')) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function hasDotSegments(value: string): boolean {
  return value.split('/').some((segment) => segment === '.' || segment === '..');
}

function comparisonPath(
  identity: Pick<PiProjectIdentityResolution, 'platform' | 'windowsCaseComparison'>,
  value: string,
): string | null {
  if (value.includes('\0') || value.includes('\uFFFD')) return null;
  if (identity.platform === 'posix') {
    return value.startsWith('/') && !hasDotSegments(value) ? value : null;
  }
  const comparison = identity.windowsCaseComparison;
  if (comparison !== 'ordinal-insensitive' && comparison !== 'case-sensitive') return null;
  let normalized = value.replaceAll('\\', '/');
  if (
    comparison === 'ordinal-insensitive'
    && Array.from(normalized).some((character) => (character.codePointAt(0) ?? 0) > 0x7f)
  ) return null;
  if (normalized.toLowerCase().startsWith('//?/unc/')) {
    normalized = `//${normalized.slice(8)}`;
  } else if (/^\/\/\?\/[A-Za-z]:\//.test(normalized)) {
    normalized = normalized.slice(4);
  } else if (normalized.startsWith('//?/') || normalized.startsWith('//./')) {
    return null;
  }
  normalized = normalized.startsWith('//')
    ? `//${normalized.slice(2).replace(/\/+/g, '/')}`
    : normalized.replace(/\/+/g, '/');
  if (hasDotSegments(normalized)) return null;
  if (!/^(?:[A-Za-z]:\/|\/\/)/.test(normalized)) return null;
  if (normalized.startsWith('//') && !/^\/\/[^/]+\/[^/]+(?:\/|$)/.test(normalized)) return null;
  if (!/^[A-Za-z]:\/$/.test(normalized)) normalized = normalized.replace(/\/$/, '');
  return comparison === 'ordinal-insensitive' ? normalized.toLowerCase() : normalized;
}

function canonicalPathsEqual(
  identity: PiProjectIdentityResolution,
  first: string,
  second: string,
): boolean {
  const left = comparisonPath(identity, first);
  const right = comparisonPath(identity, second);
  return left !== null && right !== null && left === right;
}

function canonicalPathIsWithin(
  identity: PiProjectIdentityResolution,
  root: string,
  candidate: string,
): boolean {
  const normalizedRoot = comparisonPath(identity, root);
  const normalizedCandidate = comparisonPath(identity, candidate);
  if (!normalizedRoot || !normalizedCandidate) return false;
  const prefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(prefix);
}

async function nearestGitRoot(
  start: string,
  stat: DesktopPiProjectIdentityDeps['stat'],
  pathApi: PathApi,
): Promise<string | null> {
  let current = start;
  while (true) {
    try {
      const marker = await stat(pathApi.join(current, '.git'));
      if (marker.isDirectory() || marker.isFile()) return current;
      return null;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
    }
    const parent = pathApi.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function swapAsciiCase(value: string): string | null {
  const drivePrefixLength = /^[A-Za-z]:[\\/]/.test(value) ? 2 : 0;
  for (let index = value.length - 1; index >= drivePrefixLength; index -= 1) {
    const character = value[index];
    if (!/[A-Za-z]/.test(character)) continue;
    const swapped = character === character.toLowerCase()
      ? character.toUpperCase()
      : character.toLowerCase();
    return `${value.slice(0, index)}${swapped}${value.slice(index + 1)}`;
  }
  return null;
}

async function detectWindowsCaseComparison(
  canonicalWorkingDir: string,
): Promise<WindowsCaseComparison> {
  const alternate = swapAsciiCase(canonicalWorkingDir);
  if (!alternate) return 'unavailable';
  try {
    const [original, probe] = await Promise.all([
      fsp.stat(canonicalWorkingDir),
      fsp.stat(alternate),
    ]);
    return original.dev === probe.dev && original.ino === probe.ino
      ? 'ordinal-insensitive'
      : 'case-sensitive';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'case-sensitive' : 'unavailable';
  }
}

function defaultIdentityDeps(): DesktopPiProjectIdentityDeps {
  return {
    platform: process.platform === 'win32' ? 'win32' : 'posix',
    stat: (candidate) => fsp.stat(candidate),
    realpath: (candidate) => fsp.realpath(candidate),
    resolveWindowsCaseComparison: detectWindowsCaseComparison,
  };
}

export async function resolveDesktopPiProjectIdentity(
  workingDir: string,
  dependencies: DesktopPiProjectIdentityDeps = defaultIdentityDeps(),
): Promise<PiProjectIdentityResolution | null> {
  if (!workingDir || workingDir.includes('\0')) return null;
  const pathApi = dependencies.platform === 'win32' ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(workingDir)) return null;
  const requestedWorkingDir = pathApi.resolve(workingDir);
  try {
    if (!(await dependencies.stat(requestedWorkingDir)).isDirectory()) return null;
    const canonicalWorkingDir = await dependencies.realpath(requestedWorkingDir);
    const lexicalRepoRoot = await nearestGitRoot(canonicalWorkingDir, dependencies.stat, pathApi);
    if (!lexicalRepoRoot) return null;
    const canonicalRepoRoot = await dependencies.realpath(lexicalRepoRoot);
    let identity: PiProjectIdentityResolution;
    if (dependencies.platform === 'posix') {
      if (!losslessPosixPath(canonicalWorkingDir) || !losslessPosixPath(canonicalRepoRoot)) return null;
      identity = {
        workingDir: requestedWorkingDir,
        canonicalWorkingDir,
        canonicalRepoRoot,
        repoRootStatus: 'resolved',
        platform: 'posix',
        canonicalPathEncoding: 'utf8-lossless',
      };
    } else {
      if (!losslessUtf16Path(canonicalWorkingDir) || !losslessUtf16Path(canonicalRepoRoot)) return null;
      const windowsCaseComparison = await dependencies.resolveWindowsCaseComparison?.(
        canonicalWorkingDir,
      ) ?? 'unavailable';
      if (windowsCaseComparison === 'unavailable') return null;
      identity = {
        workingDir: requestedWorkingDir,
        canonicalWorkingDir,
        canonicalRepoRoot,
        repoRootStatus: 'resolved',
        platform: 'win32',
        canonicalPathEncoding: 'utf16-lossless',
        windowsCaseComparison,
      };
    }
    return canonicalPathIsWithin(identity, canonicalRepoRoot, canonicalWorkingDir)
      && piProjectKey(identity)
      ? identity
      : null;
  } catch {
    return null;
  }
}

function projectSkillSourceRoots(identity: PiProjectIdentityResolution): string[] | null {
  const workingDir = identity.canonicalWorkingDir;
  const repoRoot = identity.canonicalRepoRoot;
  if (!workingDir || !repoRoot) return null;
  const pathApi = identity.platform === 'win32' ? path.win32 : path.posix;
  const roots = [pathApi.join(workingDir, '.pi', 'skills')];
  let current = workingDir;
  while (true) {
    roots.push(pathApi.join(current, '.agents', 'skills'));
    if (canonicalPathsEqual(identity, current, repoRoot)) break;
    const parent = pathApi.dirname(current);
    if (parent === current || !canonicalPathIsWithin(identity, repoRoot, parent)) return null;
    current = parent;
  }
  return roots;
}

async function statOrNull(
  candidate: string,
  stat: ProjectSkillScanDeps['stat'],
): Promise<FsStatLike | null> {
  try {
    return await stat(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

async function lstatOrNull(
  candidate: string,
  lstat: ProjectSkillScanDeps['lstat'],
): Promise<FsLstatLike | null> {
  try {
    return await lstat(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

async function scanOneProjectSkillRoot(
  identity: PiProjectIdentityResolution,
  sourceRoot: string,
  dependencies: ProjectSkillScanDeps,
): Promise<PiProjectCanonicalPathEvidence[] | null> {
  const rootEntry = await lstatOrNull(sourceRoot, dependencies.lstat);
  if (!rootEntry) return [];
  const rootStat = await statOrNull(sourceRoot, dependencies.stat);
  if (!rootStat) return null;
  if (!rootStat.isDirectory()) return null;
  const canonicalSourceRoot = await dependencies.realpath(sourceRoot);
  if (!canonicalPathIsWithin(identity, identity.canonicalRepoRoot!, canonicalSourceRoot)) return null;
  const entries = await dependencies.readdir(sourceRoot);
  const result: PiProjectCanonicalPathEvidence[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.') || /\.bak\.\d+$/.test(entry.name)) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const folder = pathFor(identity).join(sourceRoot, entry.name);
    const canonicalFolder = await dependencies.realpath(folder);
    if (!canonicalPathIsWithin(identity, identity.canonicalRepoRoot!, canonicalFolder)) return null;
    const folderStat = await statOrNull(folder, dependencies.stat);
    if (!folderStat?.isDirectory()) return null;

    const upperManifest = pathFor(identity).join(folder, 'SKILL.md');
    const upperEntry = await lstatOrNull(upperManifest, dependencies.lstat);
    if (!upperEntry) continue;
    const upperStat = await statOrNull(upperManifest, dependencies.stat);
    if (!upperStat?.isFile()) return null;
    const canonicalManifest = await dependencies.realpath(upperManifest);
    if (!canonicalPathIsWithin(identity, identity.canonicalRepoRoot!, canonicalManifest)) return null;
    result.push({ discoveredPath: folder, canonicalPath: canonicalFolder });
  }
  const reboundSourceRoot = await dependencies.realpath(sourceRoot);
  return canonicalPathsEqual(identity, canonicalSourceRoot, reboundSourceRoot) ? result : null;
}

function pathFor(identity: PiProjectIdentityResolution): PathApi {
  return identity.platform === 'win32' ? path.win32 : path.posix;
}

const defaultScanDeps = (): ProjectSkillScanDeps => ({
  readdir: (candidate) => fsp.readdir(candidate, { withFileTypes: true }),
  lstat: (candidate) => fsp.lstat(candidate),
  stat: (candidate) => fsp.stat(candidate),
  realpath: (candidate) => fsp.realpath(candidate),
});

export async function scanContainedDesktopPiProjectSkills(
  identity: PiProjectIdentityResolution,
  dependencies: ProjectSkillScanDeps = defaultScanDeps(),
): Promise<PiProjectCanonicalPathEvidence[] | null> {
  const roots = projectSkillSourceRoots(identity);
  if (!roots) return null;
  try {
    const evidence: PiProjectCanonicalPathEvidence[] = [];
    const canonicalPaths = new Set<string>();
    for (const root of roots) {
      const scanned = await scanOneProjectSkillRoot(identity, root, dependencies);
      if (!scanned) return null;
      for (const item of scanned) {
        const comparison = comparisonPath(identity, item.canonicalPath);
        if (!comparison || canonicalPaths.has(comparison)) return null;
        canonicalPaths.add(comparison);
        evidence.push(item);
      }
    }
    evidence.sort((left, right) => left.discoveredPath.localeCompare(right.discoveredPath));
    return evidence;
  } catch {
    return null;
  }
}

const defaultResolverDeps = (): PiProjectSkillAdmissionResolverDeps => ({
  resolveIdentity: resolveDesktopPiProjectIdentity,
  scanProjectSkills: scanContainedDesktopPiProjectSkills,
});

function admissionRevision(
  projectKey: string,
  evidence: readonly PiProjectCanonicalPathEvidence[],
): string {
  const hash = createHash('sha256');
  hash.update('desktop-auto-project-skills-v1\0');
  hash.update(projectKey);
  for (const item of evidence) {
    hash.update('\0');
    hash.update(item.discoveredPath);
    hash.update('\0');
    hash.update(item.canonicalPath);
  }
  return `auto-skills-v1:${hash.digest('hex')}`;
}

function sameProjectIdentity(
  first: PiProjectIdentityResolution,
  second: PiProjectIdentityResolution,
): boolean {
  return first.platform === second.platform
    && first.canonicalPathEncoding === second.canonicalPathEncoding
    && first.windowsCaseComparison === second.windowsCaseComparison
    && piProjectKey(first) !== null
    && piProjectKey(first) === piProjectKey(second);
}

function sameEvidence(
  identity: PiProjectIdentityResolution,
  first: readonly PiProjectCanonicalPathEvidence[],
  second: readonly PiProjectCanonicalPathEvidence[],
): boolean {
  return first.length === second.length && first.every((item, index) =>
    item.discoveredPath === second[index]?.discoveredPath
    && canonicalPathsEqual(identity, item.canonicalPath, second[index]!.canonicalPath));
}

/** Re-evaluated once for every new local Pi runtime; no user approval state is read or written. */
export async function resolveDesktopPiProjectTrustInput(
  context: { sessionId?: string; workingDir: string; remoteHostId?: string },
  dependencies: PiProjectSkillAdmissionResolverDeps = defaultResolverDeps(),
): Promise<PiProjectTrustInputSnapshot | null> {
  if (context.remoteHostId) return null;
  const identity = await dependencies.resolveIdentity(context.workingDir);
  const projectKey = identity && piProjectKey(identity);
  if (!identity || !projectKey) return null;
  const evidence = await dependencies.scanProjectSkills(identity);
  if (!evidence) return null;

  const reboundIdentity = await dependencies.resolveIdentity(context.workingDir);
  if (!reboundIdentity || !sameProjectIdentity(identity, reboundIdentity)) return null;
  const reboundEvidence = await dependencies.scanProjectSkills(reboundIdentity);
  if (!reboundEvidence || !sameEvidence(identity, evidence, reboundEvidence)) return null;

  const frozenEvidence = Object.freeze(
    evidence.map((item) => Object.freeze({ ...item })),
  );
  const snapshot: PiProjectTrustInputSnapshot = {
    identity: Object.freeze({ ...identity }),
    approval: Object.freeze({
      status: 'approved',
      scope: 'working-dir',
      scopeKey: projectKey,
      revision: admissionRevision(projectKey, frozenEvidence),
    }),
    discovered: Object.freeze({
      skills: Object.freeze(evidence.map((item) => item.discoveredPath)),
      canonicalSkillEvidence: frozenEvidence,
      settings: Object.freeze([]),
      packages: Object.freeze([]),
      extensions: Object.freeze([]),
    }),
  };
  return Object.freeze(snapshot);
}

export const __testing = {
  admissionRevision,
  canonicalPathIsWithin,
  canonicalPathsEqual,
  comparisonPath,
  nearestGitRoot,
  projectSkillSourceRoots,
};
