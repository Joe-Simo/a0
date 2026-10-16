// Independent lexer checks token boundaries, not whitespace-stripped byte concatenations.
export function svTokens(s: string) {
  const result: string[] = [];
  let at = 0;
  while (at < s.length) {
    const tail = s.slice(at);
    const m = /^(?:\s+|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)/.exec(tail);
    if (m) {
      at += m[0].length;
      continue;
    }
    const token =
      /^(?:[A-Za-z_$][A-Za-z0-9_$]*|\d+'[sS]?[bBoOdDhH][0-9a-fA-F_xXzZ?]+|\d+|"(?:\\.|[^"\\])*"|<=|>=|==|!=|<<|>>|&&|\|\||\+:|.)/.exec(
        tail,
      )?.[0];
    if (!token) throw Error('SV scanner');
    result.push(token);
    at += token.length;
  }
  return result;
}
