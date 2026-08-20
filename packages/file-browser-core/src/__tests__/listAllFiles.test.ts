/**
 * listAllFiles —— rg 版文件清单。
 * 覆盖: rg 致命退出(非零 exit code)应 reject 而非返回空结果。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listAllFiles } from '../listAllFiles.js';
import { __clearCacheForTesting } from '../ignore.js';

/** rg 路径：优先环境变量，fallback 到仓库内置 binary。 */
function findRg(): string {
  if (process.env.RG_PATH) return process.env.RG_PATH;
  const candidates = [
    path.resolve(__dirname, '../../../../apps/ripgrep-bin/win32-x64/rg.exe'),
    path.resolve(__dirname, '../../../../apps/ripgrep-bin/darwin-arm64/rg'),
    path.resolve(__dirname, '../../../../apps/ripgrep-bin/linux-x64/rg'),
  ];
  for (const p of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:fs').accessSync(p);
      return p;
    } catch {
      // continue
    }
  }
  return 'rg';
}

describe('listAllFiles', () => {
  let workdir: string;
  let rg: string;

  beforeEach(async () => {
    __clearCacheForTesting();
    rg = findRg();
    workdir = await mkdtemp(path.join(os.tmpdir(), 'listall-test-'));
    await writeFile(path.join(workdir, 'a.txt'), 'hello\n', 'utf8');
    await writeFile(path.join(workdir, 'b.ts'), 'export {}\n', 'utf8');
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('resolves with files on success', async () => {
    const res = await listAllFiles({ workdir, rgPath: rg });
    expect(res.truncated).toBe(false);
    expect(res.files).toContain('a.txt');
    expect(res.files).toContain('b.ts');
  });

  it('rejects when rg binary does not exist (ENOENT)', async () => {
    await expect(
      listAllFiles({ workdir, rgPath: '/nonexistent/rg/binary' }),
    ).rejects.toThrow();
  });

  it('resolves with an empty list when rg finds no files (exit code 1)', async () => {
    await rm(path.join(workdir, 'a.txt'));
    await rm(path.join(workdir, 'b.ts'));

    const res = await listAllFiles({ workdir, rgPath: rg });

    expect(res.files).toEqual([]);
    expect(res.truncated).toBe(false);
  });

  it('rejects when rg exits non-zero (exit code 2 via bad config)', async () => {
    // 创建坏的 ripgrep 配置——无效 flag 触发 exit code 2。
    const badConf = path.join(workdir, 'bad-ripgrep.conf');
    await writeFile(badConf, '--definitely-not-a-ripgrep-flag\n', 'utf8');

    // 通过 env 参数注入 RIPGREP_CONFIG_PATH，让 rg 读取坏配置后以 code 2 退出。
    await expect(
      listAllFiles({ workdir, rgPath: rg, env: { RIPGREP_CONFIG_PATH: badConf } }),
    ).rejects.toThrow(/rg exited with code 2/);
  });
});
