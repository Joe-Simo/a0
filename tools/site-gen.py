"""Generator for the a0lang.com page programs: site/page.a0 (home) and site/docs.a0 (reference).

Reads results/*.json (every number on the pages comes from a results file) and the live-code hero
prototype site/hero-live.html, and emits A0 source; the committed artifacts are the .a0 files.
site/ui.a0 (shared helpers, nav, footer) and site/play.a0 are maintained by hand; the UI string
below documents ui.a0 and is not written. Run from the repo root, then build:
    python3 tools/site-gen.py && bun run site
"""

import json, re, statistics

TAG = {'h1':1,'p':2,'button':3,'code':4,'div':5,'span':6,'ul':7,'li':8,'a':9,'pre':10,'h2':11,'input':12,
       'section':13,'nav':14,'h3':15,'strong':16,'footer':17,'header':18,'table':19,'tr':20,'td':21,'th':22,'small':23,'h6':24,'b':25,'i':26}
ATTR = {'id':1,'class':2,'href':3,'type':4,'placeholder':5,'aria-label':6}

# ---------------------------------------------------------------- stylesheet
CSS = r"""
@font-face{font-family:"Geist";src:url("/fonts/Geist-Variable.woff2") format("woff2");font-weight:100 900;font-display:swap}
@font-face{font-family:"Geist Mono";src:url("/fonts/GeistMono-Variable.woff2") format("woff2");font-weight:100 900;font-display:swap}
@font-face{font-family:"Geist Pixel";src:url("/fonts/GeistPixel-Square.woff2") format("woff2");font-weight:400;font-display:swap}
:root{color-scheme:light dark;--bg:#000;--fg:#fff;--fg2:#d8dbe0;--body:#c9ccd1;--muted:#8a8f98;--dim:#5c6169;--line:#1f2227;--line2:#33373d;--card:#0b0c0e;--pillbg:#fff;--pillfg:#000;--ghost:#17191d;--a0:#ffd166;--c:#7aa2ff;--rust:#f0885a;--gray:#9aa0a6;--win:#5ad19a;--loss:#ff7a7a;--glow1:rgba(120,140,255,.22);--glow2:rgba(255,209,102,.12)}
@media (prefers-color-scheme:light){:root{--bg:#fff;--fg:#0a0a0a;--fg2:#222;--body:#3a3f47;--muted:#6b7079;--dim:#6b7079;--line:#e6e8eb;--line2:#cfd3d8;--card:#fafafa;--pillbg:#0a0a0a;--pillfg:#fff;--ghost:#f0f1f3;--a0:#d99a00;--c:#3b6cf0;--rust:#d9622b;--gray:#8a8f98;--win:#15803d;--loss:#b91c1c;--glow1:rgba(120,140,255,.28);--glow2:rgba(255,190,60,.22)}}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:80px}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 "Geist",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:inherit}
.pixel{font-family:"Geist Pixel","Geist Mono",monospace;font-weight:400}
.mono{font-family:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
.top{position:fixed;inset:0 0 auto 0;z-index:20;height:64px;display:flex;align-items:center;padding:0 28px;background:linear-gradient(var(--bg),transparent)}
.nav{display:flex;align-items:center;gap:28px;width:100%}
.brand{font-size:1.25rem;letter-spacing:.02em;text-decoration:none;margin-right:12px}
.links{display:flex;gap:22px;flex:1}
.links a{color:var(--fg2);text-decoration:none;font-size:.9rem}
.links a:hover{color:var(--fg)}
.pill{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:999px;background:var(--pillbg);color:var(--pillfg);text-decoration:none;font-size:.9rem;font-weight:500}
.pill.ghost{background:var(--ghost);color:var(--fg)}
.pill:hover{filter:brightness(.92)}
@media (max-width:640px){.top{background:var(--bg);border-bottom:1px solid var(--line);height:56px;padding:0 20px}.links{gap:14px}.links a{font-size:.85rem}.pill{padding:6px 12px;font-size:.85rem}}
.hero{position:relative;min-height:100vh;display:flex;align-items:flex-end;justify-content:space-between;padding:0 28px 96px;overflow:hidden}
.hero::before{content:"";position:absolute;inset:0;background:radial-gradient(60% 50% at 70% 35%,var(--glow1),transparent 70%);pointer-events:none;z-index:0}
@keyframes drift{from{transform:translate3d(-3%,-2%,0) scale(1)}to{transform:translate3d(3%,4%,0) scale(1.1)}}
.hero>*{position:relative;z-index:1}
.stage{position:absolute!important;inset:0;z-index:0!important}
.stage canvas.scene{position:absolute;inset:0;width:100%;height:100%;display:block}
.hero .name,.hero .tag{font-size:clamp(3.4rem,11vw,9.5rem);line-height:.95;letter-spacing:-.01em;margin:0;animation:rise .6s cubic-bezier(.2,.7,.2,1) both}
.hero .tag{color:var(--fg2);animation-delay:.08s;text-align:right}
.hero .sub{position:absolute;left:28px;top:calc(50% - 10px);max-width:460px;color:var(--muted);font-size:1.05rem;animation:rise .6s .16s cubic-bezier(.2,.7,.2,1) both}
@keyframes rise{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:none}}
@media (max-width:720px){.hero{flex-direction:column;align-items:flex-start;justify-content:flex-end;gap:8px;padding:96px 20px 56px;min-height:100vh}.hero .tag{text-align:left}}
.center{max-width:720px;margin:0 auto;padding:96px 24px 40px;text-align:center}
.center h2{font-size:clamp(1.9rem,4vw,2.6rem);line-height:1.15;letter-spacing:-.02em;margin:0 auto 20px;font-weight:500;text-wrap:balance;max-width:640px}
.center p{color:var(--body);font-size:1.05rem;margin:0 auto;max-width:600px}
.trio{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;max-width:1080px;margin:40px auto 0;padding:0 24px}
.tcard{position:relative;border:1px solid var(--line);border-radius:18px;background:var(--card);padding:22px 22px 18px;min-height:260px;display:flex;flex-direction:column;overflow:hidden;transition:border-color .3s}
.tcard:hover{border-color:var(--line2)}
.tcard::before{content:"";position:absolute;inset:auto -20% -40% -20%;height:70%;filter:blur(40px);opacity:.55;pointer-events:none}
.tcard.native::before{background:radial-gradient(circle,rgba(255,209,102,.5),transparent 60%)}
.tcard.edits::before{background:radial-gradient(circle,rgba(122,162,255,.5),transparent 60%)}
.tcard.hw::before{background:radial-gradient(circle,rgba(90,209,154,.45),transparent 60%)}
.tcard .k{font-size:.75rem;color:var(--muted);letter-spacing:.08em;text-transform:uppercase}
.tcard .t{font-size:2rem;margin:2px 0 16px;letter-spacing:-.01em}
.tcard .big{font-size:clamp(2.6rem,5vw,3.6rem);line-height:1;margin:8px 0 10px}
.tcard .d{flex:1}
.tcard .big.loss{color:var(--loss)}
.tcard .d{color:var(--body);font-size:.95rem;margin:0 0 16px}
.tcard .f{border-top:1px solid var(--line);padding-top:12px;font-size:.8rem;color:var(--muted);display:grid;gap:4px}
.tcard .f span{font-variant-numeric:tabular-nums}
.layout{display:grid;grid-template-columns:200px minmax(0,760px);gap:56px;justify-content:center;padding:80px 24px 0;max-width:1160px;margin:0 auto}
.rail{position:sticky;top:96px;align-self:start;font-size:.8rem;display:flex;flex-direction:column;gap:10px}
.rail .rh{color:var(--fg2);margin:14px 0 2px}
.rail a{color:var(--muted);text-decoration:none;padding-left:12px}
.rail a:hover{color:var(--fg)}
@media (max-width:900px){.layout{grid-template-columns:minmax(0,1fr);gap:24px;padding-top:56px}.rail{position:static;flex-direction:row;flex-wrap:wrap;gap:8px}.rail .rh{display:none}.rail a{padding:6px 12px;border:1px solid var(--line);border-radius:999px;font-size:.78rem}}
.main h2{font-size:clamp(1.6rem,3vw,2.1rem);font-weight:500;letter-spacing:-.02em;margin:0 0 16px}
.main h3{font-size:1.15rem;font-weight:500;margin:28px 0 8px}
.main p{color:var(--body);margin:0 0 14px;font-size:1.02rem}
.main p strong{color:var(--fg);font-weight:500}
.main section{padding:32px 0 40px;border-top:1px solid var(--line)}
.main section:last-child{padding-bottom:8px}
.main section:first-child{border-top:0;padding-top:0}
.main section.cont{border-top:0;padding-top:0}
.chart{border:1px solid var(--line);border-radius:18px;background:var(--card);padding:22px 22px 18px;margin:22px 0 28px}
.chart .ct{font-size:1.05rem;margin:0 0 4px;font-weight:500;color:var(--fg)}
.chart .sub{color:var(--muted);font-size:.85rem;margin:0 0 16px}
.legend{display:flex;gap:18px;flex-wrap:wrap;font-size:.82rem;color:var(--fg2);margin:0 0 14px}
.legend span::before{content:"";display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;vertical-align:1px}
.legend .la0::before{background:var(--a0)}
.legend .lc::before{background:var(--c)}
.legend .lrust::before{background:var(--rust)}
.legend .lgray::before{background:var(--gray)}
.row{display:grid;grid-template-columns:118px minmax(0,1fr) auto;gap:12px;align-items:center;padding:7px 0;border-top:1px solid var(--line)}
.row:first-of-type{border-top:0}
.row .lbl{font-family:"Geist Mono",ui-monospace,monospace;font-size:.78rem;color:var(--muted)}
.row .ratio{text-align:right;font-variant-numeric:tabular-nums;font-size:.85rem;color:var(--fg);white-space:nowrap}
.row .ratio.loss{color:var(--loss)}
.row .ratio.win{color:var(--win)}
.bars{display:grid;gap:4px}
.track{display:grid;grid-template-columns:1fr 64px;gap:8px;align-items:center;height:9px}
.track .fill{height:7px;border-radius:4px;background:var(--gray);min-width:2px;transition:width .7s cubic-bezier(.2,.7,.2,1)}
.track.a0 .fill{background:var(--a0)}
.track.c .fill{background:var(--c)}
.track.rust .fill{background:var(--rust)}
.fill:not(.grown){width:0!important}
.track .val{transition:none;font-size:.75rem;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap;font-family:"Geist Mono",ui-monospace,monospace}
.single .row{grid-template-columns:150px minmax(0,1fr) auto}
.lrow{display:grid;grid-template-columns:110px 1fr;gap:10px;align-items:center;padding:3px 0}
.rank td.first{color:var(--a0)}
.rank td.behind{color:var(--fg2)}
.lrow .lbl{font-size:.8rem;color:var(--fg2);white-space:nowrap}
.lrow .track{height:10px;grid-template-columns:1fr 64px}
.lrow .track .fill{height:8px}
.lrow.me{background:color-mix(in srgb,var(--fg) 7%,transparent);border-radius:6px;padding-left:6px;padding-right:6px;margin:0 -6px}
.lrow.me .lbl{color:var(--fg);font-weight:600}
.track.nat .fill{background:var(--c)}
.track.jit .fill{background:var(--rust)}
.track.int .fill{background:var(--gray)}
.legend .lnat::before{background:var(--c)}
.legend .ljit::before{background:var(--rust)}
.legend .lint::before{background:var(--gray)}
@media (max-width:600px){.lrow{grid-template-columns:104px 1fr}.rank td.first{color:var(--a0)}
.rank td.behind{color:var(--fg2)}
.lrow .lbl{overflow:hidden;text-overflow:ellipsis}}
.row .lbl{white-space:nowrap}
.row .ratio{padding-right:4px}
@media (max-width:600px){.row,.single .row{grid-template-columns:1fr auto;row-gap:2px}.row .lbl{grid-column:1/-1}.track{grid-template-columns:1fr 58px}.track .val{font-size:.7rem}.row .ratio{font-size:.78rem;white-space:nowrap}}
.cap{color:var(--muted);font-size:.82rem;font-style:italic;margin:14px 0 0;border-top:1px solid var(--line);padding-top:12px}
.plotwrap{display:grid;grid-template-columns:36px 1fr;gap:6px;margin-top:8px}
.yl{position:relative;font-size:.7rem;color:var(--muted);font-family:"Geist Mono",ui-monospace,monospace}
.yl span{position:absolute;right:0;transform:translateY(50%)}
.plot{position:relative;height:280px;margin-top:28px;border-left:1px solid var(--line2);border-bottom:1px solid var(--line2);background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);background-size:100% 18.4%,20% 100%;background-position:0 4%}
.pt{position:absolute;width:11px;height:11px;transform:translate(-50%,50%) rotate(45deg);background:var(--gray);border-radius:2px}
.pt.a0{background:var(--a0)}
.pt.c{background:var(--c)}
.pt.rust{background:var(--rust)}
.pt.haiku{opacity:.5}
.pt .lbl{position:absolute;left:50%;bottom:16px;transform:translateX(-50%) rotate(-45deg);font-size:.66rem;color:var(--muted);white-space:nowrap;font-family:"Geist Mono",ui-monospace,monospace;letter-spacing:.02em}
.pt .lbl.below{bottom:auto;top:16px;transform:translateX(-50%) rotate(-45deg)}
.xl{display:flex;justify-content:space-between;font-size:.7rem;color:var(--muted);font-family:"Geist Mono",ui-monospace,monospace;margin:6px 0 0 42px}
.xt{text-align:center;color:var(--muted);font-size:.78rem;margin:10px 0 0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:20px 0}
.tile{border:1px solid var(--line);border-radius:14px;background:var(--card);padding:16px}
.tile .n{font-size:1.9rem;line-height:1;margin-bottom:8px;font-variant-numeric:tabular-nums}
.tile .n.loss{color:var(--loss)}
.tile p{color:var(--muted);font-size:.8rem;margin:0}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));margin:20px 0}
.grid.two{grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.grid.four{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.card{border:1px solid var(--line);border-radius:14px;background:var(--card);padding:18px}
.card h3{margin:0 0 6px;font-size:1rem}
.card p{color:var(--muted);font-size:.9rem;margin:0}
pre.code{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;overflow:auto;font:13px/1.65 "Geist Mono",ui-monospace,monospace;color:var(--fg2);margin:16px 0 0;white-space:pre}
pre.code .cm{color:var(--dim)}
pre.code+p{margin-top:16px}
pre.wrap{white-space:pre-wrap}
@media (max-width:720px){pre.code{white-space:pre;overflow-x:auto;-webkit-overflow-scrolling:touch;font-size:12px}}
table.ops{width:100%;border-collapse:collapse;font-size:.9rem;margin:12px 0 20px}
.ops th{text-align:left;color:var(--muted);font-weight:500;padding:8px 10px;border-bottom:1px solid var(--line);font-size:.8rem}
.ops td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top;color:var(--fg2)}
.ops td:first-child{white-space:nowrap;color:var(--fg)}
@media (max-width:720px){.ops tr{display:block;padding:8px 0;border-bottom:1px solid var(--line)}.ops td,.ops th{display:block;border:0;padding:2px 0}.ops th:last-child{display:none}.ops td:first-child{white-space:normal}}
.limits{border-left:2px solid var(--loss);padding-left:16px}
.foot{max-width:1160px;margin:32px auto 0;padding:32px 24px 48px;border-top:1px solid var(--line);color:var(--muted);font-size:.85rem;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
.foot a{color:var(--fg2);text-decoration:none}
.card:hover{border-color:var(--line2)}
a:focus-visible,.pill:focus-visible{outline:2px solid var(--c);outline-offset:3px;border-radius:4px}
.reveal{opacity:0;transform:translateY(14px);transition:opacity .5s ease,transform .5s ease}
.reveal.in{opacity:1;transform:none}
.docs .hero{min-height:0;padding:120px 24px 0;align-items:flex-start;flex-direction:column;justify-content:flex-start}
.docs .hero::after{display:none}
.docs .hero .name{font-size:clamp(2.6rem,7vw,5rem)}
@media (prefers-reduced-motion:reduce){.reveal{opacity:1;transform:none;transition:none}.fill{transition:none}.hero::before{animation:none}.hero .name,.hero .tag,.hero .sub{animation:none}}
""".strip('\n')

GLSL = r"""#version 300 es
precision mediump float;
uniform vec2 u_res;uniform float u_time;uniform vec2 u_mouse;uniform float u_dark;
out vec4 o;
float h(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float glyph(vec2 g,float seed){vec2 c=floor(g*vec2(3.,5.));float b=step(.5,h(c+seed));vec2 f=fract(g*vec2(3.,5.));return b*step(.15,f.x)*step(.15,f.y)*step(f.x,.85)*step(f.y,.85);}
void main(){
vec2 px=gl_FragCoord.xy;float cell=16.;
vec2 id=floor(px/cell);vec2 g=fract(px/cell);
float col=id.x;float speed=4.+8.*h(vec2(col,1.));float len=8.+18.*h(vec2(col,2.));
float rows=u_res.y/cell;float head=mod(u_time*speed+h(vec2(col,3.))*rows*3.,rows+len*2.);
float y=rows-id.y;float d=head-y;
float trail=d>=0.&&d<len?1.-d/len:0.;
float flick=floor(u_time*(6.+10.*h(id)));
float gl=glyph(g,floor(h(id+flick)*97.));
float hd=d>=0.&&d<1.?1.:0.;
vec3 green=mix(vec3(0.,.35,.12),vec3(0.,.95,.35),trail);
vec3 c=green*gl*trail*.55+vec3(.75,1.,.8)*gl*hd*.8;
float fade=smoothstep(0.,.35,px.y/u_res.y);
vec3 bg=mix(vec3(.93,.97,.93),vec3(0.),u_dark);
vec3 ink=mix(vec3(0.,.35,.12)*.9,c,u_dark);
float a=mix(.22,1.,u_dark)*fade;
o=vec4(mix(bg,bg+ink*(u_dark>.5?1.:-1.)*1.,a*(gl*max(trail,hd))),1.);
}
"""

# ---------------------------------------------------------------- hero from the prototype
# The live-code hero was designed as plain HTML+CSS (site/hero-live.html). Its CSS from
# `.live{` on is appended to the stylesheet and its `#live` subtree is emitted through the protocol.
from html.parser import HTMLParser
import re as _re
class _Tree(HTMLParser):
    def __init__(self):
        super().__init__(); self.root = ('root', {}, []); self.stack = [self.root]
    def handle_starttag(self, tag, attrs):
        node = (tag, dict(attrs), []); self.stack[-1][2].append(node); self.stack.append(node)
    def handle_endtag(self, tag):
        while len(self.stack) > 1:
            top = self.stack.pop()
            if top[0] == tag: break
    def handle_data(self, data):
        if self.stack[-1] is not self.root: self.stack[-1][2].append(data)
def hero_proto(path):
    html = open(path).read()
    css = _re.search(r'<style>(.*?)</style>', html, _re.S).group(1)
    css = css[css.index('.live{'):].strip()
    body = _re.search(r'<body>(.*?)</body>', html, _re.S).group(1)
    t = _Tree(); t.feed(body)
    def find(n):
        if isinstance(n, tuple):
            if n[1].get('id') == 'live': return n
            for c in n[2]:
                r = find(c)
                if r: return r
    return css, find(t.root)
def emit_tree(n):
    if isinstance(n, str):
        text(n); return
    tag, attrs, kids = n
    open_(tag, cls=attrs.get('class'), id_=attrs.get('id'), href=attrs.get('href'))
    for k in kids: emit_tree(k)
    close()
HERO_CSS, HERO_TREE = hero_proto('site/hero-live.html')
CSS = CSS + '\n' + HERO_CSS + '\n' + r'''/* Matrix theme: black screen, neutral type, green only as light */
:root{--bg:#000;--fg:#ededed;--fg2:#c9c9c9;--body:#a8a8a8;--muted:#6f6f6f;--dim:#4a4a4a;--line:#161616;--line2:#262626;--card:#060606;--pillbg:#000;--pillfg:#00ff41;--ghost:#0d0d0d;--a0:#00ff41;--c:#d9d9d9;--rust:#8c8c8c;--gray:#4d4d4d;--win:#00ff41;--loss:#ff4d4d;--glow1:rgba(0,255,65,.07);--glow2:rgba(0,255,65,.03);--markbg:rgba(0,255,65,.12)}
@media (prefers-color-scheme:light){:root{--bg:#fafafa;--fg:#0a0a0a;--fg2:#262626;--body:#454545;--muted:#6b6b6b;--dim:#8a8a8a;--line:#e6e6e6;--line2:#d4d4d4;--card:#fff;--pillbg:#0a0a0a;--pillfg:#00e03a;--ghost:#f0f0f0;--a0:#00a82d;--c:#2a2a2a;--rust:#8a8a8a;--gray:#c2c2c2;--win:#00852a;--loss:#c62828;--glow1:rgba(0,168,45,.06);--glow2:rgba(0,168,45,.03)}}
body{font-family:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-size:15px;letter-spacing:.01em}
h1,h2,.brand,.tcard .t{font-family:"Geist Pixel","Geist Mono",monospace;font-weight:400}
.hero .name,.hero .tag,.brand,.tcard .big,.tile .n:not(.loss){color:var(--a0)}
@media (prefers-color-scheme:dark){.hero .name,.hero .tag,.tcard .big{text-shadow:0 0 18px rgba(0,255,65,.35)}}
body::after{content:"";position:fixed;inset:0;pointer-events:none;z-index:50;background:repeating-linear-gradient(to bottom,transparent 0,transparent 2px,rgba(0,0,0,.18) 3px)}
@media (prefers-color-scheme:light){body::after{display:none}}
.chart,.tcard,.card,.tile,pre.code{border-radius:3px}
.pill{border-radius:2px;border:1px solid var(--a0);text-transform:uppercase;letter-spacing:.1em;font-size:.75rem}
.pill:hover{background:var(--a0);color:#000;filter:none}
.theme-toggle{background:none;border:1px solid var(--line2);color:var(--fg2);width:34px;height:30px;border-radius:2px;margin-right:12px;cursor:pointer;font:inherit;font-size:1rem;line-height:1}
.theme-toggle:hover{border-color:var(--a0);color:var(--a0)}
.theme-toggle:focus-visible{outline:2px solid var(--a0);outline-offset:2px}
.track .fill{border-radius:1px}
.stage{position:absolute!important;inset:0;z-index:0!important;opacity:.8}
.stage canvas.scene{position:absolute;inset:0;width:100%;height:100%;display:block}
.hero .live{z-index:1}
.live .col{background:rgba(0,0,0,.72);padding:10px 12px;border:1px solid var(--line2);border-radius:3px}
@media (prefers-color-scheme:light){.live .col{background:rgba(250,250,250,.85)}}
.tcard::before{display:none}
.row .ratio.win{color:var(--a0)}
.lrow.me .lbl{color:var(--a0)}
::selection{background:var(--a0);color:#000}
@media (prefers-reduced-motion:reduce){.stage{display:none}}
/* QA fixes */
header.top{background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.col{min-width:0}
.col .ln,.col .ty{font-size:13px}
@media (max-width:640px){.live .col.model,.live .col.asm{display:none}.links{gap:10px}.links a{font-size:.78rem}.pill{padding:6px 9px;font-size:.68rem;letter-spacing:.05em}.nav{gap:12px}}
.tblwrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
.tblwrap table.rank{min-width:540px}
@media (max-width:720px){.tblwrap table.rank tr{display:table-row}.tblwrap table.rank td,.tblwrap table.rank th{display:table-cell;padding:7px 8px}.tblwrap table.rank th:last-child{display:table-cell}}
.lrow{grid-template-columns:132px 1fr}
.lrow .track{display:grid;grid-template-columns:1fr 78px;align-items:center;height:18px}
.track .val{text-align:right;font-variant-numeric:tabular-nums;line-height:1}
.lrow .lbl,.row .lbl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media (max-width:600px){.lrow{grid-template-columns:108px 1fr}}
:root{--muted:#8f8f8f;--dim:#6f6f6f}
@media (prefers-color-scheme:light){:root{--a0:#007a21;--muted:#5f5f5f;--dim:#666}}
.col h6{font-size:11px}
@media (max-width:720px){pre.code.wrap{white-space:pre-wrap;overflow-wrap:anywhere}}
button:focus-visible{outline:2px solid var(--a0);outline-offset:2px}
.theme-toggle{min-width:36px;min-height:34px}
@media (max-width:640px){textarea{font-size:16px!important}}
.lrow.wide .track{grid-template-columns:1fr 104px}
.row .track{grid-template-columns:1fr 88px}
.track .val.loss,.rank td.loss{color:var(--loss)}
.chart .kh{font-size:.78rem;color:var(--fg2);margin:16px 0 4px;padding-top:10px;border-top:1px solid var(--line)}
.chart .kh:first-of-type{border-top:0;padding-top:0}
.chart .tblwrap{margin-top:18px}
@media (max-width:600px){.lrow.wide{grid-template-columns:118px 1fr}.lrow.wide .track{grid-template-columns:1fr 84px}}
/* Layout QA: hero scene columns per breakpoint (the prototype's own rules place the columns) */
/* column widths fit the longest final line (27, 25 and 23 characters at 13px plus padding), so a line being typed never resizes or clips its column */
.hero .live{grid-template-columns:calc(32ch + 26px) calc(29ch + 26px) calc(27ch + 26px)}
.live .col .ln,.live .col .ty{font-size:13px}
.hero .live{font-size:13px;letter-spacing:0}
@media (max-width:960px){.hero .live{grid-template-columns:calc(32ch + 26px) calc(29ch + 26px)}}
@media (max-width:640px){.hero .live{grid-template-columns:minmax(0,1fr);max-width:calc(100vw - 40px)}}
.trio{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.col h6,pre.code .cm{color:var(--muted)}
.chart .cov{display:inline-block;margin:0 0 14px;padding:2px 8px;border:1px solid var(--line2);border-radius:2px;font-size:.72rem;color:var(--fg2);letter-spacing:.02em}
.chart .cov.part{border-color:var(--muted)}
.tblwrap{background:linear-gradient(90deg,var(--card) 30%,transparent) left/40px 100% no-repeat local,linear-gradient(270deg,var(--card) 30%,transparent) right/40px 100% no-repeat local,linear-gradient(90deg,color-mix(in srgb,var(--fg) 14%,transparent),transparent) left/14px 100% no-repeat scroll,linear-gradient(270deg,color-mix(in srgb,var(--fg) 14%,transparent),transparent) right/14px 100% no-repeat scroll}
.tblwrap th,.tblwrap td{white-space:nowrap}
.tblwrap td:first-child,.tblwrap th:first-child{position:sticky;left:0;background:var(--card);z-index:1}
@media (max-width:600px){.layout{padding-left:16px;padding-right:16px}.trio{padding:0 16px}.center{padding-left:16px;padding-right:16px}.chart{padding:16px 14px 14px}.legend{gap:6px 14px}.lrow,.lrow.wide{grid-template-columns:112px 1fr;align-items:start}.lrow .lbl,.lrow.wide .lbl{white-space:normal;overflow:visible;line-height:1.25;padding-top:2px}.foot{padding-left:16px;padding-right:16px}}
@media (max-width:640px){.theme-toggle{margin-right:6px}}
:root[data-theme=light]{color-scheme:light}
:root[data-theme=dark]{color-scheme:dark}
'''


def theme_scope(css):
    """Key every prefers-color-scheme block to the viewer's choice as well as the system setting.

    `@media (prefers-color-scheme:X){R}` becomes the same block with each selector limited to
    `:root` without a forced opposite theme, followed by R limited to `:root[data-theme=X]`.
    `:where()` keeps each selector's specificity, so the cascade order is unchanged; the runtime
    and site/theme.ts only set `data-theme` on <html>.
    """
    other = {'light': 'dark', 'dark': 'light'}

    def scope(body, cond):
        def sel(s):
            s = s.strip()
            return f':root:where({cond}){s[5:]}' if s.startswith(':root') else f':where(:root{cond}) {s}'
        return re.sub(r'([^{}]+)\{([^{}]*)\}', lambda m: ','.join(sel(s) for s in m.group(1).split(',')) + '{' + m.group(2) + '}', body)

    def block(m):
        mode, body = m.group(1), m.group(2)
        return (f'@media (prefers-color-scheme:{mode}){{{scope(body, f":not([data-theme={other[mode]}])")}}}'
                + scope(body, f'[data-theme={mode}]'))
    out = re.sub(r'@media \(prefers-color-scheme:(light|dark)\)\{((?:[^{}]*\{[^{}]*\})*)\}', block, css)
    assert not re.search(r'prefers-color-scheme:(?:light|dark)\)\{(?!:root:where|:where)', out), 'unscoped theme block'
    return out


CSS = theme_scope(CSS)

# ---------------------------------------------------------------- data
_e = json.load(open('results/exec-benchmark.json'))['kernels']
def _h(v): return int(round(v * 100))
_K = [k for k in _e if _e[k]['c'].get('arm64')]
EXEC_ROWS = [(k, [('a0', _h(_e[k]['c']['arm64']['medianNsPerCall'])), ('c', _h(_e[k]['c']['handwritten']['medianNsPerCall'])), ('rust', _h(_e[k]['c']['rust']['medianNsPerCall']))]) for k in _K]
JS_ROWS = [(k, [('a0', _h(_e[k]['js']['emitted']['medianNsPerCall'])), ('c', _h(_e[k]['js']['handwritten']['medianNsPerCall']))]) for k in _e]
BUILD_ROWS = [(k, [('a0', int(round(_e[k]['c']['buildMs']['a0ToNative']))), ('rust', int(round(_e[k]['c']['buildMs']['rustc'])))]) for k in _e]
A0_BUILD = sum(r[1][0][1] for r in BUILD_ROWS); RS_BUILD = sum(r[1][1][1] for r in BUILD_ROWS)
ARM_ROWS = [(k, [('a0', _h(_e[k]['c']['arm64']['medianNsPerCall'])), ('c', _h(_e[k]['c']['emitted']['medianNsPerCall']))]) for k in _e if _e[k]['c'].get('arm64')]
ARM_LOSSES = sorted([(k, _e[k]['c']['arm64VsEmittedC']['ratio']) for k in _e if _e[k]['c'].get('arm64VsEmittedC') and _e[k]['c']['arm64VsEmittedC']['ratio'] > 1.1], key=lambda t: -t[1])
ARM_TIES = sum(1 for k in _e if _e[k]['c'].get('arm64VsEmittedC') and _e[k]['c']['arm64VsEmittedC']['ratio'] <= 1.1)
ARM_TEXT = ' A0\'s own AArch64 code generator ties clang on ' + str(ARM_TIES) + ' of ' + str(ARM_TIES + len(ARM_LOSSES)) + ' kernels' + ((' and is behind on ' + ', '.join(f'{k} ({r:.2f}x)' for k, r in ARM_LOSSES)) if ARM_LOSSES else '') + '.'
INTERP_ROWS = [(k, [('a0', _h(_e[k]['c']['arm64']['medianNsPerCall'])), ('c', _h(_e[k]['js']['handwritten']['medianNsPerCall'])), ('rust', _h(_e[k]['python']['medianNsPerCall']))]) for k in _K]
START_ROWS = [(k, [('a0', _h(_e[k]['c']['startupMs']['emitted'])), ('c', _h(_e[k]['startupInterpretersMs']['node'])), ('rust', _h(_e[k]['startupInterpretersMs']['python']))]) for k in _e]
PY_GEOMEAN = int(round(statistics.geometric_mean([_e[k]['python']['medianNsPerCall']/_e[k]['c']['arm64']['medianNsPerCall'] for k in _K])))
JS_GEOMEAN = int(round(statistics.geometric_mean([_e[k]['js']['handwritten']['medianNsPerCall']/_e[k]['c']['arm64']['medianNsPerCall'] for k in _K])))
START_RATIO = int(round(statistics.geometric_mean([_e[k]['startupInterpretersMs']['node']/_e[k]['c']['startupMs']['emitted'] for k in _e])))
C_RATIO = statistics.geometric_mean([_e[k]['c']['arm64']['medianNsPerCall']/_e[k]['c']['handwritten']['medianNsPerCall'] for k in _K])
BUILD_RATIO = RS_BUILD / A0_BUILD
BIN_BYTES = _e['affine']['c']['binaryBytes']['emitted']
START_A0 = statistics.median(_e[k]['c']['startupMs']['emitted'] for k in _e)

def _exp(path):
    r = json.load(open(path)); agg = {}
    for c in r['trials']:
        k = c['representation'] + '/' + c['protocol']; a = agg.setdefault(k, {'one':0,'n':0,'lang':0,'wf':0,'ctx':0,'out':0,'calls':0})
        a['n'] += 1; a['one'] += 1 if c['acceptedOneShot'] else 0; b = c['tokenBucketsLocal']
        a['lang'] += b['languagePrimer']; a['wf'] += b['workflowPrimer']; a['ctx'] += b['toolContext']; a['out'] += b['output']; a['calls'] += c['modelCalls']
    out = {}
    for k, a in agg.items():
        per = (a['lang'] + a['wf']) / a['calls']; cached = (per*1.25 + per*(a['calls']-1)*0.05 + a['ctx'] + a['out']) / a['n']
        out[k] = (int(round(cached)), int(round(100*a['one']/a['n'])), int(round(a['out']/a['n'])))
    return out
SCATTER = []
for label, path in [('Sonnet, set A','results/ai-edit-experiment.sonnet-min.json'),('Haiku, set A','results/ai-edit-experiment.haiku-min.json'),('Sonnet, set B','results/ai-edit-experiment.b.sonnet-min.json'),('Haiku, set B','results/ai-edit-experiment.b.haiku-min.json')]:
    for cell, (cost, acc, out) in _exp(path).items(): SCATTER.append((label, cell, cost, acc, out))
XMAX = ((max(c for _, _, c, _, _ in SCATTER) + 49) // 50) * 50
def _cell_c(model, rep):
    r = json.load(open(f'results/ai-edit-experiment.c.{model}-min.json')); n=0; acc=0; p=0; ctx=0; out=0; calls=0
    for c in r['trials']:
        if c['representation'] != rep or c['protocol'] != 'structured': continue
        n += 1; acc += 1 if c['accepted'] else 0; b = c['tokenBucketsLocal']; p += b['languagePrimer'] + b['workflowPrimer']; ctx += b['toolContext']; out += b['output']; calls += c['modelCalls']
    per = p / calls
    return (int(round((per * 1.25 + ctx + out) / n)), int(round(100 * acc / n)))
C_S = {rep: _cell_c('sonnet', rep) for rep in ['a0', 'ts', 'rust']}
_bench = json.load(open('results/exec-benchmark.json'))
_core = {'c': ('C', 'compiled-native', lambda k: _e[k]['c']['handwritten']['medianNsPerCall']),
         'rust': ('Rust', 'compiled-native', lambda k: _e[k]['c']['rust']['medianNsPerCall']),
         'js': ('JavaScript', 'jit', lambda k: _e[k]['js']['handwritten']['medianNsPerCall'])}
LANGS = []
for lid, (label, fam, get) in _core.items():
    LANGS.append((label, fam, statistics.geometric_mean([get(k) / _e[k]['c']['arm64']['medianNsPerCall'] for k in _K])))
for lid, meta in _bench['languages'].items():
    if meta.get('status') != 'ran': continue
    ks = [k for k in _K if isinstance(_e[k].get(lid), dict) and _e[k][lid].get('status') == 'ran']
    if not ks: continue
    LANGS.append((meta['label'], meta['family'], statistics.geometric_mean([_e[k][lid]['medianNsPerCall'] / _e[k]['c']['arm64']['medianNsPerCall'] for k in ks])))
LANGS.append(('A0', 'a0', 1.0))
LANGS.sort(key=lambda t: (t[2], t[0] != 'A0'))
import math
_gmin = min(g for _, _, g in LANGS) * 0.97
_lmax = math.log10(max(g for _, _, g in LANGS) / _gmin)
def _pct(g): return 3 + int(round(97 * math.log10(g / _gmin) / _lmax))
N_LANGS = len(LANGS) - 1
_labels = {lid: m['label'] for lid, m in _bench['languages'].items()}
RANKS = []
for k in _K:
    e = [('A0', _e[k]['c']['arm64']['medianNsPerCall']), ('C', _e[k]['c']['handwritten']['medianNsPerCall']), ('Rust', _e[k]['c']['rust']['medianNsPerCall']), ('JavaScript', _e[k]['js']['handwritten']['medianNsPerCall'])]
    for lid, lab in _labels.items():
        v = _e[k].get(lid)
        if isinstance(v, dict) and v.get('status') == 'ran': e.append((lab, v['medianNsPerCall']))
    e.sort(key=lambda t: t[1])
    rank = [n for n, _ in e].index('A0') + 1
    best = e[0] if e[0][0] != 'A0' else e[1]
    a0 = dict(e)['A0']
    RANKS.append((k, rank, len(e), best[0], best[1], a0))
# The full language set of exec-bench: A0, C, Rust, JavaScript, and every language that ran.
# Every comparison chart is drawn against it; one that lacks measurements says how many it has.
ALL_LANGS = ['A0', 'C', 'Rust', 'JavaScript'] + [m['label'] for m in _bench['languages'].values() if m.get('status') == 'ran']
N_ALL = len(ALL_LANGS)
COVERAGE = []
def coverage(chart_name, labels):
    have = [l for l in ALL_LANGS if l in set(labels)]
    extra = sorted(set(labels) - set(ALL_LANGS))
    assert not extra, f'{chart_name}: labels outside the exec-bench set: {extra}'
    COVERAGE.append((chart_name, len(have), [l for l in ALL_LANGS if l not in have]))
    el('p', f'measured: {len(have)} of {N_ALL} languages', cls='cov mono' + ('' if len(have) == N_ALL else ' part'))
STARTS = [('A0', 'a0', statistics.median(_e[k]['c']['startupMs']['emitted'] for k in _K)),
          ('C', 'compiled-native', statistics.median(_e[k]['c']['startupMs']['handwritten'] for k in _K))]
for grp in ('startupInterpretersMs', 'startupCompiledMs'):
    ids = set()
    for k in _K: ids |= set((_e[k].get(grp) or {}).keys())
    for lid in ids:
        vals = [_e[k][grp][lid] for k in _K if lid in (_e[k].get(grp) or {})]
        lab = 'JavaScript' if lid == 'node' else _labels.get(lid, lid)
        fam = 'a0' if False else (_bench['languages'].get(lid, {}).get('family') or ('jit' if lid == 'node' else 'interpreted'))
        STARTS.append((lab, fam, statistics.median(vals)))
START_NODE = next(v for l, _, v in STARTS if l == 'JavaScript'); START_PY = next(v for l, _, v in STARTS if l == 'Python')
STARTS.sort(key=lambda t: t[2])
_smax = math.log10(max(v for _, _, v in STARTS) / min(v for _, _, v in STARTS))
_smin = min(v for _, _, v in STARTS)
def _spct(v): return 3 + int(round(97 * math.log10(v / _smin) / _smax))
START_RANK = [n for n, _, _ in STARTS].index('A0') + 1
TIES = [l for l, f, g in LANGS if 0.95 <= g <= 1.05 and f != 'a0']
AHEAD = [l for l, _, g in LANGS if g < 0.95]
C_H = {rep: _cell_c('haiku', rep) for rep in ['a0', 'ts', 'rust']}
def _cell_set(name, model, rep):
    r = json.load(open(f'results/ai-edit-experiment.{name}.{model}-min.json')); n=0; acc=0; p=0; ctx=0; out=0; calls=0
    for c in r['trials']:
        if c['representation'] != rep or c['protocol'] != 'structured': continue
        n += 1; acc += 1 if c['accepted'] else 0; b = c['tokenBucketsLocal']; p += b['languagePrimer'] + b['workflowPrimer']; ctx += b['toolContext']; out += b['output']; calls += c['modelCalls']
    per = p / calls
    return (int(round((per * 1.25 + ctx + out) / n)), int(round(100 * acc / n)))
D_S = {rep: _cell_set('d', 'sonnet', rep) for rep in ['a0', 'ts', 'rust']}
D_H = {rep: _cell_set('d', 'haiku', rep) for rep in ['a0', 'ts', 'rust']}
def cell(label, c): return [s for s in SCATTER if s[0] == label and s[1] == c][0]
A0_A = cell('Sonnet, set A', 'a0/structured'); TS_A = cell('Sonnet, set A', 'ts/structured')
A0_B = cell('Sonnet, set B', 'a0/structured'); TS_B = cell('Sonnet, set B', 'ts/structured')
ACC = {l: cell(l, 'a0/structured')[3] for l in ['Sonnet, set A','Haiku, set A','Sonnet, set B','Haiku, set B']}
import os

COST_LANGS = [('a0', 'A0'), ('ts', 'TypeScript'), ('rust', 'Rust'), ('python', 'Python'), ('go', 'Go'),
              ('java', 'Java'), ('csharp', 'C#'), ('cpp', 'C++')]
COST_SIZES = [('b', 1), ('c', 40), ('c400', 400), ('c4000', 4000)]


def _cost_cell(path, rep):
    """Structured-protocol cell of one results file: cache-adjusted tokens per edit, split into
    primer (language + workflow primer, first read at 1.25x), code read, and write; plus acceptance."""
    if not os.path.exists(path): return None
    ts = [c for c in json.load(open(path))['trials'] if c['representation'] == rep and c['protocol'] == 'structured']
    if not ts: return None
    n = len(ts); calls = sum(c['modelCalls'] for c in ts)
    b = [c['tokenBucketsLocal'] for c in ts]
    primer = sum(x['languagePrimer'] + x['workflowPrimer'] for x in b) / calls * 1.25
    code = sum(x['toolContext'] for x in b) / n
    write = sum(x['output'] for x in b) / n
    acc = 100 * sum(1 for c in ts if c['accepted']) / n
    return {'primer': round(primer), 'code': round(code), 'write': round(write),
            'total': round(primer + code + write), 'acc': round(acc), 'n': n}


def cost_table():
    out = {}
    for tset, size in COST_SIZES:
        rows = []
        for rep, label in COST_LANGS:
            cells = {}
            for model in ('sonnet', 'haiku'):
                kind = 'min' if rep in ('a0', 'ts', 'rust') else 'langs'
                cells[model] = _cost_cell(f'results/ai-edit-experiment.{tset}.{model}-{kind}.json', rep)
            if cells['sonnet'] is None: continue
            rows.append((rep, label, cells['sonnet'], cells['haiku']))
        out[size] = rows
    return out

COST = cost_table()
def _cost(size, rep): return next(r for r in COST[size] if r[0] == rep)
C4K_A0 = _cost(4000, 'a0'); C4K_TS = _cost(4000, 'ts')
ONE_A0 = _cost(1, 'a0'); ONE_TS = _cost(1, 'ts')

# Validation latency (reply received -> edit applied and program type-checked). A quiet-machine
# run, when it exists, replaces the loaded one and its caveat.
_EL_QUIET = os.path.exists('results/edit-loop.quiet.json')
_el = json.load(open('results/edit-loop.quiet.json' if _EL_QUIET else 'results/edit-loop.json'))
EL_LOAD = max(max(x['loadavg']) for x in _el.get('load', [])) if _el.get('load') else None
_EL_LABELS = {'a0.structured': 'A0 structured', 'a0.conventional': 'A0 whole file', 'ts.warm': 'TypeScript warm',
              'ts.cold': 'TypeScript cold', 'rust.warm': 'Rust warm', 'rust.cold': 'Rust cold',
              'go.build.warm': 'Go build warm', 'go.build.cold': 'Go build cold', 'go.vet.warm': 'Go vet warm'}
EDIT_LOOP = sorted([(_EL_LABELS.get(r['kind'], r['kind']), r['kind'].split('.')[0], r['medianMs'], r['p90Ms'])
                    for r in _el['sonnet']['rows']], key=lambda t: t[2])
EL_A0 = next(r for r in _el['sonnet']['rows'] if r['kind'] == 'a0.structured')
EL_TSW = next(r for r in _el['sonnet']['rows'] if r['kind'] == 'ts.warm')

# Parallel folds: every baseline over A0 with the automatic cost model (src/parallel.ts).
_par = json.load(open('results/parallel.json'))
PAR_LABELS = [('a0_auto', 'A0'), ('c_openmp', 'C + OpenMP'), ('c', 'C'), ('rust', 'Rust'),
              ('zig', 'Zig'), ('go', 'Go'), ('java', 'Java'), ('js', 'JavaScript'), ('python', 'Python')]
PAR = [(k, v['trips'], v['medianNsPerCall']['a0_auto'],
        sorted([(lab, lid, v['baselineOverA0Auto'][lid]) for lid, lab in PAR_LABELS if lid in v['baselineOverA0Auto']], key=lambda t: t[2]))
       for k, v in _par['kernels'].items()]
PAR_QUIET = bool(_par['load'].get('quiet'))
PAR_LOAD = max(_par['load']['atTimingStart'])
PAR_LOSSES = [(k, lab, r) for k, _, _, rows in PAR for lab, lid, r in rows if lid != 'a0_auto' and r < 1]

# ---------------------------------------------------------------- emitter
lines = []; cur = 'tok'; k = 0
SECTIONS = []; _stack = []
def nid():
    global k; k += 1; return f'x{k}'
def esc(s): return s.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n')
def w(word):
    global cur; n = nid(); lines.append(f'{n} write {cur} {word}'); cur = n
def call(fn, *args):
    global cur; n = nid(); lines.append(f'{n} call {fn} {cur} ' + ' '.join(str(a) for a in args)); cur = n
def puts_lit(s):
    global cur; lit = nid(); lines.append(f'{lit} text "{esc(s)}"'); n = nid(); lines.append(f'{n} puts {cur} {lit}'); cur = n
def text(s):
    if s == '': return
    w(2); puts_lit(s)
def attr(key, value): w(4); w(ATTR[key]); puts_lit(value)
def open_(tag, cls=None, id_=None, href=None, **kw):
    call('open', TAG[tag])
    if id_: attr('id', id_)
    if cls: attr('class', cls)
    if href: attr('href', href)
    for key, v in kw.items(): attr(key.replace('_', '-'), v)
def close(): call('close')
def el(tag, s=None, cls=None, id_=None, href=None, **kw):
    open_(tag, cls, id_, href, **kw)
    if s is not None: text(s)
    close()
def node(expr):
    n = nid(); lines.append(f'{n} {expr}'); return n
def begin(name):
    global lines, cur
    _stack.append((lines, cur, name)); lines = []; cur = 'p0'
def end():
    global lines, cur
    body, ended = lines, cur
    saved_lines, saved_cur, name = _stack.pop()
    SECTIONS.append(f"fn {name} io -> io\n" + '\n'.join(body) + f"\nret {ended}\nend\n")
    lines, cur = saved_lines, saved_cur
    n = nid(); lines.append(f'{n} call {name} {cur}'); cur = n
def shader_chunks():
    chunk = ''
    for line in GLSL.split('\n'):
        if len((chunk + line + '\n').encode()) > 1000:
            w(13); puts_lit(chunk); chunk = ''
        chunk += line + '\n'
    if chunk: w(13); puts_lit(chunk)
def css_chunks():
    chunk = ''
    for line in CSS.split('\n'):
        if len((chunk + line + '\n').encode()) > 1000:
            w(9); puts_lit(chunk); chunk = ''
        chunk += line + '\n'
    if chunk: w(9); puts_lit(chunk)
def reset():
    global lines, cur, k, SECTIONS
    lines = []; cur = 'tok'; k = 0; SECTIONS = []

# --- chart pieces
def track(cls, v, mx, unit, fixed=True):
    open_('div', cls=f'track {cls}')
    call('fill', v, mx)
    open_('span', cls='val'); call('putfix' if fixed else 'putnum', v); text(unit); close()
    close()
def ratio_label(num, den, suffix, cls_by=None):
    r = node(f'mul {num} 100'); q = node(f'div {r} {den}')
    open_('span', cls='ratio' + (f' {cls_by}' if cls_by else ''))
    call('putratio', q); text(suffix); close()
_chart_n = [0]
def chart(title, sub, legend, rows, unit, ratio_fn, cap, single=False, fixed=True, langs=None):
    _chart_n[0] += 1
    begin(f'chart{_chart_n[0]}')
    open_('div', cls='chart' + (' single' if single else '') + ' reveal')
    el('p', title, cls='ct'); el('p', sub, cls='sub')
    if langs is not None: coverage(title, langs)
    if legend:
        open_('div', cls='legend')
        for lc, lt in legend: el('span', lt, cls=lc)
        close()
    for label, series in rows:
        open_('div', cls='row')
        el('span', label, cls='lbl')
        open_('div', cls='bars')
        ids = [node(f'mov {v}') for _, v in series]
        mx = node(f'call max3 {ids[0]} {ids[1]} {ids[2]}') if len(ids) == 3 else node(f'call max2 {ids[0]} {ids[1]}')
        for (cls, _), i in zip(series, ids): track(cls, i, mx, unit, fixed)
        close()
        ratio_fn(ids, series)
        close()
    el('p', cap, cls='cap')
    close()
    end()

def endsec():
    begin(f'endsec{k}'); close(); end()

def nav(active):
    call('nav')

def footer():
    call('foot')

# ---------------------------------------------------------------- shared helpers (site/ui.a0)
UI = '''# Shared UI helpers for a0lang.com programs (site/page.a0, site/docs.a0). Protocol words:
#   1 OPEN tag | 2 TEXT n bytes | 3 CLOSE | 4 ATTR key n bytes | 5 ONCLICK event | 6 STATE n words
#   9 STYLE n bytes | 12 SIZE prop percent (1 width 2 height 3 left 4 bottom)
fn open io u32 -> io
a write p0 1
b write a p1
ret b
end
fn close io -> io
a write p0 3
ret a
end
fn mulstep u32 u32 -> u32
m mul p0 10
ret m
end
# 10^p1 (p1 <= 9)
fn tenpow u32 -> u32
r fold mulstep p0 1
ret r
end
fn digitstep u32 u32 u32 -> u32
s add p0 1
ret s
end
fn morecheck u32 u32 u32 -> bool
p call tenpow p0
fits lt p2 p
more select fits false true
ret more
end
# number of decimal digits of n
fn ndigits u32 -> u32
n loop morecheck digitstep 10 1 p0
ret n
end
fn putdigit io u32 u32 u32 -> io
rest sub p3 p1
pos sub rest 1
p call tenpow pos
q div p2 p
d rem q 10
ch add d 48
t write p0 2
u write t 1
v write u ch
ret v
end
# TEXT command with the decimal rendering of p1
fn putnum io u32 -> io
nd call ndigits p1
t fold putdigit nd p0 p1 nd
ret t
end
# TEXT with p1 rendered in hundredths: 2151 -> "21.51"
fn putfix io u32 -> io
ip div p1 100
fp rem p1 100
a call putnum p0 ip
b write a 2
dot text "."
c puts b dot
tens div fp 10
ones rem fp 10
d0 add tens 48
d1 add ones 48
d write c 2
e write d 2
f write e d0
g write f d1
ret g
end
# div.fill sized to p1/p2 of the track (SIZE width percent computed here)
fn fill io u32 u32 -> io
a call open p0 5
b write a 4
c write b 2
cls text "fill"
d puts c cls
e write d 12
f write e 1
num mul p1 100
pct div num p2
g write f pct
h call close g
ret h
end
# ratio in hundredths, printed with the precision that reads well: 408x, 16.7x, 1.06x
fn r_int io u32 u32 -> io
q div p2 100
r call putnum p0 q
ret r
end
fn r_one io u32 u32 -> io
q div p2 100
a call putnum p0 q
b write a 2
dot text "."
c puts b dot
tn div p2 10
td rem tn 10
ch add td 48
d write c 2
e write d 1
f write e ch
ret f
end
fn r_two io u32 u32 -> io
r call putfix p0 p2
ret r
end
fn putratio io u32 -> io
big ge p1 10000
mid ge p1 1000
nb select big 1 0
nm0 select mid 1 0
nm select big 0 nm0
rest add nb nm
ns sub 1 rest
a fold r_int nb p0 p1
b fold r_one nm a p1
c fold r_two ns b p1
ret c
end
fn max3 u32 u32 u32 -> u32
ab lt p0 p1
m1 select ab p1 p0
mc lt m1 p2
m2 select mc p2 m1
ret m2
end
fn max2 u32 u32 -> u32
ab lt p0 p1
m select ab p1 p0
ret m
end
'''

# ---------------------------------------------------------------- home page
def gen_page():
    reset()
    css_chunks()
    nav('home')
    begin('sec_hero')
    open_('section', cls='hero', id_='top')
    open_('div', cls='stage'); shader_chunks(); close()
    emit_tree(HERO_TREE)
    el('h1', 'A0', cls='name pixel')
    el('p', 'for AI', cls='tag pixel')
    close()
    end()
    begin('sec_intro')
    open_('div', cls='center')
    el('h2', 'Native speed. Verified edits. Every target.')
    el('p', 'A model writes A0 directly. Nothing invalid lands. One source runs on every target, checked against one oracle.')
    close()
    open_('div', cls='trio')
    # native
    open_('div', cls='tcard native reveal')
    el('div', 'Native', cls='k'); el('div', 'Machine code', cls='t pixel')
    open_('div', cls='big pixel'); text(f'{PY_GEOMEAN}x'); close()
    el('p', f'faster than Python, {JS_GEOMEAN}x faster than JavaScript, measured against {N_LANGS} languages. Machine code from A0\'s own code generator.', cls='d')
    close()
    # edits
    open_('div', cls='tcard edits reveal')
    el('div', 'Edits', cls='k'); el('div', 'Made by models', cls='t pixel')
    open_('div', cls='big pixel'); text(f'{int(C4K_TS[2]["total"] / C4K_A0[2]["total"])}x'); close()
    el('p', f'fewer tokens per edit than TypeScript in a 4000-function program, {C4K_A0[2]["acc"]}% accepted (Sonnet). On a one-function file A0 costs more.', cls='d')
    close()
    # hardware
    open_('div', cls='tcard hw reveal')
    el('div', 'Hardware', cls='k'); el('div', 'Gates and cycles', cls='t pixel')
    open_('div', cls='big pixel'); text('70%'); close()
    el('p', 'fewer gates for the same programs, proved equivalent with Z3.', cls='d')
    close()
    close()
    end()
    # ---- narrative + charts
    begin('sec_rail')
    open_('div', cls='layout')
    open_('nav', cls='rail')
    el('div', 'Benchmarks', cls='rh')
    el('a', 'Native speed', href='#native')
    el('a', f'{N_LANGS} languages', href='#languages')
    el('a', 'Startup', href='#startup')
    el('a', 'Tokens', href='#tokens')
    el('a', 'Cost', href='#cost')
    el('a', 'Validation', href='#validation')
    el('a', 'Parallel folds', href='#parallel')
    el('a', 'Hardware', href='#hardware')
    el('div', 'More', cls='rh')
    el('a', 'Targets', href='#targets')
    el('a', 'Developers', href='#developers')
    close()
    open_('div', cls='main', id_='benchmarks')
    end()
    # -- native
    begin('sec_native')
    open_('section', id_='native')
    el('h2', 'Native speed')
    open_('p'); text('No runtime, no garbage collector. '); el('strong', f'{C_RATIO:.2f}x'); text(f' the time of hand-written C across {len(_K)} kernels, from A0\'s own AArch64 code generator; no C compiler is involved.'); close()
    end()
    begin('rank_table')
    open_('div', cls='chart reveal')
    el('p', f'A0\'s rank on each kernel, among all {N_LANGS + 1} languages', cls='ct')
    el('p', 'Time per call, lower is better. Median of 7 interleaved runs; every result checksum-verified.', cls='sub')
    coverage('A0 rank per kernel', [n for n, _, _ in LANGS])
    open_('div', cls='tblwrap')
    open_('table', cls='ops rank')
    open_('tr'); el('th', 'kernel'); el('th', 'A0 rank'); el('th', 'fastest other'); el('th', 'A0 vs fastest other'); close()
    for k, rank, n, bl, bv, a0v in RANKS:
        open_('tr')
        el('td', k, cls='mono')
        open_('td', cls='mono' + (' first' if rank == 1 else '')); call('putnum', node(f'mov {rank}')); text(f' of {n}'); close()
        el('td', f'{bl} ({bv:.2f} ns)')
        open_('td', cls='mono' + (' first' if a0v <= bv else ' behind')); call('putratio', node(f'mov {int(round(100 * a0v / bv))}')); text('x'); close()
        close()
    close()
    close()
    el('p', 'A0 is machine code from A0\'s own AArch64 code generator. At 1.00x or below A0 is fastest; above, the gap to close.', cls='cap')
    close()
    end()
    endsec()
    begin('sec_langs')
    open_('section', id_='languages')
    el('h2', f'Against {N_LANGS} languages')
    open_('p'); text(f'The same ten kernels, hand-written in {N_LANGS} languages, every result checksum-verified before it is timed. Time per call relative to native A0, geometric mean. '); el('strong', f'{len(TIES)} tie A0 within 5%'); text(f', {len(AHEAD)} are faster today' + (' (' + ', '.join(AHEAD) + '; closing that gap is the current compiler work)' if AHEAD else '') + ', and the rest are slower.'); close()
    end()
    begin('chart_langs')
    open_('div', cls='chart langs reveal')
    el('p', 'Time per call relative to native A0, lower is better', cls='ct')
    el('p', 'Bar length is logarithmic in the ratio; 1.00x is parity with A0. Interleaved runs, medians; JIT rows warm; interpreters at their own iteration tier.', cls='sub')
    coverage('Time per call relative to A0', [n for n, _, _ in LANGS])
    open_('div', cls='legend'); el('span', 'A0', cls='la0'); el('span', 'compiled', cls='lnat'); el('span', 'JIT or VM', cls='ljit'); el('span', 'interpreted', cls='lint'); close()
    for label, fam, g in LANGS:
        cls = 'a0' if fam == 'a0' else 'nat' if fam == 'compiled-native' else 'int' if fam == 'interpreted' else 'jit'
        open_('div', cls='lrow' + (' me' if fam == 'a0' else ''))
        el('span', label, cls='lbl')
        open_('div', cls='track ' + cls)
        open_('div', cls='fill'); w(12); w(1); w(_pct(g)); close()
        open_('span', cls='val'); call('putratio', node(f'mov {int(round(g * 100))}')); text('x'); close()
        close()
        close()
    el('p', 'A0 here is machine code from A0\'s own AArch64 code generator, no C compiler in between. Numbers, toolchains, and iteration tiers are in results/exec-benchmark.json.', cls='cap')
    close()
    end()
    endsec()
    begin('sec_start')
    open_('section', id_='startup')
    el('h2', 'Startup')
    open_('p'); el('strong', f'{START_A0:.2f} ms'); text(f' from launch to first result. Node takes {START_NODE:.0f} ms and Python {START_PY:.0f} ms. Build: {A0_BUILD} ms for ten kernels, {RS_BUILD} ms with rustc.'); close()
    end()
    begin('chart_start')
    open_('div', cls='chart langs reveal')
    el('p', f'Milliseconds from launch to first result, {len(STARTS)} languages', cls='ct')
    el('p', f'Lower is better; bar length is logarithmic. A0 is number {START_RANK}. One process launch running one iteration; JVM and .NET rows include their runtime start.', cls='sub')
    coverage('Startup', [n for n, _, _ in STARTS])
    open_('div', cls='legend'); el('span', 'A0', cls='la0'); el('span', 'compiled', cls='lnat'); el('span', 'JIT or VM', cls='ljit'); el('span', 'interpreted', cls='lint'); close()
    for label, fam, v in STARTS:
        cls = 'a0' if label == 'A0' else 'nat' if fam == 'compiled-native' else 'int' if fam == 'interpreted' else 'jit'
        open_('div', cls='lrow' + (' me' if label == 'A0' else ''))
        el('span', label, cls='lbl')
        open_('div', cls='track ' + cls)
        open_('div', cls='fill'); w(12); w(1); w(_spct(v)); close()
        open_('span', cls='val'); call('putfix', node(f'mov {int(round(v * 100))}')); text(' ms'); close()
        close()
        close()
    el('p', 'The A0 binary for startup is the C-path build; startup of the direct AArch64 binary is not yet measured.', cls='cap')
    close()
    end()
    endsec()
    # -- tokens
    begin('sec_tok')
    open_('section', id_='tokens')
    el('h2', 'Tokens')
    open_('p'); text('A model reads one function and its callees, not the file. '); el('strong', '7.3x fewer tokens read'); text(' per edit; the reply is 9 tokens where a unified diff is 79.'); close()
    end()
    tok = lambda ids, s: ratio_label(ids[0], ids[1], 'x fewer', 'win')
    chart('Tokens read to edit one function', 'Life, 17 functions, o200k tokenizer. Lower is better.',
          [('lc', 'whole program'), ('la0', 'A0 scoped view')], [('life.a0', [('c', 1746), ('a0', 239)])], ' tok', tok,
          'The view: one function, its callees\' signatures, one handle.', single=True, fixed=False)
    endsec()
    # -- cost: project scale
    begin('sec_cost')
    open_('section', id_='cost')
    el('h2', 'Cost')
    r4 = C4K_TS[2]['total'] / C4K_A0[2]['total']; r1 = ONE_A0[2]['total'] / ONE_TS[2]['total']
    open_('p'); text('A model edits one function through a scoped view: the function, the signatures it depends on, and its callers. The view stays the same size as the program grows; a numbered whole file does not. At 4000 functions an A0 edit costs ')
    open_('strong'); call('putnum', node(f'mov {C4K_A0[2]["total"]}')); text(' tokens'); close(); text(' against ')
    open_('strong'); call('putnum', node(f'mov {C4K_TS[2]["total"]}')); close(); text(f' for TypeScript ({int(r4)}x), cache-adjusted, Sonnet. On a one-function file the primer dominates and A0 is ')
    open_('strong'); call('putfix', node(f'mov {int(round(100 * r1))}')); text('x'); close(); text(' the cost of TypeScript: a loss, shown in the first row below.'); close()
    end()
    summary = []
    for size in (1, 40, 400, 4000):
        a, t, r = _cost(size, 'a0'), _cost(size, 'ts'), _cost(size, 'rust')
        summary.append((f'{size} function' + ('' if size == 1 else 's'), [('a0', a[2]['total']), ('c', t[2]['total']), ('rust', r[2]['total'])]))
    def cost_ratio(ids, series):
        a0v, tsv = series[0][1], series[1][1]
        ratio_label(ids[1], ids[0], 'x vs TS', 'win' if tsv > a0v * 1.05 else 'loss')
    chart('Tokens per edit by program size, Sonnet', 'Cache-adjusted; lower is better. Ratio is TypeScript over A0: below 1 A0 costs more.',
          [('la0', 'A0'), ('lc', 'TypeScript'), ('lrust', 'Rust')], summary, ' tok', cost_ratio,
          'Bars are linear within each row. The per-size charts below add every other measured language.', fixed=False,
          langs=['A0', 'TypeScript', 'Rust'])
    for size in (40, 400, 4000, 1):
        rows = COST[size]
        begin(f'cost_{size}')
        open_('div', cls='chart langs reveal')
        el('p', f'{size} function' + ('' if size == 1 else 's') + f': tokens per edit, {len(rows)} languages' + (' (the loss)' if size == 1 else ''), cls='ct')
        el('p', 'Sonnet, cache-adjusted, lower is better; bar length is logarithmic. Languages not listed were not measured at this size.', cls='sub')
        coverage(f'Tokens per edit, {size} function' + ('' if size == 1 else 's'), [label for _, label, _, _ in rows])
        vals = [r[2]['total'] for r in rows]; lo = min(vals) * 0.9; span = math.log10(max(vals) / lo)
        for rep, label, s, _ in sorted(rows, key=lambda r: r[2]['total']):
            open_('div', cls='lrow wide' + (' me' if rep == 'a0' else ''))
            el('span', label, cls='lbl')
            open_('div', cls='track ' + ('a0' if rep == 'a0' else 'nat'))
            open_('div', cls='fill'); w(12); w(1); w(3 + int(round(97 * math.log10(s['total'] / lo) / span))); close()
            open_('span', cls='val'); call('putnum', node(f'mov {s["total"]}')); text(' tok'); close()
            close()
            close()
        open_('div', cls='tblwrap')
        open_('table', cls='ops rank')
        open_('tr')
        for h in ('language', 'primer', 'code read', 'write', 'total', 'vs A0', 'Sonnet', 'Haiku'): el('th', h)
        close()
        a0t = next(r for r in rows if r[0] == 'a0')[2]['total']
        for rep, label, s, hk in rows:
            open_('tr')
            el('td', label, cls='first' if rep == 'a0' else None)
            for key in ('primer', 'code', 'write', 'total'):
                open_('td', cls='mono'); call('putnum', node(f'mov {s[key]}')); close()
            ratio = s['total'] / a0t
            open_('td', cls='mono ' + ('first' if rep == 'a0' else 'behind' if ratio >= 1 else 'loss'))
            call('putratio', node(f'mov {int(round(100 * ratio))}')); text('x'); close()
            el('td', f'{s["acc"]}%', cls='mono')
            el('td', f'{hk["acc"]}%' if hk else 'not run', cls='mono')
            close()
        close()
        close()
        el('p', 'Primer: language and workflow instructions, first read at the 1.25x cache-write rate. Code read: the view or numbered file. Write: the reply. vs A0 is the row total over A0; below 1.00x (red) that language is cheaper. Sonnet and Haiku columns: accepted by the tests, one shot, 12 tasks each.', cls='cap')
        close()
        end()
    el('p', 'Tasks are the same edits in every language; sets 400 and 4000 are one shared program grown to that size. Subjects are fresh Sonnet and Haiku contexts that see only the primer. Numbers: results/ai-edit-experiment.{b,c,c400,c4000}.*.json.', cls='cap')
    endsec()
    # -- validation latency
    begin('sec_val')
    open_('section', id_='validation')
    el('h2', 'Validation')
    open_('p'); text('After a reply arrives, the edit must be applied and the whole program known to type-check. For A0 that is '); el('strong', f'{EL_A0["medianMs"]:.2f} ms'); text(f' at the median; TypeScript with a warm compiler takes {EL_TSW["medianMs"]:.1f} ms.'); close()
    end()
    begin('chart_val')
    open_('div', cls='chart langs reveal')
    el('p', 'Milliseconds from reply received to program type-checked, median per edit', cls='ct')
    el('p', f'The accepted set-C Sonnet edits on the 40-function program; lower is better; bar length is logarithmic. Go uses hand translations of the reference edits.', cls='sub')
    coverage('Validation latency', sorted({ {'a0': 'A0', 'ts': 'TypeScript', 'rust': 'Rust', 'go': 'Go'}[lang] for _, lang, _, _ in EDIT_LOOP}))
    open_('div', cls='legend'); el('span', 'A0', cls='la0'); el('span', 'other toolchains', cls='lnat'); close()
    lo = min(r[2] for r in EDIT_LOOP) * 0.9; span = math.log10(max(r[2] for r in EDIT_LOOP) / lo)
    for label, lang, med, p90 in EDIT_LOOP:
        open_('div', cls='lrow wide' + (' me' if lang == 'a0' else ''))
        el('span', label, cls='lbl')
        open_('div', cls='track ' + ('a0' if lang == 'a0' else 'nat'))
        open_('div', cls='fill'); w(12); w(1); w(3 + int(round(97 * math.log10(med / lo) / span))); close()
        open_('span', cls='val'); call('putfix', node(f'mov {int(round(med * 100))}')); text(' ms'); close()
        close()
        close()
    cap = 'Cold rows start the compiler per edit; warm rows reuse a running one. Python is not measured (no mypy on the machine). results/edit-loop' + ('.quiet' if _EL_QUIET else '') + '.json.'
    if not _EL_QUIET: cap = f'Measured on a loaded machine (load average up to {EL_LOAD:.0f} on 8 cores); absolute times will move on a quiet run, which will replace these. ' + cap
    el('p', cap, cls='cap')
    close()
    end()
    endsec()
    # -- parallel folds
    begin('sec_par')
    open_('section', id_='parallel')
    el('h2', 'Parallel folds')
    open_('p'); text('A fold whose step is an associative reduction can be split across cores without changing its result. '); el('strong', 'a0 emit c --parallel'); text(' does that from a cost model; every result is checked exact against serial A0 and the reference interpreter.'); close()
    end()
    begin('chart_par')
    open_('div', cls='chart langs reveal')
    el('p', 'Time per call relative to A0 --parallel, per kernel', cls='ct')
    el('p', f'Lower is faster; below 1.00x (red) that implementation beats A0. Bar length is logarithmic. {_par["cpus"]} cores, median of {_par["samples"]} interleaved samples.', cls='sub')
    coverage('Parallel folds', sorted({'C' if lab == 'C + OpenMP' else lab for _, _, _, rows in PAR for lab, _, _ in rows}))
    open_('div', cls='legend'); el('span', 'A0', cls='la0'); el('span', 'other languages', cls='lnat'); close()
    lo = min(r for _, _, _, rows in PAR for _, _, r in rows) * 0.9
    span = math.log10(max(r for _, _, _, rows in PAR for _, _, r in rows) / lo)
    for kname, trips, a0ns, rows in PAR:
        el('p', f'{kname}: {trips} iterations, A0 {a0ns / 1e6:.2f} ms', cls='kh mono')
        for label, lid, r in rows:
            open_('div', cls='lrow wide' + (' me' if lid == 'a0_auto' else ''))
            el('span', label, cls='lbl')
            open_('div', cls='track ' + ('a0' if lid == 'a0_auto' else 'nat'))
            open_('div', cls='fill'); w(12); w(1); w(3 + int(round(97 * math.log10(r / lo) / span))); close()
            open_('span', cls='val' + (' loss' if r < 1 else '')); call('putratio', node(f'mov {max(1, int(round(r * 100)))}')); text('x'); close()
            close()
            close()
    cap = 'Hand-parallel C is OpenMP parallel-for with a reduction. A0 is behind on ' + '; '.join(f'{k} ({lab} {r:.2f}x)' for k, lab, r in PAR_LOSSES) + '. On the 64K-element kernels the cost model keeps A0 serial. results/parallel.json.'
    if not PAR_QUIET: cap = f'Measured on a loaded machine (load average up to {PAR_LOAD:.0f} on {_par["cpus"]} cores when timing started); ratios are interleaved, absolute times will move on a quiet run. ' + cap
    el('p', cap, cls='cap')
    close()
    end()
    endsec()
    # -- hardware
    begin('sec_hw')
    open_('section', id_='hardware')
    el('h2', 'Hardware')
    open_('p'); text('The same programs compile to clocked SystemVerilog. A 32-cycle divider took the 48 corpus modules from '); el('strong', '260,146 to 78,835 cells'); text('.'); close()
    end()
    chart('Synthesized cells, Yosys generic', 'Lower is better.',
          [('lc', 'single-cycle divide'), ('la0', 'clocked divider')], [('all 48 modules', [('c', 260146), ('a0', 78835)]), ('largest module', [('c', 104460), ('a0', 1175)])], ' cells',
          lambda ids, s: ratio_label(ids[0], ids[1], 'x smaller', 'win'),
          'Simulated on the oracle cases; optimizer proved equivalent with Z3.', single=True, fixed=False)
    endsec()
    # -- targets
    begin('sec_targets')
    open_('section', id_='targets')
    el('h2', 'Targets')
    el('p', 'One source, 5262 oracle cases, every target.')
    open_('div', cls='grid four')
    for t, d in [
        ('AArch64', 'A0\'s own code generator, no C in between'),
        ('x86-64', 'A0\'s own code generator, verified under Rosetta'),
        ('RISC-V, ARM32, AVR', 'A0\'s own code generators for 64-bit RISC-V, 32-bit ARM, and 8-bit AVR'),
        ('wasm32', 'A0\'s own wasm backend, or the C path through Clang: this site'),
        ('Native C', 'through clang or gcc, UBSan-clean, parity with hand-written C; --parallel for threads'),
        ('JavaScript', 'typed arrays, in-place updates, boundary guards only'),
        ('JVM', 'Java source, compiled and verified with javac'),
        ('.NET', 'C# source, verified on .NET 10'),
        ('GPU', 'Metal Shading Language kernels, verified on Apple silicon'),
        ('FPGA / ASIC', 'clocked SystemVerilog, simulated and synthesized'),
    ]:
        open_('div', cls='card reveal'); el('h3', t); el('p', d); close()
    close()
    close()
    end()
    # -- developers
    begin('sec_dev')
    open_('section', id_='developers')
    el('h2', 'Developers')
    open_('div', cls='grid two')
    for q, a in [
        ('How big is the runtime?', f'There is none. A native binary of the ten benchmark kernels is about {BIN_BYTES // 1024} KB including its driver; the wasm behind this page is under a megabyte.'),
        ('What happens when a model makes a mistake?', 'The edit is rejected before it lands, with a stable code (parse, type, structure, handle, revision), what was expected, what was seen, and the one fix that resolves it.'),
        ('Can a wrong program run forever?', 'Literal iteration counts are bounded statically. Variable counts are bounded by fuel in the reference interpreter; compiled targets have no execution budget, so a variable count runs as long as it says. io output is bounded by the caller\'s buffer, and there is no heap or recursion.'),
        ('How is correctness checked?', 'A BigInt oracle runs 5262 generated cases through every backend, Z3 proves the optimizer equivalent to the source on all 48 corpus functions, and hardware is simulated and synthesized.'),
    ]:
        open_('div', cls='card reveal'); el('h3', q); el('p', a); close()
    close()
    el('h3', 'Not yet')
    open_('div', cls='limits')
    el('p', 'No floating point, no heap, no recursion. Token cost above TypeScript on single-function tasks. AArch64 backend up to 1.4x behind clang on array and loop kernels. Emitted JavaScript slower than hand-written.')
    close()
    el('h3', 'Try it')
    open_('pre', cls='code'); open_('code')
    el('span', '# one binary, no package manager\n', cls='cm')
    text('curl -L https://github.com/Joe-Simo/a0/releases/latest/download/a0-darwin-arm64 -o a0 && chmod +x a0\n')
    text("printf 'fn sq u32 -> u32\\na mul p0 p0\\nret a\\nend\\n' > sq.a0\n")
    text('./a0 run sq.a0 sq 12          # 144\n')
    text('./a0 emit arm64 sq.a0         # A0\'s own machine code; or x86_64, c, js, java, sv\n')
    text('./a0 check sq.a0              # diagnostics with the fix')
    close(); close()
    close()
    end()
    begin('sec_close')
    close(); close()  # .main, .layout
    end()
    footer()
    w(6); w(0)
    body = '\n'.join(lines)
    return HEADER_PAGE + '\n'.join(SECTIONS) + SESSION_PAGE.replace('BODY', body)

def cur_set(n):
    global cur; cur = n

HEADER_PAGE = '''# a0lang.com home page, authored in A0. An io program speaking the A0 UI protocol (see ui.a0):
#   input : event x y ntext text[ntext] nstate state[nstate]   (this page keeps no state)
#   tags: 1 h1 2 p 3 button 4 code 5 div 6 span 7 ul 8 li 9 a 10 pre 11 h2 12 input 13 section
#         14 nav 15 h3 16 strong 17 footer 18 header 19 table 20 tr 21 td 22 th 23 small
#   attr keys: 1 id 2 class 3 href 4 type 5 placeholder 6 aria-label
# The browser runtime (site/app.ts) builds DOM from this stream and reports events back.
use "ui.a0"
'''
SESSION_PAGE = '''
fn session io -> u32
r0 read p0
event at r0 0
tok at r0 1
BODY
ret event
end
'''

# ---------------------------------------------------------------- docs page
def gen_docs():
    reset()
    css_chunks()
    nav('docs')
    begin('sec_head')
    open_('div', cls='docs')
    open_('section', cls='hero', id_='top')
    el('h1', 'Docs', cls='name pixel')
    close()
    open_('div', cls='layout')
    open_('nav', cls='rail')
    el('div', 'Language', cls='rh')
    el('a', 'The primer', href='#primer')
    el('a', 'Programs and functions', href='#programs')
    el('a', 'Types and values', href='#types')
    el('a', 'Operations', href='#operations')
    el('a', 'Iteration', href='#iteration')
    el('a', 'Modules', href='#modules')
    el('div', 'Working with models', cls='rh')
    el('a', 'Views and edits', href='#editing')
    el('a', 'Diagnostics', href='#diagnostics')
    el('div', 'Running', cls='rh')
    el('a', 'Bounds and safety', href='#bounds')
    el('a', 'Targets and CLI', href='#cli')
    el('a', 'The UI protocol', href='#ui')
    close()
    open_('div', cls='main')
    open_('section', id_='primer')
    el('h2', 'The primer')
    el('p', 'The whole language fits on one screen. This is exactly what a model receives before it writes or edits A0 (388 tokens, o200k). Everything below is the same information, expanded.')
    open_('pre', cls='code wrap'); open_('code')
    for line in open('MODEL_GUIDE.min.txt').read().rstrip('\n').split('\n'): text(line + '\n')
    close(); close()
    close()
    end()
    begin('sec_lang')
    open_('section', id_='programs')
    el('h2', 'Programs and functions')
    el('p', 'A program is a list of functions. A function is a header `fn NAME T... -> T`, then one instruction per line `ID OP ARGS`, then `ret ARG` (or `ret OP ARGS`, which names a fresh node), then `end`. Names are lowercase identifiers. Parameters are p0, p1, ... in header order. Arguments are an earlier ID in the same function, a parameter, a u32 literal, true, or false. There are no forward references, no recursion, and no nested expressions: one operation per line.')
    open_('pre', cls='code'); open_('code')
    el('span', '# clamp p0 into [p1, p2]\n', cls='cm')
    text('fn clamp u32 u32 u32 -> u32\nlo lt p0 p1\nhi lt p2 p0\na select lo p1 p0\nr select hi p2 a\nret r\nend')
    close(); close()
    close()
    open_('section', id_='types')
    el('h2', 'Types and values')
    el('p', 'u32 is an exact 32-bit unsigned integer; every arithmetic result wraps modulo 2^32. bool is true or false, never a number. Arrays u32xN and records (T,T,...) are values: get, set, at, and put copy, they never alias. io is a linear token: every io value is used exactly once, which is what makes output order and bounds checkable. Literal iteration counts are bounded statically; variable counts are bounded by fuel in the reference interpreter, and compiled targets have no execution budget.')
    close()
    open_('section', id_='operations')
    el('h2', 'Operations')
    open_('table', cls='ops')
    open_('tr'); el('th', 'Operation'); el('th', 'Meaning'); close()
    for op, meaning in [
        ('mov x', 'the value x'),
        ('add sub mul a b', 'wrapping arithmetic modulo 2^32'),
        ('and or xor a b', 'bitwise on two u32; logical on two bool'),
        ('shl shr a n', 'shift by n & 31; shr is logical'),
        ('div a b', 'unsigned quotient; b = 0 gives 4294967295'),
        ('rem a b', 'unsigned remainder; b = 0 gives a'),
        ('eq ne a b', 'equality on two u32 or two bool, result bool'),
        ('lt le gt ge a b', 'unsigned comparison, result bool'),
        ('select c x y', 'x if c else y; both are computed, so no effects inside'),
        ('call F a...', 'call an earlier function'),
        ('fold F n s a...', 'state = s; for i in 0..n-1: state = F(state, i, a...)'),
        ('loop P F n s a...', 'fold that stops before iteration i when P(state, i, a...) is false'),
        ('arr e... / rec e...', 'build an array or a record'),
        ('text "..."', 'an array of UTF-8 bytes'),
        ('get a i / set a i v', 'read or copy-with-update at index i mod N'),
        ('at r k / put r k v', 'read or copy-with-update of field k (a literal)'),
        ('read t / write t v / puts t a', 'io: read one word (0 when exhausted) as (u32,io); write one word; write length then elements'),
    ]:
        open_('tr'); el('td', op, cls='mono'); el('td', meaning); close()
    close()
    close()
    end()
    begin('sec_iter')
    open_('section', id_='iteration')
    el('h2', 'Iteration')
    el('p', 'There are no loops in the body of a function. Repetition is fold and loop over an earlier function: the step function receives the state, the index, and any extra arguments, and returns the next state. loop adds a predicate function that is checked before each iteration. n may be a literal or a value. A literal count is bounded statically, against the per-function budget. A variable count is bounded by fuel in the reference interpreter; compiled targets have no execution budget, so it runs as many iterations as the value says.')
    open_('pre', cls='code'); open_('code')
    el('span', '# sum of squares 0..n-1 with fold; the step is an earlier function\n', cls='cm')
    text('fn sqstep u32 u32 -> u32\ns mul p1 p1\nr add p0 s\nret r\nend\nfn sumsq -> u32\nr fold sqstep 10 0\nret r\nend')
    close(); close()
    close()
    open_('section', id_='modules')
    el('h2', 'Modules')
    el('p', 'A file starts with zero or more `use "path.a0"` lines, relative to the file. The linker loads every used file once, orders them by dependency, and validates the result as one program with one namespace. Cycles are rejected. A function name defined in two files is rejected with both locations. Diagnostics on a linked program name the file and line they belong to.')
    open_('pre', cls='code'); open_('code')
    text('use "ui.a0"\nuse "../examples/life.a0"\nfn page io -> io\na call open p0 5\nb call close a\nret b\nend')
    close(); close()
    close()
    open_('section', id_='editing')
    el('h2', 'Views and edits')
    el('p', 'A model never sees a whole file. It asks for a view of one function: the function with a handle line on top (e0), one signature line per callee, and a program handle (g0). The program view is scoped: a comment line with the function count, then the signatures of the target, its transitive callees, and its direct callers, so it stays the same size as the program grows to thousands of functions. A reply is the handle line followed by edits, one per line: `id op ...` replaces the instruction id or inserts it before ret; `id op ... @ other` inserts after other; `-id` deletes; `ret x` changes the result. Under g0, a whole `fn ... end` block adds or replaces a function and `-fn name` removes one. The edit is applied only if it parses, type-checks, validates, and was written against the current revision; otherwise it is rejected and the handle stays valid.')
    open_('pre', cls='code'); open_('code')
    el('span', '# a view of clamp, then a reply that fixes the upper bound\n', cls='cm')
    text('e0 fn clamp u32 u32 u32 -> u32\nlo lt p0 p1\nhi lt p2 p0\na select lo p1 p0\nr select hi p2 a\nret r\n\n')
    el('span', '# reply\n', cls='cm')
    text('e0\nhi lt p2 a\nr select hi p2 a')
    close(); close()
    close()
    open_('section', id_='diagnostics')
    el('h2', 'Diagnostics')
    el('p', 'Every rejection carries a stable code (parse, type, structure, handle, revision, limit), what was expected, what was seen, and the one fix that resolves it. The compiler never guesses: a reply that is ambiguous is rejected with the fix, not applied approximately.')
    close()
    end()
    begin('sec_run')
    open_('section', id_='bounds')
    el('h2', 'Bounds and safety')
    el('p', 'Static caps: 65536 functions per program (also after linking), 4096 instructions per function, 64 parameters, arrays up to 65536 elements (1024 on the hardware and GPU targets), literal iteration budget 2^24 per function. Variable iteration counts are bounded by fuel in the reference interpreter; compiled targets have no execution budget. io output is bounded by the caller\'s buffer. There is no heap, no recursion, no exceptions, and no undefined behavior: div and rem by zero are defined, shifts mask the count, indices wrap modulo the array length.')
    close()
    open_('section', id_='cli')
    el('h2', 'Targets and CLI')
    open_('pre', cls='code'); open_('code')
    text('a0 check <file.a0>                     # parse, type, validate; diagnostics with codes\n')
    text('a0 run <file.a0> <fn> <args...>        # reference interpreter\n')
    text('a0 emit <target> <file.a0> [out]      # arm64 x86_64 riscv64 arm32 avr wasm c js java sv\n')
    text('a0 emit c --parallel[=auto|gpu] <file.a0>  # automatic parallel folds: threads, or Metal\n')
    text('a0 wasm <file.a0> <out.wasm>           # wasm32 through the C backend, Clang, and wasm-ld\n')
    text('a0 view <file.a0> <fn>                 # dependency-scoped view with an edit handle\n')
    text('a0 patch <file.a0> <patch>             # apply a revision-checked patch')
    close(); close()
    el('p', 'Targets: AArch64, x86-64, 64-bit RISC-V, 32-bit ARM, and AVR from A0\'s own code generators; wasm32 directly (emit wasm) or through C (a0 wasm); C; JavaScript; the JVM (Java source); .NET (C# source); Metal for the GPU; and clocked SystemVerilog for FPGA and ASIC. Native output exports C-ABI symbols named a0_NAME. JavaScript output is an ES module; Java output is an ordinary class. C# and Metal are produced by the verification tools (bun run dotnet, bun run gpu). Every target is verified against the same oracle.')
    el('p', '--parallel makes the C backend split two fold shapes across threads, reductions (add, mul, and, or, xor, min, max) and element-wise array maps, when a cost model says the loop is large enough; --parallel=gpu also offloads to Metal when built as Objective-C. Results are exact: the same bits as the serial program.')
    close()
    open_('section', id_='ui')
    el('h2', 'The UI protocol')
    el('p', 'This site is two A0 io programs. Each reads an event and writes a word stream that a small generic runtime turns into DOM: 1 OPEN tag, 2 TEXT bytes, 3 CLOSE, 4 ATTR key bytes, 5 ONCLICK event, 6 STATE words, 9 STYLE bytes, 12 SIZE property percent. The stylesheet, the layout, every number, and every chart bar on these pages are computed by the program; the runtime knows nothing about the page.')
    close()
    close(); close()  # main, layout
    close()  # docs
    end()
    footer()
    w(6); w(0)
    body = '\n'.join(lines)
    return HEADER_DOCS + '\n'.join(SECTIONS) + SESSION_PAGE.replace('BODY', body)

HEADER_DOCS = '''# a0lang.com/docs, authored in A0. Same protocol and runtime as page.a0 (see ui.a0).
use "ui.a0"
'''

if __name__ == '__main__':
    open('site/page.a0', 'w').write(gen_page())
    open('site/docs.a0', 'w').write(gen_docs())
    print('wrote site/page.a0 site/docs.a0 (site/ui.a0 is maintained by hand)')
    for name, n, missing in COVERAGE:
        print(f'  {name}: {n} of {N_ALL}' + (f'; not measured: {", ".join(missing)}' if missing else ''))
