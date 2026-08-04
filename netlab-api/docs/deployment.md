# Deploying the netlab REST API on OpenWrt

This guide walks through installing and running the netlab REST API on the
OpenWrt One test router. The API controls per-direction network impairment
(latency, jitter, packet loss, bandwidth) by driving the `netlab` UCI config and
`/etc/init.d/netlab` service.

It assumes Sections 1-7 of `openwrt_basic_setup.md` are already done (the 1 GbE
test subnet is up at `192.168.50.1/24`, clients get DHCP and reach the internet,
and manual `tc`/`netem` impairment has been verified). The installer also lays
down the Section 8 persistence files (`/etc/config/netlab`, `/etc/init.d/netlab`,
the hotplug hook), so you do **not** need to complete Section 8 by hand first.

## 1. Prerequisites

- SSH access to the router (from the test subnet, e.g. `ssh root@192.168.50.1`).
- The serial console available as a recovery path, since shaping can affect the
  management path (see the warnings in `openwrt_basic_setup.md`).
- Free storage for Node.js. Node is relatively large (tens of MB); confirm with
  `df -h` before installing.
- Internet access from the router (WAN up) so `apk` can fetch the Node package.

> Security: this build ships **without authentication**. Only expose it on a
> trusted/isolated WAN. See [Hardening](#8-hardening) before any real exposure.

## 2. What gets installed

| Path | Purpose |
| --- | --- |
| `/usr/lib/netlab-api/` | The Node application (`server.js`, `lib/`, `openapi.yaml`) |
| `/etc/config/netlab` | UCI config holding the current impairment profile |
| `/etc/init.d/netlab` | Applies/removes the `tc`/`netem` qdiscs from UCI |
| `/etc/init.d/netlab-api` | procd service that runs the Node server |
| `/etc/hotplug.d/iface/95-netlab` | Reapplies shaping after a WAN reconnect |
| firewall rule `Allow-netlab-api` | Opens the API TCP port on the WAN zone |

## 3. Copy the package to the router

From your workstation, in the directory that contains `netlab-api/`:

```sh
scp -r netlab-api root@192.168.50.1:/root/
```

If your workstation is isolating the test interface in a network namespace (see
`notes.md`), prefix with `sudo ip netns exec openwrt-test`:

```sh
sudo ip netns exec openwrt-test scp -r netlab-api root@192.168.50.1:/root/
```

## 4. Run the installer

```sh
ssh root@192.168.50.1
cd /root/netlab-api
sh scripts/install.sh
```

The installer performs these steps (`scripts/install.sh`):

1. **Node.js** - if `node` is missing, it configures the
   [nxhack prebuilt feed](https://github.com/nxhack/openwrt-node-packages) and
   runs `apk add node`. OpenWrt 25.12+ has no official target `node` package, so
   this third-party feed is required. The release and package arch are
   auto-detected from `/etc/openwrt_release` (`DISTRIB_RELEASE` and
   `DISTRIB_ARCH`, e.g. `aarch64_cortex-a53` on the OpenWrt One). Note the feed
   uses this full package arch, not the bare `aarch64` that `apk --print-arch`
   reports.
2. **Application** - copies `server.js`, `openapi.yaml`, and `lib/` to
   `/usr/lib/netlab-api/`.
3. **System files** - installs the config (only if not already present), init
   scripts, and hotplug hook; makes them executable; and enables both the
   `netlab` and `netlab-api` services for boot.
4. **Firewall** - adds an `Allow-netlab-api` rule opening TCP `8080` on the WAN
   zone (idempotent - skipped if already present).
5. **Start** - restarts `netlab` (applies current impairment) and `netlab-api`
   (starts the server).

### Choosing a different port

The default port is `8080`. To use another port, set `NETLAB_API_PORT` for both
the installer (firewall rule) and the service (see step 6):

```sh
NETLAB_API_PORT=9090 sh scripts/install.sh
```

### If automatic Node install fails

If the release/arch can't be detected (e.g. a snapshot build), the installer
stops before installing Node and prints guidance. Install Node manually per the
nxhack instructions, then re-run `sh scripts/install.sh` - the remaining steps
are idempotent.

## 5. Verify

```sh
# On the router or any host that can reach it
curl http://192.168.50.1:8080/healthz
# -> {"status":"ok"}

# Current impairment profile (reads from UCI)
curl http://192.168.50.1:8080/api/v1/impairment

# Live device mapping + tc counters
curl http://192.168.50.1:8080/api/v1/status
```

From a WAN-side host, substitute the router's WAN IP for `192.168.50.1`.

A quick end-to-end check:

```sh
# Apply a preset, then confirm ping RTT/jitter changes from a test client
curl -X POST http://192.168.50.1:8080/api/v1/profiles/poor-lte/apply
ping -c 20 1.1.1.1

# Remove impairment
curl -X DELETE http://192.168.50.1:8080/api/v1/impairment
```

## 6. Running and managing the service

The API runs under procd as `netlab-api`, with `respawn` enabled so it restarts
on crash.

```sh
/etc/init.d/netlab-api start      # start now
/etc/init.d/netlab-api stop       # stop
/etc/init.d/netlab-api restart    # restart
/etc/init.d/netlab-api enable     # start on boot (installer already does this)
/etc/init.d/netlab-api disable    # do not start on boot
```

The shaping itself is a separate service:

```sh
/etc/init.d/netlab restart        # re-resolve devices and reapply from UCI
/etc/init.d/netlab stop           # tear down qdiscs
/etc/init.d/netlab reload         # stop + start (what the API calls on writes)
```

### Environment overrides

The service reads two environment variables (defaults shown):

- `NETLAB_API_HOST` (default `0.0.0.0`) - bind address.
- `NETLAB_API_PORT` (default `8080`) - listen port.

These are set in `/etc/init.d/netlab-api`. To change the port after install,
edit that file's `NETLAB_API_PORT` default, update the firewall rule's
`dest_port`, then:

```sh
uci commit firewall && /etc/init.d/firewall reload
/etc/init.d/netlab-api restart
```

## 7. Logs and troubleshooting

```sh
logread -e netlab-api     # API server stdout/stderr (via procd)
logread -e netlab         # shaping: applied tc commands, resolve failures
```

| Symptom | Likely cause / fix |
| --- | --- |
| `curl` to `/healthz` refused | Service not running (`/etc/init.d/netlab-api status`) or firewall rule missing |
| `/healthz` works locally but not over WAN | Firewall rule absent or wrong port; check `uci show firewall \| grep netlab-api` |
| API returns `500` on writes | `netlab` failed to resolve a device or `tc` errored; check `logread -e netlab` |
| `apply`/`PUT` succeeds but no shaping seen | Flow offloading enabled, or a competing root qdisc (SQM/QoS). See Section 11 of the setup guide |
| Impairment lost after WAN reconnect | Confirm `/etc/hotplug.d/iface/95-netlab` exists and is executable |
| `node: not found` | Node install failed; install manually and re-run the installer |
| `UNTRUSTED signature` / `1 unavailable` on the nxhack feed | Expected: the nxhack index isn't signed with a key in apk's trust store. The installer uses `--allow-untrusted` (the maintainer's documented workaround) so node still installs. To do it by hand: `apk add --allow-untrusted node`. |

Confirm the shaping is actually live:

```sh
WAN_DEV="$(ubus call network.interface.wan status | jsonfilter -e '@.l3_device')"
TEST_DEV="$(ubus call network.interface.lan status | jsonfilter -e '@.l3_device')"
tc -s qdisc show dev "$WAN_DEV"
tc -s qdisc show dev "$TEST_DEV"
```

The same information is available over HTTP via `GET /api/v1/status`.

## 8. Hardening

This deployment has no auth by request. Before exposing it to anything but a
trusted/isolated network:

- **Restrict the source.** Narrow the `Allow-netlab-api` firewall rule to
  specific source subnets/hosts rather than the whole WAN:

```sh
uci set firewall.@rule[-1].src_ip='203.0.113.0/24'
uci commit firewall && /etc/init.d/firewall reload
```

- **Add TLS.** Terminate HTTPS with a reverse proxy (uhttpd/nginx) in front of
  the API; keep the Node server bound to localhost in that case.
- **Add a token.** As a follow-up, read an expected bearer token from a UCI
  option and check it in `server.js`.

## 9. Uninstall

```sh
/etc/init.d/netlab-api stop && /etc/init.d/netlab-api disable
/etc/init.d/netlab stop && /etc/init.d/netlab disable
rm -rf /usr/lib/netlab-api
rm -f /etc/init.d/netlab-api /etc/init.d/netlab \
      /etc/hotplug.d/iface/95-netlab /etc/config/netlab

# Remove the firewall rule (find its index in: uci show firewall)
# then: uci delete firewall.@rule[<index>]; uci commit firewall
/etc/init.d/firewall reload
```

This mirrors the rollback in Section 13 of `openwrt_basic_setup.md`; it removes
the qdiscs, services, and automation files. Restore the conventional LAN address
separately if desired.
