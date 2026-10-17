#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "arena_runtime.h"
static a0_arena_session *session;
#define A0_COMPILER_READ(t) ((void)(t),a0_runtime_read(session))
#define A0_COMPILER_WRITE(t,v) ((void)(t),a0_runtime_write(session,(v)))
#include "module.c"
#include "api.h"
static void die(const char *s) {fprintf(stderr,"%s\n",s);exit(1);}
static void want(uint32_t x) {if(a0_runtime_read(session)!=x)die("protocol");}
static void request(uint32_t op,uint32_t n,const uint32_t *a) {
 a0_runtime_write(session,op);a0_runtime_write(session,n);
 for(uint32_t i=0;i<n;i++)a0_runtime_write(session,a[i]);
}
static uint32_t decode(const unsigned char *b) {
 return (uint32_t)b[0]|(uint32_t)b[1]<<8|(uint32_t)b[2]<<16|(uint32_t)b[3]<<24;
}
static uint32_t input_word(void) {
 unsigned char b[4];if(fread(b,1,4,stdin)!=4)die("input word");return decode(b);
}
static void output_word(uint32_t x) {
 unsigned char b[]={x,x>>8,x>>16,x>>24};if(fwrite(b,1,4,stdout)!=4)die("output word");
}
static void load(uint32_t h,uint32_t off,uint32_t count,uint32_t *page) {
 uint32_t a[]={h,off,count};request(2,3,a);want(0);want(count);
 for(uint32_t i=0;i<count;i++)page[i]=a0_runtime_read(session);
}
int main(void) {
 unsigned char header[16];
 for(;;) {
  size_t got=fread(header,1,sizeof header,stdin);
  if(!got){if(ferror(stdin))die("input header");break;}
  if(got!=sizeof header)die("partial header");
  uint32_t count=decode(header),length=decode(header+4),extra=decode(header+8),mode=decode(header+12);
  if((uint64_t)count+extra>UINT32_MAX)die("test budget overflow");
  uint32_t *original=malloc(((size_t)count+1)*sizeof *original);if(!original)die("input allocation");
  for(uint32_t i=0;i<count;i++)original[i]=input_word();
  session=a0_arena_create(count+extra,0);if(!session)die("session allocation");
  want(0);want(2);want(A0_ARENA_MAGIC);want(1);
  uint32_t h=0;
  if(count) {
   request(1,1,&count);want(0);want(1);h=a0_runtime_read(session);
   for(uint32_t i=0;i<count;) {
    uint32_t n=count-i>128?128:count-i,a[131]={h,i,n};
    for(uint32_t j=0;j<n;j++)a[j+3]=original[i+j];
    request(3,n+3,a);want(0);want(0);i+=n;
   }
  }
  uint32_t selected=mode?UINT32_MAX:h;
  a0_io io,before;memset(&io,0xa5,sizeof io);memcpy(&before,&io,sizeof io);
  HEX_RESULT r=a0_arena_sha256_hex(&io,selected,length);
  if(r.f2!=&io||memcmp(&before,&io,sizeof io))die("hex IO identity/content");
  if(r.f0&&(r.f1.f0||r.f1.f1||r.f1.f2))die("hex output on refusal");
  HASH_RESULT raw=a0_arena_sha256(&io,selected,length);
  if(raw.f2!=&io||memcmp(&before,&io,sizeof io))die("raw IO identity/content");
  if(raw.f0)for(uint32_t i=0;i<8;i++)if(raw.f1.e[i])die("raw output on refusal");
  output_word(r.f0);output_word(raw.f0);
  for(uint32_t i=0;i<8;i++)output_word(raw.f1.e[i]);
  output_word(r.f1.f1);
  if(r.f1.f1) {
   if(r.f1.f1!=64)die("hex length");
   uint32_t page[128];load(r.f1.f0,0,64,page);
   for(uint32_t i=0;i<64;i++){if(page[i]>255)die("hex byte");if(fputc((int)page[i],stdout)==EOF)die("hex write");}
  }
  for(uint32_t i=0;i<count;) {
   uint32_t n=count-i>128?128:count-i,page[128];load(h,i,n,page);
   for(uint32_t j=0;j<n;j++)if(page[j]!=original[i+j])die("source mutation");i+=n;
  }
  uint32_t code=0;request(5,1,&code);want(0);want(0);
  if(!a0_arena_is_complete(session)||a0_arena_allocated_words(session))die("incomplete session");
  a0_arena_destroy(session);session=NULL;free(original);
 }
 return 0;
}
