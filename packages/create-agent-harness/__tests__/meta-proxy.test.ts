// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import {
  META_PROXY_VERSION,
  createMetaProxyPolicyToken,
  isValidReleaseVersion,
  metaProxyClientEnvironment,
  metaProxyCmd,
  metaProxyEndpoint,
  parseSha256Sums,
  resolveMetaProxyAsset,
  sha256Hex,
  verifyMetaProxyChecksum,
  verifyMetaProxyManifest,
  worktreeFingerprint,
} from '../src/meta-proxy.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('optional Meta-Proxy integration', () => {
  it('maps each supported platform to the signed v0.3.0 asset name', () => {
    expect(resolveMetaProxyAsset('win32', 'x64')).toMatchObject({
      target: 'x86_64-pc-windows-msvc',
      archive: 'zip',
      assetName: `meta-proxy-${META_PROXY_VERSION}-x86_64-pc-windows-msvc.zip`,
    });
    expect(resolveMetaProxyAsset('darwin', 'arm64').assetName).toContain('aarch64-apple-darwin.tar.gz');
    expect(resolveMetaProxyAsset('linux', 'x64').assetName).toContain('x86_64-unknown-linux-gnu.tar.gz');
    expect(() => resolveMetaProxyAsset('freebsd', 'x64')).toThrow(/No signed Meta-Proxy release/);
  });

  it('only accepts release version values, never arbitrary path-like input', () => {
    expect(isValidReleaseVersion('0.3.0')).toBe(true);
    expect(isValidReleaseVersion('1.2.3-rc.1')).toBe(true);
    expect(isValidReleaseVersion('../0.3.0')).toBe(false);
    expect(isValidReleaseVersion('v0.3.0')).toBe(false);
    expect(isValidReleaseVersion('0.3.0/../../other')).toBe(false);
  });

  it('checks both the named archive checksum and the signature gate', () => {
    const archive = Buffer.from('trusted-release-bytes');
    const asset = 'meta-proxy-0.3.0-x86_64-pc-windows-msvc.zip';
    const sums = Buffer.from(`${sha256Hex(archive)}  ${asset}\n`);

    expect(parseSha256Sums(sums.toString())).toEqual(new Map([[asset, sha256Hex(archive)]]));
    expect(verifyMetaProxyChecksum(archive, asset, sums)).toBe(true);
    expect(verifyMetaProxyChecksum(Buffer.from('tampered'), asset, sums)).toBe(false);
    expect(verifyMetaProxyManifest(sums, 'not-a-valid-ed25519-signature')).toBe(false);
  });

  it('requires explicit consent before a binary download and documents the optional surface', async () => {
    const refused = await metaProxyCmd(['install']);
    expect(refused.code).toBe(2);
    expect(refused.lines.join('\n')).toMatch(/explicit consent/i);

    const help = await metaProxyCmd(['help']);
    expect(help.code).toBe(0);
    expect(help.lines.join('\n')).toMatch(/install.*status.*start.*stop.*login.*logout.*run/i);
  });

  it('passes the local proxy token only to a literal loopback endpoint', () => {
    const home = mkdtempSync(join(tmpdir(), 'metaharness-proxy-env-'));
    const priorState = process.env.RUFLO_STATE_DIR;
    try {
      const state = join(home, '.ruflo');
      mkdirSync(state, { recursive: true });
      process.env.RUFLO_STATE_DIR = state;
      writeFileSync(join(state, 'proxy-token'), 'local-token\n');
      writeFileSync(join(state, 'proxy-config.toml'), 'bind = "127.0.0.1:22435"\n');

      expect(metaProxyEndpoint(home)).toBe('http://127.0.0.1:22435');
      expect(metaProxyClientEnvironment(home)).toEqual({
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:22435',
        ANTHROPIC_AUTH_TOKEN: 'local-token',
      });

      writeFileSync(join(state, 'proxy-config.toml'), 'bind = "0.0.0.0:11435"\n');
      expect(() => metaProxyEndpoint(home)).toThrow(/non-loopback/i);
    } finally {
      if (priorState === undefined) delete process.env.RUFLO_STATE_DIR;
      else process.env.RUFLO_STATE_DIR = priorState;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('mints a scoped, signed worktree policy capability without exposing a path', () => {
    const token = createMetaProxyPolicyToken('local-proxy-secret', 'economy', worktreeFingerprint('C:/tmp/herd/agent-a'), 0);
    const [prefix, encoded, signature] = token.split('.');
    expect(prefix).toBe('mh1');
    expect(signature).toMatch(/^[A-Za-z0-9_-]+$/);
    const claim = JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8'));
    expect(claim).toMatchObject({ policy: 'economy', exp: 28_800 });
    expect(claim.worktree).toMatch(/^[a-f0-9]{32}$/);
    expect(JSON.stringify(claim)).not.toContain('C:/tmp/herd/agent-a');
  });
});
