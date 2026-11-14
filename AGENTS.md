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

## Writing on GitHub

It should always be obvious when an agent wrote something, not the person whose account posted it. This covers prose: PR descriptions, issues, comments and reviews. Mechanical writes (pushing, merging, labels, moving board items) are not covered.

- At the start of a session, ask for permission before posting prose under someone's account. Once given, it covers the rest of that session.
- Every piece of prose an agent posts starts with a banner naming the model:

  ```markdown
  > [!NOTE]
  > Written by Claude Opus 5.5
  ```

  Use the name of the model actually writing, not this example's.
