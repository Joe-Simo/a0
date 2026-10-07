#!/bin/sh
# Prints the machine, the tool versions and the load the timing gate sees. Writes nothing. About 30 s (the build).
# Usage: sh scripts/bench-repro/check.sh
. "$(dirname "$0")/lib.sh"
build >/dev/null

echo "machine:  $(node -p "process.platform + '-' + process.arch + ', ' + require('os').cpus().length + ' cpus, ' + require('os').cpus()[0].model.trim()")"
echo "node:     $(node --version)"
echo "bun:      $(bun --version)"
for t in clang gcc rustc zig go java dotnet qemu-system-x86_64 qemu-riscv64 iverilog yosys z3; do
  if have "$t"; then
    v=$("$t" --version 2>&1 | head -1) || v=$("$t" -version 2>&1 | head -1)
    echo "$t: $v"
  else
    echo "$t: not found"
  fi
done
echo "load:     $(node -e "import('./dist/tools/system-load.js').then(m => console.log(m.loadSource() + ' ' + m.systemLoad().toFixed(2) + ' (limit ' + (process.env.A0_MAX_LOAD ?? '10') + ')'))")"
echo "A0 timing runs wait until the load is at or below the limit; see README.md."
