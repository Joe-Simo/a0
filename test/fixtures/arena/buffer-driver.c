#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "module.c"
int main(void) {
  if (a0_read_word(7u) != 7u) return 5;
  a0_io io;
  memset(&io, 0, sizeof io);
  io.input[0] = 42u;
  io.ninput = 1u;
  io.noutput = A0_IO_OUTPUT_CAPACITY - 1u;
  if (a0_buffer_probe(&io) != 42u) return 1;
  if (io.position != 1u) return 2;
  if (io.noutput != A0_IO_OUTPUT_CAPACITY) return 3;
  if (io.output[A0_IO_OUTPUT_CAPACITY - 1u] != 43u) return 4;
  puts("buffered defaults unchanged");
  return 0;
}
