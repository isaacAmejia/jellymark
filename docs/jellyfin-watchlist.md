# Jellyfin Watchlist and Cross-Server Sync with JellyMark

JellyMark is a Jellyfin Web enhancement for people who want a personal **Jellyfin Watchlist** and, optionally, **Watchlist synchronization between two Jellyfin servers**.

## Add a Watchlist to Jellyfin

JellyMark adds a bookmark-based Watchlist directly to Jellyfin Web. It supports movies, series, and seasons and also provides Series Progress, movie/season Watch History, Statistics, import/export, and playlist export.

The Watchlist works independently. You do not need to run the sync service if you only want a Watchlist on one Jellyfin server.

See the main [JellyMark installation instructions](../README.md#install-the-watchlist).

## Sync a Jellyfin Watchlist between two servers

If you run two separate Jellyfin instances, JellyMark can pair users and synchronize Watchlist membership between them.

The sync service:

- supports two-way synchronization
- can merge existing Watchlists during initial setup
- matches equivalent media across separate Jellyfin libraries
- skips uncertain media matches rather than forcing them
- lets each Watchlist continue working if the sync service is stopped

See [Optional: sync two servers](../README.md#optional-sync-two-servers) for setup.

## What JellyMark syncs

JellyMark syncs **Watchlist membership**.

It does not copy media files, playback progress, watched status, or media requests between Jellyfin servers.

## Related JellyPi project

For TV remote and D-pad navigation in Jellyfin Web, including navigation inside JellyMark, see [JellyNav](https://github.com/isaacAmejia/jellynav).
