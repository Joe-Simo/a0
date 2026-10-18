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
static uint32_t *copy_table(uint32_t handle,uint32_t n){
 if(!handle){if(n)die("missing original table");return NULL;}
 uint32_t *p=malloc(n?(size_t)n*sizeof(uint32_t):1);if(!p)die("inspection allocation");
 for(uint32_t at=0;at<n;){uint32_t count=n-at>128?128:n-at;load(handle,at,count,p+at);at+=count;}return p;
}
static void same_table(uint32_t handle,uint32_t n,const uint32_t *before){
 for(uint32_t at=0;at<n;){uint32_t count=n-at>128?128:n-at,page[128];load(handle,at,count,page);if(memcmp(page,before+at,(size_t)count*sizeof(uint32_t)))die("original source IR changed");at+=count;}
}
int main(int argc,char **argv){
#ifdef _WIN32
 _setmode(_fileno(stdin),_O_BINARY);_setmode(_fileno(stdout),_O_BINARY);
#endif
int standalone=argc==2&&!strcmp(argv[1],"--standalone");if(argc!=1&&!standalone)die("unknown driver argument");
if(word()!=0x41535646u)die("packet magic");uint32_t max=word(),quantum=word(),length=word(),observation=word();if(!quantum&&!observation)die("zero scheduling quantum");session=a0_arena_create(max,0);if(!session)die("session allocation");want(0);want(2);want(A0_ARENA_MAGIC);want(1);
 uint32_t n=length?length:1;send(1,1,&n);want(0);want(1);uint32_t source=a0_runtime_read(session);for(uint32_t i=0;i<length;){uint32_t k=length-i>128?128:length-i,a[131]={source,i,k};for(uint32_t z=0;z<k;z++)a[z+3]=word();send(3,k+3,a);want(0);want(0);i+=k;}
 a0_io io,before;memset(&io,0xa5,sizeof io);memcpy(&before,&io,sizeof io);SV_STATE s=standalone?a0_probe_standalone_begin(&io,source,length):a0_arena_parse_verify_begin(&io,source,length);
 const uint32_t offsets[]={41,44,47,50};uint32_t handles[4],table_lengths[4];uint32_t *original[4];for(uint32_t i=0;i<4;i++){uint32_t o=offsets[i];handles[i]=s.f1.e[o];table_lengths[i]=s.f1.e[o+1];original[i]=copy_table(handles[i],table_lengths[i]);}
 uint64_t count=0;while(s.f0.e[1]!=11){if(observation&&count>=observation)break;s=a0_arena_verify_resume(s,quantum);if(++count>10000000)die("continuation ceiling");}
 for(uint32_t i=0;i<4;i++){uint32_t o=offsets[i];if(s.f1.e[o]!=handles[i]||s.f1.e[o+1]!=table_lengths[i])die("original source IR changed");same_table(handles[i],table_lengths[i],original[i]);free(original[i]);}
 if(s.f6!=&io||memcmp(&io,&before,sizeof io))die("compiler transport IO changed");if(a0_arena_protocol_failed(session))die("protocol failure");out(0x41535646u);out((uint32_t)count);out((uint32_t)(count>>32));out(a0_arena_verify_status(s.f0));for(uint32_t i=0;i<128;i++)out(s.f0.e[i]);for(uint32_t i=0;i<128;i++)out(s.f1.e[i]);for(uint32_t i=0;i<128;i++)out(s.f2.e[i]);for(uint32_t i=0;i<128;i++)out(s.f3.e[i]);for(uint32_t i=0;i<128;i++)out(s.f4.e[i]);for(uint32_t i=0;i<128;i++)out(s.f5.e[i]);uint32_t allocated=a0_arena_allocation_count(session);if(allocated!=length_count)die("allocation count");out(allocated);for(uint32_t i=0;i<allocated;i++){uint32_t n=lengths[i];out(n);for(uint32_t at=0;at<n;){uint32_t count=n-at>128?128:n-at,page[128];load(i+1,at,count,page);for(uint32_t j=0;j<count;j++)out(page[j]);at+=count;}}
 uint32_t finish=0;send(5,1,&finish);want(0);want(0);if(!a0_arena_is_complete(session)||a0_arena_allocated_words(session))die("incomplete FINISH");a0_arena_destroy(session);free(lengths);return 0;
}
