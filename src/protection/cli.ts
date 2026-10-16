/** Native toolchain controls. No mount, network, external application or background process. */
import { readFileSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { A0Error, checkArgument, LIMITS, run, type Value } from '../core.js';
import { POLICY_FILE, protectionPolicy } from '../protection-policy.js';
import { isTarget } from '../targets.js';
import { compileSealed, linkSealed } from './build.js';
import {
  createIdentity,
  digest,
  type Identity,
  type IdentityFile,
  ProtectionError,
  text,
  unlockIdentity,
  utf8,
} from './crypto.js';
import {
  archiveDisabledStore,
  assertDurableHost,
  atomicWrite,
  DiskVaultStore,
  inventory,
  optionalRead,
  resumeMigration,
  writeNew,
} from './disk.js';
import { importSealedProject } from './store.js';
import { type Consumer, type Disclosure, type Migration, SealedProject } from './vault.js';

const output = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};
function flag(args: readonly string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}
async function secret(args: readonly string[]): Promise<Uint8Array> {
  const fd = flag(args, 'password-fd');
  if (fd !== undefined) {
    if (!/^(?:[3-9]|[1-9][0-9]+)$/.test(fd))
      throw new ProtectionError('PASSWORD_FD_MUST_BE_3_OR_HIGHER');
    const bytes = readFileSync(Number(fd));
    if (bytes.length > 4096) {
      bytes.fill(0);
      throw new ProtectionError('PASSPHRASE_TOO_LONG');
    }
    const end = bytes[bytes.length - 1] === 10 ? bytes.length - 1 : bytes.length;
    const out = Uint8Array.from(bytes.subarray(0, end));
    bytes.fill(0);
    return out;
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new ProtectionError('USE_TTY_OR_PASSWORD_FD');
  process.stderr.write('Passphrase (input hidden): ');
  const input = process.stdin;
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  return new Promise((resolveSecret, reject) => {
    let bytes: number[] = [];
    const finish = (error?: Error): void => {
      input.removeListener('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      process.stderr.write('\n');
      const result = Uint8Array.from(bytes);
      bytes.fill(0);
      bytes = [];
      if (error) {
        result.fill(0);
        reject(error);
      } else resolveSecret(result);
    };
    const onData = (chunk: Buffer): void => {
      for (const b of chunk) {
        if (b === 3 || b === 4) {
          finish(new ProtectionError('CANCELLED'));
          return;
        }
        if (b === 13 || b === 10) {
          finish();
          return;
        }
        if (b === 8 || b === 127) bytes.pop();
        else bytes.push(b);
        if (bytes.length > 4096) {
          finish(new ProtectionError('PASSPHRASE_TOO_LONG'));
          return;
        }
      }
    };
    input.on('data', onData);
  });
}
async function identity(args: readonly string[]): Promise<Identity> {
  const key = flag(args, 'key');
  if (!key) throw new ProtectionError('KEY_FILE_REQUIRED');
  const file = JSON.parse(await readFile(resolve(key), 'utf8')) as IdentityFile;
  const password = await secret(args);
  try {
    return await unlockIdentity(file, password);
  } finally {
    password.fill(0);
  }
}
function authorized(args: readonly string[], hash: string): void {
  if (flag(args, 'approve') !== hash || !args.includes('--confirm-exposure'))
    throw new ProtectionError('REVIEW_PLAN_AND_SUPPLY_APPROVE_HASH_AND_CONFIRM_EXPOSURE');
}
async function offPlan(project: SealedProject): Promise<{ migration: Migration; digest: string }> {
  const items = Object.entries(project.entries())
    .filter(
      ([path, e]) =>
        e.role === 'source' ||
        e.role === 'metadata' ||
        /^\.a0-(cache|index|history|logs|tmp)\//.test(path),
    )
    .map(([path, e]) => ({ path, role: e.role, hash: e.hash }));
  const migration: Migration = { direction: 'off', stage: 'copy', items };
  return {
    migration,
    digest: await digest(
      utf8.encode(JSON.stringify({ revision: project.status.revision, migration })),
    ),
  };
}

/** Editor/terminal adapter protocol. An external AI grant is supplied at owner launch, never by a tool call. */
export async function serveUnlocked(
  project: SealedProject,
  root: string,
  consumer: Consumer,
  approval?: object,
): Promise<void> {
  const access = project.sourceAccess(consumer, approval);
  output({
    ok: true,
    ...project.status,
    consumer,
    warning: 'Unlocked views are plaintext. Copying or logging them exposes source.',
  });
  try {
    for await (const line of sessionLines(process.stdin)) {
      if (line.length > 16 * 1024 * 1024) {
        output({ ok: false, code: 'MESSAGE_TOO_LARGE' });
        break;
      }
      try {
        const request = JSON.parse(line) as {
          op: string;
          path: string;
          source: string;
          target: string;
          allowPlaintextArtifact?: boolean;
          function?: string;
          args?: Value[];
          fuel?: number;
          profile?: 'strict' | 'canonical';
        };
        if (request.op === 'lock') {
          project.lock();
          output({ ok: true, locked: true });
          break;
        }
        if (request.op === 'status') {
          output({ ok: true, ...project.status });
          continue;
        }
        if (request.op === 'read') {
          output({ ok: true, source: await access.read(request.path) });
          continue;
        }
        if (request.op === 'write') {
          if (project.status.phase !== 'on') throw new ProtectionError('MIGRATION_IN_PROGRESS');
          if (typeof request.source !== 'string') throw new ProtectionError('SOURCE_REQUIRED');
          await access.write(request.path, request.source);
          output({ ok: true });
          continue;
        }
        // Build/check may disclose names from dependencies. External agents use scoped reads/edits until a reviewed full-project integration exists.
        if (consumer === 'external-ai') throw new ProtectionError('SCOPED_AI_OPERATION_PENDING');
        if (
          request.profile !== undefined &&
          request.profile !== 'strict' &&
          request.profile !== 'canonical'
        )
          throw new ProtectionError('UNKNOWN_PROFILE');
        if (request.op === 'read-metadata' || request.op === 'write-metadata') {
          if (project.entries()[request.path]?.role !== 'metadata')
            throw new ProtectionError('NOT_METADATA');
          if (request.op === 'write-metadata') {
            if (project.status.phase !== 'on') throw new ProtectionError('MIGRATION_IN_PROGRESS');
            if (typeof request.source !== 'string') throw new ProtectionError('SOURCE_REQUIRED');
            const bytes = utf8.encode(request.source);
            try {
              await project.write(request.path, bytes, 'metadata');
            } finally {
              bytes.fill(0);
            }
            output({ ok: true });
          } else {
            const bytes = await project.read(request.path);
            try {
              output({ ok: true, text: text.decode(bytes) });
            } finally {
              bytes.fill(0);
            }
          }
          continue;
        }
        if (request.op === 'paths') {
          output({
            ok: true,
            paths: Object.entries(project.entries())
              .filter(([, e]) => e.role === 'source')
              .map(([p]) => p),
          });
          continue;
        }
        if (request.op === 'check') {
          const linked = await linkSealed(project, request.path, request.profile);
          output({ ok: true, functions: linked.program.functions.length });
          continue;
        }
        if (request.op === 'run') {
          const linked = await linkSealed(project, request.path, request.profile),
            fn = linked.program.byName.get(request.function ?? '');
          if (!fn || !Array.isArray(request.args) || fn.params.length !== request.args.length)
            throw new ProtectionError('INVALID_RUN_ARGUMENTS');
          const fuel = request.fuel ?? LIMITS.defaultFuel;
          if (!Number.isSafeInteger(fuel) || fuel < 1 || fuel > LIMITS.defaultFuel)
            throw new ProtectionError('FUEL_LIMIT');
          for (const [i, t] of fn.params.entries())
            checkArgument(t, request.args[i] as Value, `p${i}`);
          output({ ok: true, value: run(fn, request.args, { fuel }) });
          continue;
        }
        if (request.op === 'build') {
          if (!isTarget(request.target)) throw new ProtectionError('UNKNOWN_TARGET');
          if (request.target !== 'wasm' && request.allowPlaintextArtifact !== true)
            throw new ProtectionError('PLAINTEXT_ARTIFACT_CONFIRMATION_REQUIRED');
          const bytes = await compileSealed(project, request.path, request.target, {
            projectRoot: root,
            ...(request.profile === undefined ? {} : { profile: request.profile }),
          });
          output({ ok: true, artifact: Buffer.from(bytes).toString('base64') });
          continue;
        }
        if (request.op === 'export') {
          output({ ok: true, sealed: await project.sealedExport() });
          continue;
        }
        throw new ProtectionError('UNKNOWN_OPERATION');
      } catch (e) {
        // No source excerpts, host paths, key material or underlying library errors in managed logs/protocol errors.
        output({
          ok: false,
          code:
            e instanceof ProtectionError
              ? e.code
              : e instanceof A0Error
                ? e.id
                : 'OPERATION_FAILED',
        });
      }
    }
  } finally {
    project.lock();
  }
}
async function* sessionLines(input: AsyncIterable<Buffer>): AsyncGenerator<string> {
  let parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    let start = 0;
    for (let i = 0; i <= chunk.length; i++) {
      if (i !== chunk.length && chunk[i] !== 10) continue;
      const part = chunk.subarray(start, i);
      size += part.length;
      if (size > 16 * 1024 * 1024) throw new ProtectionError('MESSAGE_TOO_LARGE');
      parts.push(part);
      if (i !== chunk.length) {
        yield Buffer.concat(parts, size).toString('utf8');
        parts = [];
        size = 0;
      }
      start = i + 1;
    }
  }
  if (size > 0) yield Buffer.concat(parts, size).toString('utf8');
}

export async function protectionCli(
  command: 'seal' | 'protect',
  args: readonly string[],
): Promise<void> {
  const [action, ...rest] = args;
  if (action === undefined || action === 'help' || args.includes('--help')) {
    output({
      control: command,
      commands:
        command === 'protect'
          ? ['on', 'off', 'status']
          : [
              'on',
              'off',
              'status',
              'keygen',
              'unlock',
              'resume',
              'share',
              'rotate',
              'revoke',
              'export',
              'import',
              'recover-lock',
            ],
      options: [
        '--include=RELATIVE_FILE (repeat for sensitive metadata or additional source)',
        '--plan',
        '--key=FILE',
        '--password-fd=N',
        '--approve=DIGEST',
        '--confirm-exposure',
        '--consumer=local-terminal|local-editor|external-ai',
        '--recipient=ID',
        '--recipient-key=FILE',
        '--trust-project=FINGERPRINT',
        '--acknowledge-old-copies',
        '--out=FILE',
        '--input=FILE',
      ],
      reference: 'docs/PROTECTION.md',
      productionSecurityReview: 'pending',
    });
    return;
  }
  const positional = rest.filter((a) => !a.startsWith('--'));
  const root = await realpath(resolve(positional[0] ?? '.'));
  const include = rest
    .filter((a) => a.startsWith('--include='))
    .map((a) => a.slice('--include='.length));
  const planOn = async () => {
    const plan = await inventory(root, include);
    const key = flag(rest, 'key');
    if (key && plan.items.some((i) => resolve(root, i.path) === resolve(key)))
      throw new ProtectionError('KEEP_IDENTITY_OUTSIDE_MANAGED_SOURCE');
    return plan;
  };
  if (command === 'protect') {
    if (action === 'status') {
      output({
        protect: protectionPolicy(root, true).protect,
        implemented: ['wasm:artifact-hygiene'],
        resistance: 'unmeasured',
      });
      return;
    }
    if (action !== 'on' && action !== 'off') throw new ProtectionError('EXPECTED_ON_OFF_STATUS');
    await atomicWrite(
      resolve(root, POLICY_FILE),
      JSON.stringify({ format: 'a0-protection-1', protect: action === 'on' }),
    );
    output({ protect: action === 'on', affects: 'future builds only', resistance: 'unmeasured' });
    return;
  }
  if (action === 'keygen') {
    const path = flag(rest, 'key');
    if (!path) throw new ProtectionError('KEY_FILE_REQUIRED');
    if ((await optionalRead(resolve(path))) !== undefined)
      throw new ProtectionError('KEY_FILE_EXISTS');
    const password = await secret(rest);
    try {
      const file = await createIdentity(password);
      await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
      await writeNew(resolve(path), JSON.stringify(file));
      output({
        id: file.id,
        publicKey: file.publicKey,
        signingKey: file.signingKey,
        recovery:
          'Back up this encrypted identity separately; no vendor can recover a lost identity and passphrase.',
      });
    } finally {
      password.fill(0);
    }
    return;
  }
  const store = new DiskVaultStore(root);
  const head = await store.head();
  if (action === 'status') {
    const exists = await lstat(store.dir).then(
      () => true,
      (e) => {
        if (e.code === 'ENOENT') return false;
        throw e;
      },
    );
    output({
      seal: exists,
      phase: head?.phase ?? (exists ? 'incomplete' : 'off'),
      lock: 'Sessions are process-local; stored source remains encrypted while a session is unlocked.',
      reviewedForProductionConfidentiality: false,
    });
    return;
  }
  if (action === 'on' && rest.includes('--plan')) {
    const plan = await planOn();
    output({
      action: 'seal on',
      digest: plan.digest,
      files: plan.items.length,
      items: plan.items,
      unmanaged: plan.unmanaged,
      incompleteSourceGraphs: plan.incompleteGraphs,
      exposure:
        'Memory, existing VCS/history, backups, unmanaged tools and build outputs can retain plaintext. Secure deletion is not promised.',
    });
    return;
  }
  const owner = await identity(rest);
  if (!['unlock', 'export'].includes(action)) assertDurableHost();
  if (action === 'recover-lock' && !head) {
    const hash = flag(rest, 'approve-lock');
    if (!hash) throw new ProtectionError('LOCK_HASH_REQUIRED');
    await store.recoverCommitLock(hash);
    output({ ok: true, phase: 'incomplete' });
    return;
  }
  if (action === 'import') {
    const input = flag(rest, 'input');
    if (!input) throw new ProtectionError('INPUT_REQUIRED');
    await store.initialize();
    const project = await importSealedProject(
      store,
      await readFile(input, 'utf8'),
      owner,
      flag(rest, 'trust-project'),
    );
    project.lock();
    output({ ok: true, seal: true });
    return;
  }
  let project: SealedProject;
  if (action === 'on' && !head) {
    const plan = await planOn();
    authorized(rest, plan.digest);
    await store.initialize();
    project = await SealedProject.create(store, owner, {
      direction: 'on',
      stage: 'copy',
      items: plan.items,
    });
  } else project = await SealedProject.unlock(store, owner, flag(rest, 'trust-project'));
  try {
    if (action === 'unlock') {
      if (project.status.phase !== 'on') throw new ProtectionError('MIGRATION_IN_PROGRESS');
      const consumer = flag(rest, 'consumer');
      if (
        consumer !== 'local-terminal' &&
        consumer !== 'local-editor' &&
        consumer !== 'external-ai'
      )
        throw new ProtectionError('DECLARE_CONSUMER');
      let approval: object | undefined;
      if (consumer === 'external-ai') {
        const request: Disclosure = {
          project: project.status.project,
          recipient: flag(rest, 'recipient') ?? '',
          paths: (flag(rest, 'paths') ?? '').split(',').filter(Boolean),
          expires: Date.now() + 900_000,
        };
        const challenge = await digest(
          utf8.encode(
            JSON.stringify({ ...request, expires: undefined, revision: project.status.revision }),
          ),
        );
        if (flag(rest, 'approve-disclosure') !== challenge) {
          output({ disclosurePlan: { ...request, challenge } });
          throw new ProtectionError('OWNER_DISCLOSURE_APPROVAL_REQUIRED');
        }
        approval = await project.approveDisclosure(request, async () => true);
      }
      await serveUnlocked(project, root, consumer, approval);
      return;
    }
    if (action === 'off') {
      const plan = await offPlan(project);
      if (rest.includes('--plan')) {
        output({
          action: 'seal off',
          digest: plan.digest,
          files: plan.migration.items.length,
          items: plan.migration.items,
          exposure:
            'This restores plaintext files. Unmanaged tools and backups may retain copies permanently.',
        });
        return;
      }
      authorized(rest, plan.digest);
      await project.setMigration('unsealing', plan.migration);
      await resumeMigration(project, root);
      await archiveDisabledStore(store);
    } else if (action === 'on') {
      if (project.status.phase === 'off') {
        const plan = await planOn();
        authorized(rest, plan.digest);
        await project.startSealing({ direction: 'on', stage: 'copy', items: plan.items });
      }
      if (project.migration) await resumeMigration(project, root);
    } else if (action === 'resume') {
      if (project.migration) await resumeMigration(project, root);
      if (project.status.phase === 'off') await archiveDisabledStore(store);
    } else if (action === 'rotate' || action === 'revoke') {
      if (!rest.includes('--acknowledge-old-copies'))
        throw new ProtectionError('ACKNOWLEDGE_OLD_COPIES_REQUIRED');
      const revoke = flag(rest, 'recipient');
      if (action === 'revoke' && !revoke) throw new ProtectionError('RECIPIENT_REQUIRED');
      await project.rotate(revoke);
    } else if (action === 'share') {
      const file = flag(rest, 'recipient-key');
      if (!file) throw new ProtectionError('RECIPIENT_KEY_REQUIRED');
      const recipient = JSON.parse(await readFile(file, 'utf8')) as IdentityFile;
      await project.share({
        id: recipient.id,
        publicKey: recipient.publicKey,
        signingKey: recipient.signingKey,
      });
    } else if (action === 'export') {
      const out = flag(rest, 'out');
      if (!out) throw new ProtectionError('OUTPUT_REQUIRED');
      await atomicWrite(resolve(out), await project.sealedExport());
    } else if (action === 'recover-lock') {
      const hash = flag(rest, 'approve-lock');
      if (!hash) throw new ProtectionError('LOCK_HASH_REQUIRED');
      await store.recoverCommitLock(hash);
    } else throw new ProtectionError('UNKNOWN_CONTROL');
    output({ ok: true, ...project.status });
  } finally {
    project.lock();
  }
}
