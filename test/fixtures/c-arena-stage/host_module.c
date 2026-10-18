/* Host-shim controls only: this fake module exercises publication/lifetime,
 * never claims to parse or compile A0. Actual compiler proofs use emitted C. */
typedef struct a0_io a0_io;
static a0_io *a0_arena_c_stage(a0_io *token, uint32_t source, uint32_t length,
    uint32_t input, uint32_t output, uint32_t flags, uint32_t quantum, uint32_t resumes) {
  /* Echo the uploaded binary snapshot so this control catches text-mode input
   * or output conversion too. The fixed host fixture fits one protocol batch. */
  if (length > A0_ARENA_BULK_MAX) return token;
  A0_IO_WRITE(token, A0_ARENA_LOAD);
  A0_IO_WRITE(token, 3);
  A0_IO_WRITE(token, source);
  A0_IO_WRITE(token, 0);
  A0_IO_WRITE(token, length);
  uint32_t status, count, words[A0_ARENA_BULK_MAX];
  (void)A0_IO_READ(token, &status);
  (void)A0_IO_READ(token, &count);
  if (status || count != length) return token;
  for (uint32_t i = 0; i < count; i++) (void)A0_IO_READ(token, words + i);
  A0_IO_WRITE(token, A0_ARENA_EMIT);
  A0_IO_WRITE(token, length + 1);
  A0_IO_WRITE(token, length);
  for (uint32_t i = 0; i < length; i++) A0_IO_WRITE(token, words[i]);
  (void)A0_IO_READ(token, &status);
  (void)A0_IO_READ(token, &count);
  A0_IO_WRITE(token, A0_ARENA_FINISH);
  A0_IO_WRITE(token, 1);
  A0_IO_WRITE(token, status || count ? 1 : 0);
  (void)A0_IO_READ(token, &status);
  (void)A0_IO_READ(token, &count);
  return token;
}
