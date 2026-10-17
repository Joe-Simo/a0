/* Generic word storage/transport only. A0 owns every compiler decision. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include "arena_runtime.h"
static FILE *input_file,*output_file;
static a0_arena_session *session;
static uint32_t phase,op,nargs,at,enabled,fault_op,fault_nth,fault_status,fault_kind,seen;
static uint32_t injected[131],injected_at,injected_count;
static void die(const char *s){fprintf(stderr,"%s\n",s);exit(2);}
static uint32_t tr_read(void){return injected_at<injected_count?injected[injected_at++]:a0_runtime_read(session);}
static void tr_write(uint32_t v){
 int done=0;
 if(!phase){op=v;phase=1;}else if(phase==1){nargs=v;at=0;phase=v?2:0;done=!v;}else if(++at==nargs){phase=0;done=1;}
 a0_runtime_write(session,v);
 if(done&&enabled&&fault_kind&&op==fault_op&&++seen==fault_nth){
  (void)a0_runtime_read(session);uint32_t n=a0_runtime_read(session),p[128];if(n>128)die("fault reply size");
  for(uint32_t i=0;i<n;i++)p[i]=a0_runtime_read(session);
  injected_at=0;injected[0]=fault_kind==2?0:fault_status;injected[1]=fault_kind==2&&n?n-1:0;injected_count=2+injected[1];
  for(uint32_t i=0;i<injected[1];i++)injected[i+2]=p[i];
 }
}
#define A0_COMPILER_READ(t) ((void)(t),tr_read())
#define A0_COMPILER_WRITE(t,v) ((void)(t),tr_write(v))
#include "module.c"
#include "api.h"
static uint32_t word(void){unsigned char b[4];if(fread(b,1,4,input_file)!=4)die("truncated input");return (uint32_t)b[0]|(uint32_t)b[1]<<8|(uint32_t)b[2]<<16|(uint32_t)b[3]<<24;}
static void out(uint32_t v){unsigned char b[4]={(unsigned char)v,(unsigned char)(v>>8),(unsigned char)(v>>16),(unsigned char)(v>>24)};if(fwrite(b,1,4,output_file)!=4)die("output");}
static void want(uint32_t v){if(tr_read()!=v)die("storage reply");}
static void send(uint32_t opcode,uint32_t n,const uint32_t *a){tr_write(opcode);tr_write(n);for(uint32_t i=0;i<n;i++)tr_write(a[i]);}
static uint32_t upload(uint32_t n,uint32_t **preserve){
 uint32_t h=0;if(!n)return 0;uint32_t *copy=preserve?malloc((size_t)n*4):NULL;if(preserve&&!copy)die("host source allocation");
 send(1,1,&n);want(0);want(1);h=tr_read();
 for(uint32_t i=0;i<n;){uint32_t count=n-i>128?128:n-i,a[131]={h,i,count};for(uint32_t j=0;j<count;j++){a[j+3]=word();if(copy)copy[i+j]=a[j+3];}send(3,count+3,a);want(0);want(0);i+=count;}
 if(preserve)*preserve=copy;return h;
}
static uint32_t length,quantum,source,code,e[128],verify[128],counts[3],*source_copy;
static WASM_OPTIONS options;
static a0_io io,before;
static uint64_t resumes;
static void *worker(void *unused){
 (void)unused;memset(&io,0xa5,sizeof io);memcpy(&before,&io,sizeof io);enabled=1;
 WASM_STATE s=a0_arena_wasm_source_begin(&io,source,length,options);
 while(!a0_arena_wasm_source_done(s.f0)){s=a0_arena_wasm_source_resume(s,quantum);resumes++;}
 memcpy(e,s.f0.e,sizeof e);memcpy(verify,s.f1.f3.f0.e,sizeof verify);for(uint32_t i=0;i<3;i++)counts[i]=s.f1.f1.e[11+i];
 if(s.f1.f3.f6!=&io)die("token identity");s=a0_arena_wasm_source_resume(s,quantum);if(memcmp(e,s.f0.e,sizeof e))die("terminal resume");
 WASM_STATUSIO r=a0_arena_wasm_source_publish(s);code=r.f0;if(r.f1!=&io)die("token identity");enabled=0;
 if(memcmp(&io,&before,sizeof io))die("buffered IO changed");return NULL;
}
int main(int argc,char **argv){
 if(argc!=3)die("input/output files required");input_file=fopen(argv[1],"rb");output_file=fopen(argv[2],"wb");if(!input_file||!output_file)die("files");
 if(word()!=0x41574153u)die("packet magic");uint32_t max=word(),maxout=word();quantum=word();length=word();fault_op=word();fault_nth=word();fault_status=word();fault_kind=word();
 if(!quantum||fault_kind>2)die("protocol quantum/fault");options=a0_arena_wasm_options();for(uint32_t i=0;i<7;i++)options.e[i]=word();uint32_t names=word(),spans=word();
 session=a0_arena_create(max,maxout);if(!session)die("session allocation");want(0);want(2);want(A0_ARENA_MAGIC);want(1);
 source=upload(length,&source_copy);options.e[7]=upload(names,NULL);options.e[8]=options.e[9]=names;options.e[10]=upload(spans,NULL);options.e[11]=options.e[12]=spans;
 if(fgetc(input_file)!=EOF)die("trailing input");pthread_attr_t attr;pthread_t thread;if(pthread_attr_init(&attr)||pthread_attr_setstacksize(&attr,(size_t)1u<<30))die("thread attributes");if(pthread_create(&thread,&attr,worker,NULL))die("thread start");pthread_attr_destroy(&attr);if(pthread_join(thread,NULL))die("thread join");
 if(a0_arena_protocol_failed(session))die("protocol failure");
 for(uint32_t i=0;i<length;){uint32_t count=length-i>128?128:length-i,a[3]={source,i,count};send(2,3,a);want(0);want(count);for(uint32_t j=0;j<count;j++)if(tr_read()!=source_copy[i+j])die("source changed");i+=count;}
 uint32_t count=a0_arena_output_count(session);const uint32_t *bytes=a0_arena_output(session);for(uint32_t i=0;i<count;i++)if(bytes[i]>255)die("nonbyte output");
 uint32_t allocated=a0_arena_allocated_words(session);send(5,1,&code);want(0);want(0);if(!a0_arena_is_complete(session)||a0_arena_finish_code(session)!=code||a0_arena_allocated_words(session))die("incomplete FINISH");
 out(0x41574153u);out(code);out((uint32_t)resumes);out((uint32_t)(resumes>>32));for(uint32_t i=0;i<128;i++)out(e[i]);for(uint32_t i=0;i<128;i++)out(verify[i]);for(uint32_t i=0;i<3;i++)out(counts[i]);out(allocated);out(count);for(uint32_t i=0;i<count;i++)out(bytes[i]);
 free(source_copy);a0_arena_destroy(session);if(fclose(input_file)||fclose(output_file))die("close");return 0;
}
