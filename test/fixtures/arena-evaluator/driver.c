/* Test transport and generic storage inspection only. Every language decision
   is made by A0 ae_source_begin/ae_run_begin/ae_pump and the A0 value adapters. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "arena_runtime.h"
static a0_arena_session *session;
static void transport_write(uint32_t value);
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif
#define A0_COMPILER_READ(t) ((void)(t),a0_runtime_read(session))
#define A0_COMPILER_WRITE(t,v) ((void)(t),transport_write((v)))
#include "module.c"
#include "api.h"
static void die(const char*s){fprintf(stderr,"%s\n",s);exit(2);}
static uint32_t word(void){unsigned char b[4];if(fread(b,1,4,stdin)!=4)die("truncated input");return (uint32_t)b[0]|(uint32_t)b[1]<<8|(uint32_t)b[2]<<16|(uint32_t)b[3]<<24;}
static void out(uint32_t v){unsigned char b[4]={(unsigned char)v,(unsigned char)(v>>8),(unsigned char)(v>>16),(unsigned char)(v>>24)};if(fwrite(b,1,4,stdout)!=4)die("write output");}
static void want(uint32_t v){if(a0_runtime_read(session)!=v)die("storage reply");}
/* Remember only generic allocation lengths so tests can export storage through
   public LOAD requests; no private runtime structures or language semantics. */
static uint32_t *lengths, length_count, length_capacity;
static uint32_t phase, request_op, request_count, request_at, allocation_words;
static void remember(uint32_t words){
 if(length_count==length_capacity){uint64_t cap=length_capacity?(uint64_t)length_capacity*2:16;if(cap>UINT32_MAX)cap=UINT32_MAX;if(cap<=length_count||cap>SIZE_MAX/sizeof(uint32_t))die("metadata allocation");uint32_t *p=realloc(lengths,(size_t)cap*sizeof(uint32_t));if(!p)die("metadata allocation");lengths=p;length_capacity=(uint32_t)cap;}
 lengths[length_count++]=words;
}
static void transport_write(uint32_t value){
 int complete=0;
 if(phase==0){request_op=value;phase=1;}
 else if(phase==1){request_count=value;request_at=0;phase=value?2:0;complete=value==0;}
 else{if(request_op==A0_ARENA_ALLOC&&request_at==0)allocation_words=value;request_at++;if(request_at==request_count){phase=0;complete=1;}}
 a0_runtime_write(session,value);
 if(complete&&request_op==A0_ARENA_ALLOC){uint32_t count=a0_arena_allocation_count(session);if(count==length_count+1)remember(allocation_words);else if(count!=length_count)die("allocation metadata mismatch");}
}
static void send(uint32_t op,uint32_t n,const uint32_t*a){transport_write(op);transport_write(n);for(uint32_t i=0;i<n;i++)transport_write(a[i]);}
static void load(uint32_t handle,uint32_t start,uint32_t count,uint32_t *page){uint32_t args[3]={handle,start,count};send(A0_ARENA_LOAD,3,args);want(0);want(count);for(uint32_t i=0;i<count;i++)page[i]=a0_runtime_read(session);}
static AE_VEC vector(void){AE_VEC v;v.f0=word();v.f1=word();v.f2=word();return v;}
static void upload(uint32_t count){for(uint32_t j=0;j<count;j++){uint32_t n=word();if(!n)die("empty block");send(1,1,&n);want(0);want(1);if(a0_runtime_read(session)!=j+1)die("handle order");for(uint32_t i=0;i<n;){uint32_t k=n-i>128?128:n-i,a[131]={j+1,i,k};for(uint32_t z=0;z<k;z++)a[z+3]=word();send(3,k+3,a);want(0);want(0);i+=k;}}}
static AE_STATE pump(AE_STATE s,uint32_t quantum,uint32_t observation,uint64_t *count){while(s.f0.e[12]){if(observation&&*count>=observation)break;s=a0_ae_pump(s,quantum);(*count)++;}return s;}
int main(void){
#ifdef _WIN32
 _setmode(_fileno(stdin),_O_BINARY);_setmode(_fileno(stdout),_O_BINARY);
#endif
 if(word()!=0x41454556u)die("packet magic");uint32_t mode=word();if(mode==2){uint32_t n=word();out(n);for(uint32_t i=0;i<n;i++){AE_PAIR a;a.f0=word();a.f1=word();uint32_t u=word();AE_PAIR b=a0_ae_fsub(a,u);out(b.f0);out(b.f1);}return 0;}
 uint32_t max=word(),quantum=word(),blocks=word();if(!quantum)die("zero scheduling quantum");session=a0_arena_create(max,0);if(!session)die("session allocation");want(0);want(2);want(A0_ARENA_MAGIC);want(1);upload(blocks);
 AE_PAGE ir;for(uint32_t i=0;i<128;i++)ir.e[i]=word();uint32_t source=word(),sourceLen=word(),fnid=word();AE_VEC args=vector();uint32_t flo=word(),fhi=word(),hasTrips=word(),tlo=word(),thi=word();a0_io io,before;memset(&io,0xa5,sizeof io);memcpy(&before,&io,sizeof io);
 AE_STATE s=a0_ae_empty(ir,&io,flo,fhi,hasTrips!=0,tlo,thi);uint32_t observation=0;
 if(mode==1)s=a0_ae_source_begin(&io,source,sourceLen,fnid,args,flo,fhi,hasTrips!=0,tlo,thi);
 else if(mode==0||mode==6){s=a0_ae_run_begin(s,fnid,args);if(mode==6)observation=word();}
 else if(mode==3){AE_VEC literals=vector(),children=vector();s=a0_ae_import_request(s,literals,children);}
 else if(mode==4){uint32_t ta=word(),a=word(),tb=word(),b=word();s=a0_ae_equal_request(s,ta,a,tb,b);}
 else if(mode==5){uint32_t originalFn=word();AE_PAGE node;memset(&node,0,sizeof node);for(uint32_t i=0;i<14;i++)node.e[i]=word();AE_VEC operands=vector(),params=vector();uint32_t callee=word(),pred=word();s=a0_ae_contract_view(s,originalFn,node,operands,params,callee,pred);s=a0_ae_run_begin(s,s.f0.e[17],args);}
 else die("unknown test operation");
 uint64_t count=0;s=pump(s,quantum,observation,&count);if(s.f2!=&io||memcmp(&io,&before,sizeof io))die("compiler transport IO changed");if(a0_arena_protocol_failed(session))die("protocol failure");out(0x41454556u);out((uint32_t)count);out((uint32_t)(count>>32));for(uint32_t i=0;i<128;i++)out(s.f0.e[i]);for(uint32_t i=0;i<128;i++)out(s.f1.e[i]);uint32_t allocated=a0_arena_allocation_count(session);if(allocated!=length_count)die("allocation count");out(allocated);for(uint32_t i=0;i<allocated;i++){uint32_t n=lengths[i];out(n);for(uint32_t pos=0;pos<n;){uint32_t k=n-pos>128?128:n-pos,page[128];load(i+1,pos,k,page);for(uint32_t j=0;j<k;j++)out(page[j]);pos+=k;}}
 uint32_t finish=0;send(5,1,&finish);want(0);want(0);if(!a0_arena_is_complete(session)||a0_arena_allocated_words(session))die("incomplete FINISH");a0_arena_destroy(session);free(lengths);return 0;
}
