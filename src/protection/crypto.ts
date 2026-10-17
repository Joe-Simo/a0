/** Offline, host-independent JWE adapter. Cryptography is provided by jose and WebCrypto. */
import {
  CompactEncrypt,
  CompactSign,
  calculateJwkThumbprint,
  compactDecrypt,
  compactVerify,
  exportJWK,
  generateKeyPair,
  importJWK,
  type JWK,
} from 'jose';

import { ProtectionError } from './errors.js';

export { ProtectionError } from './errors.js';

export const utf8 = new TextEncoder();
export const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export const random = (size = 32): Uint8Array => crypto.getRandomValues(new Uint8Array(size));
export function opaqueId(): string {
  return Array.from(random(24), (b) => b.toString(16).padStart(2, '0')).join('');
}
export async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}

export interface IdentityFile {
  readonly format: 'a0-identity-1';
  readonly id: string;
  readonly publicKey: JWK;
  readonly signingKey: JWK;
  readonly recovery: string;
}

/** All key holders are trusted collaborators. This is not a read-only access-control system. */
export interface Identity {
  readonly id: string;
  readonly publicKey: JWK;
  readonly privateKey: CryptoKey;
  readonly signingKey: JWK;
  readonly signingPrivateKey: CryptoKey;
}

const TYPE = 'a0-seal+jwe';
const PBKDF_ITERATIONS = 600_000;

export async function createIdentity(password: Uint8Array): Promise<IdentityFile> {
  if (password.byteLength < 16) throw new ProtectionError('PASSPHRASE_TOO_SHORT');
  const pair = await generateKeyPair('ECDH-ES+A256KW', { crv: 'P-256', extractable: true });
  const publicKey = await exportJWK(pair.publicKey);
  const privateKey = await exportJWK(pair.privateKey);
  const signing = await generateKeyPair('ES256', { extractable: true });
  const signingKey = await exportJWK(signing.publicKey);
  const signingPrivateKey = await exportJWK(signing.privateKey);
  const id = await calculateJwkThumbprint(publicKey);
  const recovery = await new CompactEncrypt(
    utf8.encode(JSON.stringify({ privateKey, signingPrivateKey })),
  )
    .setProtectedHeader({
      alg: 'PBES2-HS512+A256KW',
      enc: 'A256GCM',
      typ: 'a0-recovery+jwe',
    })
    .setKeyManagementParameters({ p2c: PBKDF_ITERATIONS })
    .encrypt(password);
  return { format: 'a0-identity-1', id, publicKey, signingKey, recovery };
}

export async function unlockIdentity(file: IdentityFile, password: Uint8Array): Promise<Identity> {
  try {
    if (file.format !== 'a0-identity-1') throw new Error();
    const { plaintext, protectedHeader: h } = await compactDecrypt(file.recovery, password, {
      keyManagementAlgorithms: ['PBES2-HS512+A256KW'],
      contentEncryptionAlgorithms: ['A256GCM'],
      maxPBES2Count: PBKDF_ITERATIONS,
    });
    if (h.typ !== 'a0-recovery+jwe' || h.p2c !== PBKDF_ITERATIONS) throw new Error();
    try {
      const { privateKey: jwk, signingPrivateKey: signingJwk } = JSON.parse(
        text.decode(plaintext),
      ) as { privateKey: JWK; signingPrivateKey: JWK };
      if (
        (await calculateJwkThumbprint(jwk)) !== file.id ||
        (await calculateJwkThumbprint(file.publicKey)) !== file.id
      )
        throw new Error();
      if (
        (await calculateJwkThumbprint(signingJwk)) !==
        (await calculateJwkThumbprint(file.signingKey))
      )
        throw new Error();
      const privateKey = await importJWK(jwk, 'ECDH-ES+A256KW', { extractable: false });
      const signingPrivateKey = await importJWK(signingJwk, 'ES256', { extractable: false });
      if (privateKey instanceof Uint8Array) throw new Error();
      if (signingPrivateKey instanceof Uint8Array) throw new Error();
      return {
        id: file.id,
        publicKey: file.publicKey,
        privateKey,
        signingKey: file.signingKey,
        signingPrivateKey,
      };
    } finally {
      plaintext.fill(0);
    }
  } catch {
    throw new ProtectionError('IDENTITY_AUTHENTICATION_FAILED');
  }
}

export async function sign(bytes: Uint8Array, identity: Identity, type: string): Promise<string> {
  return new CompactSign(bytes)
    .setProtectedHeader({ alg: 'ES256', typ: type })
    .sign(identity.signingPrivateKey);
}
export async function verify(signature: string, publicKey: JWK, type: string): Promise<Uint8Array> {
  try {
    const key = await importJWK(publicKey, 'ES256');
    const result = await compactVerify(signature, key, { algorithms: ['ES256'] });
    if (result.protectedHeader.typ !== type) throw new Error();
    return result.payload;
  } catch {
    throw new ProtectionError('SIGNATURE_FAILURE');
  }
}

export interface Binding {
  readonly project: string;
  readonly epoch: string;
  readonly object: string;
}
function header(b: Binding): { typ: string; p: string; g: string; o: string } {
  return { typ: TYPE, p: b.project, g: b.epoch, o: b.object };
}
function matches(h: Record<string, unknown>, b: Binding): boolean {
  return h.typ === TYPE && h.p === b.project && h.g === b.epoch && h.o === b.object;
}

/** A fresh per-object CEK and random IV are generated by JWE, never derived from content. */
export async function encrypt(bytes: Uint8Array, key: Uint8Array, b: Binding): Promise<string> {
  return new CompactEncrypt(bytes)
    .setProtectedHeader({ ...header(b), alg: 'A256KW', enc: 'A256GCM' })
    .encrypt(key);
}
export async function decrypt(cipher: string, key: Uint8Array, b: Binding): Promise<Uint8Array> {
  try {
    const r = await compactDecrypt(cipher, key, {
      keyManagementAlgorithms: ['A256KW'],
      contentEncryptionAlgorithms: ['A256GCM'],
    });
    if (!matches(r.protectedHeader, b)) {
      r.plaintext.fill(0);
      throw new Error();
    }
    return r.plaintext;
  } catch {
    throw new ProtectionError('INTEGRITY_OR_KEY_FAILURE');
  }
}

export async function wrap(key: Uint8Array, recipient: JWK, b: Binding): Promise<string> {
  const publicKey = await importJWK(recipient, 'ECDH-ES+A256KW');
  return new CompactEncrypt(key)
    .setProtectedHeader({ ...header(b), alg: 'ECDH-ES+A256KW', enc: 'A256GCM' })
    .encrypt(publicKey);
}
export async function unwrap(cipher: string, identity: Identity, b: Binding): Promise<Uint8Array> {
  try {
    const r = await compactDecrypt(cipher, identity.privateKey, {
      keyManagementAlgorithms: ['ECDH-ES+A256KW'],
      contentEncryptionAlgorithms: ['A256GCM'],
    });
    if (!matches(r.protectedHeader, b) || r.plaintext.length !== 32) {
      r.plaintext.fill(0);
      throw new Error();
    }
    return r.plaintext;
  } catch {
    throw new ProtectionError('RECIPIENT_NOT_AUTHORIZED');
  }
}
