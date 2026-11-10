# Verification - 0.1.0

## Supported baseline

Windows x64; DSH exactly 0.2.2-rc.1; Cordis 4.1.0 supplied by DSH; Node >=24.16.0 <25. Tested Node builds: standalone 24.16.0 and installed DSH runtime 24.21.0. Intermediate Node 24 patch builds are not individually certified. Node 20-23, 25+, other DSH versions, Linux/macOS and Windows ARM64 are outside this release support statement.

## Checks

- Full suite on each tested Node runtime: 79 passed, 0 failed, 0 skipped.
- Real Cordis lifecycle: duplicate fibers, surviving owner, independent roots, INFO exclusion, post-dispose exclusion and 20 same-process reloads with default run retention <=16.
- Isolated DSH profile: composed configuration, schema, invalid-bundle control, host boot, WARN/ERROR persistence and INFO exclusion.
- Real desktop installation receipt: main process changed 16776 -> 32668; host changed 2132 -> 32904; startup=1, probe WARN=1, ERROR=1, INFO=0.
- Temporary live-host probe removed; original user patch restored byte-for-byte; link dependency and bundle remain enabled.
- DSH compatibility gate: supported version accepted; sampled older/newer/prerelease and non-Windows hosts rejected. See release.json for the actual release results.
- Packaged source is extracted and retested before delivery; SHA256SUMS and release.json identify the archives and Git commit/tag.

Release verification reads the existing installation receipt; it does not restart the desktop app or change its profile. Tests use isolated scratch directories. Redaction and durability limits remain as described in README.md.
