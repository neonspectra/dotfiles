# pi-agent-browser

Documents how to get the `browser` tool working on a new machine.

## What it is

`pi-agent-browser` is an npm package that registers a `browser` tool in pi. It wraps `agent-browser`, which drives a real Chromium instance. The LLM can open URLs, take screenshots, click elements, fill forms, and so on.

The extension itself lives in npm — not in this folder — so there's nothing to copy. You just need to reinstall it and apply the `force-tools.ts` fix.

## Steps

### 1. Install the pi extension

```bash
pi install npm:pi-agent-browser
```

This downloads the package and registers the extension. Pi handles it automatically.

### 2. Install agent-browser and Chromium

`agent-browser` gets pulled in on first use, but you can do it upfront:

```bash
npm install -g agent-browser
agent-browser install
```

The second command downloads Chromium. It takes a minute.

### 3. Add `browser` to force-tools.ts

This is the step that's easy to miss. `force-tools.ts` runs on every session start and resets the active tool list to a hardcoded array. If `browser` isn't in that array, the extension registers fine but the tool silently disappears.

Open `~/.pi/agent/extensions/force-tools.ts` and add `"browser"` to the `tools` array. See `FORCE-TOOLS.md` for the full current list and more detail on why this matters.

### 4. Reload pi

```bash
/reload
```

The `browser` tool should now appear in the active tool list.

## Verifying it works

Ask pi to open a URL — something like "open https://example.com and tell me the page title." If it calls the `browser` tool and returns a result, you're good.

## Requirements

- A vision-capable model for screenshot descriptions (Claude Sonnet/Opus, GPT-4o, Gemini Pro, etc.). Text-only models can still use the tool but won't be able to interpret screenshots.
