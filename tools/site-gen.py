"""Generator for the a0lang.com page programs: site/page.a0 (home) and site/docs.a0 (reference).

Step 1 of moving the generator into A0: every computed number is integer or fixed-point arithmetic
with explicit rounding, and the prose, stylesheet, shader and page structure are data files under
site/gen/ (the templates page.tpl and docs.tpl, style.css, scene.glsl, tags.tpl). The template
language and the arithmetic are the ones site/gen/sitegen.a0 implements.
    python3 tools/site-gen.py && bun run site
"""

import json, math, os

# ---------------------------------------------------------------- integer arithmetic
Q = 20  # log2 values are fixed point with Q fraction bits
T_LG = [round((1 << Q) * math.log2(1 + i / 1024)) for i in range(1025)]
T_EX = [round((1 << Q) * 2 ** (i / 1024)) for i in range(1025)]


def lg(n):
    """log2(n) in Q20 for an integer n >= 1: table of log2(1 + i/1024), linear in between."""
    n = max(n, 1)
    e = n.bit_length() - 1
    m = (n << (31 - e)) & 0xFFFFFFFF
    i = (m >> 21) & 1023
    f = (m >> 5) & 0xFFFF
    return (e << Q) + T_LG[i] + (((T_LG[i + 1] - T_LG[i]) * f) >> 16)


def ex(L, c):
    """round(c * 2^(L / 2^20)) for a signed Q20 L: table of 2^(i/1024), linear in between."""
    E = L >> Q
    f = L - (E << Q)
    i = f >> 10
    fr = f & 1023
    x = (T_EX[i] + (((T_EX[i + 1] - T_EX[i]) * fr) >> 10)) * c
    s = Q - E
    if s <= 0: return x << -s
    if s >= 32: return 0
    return (x + (1 << (s - 1))) >> s


def rdiv(a, b):
    """a / b rounded to the nearest integer, ties to even (Python's round)."""
    q, r = divmod(a, b)
    return q + 1 if 2 * r > b or (2 * r == b and q & 1) else q


def fx(s, scale):
    """A JSON number (its text) as an integer in units of 1/scale, truncated after 9 digits."""
    ip, _, fr = s.partition('.')
    return int(ip) * scale + int((fr + '000000000')[:9]) // (10 ** 9 // scale)


def median(v):
    v = sorted(v); n = len(v)
    return v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) // 2


def pct(v, lo, hi):
    """Bar length 3..100 of a Q20 log value between lo and hi."""
    return 3 + rdiv(97 * (v - lo), hi - lo)


def fmt2(h): return f'{h // 100}.{h % 100:02d}'
def fmt1(t): return f'{t // 10}.{t % 10}'


LG097 = lg(97) - lg(100)
LG09 = lg(9) - lg(10)

# ---------------------------------------------------------------- inputs
def load(tpl):
    lines = open(tpl).read().split('\n')
    files = []
    for l in lines:
        if l.startswith('f '):
            f = l.split(' ')
            files.append((f[1:-1], open(f[-1]).read() if os.path.exists(f[-1]) else None))
    maps = [l.split(' ', 3)[1:] for l in lines if l.startswith('m ')]
    for role, text in files:
        if role[0] == 'tags' and text is not None:
            maps += [l.split(' ', 3)[1:] for l in text.split('\n') if l.startswith('m ')]
    return lines, files, maps


def jload(text): return json.loads(text, parse_float=str, parse_int=str)


def compute(files, maps):
    V = {}
    one = {r[0]: t for r, t in files if len(r) == 1}
    mp = lambda name: [(k, v) for n, k, v in maps if n == name]
    if 'exec' not in one: return V
    ex_ = jload(one['exec']); kern = ex_['kernels']; langs = ex_['languages']
    NS = 10 ** 4
    K = [k for k in kern if isinstance(kern[k]['c'].get('arm64'), dict)]
    arm = {k: fx(kern[k]['c']['arm64']['medianNsPerCall'], NS) for k in K}
    hand = {k: fx(kern[k]['c']['handwritten']['medianNsPerCall'], NS) for k in K}
    rust = {k: fx(kern[k]['c']['rust']['medianNsPerCall'], NS) for k in K}
    js = {k: fx(kern[k]['js']['handwritten']['medianNsPerCall'], NS) for k in K}
    ran = lambda k, lid: isinstance(kern[k].get(lid), dict) and kern[k][lid].get('status') == 'ran'
    med = lambda k, lid: fx(kern[k][lid]['medianNsPerCall'], NS)
    gm = lambda num, ks: sum(lg(num[k]) - lg(arm[k]) for k in ks) // len(ks)
    V['py_geomean'] = str(ex(gm({k: med(k, 'python') for k in K}, K), 1))
    V['js_geomean'] = str(ex(gm(js, K), 1))
    V['c_ratio'] = fmt2(ex(sum(lg(arm[k]) - lg(hand[k]) for k in K) // len(K), 100))
    V['n_k'] = str(len(K))
    LANGS = [('C', 'compiled-native', gm(hand, K)), ('Rust', 'compiled-native', gm(rust, K)), ('JavaScript', 'jit', gm(js, K))]
    for lid, meta in langs.items():
        if meta.get('status') != 'ran': continue
        ks = [k for k in K if ran(k, lid)]
        if ks: LANGS.append((meta['label'], meta['family'], gm({k: med(k, lid) for k in ks}, ks)))
    LANGS.append(('A0', 'a0', 0))
    LANGS.sort(key=lambda t: (t[2], t[0] != 'A0'))
    cls = lambda fam: 'a0' if fam == 'a0' else 'nat' if fam == 'compiled-native' else 'int' if fam == 'interpreted' else 'jit'
    lo = min(g for _, _, g in LANGS) + LG097; hi = max(g for _, _, g in LANGS)
    V['langs'] = str(len(LANGS))
    V['lg_label'] = [l for l, _, _ in LANGS]
    V['lg_cls'] = [cls(f) for _, f, _ in LANGS]
    V['lg_me'] = ['1' if f == 'a0' else '' for _, f, _ in LANGS]
    V['lg_pct'] = [str(pct(g, lo, hi)) for _, _, g in LANGS]
    V['lg_g100'] = [str(ex(g, 100)) for _, _, g in LANGS]
    V['n_langs'] = str(len(LANGS) - 1); V['n_langs1'] = str(len(LANGS))
    t95 = lg(95) - lg(100); t105 = lg(105) - lg(100)
    V['n_ties'] = str(sum(1 for _, f, g in LANGS if t95 <= g <= t105 and f != 'a0'))
    ahead = [l for l, _, g in LANGS if g < t95]
    V['n_ahead'] = str(len(ahead)); V['ahead'] = ', '.join(ahead)
    ALL = ['A0', 'C', 'Rust', 'JavaScript'] + [m['label'] for m in langs.values() if m.get('status') == 'ran']
    V['n_all'] = str(len(ALL))

    def cov(name, labels):
        n = sum(1 for l in ALL if l in set(labels))
        V[name] = str(n); V[name + '_part'] = '' if n == len(ALL) else '1'
    cov('cov_langs', [l for l, _, _ in LANGS])
    # rank per kernel
    rows = []
    for k in K:
        e = [('A0', arm[k]), ('C', hand[k]), ('Rust', rust[k]), ('JavaScript', js[k])]
        e += [(m['label'], med(k, lid)) for lid, m in langs.items() if ran(k, lid)]
        e.sort(key=lambda t: t[1])
        rank = [n for n, _ in e].index('A0') + 1
        best = e[0] if e[0][0] != 'A0' else e[1]
        rows.append((k, rank, len(e), best[0], best[1], arm[k]))
    V['ranks'] = str(len(rows))
    V['rk_name'] = [r[0] for r in rows]; V['rk_rank'] = [str(r[1]) for r in rows]
    V['rk_first'] = ['1' if r[1] == 1 else '' for r in rows]; V['rk_n'] = [str(r[2]) for r in rows]
    V['rk_best'] = [r[3] for r in rows]; V['rk_bv'] = [fmt2(rdiv(r[4], 100)) for r in rows]
    V['rk_ratio'] = [str(rdiv(100 * r[5], r[4])) for r in rows]; V['rk_win'] = ['1' if r[5] <= r[4] else '' for r in rows]
    # startup
    MS = 10 ** 6
    st = lambda k, g, lid: fx(kern[k][g][lid], MS)
    STARTS = [('A0', 'a0', median(fx(kern[k]['c']['startupMs']['emitted'], MS) for k in K)),
              ('C', 'compiled-native', median(fx(kern[k]['c']['startupMs']['handwritten'], MS) for k in K))]
    for grp in ('startupInterpretersMs', 'startupCompiledMs'):
        ids = {}
        for k in K: ids.update(dict.fromkeys((kern[k].get(grp) or {}).keys()))
        for lid in ids:
            vals = [st(k, grp, lid) for k in K if lid in (kern[k].get(grp) or {})]
            lab = 'JavaScript' if lid == 'node' else langs[lid]['label'] if lid in langs else lid
            fam = langs.get(lid, {}).get('family') or ('jit' if lid == 'node' else 'interpreted')
            STARTS.append((lab, fam, median(vals)))
    node = next(v for l, _, v in STARTS if l == 'JavaScript'); py = next(v for l, _, v in STARTS if l == 'Python')
    V['start_a0'] = fmt2(rdiv(STARTS[0][2], 10 ** 4))
    V['start_node'] = str(rdiv(node, MS)); V['start_py'] = str(rdiv(py, MS))
    STARTS.sort(key=lambda t: t[2])
    lo = lg(min(v for _, _, v in STARTS)); hi = lg(max(v for _, _, v in STARTS))
    V['starts'] = str(len(STARTS)); V['n_starts'] = str(len(STARTS))
    V['st_label'] = [l for l, _, _ in STARTS]
    V['st_cls'] = ['a0' if l == 'A0' else cls(f) for l, f, _ in STARTS]
    V['st_me'] = ['1' if l == 'A0' else '' for l, _, _ in STARTS]
    V['st_pct'] = [str(pct(lg(v), lo, hi)) for _, _, v in STARTS]
    V['st_v100'] = [str(rdiv(v, 10 ** 4)) for _, _, v in STARTS]
    V['start_rank'] = str([l for l, _, _ in STARTS].index('A0') + 1)
    cov('cov_start', [l for l, _, _ in STARTS])
    V['a0_build'] = str(sum(rdiv(fx(kern[k]['c']['buildMs']['a0ToNative'], 1000), 1000) for k in kern))
    V['rs_build'] = str(sum(rdiv(fx(kern[k]['c']['buildMs']['rustc'], 1000), 1000) for k in kern))
    V['bin_kb'] = str(int(kern['affine']['c']['binaryBytes']['emitted']) // 1024)

    # cost per edit
    def cell(text, rep):
        if text is None: return None
        ts = [c for c in jload(text)['trials'] if c['representation'] == rep and c['protocol'] == 'structured']
        if not ts: return None
        n = len(ts); calls = sum(int(c['modelCalls']) for c in ts)
        b = [c['tokenBucketsLocal'] for c in ts]
        P = sum(int(x['languagePrimer']) + int(x['workflowPrimer']) for x in b)
        C = sum(int(x['toolContext']) for x in b); W = sum(int(x['output']) for x in b)
        A = sum(1 for c in ts if c['accepted'])
        return {'primer': rdiv(5 * P, 4 * calls), 'code': rdiv(C, n), 'write': rdiv(W, n),
                'total': rdiv(5 * P * n + 4 * calls * (C + W), 4 * calls * n), 'acc': rdiv(100 * A, n)}
    cfile = {tuple(r[1:4]): t for r, t in files if r[0] == 'cost'}
    sizes = list(dict.fromkeys(r[1] for r, _ in files if r[0] == 'cost'))
    costmap = [(rep, v.split(' ', 1)) for rep, v in mp('cost')]
    labels = dict((rep, kl[1]) for rep, kl in costmap)
    COST = {}
    for size in sizes:
        rs = []
        for rep, (kind, label) in costmap:
            s = cell(cfile.get((size, 'sonnet', kind)), rep)
            if s is None: continue
            rs.append((rep, label, s, cell(cfile.get((size, 'haiku', kind)), rep)))
        COST[size] = rs
    tot = lambda size, rep: next(r for r in COST[size] if r[0] == rep)[2]
    asc = sorted(sizes, key=int)
    V['csum'] = str(len(asc))
    V['cs_size'] = asc; V['cs_many'] = ['' if s == '1' else '1' for s in asc]
    V['cs_a0'] = [str(tot(s, 'a0')['total']) for s in asc]; V['cs_ts'] = [str(tot(s, 'ts')['total']) for s in asc]
    V['cs_rust'] = [str(tot(s, 'rust')['total']) for s in asc]
    V['cs_cls'] = ['win' if 100 * tot(s, 'ts')['total'] > 105 * tot(s, 'a0')['total'] else 'loss' for s in asc]
    cov('cov_sum', [labels['a0'], labels['ts'], labels['rust']])
    big, small = asc[-1], asc[0]
    V['cmax_a0'] = str(tot(big, 'a0')['total']); V['cmax_ts'] = str(tot(big, 'ts')['total'])
    V['cmax_ratio'] = str(tot(big, 'ts')['total'] // tot(big, 'a0')['total']); V['cmax_acc'] = str(tot(big, 'a0')['acc'])
    V['cmin_100'] = str(rdiv(100 * tot(small, 'a0')['total'], tot(small, 'ts')['total']))
    V['csz'] = str(len(sizes))
    for key in ('cz_size', 'cz_many', 'cz_n', 'cz_loss', 'cz_cov', 'cz_covpart', 'cb', 'ct'): V[key] = []
    for key in ('cb_label', 'cb_a0', 'cb_pct', 'cb_total', 'ct_label', 'ct_a0', 'ct_primer', 'ct_code', 'ct_write',
                'ct_total', 'ct_cls', 'ct_ratio', 'ct_acc', 'ct_hk'): V[key] = []
    for size in sizes:
        rs = COST[size]
        V['cz_size'].append(size); V['cz_many'].append('' if size == '1' else '1'); V['cz_n'].append(str(len(rs)))
        V['cz_loss'].append('1' if tot(size, 'a0')['total'] > tot(size, 'ts')['total'] else '')
        cov('_c', [l for _, l, _, _ in rs]); V['cz_cov'].append(V.pop('_c')); V['cz_covpart'].append(V.pop('_c_part'))
        vals = [r[2]['total'] for r in rs]; lo = lg(min(vals)) + LG09; hi = lg(max(vals))
        srt = sorted(rs, key=lambda r: r[2]['total'])
        V['cb'].append(str(len(srt)))
        V['cb_label'].append([r[1] for r in srt]); V['cb_a0'].append(['1' if r[0] == 'a0' else '' for r in srt])
        V['cb_pct'].append([str(pct(lg(r[2]['total']), lo, hi)) for r in srt]); V['cb_total'].append([str(r[2]['total']) for r in srt])
        a0t = tot(size, 'a0')['total']
        V['ct'].append(str(len(rs)))
        V['ct_label'].append([r[1] for r in rs]); V['ct_a0'].append(['1' if r[0] == 'a0' else '' for r in rs])
        for f in ('primer', 'code', 'write', 'total'): V['ct_' + f].append([str(r[2][f]) for r in rs])
        V['ct_cls'].append(['first' if r[0] == 'a0' else 'behind' if r[2]['total'] >= a0t else 'loss' for r in rs])
        V['ct_ratio'].append([str(rdiv(100 * r[2]['total'], a0t)) for r in rs])
        V['ct_acc'].append([str(r[2]['acc']) for r in rs]); V['ct_hk'].append([str(r[3]['acc']) if r[3] else '' for r in rs])

    # validation latency: the quiet run when there is one
    quiet = one.get('editq') is not None
    el = jload(one['editq'] if quiet else one['edit'])
    load = [fx(x, 100) for r in el.get('load', []) for x in r['loadavg']]
    elmap = dict(mp('el')); ellang = dict(mp('ellang'))
    rows = [(r['kind'], fx(r['medianMs'], 1000)) for r in el['sonnet']['rows']]
    msd = dict(rows)
    V['el_a0'] = fmt2(rdiv(msd['a0.structured'], 10)); V['el_tsw'] = fmt1(rdiv(msd['ts.warm'], 100))
    rows.sort(key=lambda t: t[1])
    lo = lg(min(v for _, v in rows)) + LG09; hi = lg(max(v for _, v in rows))
    V['el'] = str(len(rows))
    V['el_label'] = [elmap.get(k, k) for k, _ in rows]; V['el_a0row'] = ['1' if k.split('.')[0] == 'a0' else '' for k, _ in rows]
    V['el_pct'] = [str(pct(lg(v), lo, hi)) for _, v in rows]; V['el_med100'] = [str(rdiv(v, 10)) for _, v in rows]
    V['el_quiet'] = '1' if quiet else ''; V['el_loaded'] = '' if quiet else '1'
    V['el_load'] = str(rdiv(max(load), 100)) if load else ''
    cov('cov_val', [ellang.get(k.split('.')[0], '') for k, _ in rows])

    # parallel folds
    par = jload(one['par']); parmap = mp('par'); parcov = dict(mp('parcov'))
    PAR = []
    for k, v in par['kernels'].items():
        b = v['baselineOverA0Auto']
        rs = sorted([(lab, lid, fx(b[lid], 10 ** 5)) for lid, lab in parmap if lid in b], key=lambda t: t[2])
        PAR.append((k, v['trips'], fx(v['medianNsPerCall']['a0_auto'], 10), rs))
    allr = [r for _, _, _, rs in PAR for _, _, r in rs]
    lo = lg(min(allr)) + LG09; hi = lg(max(allr))
    V['pk'] = str(len(PAR))
    V['pk_name'] = [p[0] for p in PAR]; V['pk_trips'] = [p[1] for p in PAR]; V['pk_ms'] = [fmt2(rdiv(p[2], 10 ** 5)) for p in PAR]
    V['pr'] = [str(len(p[3])) for p in PAR]
    V['pr_label'] = [[l for l, _, _ in p[3]] for p in PAR]; V['pr_a0'] = [['1' if lid == 'a0_auto' else '' for _, lid, _ in p[3]] for p in PAR]
    V['pr_pct'] = [[str(pct(lg(r), lo, hi)) for _, _, r in p[3]] for p in PAR]
    V['pr_loss'] = [['1' if r < 10 ** 5 else '' for _, _, r in p[3]] for p in PAR]
    V['pr_r100'] = [[str(max(1, rdiv(r, 1000))) for _, _, r in p[3]] for p in PAR]
    V['par_losses'] = '; '.join(f'{k} ({lab} {fmt2(rdiv(r, 1000))}x)' for k, _, _, rs in PAR for lab, lid, r in rs if lid != 'a0_auto' and r < 10 ** 5)
    V['par_cpus'] = par['cpus']; V['par_samples'] = par['samples']
    V['par_loaded'] = '' if par['load'].get('quiet') else '1'
    V['par_load'] = str(rdiv(max(fx(x, 100) for x in par['load']['atTimingStart']), 100))
    cov('cov_par', [parcov.get(lid, lab) for _, _, _, rs in PAR for lab, lid, _ in rs])
    return V


# ---------------------------------------------------------------- template interpreter
class Gen:
    def __init__(self, lines, files, maps, V):
        self.lines, self.V = lines, V
        self.text = {r[0]: t for r, t in files if len(r) == 1}
        self.tag = {k: v for n, k, v in maps if n == 'tag'}
        self.attr_ = {k: v for n, k, v in maps if n == 'attr'}

    def var(self, name):
        if name == 'k': return str(self.k)
        v = self.V.get(name, '')
        if isinstance(v, list): v = v[self.idx[0]] if self.idx else ''
        if isinstance(v, list): v = v[self.idx[1]] if len(self.idx) > 1 else ''
        return v

    def expand(self, s, regs=False):
        out = []; i = 0
        while i < len(s):
            c = s[i]
            if c == '\\':
                d = s[i + 1]; out.append({'n': '\n', 's': ' '}.get(d, d)); i += 2
            elif c == '$':
                j = s.index('$', i + 1); out.append(self.var(s[i + 1:j])); i = j + 1
            elif c == '{':
                j = s.index('|', i); name = s[i + 1:j]; e = s.index('}', j)
                parts = s[j + 1:e].split('|') + ['']
                out.append(self.expand(parts[0] if self.var(name) != '' else parts[1])); i = e + 1
            elif c == '%' and regs:
                out.append(self.regs[s[i + 1]]); i += 2
            else:
                out.append(c); i += 1
        return ''.join(out)

    # emitter
    def line(self, s):
        if self.pass_ == (1 if self.sec else 2):
            self.out.append(s if self.first else '\n' + s)
        self.first = False
    def nid(self):
        self.k += 1; return f'x{self.k}'
    def w(self, word):
        n = self.nid(); self.line(f'{n} write {self.cur} {word}'); self.cur = n
    def call(self, fn, args):
        n = self.nid(); self.line(f'{n} call {fn} {self.cur} {args}'); self.cur = n
    def puts(self, s):
        lit = self.nid(); self.line(f'{lit} text "' + s.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n') + '"')
        n = self.nid(); self.line(f'{n} puts {self.cur} {lit}'); self.cur = n
    def textop(self, s):
        if s != '': self.w(2); self.puts(s)
    def open(self, tag): self.call('open', self.tag[tag])
    def attr(self, key, value):
        if value != '': self.w(4); self.w(self.attr_[key]); self.puts(value)
    def chunks(self, word, text):
        chunk = ''
        for line in text.split('\n'):
            if len((chunk + line + '\n').encode()) > 1000:
                self.w(word); self.puts(chunk); chunk = ''
            chunk += line + '\n'
        if chunk: self.w(word); self.puts(chunk)

    def run(self, pass_):
        self.pass_, self.out, self.k, self.cur, self.sec, self.first = pass_, [], 0, 'tok', False, True
        self.nsec, self.regs, self.idx, stack = 0, {}, [], []
        pc = 0
        while pc < len(self.lines):
            l = self.lines[pc]; op, arg = l[:1], l[1:]; pc += 1
            if op in ('1', '2'):
                if int(op) == pass_: self.out.append(arg + '\n')
            elif op == '<': self.open(arg)
            elif op == '.':
                tag, _, cls = arg.partition(' '); self.open(tag); self.attr('class', self.expand(cls))
            elif op == '=':
                tag, _, s = arg.partition(' '); self.open(tag); self.textop(self.expand(s)); self.call('close', '')
            elif op == '+':
                key, _, v = arg.partition(' '); self.attr(key, self.expand(v))
            elif op == '>': self.call('close', '')
            elif op == '"': self.textop(self.expand(arg))
            elif op == 'w': self.w(self.expand(arg[1:], True))
            elif op == 'c':
                fn, _, a = arg[1:].partition(' '); self.call(fn, self.expand(a, True))
            elif op == 'n':
                reg, _, e = arg[1:].partition(' '); n = self.nid(); self.line(f'{n} {self.expand(e, True)}'); self.regs[reg] = n
            elif op == 's':
                word, _, role = arg[1:].partition(' '); t = self.text[role]
                if role == 'css': t = theme_scope(t)
                self.chunks(word, t)
            elif op == 'l':
                for line in self.text[arg[1:]].rstrip('\n').split('\n'): self.textop(line + '\n')
            elif op == '{':
                assert not self.sec
                name = self.expand(arg); self.saved = (self.cur, self.first)
                self.sec, self.cur = True, 'p0'
                if pass_ == 1: self.out.append(('' if self.nsec == 0 else '\n') + f'fn {name} io -> io\n')
                self.first = True; self.nsec += 1; self.secname = name
            elif op == '}':
                if pass_ == 1: self.out.append(f'\nret {self.cur}\nend\n')
                self.sec = False; self.cur, self.first = self.saved
                n = self.nid(); self.line(f'{n} call {self.secname} {self.cur}'); self.cur = n
            elif op == '[':
                n = int(self.var(arg) or 0)
                if n == 0:
                    d = 1
                    while d:
                        o = self.lines[pc][:1]; pc += 1; d += (o == '[') - (o == ']')
                else:
                    stack.append((pc, n)); self.idx.append(0)
            elif op == ']':
                start, n = stack[-1]
                if self.idx[-1] + 1 < n: self.idx[-1] += 1; pc = start
                else: stack.pop(); self.idx.pop()
        return ''.join(self.out)


def theme_scope(css):
    """Key every prefers-color-scheme block to the viewer's choice as well as the system setting.

    `@media (prefers-color-scheme:X){R}` becomes the same block with each selector limited to
    `:root` without a forced opposite theme, followed by R limited to `:root[data-theme=X]`.
    `:where()` keeps each selector's specificity; site/theme.ts only sets `data-theme` on <html>.
    """
    import re
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
    return re.sub(r'@media \(prefers-color-scheme:(light|dark)\)\{((?:[^{}]*\{[^{}]*\})*)\}', block, css)


def generate(tpl):
    lines, files, maps = load(tpl)
    g = Gen(lines, files, maps, compute(files, maps))
    return g.run(1) + g.run(2)


if __name__ == '__main__':
    open('site/page.a0', 'w').write(generate('site/gen/page.tpl'))
    open('site/docs.a0', 'w').write(generate('site/gen/docs.tpl'))
    print('wrote site/page.a0 site/docs.a0')
