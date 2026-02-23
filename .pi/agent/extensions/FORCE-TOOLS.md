# force-tools.ts

`force-tools.ts` enforces a fixed set of active tools on every session start and session switch by calling `pi.setActiveTools()`. This overrides whatever tool state pi would otherwise use.

## Why it exists

Tool state was drifting between sessions — either pi's defaults were wrong, or other extensions were adding things unexpectedly. This locks the active set to a known-good list.

## The catch

**Any newly installed tool package will be silently excluded unless you add its tool name to the list in `force-tools.ts`.**

The extension registers fine, but `force-tools.ts` fires immediately on session start and resets the active tools to the hardcoded list. The new tool just disappears without an error.

## What to do when installing a new pi tool package

1. Install the package as normal (`pi install npm:...`)
2. Find the tool name(s) it registers (check the package README or its extension source)
3. Add each name to the `tools` array in `force-tools.ts`
4. Reload pi (`/reload`)

## Current tool list

```
read, edit, write, grep, find, ls, bash,
pi_run, web_search, remember, recall, browser
```
