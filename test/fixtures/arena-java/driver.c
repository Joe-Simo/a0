/* Binary byte/opaque-state transport only. Include the unmodified runtimes once
 * to inspect every existing allocation capacity and inject storage error replies. */
#define _XOPEN_SOURCE 700
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif
#include "arena_runtime.c"
#include "fs_runtime.c"
static a0fs_session *session;
static uint32_t inject_status;
static uint32_t proof_read(void){
 if(inject_status&&session->rpos==0&&session->rlen>=2){session->reply[0]=inject_status;session->reply[1]=0;session->rlen=2;inject_status=0;}
 return a0fs_read(session);
}
#define A0_COMPILER_READ(t) ((void)(t),proof_read())
#define A0_COMPILER_WRITE(t,v) ((void)(t),a0fs_write(session,(v)))
#include "module.c"
#include "api.h"
static void die(const char*s){fprintf(stderr,"%s\n",s);exit(2);}
static uint32_t word(void){unsigned char b[4];if(fread(b,1,4,stdin)!=4)die("truncated input");return(uint32_t)b[0]|(uint32_t)b[1]<<8|(uint32_t)b[2]<<16|(uint32_t)b[3]<<24;}
static void out(uint32_t v){unsigned char b[4]={(unsigned char)v,(unsigned char)(v>>8),(unsigned char)(v>>16),(unsigned char)(v>>24)};if(fwrite(b,1,4,stdout)!=4)die("write output");}
static void want(uint32_t n){if(a0fs_read(session)!=n)die("storage reply");}
static void send(uint32_t op,uint32_t n,const uint32_t*a){a0fs_write(session,op);a0fs_write(session,n);for(uint32_t i=0;i<n;i++)a0fs_write(session,a[i]);}
static uint32_t upload(uint32_t n){uint32_t len=n?n:1;send(1,1,&len);want(0);want(1);uint32_t h=a0fs_read(session);for(uint32_t i=0;i<n;){uint32_t count=n-i>128?128:n-i,a[131]={h,i,count};for(uint32_t j=0;j<count;j++)a[j+3]=word();send(3,count+3,a);want(0);want(0);i+=count;}return h;}
static allocation *keep(uint32_t *count){
 a0_arena_session*b=session->base;*count=b->allocation_count;
 allocation*copy=calloc(*count?*count:1,sizeof*copy);if(!copy)die("snapshot directory");
 for(uint32_t i=0;i<*count;i++){copy[i].length=b->allocations[i].length;copy[i].words=malloc((size_t)copy[i].length*sizeof(uint32_t));if(!copy[i].words)die("snapshot allocation");memcpy(copy[i].words,b->allocations[i].words,(size_t)copy[i].length*sizeof(uint32_t));}return copy;
}
static void unchanged(allocation*copy,uint32_t count){
 a0_arena_session*b=session->base;if(b->allocation_count<count)die("old allocation removed");
 for(uint32_t i=0;i<count;i++){if(copy[i].length!=b->allocations[i].length||memcmp(copy[i].words,b->allocations[i].words,(size_t)copy[i].length*sizeof(uint32_t)))die("old allocation capacity changed");free(copy[i].words);}free(copy);
}
static uint32_t*words(uint32_t h,uint32_t need){a0_arena_session*b=session->base;if(!h||h>b->allocation_count||need>b->allocations[h-1].length)die("fault fixture extent");return b->allocations[h-1].words;}
static void fault(uint32_t kind,uint32_t*c,uint32_t*d){
 if(kind==1)words(c[3],9)[8]=99;
 if(kind==2)words(c[3],17)[16]=99;
 if(kind==3)words(d[40],15)[14]=123;
 if(kind==4)words(d[40],16)[15]=123;
 if(kind==5)words(d[40],17)[16]=123;
 if(kind==6)words(d[37],1)[0]=123;
 if(kind==7)c[3]=0xfffffffeu;
 if(kind==8)d[1]^=1;
 if(kind==9)d[8]=1;
 if(kind==10){d[8]=3;words(c[2],10)[9]=3;}
 if(kind>=21&&kind<=25)inject_status=kind-20;
}
int main(void){
#ifdef _WIN32
 _setmode(_fileno(stdin),_O_BINARY);_setmode(_fileno(stdout),_O_BINARY);
#endif
 if(word()!=0x414a4156u)die("packet magic");
 uint32_t mode=word(),max=word(),maxout=word(),quantum=word(),observation=word(),incap=word(),outcap=word(),kind=word(),budget=word();
 uint32_t sourceLength=word(),entryLength=word(),rootLength=word(),override=word(),dense=word(),work=word();
 if(mode>2||(!quantum&&!observation))die("transport command");
 session=a0fs_create(max,maxout);if(!session)die("session allocation");a0_io io,before;memset(&io,0xa5,sizeof io);memcpy(&before,&io,sizeof io);
 HELLO_RESULT hello=a0_fs_hello(&io);if(hello.f0||hello.f1!=&io)die("FS hello");
 uint32_t source=upload(sourceLength),entry=upload(entryLength),root=upload(rootLength);
 uint32_t originalCount,snapshotCount=0;allocation*original=keep(&originalCount);allocation*snapshot=NULL;
 uint32_t e[128]={0},v[128]={0},m[6]={0},linkfacts[128]={0},d[128]={0},ctx[16]={0};
 uint32_t code=0;uint64_t pumps=0;TARGET_RESULT result;
 if(mode==1){
  LINK_STATE k=a0_arena_java_link_begin_options(&io,entry,entryLength,root,rootLength,true,override,dense!=0,work,incap,outcap);
  while(k.f0.e[0]==0&&k.f0.e[1]!=3){if(observation&&pumps>=observation)break;if(!snapshot&&k.f0.e[1]==2){snapshot=keep(&snapshotCount);memcpy(ctx,k.f2.e,sizeof ctx);memcpy(d,k.f3.e,sizeof d);}k=a0_arena_java_link_resume(k,quantum);if(++pumps>10000000)die("test continuation watchdog");}
  if(snapshot){if(memcmp(ctx,k.f2.e,sizeof ctx)||memcmp(d,k.f3.e,sizeof d))die("linked ctx/D changed");unchanged(snapshot,snapshotCount);}
  memcpy(d,k.f3.e,sizeof d);memcpy(e,k.f0.e,sizeof e);memcpy(v,k.f1.f1.f0.e,sizeof v);memcpy(m,k.f1.f1.f1.e,sizeof m);memcpy(linkfacts,k.f1.f0.e,sizeof linkfacts);result=a0_arena_java_link_result(k);
 }else{
  UNIT_STATE j=a0_arena_java_begin_options(&io,source,sourceLength,incap,outcap);
  while(j.f0.e[0]==0&&j.f0.e[1]!=3){
   if(observation&&pumps>=observation)break;
   if(mode==2&&j.f0.e[1]==2)break;
   if(!snapshot&&j.f0.e[1]==2){snapshot=keep(&snapshotCount);memcpy(ctx,j.f2.e,sizeof ctx);memcpy(d,j.f3.e,sizeof d);}
   j=a0_arena_java_resume(j,mode==2?1:quantum);if(++pumps>10000000)die("test continuation watchdog");
  }
  if(mode==2&&j.f0.e[0]==0&&j.f0.e[1]==2){
   fault(kind,j.f2.e,j.f3.e);memcpy(ctx,j.f2.e,sizeof ctx);memcpy(d,j.f3.e,sizeof d);snapshot=keep(&snapshotCount);
   uint32_t oldmax=session->base->max_words;if(budget!=0xffffffffu){uint64_t cap=(uint64_t)session->base->allocated_words+budget;session->base->max_words=cap>0xffffffffu?0xffffffffu:(uint32_t)cap;}
   result=a0_java_emit_options(&io,j.f2,j.f3,incap,outcap);inject_status=0;session->base->max_words=oldmax;
   if(memcmp(ctx,j.f2.e,sizeof ctx)||memcmp(d,j.f3.e,sizeof d))die("direct ctx/D changed");
  }else result=a0_arena_java_result(j);
  if(snapshot){if(memcmp(ctx,j.f2.e,sizeof ctx)||memcmp(d,j.f3.e,sizeof d))die("unit ctx/D changed");unchanged(snapshot,snapshotCount);}
  memcpy(d,j.f3.e,sizeof d);memcpy(e,j.f0.e,sizeof e);memcpy(v,j.f1.f0.e,sizeof v);memcpy(m,j.f1.f1.e,sizeof m);
 }
 unchanged(original,originalCount);code=result.f0;
 if(result.f2!=&io||memcmp(&io,&before,sizeof io))die("transport IO capability changed");
 if(code==0){EW_RESULT emitted=a0_ew_emit(&io,result.f1);code=emitted.f0;if(emitted.f1!=&io)die("emission IO changed");}
 else if(result.f1.f0||result.f1.f1||result.f1.f2)die("partial public output on failure");
 if(a0fs_protocol_failed(session)||memcmp(&io,&before,sizeof io))die("transport failed");
 send(5,1,&code);want(0);want(0);if(!a0fs_is_complete(session)||a0fs_allocated_words(session)||a0_arena_finish_code(session->base)!=code)die("incomplete FINISH");
 out(0x414a4156u);out(code);out((uint32_t)pumps);out((uint32_t)(pumps>>32));out(snapshotCount);
 for(uint32_t i=0;i<128;i++)out(e[i]);for(uint32_t i=0;i<128;i++)out(v[i]);for(uint32_t i=0;i<6;i++)out(m[i]);for(uint32_t i=0;i<128;i++)out(linkfacts[i]);for(uint32_t i=0;i<128;i++)out(d[i]);
 uint32_t len=code==0?a0_arena_output_count(session->base):0;out(len);const uint32_t*bytes=a0_arena_output(session->base);for(uint32_t i=0;i<len;i++){if(bytes[i]>255)die("nonbyte output");out(bytes[i]);}a0fs_destroy(session);return 0;
}
