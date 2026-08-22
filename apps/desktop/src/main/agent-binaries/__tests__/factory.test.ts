/**
 * factory.ts(createBinaryProvisioner)emit 时序回归。
 *
 * 背景(2026-07):统一下载器是单槽 FIFO 串行,agent 二进制下载可能在队列里
 * 排在热更 zip 之后。factory 若在 `await download()` 之前就 emit 'downloading',
 * splash 会在排队期间显示一根冻结在 0% 的假进度条;fromCache 命中时还会闪
 * 0→100 假进度。约定:'downloading' 状态只能由传输层真实 onProgress 事件驱动。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import type { VendorRuntimeState } from '../types.js';

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
}));

vi.mock('../../downloader/index.js', () => ({
  download: mocks.download,
  DownloadError: class DownloadError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

const FAKE_SHA = 'a'.repeat(64);

vi.mock('../../manifestService.js', () => ({
  fetchManifest: vi.fn(async () => null),
  getCachedManifest: vi.fn(() => ({ app: {} })),
  getBaseUrl: () => 'https://cdn.test',
}));

vi.mock('../manifest.js', () => ({
  getVendorAsset: () => ({
    version: '9.9.9-test',
    file: 'claude/claude-9.9.9.gz',
    sha256: FAKE_SHA,
    size: 3,
  }),
  resolveVendorAssetUrl: (base: string, asset: { file: string }) => `${base}/${asset.file}`,
}));

import { createBinaryProvisioner } from '../factory.js';

interface DownloadOpts {
  targetPath: string;
  onProgress?: (e: { loaded: number; total: number | null; percent: number | null; speedBps: number }) => void;
}

/** download mock 的成功实现:落一个真实 gzip 让后续解压走通。 */
function fulfillDownload(opts: DownloadOpts, fromCache: boolean): {
  path: string; size: number; sha256: string; fromCache: boolean; durationMs: number; resumedFromBytes: number;
} {
  fs.mkdirSync(path.dirname(opts.targetPath), { recursive: true });
  fs.writeFileSync(opts.targetPath, gzipSync(Buffer.from('bin')));
  return {
    path: opts.targetPath,
    size: 3,
    sha256: FAKE_SHA,
    fromCache,
    durationMs: 1,
    resumedFromBytes: 0,
  };
}

function makeProvisioner() {
  // installSubdir 每个用例唯一,落在 electron-stub 的 tmp userData 下,互不污染。
  return createBinaryProvisioner({
    vendorKey: 'claude',
    manifestField: 'claudeCode',
    installSubdir: `factory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    artifact: { kind: 'gz', binaryName: 'claude-test-bin' },
  });
}

beforeEach(() => {
  mocks.download.mockReset();
});

describe('createBinaryProvisioner emit 时序', () => {
  it('fromCache 命中(download 不产生 onProgress):全程不得 emit downloading', async () => {
    mocks.download.mockImplementation(async (opts: DownloadOpts) => fulfillDownload(opts, true));

    const statuses: Array<VendorRuntimeState['status']> = [];
    const provisioner = makeProvisioner();
    const result = await provisioner.prepare({
      onProgress: (p) => statuses.push(p.status),
    });

    expect(result.ready).toBe(true);
    // 旧实现会在 download() 之前 emit 一次 downloading/0%,造成 splash 假进度条。
    expect(statuses).not.toContain('downloading');
    expect(statuses[statuses.length - 1]).toBe('ready');
  });

  it('真实下载:downloading 只能出现在 download() 的 onProgress 之后(排队期间无事件)', async () => {
    let statusesWhenDownloadInvoked: Array<VendorRuntimeState['status']> = [];
    const statuses: Array<VendorRuntimeState['status']> = [];

    mocks.download.mockImplementation(async (opts: DownloadOpts) => {
      // download() 被调用瞬间 = 任务刚入队(可能在队列里等热更 zip)。
      // 此刻不允许已有任何 downloading emit。
      statusesWhenDownloadInvoked = [...statuses];
      // 模拟排一拍队后传输真正开始,首个进度事件到达。
      await new Promise((r) => setTimeout(r, 10));
      opts.onProgress?.({ loaded: 1, total: 3, percent: 33.3, speedBps: 1024 });
      opts.onProgress?.({ loaded: 3, total: 3, percent: 100, speedBps: 1024 });
      return fulfillDownload(opts, false);
    });

    const provisioner = makeProvisioner();
    const result = await provisioner.prepare({
      onProgress: (p) => statuses.push(p.status),
    });

    expect(result.ready).toBe(true);
    expect(statusesWhenDownloadInvoked).not.toContain('downloading');
    expect(statuses).toContain('downloading');
    expect(statuses[statuses.length - 1]).toBe('ready');
  });
});


describe('离线启动 fallback', () => {
  it('本地有已验证版本时:manifest fetch 失败仍返回 ready', async () => {
    // 获取真实 userData 路径（electron-stub 提供 tmp 目录）
    const { app } = await import('electron');
    const userData = app.getPath('userData');
    const installSubdir = `offline-fallback-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const version = '1.2.3-verified';
    const binaryName = 'test-binary';

    // 创建本地已验证版本目录结构
    const versionDir = path.join(userData, installSubdir, version);
    fs.mkdirSync(versionDir, { recursive: true });
    const binPath = path.join(versionDir, binaryName);
    fs.writeFileSync(binPath, 'fake binary');
    fs.chmodSync(binPath, 0o755);
    // 创建 .verified 标记文件
    fs.writeFileSync(path.join(versionDir, '.verified'), '');

    // 让 manifest 和 cache 都返回 null（模拟 CDN 不可达）
    const { getCachedManifest, fetchManifest } = await import('../../manifestService.js');
    vi.mocked(getCachedManifest).mockReturnValue(null as any);
    vi.mocked(fetchManifest).mockResolvedValue(null as any);

    const provisioner = createBinaryProvisioner({
      vendorKey: 'claude',
      manifestField: 'testField',
      installSubdir,
      artifact: { kind: 'raw', binaryName },
    });

    const result = await provisioner.prepare();

    expect(result.ready).toBe(true);
    expect(result.binaryPath).toBe(binPath);
  });

  it('download 失败时:本地有已验证版本仍返回 ready', async () => {
    const { app } = await import('electron');
    const userData = app.getPath('userData');
    const installSubdir = `download-fallback-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const version = '2.0.0-verified';
    const binaryName = 'test-binary';

    // 创建本地已验证版本
    const versionDir = path.join(userData, installSubdir, version);
    fs.mkdirSync(versionDir, { recursive: true });
    const binPath = path.join(versionDir, binaryName);
    fs.writeFileSync(binPath, 'fake binary');
    fs.chmodSync(binPath, 0o755);
    fs.writeFileSync(path.join(versionDir, '.verified'), '');

    // manifest 返回成功，但 download 会抛错（模拟 CDN 拦截）
    const { getCachedManifest, fetchManifest } = await import('../../manifestService.js');
    vi.mocked(getCachedManifest).mockReturnValue(null as any);
    vi.mocked(fetchManifest).mockResolvedValue({
      version: '2.0.0',
      claude: { file: '/linux-x64/claude.bin', sha256: 'abc', size: 100 },
    } as any);

    // Mock download to throw
    const downloader = await import('../../downloader/index.js');
    vi.mocked(downloader.download).mockRejectedValue(new Error('CDN blocked'));

    const provisioner = createBinaryProvisioner({
      vendorKey: 'claude',
      manifestField: 'claude',
      installSubdir,
      artifact: { kind: 'raw', binaryName },
    });

    const result = await provisioner.prepare();

    expect(result.ready).toBe(true);
    expect(result.binaryPath).toBe(binPath);
  });
});
