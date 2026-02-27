# Proposal for Modularizing index.html

## Conclusion
Currently, `app/index.html` holds the entire UI(User Interface) skeleton in a single file. While fast for initial development, with the expansion to 5 tabs (`Environment`, `Downloads`, `YouTube DB`, `Organizer`, `ReNamer`), **modularizing it is now better for maintainability**.

## Why Modularization is Needed Now
- `app/index.html` is already around 390 lines long, requiring developers to read the entire file context even when modifying just a specific tab.
- Having many `id`/`class` selectors per tab increases the chance of collisions and unnecessarily expands the scope of code reviews.
- Combined with the DOM(Document Object Model) binding structure in `app/src/main.js` (1605 lines), tracking functionality at the feature level becomes difficult.

## Recommended Approach (Based on Vite)
1. Keep only the minimal Shell in `index.html`
   - Header
   - Main tab bar
   - Tab mount points like `<main id="tabHost"></main>`
2. Separate Markup per tab into `src/ui/tabs/*.js`
   - `renderServerTab()`
   - `renderDownloadsTab()`
   - `renderSqliteTab()`
   - `renderOrganizerTab()`
   - `renderRenamerTab()`
3. Group event bindings by tab
   - `src/features/server/bindServerEvents.js`
   - `src/features/downloads/bindDownloadEvents.js`
4. Reuse common components (e.g., card header, modal) in `src/ui/components/`

## Implementation Steps (Risk Minimization)
1. **Phase 1**: Move only the markup into functions, keeping existing `id`s (no behavioral changes).
2. **Phase 2**: Separate event bindings for each tab.
3. **Phase 3**: Extract common UI components + E2E(End-to-End) / manual checks.

## Expected Benefits
- Reduced file navigation time when modifying individual tabs.
- Smaller review units, lowering the risk of regressions.
- Improved predictability of the file structure when adding new features.
