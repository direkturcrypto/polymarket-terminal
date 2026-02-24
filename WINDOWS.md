# Running Polymarket Terminal on Windows

The project was written with Unix/macOS in mind. These are the issues that prevent or break it on Windows, and how they are addressed.

---

## 1. NPM scripts and environment variables (fixed with cross-env)

**Problem:** Scripts like `npm run mm` and `npm run mm-sim` use Unix-only syntax:

```bash
DRY_RUN=true node src/mm.js
```

On Windows (cmd.exe), `VAR=value command` is not supported. The shell treats `DRY_RUN=true` as a command name, so you get:

- **"DRY_RUN=true is not recognized as an internal or external command"**, or
- The script runs but `process.env.DRY_RUN` is never set, so **dry run vs live mode is wrong** (e.g. `npm run mm-sim` could run live).

**Fix:** Use [cross-env](https://www.npmjs.com/package/cross-env) so the same script works on Windows and Unix. The `package.json` scripts have been updated to use `cross-env DRY_RUN=... node ...`.

**Copy-trade bot:** `npm start` and `npm run dev` do not set `DRY_RUN` in the script; they rely on your `.env` file. So copy-trade already works on Windows as long as you set `DRY_RUN=true` or `DRY_RUN=false` in `.env`.

---

## 2. Blessed terminal UI on Windows

**Problem:** The dashboard uses [blessed](https://github.com/chjj/blessed), which targets Unix terminals. On Windows:

- **Unicode:** Windows often does not use UTF-8 by default. `fullUnicode` / `forceUnicode` can lead to wrong or missing characters (e.g. box-drawing, emoji).
- **ACS (Alternative Character Set):** Border and line drawing can be broken or show as wrong characters (`windows-ansi` is reported as supporting ACS when it does not).
- **Rendering:** Visual glitches and extra newlines are common in cmd.exe and some terminals.

**Fixes applied in code:**

- When `process.platform === 'win32'`, the dashboard enables `terminal: 'windows-ansi'` and turns off ACS-based drawing so borders fall back to ASCII-safe rendering where possible.

**What you should do on Windows:**

1. **Use Windows Terminal** (not legacy cmd.exe) for better UTF-8 and key handling.
2. **Set UTF-8 codepage** before starting the app (in the same terminal):
   ```bat
   chcp 65001
   npm start
   ```
   Or in PowerShell:
   ```powershell
   [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
   npm start
   ```
3. If the TUI is still unusable, you can run the bot logic without the dashboard by not calling the dashboard init (see “Headless” below); that would require a small code path or env flag if the project adds one.

---

## 3. File paths and atomic writes

**Status:** No change needed.

- All paths use `path.join()` and `path.dirname(fileURLToPath(import.meta.url))`, so paths are correct on Windows.
- `fs.renameSync(tempPath, filePath)` overwrites the target on Windows in current Node versions, so atomic writes in `state.js` are fine.

---

## 4. Signals (SIGINT / SIGTERM)

**Status:** No change needed.

Node.js on Windows does receive SIGINT (e.g. Ctrl+C) and SIGTERM in typical environments (Windows Terminal, PowerShell, VS Code terminal). The existing `process.on('SIGINT', ...)` and `process.on('SIGTERM', ...)` shutdown handlers work.

---

## 5. Copying the env file

On Windows there is no `cp` command. Use:

```bat
copy .env.example .env
```

(PowerShell: `Copy-Item .env.example .env`.)

---

## Summary

| Issue              | Effect on Windows              | Fix / workaround                          |
|--------------------|---------------------------------|-------------------------------------------|
| `DRY_RUN=...` in scripts | Scripts fail or wrong mode      | cross-env in npm scripts (done)           |
| Blessed TUI        | Bad Unicode, borders, or layout | Windows options in code + chcp 65001 + Windows Terminal |
| Paths / fs         | OK                              | Already cross-platform                    |
| SIGINT/SIGTERM     | OK                              | Already works in Node on Windows          |
| `.env` copy        | Different command               | Use `copy .env.example .env`              |

After pulling the Windows-related fixes, you can run on Windows:

```bat
chcp 65001
npm install
copy .env.example .env
REM Edit .env with your keys and DRY_RUN=true for simulation.

npm start
npm run mm-sim
npm run sniper-sim
```

Use **Windows Terminal** and set **DRY_RUN** in `.env` or via the cross-env scripts for the correct mode.
