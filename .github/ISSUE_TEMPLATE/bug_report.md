---
name: Bug report
about: A program that is rejected, miscompiled, or behaves differently on two targets
title: ''
labels: bug
---

**What happened**

<!-- One or two sentences. -->

**A minimal program**

```
fn f u32 -> u32
a add p0 1
ret a
end
```

<!-- The smallest `.a0` that shows it. For a miscompile, the call and the result you expected. -->

**What you ran**

<!-- For example: `a0 check file.a0`, `a0 run file.a0 f 5`, `a0 emit c file.a0`. Paste the output or the diagnostic code (A0nnnn). -->

**Environment**

- `a0 --version`:
- OS and architecture:
- Installed from (release binary, Homebrew, built from source):
