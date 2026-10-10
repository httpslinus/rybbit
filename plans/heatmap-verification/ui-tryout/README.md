# Local heatmap UI tryout

Fresh test run on 2026-10-10 against the isolated local stack at `http://localhost:18033`. The retained **Heatmap UI tryout** site (ID 26) contains 141 trusted clicks across nine identified sessions at widths 375/768/1440: 114 on `/` and 27 on `/pricing`. Replay was off. All 18 compact uploads and 18 ordinary analytics requests succeeded.

The Northstar page is a local responsive demo fixture. Its interactions were captured by the shipped tracker and stored through normal APIs. Screenshots show the actual Rybbit UI and real report responses. Browser interception serves only the identical demo page as the live iframe background, with its tracker disabled.

The report test passed seven checks after the layout refinement: recorded hotspot counts, width switching, page search/selection, scroll bands/table, geometry-only/live-background toggling, cohort editor, and mobile picker/fullscreen/focus restoration. Existing local Stripe initialization and the demo domain's favicon 404 are recorded separately; the favicon failure also reproduces on the existing main dashboard. All heatmap API responses succeeded. Prior harness validation attempts remain in the evidence.

To repeat from the repository root with the local stack running:

```sh
node plans/heatmap-verification/ui-tryout/collect.mjs
node plans/heatmap-verification/ui-tryout/capture.mjs
node plans/heatmap-verification/ui-tryout/filter-check.mjs
HEATMAP_UI_QA_BUILD=3801a7b node plans/heatmap-verification/ui-tryout/layout-check.mjs refined
node plans/heatmap-verification/ui-tryout/load-check.mjs
```

The collector creates and retains a new local QA site. Dashboard captures use the collection calendar day so the evidence remains repeatable after the original one-hour window. Credentials stay in the ignored parent `.cache/state.json` and are never included in screenshots or evidence. Full Chrome for Testing renders the screenshots at DPR 2: desktop 1680×1050 CSS px / 3360×2100 output px; phone 375×900 CSS px / 750×1800 output px. No screenshot CSS, report-response substitution, or image editing is applied.

- [Collection evidence](collection.json)
- [Dashboard test and capture evidence](report.json)
- [Filter interaction evidence](filter-evidence.json)
- [Fresh page load evidence](load-evidence.json)
- [Desktop clicks](screenshots/desktop-clicks.png)
- [Desktop scroll](screenshots/desktop-scroll.png)
- [Selected-page sample details](screenshots/layout-refined-sample-details.png)
- [Cohort dialog](screenshots/cohort-dialog.png)
- [Phone fullscreen](screenshots/mobile-fullscreen.png)
- [Desktop Filter panel](screenshots/filter-desktop-options.png)
- [Applied event-type chip](screenshots/filter-desktop-active.png)
- [Phone Filter panel](screenshots/filter-mobile-375-options.png)

## Layout refinement

Heatmaps now follows Replay's split workspace and the shared compact toolbar used by Pages and Events. Click/scroll mode stays visible above the workspace; the Low/High legend aligns right in the background-controls row. The live-background explanation is available from its info tooltip. The preview fills the remaining workspace instead of stopping at 640px, and the workspace excludes the marketing footer. Long selected paths truncate with the complete path available on hover; width-menu metadata wraps within the viewport. The shared date controls use tighter phone spacing and wrap when necessary, preserving a single row at 375px and keeping navigation accessible at 320px.

The page picker shows paths. Hostnames appear in the picker and selected-page header only when the returned pages and selected page span multiple hosts, so a single-host report does not repeat the site identity. Selection still uses both host and path. Sample details are available from a labeled button in the selected-page header, including fullscreen, and show counts for the selected viewport. The narrower picker leaves more room for the preview. Match all/Match any lives beside the active filter chips and appears for at least two added conditions, or when a saved link uses Match any. The Filter button adds conditions; the matching control determines their AND/OR behavior. Saved segments remain required.

Event type and bounce exclusion now live inside the Filter popover. Cohorts use an additional tab modeled on Segments, including its searchable list, selection checkmarks, row actions and create button. Applied report conditions use the existing ButtonGroup chip treatment and clear only their own URL selectors. Cohort chips open their historical definition using the SegmentChip detail pattern. The cohort editor stays outside the popover so closing Filter does not unmount it.

The UX pass reuses these established solutions:

| Heatmap interaction                    | Existing Rybbit solution                                              |
| -------------------------------------- | --------------------------------------------------------------------- |
| Page-dependent Filter choices          | `SubHeader` and `availableFilters` on Replay, Events and Goals        |
| Saved historical audiences             | `NewFilterButton` tabs and `SegmentsTab` searchable selection/actions |
| Active choices and saved-group details | `FilterChip`, `SegmentChip` and shared `ButtonGroup`                  |
| Page picker and split preview          | Replay workspace                                                      |
| Clicks/Scroll mode                     | Shared `AnalysisBar` and `SegmentedControl` used by other reports     |
| Secondary sample information           | Labeled Button/Popover trigger instead of a dedicated chart icon      |
| Cohort editing                         | Shared Dialog, form fields and FilterPicker used by segment editing   |

Dot-separated UI summaries were replaced throughout the client with natural wording, spaced fields, parentheses, count badges, or CSS dividers. All 12 message catalogs were updated and validated for ICU placeholders and plural forms.

The refinement passed all 1,516 client tests, client typechecking, native and local Docker production builds, and the seven live-dashboard checks. Repository lint and scoped heatmap lint pass; scoped checks on older copy-only screens retain nine errors already present in HEAD, with no introduced errors.

The independent responsive run passed 23 checks at 320/375/768/1440/1680px: width-menu bounds, keyboard mode and page scrolling, tooltip focus, a path/hostname-only picker, click and scroll sample details, fullscreen popover behavior, matching-control visibility and URL persistence, and date-navigation bounds on Heatmaps and Main. At 1680×1050, the desktop preview grew from 640px to 838px (198px, about 31%). At 375×900, the preview is fully visible from y257 to y891, with 634px of height, instead of extending below the screen. At 320px it retains 594px of height. All 19 report API responses returned 200.

The Filter pass passed nine additional browser checks: closed defaults, existing tabs, event-type and bounce requests, removable chips preserving unrelated URL state, real cohort creation/selection/details/editing, phone bounds, and Main retaining its existing two tabs. All 17 heatmap/cohort responses succeeded, including the real cohort creation returning 201. Six fresh production page loads also check desktop and phone widths at normal speed and 6x CPU throttling. Together with the seven report checks and 23 responsive checks, this is 45 browser checks against the updated local production image `3801a7b`.

Runtime checks retain raw errors and assert that none are new relative to the measured previous build. The local empty Stripe-key error is already present. Both React hydration messages (`#418`, text and HTML) also reproduce in the previous production image `71eed09` under 6x CPU throttling; the failed negative comparison is preserved in [baseline-load-evidence.json](baseline-load-evidence.json). Only those exact observed messages on this site's Heatmaps route are classified as existing hydration errors. They remain unresolved; passing functional checks does not mean the legacy hydration issue was repaired.

Independent before/after measurements and responsive checks are saved in [layout-evidence.json](layout-evidence.json). The original screenshots are preserved under `screenshots-before/`, with independently measured baseline screenshots alongside the refined captures.

The hostname follow-up was validated in local production image `f472404`: 18 report tests, repository and scoped lint, typechecking, production build, seven report checks and 23 responsive checks passed. Single-host click and scroll page lists now contain paths alone; multi-host regression checks verify that identical paths remain distinguishable and select the correct host. The latest report and layout screenshots reflect this follow-up. The prior 45-check filter-consolidation run and captures remain in the evidence history.
