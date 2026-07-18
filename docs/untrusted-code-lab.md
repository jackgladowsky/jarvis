# Disposable lab for untrusted web-sourced code (follow-up design)

This is a recommendation, not an implemented host-wide sandbox. Normal trusted JARVIS operations retain their current shell/filesystem authority and confirmation policy. The future lab should be an explicit per-task workflow for code whose provenance is not trusted.

## Isolation boundary

Use a rootless Docker/Podman container created from a pinned minimal image digest for ordinary package/source evaluation. Use an ephemeral KVM-backed VM or microVM (Incus VM/Firecracker) for hostile native code or meaningful container-escape risk. The instance is destroyed after each run.

Never mount the host Docker socket, home directory, SSH agent, JARVIS data, `.env`, credentials, browser profile, or writable source checkout. Copy the source/archive into a fresh volume. Run as non-root with a read-only root filesystem, tmpfs workspace, dropped capabilities, `no-new-privileges`, seccomp/AppArmor, and strict PID/CPU/RAM/time/disk quotas. Export only through a dedicated size/type-scanned handoff directory.

## Network and dependencies

Network is disabled during execution by default. A separate fetch phase downloads explicitly declared URLs/packages through an allowlisted proxy, records hashes and lockfiles, and performs malware/license scanning. The execution phase receives only that immutable dependency bundle and runs offline. Host package-manager caches that may contain credentials are never mounted.

## Trace and promotion

Record the base image digest, source/archive and lockfile hashes, commands, network policy, resource limits, exit status, output descriptors, and exported artifact hashes in the correlated lifecycle trace. Owner approval is needed only when promoting an artifact from the untrusted lab onto the trusted host or executing it there; it must not add friction to normal trusted operations.

Before exposing the workflow, test fork bombs, memory/disk exhaustion, device/socket/symlink access, localhost/LAN/cloud-metadata probes, secret discovery, namespace escape attempts, and poisoned artifact paths/names. A failed cleanup or isolation assertion invalidates the run and exports nothing.
