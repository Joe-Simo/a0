# Explicit commit-lock recovery

The baseline allowed recovery from an unscoped absent PID and did not explicitly require
project-owner authority after recipient unlock. The reproduction and bounded measurements
are recorded in `results/protection-lock-recovery.json`.

The CLI now requires an authenticated project owner. New locks carry local boot and PID
namespace metadata; recovery refuses live, legacy, foreign or otherwise unverifiable owners.
A separate exclusive recovery marker prevents competing recovery attempts. Recovery checks
the reviewed digest and file identity and refuses symbolic links. Incomplete stores without
authenticated owner metadata are not recovered by this command.

This is cooperative local-process coordination, not protection from a compromised host.
Other hosts, old locks and a crashed recovery marker remain fail-closed limitations.
Plaintext-writer leases and arbitrary external tools are separate unfinished work.
The focused checks and warm encrypted-write cost results are in the result file; cold-start
cost and isolated memory overhead are not established. Full-platform/security acceptance
and the public language cutover remain outstanding.
