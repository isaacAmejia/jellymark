# JellySync on Unraid

For new Docker installations, `run-docker.sh` and `compose.yaml` use the short
container name **JellySync**. An icon, WebUI link and console shell are provided
through Unraid-recognized labels. The icon is publicly accessible at
`assets/unraid/jellysync.png` in this repository.

These labels improve the Unraid Docker dashboard but **do not convert** a
container into a DockerMan-managed container. Native **Edit** and **Auto-Start**
require a matching Unraid v2 XML template and recreation through DockerMan.
Never put `net.unraid.docker.managed=dockerman` on a container owned by Docker
Compose or a shell script: Unraid's editable template must match the runtime.

When migrating an existing installation:

1. Back up its `/data` bind mount and record the exact current image tag.
2. Preserve the existing admin token, user pairs and API keys. Do not install
   the older public stable image over a newer test image.
3. Preserve port 8788, the current `/data` host directory and its credentials.
4. Import and verify a native XML template before letting DockerMan recreate
   the container. Set Auto-Start in Unraid after validating the new instance.

`run-docker.sh` refuses to create a parallel `JellySync` when one of the older
`jellyfin-watchlist-sync` or `jellymark-sync` containers exists. It also refuses
to replace any native DockerMan-managed container.
