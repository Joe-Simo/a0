/** Portable encrypted object store. No filesystem, network, model, driver or daemon dependency. */
import { calculateJwkThumbprint, type JWK } from 'jose';
import {
  decrypt,
  digest,
  encrypt,
  type Identity,
  opaqueId,
  ProtectionError,
  random,
  sign,
  text,
  unwrap,
  utf8,
  verify,
  wrap,
} from './crypto.js';

export type Phase = 'sealing' | 'on' | 'unsealing' | 'off';
export type Role =
  | 'source'
  | 'metadata'
  | 'cache'
  | 'index'
  | 'history'
  | 'log'
  | 'temporary'
  | 'private-debug';
export interface Entry {
  readonly object: string;
  readonly hash: string;
  readonly role: Role;
}
export interface Migration {
  readonly direction: 'on' | 'off';
  readonly stage: 'copy' | 'delete';
  readonly items: readonly { readonly path: string; readonly role: Role; readonly hash: string }[];
}
interface Manifest {
  readonly format: 'a0-manifest-1';
  readonly revision: string;
  readonly phase: Phase;
  readonly entries: Readonly<Record<string, Entry>>;
  readonly recipients: readonly Recipient[];
  readonly migration: Migration | null;
}
export interface Recipient {
  readonly id: string;
  readonly publicKey: JWK;
  readonly signingKey: JWK;
}
interface Certificate {
  readonly project: string;
  readonly epoch: string;
  readonly keyHash: string;
  readonly recipients: readonly Recipient[];
}
interface SignedManifest {
  readonly authority: { readonly owner: JWK; readonly nonce: string };
  readonly data: Manifest;
  readonly certificate: string;
  readonly signature: string;
}
export interface Head {
  readonly format: 'a0-vault-1';
  readonly project: string;
  readonly epoch: string;
  readonly revision: string;
  readonly manifest: string;
  readonly grants: readonly string[];
  readonly phase: Phase;
}
/** CAS and immutable puts MUST be durable and atomic. Integrity errors MUST NOT become misses. */
export interface VaultStore {
  head(): Promise<Head | undefined>;
  get(id: string): Promise<string>;
  put(id: string, cipher: string): Promise<void>;
  commit(expectedRevision: string | undefined, head: Head): Promise<void>;
}
export type Consumer = 'compiler' | 'local-editor' | 'local-terminal' | 'external-ai';
export interface Disclosure {
  readonly project: string;
  readonly recipient: string;
  readonly paths: readonly string[];
  readonly expires: number;
}
export interface SourceAccess {
  read(path: string): Promise<string>;
  write(path: string, source: string): Promise<void>;
}
export function safePath(path: string): string {
  if (
    path.length === 0 ||
    path.includes('\\') ||
    path.startsWith('/') ||
    path.includes(':') ||
    path
      .split('/')
      .some(
        (x) =>
          x === '' || x === '.' || x === '..' || Array.from(x).some((c) => c.charCodeAt(0) < 32),
      ) ||
    path === '__proto__' ||
    path === 'constructor' ||
    path === 'prototype'
  ) {
    throw new ProtectionError('UNSAFE_PATH');
  }
  return path;
}

export class SealedProject {
  #key: Uint8Array;
  #head: Head;
  #manifest: Manifest;
  #locked = false;
  #serial: Promise<unknown> = Promise.resolve();
  #approvals = new WeakMap<object, Disclosure>();
  private constructor(
    readonly store: VaultStore,
    key: Uint8Array,
    head: Head,
    manifest: Manifest,
    private readonly identity: Identity,
    private certificate: string,
    private readonly authority: SignedManifest['authority'],
  ) {
    this.#key = key;
    this.#head = head;
    this.#manifest = manifest;
  }
  static async create(
    store: VaultStore,
    owner: Identity,
    migration: Migration | null = null,
  ): Promise<SealedProject> {
    if ((await store.head()) !== undefined) throw new ProtectionError('ALREADY_EXISTS');
    const key = random();
    const nonce = opaqueId();
    const projectId = await digest(
      utf8.encode(`${await calculateJwkThumbprint(owner.signingKey)}/${nonce}`),
    );
    const head: Head = {
      format: 'a0-vault-1',
      project: projectId,
      epoch: opaqueId(),
      revision: opaqueId(),
      manifest: opaqueId(),
      grants: [],
      phase: migration ? 'sealing' : 'on',
    };
    const grants = [await wrap(key, owner.publicKey, { ...head, object: 'grant' })];
    const manifest: Manifest = {
      format: 'a0-manifest-1',
      revision: head.revision,
      phase: head.phase,
      entries: {},
      recipients: [{ id: owner.id, publicKey: owner.publicKey, signingKey: owner.signingKey }],
      migration,
    };
    const certificate = await sign(
      utf8.encode(
        JSON.stringify({
          project: projectId,
          epoch: head.epoch,
          keyHash: await digest(key),
          recipients: manifest.recipients,
        } satisfies Certificate),
      ),
      owner,
      'a0-authority+jws',
    );
    const project = new SealedProject(
      store,
      key,
      { ...head, grants },
      manifest,
      owner,
      certificate,
      { owner: owner.signingKey, nonce },
    );
    try {
      await project.#persist(undefined);
      return project;
    } catch (e) {
      project.lock();
      throw e;
    }
  }
  static async unlock(
    store: VaultStore,
    identity: Identity,
    trustedProject?: string,
  ): Promise<SealedProject> {
    const head = await store.head();
    if (head?.format !== 'a0-vault-1' || !Array.isArray(head.grants) || head.grants.length > 256)
      throw new ProtectionError('INVALID_HEAD');
    for (const grant of head.grants) {
      let key: Uint8Array;
      try {
        key = await unwrap(grant, identity, { ...head, object: 'grant' });
      } catch {
        continue;
      }
      try {
        const bytes = await decrypt(await store.get(head.manifest), key, {
          ...head,
          object: head.manifest,
        });
        let signed: SignedManifest;
        try {
          signed = JSON.parse(text.decode(bytes)) as SignedManifest;
        } finally {
          bytes.fill(0);
        }
        const manifest = signed.data;
        const owner = await calculateJwkThumbprint(signed.authority.owner);
        if (head.project !== (await digest(utf8.encode(`${owner}/${signed.authority.nonce}`))))
          throw new ProtectionError('INVALID_PROJECT');
        if (trustedProject !== undefined && trustedProject !== head.project)
          throw new ProtectionError('PROJECT_FINGERPRINT_MISMATCH');
        if (
          trustedProject === undefined &&
          owner !== (await calculateJwkThumbprint(identity.signingKey))
        )
          throw new ProtectionError('TRUSTED_PROJECT_FINGERPRINT_REQUIRED');
        const certificate = JSON.parse(
          text.decode(await verify(signed.certificate, signed.authority.owner, 'a0-authority+jws')),
        ) as Certificate;
        if (
          certificate.project !== head.project ||
          certificate.epoch !== head.epoch ||
          certificate.keyHash !== (await digest(key)) ||
          JSON.stringify(certificate.recipients) !== JSON.stringify(manifest.recipients)
        )
          throw new ProtectionError('INVALID_AUTHORIZATION');
        const expected = JSON.stringify({
          head,
          manifest: await digest(utf8.encode(JSON.stringify(manifest))),
          certificate: await digest(utf8.encode(signed.certificate)),
        });
        let validSignature = false;
        for (const r of certificate.recipients) {
          try {
            if (
              text.decode(await verify(signed.signature, r.signingKey, 'a0-head+jws')) === expected
            )
              validSignature = true;
          } catch {
            /* A different authorized writer is expected. */
          }
        }
        if (!validSignature) throw new ProtectionError('SIGNATURE_FAILURE');
        if (
          manifest.format !== 'a0-manifest-1' ||
          manifest.revision !== head.revision ||
          manifest.phase !== head.phase ||
          !manifest.entries ||
          !Array.isArray(manifest.recipients) ||
          !manifest.recipients.some((r) => r.id === identity.id)
        )
          throw new ProtectionError('INVALID_MANIFEST');
        for (const p of Object.keys(manifest.entries)) safePath(p);
        return new SealedProject(
          store,
          key,
          head,
          manifest,
          identity,
          signed.certificate,
          signed.authority,
        );
      } catch (e) {
        key.fill(0);
        throw e;
      }
    }
    throw new ProtectionError('RECIPIENT_NOT_AUTHORIZED');
  }
  get status(): {
    sealed: boolean;
    locked: boolean;
    phase: Phase;
    revision: string;
    project: string;
  } {
    return {
      sealed: this.#head.phase !== 'off',
      locked: this.#locked,
      phase: this.#head.phase,
      revision: this.#head.revision,
      project: this.#head.project,
    };
  }
  get migration(): Migration | null {
    this.#assert();
    return this.#manifest.migration;
  }
  entries(): Readonly<Record<string, Entry>> {
    this.#assert();
    return structuredClone(this.#manifest.entries);
  }
  has(path: string): boolean {
    this.#assert();
    return Object.hasOwn(this.#manifest.entries, safePath(path));
  }
  lock(): void {
    this.#locked = true;
    this.#key.fill(0);
    this.#approvals = new WeakMap();
  }
  #assert(): void {
    if (this.#locked) throw new ProtectionError('LOCKED');
  }
  async #queue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#serial.then(async () => {
      this.#assert();
      return fn();
    });
    this.#serial = result.catch(() => undefined);
    return result;
  }
  async #persist(expected: string | undefined): Promise<void> {
    const h = this.#head;
    const signature = await sign(
      utf8.encode(
        JSON.stringify({
          head: h,
          manifest: await digest(utf8.encode(JSON.stringify(this.#manifest))),
          certificate: await digest(utf8.encode(this.certificate)),
        }),
      ),
      this.identity,
      'a0-head+jws',
    );
    const cipher = await encrypt(
      utf8.encode(
        JSON.stringify({
          data: this.#manifest,
          certificate: this.certificate,
          signature,
          authority: this.authority,
        } satisfies SignedManifest),
      ),
      this.#key,
      { ...h, object: h.manifest },
    );
    this.#assert();
    await this.store.put(h.manifest, cipher);
    this.#assert();
    await this.store.commit(expected, h);
  }
  /** A failed commit invalidates the session: reopen and authenticate the durable head. */
  async #change(manifest: Manifest, extra: Partial<Head> = {}): Promise<void> {
    const expected = this.#head.revision;
    const revision = opaqueId();
    this.#head = { ...this.#head, ...extra, revision, manifest: opaqueId(), phase: manifest.phase };
    this.#manifest = { ...manifest, revision };
    try {
      await this.#persist(expected);
    } catch (e) {
      this.lock();
      throw e;
    }
  }
  async read(path: string): Promise<Uint8Array> {
    this.#assert();
    safePath(path);
    const e = this.#manifest.entries[path];
    if (!e) throw new ProtectionError('NOT_FOUND');
    const bytes = await decrypt(await this.store.get(e.object), this.#key, {
      ...this.#head,
      object: e.object,
    });
    try {
      this.#assert();
      if ((await digest(bytes)) !== e.hash) throw new ProtectionError('INTEGRITY_OR_KEY_FAILURE');
      return bytes;
    } catch (error) {
      bytes.fill(0);
      throw error;
    }
  }
  async write(path: string, bytes: Uint8Array, role: Role = 'source'): Promise<void> {
    return this.writeBatch([{ path, bytes, role }]);
  }
  async writeBatch(
    changes: readonly { readonly path: string; readonly bytes: Uint8Array; readonly role: Role }[],
  ): Promise<void> {
    const paths = new Set<string>();
    for (const item of changes) {
      safePath(item.path);
      if (paths.has(item.path)) throw new ProtectionError('DUPLICATE_CHANGE');
      paths.add(item.path);
    }
    return this.#queue(async () => {
      const entries = { ...this.#manifest.entries };
      let changed = false;
      for (let i = 0; i < changes.length; i += 16) {
        await Promise.all(
          changes.slice(i, i + 16).map(async ({ path, bytes, role }) => {
            const hash = await digest(bytes);
            const old = entries[path];
            if (old?.hash === hash && old.role === role) return;
            const object = opaqueId();
            const cipher = await encrypt(bytes, this.#key, { ...this.#head, object });
            this.#assert();
            await this.store.put(object, cipher);
            entries[path] = { object, hash, role };
            changed = true;
          }),
        );
      }
      if (!changed) return;
      await this.#change({
        ...this.#manifest,
        entries,
      });
    });
  }
  async setMigration(phase: Phase, migration: Migration | null): Promise<void> {
    return this.#queue(async () => {
      await this.#requireOwner();
      await this.#change({ ...this.#manifest, phase, migration });
    });
  }
  async startSealing(migration: Migration): Promise<void> {
    return this.#queue(async () => {
      await this.#requireOwner();
      if (this.#manifest.phase !== 'off' || migration.direction !== 'on')
        throw new ProtectionError('INVALID_TRANSITION');
      await this.#change({ ...this.#manifest, entries: {}, phase: 'sealing', migration });
    });
  }
  async #authorize(
    recipients: readonly Recipient[],
    key: Uint8Array,
    epoch: string,
  ): Promise<string> {
    await this.#requireOwner();
    return sign(
      utf8.encode(
        JSON.stringify({
          project: this.#head.project,
          epoch,
          keyHash: await digest(key),
          recipients,
        } satisfies Certificate),
      ),
      this.identity,
      'a0-authority+jws',
    );
  }
  async #requireOwner(): Promise<void> {
    if (
      (await calculateJwkThumbprint(this.identity.signingKey)) !==
      (await calculateJwkThumbprint(this.authority.owner))
    )
      throw new ProtectionError('PROJECT_OWNER_REQUIRED');
  }
  async share(recipient: Recipient): Promise<void> {
    return this.#queue(async () => {
      const id = await calculateJwkThumbprint(recipient.publicKey);
      if (recipient.id !== id || recipient.publicKey.d || recipient.signingKey.d)
        throw new ProtectionError('INVALID_RECIPIENT');
      if (this.#manifest.recipients.some((r) => r.id === id)) return;
      if (this.#manifest.recipients.length >= 256) throw new ProtectionError('RECIPIENT_LIMIT');
      const recipients = [...this.#manifest.recipients, recipient];
      const certificate = await this.#authorize(recipients, this.#key, this.#head.epoch);
      const grant = await wrap(this.#key, recipient.publicKey, { ...this.#head, object: 'grant' });
      this.certificate = certificate;
      await this.#change(
        { ...this.#manifest, recipients },
        { grants: [...this.#head.grants, grant] },
      );
    });
  }
  /** Revocation re-encrypts the active version under a fresh project key; old copies remain readable. */
  async rotate(revoke?: string): Promise<void> {
    return this.#queue(async () => {
      if (this.#manifest.migration) throw new ProtectionError('MIGRATION_IN_PROGRESS');
      if (revoke !== undefined && !this.#manifest.recipients.some((r) => r.id === revoke))
        throw new ProtectionError('RECIPIENT_NOT_FOUND');
      const recipients: Recipient[] = [];
      for (const r of this.#manifest.recipients) if (r.id !== revoke) recipients.push(r);
      if (recipients.length === 0) throw new ProtectionError('LAST_RECIPIENT');
      if (!recipients.some((r) => r.id === this.identity.id))
        throw new ProtectionError('OWNER_CANNOT_REVOKE_SELF');
      const key = random();
      const epoch = opaqueId();
      const entries: Record<string, Entry> = {};
      try {
        const certificate = await this.#authorize(recipients, key, epoch);
        for (const [path, e] of Object.entries(this.#manifest.entries)) {
          const bytes = await this.read(path);
          try {
            const object = opaqueId();
            await this.store.put(
              object,
              await encrypt(bytes, key, { ...this.#head, epoch, object }),
            );
            entries[path] = { ...e, object };
          } finally {
            bytes.fill(0);
          }
        }
        const grants = await Promise.all(
          recipients.map((r) => wrap(key, r.publicKey, { ...this.#head, epoch, object: 'grant' })),
        );
        this.#assert();
        this.#key.fill(0);
        this.#key = key;
        this.certificate = certificate;
        await this.#change({ ...this.#manifest, entries, recipients }, { epoch, grants });
      } catch (e) {
        key.fill(0);
        this.lock();
        throw e;
      }
    });
  }
  async approveDisclosure(
    request: Disclosure,
    approve: (request: Disclosure) => Promise<boolean>,
  ): Promise<object> {
    this.#assert();
    const approved = structuredClone(request);
    if (
      approved.project !== this.#head.project ||
      !Number.isSafeInteger(approved.expires) ||
      approved.recipient.length === 0 ||
      approved.expires <= Date.now() ||
      approved.expires > Date.now() + 3_600_000 ||
      !(await approve(structuredClone(approved))) ||
      approved.expires <= Date.now()
    )
      throw new ProtectionError('DISCLOSURE_NOT_APPROVED');
    for (const p of approved.paths) safePath(p);
    this.#assert();
    const token = Object.freeze({});
    this.#approvals.set(token, approved);
    return token;
  }
  revokeDisclosure(approval: object): void {
    this.#assert();
    this.#approvals.delete(approval);
  }
  sourceAccess(consumer: Consumer, approval?: object): SourceAccess {
    const allow = (path: string): void => {
      this.#assert();
      if (
        !/\.a0d?$/.test(path) ||
        (this.#manifest.entries[path] && this.#manifest.entries[path]?.role !== 'source')
      )
        throw new ProtectionError('NOT_SOURCE');
      if (consumer !== 'external-ai') return;
      const request = approval && this.#approvals.get(approval);
      if (!request || request.expires <= Date.now() || !request.paths.includes(path))
        throw new ProtectionError('DISCLOSURE_NOT_APPROVED');
    };
    return {
      read: async (path) => {
        allow(path);
        const bytes = await this.read(path);
        try {
          allow(path);
          return text.decode(bytes);
        } finally {
          bytes.fill(0);
        }
      },
      write: async (path, source) => {
        allow(path);
        const bytes = utf8.encode(source);
        try {
          await this.write(path, bytes);
        } finally {
          bytes.fill(0);
        }
      },
    };
  }
  /** Export contains only encrypted objects and the public head; no project or private keys. */
  async sealedExport(): Promise<string> {
    return this.#queue(async () => {
      const head = this.#head;
      const objects: Record<string, string> = {};
      for (const id of [
        head.manifest,
        ...Object.values(this.#manifest.entries).map((e) => e.object),
      ])
        objects[id] = await this.store.get(id);
      const snapshot: VaultStore = {
        head: async () => head,
        get: async (id) => {
          const value = objects[id];
          if (!value) throw new ProtectionError('MISSING_OBJECT');
          return value;
        },
        put: async () => {
          throw new ProtectionError('READ_ONLY');
        },
        commit: async () => {
          throw new ProtectionError('READ_ONLY');
        },
      };
      const verify = await SealedProject.unlock(snapshot, this.identity, head.project);
      try {
        for (const path of Object.keys(verify.entries())) (await verify.read(path)).fill(0);
      } finally {
        verify.lock();
      }
      this.#assert();
      return JSON.stringify({ format: 'a0-sealed-export-1', head, objects });
    });
  }
}
