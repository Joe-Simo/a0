#include <pthread.h>
#include <stdio.h>
#define A0_IO_INPUT_CAPACITY 17412u
#define A0_IO_OUTPUT_CAPACITY 4194304u
#include "emitter.c"
static a0_io io;
static uint32_t code;
static void *run(void *arg) {
  (void)arg;
  code = a0_emitchunkio(&io);
  return NULL;
}
int main(void) {
  unsigned char b[4];
  uint32_t n = 0;
  while (fread(b, 1, 4, stdin) == 4) {
    if (n == A0_IO_INPUT_CAPACITY) {
      fprintf(stderr, "a0c: input over %u words\n", A0_IO_INPUT_CAPACITY);
      return 64;
    }
    io.input[n++] = (uint32_t)b[0] | (uint32_t)b[1] << 8 | (uint32_t)b[2] << 16 | (uint32_t)b[3] << 24;
  }
  io.ninput = n;
  pthread_attr_t attr;
  pthread_t thread;
  pthread_attr_init(&attr);
  pthread_attr_setstacksize(&attr, (size_t)1073741824u);
  if (pthread_create(&thread, &attr, run, NULL) != 0 || pthread_join(thread, NULL) != 0) {
    fprintf(stderr, "a0c: cannot run the compiler thread\n");
    return 66;
  }
  if (io.noutput >= A0_IO_OUTPUT_CAPACITY) {
    fprintf(stderr, "a0c: output capacity reached\n");
    return 65;
  }
  /* The C bytes, then the trailer words (k bounds, then k) little-endian. */
  uint32_t k = io.noutput > 0 ? io.output[io.noutput - 1] : 0;
  uint32_t c = io.noutput > k ? io.noutput - k - 1 : 0;
  for (uint32_t i = 0; i < io.noutput; i++) {
    uint32_t w = io.output[i];
    putchar((int)(w & 255u));
    if (i >= c) {
      putchar((int)(w >> 8 & 255u));
      putchar((int)(w >> 16 & 255u));
      putchar((int)(w >> 24 & 255u));
    }
  }
  return (int)code;
}
