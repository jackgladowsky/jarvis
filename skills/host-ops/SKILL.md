# Host Ops

Use this skill for operations on the owner's Linux host: services, Docker, filesystem layout, logs, and system state.

## Host facts

Read `~/.jarvis/AGENTS.md` before relying on host-specific details. It is hand-curated and authoritative for hostname, OS, user, services, and paths.

If `AGENTS.md` does not cover a discovered durable fact, consider updating `~/.jarvis/data/notes/environment.md` under the memory rules.

## Common commands

```bash
hostnamectl
systemctl list-units --type=service --state=running
sudo systemctl status <service>
sudo systemctl restart <service>
journalctl -fu <service>
docker ps
docker compose ps
df -h
free -h
```

Use `sudo` when needed. Do not ask for permission merely because a command needs sudo.

## Safety

For destructive operations (`rm -rf`, `mkfs`, `dd`, mass deletes, branch/data cleanup), think first. The system permits them; that is not the same as an endorsement from the universe.

Avoid destructive guesses. If product/security/destructive implications are unclear, ask the owner.

## JARVIS paths

Default live layout:

```text
~/jarvis/                  source repo
~/.jarvis/                 host-local data
~/.jarvis/config.yaml      config
~/.jarvis/.env             secrets
~/.jarvis/prompts/system.md live system prompt
~/.jarvis/AGENTS.md        host docs
~/.jarvis/data/audit.log   tool audit log
```

Logs:

```bash
journalctl -fu jarvis
tail -f ~/.jarvis/data/audit.log
tail -f ~/.jarvis/data/jobs/scheduler.log
tail -f ~/.jarvis/data/background/bootstrap.log
```

## Source vs data

Everything under `~/.jarvis/` is host-local and should not be committed. Everything under `~/jarvis/` should be replaceable from git.
