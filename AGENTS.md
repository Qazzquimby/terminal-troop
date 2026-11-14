# Agent principles

Rules for any agent working in this repo.

## Specs

- When a ticket leaves out something that is only a tuning value (speeds, ranges, damage, durations, counts, spawn weights), don't stop to ask. Look for the answer in the code (`src/config.ts`), related tickets and their comments, then make a best guess. Put it in config and list every guess in the PR description so it can be reviewed and changed.
- When a ticket is underdeveloped in a way that config can't fix, such as a missing mechanic or behaviour that could go several different ways, reply with a list of the clarifying questions needed to continue.

## Assets

- Act as if asset files exist and will be provided later. Reference them by the path they would have.
- If loading an asset that doesn't exist yet breaks tests, write the loading code and comment it out.

## Feel

- Give a sound effect to anything that realistically deserves one, even if the spec doesn't mention it.
- Add visual effects where reasonable.
