# netlab REST API

A zero-dependency Node.js REST API that runs **on an OpenWrt test router** and
exposes per-direction network impairment control (latency, jitter, packet loss,
and bandwidth) over WAN.

It is the automation layer on top of Section 7/8 of `openwrt_basic_setup.md`:
the API writes validated values into the `netlab` UCI config and reloads the
`/etc/init.d/netlab` service, which drives `tc`/`netem` on both shaped
interfaces.

- `upload`   = WAN egress    (test clients -> internet)
- `download` = br-lan egress (internet -> test clients)

## Design

- **Runtime:** Node.js built-in `http` only. No npm dependencies to install on
  the router.
- **Backend:** the `netlab` UCI config + init script (persistent across reboots
  and WAN reconnects via the hotplug hook).
- **Safety:** every input is validated to strict numeric bounds, and all router
  commands run via `execFile` with an argument array (never a shell string), so
  the unauthenticated endpoint cannot be used for command injection.

> Security: this deployment ships **without authentication**. Only expose it on
> a trusted/isolated WAN. See "Hardening" below.

## Documentation

- [`docs/deployment.md`](docs/deployment.md) — how to deploy, run, and manage the
  server on the OpenWrt router.
- [`docs/api.md`](docs/api.md) — full API reference (kept consistent with
  [`openapi.yaml`](openapi.yaml), the source of truth).

## Layout

```
netlab-api/
  server.js                       # HTTP server + routing
  openapi.yaml                    # OpenAPI 3.1 spec
  package.json
  lib/
    exec.js                       # execFile wrapper (no shell)
    validate.js                   # strict input validation
    uci.js                        # read/write netlab.main.* via uci
    netem.js                      # JSON <-> UCI conversion + apply/clear
    status.js                     # live device resolve + tc counters
    profiles.js                   # Section 9 presets
  files/
    etc/config/netlab             # UCI config (Section 8.1)
    etc/init.d/netlab             # impairment init script (Section 8.2)
    etc/init.d/netlab-api         # procd service that runs server.js
    etc/hotplug.d/iface/95-netlab # reapply after reconnect (Section 8.4)
  scripts/
    install.sh                    # on-router installer
```

## Install (on the router)

1. Copy the package to the router:

```sh
scp -r netlab-api root@192.168.50.1:/root/
```

2. Run the installer on the router:

```sh
ssh root@192.168.50.1
cd /root/netlab-api
sh scripts/install.sh
```

The installer:
- adds the [nxhack prebuilt Node.js feed](https://github.com/nxhack/openwrt-node-packages)
  and installs `node` (OpenWrt 25.12+ has no official target `node` package),
  auto-detecting the release and arch;
- installs the app to `/usr/lib/netlab-api`;
- installs the config, init scripts, and hotplug hook, and enables both
  services;
- adds a WAN firewall rule opening TCP `8080` (override with
  `NETLAB_API_PORT=... sh scripts/install.sh`).

3. Verify:

```sh
curl http://<router-wan-ip>:8080/healthz
```

If `node` cannot be installed automatically (unknown release/arch), install it
manually per the nxhack instructions and re-run `scripts/install.sh`.

## Endpoints

Base path: `/api/v1`. Full contract in [`openapi.yaml`](openapi.yaml)
(also served live at `GET /openapi.yaml`).

| Method | Path | Description |
| --- | --- | --- |
| GET | `/healthz` | Liveness probe |
| GET | `/openapi.yaml` | This OpenAPI document |
| GET | `/api/v1/impairment` | Current profile |
| PUT | `/api/v1/impairment` | Replace full profile and apply |
| PATCH | `/api/v1/impairment` | Partial update and apply |
| DELETE | `/api/v1/impairment` | Clear all impairment |
| GET | `/api/v1/status` | Live device mapping + `tc` counters |
| GET | `/api/v1/profiles` | List preset profiles |
| POST | `/api/v1/profiles/{name}/apply` | Apply a preset |

### Profile model

```json
{
  "enabled": true,
  "queueLimit": 1000,
  "upload":   { "rateMbit": 20, "delayMs": 50, "jitterMs": 10, "lossPct": 1 },
  "download": { "rateMbit": 20, "delayMs": 50, "jitterMs": 10, "lossPct": 1 }
}
```

- `rateMbit`: bandwidth cap in Mbit/s (`0` = unlimited)
- `delayMs`: one-way added delay (per shaped interface)
- `jitterMs`: delay variation
- `lossPct`: random packet loss percentage (0-100)

Presets (`GET /api/v1/profiles`): `clean-constrained`, `good-lte`, `poor-lte`,
`satellite-like`, `severe-failure`.

## Examples

```sh
HOST=http://192.168.50.1:8080

# Current impairment
curl $HOST/api/v1/impairment

# Replace the full profile (asymmetric: 5 up / 30 down)
curl -X PUT $HOST/api/v1/impairment \
  -H 'Content-Type: application/json' \
  -d '{
    "enabled": true,
    "queueLimit": 1000,
    "upload":   { "rateMbit": 5,  "delayMs": 80, "jitterMs": 25, "lossPct": 2 },
    "download": { "rateMbit": 30, "delayMs": 20, "jitterMs": 5,  "lossPct": 0.2 }
  }'

# Bump only the download loss to 5%
curl -X PATCH $HOST/api/v1/impairment \
  -H 'Content-Type: application/json' \
  -d '{ "download": { "lossPct": 5 } }'

# Apply a preset
curl -X POST $HOST/api/v1/profiles/poor-lte/apply

# Live tc counters
curl $HOST/api/v1/status

# Remove all impairment
curl -X DELETE $HOST/api/v1/impairment
```

## Service management

```sh
/etc/init.d/netlab-api {start|stop|restart|enable|disable}   # the API server
/etc/init.d/netlab     {start|stop|restart|reload}           # the shaping itself
logread -e netlab-api                                        # API logs
logread -e netlab                                            # shaping logs
```

## Local development

You can run the server on any Linux host for smoke testing. The `tc`/`uci`/`ubus`
calls will fail without OpenWrt, but validation, routing, and error handling can
be exercised:

```sh
cd netlab-api
node server.js          # listens on 0.0.0.0:8080
curl localhost:8080/healthz
curl localhost:8080/api/v1/profiles
```

## Hardening (recommended before real WAN exposure)

This build has no auth by request. To reduce exposure:

- Restrict the firewall rule `Allow-netlab-api` to specific source subnets.
- Terminate TLS in front of the API (e.g. an nginx/uhttpd reverse proxy).
- Add a bearer-token check in `server.js` (read the expected token from a UCI
  option) as a follow-up.
