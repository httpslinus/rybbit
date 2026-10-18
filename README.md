<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/public/rybbit/horizontal_white.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/public/rybbit/horizontal_black.svg">
    <img src="docs/public/rybbit/horizontal_black.svg" height="70" alt="Rybbit">
  </picture>
    <p align="center">Open Source Web & Product Analytics</p>

<p align="center">
    <a href="https://rybbit.com" target="_blank">Website</a> |
    <a href="https://demo.rybbit.com/81" target="_blank">Demo</a> |
    <a href="https://rybbit.com/docs" target="_blank">Documentation</a> |
    <a href="https://discord.gg/DEhGb4hYBj" target="_blank">Discord</a> |
    <a href="https://github.com/rybbit-io/rybbit?tab=AGPL-3.0-1-ov-file" target="_blank">License (AGPL-3)</a> |
    <a href="https://github.com/rybbit-io/rybbit/blob/master/CONTRIBUTE.md" target="_blank">Contribute</a>
</p>

<a href="https://rybbit.com/" target="_blank">Rybbit</a> is the modern open source and privacy friendly alternative to Google Analytics. It takes only a couple minutes to setup and is super intuitive to use.

<p align="center">
  <a href="https://www.producthunt.com/products/rybbit?embed=true&utm_source=badge-top-post-badge&utm_medium=badge&utm_source=badge-rybbit" target="_blank">
    <img src="https://api.producthunt.com/widgets/embed-image/v1/top-post-badge.svg?post_id=1028220&theme=standard&period=daily" alt="Rybbit - Open Source Google Analytics Replacement | Product Hunt" width="250" height="54" />
  </a>
</p>

<p align="center">
  <strong><a href="https://demo.rybbit.com/81">🔍 View Live Demo</a></strong> - See Rybbit running on a real-life production site.
</p>

<img width="1299" height="797" alt="Screenshot 2025-10-16 at 7 25 20 PM" src="https://github.com/user-attachments/assets/7988ba04-64ee-4410-9972-847d278efa2f" />

<hr>

## This fork

Changes added on top of [upstream Rybbit](https://github.com/rybbit-io/rybbit):

- **Self-hosted dashboards:** Performance (Web Vitals), Pages and Bots.
- **Heatmaps:** click and scroll maps, page grouping, historical cohorts and masked page backgrounds. Work independently of session replay.
- **Smaller tracker downloads:** an 11.1 kB core, deferred heatmap and recording modules, and shared page capture with a standalone fallback.
- **Coolify deployment:** application configuration using persistent databases. See [deployment notes](ops/DEPLOYMENT.md).

## Tracker sizes

Gzip, decimal kB. Upstream `master` at [`1a8f1ff9`](https://github.com/rybbit-io/rybbit/commit/1a8f1ff9ca8beca1c2207866d659d34be3cdcae8), verified 18 October 2026.

| Download                        | Upstream Rybbit |   This fork |
| ------------------------------- | --------------: | ----------: |
| Core tracker                    |         11.1 kB | **11.1 kB** |
| Session recording module        |         82.1 kB |     24.5 kB |
| Heatmap module                  |   Not available |      7.2 kB |
| Standalone page capture         |   Not available |      8.1 kB |
| **Core + recording**            |     **93.1 kB** | **35.6 kB** |
| Core + heatmaps + recording     |   Not available | **42.9 kB** |
| All modules, including fallback |   Not available | **51.0 kB** |

Heatmaps and recording load independently when enabled. Active recording supplies heatmap backgrounds without a second DOM upload; standalone capture loads only when needed. [Implementation and measurements](server/src/analytics-script/README.md).
