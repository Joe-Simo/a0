#define _POSIX_C_SOURCE 200809L
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include "fs_runtime.h"
static a0fs_session *session;
#define A0_COMPILER_READ(t) ((void)(t),a0fs_read(session))
#define A0_COMPILER_WRITE(t,v) ((void)(t),a0fs_write(session,(v)))
#include "module.c"
#include "api.h"
/* A641: fixed13-word header, exact payload word count, mandatory A6E1 tag.
 * Source/path bytewords are checked0..255 before an A0 invocation. Table words
 * remain fullu32. No compiler syntax, graph, opcode or target decision here. */
static uint32_t *packet,words,mode,budget,maxout,quantum,maxpumps,platform,incap,outcap,strict,options,payload;
static uint32_t starts[6],lengths[6],counts[3],en,rn,eo,ro,explicitroot,override,dense,work;
static a0_io io,before;
static AX_STATE state;
static AX_RESULT result;
static AX_LINK linked;
static uint32_t code,pumps,pending;
_Noreturn static void die(const char *s){fprintf(stderr,"%s\n",s);exit(91);}
static void want(uint32_t expected){uint32_t actual=a0fs_read(session);if(actual!=expected){fprintf(stderr,"transport %u expected %u\n",actual,expected);exit(92);}}
static void send(uint32_t op,uint32_t n,const uint32_t *a){a0fs_write(session,op);a0fs_write(session,n);for(uint32_t i=0;i<n;i++)a0fs_write(session,a[i]);}
static uint32_t upload(const uint32_t *data,uint32_t len,uint32_t *handle){*handle=0;if(!len)return 0;send(1,1,&len);uint32_t c=a0fs_read(session),n=a0fs_read(session);if(c){if(n)die("alloc failure shape");return c;}if(n!=1)die("alloc shape");*handle=a0fs_read(session);for(uint32_t off=0;off<len;){uint32_t k=len-off>128?128:len-off,a[131]={*handle,off,k};for(uint32_t j=0;j<k;j++)a[j+3]=data[off+j];send(3,k+3,a);want(0);want(0);off+=k;}return 0;}
static void load(uint32_t handle,uint32_t off,uint32_t n,uint32_t *data){uint32_t a[]={handle,off,n};send(2,3,a);want(0);want(n);for(uint32_t i=0;i<n;i++)data[i]=a0fs_read(session);}
static void jsonwords(const char *name,const uint32_t *data,uint32_t n){fprintf(stderr,",\"%s\":[",name);for(uint32_t i=0;i<n;i++)fprintf(stderr,"%s%u",i?",":"",data[i]);fprintf(stderr,"]");}
static void metadata(void){fprintf(stderr,"{\"code\":%u,\"pending\":%s,\"pumps\":%u,\"mode\":%u",code,pending?"true":"false",pumps,mode);if(mode!=1){jsonwords("verifier",state.f0.f0.e,128);jsonwords("checked",state.f0.f1.e,128);jsonwords("context",state.f1.e,16);jsonwords("descriptor",state.f2.e,128);jsonwords("link",state.f11.e,128);if(mode==2)jsonwords("service",linked.f1.e,128);}fprintf(stderr,",\"fsCalls\":[%llu,%llu,%llu,%llu]}", (unsigned long long)a0fs_calls(session,16),(unsigned long long)a0fs_calls(session,17),(unsigned long long)a0fs_calls(session,18),(unsigned long long)a0fs_calls(session,19));fputc('\n',stderr);}
static void *run(void *unused){(void)unused;session=a0fs_create(budget,maxout);if(!session){code=4;return NULL;}memset(&io,0xa5,sizeof io);memcpy(&before,&io,sizeof io);HELLO hello=a0_fs_hello(&io);if(hello.f0||hello.f1!=&io)die("hello/io");a0_io *token=&io;VECTOR output={0};
if(mode==0){uint32_t h;code=upload(packet+14,payload-2,&h);if(!code)state=a0_arena_arm64_source_begin(token,h,payload-2,strict,options);}
else if(mode==1){CONTEXT ctx={0};for(uint32_t i=0;i<6&&!code;i++)code=upload(packet+starts[i],lengths[i],&ctx.e[i]);ctx.e[11]=counts[0];ctx.e[12]=counts[1];ctx.e[13]=counts[2];if(!code){result=a0_arena_arm64_emit_context(token,ctx,(PAGE){0},strict,options);code=result.f0;token=result.f2;output=result.f1;}}
else {uint32_t eh=0,rh=0;code=upload(packet+eo,en,&eh);if(!code)code=upload(packet+ro,rn,&rh);if(!code){linked=a0_arena_arm64_link_begin(token,eh,en,rh,rn,explicitroot!=0,override,dense!=0,work,strict,options);state=linked.f0;}}
if(mode!=1&&!code){while(state.f9==0&&pumps<maxpumps){if(mode==2){linked=a0_arena_arm64_link_pump(linked,quantum);state=linked.f0;}else state=a0_arena_arm64_source_pump(state,quantum);pumps++;}pending=state.f9==0;code=state.f10;token=state.f0.f6;output=state.f3;if(pending)code=7;}
unsigned char *bytes=NULL;uint32_t count=0;if(!code){count=output.f1;bytes=malloc(count?count:1);if(!bytes)code=4;for(uint32_t off=0;off<count&&!code;){uint32_t k=count-off>128?128:count-off,page[128];load(output.f0,off,k,page);for(uint32_t j=0;j<k;j++){if(page[j]>255){code=3;break;}bytes[off+j]=(unsigned char)page[j];}off+=k;}}
/* Exercise the A0 publication path and configured output budget before writing
 * any process output. Failed/truncated/pending requests publish zero bytes. */
if(!code){COMMIT r=a0_ew_emit(token,output);code=r.f0;token=r.f1;}
if(token!=&io||memcmp(&io,&before,sizeof io))die("IO identity/storage changed");metadata();HELLO done=a0_arena_finish(token,code);if(done.f0||done.f1!=&io||!a0fs_is_complete(session)||a0fs_protocol_failed(session)||a0fs_allocated_words(session))die("incomplete transport");if(!code&&fwrite(bytes,1,count,stdout)!=count)die("stdout");free(bytes);a0fs_destroy(session);session=NULL;return NULL;}
static uint32_t next(uint32_t *pos){if(*pos>=words)die("truncated payload");return packet[(*pos)++];}
static void bytespan(uint32_t off,uint32_t n){if(off>words||n>words-off)die("truncated byte span");for(uint32_t i=0;i<n;i++)if(packet[off+i]>255)die("byteword outside0..255");}
int main(void){size_t n=0,capacity=65536;unsigned char *raw=malloc(capacity);if(!raw)die("packet allocation");for(;;){if(n==capacity){if(capacity>SIZE_MAX/2)die("packet size overflow");capacity*=2;unsigned char *q=realloc(raw,capacity);if(!q)die("packet allocation");raw=q;}size_t got=fread(raw+n,1,capacity-n,stdin);n+=got;if(!got){if(ferror(stdin))die("packet read");break;}}if(n%4||n/4>UINT32_MAX||n<14*4)die("packet shape");words=(uint32_t)(n/4);packet=malloc((size_t)words*sizeof *packet);if(!packet)die("packet allocation");for(uint32_t i=0;i<words;i++){size_t j=(size_t)i*4;packet[i]=(uint32_t)raw[j]|(uint32_t)raw[j+1]<<8|(uint32_t)raw[j+2]<<16|(uint32_t)raw[j+3]<<24;}free(raw);
if(packet[0]!=UINT32_C(0x41363431)||packet[1]!=1||packet[2]>2||packet[12]!=words-13)die("packet header");mode=packet[2];budget=packet[3];maxout=packet[4];quantum=packet[5];maxpumps=packet[6];platform=packet[7];incap=packet[8];outcap=packet[9];strict=packet[10];options=packet[11];payload=packet[12];if(platform||incap||outcap)die("nonzero reserved packet fields");uint32_t pos=13;
if(mode==0){uint32_t len=next(&pos);if(payload<2||len!=payload-2)die("declared source length");bytespan(pos,len);pos+=len;}
else if(mode==1){for(uint32_t i=0;i<6;i++){lengths[i]=next(&pos);starts[i]=pos;if(lengths[i]>words-pos)die("declared table length");pos+=lengths[i];}for(uint32_t i=0;i<3;i++)counts[i]=next(&pos);}
else {en=next(&pos);eo=pos;bytespan(pos,en);pos+=en;rn=next(&pos);ro=pos;bytespan(pos,rn);pos+=rn;explicitroot=next(&pos);override=next(&pos);dense=next(&pos);work=next(&pos);if(explicitroot>1||dense>1)die("boolean flag");}
if(next(&pos)!=UINT32_C(0x41364531)||pos!=words)die("completion tag/trailing input");pthread_attr_t attr;pthread_t thread;if(pthread_attr_init(&attr)||pthread_attr_setstacksize(&attr,(size_t)1<<30)||pthread_create(&thread,&attr,run,NULL))die("native thread");pthread_attr_destroy(&attr);if(pthread_join(thread,NULL))die("native join");free(packet);return code<=8?(int)code:90;}
