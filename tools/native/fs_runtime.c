#define _XOPEN_SOURCE 700
#include "fs_runtime.h"
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
struct a0fs_session {
  a0_arena_session *base;
  uint32_t op,argc,got,args[131],phase,reply[134],rlen,rpos;
  bool failed;
  uint64_t calls[4];
};
static void fail(a0fs_session*s){if(s->failed)return;s->failed=true;s->phase=0;if(s->rpos==s->rlen){s->rpos=0;s->rlen=0;}s->reply[s->rlen++]=1;s->reply[s->rlen++]=0;}
static void reply(a0fs_session*s,uint32_t status,uint32_t n,const uint32_t*p){s->rpos=0;s->rlen=n+2;s->reply[0]=status;s->reply[1]=n;for(uint32_t i=0;i<n;i++)s->reply[i+2]=p[i];}
static uint32_t base(a0fs_session*s,uint32_t op,uint32_t n,const uint32_t*a,uint32_t*p,uint32_t*count){a0_runtime_write(s->base,op);a0_runtime_write(s->base,n);for(uint32_t i=0;i<n;i++)a0_runtime_write(s->base,a[i]);uint32_t status=a0_runtime_read(s->base);*count=a0_runtime_read(s->base);if(*count>128){fail(s);return 1;}for(uint32_t i=0;i<*count;i++)p[i]=a0_runtime_read(s->base);if(a0_arena_protocol_failed(s->base))s->failed=true;return status;}
static uint32_t path(a0fs_session*s,const uint32_t*a,char**out,int*oserror){uint32_t len=a[2];if(len){if(a[1]>UINT32_MAX-len)return 3;uint32_t check[]={a[0],a[1]+len,0},unused[128],count;uint32_t code=base(s,2,3,check,unused,&count);if(code)return code;if(count){fail(s);return 1;}}if((uint64_t)len+1>SIZE_MAX)return 4;char*p=malloc((size_t)len+1);if(!p)return 4;for(uint32_t i=0;i<len;){uint32_t n=len-i>128?128:len-i,args[]={a[0],a[1]+i,n},page[128],count;if(a[1]>UINT32_MAX-i){free(p);return 3;}uint32_t status=base(s,2,3,args,page,&count);if(status){free(p);return status;}if(count!=n){free(p);fail(s);return 1;}for(uint32_t j=0;j<n;j++){if(page[j]>255){free(p);return 3;}if(page[j]==0){free(p);*oserror=EINVAL;return 0;}p[i+j]=(char)page[j];}i+=n;}p[len]=0;*out=p;return 0;}
static uint32_t store(a0fs_session*s,const unsigned char*p,uint32_t len,uint32_t*h){*h=0;if(len==0)return 0;uint32_t page[128],count,status=base(s,1,1,&len,page,&count);if(status)return status;if(count!=1){fail(s);return 1;}*h=page[0];for(uint32_t i=0;i<len;){uint32_t n=len-i>128?128:len-i,args[131]={*h,i,n};for(uint32_t j=0;j<n;j++)args[j+3]=p[i+j];status=base(s,3,n+3,args,page,&count);if(status)return status;if(count!=0){fail(s);return 1;}i+=n;}return 0;}
static uint32_t readfile(const char*p,unsigned char**out,uint32_t*len,int*oserror){FILE*f=fopen(p,"rb");if(!f){*oserror=errno;return 0;}size_t cap=4096,n=0;unsigned char*b=malloc(cap);if(!b){fclose(f);return 4;}for(;;){size_t got=fread(b+n,1,cap-n,f);n+=got;if(got==0){if(ferror(f))*oserror=errno?errno:EIO;break;}if(n==cap){if(cap==UINT32_MAX){free(b);fclose(f);return 4;}size_t next=cap>UINT32_MAX/2?UINT32_MAX:cap*2;unsigned char*q=realloc(b,next);if(!q){free(b);fclose(f);return 4;}b=q;cap=next;}}fclose(f);if(*oserror){free(b);return 0;}*out=b;*len=(uint32_t)n;return 0;}
static void execute(a0fs_session*s){uint32_t result[128],count=0,status=0;if(s->op<=5){status=base(s,s->op,s->argc,s->args,result,&count);reply(s,status,count,result);return;}if(a0_arena_is_finished(s->base)){reply(s,5,0,result);return;}s->calls[s->op-16]++;char*p=NULL,*resolved=NULL;unsigned char*data=NULL;uint32_t len=0,h=0;int os=0;if(s->op!=19)status=path(s,s->args,&p,&os);if(!status&&!os){if(s->op==16){resolved=realpath(p,NULL);if(!resolved)os=errno;else{data=(unsigned char*)resolved;size_t n=strlen(resolved);if(n>UINT32_MAX)status=4;else len=(uint32_t)n;}}else if(s->op==17){status=readfile(p,&data,&len,&os);}else if(s->op==18){struct stat st;if(stat(p,&st)!=0)os=errno;else{uint64_t size=(uint64_t)st.st_size;result[0]=0;result[1]=(uint32_t)st.st_mode;result[2]=(uint32_t)size;result[3]=(uint32_t)(size>>32);}}else if(s->op==19){resolved=getcwd(NULL,0);if(!resolved)os=errno;else{data=(unsigned char*)resolved;size_t n=strlen(resolved);if(n>UINT32_MAX)status=4;else len=(uint32_t)n;}}}if(status){free(p);free(data);reply(s,status,0,result);return;}if(s->op==18){if(os){result[0]=(uint32_t)os;result[1]=result[2]=result[3]=0;}free(p);reply(s,0,4,result);return;}if(!os)status=store(s,data,len,&h);free(p);free(data);if(status){reply(s,status,0,result);return;}result[0]=(uint32_t)os;result[1]=h;result[2]=os?0:len;reply(s,0,3,result);}
static bool shape(uint32_t op,uint32_t n){switch(op){case 1:return n==1;case 2:return n==3;case 3:return n>=3&&n<=131;case 4:return n>=1&&n<=129;case 5:return n==1;case 16:case 17:case 18:return n==3;case 19:return n==0;default:return false;}}
a0fs_session*a0fs_create(uint32_t max_words,uint32_t max_output_words){a0fs_session*s=calloc(1,sizeof*s);if(!s)return NULL;s->base=a0_arena_create(max_words,max_output_words);if(!s->base){free(s);return NULL;}const uint32_t hello[]={0,2,A0_ARENA_MAGIC,1};for(uint32_t i=0;i<4;i++)if(a0_runtime_read(s->base)!=hello[i]){a0fs_destroy(s);return NULL;}const uint32_t ext[]={A0_ARENA_MAGIC,1,A0_FS_MAGIC,1};reply(s,0,4,ext);return s;}
void a0fs_destroy(a0fs_session*s){if(!s)return;a0_arena_destroy(s->base);free(s);}
uint32_t a0fs_read(a0fs_session*s){if(s->rpos==s->rlen){if(!s->failed)fail(s);else{s->rpos=0;s->rlen=2;s->reply[0]=1;s->reply[1]=0;}}uint32_t v=s->reply[s->rpos++];if(s->rpos==s->rlen){s->rpos=s->rlen=0;}return v;}
void a0fs_write(a0fs_session*s,uint32_t word){if(s->failed)return;if(s->rpos!=s->rlen){fail(s);return;}if(s->phase==0){s->op=word;s->phase=1;}else if(s->phase==1){if(!shape(s->op,word)){fail(s);return;}s->argc=word;s->got=0;s->phase=2;if(word==0){s->phase=0;execute(s);}}else{s->args[s->got++]=word;if(s->got==s->argc){s->phase=0;execute(s);}}}
bool a0fs_is_complete(const a0fs_session*s){return !s->failed&&s->phase==0&&s->rpos==s->rlen&&a0_arena_is_complete(s->base);}
bool a0fs_protocol_failed(const a0fs_session*s){return s->failed||a0_arena_protocol_failed(s->base);}
uint32_t a0fs_allocated_words(const a0fs_session*s){return a0_arena_allocated_words(s->base);}

uint64_t a0fs_calls(const a0fs_session*s,uint32_t op){return op>=16&&op<=19?s->calls[op-16]:0;}
