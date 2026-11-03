#ifndef A0_SOURCE_UTF8_H
#define A0_SOURCE_UTF8_H
#include <stdbool.h>
#include <stddef.h>

/* UTF-8 scalar encodings only: no overlong forms, surrogates, or values above U+10FFFF. */
static bool a0_source_utf8_valid(const unsigned char *s, size_t n) {
  size_t i = 0;
  while (i < n) {
    unsigned char c = s[i++];
    if (c < 0x80) continue;
    if (c >= 0xc2 && c <= 0xdf) {
      if (n - i < 1 || s[i] < 0x80 || s[i] > 0xbf) return false;
      i++;
    } else if (c >= 0xe0 && c <= 0xef) {
      if (n - i < 2) return false;
      unsigned char d = s[i];
      if (d < 0x80 || d > 0xbf || (c == 0xe0 && d < 0xa0) ||
          (c == 0xed && d > 0x9f) || s[i + 1] < 0x80 || s[i + 1] > 0xbf) return false;
      i += 2;
    } else if (c >= 0xf0 && c <= 0xf4) {
      if (n - i < 3) return false;
      unsigned char d = s[i];
      if (d < 0x80 || d > 0xbf || (c == 0xf0 && d < 0x90) ||
          (c == 0xf4 && d > 0x8f) || s[i + 1] < 0x80 || s[i + 1] > 0xbf ||
          s[i + 2] < 0x80 || s[i + 2] > 0xbf) return false;
      i += 3;
    } else return false;
  }
  return true;
}
#endif
