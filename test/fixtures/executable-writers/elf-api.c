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
static uint32_t load_byte(a0_io *io,VECTOR_TYPE v,uint32_t offset){LOAD_RESULT r=a0_av_load(io,v,offset,1);if(r.f0)abort();return r.f1.e[0];}
static uint64_t load64(a0_io *io,VECTOR_TYPE v,uint32_t offset){uint64_t r=0;for(uint32_t i=0;i<8;i++)r|=(uint64_t)load_byte(io,v,offset+i)<<(8*i);return r;}
static void check(int test){
 session=a0_arena_create(10000,10000);if(!session)abort();
 a0_io io;memset(&io,0,sizeof io);if(a0_arena_hello(&io).f0)abort();
 uint32_t status=0;
 if(test<7){
  VECTOR_TYPE v={0,0,0};uint32_t expected=0;
  if(test==0){v.f0=123;v.f1=1;v.f2=1;expected=2;}
  if(test==1){v.f0=123;v.f1=1;v.f2=0;expected=6;}
  if(test==2){v.f1=UINT32_MAX;v.f2=UINT32_MAX;v.f0=123;expected=7;}
  if(test==3){BYTE_RESULT a=a0_ew_new(&io,1);v=a.f1;v.f1=v.f2=2;expected=3;}
  if(test==4){BYTE_RESULT a=a0_ew_new(&io,1);v=a.f1;WORD_PAGE z=a0_arena_zero();z.e[0]=256;if(a0_av_store(&io,v,0,1,z).f0)abort();expected=6;}
  if(test==6)expected=6;
  ELF_BUILD_RESULT r=a0_elf_build64(&io,v,62,0,0,test==6?2097152u:0u);status=r.f0;
  if(status!=expected){fprintf(stderr,"case%d status%u expected%u\n",test,status,expected);abort();}
  if(status&&(r.f1.f0||r.f1.f1||r.f1.f2))abort();
 }else{
  // Synthetic near-u32 image sizes exercise 64-bit BSS virtual-address carries without huge allocations.
  const uint32_t sizes[]={0u,4096u,UINT32_MAX,UINT32_MAX-4095u,UINT32_MAX-4194304u};
  for(uint32_t i=0;i<sizeof sizes/sizeof sizes[0];i++){
   BYTE_RESULT a=a0_ew_new(&io,176);
   BYTE_RESULT r=a0_elf_bss(a,0,sizes[i],UINT32_MAX,2097151u);if(r.f0)abort();
   uint64_t f=sizes[i];uint64_t expected=UINT64_C(0x400000)+((f+4095)/4096)*4096+4096+f%4096;
   if(load64(&io,r.f1,136)!=expected||load64(&io,r.f1,144)!=expected||load64(&io,r.f1,128)!=f||load64(&io,r.f1,160)!=UINT64_C(9007199254740991))abort();
  }
 }
 SIMPLE_RESULT done=a0_arena_finish(&io,status);if(done.f0||!a0_arena_is_complete(session)||a0_arena_allocated_words(session)||a0_arena_output_count(session))abort();
 a0_arena_destroy(session);
}
int main(void){for(int i=0;i<8;i++)check(i);puts("8 API groups passed (including 5 u64-carry vectors)");return 0;}
