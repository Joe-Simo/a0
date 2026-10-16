/* Test transport only: raw source and explicit component requests. Grammar,
 * verification, canonical bytes, mappings and SHA decisions execute in A0.
 * The unmodified runtime is included to snapshot every preexisting allocation,
 * including its unused capacity, and inject explicit storage error replies. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif
#include "arena_runtime.c"
static a0_arena_session *session;
static uint32_t inject_status;
static uint32_t proof_read(void) {
  if(inject_status && session->response_position==0 && session->response_count>=2){
    session->response[0]=inject_status;session->response[1]=0;
    session->response_count=2;inject_status=0;
  }
  return a0_runtime_read(session);
}
#define A0_COMPILER_READ(t) ((void)(t),proof_read())
#define A0_COMPILER_WRITE(t,v) ((void)(t),a0_runtime_write(session,(v)))
#include "module.c"
#include "api.h"
static void die(const char*s){fprintf(stderr,"%s\n",s);exit(2);}
static uint32_t word(void){unsigned char b[4];if(fread(b,1,4,stdin)!=4)die("truncated input");return (uint32_t)b[0]|(uint32_t)b[1]<<8|(uint32_t)b[2]<<16|(uint32_t)b[3]<<24;}
static void out(uint32_t v){unsigned char b[4]={(unsigned char)v,(unsigned char)(v>>8),(unsigned char)(v>>16),(unsigned char)(v>>24)};if(fwrite(b,1,4,stdout)!=4)die("write output");}
static void want(uint32_t v){if(a0_runtime_read(session)!=v)die("storage reply");}
static void send(uint32_t op,uint32_t n,const uint32_t*a){a0_runtime_write(session,op);a0_runtime_write(session,n);for(uint32_t i=0;i<n;i++)a0_runtime_write(session,a[i]);}
static allocation *keep(uint32_t *count){
  *count=session->allocation_count;
  allocation *copy=calloc(*count?*count:1,sizeof *copy);if(!copy)die("snapshot directory");
  for(uint32_t i=0;i<*count;i++){
    copy[i].length=session->allocations[i].length;
    copy[i].words=malloc((size_t)copy[i].length*sizeof(uint32_t));if(!copy[i].words)die("snapshot allocation");
    memcpy(copy[i].words,session->allocations[i].words,(size_t)copy[i].length*sizeof(uint32_t));
  }
  return copy;
}
static void unchanged(allocation*copy,uint32_t count){
  if(session->allocation_count<count)die("old allocations removed");
  for(uint32_t i=0;i<count;i++){
    if(copy[i].length!=session->allocations[i].length || memcmp(copy[i].words,session->allocations[i].words,(size_t)copy[i].length*sizeof(uint32_t)))die("preexisting arena allocation changed");
    free(copy[i].words);
  }
  free(copy);
}
static void view(uint32_t h,uint32_t n,int bytes){
  if(!n)return;
  if(!h||h>session->allocation_count||n>session->allocations[h-1].length)die("output view range");
  for(uint32_t i=0;i<n;i++){uint32_t v=session->allocations[h-1].words[i];if(bytes&&v>255)die("nonbyte output");out(v);}
}
int main(void){
#ifdef _WIN32
  _setmode(_fileno(stdin),_O_BINARY);_setmode(_fileno(stdout),_O_BINARY);
#endif
  if(word()!=0x41464d54u)die("packet magic");
  uint32_t max=word(),maxout=word(),checked=word(),length=word(),requests=word();
  session=a0_arena_create(max,maxout);if(!session)die("session allocation");
  want(0);want(2);want(A0_ARENA_MAGIC);want(1);
  uint32_t n=length?length:1;send(1,1,&n);want(0);want(1);uint32_t source=a0_runtime_read(session);
  uint32_t *original_source=calloc(n,sizeof(uint32_t));if(!original_source)die("source snapshot");
  for(uint32_t i=0;i<length;){uint32_t k=length-i>128?128:length-i,a[131]={source,i,k};for(uint32_t z=0;z<k;z++){a[z+3]=word();original_source[i+z]=a[z+3];}send(3,k+3,a);want(0);want(0);i+=k;}
  a0_io io,before;memset(&io,0xa5,sizeof io);memcpy(&before,&io,sizeof io);
  PARSED p=a0_arena_parse(&io,source,length);AS_RESULT ps;memset(&ps,0,sizeof ps);
  uint32_t initial=p.f0;if(p.f2!=&io)die("parse IO");
  if(initial==0||initial==7){
    if(p.f1.e[60]){AS_INPUT arg;arg.f0=p.f1;arg.f1=&io;ps=a0_as_resume(arg);if(ps.f0.e[0]!=0)initial=ps.f0.e[0];if(ps.f2!=&io)die("spec IO");}
    if(checked&&(initial==0||initial==7)){
      VERIFIED q=a0_arena_verify_begin(&io,p.f1);uint32_t rounds=0;
      while(q.f0.e[0]==0&&q.f0.e[1]!=11){q=a0_arena_verify_resume(q,97);if(++rounds>10000000)die("verification watchdog");}
      initial=a0_arena_verify_status(q.f0);p.f1=q.f1;ps.f1=q.f2;if(q.f6!=&io)die("verification IO");
    }
  }
  if(memcmp(&io,&before,sizeof io))die("initial IO capability changed");
  out(0x41464d54u);out(initial);out(p.f1.e[1]);out(p.f1.e[42]/14);out(requests);
  for(uint32_t request=0;request<requests;request++){
    uint32_t operation=word(),mode=word(),id=word(),skip=word(),mapping=word(),fault=word(),budget=word();
    PARSED current=p;AS_RESULT grammar=ps;
    uint32_t changed_h=0,changed_at=0,changed_value=0,changed_flags=0;
    if(fault==1)current.f1.e[93]=2;
    if(fault==2)current.f1.e[0]=7;
    if(fault==3)current.f1.e[6]=0xfffffffeu;
    if(fault==4)current.f1.e[44]=0xfffffffeu;
    if(fault==5){uint32_t one=1;send(1,1,&one);want(0);want(1);current.f1.e[44]=a0_runtime_read(session);}
    if(fault==6)memset(grammar.f1.e,0,sizeof grammar.f1.e);
    if(fault==7)grammar.f1.e[31]^=1;
    if(fault==8)current.f1.e[59]=0xfffffffeu;
    if(fault==9)current.f1.e[60]=127;
    if(fault==10)current.f1.e[101]=0;
    if(fault==11||fault==12){changed_h=current.f1.e[44];if(!changed_h||changed_h>session->allocation_count||session->allocations[changed_h-1].length<14)die("opcode fault fixture");changed_at=1;changed_value=session->allocations[changed_h-1].words[1];changed_flags=session->allocations[changed_h-1].words[11];session->allocations[changed_h-1].words[1]=99;if(fault==12)session->allocations[changed_h-1].words[11]|=2;}
    if(fault==13)current.f1.e[0]=6;
    if(fault==14)current.f1.e[45]=0;
    uint32_t oldmax=session->max_words;
    if(budget!=0xffffffffu){uint64_t cap=(uint64_t)session->allocated_words+budget;session->max_words=cap>0xffffffffu?0xffffffffu:(uint32_t)cap;}
    uint32_t count;allocation *copy=keep(&count);uint32_t original_m[128],original_ps[128];memcpy(original_m,current.f1.e,sizeof original_m);memcpy(original_ps,grammar.f1.e,sizeof original_ps);
    if(fault>=21&&fault<=25)inject_status=fault-20;
    uint32_t code=initial,handle=0,len=0,events=0,eventh=0,facts[128]={0};
    if(initial==0||(!checked&&initial==7)){
      if(operation==0){FORMATTED r=a0_arena_format_described(&io,current.f1,grammar.f1,mode,id,skip!=0,mapping!=0);code=r.f0;handle=r.f1.f0;len=r.f1.f1;memcpy(facts,r.f2.e,sizeof facts);eventh=r.f2.e[4];events=r.f2.e[5];if(r.f3!=&io)die("format IO");if(code&&(r.f1.f0||r.f1.f1||r.f1.f2||events||r.f2.e[6]||r.f2.e[9]))die("failed format exposed output");}
      else if(operation==1){REVISION r=a0_arena_revision(&io,current.f1,grammar.f1,mode,id);code=r.f0;handle=r.f1.f0;len=r.f1.f1;if(r.f2!=&io)die("revision IO");if(code&&(r.f1.f0||r.f1.f1||r.f1.f2))die("failed revision exposed output");}
      else die("unknown test request");
    }
    inject_status=0;
    if(memcmp(&io,&before,sizeof io)||memcmp(original_m,current.f1.e,sizeof original_m)||memcmp(original_ps,grammar.f1.e,sizeof original_ps))die("component input changed");
    unchanged(copy,count);
    if(changed_h){session->allocations[changed_h-1].words[changed_at]=changed_value;session->allocations[changed_h-1].words[11]=changed_flags;}
    session->max_words=oldmax;
    if(a0_arena_protocol_failed(session))die("protocol failure");
    out(operation);out(code);out(len);out(events);for(uint32_t i=0;i<128;i++)out(facts[i]);view(handle,len,1);view(eventh,events,0);
  }
  if(memcmp(original_source,session->allocations[source-1].words,(size_t)length*sizeof(uint32_t)))die("source changed across complete request");free(original_source);
  uint32_t finish=0;send(5,1,&finish);want(0);want(0);
  if(!a0_arena_is_complete(session)||a0_arena_allocated_words(session)||a0_arena_finish_code(session)!=0)die("incomplete FINISH");
  a0_arena_destroy(session);return 0;
}
