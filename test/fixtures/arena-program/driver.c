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
static void die(const char*s){fprintf(stderr,"%s\n",s);exit(1);}
static void want(uint32_t n){uint32_t v=a0_runtime_read(session);if(v!=n){fprintf(stderr,"protocol got%u expected%u\n",v,n);exit(2);}}
static void send(uint32_t op,uint32_t n,const uint32_t*a){a0_runtime_write(session,op);a0_runtime_write(session,n);for(uint32_t i=0;i<n;i++)a0_runtime_write(session,a[i]);}
static void out(FILE*f,uint32_t v){if(fwrite(&v,4,1,f)!=1)die("write");}
static void load(uint32_t h,uint32_t start,uint32_t n,uint32_t*page){const uint32_t args[]={h,start,n};send(2,3,args);want(0);want(n);for(uint32_t j=0;j<n;j++)page[j]=a0_runtime_read(session);}
static void vector(FILE*f,const uint32_t*p,uint32_t off){uint32_t h=p[off],len=p[off+1];out(f,len);for(uint32_t i=0;i<len;){uint32_t n=len-i>128?128:len-i,page[128];load(h,i,n,page);for(uint32_t j=0;j<n;j++)out(f,page[j]);i+=n;}}
int main(int argc,char**argv){if(argc!=4)die("source output budget");FILE*f=fopen(argv[1],"rb");if(!f)die("open");fseek(f,0,SEEK_END);long size=ftell(f);if(size<0||(uint64_t)size>UINT32_MAX)die("source size");rewind(f);uint32_t n=(uint32_t)size;unsigned char*bytes=malloc((size_t)n+1);if(!bytes)die("malloc");if(fread(bytes,1,n,f)!=n)die("read");fclose(f);session=a0_arena_create((uint32_t)strtoul(argv[3],NULL,10),0);if(!session)die("session");want(0);want(2);want(A0_ARENA_MAGIC);want(1);uint32_t h=0;if(n){send(1,1,&n);want(0);want(1);h=a0_runtime_read(session);for(uint32_t i=0;i<n;){uint32_t k=n-i>128?128:n-i,a[131]={h,i,k};for(uint32_t j=0;j<k;j++)a[j+3]=bytes[i+j];send(3,k+3,a);want(0);want(0);i+=k;}}a0_io io,before;memset(&io,0xa5,sizeof io);memcpy(&before,&io,sizeof io);PARSE_RESULT r=a0_arena_parse_check(&io,h,n);if(r.f2!=&io||memcmp(&io,&before,sizeof io))die("IO identity/content changed");f=fopen(argv[2],"wb");if(!f)die("output");out(f,r.f0);for(uint32_t i=0;i<128;i++)out(f,r.f1.e[i]);const uint32_t offsets[]={32,35,38,41,44,47,50,53,56,59,62,68,71,74,97,100,103,106,115,118,121,124};for(uint32_t i=0;i<sizeof offsets/sizeof offsets[0];i++)vector(f,r.f1.e,offsets[i]);out(f,r.f1.e[67]);for(uint32_t id=0;id<r.f1.e[67];id++){uint32_t entry[128];load(r.f1.e[62],id*5,5,entry);out(f,entry[2]);for(uint32_t i=0;i<entry[2];){uint32_t k=entry[2]-i>128?128:entry[2]-i,page[128];load(entry[0],entry[1]+i,k,page);for(uint32_t j=0;j<k;j++)out(f,page[j]);i+=k;}}fclose(f);for(uint32_t i=0;i<n;){uint32_t k=n-i>128?128:n-i,page[128];load(h,i,k,page);for(uint32_t j=0;j<k;j++)if(page[j]!=bytes[i+j])die("source mutated");i+=k;}uint32_t code=0;send(5,1,&code);want(0);want(0);if(!a0_arena_is_complete(session)||a0_arena_allocated_words(session))die("incomplete");a0_arena_destroy(session);free(bytes);return 0;}
