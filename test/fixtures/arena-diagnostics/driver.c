#include "structured.c"

static void load(uint32_t handle, uint32_t start, uint32_t count, uint32_t *page) {
  const uint32_t args[] = {handle, start, count};
  send(2, 3, args);
  want(0);
  want(count);
  for (uint32_t i = 0; i < count; i++) page[i] = a0_runtime_read(session);
}

/* Host responsibilities are source upload, word transport and session checks. */
int main(int argc, char **argv) {
  if (argc == 4) return structured_main(argc, argv);
  if (argc != 5) die("source output budget options");
  FILE *file = fopen(argv[1], "rb");
  if (!file) die("open source");
  if (fseek(file, 0, SEEK_END) != 0) die("seek source");
  long size = ftell(file);
  if (size < 0 || (uint64_t)size > UINT32_MAX) die("source size");
  rewind(file);
  uint32_t length = (uint32_t)size;
  unsigned char *bytes = malloc((size_t)length + 1);
  if (!bytes) die("allocate source");
  if (fread(bytes, 1, length, file) != length) die("read source");
  if (fclose(file) != 0) die("close source");

  session = a0_arena_create((uint32_t)strtoul(argv[3], NULL, 10), 0);
  if (!session) die("create session");
  want(0);
  want(2);
  want(A0_ARENA_MAGIC);
  want(1);
  uint32_t handle = 0;
  if (length != 0) {
    send(1, 1, &length);
    want(0);
    want(1);
    handle = a0_runtime_read(session);
    for (uint32_t i = 0; i < length;) {
      uint32_t count = length - i > 128 ? 128 : length - i;
      uint32_t args[131] = {handle, i, count};
      for (uint32_t j = 0; j < count; j++) args[j + 3] = bytes[i + j];
      send(3, count + 3, args);
      want(0);
      want(0);
      i += count;
    }
  }

  a0_io io, before;
  memset(&io, 0xa5, sizeof io);
  memcpy(&before, &io, sizeof io);
  DIAG_RESULT result = a0_arena_parse_diagnostic_options(&io, handle, length, (uint32_t)strtoul(argv[4], NULL, 10));
  if (result.f3 != &io || memcmp(&io, &before, sizeof io) != 0)
    die("IO identity/content changed");
  if (result.f0 != 0 && (result.f1.f0 || result.f1.f1 || result.f1.f2))
    die("nonempty output view after refusal");
  file = fopen(argv[2], "wb");
  if (!file) die("open output");
  out(file, result.f0);
  for (uint32_t i = 0; i < 128; i++) out(file, result.f2.e[i]);
  out(file, result.f1.f1);
  for (uint32_t i = 0; i < result.f1.f1;) {
    uint32_t count = result.f1.f1 - i > 128 ? 128 : result.f1.f1 - i;
    uint32_t page[128];
    load(result.f1.f0, i, count, page);
    for (uint32_t j = 0; j < count; j++) out(file, page[j]);
    i += count;
  }
  if (fclose(file) != 0) die("close output");

  for (uint32_t i = 0; i < length;) {
    uint32_t count = length - i > 128 ? 128 : length - i;
    uint32_t page[128];
    load(handle, i, count, page);
    for (uint32_t j = 0; j < count; j++)
      if (page[j] != bytes[i + j]) die("source mutated");
    i += count;
  }
  uint32_t code = 0;
  send(5, 1, &code);
  want(0);
  want(0);
  if (!a0_arena_is_complete(session) || a0_arena_allocated_words(session))
    die("incomplete session");
  a0_arena_destroy(session);
  free(bytes);
  return 0;
}
