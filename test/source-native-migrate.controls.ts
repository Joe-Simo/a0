/** Actual A0 migration pipeline; artifacts are explicit and every control must execute. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { compile } from '../src/backends.js';
import { formatProgram, run } from '../src/core.js';
import { formatDense } from '../src/dense.js';
import { link } from '../src/link.js';
import { migrateProject } from '../src/migrate.js';
import { programRevision } from '../src/revision.js';
import { nativeSource } from '../src/source-native.js';
import { linkNativeSource } from '../src/source-native-link.js';
import { migrateNativeSourceProject } from '../src/source-native-migrate.js';
import { TARGETS } from '../src/targets.js';
import { prepareSourceFormat, prepareSourceFrontend } from '../tools/source-native-load.js';

const frontendPath = process.env.A0_MIGRATE_FRONTEND;
const formatPath = process.env.A0_MIGRATE_FORMAT;
assert.ok(frontendPath && formatPath, 'A0_MIGRATE_FRONTEND/FORMAT required');
const prepared = await prepareSourceFrontend(frontendPath);
assert.equal(prepared.build.diagnosticPorts, 'arena-v1');
const module = new WebAssembly.Module(await readFile(join(frontendPath, 'frontend.wasm')));
const formatting = await prepareSourceFormat(formatPath);
const engine = () => nativeSource(module, undefined, formatting);
const read = (path: string): Promise<string> => readFile(path, 'utf8');
const absent = (path: string): Promise<void> =>
  assert.rejects(access(path), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');

async function fixture(root: string): Promise<string> {
  const sources = new Map([
    [
      'main.a0',
      '# project Ω\nprofile strict # profile\nuse "empty.a0" # wrapper\nuse "lib/twice.a0" # import\n# top 😀\nfn top u32 -> u32\nex 3 -> 5 # example\npre lt p0 90 # pre\npost gt r p0 # post\na call twice p0 # node\nret a # return\nend # end\nfn hasflag u32 -> bool\na call choose p0\nret a\nend\n# main tail\n',
    ],
    ['empty.a0', 'profile strict\n# empty wrapper\nuse "lib/inc.a0"\n# empty tail λ\n'],
    [
      'lib/inc.a0',
      'profile strict\n# increment\nfn inc u32 -> u32\nex 0 -> 1\na add p0 1\nret a\nend\nfn flags u32 -> boolx2\na lt p0 10\nb arr a true\nret b\nend\n# helper tail\n',
    ],
    [
      'lib/twice.a0',
      'profile strict\nuse "inc.a0" # shared dependency\nfn twice u32 -> u32\nex 3 -> 5\na call inc p0\nb call inc a\nret b\nend\nfn choose u32 -> bool\na call flags p0\nb get a 0\nret b\nend\n# text function\nfn banner -> u32x6\na text "λ😀"\nret a\nend\n# library tail\n',
    ],
  ]);
  for (const [name, text] of sources) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
  return join(root, 'main.a0');
}

test('native historical import preserves three input spellings, full metadata and every backend', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'a0-native-migrate-'));
  const host = engine();
  try {
    const input = join(scratch, 'input');
    const entry = await fixture(input);
    const before = await link(entry, read, { root: input, includeUnits: true });
    const originals = await Promise.all(
      before.sources.map(async (s) => [s.path, await readFile(s.path)] as const),
    );
    const denseRoot = join(scratch, 'dense');
    const dense = await migrateProject(entry, denseRoot, input);
    const legacyDenseRoot = join(scratch, 'legacy-dense');
    for (const unit of before.units ?? []) {
      const path = join(legacyDenseRoot, relative(input, unit.path));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, formatDense(unit.program, { comments: true, known: unit.known }));
    }
    for (const [name, source, root, legacyDense] of [
      ['canonical', entry, input, false],
      ['dense', join(denseRoot, dense.entry), denseRoot, false],
      ['legacy-dense', join(legacyDenseRoot, 'main.a0'), legacyDenseRoot, true],
    ] as const) {
      const output = join(scratch, `output-${name}`);
      const manifest = await migrateNativeSourceProject(source, output, host, root, legacyDense);
      assert.equal(manifest.entry, 'main.a0');
      assert.equal(manifest.files.length, 4);
      assert.ok(manifest.files.every((file) => file.destination.endsWith('.a0')));
      const after = await linkNativeSource(join(output, manifest.entry), read, host, {
        root: output,
      });
      assert.equal(formatProgram(after.program), formatProgram(before.program));
      assert.equal(programRevision(after.program), manifest.revision);
      const top = after.program.byName.get('top');
      assert.ok(top);
      assert.equal(run(top, [3]), 5);
      for (const target of TARGETS)
        assert.deepEqual(compile(after.program, target), compile(before.program, target), target);
      const repeats = [join(scratch, `repeat-a-${name}`), join(scratch, `repeat-b-${name}`)];
      const manifests = await Promise.all(
        repeats.map((directory) =>
          migrateNativeSourceProject(source, directory, host, root, legacyDense),
        ),
      );
      assert.deepEqual(manifests, [manifest, manifest]);
      for (const directory of repeats)
        for (const file of manifest.files)
          assert.deepEqual(
            await readFile(join(output, file.destination)),
            await readFile(join(directory, file.destination)),
          );
      await assert.rejects(
        migrateNativeSourceProject(source, output, host, root, legacyDense),
        /EEXIST/,
      );
    }
    for (const [path, bytes] of originals) assert.deepEqual(await readFile(path), bytes);
    assert.ok(
      host.parse('fn alive\nret 1\nend\n').ok,
      'migration does not close its borrowed frontend',
    );
  } finally {
    host.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

test('native migration refuses missing capabilities and staged graph resource failure without publishing', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'a0-native-migrate-refusal-'));
  const host = engine();
  const noFormatter = nativeSource(module);
  try {
    const input = join(scratch, 'input');
    const entry = await fixture(input);
    const output = join(scratch, 'no-formatter');
    await assert.rejects(
      migrateNativeSourceProject(entry, output, noFormatter, input),
      /unavailable/,
    );
    await absent(output);
    const activationBounded: ReturnType<typeof nativeSource> = {
      ...host,
      activateProgramForFormat(program) {
        return host.activateProgramForFormat(program, 0);
      },
    };
    const unformatted = join(scratch, 'activation-refused');
    await assert.rejects(
      migrateNativeSourceProject(entry, unformatted, activationBounded, input),
      /status 4|refused: 4/,
    );
    await absent(unformatted);
    const bounded: ReturnType<typeof nativeSource> = {
      ...host,
      checkUnits(units, profile) {
        return host.checkUnits(units, profile, 0);
      },
    };
    const refused = join(scratch, 'graph-refused');
    await assert.rejects(migrateNativeSourceProject(entry, refused, bounded, input), /status 4/);
    await absent(refused);
    assert.ok((await link(entry, read, { root: input })).program.byName.has('top'));
  } finally {
    host.close();
    noFormatter.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

test('native migration retains UTF8, symlink confinement and concurrent source-edit guards', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'a0-native-migrate-guards-'));
  const host = engine();
  try {
    const input = join(scratch, 'input');
    const entry = await fixture(input);
    const good = await readFile(entry);
    await writeFile(entry, Buffer.from([0xff, 0x0a]));
    const invalid = join(scratch, 'invalid-utf8');
    await assert.rejects(migrateNativeSourceProject(entry, invalid, host, input), /valid UTF-8/);
    await absent(invalid);
    await writeFile(entry, good);
    const outsideRoot = join(scratch, 'outside');
    await mkdir(outsideRoot);
    const outside = join(outsideRoot, 'outside.a0');
    await writeFile(outside, 'fn outside u32 -> u32\nret p0\nend\n');
    await symlink(outsideRoot, join(input, 'escape'), 'junction');
    await writeFile(entry, 'use "escape/outside.a0"\nfn f u32 -> u32\nret p0\nend\n');
    const escaped = join(scratch, 'escaped');
    await assert.rejects(
      migrateNativeSourceProject(entry, escaped, host, input),
      /outside|root|escapes/,
    );
    await absent(escaped);
    await writeFile(entry, good);
    let changed = false;
    const concurrent: ReturnType<typeof nativeSource> = {
      ...host,
      format(input, request) {
        const result = host.format(input, request);
        if (!changed) {
          changed = true;
          writeFileSync(entry, Buffer.concat([good, Buffer.from('# concurrent edit\n')]));
        }
        return result;
      },
    };
    const stale = join(scratch, 'stale');
    await assert.rejects(
      migrateNativeSourceProject(entry, stale, concurrent, input),
      /source changed during migration/,
    );
    assert.ok(changed);
    await absent(stale);
    assert.deepEqual(
      await readFile(entry),
      Buffer.concat([good, Buffer.from('# concurrent edit\n')]),
    );
  } finally {
    host.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

test('native migration preserves transitive implicit Dense result types and rejects corrupted metadata or fixed points', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'a0-native-migrate-inference-'));
  const host = engine();
  try {
    const input = join(scratch, 'input');
    await mkdir(input);
    await writeFile(
      join(input, 'dep.a0'),
      '# dep\nfn choose u32 -> bool\na lt p0 10\nret a\nend\nfn pair u32 -> (u32,bool)\na lt p0 10\nb rec p0 a\nret b\nend\n',
    );
    await writeFile(
      join(input, 'middle.a0d'),
      'use "dep.a0"\nfn passbool choose A\nfn passpair pair A\n',
    );
    const entry = join(input, 'main.a0d');
    await writeFile(
      entry,
      '# retained Ω\nuse "middle.a0d"\nfn finalbool passbool A\nfn finalpair passpair A\n',
    );
    const before = await link(entry, read, { root: input });
    const output = join(scratch, 'converted');
    const manifest = await migrateNativeSourceProject(entry, output, host, input);
    assert.equal(manifest.entry, 'main.a0');
    const after = await linkNativeSource(join(output, manifest.entry), read, host, {
      root: output,
    });
    assert.equal(formatProgram(after.program), formatProgram(before.program));
    const boolean = after.program.byName.get('finalbool');
    const pair = after.program.byName.get('finalpair');
    assert.ok(boolean && pair);
    assert.equal(boolean.result, 'bool');
    assert.deepEqual(pair.result, { kind: 'rec', fields: ['u32', 'bool'] });
    assert.equal(run(boolean, [7]), true);
    assert.deepEqual(run(pair, [7]), [7, true]);

    for (const corruption of ['metadata', 'fixed-point'] as const) {
      let prints = 0;
      const corrupted: ReturnType<typeof nativeSource> = {
        ...host,
        format(input, request) {
          const result = host.format(input, request);
          prints++;
          if (!result.ok) return result;
          return {
            ...result,
            text:
              corruption === 'metadata' && prints === 1
                ? result.text.replace('# dep', '# changed')
                : corruption === 'fixed-point' && prints === 2
                  ? `${result.text}\n`
                  : result.text,
          };
        },
      };
      const refused = join(scratch, corruption);
      await assert.rejects(
        migrateNativeSourceProject(entry, refused, corrupted, input),
        corruption === 'metadata' ? /changed source or comments/ : /formatter fixed point/,
      );
      await absent(refused);
    }
  } finally {
    host.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
