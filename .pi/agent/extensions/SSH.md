# SSH Extension (ssh.ts)

**Location:** `~/.pi/agent/extensions/ssh.ts`

This extension overrides built‑in tools to run on a remote host via SSH when `--ssh` is provided. It is auto‑loaded from `~/.pi/agent/extensions/`.

## Summary of behavior

- Remote mode is enabled with `--ssh user@host` or `--ssh user@host:/remote/path`.
- When SSH is active, these tools run remotely:
  - `read`, `write`, `edit`, `ls`, `find`, `grep`, `bash`
- Other tools (`pi_run`, `web_search`, `remember`, `recall`) remain local by design.
- SSH uses non‑interactive options: `BatchMode=yes`, `ConnectTimeout=10`.
- If `--ssh` is set but the connection fails, **tools error** (no silent local fallback).

## Flags

- `--ssh user@host[:/remote/path]`
- `--ssh-debug` → updates status bar with per‑tool remote/local info
- `--ssh-verify /path` → checks and lists a remote path on connect

### CLI fallback parsing

The extension also reads `process.argv` directly for `--ssh`, `--ssh-debug`, and `--ssh-verify` to support print/json mode where registered flags may not be wired early enough.

## Remote AGENTS.md injection

If `AGENTS.md` exists in the **remote cwd**, its contents are injected into the model context as a **user message** on each call. This is not a true “context file” (because extensions cannot modify the resource loader), but it is functionally equivalent for the model.

Marker used in the injected message:

```
[Remote AGENTS.md]
...
```

## Remote tool implementations

### read / write / edit

- Use `resolveRemotePath()` for consistent mapping.
- `edit` uses the standard edit tool with remote read/write ops.
- A transient “file not found” flash can occur in the UI during edit in SSH mode due to the edit tool’s pre‑flight access check and remote latency.

### ls

- Custom remote implementation using `ls -A -p` for directory markers.
- Enforces local tool’s 50KB output cap and entry limits.

### find

- Uses **ripgrep** (`rg --files --hidden -g <pattern>`) on the remote.
- Requires `rg` to be installed remotely.
- Returns paths relative to the remote search directory.
- Enforces output size and result limits similar to the local tool.

### grep

- Uses **ripgrep** in `--json` mode on the remote.
- Requires `rg` to be installed remotely.
- Reads matching files via `cat` over SSH to build context lines.
- Enforces match limits and line truncation similar to the local tool.

### bash

- Runs `ssh remote "cd <remoteCwd> && <command>"`.

## Known gotchas / pitfalls

1. **Remote `rg` required for find/grep.**
   - If `rg` isn’t installed, find/grep will error. There is no fallback to `fd` or `grep` because that would diverge from local behavior and .gitignore handling.

2. **Path mapping assumes “local path == remote path” when absolute.**
   - `resolveRemotePath()` maps:
     - local paths that start with local cwd → remote cwd
     - absolute paths → left as‑is
     - relative paths → resolved under remote cwd

3. **No true context files.**
   - AGENTS.md is injected as a user message, not registered in the resource loader. The model sees it, but the UI won’t list it as a context file.

4. **One remote per agent instance.**
   - The extension stores a single `resolvedSsh`. Multiple remotes require multiple pi processes.

5. **Non‑interactive SSH only.**
   - Password prompts will fail (stdin is ignored). Key‑based auth is required.

6. **`--ssh` parsing with colon.**
   - Only `user@host:/absolute/path` is treated as a remote path; `:` in other contexts (e.g., IPv6) is handled safely.

7. **Edit tool “file not found” flicker.**
   - Caused by the edit tool’s early `access()` check and SSH latency. It doesn’t interrupt execution, but may show a brief UI error.

8. **Auto‑load vs explicit `-e`.**
   - The extension is auto‑loaded from `~/.pi/agent/extensions/`. Using `-e` can help confirm the correct file is loaded during debugging.

## Development notes

- `sshExec()` is the core primitive; all remote tools go through it.
- Always use `resolveRemotePath()` for path mapping.
- Keep output truncation behavior aligned with the built‑in tools to avoid model surprises.
- When adding new remote tools, use the same “no silent local fallback” rule when `--ssh` is set.
