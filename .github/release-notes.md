# JellyMark — first public release

A standalone Watchlist for Jellyfin web, with optional syncing between two Jellyfin servers.

Part of **JellyPi**, a larger Jellyfin TV project. The Watchlist works independently.

Based on and adapted from **[KefinTweaks Watchlist](https://github.com/ranaldsgift/KefinTweaks)** by **ranaldsgift**. JellyMark reuses substantial Watchlist code under the MIT license; original copyright and license notices are included.

## Downloads

- **jellymark.js** — the Watchlist script. Paste it into JavaScript Injector.
- **jellymark-v3.2.1.zip** — the complete project, including the optional Docker sync service and installation guide.
- **SHA256SUMS.txt** — checksums for the downloads.

See the [installation guide](https://github.com/isaacAmejia/jellymark/blob/v3.2.1/README.md) for setup and updates.

## Included

- Bookmark buttons, movie/show filters, and theme-aware styling.
- Season-based Watch History, series posters in Series Progress, and viewing statistics.
- Watchlist import/export and playlist tools.
- Optional per-user, two-way Watchlist sync with conservative media matching.

Includes Watchlist UI **3.2.1** and JellyMark Sync **3.0.1**. This release brings the tested Watchlist and sync service to JellyMark with clearer installation instructions and preserved upstream credits. It does not add playback-state sync or TV remote controls.

Existing KefinTweaks Watchlist entries are retained. Replace your existing Injector entry with `jellymark.js` and reload Jellyfin; do not enable both copies. For a sync-service upgrade, back up and reuse your existing data folder and set `CONTAINER_NAME` to your current container name when running the launcher.

