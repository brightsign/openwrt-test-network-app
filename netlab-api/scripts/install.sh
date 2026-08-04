#!/bin/sh
#
# On-router installer for the netlab REST API.
#
# Run this ON the OpenWrt router, from the copied netlab-api/ directory:
#     sh scripts/install.sh
#
# It will:
#   1. Add the nxhack prebuilt Node.js feed and install `node` (OpenWrt 25.12+
#      has no official target node package).
#   2. Install the application into /usr/lib/netlab-api.
#   3. Install the netlab impairment config + init script + hotplug hook and the
#      netlab-api service, and enable both services.
#   4. Open the API TCP port on the WAN firewall zone.

set -e

API_PORT="${NETLAB_API_PORT:-8080}"
APP_DIR="/usr/lib/netlab-api"
NODE_FEED_KEY_URL="https://downloads.nxhack.com/nodejs.pem"

# Resolve the directory this script lives in, then its parent (package root).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

log() { echo "[install] $*"; }

# ---------------------------------------------------------------------------
# 1. Node.js
# ---------------------------------------------------------------------------
install_node() {
	if command -v node >/dev/null 2>&1; then
		log "node already installed: $(node --version)"
		return 0
	fi

	log "node not found; configuring nxhack prebuilt feed"

	# Determine the OpenWrt release and target arch to build the feed URL.
	# shellcheck disable=SC1091
	. /etc/openwrt_release 2>/dev/null || true
	local version arch
	version="${DISTRIB_RELEASE:-}"

	# The nxhack feed (like OpenWrt's own feeds) is keyed on the full package
	# arch, e.g. "aarch64_cortex-a53" -- NOT the bare "aarch64" that
	# `apk --print-arch` reports. Prefer DISTRIB_ARCH from openwrt_release, then
	# fall back to parsing an existing distfeed URL.
	arch="${DISTRIB_ARCH:-}"
	if [ -z "$arch" ]; then
		arch="$(sed -n 's#.*/packages/\([a-z0-9_-]*\)/base/.*#\1#p' \
			/etc/apk/repositories.d/distfeeds.list 2>/dev/null | head -n1)"
	fi

	if [ -z "$arch" ]; then
		log "ERROR: could not determine the OpenWrt package arch"
		log "Set the feed manually per https://github.com/nxhack/openwrt-node-packages"
		log "then re-run this script."
		return 1
	fi
	if [ -z "$version" ] || [ "$version" = "SNAPSHOT" ]; then
		log "WARNING: could not determine a numeric release from /etc/openwrt_release."
		log "Set the feed manually per https://github.com/nxhack/openwrt-node-packages"
		log "then re-run. Detected arch: $arch"
		return 1
	fi

	log "release=$version arch=$arch"

	wget -q "$NODE_FEED_KEY_URL" -O /etc/apk/keys/nodejs.pem

	mkdir -p /etc/apk/repositories.d
	local feed feeds_file
	feed="https://downloads.nxhack.com/releases/${version}/packages/${arch}/node/packages.adb"
	feeds_file=/etc/apk/repositories.d/customfeeds.list
	# Drop any previously-added nxhack node feed lines (e.g. a wrong arch from an
	# earlier run) so only the correct one remains.
	if [ -f "$feeds_file" ]; then
		grep -v 'downloads\.nxhack\.com/.*/node/' "$feeds_file" > "$feeds_file.tmp" 2>/dev/null \
			&& mv "$feeds_file.tmp" "$feeds_file"
	fi
	echo "$feed" >> "$feeds_file"

	# The nxhack prebuilt index is not signed with a key in apk's trust store,
	# so apk reports "UNTRUSTED signature" and marks the feed unavailable. This
	# is expected for this third-party feed; the maintainer's documented
	# workaround is --allow-untrusted. It disables signature verification for
	# these operations only (you are explicitly trusting downloads.nxhack.com).
	log "installing node from nxhack feed (--allow-untrusted, per maintainer docs)"
	apk update --allow-untrusted
	apk add --allow-untrusted node

	log "installed node: $(node --version)"
}

# ---------------------------------------------------------------------------
# 2. Application files
# ---------------------------------------------------------------------------
install_app() {
	log "installing application to $APP_DIR"
	mkdir -p "$APP_DIR"
	cp "$PKG_ROOT/server.js" "$APP_DIR/"
	cp "$PKG_ROOT/openapi.yaml" "$APP_DIR/"
	rm -rf "$APP_DIR/lib"
	cp -r "$PKG_ROOT/lib" "$APP_DIR/lib"
}

# ---------------------------------------------------------------------------
# 3. System files + services
# ---------------------------------------------------------------------------
install_system_files() {
	log "installing config, init scripts, and hotplug hook"

	# Do not clobber an existing netlab config the operator may have tuned.
	if [ ! -f /etc/config/netlab ]; then
		cp "$PKG_ROOT/files/etc/config/netlab" /etc/config/netlab
	else
		log "keeping existing /etc/config/netlab"
	fi

	cp "$PKG_ROOT/files/etc/init.d/netlab" /etc/init.d/netlab
	cp "$PKG_ROOT/files/etc/init.d/netlab-api" /etc/init.d/netlab-api
	mkdir -p /etc/hotplug.d/iface
	cp "$PKG_ROOT/files/etc/hotplug.d/iface/95-netlab" /etc/hotplug.d/iface/95-netlab

	chmod +x /etc/init.d/netlab /etc/init.d/netlab-api /etc/hotplug.d/iface/95-netlab

	/etc/init.d/netlab enable
	/etc/init.d/netlab-api enable
}

# ---------------------------------------------------------------------------
# 4. Firewall
# ---------------------------------------------------------------------------
open_firewall() {
	if uci -q show firewall | grep -q "name='Allow-netlab-api'"; then
		log "firewall rule Allow-netlab-api already present"
		return 0
	fi
	log "opening WAN TCP port $API_PORT for the API"
	uci add firewall rule >/dev/null
	uci set firewall.@rule[-1].name='Allow-netlab-api'
	uci set firewall.@rule[-1].src='wan'
	uci set firewall.@rule[-1].proto='tcp'
	uci set firewall.@rule[-1].dest_port="$API_PORT"
	uci set firewall.@rule[-1].target='ACCEPT'
	uci commit firewall
	/etc/init.d/firewall reload
}

# ---------------------------------------------------------------------------

install_node
install_app
install_system_files
open_firewall

log "starting services"
# On a first install the services are not running yet, so `restart` would print
# a harmless "Command failed: Not found" from procd's stop phase. Stop quietly
# first (ignoring that), then start.
/etc/init.d/netlab stop >/dev/null 2>&1 || true
/etc/init.d/netlab start || log "WARNING: netlab start failed (check logread -e netlab)"
/etc/init.d/netlab-api stop >/dev/null 2>&1 || true
/etc/init.d/netlab-api start || log "WARNING: netlab-api start failed (check logread -e netlab-api)"

# Confirm the API actually came up.
sleep 1
if pgrep -f "$APP_DIR/server.js" >/dev/null 2>&1; then
	log "netlab-api is running (node $APP_DIR/server.js)"
else
	log "WARNING: netlab-api does not appear to be running; check: logread -e netlab-api"
fi

log "done. Verify with: curl http://<router-wan-ip>:${API_PORT}/healthz"
