/**
 * RipgrepSearcher —— rg 搜索器。
 * 覆盖: rg 致命退出(exit code 2)应 emit error 事件而非正常 end。
 */

import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RipgrepSearcher } from '../search/RipgrepSearcher.js';
import type { SearchEvent } from '../search/types.js';

/** rg 路径：优先环境变量，fallback 到仓库内置 binary。 */
function rgPath(): string {
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
    } catch { /* continue */ }
  }
  return 'rg';
}

/** 简易无操作 logger。 */
const noopLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function collectEvents(searcher: RipgrepSearcher, searchId: string): Promise<SearchEvent[]> {
  return new Promise((resolve) => {
    const events: SearchEvent[] = [];
    let errorTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (errorTimer) clearTimeout(errorTimer);
      searcher.off('event', handler);
      resolve(events);
    };
    const handler = (ev: SearchEvent) => {
      if (ev.searchId !== searchId) return;
      events.push(ev);
      if (ev.type === 'end') {
        finish();
      } else if (ev.type === 'error') {
        // Keep listening briefly so a contradictory end event is observable.
        errorTimer = setTimeout(finish, 25);
      }
    };
    searcher.on('event', handler);
  });
}

describe('RipgrepSearcher', () => {
  let workdir: string;
  let rg: string;

  beforeEach(async () => {
    rg = rgPath();
    workdir = await mkdtemp(path.join(os.tmpdir(), 'rgsearcher-test-'));
    await mkdir(path.join(workdir, 'src'), { recursive: true });
    await writeFile(path.join(workdir, 'src', 'code.ts'), 'const x = 1;\n', 'utf8');
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('emits match + end on successful search', async () => {
    const searcher = new RipgrepSearcher({ rgPath: rg, logger: noopLog });
    const searchId = searcher.start({
      workdir,
      query: 'const x',
      caseSensitive: false,
      maxMatches: 100,
    });
    const events = await collectEvents(searcher, searchId);
    expect(events.some((e) => e.type === 'match')).toBe(true);
    expect(events.some((e) => e.type === 'end')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('emits end (not error) when no matches (exit code 1)', async () => {
    const searcher = new RipgrepSearcher({ rgPath: rg, logger: noopLog });
    const searchId = searcher.start({
      workdir,
      query: 'zzz_nonexistent_xyz',
      caseSensitive: false,
      maxMatches: 100,
    });
    const events = await collectEvents(searcher, searchId);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    const end = events.find((e) => e.type === 'end');
    expect(end).toBeDefined();
    if (end && end.type === 'end') {
      expect(end.totalMatches).toBe(0);
    }
  });

  it('emits error without end when rg cannot be started', async () => {
    const searcher = new RipgrepSearcher({ rgPath: path.join(workdir, 'missing-rg'), logger: noopLog });
    const searchId = searcher.start({
      workdir,
      query: 'anything',
      caseSensitive: false,
      maxMatches: 100,
    });
    const events = await collectEvents(searcher, searchId);

    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.some((e) => e.type === 'end')).toBe(false);
  });

  it('emits error when rg exits with fatal code 2', async () => {
    // 创建坏 ripgrep 配置触发 exit code 2
    const badConf = path.join(workdir, 'bad-ripgrep.conf');
    await writeFile(badConf, '--definitely-not-a-ripgrep-flag\n', 'utf8');
    const isWin = process.platform === 'win32';
    let wrapper: string;
    if (isWin) {
      wrapper = path.join(workdir, 'rg-bad.bat');
      await writeFile(
        wrapper,
        `@echo off\r\nset "RIPGREP_CONFIG_PATH=${badConf}"\r\n"${rg}" %*\r\n`,
      );
    } else {
      wrapper = path.join(workdir, 'rg-bad.sh');
      await writeFile(
        wrapper,
        `#!/bin/sh\nexport RIPGREP_CONFIG_PATH="${badConf}"\nexec "${rg}" "$@"\n`,
        'utf8',
      );
      await chmod(wrapper, 0o755);
    }

    const searcher = new RipgrepSearcher({ rgPath: wrapper, logger: noopLog });
    const searchId = searcher.start({
      workdir,
      query: 'anything',
      caseSensitive: false,
      maxMatches: 100,
    });
    const events = await collectEvents(searcher, searchId);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.some((e) => e.type === 'end')).toBe(false);
  });
});
