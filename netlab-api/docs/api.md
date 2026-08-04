# netlab Impairment Control API Reference

**Version:** 1.0.0

This reference is generated from and kept consistent with the OpenAPI 3.1 spec
at [`../openapi.yaml`](../openapi.yaml), which is the source of truth. The live
server also serves the spec at `GET /openapi.yaml`. If this document and the spec
ever disagree, the spec wins.

## Overview

The API controls network impairment on an OpenWrt test router. Traffic is shaped
per direction using `tc`/`netem`:

- `upload` = WAN egress (traffic from test clients toward the internet)
- `download` = br-lan egress (traffic from the internet toward test clients)

The API writes validated values into the `netlab` UCI config and reloads the
`/etc/init.d/netlab` service, so changes persist across reboots and WAN
reconnects.

> Security: this deployment ships **without authentication** and is intended for
> a trusted/isolated WAN. Do not expose it to an untrusted network.

## Server

```
http://{host}:{port}
```

| Variable | Default | Description |
| --- | --- | --- |
| `host` | `192.168.1.1` | Router WAN address |
| `port` | `8080` | API listen port |

All request and response bodies are `application/json` unless noted. The
`/openapi.yaml` document is served as `application/yaml`.

## Conventions

- Numbers are plain JSON numbers (integers or decimals). Units are encoded in the
  field name (`rateMbit`, `delayMs`, `jitterMs`, `lossPct`).
- A `rateMbit` of `0` means "unlimited" (no rate cap applied).
- `delayMs` is **one-way** delay per shaped interface. Applying delay to both
  `upload` and `download` roughly doubles the added round-trip time.
- Writes (`PUT`, `PATCH`, `DELETE`, and profile `apply`) reapply shaping
  immediately and return the resulting profile.

## Endpoints

| Method | Path | Summary |
| --- | --- | --- |
| GET | [`/healthz`](#get-healthz) | Liveness probe |
| GET | [`/openapi.yaml`](#get-openapiyaml) | This OpenAPI document |
| GET | [`/api/v1/impairment`](#get-apiv1impairment) | Get the current profile |
| PUT | [`/api/v1/impairment`](#put-apiv1impairment) | Replace the full profile |
| PATCH | [`/api/v1/impairment`](#patch-apiv1impairment) | Partially update the profile |
| DELETE | [`/api/v1/impairment`](#delete-apiv1impairment) | Clear all impairment |
| GET | [`/api/v1/status`](#get-apiv1status) | Live shaping status |
| GET | [`/api/v1/profiles`](#get-apiv1profiles) | List preset profiles |
| POST | [`/api/v1/profiles/{name}/apply`](#post-apiv1profilesnameapply) | Apply a preset |

---

### GET `/healthz`

Liveness probe. Always returns `200` if the server is up.

**Response `200`**

```json
{ "status": "ok" }
```

---

### GET `/openapi.yaml`

Returns this API's OpenAPI 3.1 document (`application/yaml`). Also available at
`/openapi.yml`.

---

### GET `/api/v1/impairment`

Returns the current impairment profile, read from the `netlab` UCI config.

**Response `200`** — [`Profile`](#profile)

```json
{
  "enabled": true,
  "queueLimit": 1000,
  "upload":   { "rateMbit": 20, "delayMs": 50, "jitterMs": 10, "lossPct": 1 },
  "download": { "rateMbit": 20, "delayMs": 50, "jitterMs": 10, "lossPct": 1 }
}
```

**Example**

```sh
curl http://192.168.50.1:8080/api/v1/impairment
```

---

### PUT `/api/v1/impairment`

Replaces the **full** impairment profile and applies it. All fields are required
(see [`Profile`](#profile)).

**Request body** — [`Profile`](#profile) (required)

**Responses**

| Status | Body | Meaning |
| --- | --- | --- |
| `200` | [`Profile`](#profile) | Applied profile |
| `400` | [`Error`](#error) | Request body failed validation |
| `500` | [`Error`](#error) | A command on the router failed |

**Example**

```sh
curl -X PUT http://192.168.50.1:8080/api/v1/impairment \
  -H 'Content-Type: application/json' \
  -d '{
    "enabled": true,
    "queueLimit": 1000,
    "upload":   { "rateMbit": 20, "delayMs": 50, "jitterMs": 10, "lossPct": 1 },
    "download": { "rateMbit": 20, "delayMs": 50, "jitterMs": 10, "lossPct": 1 }
  }'
```

---

### PATCH `/api/v1/impairment`

Partially updates the profile and applies it. Any subset of fields may be
supplied; provided direction objects are merged field-by-field with the stored
configuration. At least one field is required.

**Request body** — [`ProfilePatch`](#profilepatch) (required, `minProperties: 1`)

**Responses**

| Status | Body | Meaning |
| --- | --- | --- |
| `200` | [`Profile`](#profile) | Applied profile |
| `400` | [`Error`](#error) | Empty or invalid body |
| `500` | [`Error`](#error) | A command on the router failed |

**Example** — change only the download loss:

```sh
curl -X PATCH http://192.168.50.1:8080/api/v1/impairment \
  -H 'Content-Type: application/json' \
  -d '{ "download": { "lossPct": 5 } }'
```

---

### DELETE `/api/v1/impairment`

Clears all impairment: sets `enabled` to `false`, commits, and tears down the
live qdiscs on both devices.

**Responses**

| Status | Body | Meaning |
| --- | --- | --- |
| `200` | [`Profile`](#profile) | Resulting (disabled) profile |
| `500` | [`Error`](#error) | A command on the router failed |

**Example**

```sh
curl -X DELETE http://192.168.50.1:8080/api/v1/impairment
```

---

### GET `/api/v1/status`

Returns live shaping status: the resolved Linux devices behind the logical WAN
and test interfaces, plus the current `tc` qdisc output and parsed counters per
direction.

**Response `200`** — [`Status`](#status)

```json
{
  "interfaces": {
    "wan":  { "logical": "wan", "device": "eth0" },
    "test": { "logical": "lan", "device": "br-lan" }
  },
  "upload": {
    "device": "eth0",
    "raw": "qdisc netem 8001: root refcnt 2 limit 1000 delay 50ms  10ms loss 1% rate 20Mbit\n Sent 12345 bytes 67 pkt (dropped 2, overlimits 0 requeues 0)",
    "stats": { "sentBytes": 12345, "sentPackets": 67, "dropped": 2, "overlimits": 0 }
  },
  "download": {
    "device": "br-lan",
    "raw": "...",
    "stats": { "sentBytes": 0, "sentPackets": 0, "dropped": 0, "overlimits": 0 }
  }
}
```

`upload` is the qdisc on WAN egress; `download` is the qdisc on the test bridge
egress. `device`, `raw`, and `stats` may be `null` if a device cannot be resolved
or has no qdisc.

**Example**

```sh
curl http://192.168.50.1:8080/api/v1/status
```

---

### GET `/api/v1/profiles`

Lists the built-in preset profiles.

**Response `200`**

```json
{ "profiles": [ /* array of Preset */ ] }
```

Each item is a [`Preset`](#preset). See [Presets](#presets) for the concrete
values.

**Example**

```sh
curl http://192.168.50.1:8080/api/v1/profiles
```

---

### POST `/api/v1/profiles/{name}/apply`

Applies a named preset profile and reapplies shaping.

**Path parameters**

| Name | In | Required | Allowed values |
| --- | --- | --- | --- |
| `name` | path | yes | `clean-constrained`, `good-lte`, `poor-lte`, `satellite-like`, `severe-failure` |

**Responses**

| Status | Body | Meaning |
| --- | --- | --- |
| `200` | `{ "applied": string, "profile": Profile }` | Preset applied |
| `404` | [`Error`](#error) | Unknown preset name |
| `500` | [`Error`](#error) | A command on the router failed |

**Response `200` example**

```json
{
  "applied": "poor-lte",
  "profile": {
    "enabled": true,
    "queueLimit": 1000,
    "upload":   { "rateMbit": 2, "delayMs": 100, "jitterMs": 30, "lossPct": 2 },
    "download": { "rateMbit": 8, "delayMs": 100, "jitterMs": 30, "lossPct": 2 }
  }
}
```

**Example**

```sh
curl -X POST http://192.168.50.1:8080/api/v1/profiles/poor-lte/apply
```

---

## Schemas

### Direction

Impairment for one direction. All fields required in [`Profile`](#profile).

| Field | Type | Constraints | Description |
| --- | --- | --- | --- |
| `rateMbit` | number | `>= 0` | Bandwidth cap in Mbit/s. `0` means unlimited. |
| `delayMs` | number | `>= 0` | One-way added delay in milliseconds. |
| `jitterMs` | number | `>= 0` | Delay variation in milliseconds. |
| `lossPct` | number | `0`–`100` | Random packet loss percentage. |

### DirectionPatch

Same fields as [`Direction`](#direction), but every field is optional. Only the
provided fields are updated.

### Profile

| Field | Type | Constraints | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | required | Whether impairment is applied at boot/reload. |
| `queueLimit` | integer | required, `>= 1` | netem queue length in packets. |
| `upload` | [`Direction`](#direction) | required | Upload (WAN egress) impairment. |
| `download` | [`Direction`](#direction) | required | Download (br-lan egress) impairment. |

### ProfilePatch

Partial [`Profile`](#profile). All fields optional but at least one must be
present (`minProperties: 1`). `upload`/`download` accept a
[`DirectionPatch`](#directionpatch).

### Preset

| Field | Type | Description |
| --- | --- | --- |
| `name` | string | Preset identifier used in the apply path. |
| `description` | string | Human-readable purpose. |
| `profile` | [`Profile`](#profile) | The full profile the preset applies. |

### Status

| Field | Type | Description |
| --- | --- | --- |
| `interfaces.wan` | [`InterfaceMap`](#interfacemap) | Logical WAN interface and resolved device. |
| `interfaces.test` | [`InterfaceMap`](#interfacemap) | Logical test interface and resolved device. |
| `upload` | [`QdiscStatus`](#qdiscstatus) | Qdisc on WAN egress. |
| `download` | [`QdiscStatus`](#qdiscstatus) | Qdisc on the test bridge egress. |

### InterfaceMap

| Field | Type | Description |
| --- | --- | --- |
| `logical` | string | OpenWrt logical interface name (e.g. `wan`, `lan`). |
| `device` | string \| null | Resolved Linux device (e.g. `eth0`, `br-lan`). |

### QdiscStatus

| Field | Type | Description |
| --- | --- | --- |
| `device` | string \| null | The device the qdisc is on. |
| `raw` | string \| null | Raw `tc -s qdisc show` output. |
| `stats` | object \| null | Parsed counters (below). |

`stats` fields (all integers): `sentBytes`, `sentPackets`, `dropped`,
`overlimits`.

### Error

Returned for all error responses.

| Field | Type | Description |
| --- | --- | --- |
| `error.code` | string | Machine-readable code (e.g. `validation_error`, `not_found`, `internal_error`). |
| `error.message` | string | Human-readable detail. |

```json
{ "error": { "code": "validation_error", "message": "\"download.lossPct\" must be <= 100" } }
```

## Error codes

| HTTP | `error.code` | When |
| --- | --- | --- |
| `400` | `validation_error` | Malformed JSON, unknown field, out-of-range value, or empty PATCH |
| `404` | `not_found` | Unknown route or unknown preset name |
| `405` | `method_not_allowed` | Unsupported method on `/api/v1/impairment` |
| `500` | `internal_error` | A `uci`/`tc`/`ubus` command on the router failed |

## Presets

Values from Section 9 of the setup guide. Delay, jitter, and loss are applied
equally to both directions; rate differs per direction.

| Name | Description | Up (Mbit/s) | Down (Mbit/s) | Delay (ms) | Jitter (ms) | Loss (%) |
| --- | --- | --- | --- | --- | --- | --- |
| `clean-constrained` | Bandwidth-only behavior | 10 | 50 | 10 | 2 | 0 |
| `good-lte` | Typical mobile path | 10 | 40 | 35 | 8 | 0.2 |
| `poor-lte` | Unstable field connection | 2 | 8 | 100 | 30 | 2 |
| `satellite-like` | High-latency application testing | 5 | 25 | 300 | 20 | 0.5 |
| `severe-failure` | Timeout and recovery logic (256/512 kbit) | 0.256 | 0.512 | 250 | 100 | 10 |

All presets set `enabled: true` and `queueLimit: 1000`.
