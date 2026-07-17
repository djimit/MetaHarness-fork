// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import {
  META_PROXY_VERSION,
  isValidReleaseVersion,
  metaProxyCmd,
  parseSha256Sums,
  resolveMetaProxyAsset,
  sha256Hex,
  verifyMetaProxyChecksum,
  verifyMetaProxyManifest,
} from '../src/meta-proxy.js';

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
    expect(help.lines.join('\n')).toMatch(/install.*status.*start.*stop.*login.*logout/i);
  });
});
