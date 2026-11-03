#include <stdio.h>
#include <stdlib.h>
#include "source_utf8.h"
int main(void) {
  char line[1024];
  while (fgets(line, sizeof line, stdin) != NULL) {
    unsigned char bytes[128];
    size_t n = 0;
    char *p = line;
    while (*p == ' ') p++;
    while (*p != '\n' && *p != '\0') {
      char *end;
      unsigned long value = strtoul(p, &end, 16);
      if (end == p || value > 255 || n == sizeof bytes) return 2;
      bytes[n++] = (unsigned char)value;
      p = end;
      while (*p == ' ') p++;
    }
    printf("%d\n", a0_source_utf8_valid(bytes, n) ? 1 : 0);
  }
  return ferror(stdin) ? 3 : 0;
}
