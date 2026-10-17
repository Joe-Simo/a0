import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnWithInput } from '../../../src/toolchain.js';

export interface TargetDriver {
  readonly file: string;
  readonly className: string;
  readonly source: string;
  readonly extra?: Readonly<Record<string, string>>;
  readonly input?: string;
  readonly expected: string;
  readonly cases: number;
}
export interface SourceCase {
  readonly name: string;
  readonly source?: string;
  readonly mode?: number;
  readonly code: number;
  readonly quantum?: number;
  readonly observation?: number;
  readonly incap?: number;
  readonly outcap?: number;
  readonly maxout?: number;
  readonly fault?: number;
  readonly budget?: number;
  readonly expectedTargetSHA256?: string;
  readonly diagnostic?: number;
  readonly specDiagnostic?: number;
  readonly pending?: boolean;
  readonly targetDriver?: TargetDriver;
  readonly entry?: string;
  readonly root?: string;
  readonly override?: number;
  readonly dense?: boolean;
}
export interface LinkedCase {
  readonly name: string;
  readonly code?: number;
  readonly override?: number;
  readonly files: Readonly<Record<string, string | { type: string; data: readonly number[] }>>;
  readonly targetDriver?: TargetDriver;
}
export interface Plan {
  readonly rows: readonly SourceCase[];
  readonly linkCases: readonly LinkedCase[];
}
export interface NativeResult {
  readonly packetSHA256: string;
  readonly code: number;
  readonly pumps: number;
  readonly snapshots: number;
  readonly e: readonly number[];
  readonly v: readonly number[];
  readonly m: readonly number[];
  readonly l: readonly number[];
  readonly d: readonly number[];
  readonly text: string;
}

/** Generic words and opaque continuation transport; no source or target decisions. */
export function runNative(exe: string, row: SourceCase): NativeResult {
  const source = Buffer.from(row.source ?? ''),
    entry = Buffer.from(row.entry ?? ''),
    root = Buffer.from(row.root ?? '');
  const header = [
    0x414a4156,
    row.mode ?? 0,
    100000000,
    row.maxout ?? 100000000,
    row.quantum ?? 1,
    row.observation ?? 0,
    row.incap ?? 256,
    row.outcap ?? 1024,
    row.fault ?? 0,
    row.budget ?? 0xffffffff,
    source.length,
    entry.length,
    root.length,
    row.override ?? 0,
    row.dense ? 1 : 0,
    100000,
  ];
  const packet = Buffer.alloc((header.length + source.length + entry.length + root.length) * 4);
  let cursor = 0;
  for (const word of header) packet.writeUInt32LE(word >>> 0, cursor++ * 4);
  for (const bytes of [source, entry, root])
    for (const byte of bytes) packet.writeUInt32LE(byte, cursor++ * 4);
  assert.equal(cursor * 4, packet.length);
  const child = spawnWithInput(exe, packet, { maxBuffer: 256000000, timeout: 180000 });
  assert.equal(
    child.status,
    0,
    `${row.name}: ${child.stderr?.toString() || child.error?.stack || 'native failure'}`,
  );
  assert.equal(child.signal, null);
  const data = child.stdout;
  assert.equal(data.length % 4, 0);
  cursor = 0;
  const word = (): number => {
    assert.ok((cursor + 1) * 4 <= data.length, 'truncated native reply');
    return data.readUInt32LE(cursor++ * 4);
  };
  assert.equal(word(), 0x414a4156);
  const code = word(),
    low = word(),
    high = word(),
    snapshots = word(),
    e = Array.from({ length: 128 }, word),
    v = Array.from({ length: 128 }, word),
    m = Array.from({ length: 6 }, word),
    l = Array.from({ length: 128 }, word),
    d = Array.from({ length: 128 }, word),
    length = word(),
    bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    const byte = word();
    assert.ok(byte <= 255);
    bytes[i] = byte;
  }
  assert.equal(cursor * 4, data.length);
  return {
    packetSHA256: createHash('sha256').update(data).digest('hex'),
    code,
    pumps: low + high * 4294967296,
    snapshots,
    e,
    v,
    m,
    l,
    d,
    text: bytes.toString(),
  };
}

export interface JavaTools {
  readonly java: string;
  readonly compiler: string;
  readonly compilerPrefix: readonly string[];
}

/** Compile only native-emitted Java plus a fixed independent test driver. */
export async function runJava(
  tools: JavaTools,
  dir: string,
  text: string,
  driver: TargetDriver,
  expectPass = true,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'A0Module.java'), text);
  await writeFile(join(dir, driver.file), driver.source);
  for (const [file, source] of Object.entries(driver.extra ?? {}))
    await writeFile(join(dir, file), source);
  const built = spawnSync(
    tools.compiler,
    [
      ...tools.compilerPrefix,
      '-Xlint:all',
      '-Werror',
      '-d',
      dir,
      'A0Module.java',
      driver.file,
      ...Object.keys(driver.extra ?? {}),
    ],
    { cwd: dir, encoding: 'utf8', timeout: 120000, maxBuffer: 16 << 20 },
  );
  assert.equal(built.error, undefined);
  assert.equal(built.status, 0, built.stderr);
  const input = join(dir, 'driver-input.txt');
  writeFileSync(input, driver.input ?? '');
  const fd = openSync(input, 'r');
  try {
    const ran = spawnSync(tools.java, ['-cp', dir, driver.className], {
      cwd: dir,
      stdio: [fd, 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 16 << 20,
    });
    assert.equal(ran.error, undefined);
    if (expectPass) {
      assert.equal(ran.status, 0, ran.stderr);
      assert.equal(ran.stdout, driver.expected);
    } else {
      assert.notEqual(ran.status, 0);
      assert.match(ran.stderr, /AssertionError/);
    }
  } finally {
    closeSync(fd);
  }
}
