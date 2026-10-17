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
static VECTOR_TYPE words(a0_io *io,uint32_t n,const uint32_t *values){
 BYTE_RESULT r=a0_ew_new(io,n);if(r.f0)abort();for(uint32_t i=0;i<n;i++){r=a0_ew_meta(r,0,i,values[i]);if(r.f0)abort();}return r.f1;
}
static void check(int mode){
 session=a0_arena_create(1000000,1000000);if(!session)abort();
 a0_io io;memset(&io,0,sizeof io);if(a0_arena_hello(&io).f0)abort();
 const uint32_t namewords[]={65u,65u,66u},spanwords[]={0,1,1,1,2,1};
 VECTOR_TYPE names=words(&io,3,namewords),spans=words(&io,6,spanwords),query=words(&io,1,namewords);
 uint32_t status=0;
 if(mode<4){
  uint32_t expected=6;
  if(mode==0)spans.f0=12345;
  if(mode==1)names.f0=12345;
  if(mode==2){BYTE_RESULT changed={0,names,&io};changed=a0_ew_meta(changed,0,0,256);if(changed.f0)abort();}
  if(mode==3){spans.f1=spans.f2=7;expected=6;}
  if(mode==0||mode==1)expected=2;
  PE_PREPARE_RESULT r=a0_pe_prepare(&io,1,names,spans);status=r.f0;
  if(status!=expected||r.f1.f0||r.f1.f1||r.f1.f2||r.f1.f3.f0||r.f1.f3.f1||r.f1.f3.f2){fprintf(stderr,"prepare%d status%u expected%u\n",mode,status,expected);abort();}
 }else{
  PE_PREPARE_RESULT plan=a0_pe_prepare(&io,1,names,spans);if(plan.f0)abort();
  if(mode==4){
   // Distinct imports with duplicate names both point to last hint; named IAT query resolves last slot.
   PE_FIND_IAT_RESULT r=a0_pe_find_iat(&io,names,spans,query,plan.f1);if(r.f0||r.f1!=plan.f1.f2+8)abort();
  }
  if(mode==5){query.f0=12345;PE_FIND_IAT_RESULT r=a0_pe_find_iat(&io,names,spans,query,plan.f1);status=r.f0;if(status!=2||r.f1)abort();}
  if(mode==6){spans.f1=spans.f2=7;PE_FIND_IAT_RESULT r=a0_pe_find_iat(&io,names,spans,query,plan.f1);status=r.f0;if(status!=6||r.f1)abort();}
  if(mode==7){BYTE_RESULT changed={0,query,&io};changed=a0_ew_meta(changed,0,0,256);if(changed.f0)abort();PE_FIND_IAT_RESULT r=a0_pe_find_iat(&io,names,spans,query,plan.f1);status=r.f0;if(status!=6||r.f1)abort();}
  if(mode>=8&&mode<=12){
   uint32_t expected=6;
   if(mode==8)plan.f1.f1++;
   if(mode==9)plan.f1.f2++;
   if(mode==10){plan.f1.f3.f0=12345;expected=2;}
   if(mode==11)plan.f1.f3.f1=0;
   if(mode==12)plan.f1.f2=UINT32_MAX;
   PE_BUILD_RESULT r=a0_pe_build(&io,query,0,plan.f1);status=r.f0;if(status!=expected||r.f1.f0||r.f1.f1||r.f1.f2)abort();
  }
  if(mode==13){plan.f1.f2=UINT32_MAX;PE_FIND_IAT_RESULT r=a0_pe_find_iat(&io,names,spans,query,plan.f1);status=r.f0;if(status!=6||r.f1)abort();}
 }
 SIMPLE_RESULT done=a0_arena_finish(&io,status);if(done.f0||!a0_arena_is_complete(session)||a0_arena_allocated_words(session)||a0_arena_output_count(session))abort();
 a0_arena_destroy(session);
}
int main(void){for(int i=0;i<14;i++)check(i);puts("14 PE API cases passed");return 0;}
