/* Test-only raw word transport/snapshots. All UTF8 decisions execute in A0. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "arena_runtime.c"
static FILE *input_file,*output_file;
static a0_arena_session *session;
static uint32_t enabled,phase,opcode,nargs,received,selected_op,selected_nth,selected_status,fault_kind,seen,fired;
static uint32_t injected[130],injected_at,injected_count;
static void die(const char *s){fprintf(stderr,"%s\n",s);exit(2);}
static uint32_t tr_read(void){return injected_at<injected_count?injected[injected_at++]:a0_runtime_read(session);}
static void tr_write(uint32_t v){
 int done=0;if(!phase){opcode=v;phase=1;}else if(phase==1){nargs=v;received=0;phase=v?2:0;done=!v;}else if(++received==nargs){phase=0;done=1;}
 a0_runtime_write(session,v);
 if(done&&enabled&&fault_kind&&opcode==selected_op&&++seen==selected_nth){
  (void)a0_runtime_read(session);uint32_t n=a0_runtime_read(session),payload[128];if(n>128)die("fault reply extent");for(uint32_t i=0;i<n;i++)payload[i]=a0_runtime_read(session);
  injected_at=0;injected[0]=fault_kind==2?0:selected_status;injected[1]=fault_kind==2&&n?n-1:0;injected_count=2+injected[1];for(uint32_t i=0;i<injected[1];i++)injected[i+2]=payload[i];fired=1;
 }
}
#define A0_COMPILER_READ(t) ((void)(t),tr_read())
#define A0_COMPILER_WRITE(t,v) ((void)(t),tr_write(v))
#include "module.c"
#include "api.h"
static uint32_t word(void){unsigned char b[4];if(fread(b,1,4,input_file)!=4)die("truncated packet");return (uint32_t)b[0]|(uint32_t)b[1]<<8|(uint32_t)b[2]<<16|(uint32_t)b[3]<<24;}
static void out(uint32_t v){unsigned char b[4]={(unsigned char)v,(unsigned char)(v>>8),(unsigned char)(v>>16),(unsigned char)(v>>24)};if(fwrite(b,1,4,output_file)!=4)die("output file");}
static void want(uint32_t v){if(a0_runtime_read(session)!=v)die("runtime reply");}
static void send(uint32_t op,uint32_t n,const uint32_t *a){a0_runtime_write(session,op);a0_runtime_write(session,n);for(uint32_t i=0;i<n;i++)a0_runtime_write(session,a[i]);}
static uint32_t allocate(uint32_t n){send(1,1,&n);want(0);want(1);return a0_runtime_read(session);}
static void store(uint32_t h,uint32_t off,uint32_t n,const uint32_t *p){uint32_t a[131]={h,off,n};memcpy(a+3,p,(size_t)n*4);send(3,n+3,a);want(0);want(0);}
static allocation *snapshot(uint32_t *count){
 *count=session->allocation_count;allocation *copy=calloc(*count?*count:1,sizeof *copy);if(!copy)die("snapshot directory");for(uint32_t i=0;i<*count;i++){copy[i].length=session->allocations[i].length;copy[i].words=malloc((size_t)copy[i].length*4);if(!copy[i].words)die("snapshot words");memcpy(copy[i].words,session->allocations[i].words,(size_t)copy[i].length*4);}return copy;
}
static void check_snapshot(allocation *copy,uint32_t count){if(session->allocation_count<count)die("old allocations removed");for(uint32_t i=0;i<count;i++){if(copy[i].length!=session->allocations[i].length||memcmp(copy[i].words,session->allocations[i].words,(size_t)copy[i].length*4))die("old allocation changed");}}
static void free_snapshot(allocation *copy,uint32_t count){for(uint32_t i=0;i<count;i++)free(copy[i].words);free(copy);}
static uint32_t *copy_view(uint32_t h,uint32_t n,int bytes){
 if(!n)return NULL;if(!h||h>session->allocation_count||n>session->allocations[h-1].length)die("output vector range");uint32_t *p=malloc((size_t)n*4);if(!p)die("output snapshot");memcpy(p,session->allocations[h-1].words,(size_t)n*4);if(bytes)for(uint32_t i=0;i<n;i++)if(p[i]>255)die("nonbyte output");return p;
}
int main(int argc,char **argv){
 if(argc!=3)die("file-backed input/output required");input_file=fopen(argv[1],"rb");output_file=fopen(argv[2],"wb");if(!input_file||!output_file)die("files");if(word()!=0x55384e50u)die("packet magic");
 uint32_t mode=word(),budget=word(),source_words=word(),length=word(),padding=word(),bad_handle=word();selected_op=word();selected_nth=word();selected_status=word();fault_kind=word();uint32_t lifecycle=word(),slot=word(),forged_length=word(),append_count=word();if(mode>2||lifecycle>2||fault_kind>2)die("request mode");
 session=a0_arena_create(budget,0);if(!session)die("runtime create");a0_io io,before;memset(&io,0xa5,sizeof io);memcpy(&before,&io,sizeof io);HELLO hello=a0_arena_hello(&io);if(hello.f0||hello.f1!=&io)die("hello");
 for(uint32_t i=0;i<padding;i++)(void)allocate(1);uint32_t source=allocate(source_words?source_words:1);for(uint32_t i=0;i<source_words;){uint32_t n=source_words-i>128?128:source_words-i,p[128];for(uint32_t j=0;j<n;j++)p[j]=word();store(source,i,n,p);i+=n;}
 uint32_t sentinel=allocate(4),sentinel_words[4]={0xffffffffu,256,17,0};store(sentinel,0,4,sentinel_words);if(fgetc(input_file)!=EOF)die("packet tail");
 uint32_t old_count=0;allocation *old=snapshot(&old_count);uint32_t flags=8,code=0,meta[128]={0},out_length=0,origin_length=0,*decoded=NULL,*origins=NULL;
 if(lifecycle==2){check_snapshot(old,old_count);flags|=256;FINISHED f=a0_arena_finish(&io,0);if(f.f0||f.f1!=&io)die("pre-finish");}
 if(lifecycle==1){a0_runtime_write(session,99);a0_runtime_write(session,0);if(!a0_arena_protocol_failed(session))die("sticky protocol setup");}
 enabled=1;
 if(mode==0){DECODED r=a0_arena_utf8_decode(&io,bad_handle?0xffffffffu:source,length);code=r.f0;memcpy(meta,r.f2.e,sizeof meta);if(r.f3!=&io)die("decode IO");if(r.f1.f0!=meta[32]||r.f1.f1!=meta[33]||r.f1.f2!=meta[34])die("output descriptor mismatch");out_length=r.f1.f1;origin_length=meta[36];if(code&&(r.f1.f0||r.f1.f1||r.f1.f2||meta[2]||meta[3]||meta[35]||meta[36]||meta[37]||meta[95]))die("failed decoder exposed public result");if(!code){decoded=copy_view(r.f1.f0,out_length,1);origins=copy_view(meta[35],origin_length,0);}}
 else if(mode==1){if(slot!=32&&slot!=35)die("geometry slot");UD_STATE s={0};s.f2=&io;s.f0.e[slot+1]=forged_length;s.f0.e[slot+2]=forged_length;META page={0};UD_STATE r=a0_ud_append(s,slot,append_count,page);code=r.f0.e[0];memcpy(meta,r.f0.e,sizeof meta);if(r.f2!=&io)die("append IO");if(s.f0.e[slot+1]!=forged_length||s.f0.e[0])die("append input changed");}
 else{if(source_words!=4)die("unit words");UNIT_BYTES bytes={0};memcpy(bytes.e,session->allocations[source-1].words,16);UNIT_RESULT r=a0_utf8_unit(bytes,length);code=r.f0;meta[0]=code;meta[1]=r.f1;meta[2]=r.f3;meta[3]=r.f4;meta[15]=r.f5;for(uint32_t i=0;i<4;i++)meta[48+i]=r.f2.e[i];out_length=r.f3;if(out_length>4)die("unit length");if(out_length){decoded=malloc((size_t)out_length*4);if(!decoded)die("unit snapshot");memcpy(decoded,r.f2.e,(size_t)out_length*4);}if(code&&(r.f1||r.f3||r.f4||r.f5))die("failed unit result");}
 enabled=0;if(injected_at!=injected_count)die("proxy reply not drained");if(memcmp(&io,&before,sizeof io))die("buffered IO changed");flags|=4;if(fired)flags|=16;
 if(lifecycle!=2){check_snapshot(old,old_count);flags|=3;}free_snapshot(old,old_count);
 uint32_t allocated_before=a0_arena_allocated_words(session),allocated_after=0,cleanup=0;
 if(lifecycle==1){if(code!=1||!a0_arena_protocol_failed(session)||a0_arena_is_complete(session))die("sticky protocol lifecycle");flags|=64;cleanup=1;allocated_after=0xffffffffu;}
 else if(lifecycle==2){if(code!=5||!a0_arena_is_complete(session)||allocated_before||a0_arena_finish_code(session))die("already finished lifecycle");flags|=128|32;cleanup=2;}
 else{if(a0_arena_protocol_failed(session))die("unexpected protocol failure");FINISHED f=a0_arena_finish(&io,code);if(f.f0||f.f1!=&io||!a0_arena_is_complete(session)||a0_arena_finish_code(session)!=code||a0_arena_allocated_words(session))die("FINISH/drain");flags|=32;allocated_after=a0_arena_allocated_words(session);}
 out(0x55384e50u);out(mode);out(code);out(cleanup);out(flags);out(allocated_before);out(allocated_after);out(out_length);out(origin_length);for(uint32_t i=0;i<128;i++)out(meta[i]);for(uint32_t i=0;i<out_length;i++)out(decoded[i]);for(uint32_t i=0;i<origin_length;i++)out(origins[i]);
 free(decoded);free(origins);a0_arena_destroy(session);if(fclose(input_file)||fclose(output_file))die("close");return 0;
}
