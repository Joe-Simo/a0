/** Shared errors contain stable codes, never source, key material or host paths. */
export class ProtectionError extends Error {
  constructor(readonly code: string) {
    super(`A0 protection: ${code}`);
  }
}
