#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "arena_runtime.h"
static a0_arena_session *compiler_session;
#define A0_COMPILER_READ(t) ((void)(t), a0_runtime_read(compiler_session))
#define A0_COMPILER_WRITE(t,v) ((void)(t), a0_runtime_write(compiler_session,(v)))
#include "module.c"
#include "api.h"

static void die(const char *what) { fprintf(stderr, "%s\n", what); exit(1); }
static void expect_word(uint32_t want) {
  uint32_t got = a0_runtime_read(compiler_session);
  if (got != want) { fprintf(stderr,"protocol expected %u, got %u\n",want,got); exit(2); }
}
static void send(uint32_t op, const uint32_t *args, uint32_t n) {
  a0_runtime_write(compiler_session,op);
  a0_runtime_write(compiler_session,n);
  for (uint32_t i=0;i<n;i++) a0_runtime_write(compiler_session,args[i]);
}
static unsigned char *file(const char *path, uint32_t *length) {
  FILE *f = fopen(path,"rb"); if (f == NULL) die("cannot open fixture");
  if (fseek(f,0,SEEK_END) != 0) die("seek failed");
  long n = ftell(f); if (n < 0 || (uint64_t)n > UINT32_MAX) die("fixture too large");
  rewind(f); unsigned char *p = malloc((size_t)n+1u); if (p == NULL) die("allocation failed");
  if (fread(p,1,(size_t)n,f) != (size_t)n) die("read failed");
  fclose(f); *length=(uint32_t)n; return p;
}
static uint32_t le32(const unsigned char *p) {
  return (uint32_t)p[0] | (uint32_t)p[1]<<8 | (uint32_t)p[2]<<16 | (uint32_t)p[3]<<24;
}
int main(int argc, char **argv) {
  if (argc != 4) die("source expected-tokens expected-status");
  uint32_t n, expected_bytes;
  unsigned char *source=file(argv[1],&n), *expected=file(argv[2],&expected_bytes);
  if (expected_bytes % 12u != 0) die("invalid token fixture framing");
  const uint32_t expected_words=expected_bytes/4u;
  const uint32_t expected_status=(uint32_t)strtoul(argv[3],NULL,10);
  const uint64_t budget=(uint64_t)n*4u+4u;
  if (budget > UINT32_MAX) die("test budget exceeds runtime indices");
  compiler_session=a0_arena_create((uint32_t)budget,0u);
  if (compiler_session == NULL) die("cannot create session");
  expect_word(0); expect_word(2); expect_word(A0_ARENA_MAGIC); expect_word(A0_ARENA_VERSION);
  const uint32_t source_words=n == 0 ? 1u : n;
  send(A0_ARENA_ALLOC,&source_words,1u);
  expect_word(0); expect_word(1);
  const uint32_t source_handle=a0_runtime_read(compiler_session);
  for (uint32_t i=0;i<n;) {
    const uint32_t count=n-i > 128u ? 128u : n-i;
    uint32_t args[131]={source_handle,i,count};
    for (uint32_t j=0;j<count;j++) args[3+j]=source[i+j];
    send(A0_ARENA_STORE,args,count+3u); expect_word(0); expect_word(0); i+=count;
  }
  a0_io io,before;
  memset(&io,0,sizeof io); memcpy(&before,&io,sizeof io);
  LEX_RESULT (*lex)(a0_io*,uint32_t,uint32_t)=a0_arena_lex;
  const LEX_RESULT result=lex(&io,source_handle,n);
  if (result.f0 != expected_status) { fprintf(stderr,"lexer status expected %u, got %u\n",expected_status,result.f0); return 3; }
  if (result.f3 != &io || memcmp(&before,&io,sizeof io) != 0) die("IO ABI changed");
  if (result.f0 == 0) {
    if (result.f1 == 0 || result.f2 != expected_words/3u) {
      fprintf(stderr,"token count expected %u, got %u\n",expected_words/3u,result.f2); return 4;
    }
    for (uint32_t i=0;i<expected_words;) {
      const uint32_t count=expected_words-i > 128u ? 128u : expected_words-i;
      const uint32_t args[]={result.f1,i,count};
      send(A0_ARENA_LOAD,args,3u); expect_word(0); expect_word(count);
      for (uint32_t j=0;j<count;j++) {
        const uint32_t got=a0_runtime_read(compiler_session), want=le32(expected+4u*(i+j));
        if (got != want) { fprintf(stderr,"token word %u expected %u, got %u\n",i+j,want,got); return 5; }
      }
      i+=count;
    }
  } else if (result.f1 != 0 || result.f2 != 0) die("partial tokens published on failure");
  for (uint32_t i=0;i<n;) {
    const uint32_t count=n-i > 128u ? 128u : n-i;
    const uint32_t args[]={source_handle,i,count};
    send(A0_ARENA_LOAD,args,3u); expect_word(0); expect_word(count);
    for (uint32_t j=0;j<count;j++) if (a0_runtime_read(compiler_session) != source[i+j]) die("source mutated");
    i+=count;
  }
  const uint32_t finish=0;
  send(A0_ARENA_FINISH,&finish,1u); expect_word(0); expect_word(0);
  if (!a0_arena_is_complete(compiler_session) || a0_arena_allocated_words(compiler_session) != 0) die("incomplete invocation");
  a0_arena_destroy(compiler_session); free(source); free(expected);
  return 0;
}
