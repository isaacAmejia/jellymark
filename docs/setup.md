# Setup options and troubleshooting

Start with the [installation guide](../README.md). These options are only needed for custom deployments or troubleshooting.

## Where your data lives

Watchlists are stored in each Jellyfin user's native Likes. The browser script uses the signed-in user's session; it does not need a sync API key or admin token.

The sync service keeps its settings and comparison history in `data` beside the launcher:

| File | Purpose |
| --- | --- |
| `config.json` | Server addresses, API keys, and user pairs |
| `state.db` | Media matches and the previous state of each Watchlist |
| `admin-token` | Password for the sync admin page |

Back up this folder before updating. Keep it private and out of Git. Do not delete `state.db` to refresh a Watchlist: losing that history changes how the service recognizes removals.

## Custom data folder or port

```bash
DATA_DIR=/absolute/path/to/watchlist-data HOST_PORT=8789 bash run-docker.sh
```

Use the same `DATA_DIR` whenever you rebuild. When migrating an older installation, set `CONTAINER_NAME` to its existing container name so the launcher replaces it instead of starting a second sync service. Other optional settings are `CONTAINER_NAME`, `IMAGE_NAME`, and `TOKEN_FILE`. The launcher creates a token if needed and prints its file location, never its value. Read that file locally to unlock the admin page.

The launcher needs Docker, Bash, and either OpenSSL or Python 3. It builds the image and replaces the container with the configured name, keeping the selected data folder.

## Docker Compose instead

Choose either Compose or the launcher to manage your container. From the project folder:

```bash
read -rsp 'Choose a long random admin token: ' JWS_ADMIN_TOKEN
printf '\n'
export JWS_ADMIN_TOKEN
docker compose up -d --build
```

Use that token to unlock the admin page. Compose stores data in `./data`; set the same token on future updates. It does not create an `admin-token` file for you.

## First sync and later changes

- **Merge** combines Watchlist entries that can be matched across the two libraries.
- **Make B match A** makes A the starting list; matched entries found only on B can be removed. **Make A match B** does the reverse.
- **Two-way** copies subsequent additions and removals in either direction. One-way options copy only in the chosen direction after the first sync.
- **Conflict winner** chooses which server wins if both sides changed differently between checks.
- **Auto-remove watched** removes matched items watched on either side. It can override keeping an entry during a merge.

The browser UI also removes watched entries while it is running. Watch History and Series Progress always reflect the current Jellyfin server's own user data.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Watchlist tab missing | Confirm the Injector entry is enabled, contains only JavaScript, and reload the page. Disable any duplicate Watchlist script. |
| Two Watchlist buttons | Disable KefinTweaks' Watchlist module or an older copy of this script. Existing Likes are shared, so no migration is needed. |
| Connection test fails | Save connections first. Check each server's address, port, API key, and reachability from the sync container. |
| Item does not sync | Confirm the pair is enabled and its media type is selected. Check **Mappings** and **Recent Log** for unmatched items. |
| Change is not visible | Allow a sync cycle, then use **Refresh Watchlist** on the other server. |
| Token not accepted | Use the token for this container, not a Jellyfin API key. The launcher prints the token file location. |

The health endpoint is `http://YOUR-SERVER-HOST:8788/health`. For the default container, `docker logs --tail 100 jellymark-sync` shows recent activity. Keep the admin page on a trusted network or behind authenticated HTTPS.

### How media matching works

The service reuses confirmed matches, then looks for provider IDs (TMDB, TVDB, IMDb), series/season/episode relationships, matching file-path endings, and finally a unique exact movie/series title and year. It skips ambiguous matches. Check provider metadata and library contents before changing matching settings.

Movies, series, seasons, and episodes can be synced. Other item types shown under **All** stay local.

## Compatibility

Replace your old Injector entry rather than enabling both scripts. Existing Watchlists remain in Jellyfin. Stable browser settings, DOM identifiers, and the `JWS_ADMIN_TOKEN` environment variable are retained for compatibility with earlier installations and separate navigation scripts.

## Development checks

```bash
python3 -m unittest discover -s tests -v
node --check ui/jellymark.js
bash -n run-docker.sh
```

CI also builds the container and runs browser checks with mocked Jellyfin responses. The standalone UI checks run with the sync container stopped. These checks do not claim compatibility with every third-party theme or native client.

Release publishing runs only after those checks pass on a main-branch commit whose message starts with `Release v`. It packages the committed script and source, adds SHA-256 checksums, and creates a GitHub release. Ordinary commits and pull requests do not publish releases.

