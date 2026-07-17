/**
 * Optional Meta-Proxy integration for the published `metaharness` CLI.
 *
 * Meta-Proxy is deliberately not an npm dependency: it is a separately released
 * Rust binary. This module downloads its public, signed release only when the
 * user explicitly asks for `metaharness proxy install --yes`, verifies the
 * signed SHA256 manifest with a pinned Ed25519 public key, and then installs it
 * under the user's MetaHarness state directory.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export const META_PROXY_VERSION = '0.3.0';
export const META_PROXY_RELEASE_BASE = 'https://github.com/cognitum-one/meta-proxy-dist/releases/download';

/** The release signing key, pinned in the client rather than fetched from GitHub. */
export const META_PROXY_SIGNING_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAjhLDomjIGdcltYC7j+aiESQFD4LWoHaULietG1PuDjw=
-----END PUBLIC KEY-----
`;

export interface PlatformAsset {
  target: string;
  archive: 'tar.gz' | 'zip';
  assetName: string;
}

const PLATFORM_TABLE: Record<string, { target: string; archive: PlatformAsset['archive'] }> = {
  'darwin-arm64': { target: 'aarch64-apple-darwin', archive: 'tar.gz' },
  'darwin-x64': { target: 'x86_64-apple-darwin', archive: 'tar.gz' },
  'linux-arm64': { target: 'aarch64-unknown-linux-gnu', archive: 'tar.gz' },
  'linux-x64': { target: 'x86_64-unknown-linux-gnu', archive: 'tar.gz' },
  'win32-x64': { target: 'x86_64-pc-windows-msvc', archive: 'zip' },
};

export function resolveMetaProxyAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  version = META_PROXY_VERSION,
): PlatformAsset {
  const entry = PLATFORM_TABLE[`${platform}-${arch}`];
  if (!entry) {
    throw new Error(
      `No signed Meta-Proxy release for ${platform}-${arch}. Supported: ${Object.keys(PLATFORM_TABLE).join(', ')}.`,
    );
  }
  return {
    ...entry,
    assetName: `meta-proxy-${version}-${entry.target}.${entry.archive}`,
  };
}

export function isValidReleaseVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value);
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function parseSha256Sums(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-fA-F]{64})[ \t]+\*?(.+)$/);
    if (match) entries.set(match[2]!.trim(), match[1]!.toLowerCase());
  }
  return entries;
}

export function verifyMetaProxyChecksum(archive: Buffer, assetName: string, sums: Buffer): boolean {
  return parseSha256Sums(sums.toString('utf8')).get(assetName) === sha256Hex(archive);
}

/** Verify the raw SHA256SUMS bytes against the pinned Ed25519 release key. */
export function verifyMetaProxyManifest(sums: Buffer, signatureBase64: string): boolean {
  try {
    const signature = Buffer.from(signatureBase64.trim(), 'base64');
    return signature.length > 0 && verifySignature(null, sums, createPublicKey(META_PROXY_SIGNING_PUBKEY_PEM), signature);
  } catch {
    return false;
  }
}

export function metaProxyDataDir(home = homedir()): string {
  return process.env.METAHARNESS_META_PROXY_DIR?.trim() || join(home, '.metaharness', 'meta-proxy');
}

export function metaProxyBinaryPath(
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string {
  return join(metaProxyDataDir(home), 'bin', platform === 'win32' ? 'meta-proxy.exe' : 'meta-proxy');
}

function pidPath(home = homedir()): string {
  return join(metaProxyDataDir(home), 'meta-proxy.pid');
}

function versionPath(bin: string): string {
  return `${bin}.version`;
}

export interface FetchResponse {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type Fetcher = (url: string) => Promise<FetchResponse>;

export interface InstallMetaProxyOptions {
  version?: string;
  releaseBase?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  home?: string;
  fetcher?: Fetcher;
}

export interface MetaProxyInstallResult {
  ok: boolean;
  message: string;
  binaryPath?: string;
  version?: string;
}

async function fetchBytes(fetcher: Fetcher, url: string): Promise<Buffer | null> {
  try {
    const response = await fetcher(url);
    return response.ok ? Buffer.from(await response.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

/** Download, authenticate, extract, and atomically install a Meta-Proxy release. */
export async function installMetaProxy(options: InstallMetaProxyOptions = {}): Promise<MetaProxyInstallResult> {
  const version = options.version ?? META_PROXY_VERSION;
  if (!isValidReleaseVersion(version)) return { ok: false, message: `Invalid Meta-Proxy version "${version}".` };

  let asset: PlatformAsset;
  try {
    asset = resolveMetaProxyAsset(options.platform, options.arch, version);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  const base = `${(options.releaseBase ?? META_PROXY_RELEASE_BASE).replace(/\/$/, '')}/v${version}`;
  const fetcher = options.fetcher ?? (globalThis.fetch as unknown as Fetcher);
  const [archive, sums, signature] = await Promise.all([
    fetchBytes(fetcher, `${base}/${asset.assetName}`),
    fetchBytes(fetcher, `${base}/SHA256SUMS`),
    fetchBytes(fetcher, `${base}/SHA256SUMS.sig`),
  ]);

  if (!archive || !sums || !signature) {
    return { ok: false, message: `Signed Meta-Proxy v${version} release assets were not available for ${asset.target}.` };
  }
  if (!verifyMetaProxyManifest(sums, signature.toString('utf8'))) {
    return { ok: false, message: 'Meta-Proxy SHA256SUMS signature verification failed; refusing to install.' };
  }
  if (!verifyMetaProxyChecksum(archive, asset.assetName, sums)) {
    return { ok: false, message: `Meta-Proxy checksum verification failed for ${asset.assetName}; refusing to install.` };
  }

  const root = metaProxyDataDir(options.home);
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const work = mkdtempSync(join(root, '.install-'));
  try {
    const archivePath = join(work, asset.assetName);
    writeFileSync(archivePath, archive, { mode: 0o600 });
    extractArchive(archivePath, asset.archive, work);
    const binaryName = (options.platform ?? process.platform) === 'win32' ? 'meta-proxy.exe' : 'meta-proxy';
    const extractedBinary = findFile(work, binaryName);
    if (!extractedBinary) return { ok: false, message: `Verified archive did not contain ${binaryName}.` };

    const destination = metaProxyBinaryPath(options.platform, options.home);
    if (existsSync(destination)) rmSync(destination, { force: true });
    renameSync(extractedBinary, destination);
    if ((options.platform ?? process.platform) !== 'win32') chmodSync(destination, 0o755);
    writeFileSync(versionPath(destination), `${version}\n`, { encoding: 'utf8', mode: 0o600 });
    return { ok: true, message: `Installed verified Meta-Proxy v${version} at ${destination}.`, binaryPath: destination, version };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function extractArchive(archivePath: string, archive: PlatformAsset['archive'], work: string): void {
  const command = archive === 'zip' ? 'tar' : 'tar';
  const args = archive === 'zip'
    ? ['-xf', archivePath, '-C', work]
    : ['-xzf', archivePath, '-C', work];
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not extract the Meta-Proxy archive: ${result.error?.message ?? result.stderr ?? `tar exited ${result.status}`}`);
  }
}

function findFile(dir: string, basename: string): string | null {
  for (const entry of readdirSync(dir)) {
    const candidate = join(dir, entry);
    const stat = statSync(candidate);
    if (stat.isDirectory()) {
      const nested = findFile(candidate, basename);
      if (nested) return nested;
    } else if (entry === basename) {
      return candidate;
    }
  }
  return null;
}

export interface MetaProxyStatus {
  installed: boolean;
  running: boolean;
  binaryPath: string;
  version: string | null;
  pid: number | null;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * A pid file alone is not sufficient authority to terminate a process: operating
 * systems eventually reuse PIDs. Confirm that it is still our exact executable
 * before reporting it as managed or sending a stop signal.
 */
function processMatchesBinary(pid: number, binaryPath: string, platform: NodeJS.Platform): boolean {
  try {
    if (platform === 'linux') {
      const result = spawnSync('readlink', ['-f', `/proc/${pid}/exe`], { encoding: 'utf8', timeout: 2_000 });
      return result.status === 0 && result.stdout.trim() === binaryPath;
    }
    if (platform === 'win32') {
      const command = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -ne $p) { [Console]::Out.Write($p.ExecutablePath) }`;
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 2_000, windowsHide: true });
      return result.status === 0 && result.stdout.trim().toLowerCase() === binaryPath.toLowerCase();
    }
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 2_000 });
    return result.status === 0 && result.stdout.trim().endsWith(basename(binaryPath));
  } catch {
    return false;
  }
}

export function metaProxyStatus(home = homedir(), platform: NodeJS.Platform = process.platform): MetaProxyStatus {
  const binaryPath = metaProxyBinaryPath(platform, home);
  const installed = existsSync(binaryPath);
  let version: string | null = null;
  try { version = readFileSync(versionPath(binaryPath), 'utf8').trim() || null; } catch { /* no sidecar */ }

  let pid: number | null = null;
  try {
    const parsed = Number.parseInt(readFileSync(pidPath(home), 'utf8').trim(), 10);
    if (Number.isSafeInteger(parsed) && parsed > 0 && processExists(parsed) && processMatchesBinary(parsed, binaryPath, platform)) pid = parsed;
  } catch { /* no managed process */ }
  return { installed, running: pid !== null, binaryPath, version, pid };
}

export function startMetaProxy(home = homedir(), platform: NodeJS.Platform = process.platform): MetaProxyInstallResult {
  const status = metaProxyStatus(home, platform);
  if (!status.installed) return { ok: false, message: 'Meta-Proxy is not installed. Run `metaharness proxy install --yes` first.' };
  if (status.running) return { ok: true, message: `Meta-Proxy is already running (pid ${status.pid}).`, binaryPath: status.binaryPath, version: status.version ?? undefined };

  const root = metaProxyDataDir(home);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const log = openSync(join(root, 'meta-proxy.log'), 'a', 0o600);
  try {
    const child = spawn(status.binaryPath, [], { detached: true, stdio: ['ignore', log, log], windowsHide: true });
    if (!child.pid) return { ok: false, message: 'Meta-Proxy did not return a process id.' };
    child.unref();
    writeFileSync(pidPath(home), `${child.pid}\n`, { encoding: 'utf8', mode: 0o600 });
    return { ok: true, message: `Meta-Proxy started (pid ${child.pid}).`, binaryPath: status.binaryPath, version: status.version ?? undefined };
  } finally {
    closeSync(log);
  }
}

export function stopMetaProxy(home = homedir()): MetaProxyInstallResult {
  let pid: number;
  try { pid = Number.parseInt(readFileSync(pidPath(home), 'utf8').trim(), 10); } catch {
    return { ok: true, message: 'Meta-Proxy is not running (no managed pid file).' };
  }
  const status = metaProxyStatus(home);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !status.running || status.pid !== pid) {
    rmSync(pidPath(home), { force: true });
    return { ok: true, message: 'Meta-Proxy is not running under this managed binary (stale pid file removed).' };
  }
  try {
    process.kill(pid, 'SIGTERM');
    rmSync(pidPath(home), { force: true });
    return { ok: true, message: `Meta-Proxy stop requested (pid ${pid}).` };
  } catch (error) {
    return { ok: false, message: `Could not stop Meta-Proxy pid ${pid}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export interface ProxyCommandResult { code: number; lines: string[]; }

/** `metaharness proxy` command surface. OAuth remains inside the Meta-Proxy binary. */
export async function metaProxyCmd(args: string[]): Promise<ProxyCommandResult> {
  const subcommand = args[0] ?? 'help';
  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    return {
      code: 0,
      lines: [
        'Usage: metaharness proxy <install|status|start|stop|path|login|logout> [options]',
        '',
        'Optional signed Meta-Proxy sidecar for local Claude-compatible routing.',
        `  install [--version ${META_PROXY_VERSION}] --yes  download, verify, and install`,
        '  status                                      show installed version and managed process state',
        '  start | stop | path                         manage the optional local sidecar',
        '  login | logout                              run Meta-Proxy Cognitum OAuth login/logout',
      ],
    };
  }
  if (subcommand === 'install') {
    const versionIndex = args.indexOf('--version');
    const version = versionIndex >= 0 ? args[versionIndex + 1] : undefined;
    if (versionIndex >= 0 && !version) return { code: 2, lines: ['--version requires a value, for example 0.3.0.'] };
    if (!args.includes('--yes')) {
      return { code: 2, lines: ['Refusing to download a binary without explicit consent. Re-run: metaharness proxy install --yes'] };
    }
    const result = await installMetaProxy({ version });
    return { code: result.ok ? 0 : 1, lines: [result.message] };
  }
  if (subcommand === 'status') {
    const status = metaProxyStatus();
    return {
      code: status.installed ? 0 : 1,
      lines: [
        'Meta-Proxy',
        `  installed: ${status.installed ? 'yes' : 'no'}`,
        `  binary: ${status.binaryPath}`,
        `  version: ${status.version ?? 'unknown'}`,
        `  managed process: ${status.running ? `running (pid ${status.pid})` : 'not running'}`,
      ],
    };
  }
  if (subcommand === 'path') {
    const status = metaProxyStatus();
    return { code: status.installed ? 0 : 1, lines: status.installed ? [status.binaryPath] : ['Meta-Proxy is not installed. Run `metaharness proxy install --yes`.'] };
  }
  if (subcommand === 'start') {
    const result = startMetaProxy();
    return { code: result.ok ? 0 : 1, lines: [result.message] };
  }
  if (subcommand === 'stop') {
    const result = stopMetaProxy();
    return { code: result.ok ? 0 : 1, lines: [result.message] };
  }
  if (subcommand === 'login' || subcommand === 'logout') {
    const status = metaProxyStatus();
    if (!status.installed) return { code: 1, lines: ['Meta-Proxy is not installed. Run `metaharness proxy install --yes` first.'] };
    const result = spawnSync(status.binaryPath, [subcommand, ...args.slice(1)], { stdio: 'inherit', windowsHide: true });
    if (result.error) return { code: 1, lines: [`Could not run Meta-Proxy ${subcommand}: ${result.error.message}`] };
    return { code: result.status ?? 1, lines: [] };
  }
  return { code: 2, lines: [`Unknown proxy subcommand "${subcommand}". Try: install | status | start | stop | path | login | logout`] };
}
