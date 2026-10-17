#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "fs_runtime.h"
static a0fs_session *session;
#define A0_COMPILER_READ(t) ((void)(t),a0fs_read(session))
#define A0_COMPILER_WRITE(t,v) ((void)(t),a0fs_write(session,(v)))
#include "module.c"
#include "api.h"
static a0_io io,before;
static void die(const char*s){fprintf(stderr,"%s\n",s);exit(1);}
static void want(uint32_t n){uint32_t v=a0fs_read(session);if(v!=n){fprintf(stderr,"protocol%u/%u\n",v,n);exit(2);}}
static void send(uint32_t op,uint32_t n,const uint32_t*a){a0fs_write(session,op);a0fs_write(session,n);for(uint32_t i=0;i<n;i++)a0fs_write(session,a[i]);}
static void load(uint32_t h,uint32_t off,uint32_t n,uint32_t*page){uint32_t a[]={h,off,n};send(2,3,a);want(0);want(n);for(uint32_t i=0;i<n;i++)page[i]=a0fs_read(session);}
static uint32_t uploadwords(const uint32_t*words,uint32_t n,uint32_t cap){if(!cap)return 0;send(1,1,&cap);want(0);want(1);uint32_t h=a0fs_read(session);for(uint32_t i=0;i<n;){uint32_t k=n-i>128?128:n-i,a[131]={h,i,k};for(uint32_t j=0;j<k;j++)a[j+3]=words[i+j];send(3,k+3,a);want(0);want(0);i+=k;}return h;}
static uint32_t upload(const unsigned char*s,uint32_t n){uint32_t*words=malloc(((size_t)n+1)*sizeof *words);if(!words)die("argument words");for(uint32_t i=0;i<n;i++)words[i]=s[i];uint32_t h=uploadwords(words,n,n);free(words);return h;}
static void out(FILE*f,uint32_t n){if(fwrite(&n,4,1,f)!=1)die("output");}
static uint32_t in(FILE*f){uint32_t n;if(fread(&n,4,1,f)!=1)die("input");return n;}
static void bytes(FILE*f,uint32_t h,uint32_t start,uint32_t len){out(f,len);for(uint32_t i=0;i<len;){uint32_t n=len-i>128?128:len-i,page[128];load(h,start+i,n,page);for(uint32_t j=0;j<n;j++)out(f,page[j]);i+=n;}}
static void vector(FILE*f,const uint32_t*p,uint32_t off){bytes(f,p[off],0,p[off+1]);}
static void psdata(FILE*f,const uint32_t*p){for(uint32_t i=0;i<128;i++)out(f,p[i]);const uint32_t offsets[]={32,35,38,41,44,47,50,53,56,59,62,68,71,74};for(uint32_t i=0;i<sizeof offsets/sizeof offsets[0];i++)vector(f,p,offsets[i]);out(f,p[67]);for(uint32_t id=0;id<p[67];id++){uint32_t entry[128];load(p[62],id*5,5,entry);bytes(f,entry[0],entry[1],entry[2]);}}
static void snapshot(FILE*f,uint32_t h){if(!h){out(f,0);return;}out(f,1);uint32_t p[128];load(h,0,128,p);psdata(f,p);}
static void start(uint32_t budget){session=a0fs_create(budget,0);if(!session)die("session");memset(&io,0xa5,sizeof io);memcpy(&before,&io,sizeof io);HELLO_RESULT hello=a0_fs_hello(&io);if(hello.f0||hello.f1!=&io)die("FS negotiation");}
static void finish(void){if(memcmp(&io,&before,sizeof io))die("IO bytes");uint32_t code=0;send(5,1,&code);want(0);want(0);if(!a0fs_is_complete(session)||a0fs_allocated_words(session)||a0fs_protocol_failed(session))die("incomplete");a0fs_destroy(session);}
static int project(const char*input,const char*output){FILE*f=fopen(input,"rb");if(!f)die("project input");uint32_t budget=in(f),on=in(f);uint32_t*ow=malloc(((size_t)on+1)*4);if(!ow)die("origin words");for(uint32_t i=0;i<on;i++)ow[i]=in(f);uint32_t fn=in(f),cap=in(f);uint32_t*fw=malloc(((size_t)fn+1)*4);if(!fw)die("fragment words");for(uint32_t i=0;i<fn;i++)fw[i]=in(f);uint32_t first=in(f),len=in(f);if(fgetc(f)!=EOF)die("project trailing input");fclose(f);start(budget);uint32_t oh=uploadwords(ow,on,on),fh=uploadwords(fw,fn,cap);free(ow);free(fw);ORIGIN_VECTOR ov={oh,on,on},fv={fh,fn,cap};ORIGIN_RESULT r=a0_lc_project(&io,ov,first,len,fv);if(r.f4!=&io)die("project IO");f=fopen(output,"wb");if(!f)die("project output");out(f,r.f0);out(f,r.f2);out(f,r.f3);out(f,r.f1.f0);out(f,r.f1.f1);out(f,r.f1.f2);bytes(f,r.f1.f0,0,r.f1.f1);fclose(f);finish();return 0;}
int main(int argc,char**argv){if(argc==4&&strcmp(argv[1],"project")==0)return project(argv[2],argv[3]);if(argc!=8)die("entry root explicit override dense work output");start(50000000);uint32_t en=(uint32_t)strlen(argv[1]),rn=(uint32_t)strlen(argv[2]),eh=upload((const unsigned char*)argv[1],en),rh=upload((const unsigned char*)argv[2],rn);LINK_RESULT r=a0_arena_link_parse(&io,eh,en,rh,rn,strtoul(argv[3],NULL,10)!=0,(uint32_t)strtoul(argv[4],NULL,10),strtoul(argv[5],NULL,10)!=0,(uint32_t)strtoul(argv[6],NULL,10));if(r.f3!=&io)die("link IO");FILE*f=fopen(argv[7],"wb");if(!f)die("output open");out(f,r.f0);for(uint32_t i=0;i<128;i++)out(f,r.f2.e[i]);const uint32_t offsets[]={32,35,38,41,44,47,50,53,56,59,62,68,74,77,100,103,106,109};for(uint32_t i=0;i<sizeof offsets/sizeof offsets[0];i++)vector(f,r.f2.e,offsets[i]);uint32_t files=r.f2.e[33]/12;out(f,files);for(uint32_t id=0;id<files;id++){uint32_t row[128];load(r.f2.e[32],id*12,12,row);bytes(f,row[0],0,row[1]);bytes(f,row[2],0,row[3]);snapshot(f,row[4]);}out(f,r.f2.e[120]);if(r.f2.e[120])psdata(f,r.f1.e);for(uint32_t op=16;op<=19;op++){uint64_t n=a0fs_calls(session,op);out(f,(uint32_t)n);out(f,(uint32_t)(n>>32));}fclose(f);finish();return 0;}
