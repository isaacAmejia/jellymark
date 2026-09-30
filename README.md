# JellyMark

**JellyMark adds a personal watchlist to Jellyfin Web and can optionally sync that watchlist between two Jellyfin servers.** Save movies, series, and seasons, track viewing progress and history, and keep paired users' Watchlists synchronized across separate Jellyfin instances. **The Watchlist works on its own—no sync service or KefinTweaks required.**

- Save movies, series, and seasons with a bookmark button.
- Browse Series Progress, movie/season Watch History, and Statistics.
- Use your current Jellyfin theme, including GlassFin.
- Import/export your Watchlist or copy it to a playlist.

**Based on [KefinTweaks Watchlist](https://github.com/ranaldsgift/KefinTweaks) by ranaldsgift.** JellyMark reuses and adapts substantial Watchlist code, with a standalone interface and optional cross-server sync. Thanks to the original author and contributors. [MIT license and credits](THIRD_PARTY_NOTICES.md).

[Download the latest release](https://github.com/isaacAmejia/jellymark/releases/latest) · [What's changed](CHANGELOG.md)

Trying to **add a Watchlist to Jellyfin** or **sync a Jellyfin Watchlist between two servers**? See [Jellyfin Watchlist and cross-server sync](docs/jellyfin-watchlist.md).

Part of **JellyPi**, a larger project bringing together Jellyfin tools for a smoother TV experience. This Watchlist can also be used independently.

## Install the Watchlist

You need Jellyfin web and the [JavaScript Injector plugin](https://github.com/n00bcodr/Jellyfin-JavaScript-Injector).

1. Download **jellymark.js** from the release, or open [the script](ui/jellymark.js) and click **Raw**.
2. In Jellyfin, open **Dashboard → JavaScript Injector → Add Script**.
3. Name it **JellyMark**, paste the entire file as JavaScript, enable it, and save. Do not include `<script>` tags or Markdown fences.
4. If you use KefinTweaks, disable its Watchlist module to avoid duplicate controls. Your existing entries are kept.
5. Fully reload Jellyfin. Open **Watchlist** beside your Home tabs or from the sidebar.

An outlined bookmark adds an item; a filled bookmark removes it. Bookmarking an episode saves its season. Watched items are automatically removed from the Watchlist.

This adds the UI to Jellyfin web, not native apps such as Roku. TV remote navigation is handled by your separate navigation script.

## Optional: sync two servers

Install the Watchlist on both servers first. Run **one** sync container on a machine that can reach both Jellyfin servers. Each Watchlist keeps working when sync is stopped.

**Requirements:** Docker and Bash, plus OpenSSL or Python 3 to generate the admin token.

1. Download and extract **jellymark-v3.2.1.zip** from the release. Open a terminal in the extracted `jellymark` folder and run:

   ```bash
   bash run-docker.sh
   ```

2. Open `http://YOUR-SERVER-HOST:8788`. Read the admin token locally with `cat data/admin-token`, paste it into the page, and click **Unlock**. Keep this token private.
3. On each Jellyfin server, create an API key under **Dashboard → API Keys**. In the sync page, enter each server's address and its own key. Use the server address without `/web`; `localhost` inside Docker refers to the sync container.
4. Click **Save connections**, **Test connections**, then **Load users**.
5. Click **Add pair**, choose one user from each server, and set **Direction** to **Two-way**. For **Initial bootstrap** (the first sync), choose **Merge** to combine both existing lists. Use **Make B match A** only if A should replace B's matched Watchlist entries.
6. Review **Auto-remove watched** and **Conflict winner**, then click **Save pairs**. Enabled pairs start syncing immediately. Click **Sync now** to test an unwatched movie available on both servers.

Sync runs about every **15 seconds** by default; change **Poll seconds** and save connections to adjust it. Use **Refresh Watchlist** if a change has not appeared yet. Only paired users are synced, and uncertain media matches are skipped.

Sync shares Watchlist membership. It does **not** copy media files, playback progress, watched status, or requests between servers.

## Updates and help

- **Watchlist:** replace the existing Injector script with the new file and fully reload Jellyfin.
- **Sync service:** back up your data, extract the new release, then run `DATA_DIR=/absolute/path/to/existing/data bash run-docker.sh`. If upgrading an existing container with a different name, also set `CONTAINER_NAME` to that name. Keep using the same data folder; it contains your settings, admin token, and sync history.
- **Trouble connecting or syncing?** See [setup options and troubleshooting](docs/setup.md).
- **Found a bug?** [Open an issue](https://github.com/isaacAmejia/jellymark/issues) with your Jellyfin/browser versions and steps to reproduce. Remove API keys, tokens, and personal details from screenshots or logs.

JellyMark v3.2.1 includes Watchlist UI **3.2.1** and JellyMark Sync **3.0.1**. Licensed under [MIT](LICENSE).
