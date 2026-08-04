# OpenWrt Network Impairment Test Subnet

**A reproducible lab for latency, jitter, bandwidth limits, and packet loss**

Implementation target: a dedicated OpenWrt One with its 1 GbE LAN port as the primary impaired test network; Wi-Fi is optional

> **Note:** Recommended architecture: Use the OpenWrt One as a dedicated test router. The 2.5 GbE port is WAN; the 1 GbE port and any downstream unmanaged switch form the impaired Ethernet test network. Wi-Fi is an optional attachment to the same LAN, not the primary path.

## 1. Resulting Architecture

The finished router treats its existing LAN as the test network. Every client connected downstream of the OpenWrt One's 1 GbE port receives DHCP, reaches the internet through NAT, and experiences the configured latency, jitter, bandwidth limit, and packet loss. Connect one client directly or attach an unmanaged Ethernet switch to test multiple clients. A Wi-Fi SSID may optionally be attached to the same LAN/test network later.

| Component | Example | Purpose | Shaping direction |
| --- | --- | --- | --- |
| Upstream/WAN device | eth0, wan, or pppoe-wan | 2.5 GbE connection to internet/upstream LAN | Upload from test clients |
| Ethernet LAN/test bridge | br-lan containing eth1 | 1 GbE port and any downstream Ethernet switch; optional Wi-Fi SSID | Download toward test clients |
| Test subnet | 192.168.50.0/24 | DHCP and firewall scope for every downstream client | All connected test devices |
| Control utility | tc + netem | Applies delay, jitter, loss, and rate | Both interfaces independently |

> **Note:** Warning: A qdisc controls packets leaving an interface. WAN egress controls upload from all downstream test clients, while br-lan egress controls download toward them. Applying only one qdisc produces a one-sided test.

## 2. Assumptions and Naming

This guide uses the following names. Change them where necessary for the router:

- Upstream interface: wan (normally the 2.5 GbE/PoE port)
- Primary test logical interface: lan
- Primary test bridge device: br-lan, containing the 1 GbE port eth1
- Optional Wi-Fi SSID: NetLab, attached to lan
- Test subnet: 192.168.50.0/24
- Router address on the Ethernet test subnet: 192.168.50.1
- Initial DHCP pool: 192.168.50.100 through 192.168.50.249
> **Note:** Interface-name rule: The OpenWrt logical interface name such as wan is not always the Linux device that tc must use. PPPoE commonly creates pppoe-wan; DHCP/Ethernet WAN may use eth1, wan, or a VLAN device. The scripts below resolve the live Linux device with ubus.

## 3. Prerequisites and Safety

- OpenWrt with SSH access and enough free storage for tc-full and scheduler kernel modules. This guide assumes a current OpenWrt release that uses the apk package manager.
- A recovery or management path. Keep the USB-C serial console available while commissioning. Once shaping is enabled, management through the 1 GbE test port can itself be delayed or dropped; use conservative profiles or exempt management traffic when necessary.
- A router CPU capable of forwarding at the desired test rate. Software shaping disables some acceleration benefits and can become CPU-bound.
- A configuration backup before changing bridges, VLANs, firewall zones, or wireless settings.
> **Note:** Warning: The primary management path may share the impaired Ethernet test network. Keep the serial console available and avoid 100% loss or unusably low bandwidth until automatic rollback and recovery are proven.

### 3.1 Default SSH Login

On a standard, freshly installed OpenWrt image, the administrative SSH username is root. OpenWrt does not ship with a preset root password.

Connect from a computer attached to the OpenWrt LAN:

```sh
ssh root@192.168.1.1
```

At the password prompt, press Enter without typing a password. This blank-password login is intended only for initial setup and is normally available from the LAN side; the default firewall does not expose SSH administration through WAN.

Immediately set a strong password:

```sh
passwd
```

After setting it, future SSH and LuCI logins use username root and the password you created. There is no separate default password to recover. If the device came with a vendor-modified or preconfigured image, its credentials may differ; consult the supplied documentation or reset/reflash it rather than guessing.

Security note: do not create a WAN port-forward to the router's own SSH service for this test setup. Keep router administration restricted to a trusted management network.

## 4. Install Required Packages

SSH into the router and update the package index:

OpenWrt 25.12 and newer use apk rather than opkg. Do not mix commands or feed configuration from the two package managers. If apk cannot find compatible scheduler modules, verify that the installed firmware and repositories belong to the same release and build.

```sh
apk update
apk add tc-full kmod-sched-core kmod-sched
```

Depending on the OpenWrt release and target, netem may be included in kmod-sched or exposed as a separate package. Check and install it when available:

```sh
apk info | grep -E 'tc-full|kmod-sched|netem'
apk search 'kmod-*netem*'
# Install the exact package name shown by the previous command, if present:
apk add kmod-netem
```

Verify that tc and netem work:

```sh
tc -V
tc qdisc add dev lo root netem delay 1ms
tc qdisc del dev lo root
```

> **Note:** Firmware-package matching: OpenWrt kernel modules must match the exact running kernel build. If apk reports an incompatible kernel dependency or architecture, upgrade to a consistent official firmware build with matching repositories. Do not force-install a mismatched scheduler module.

## 5. Configure the 1 GbE Ethernet Test Network

### What is UCI?

UCI stands for Unified Configuration Interface. It is OpenWrt's standard command-line system for reading and changing configuration. Instead of directly editing files such as /etc/config/network or /etc/config/firewall, you use uci commands that modify those files in a structured, repeatable way.

Most UCI commands in this guide follow this structure:

```sh
uci set <config>.<section>.<option>='<value>'
uci commit <config>
/etc/init.d/<service> restart
```

For example, uci set network.lan.ipaddr='192.168.50.1' means: change the ipaddr option in the lan section of /etc/config/network. The command stages the change. uci commit network writes the staged network changes to disk, and restarting the network service applies them.

Common commands used in this document:

```sh
uci show network                 # Display the current network configuration
uci get network.lan.ipaddr        # Read one option
uci set network.lan.ipaddr='192.168.50.1'  # Stage a change
uci changes                       # Show staged, uncommitted changes
uci revert network                # Discard staged network changes
uci commit network                # Save staged network changes to disk
```

Important: UCI changes are not automatically safe. A bad network or firewall setting can disconnect your SSH session. Keep the serial console available, review changes with uci changes before committing, and make network changes in small batches.

> **Note:** Isolation option: The default LAN input policy is ACCEPT for straightforward commissioning. After setup is proven, restrict router-management services explicitly if untrusted devices will be connected downstream.

### 5.1 Make the 1 GbE LAN the test network

The OpenWrt One already places eth1, the 1 GbE port, inside br-lan. Keep that physical mapping and configure the existing lan interface as the routed test subnet. This is the main topology in this guide. Every device connected directly to the 1 GbE port, or through an unmanaged Ethernet switch attached to that port, becomes a test client.

Verify the port membership before changing addresses:

```sh
uci show network | grep -E "br-lan|ports|network.lan"
ip link show eth1
ip link show br-lan
```

Configure the LAN/test subnet:

```sh
uci set network.lan.proto='static'
uci set network.lan.ipaddr='192.168.50.1'
uci set network.lan.netmask='255.255.255.0'
uci commit network
/etc/init.d/network restart
```

Changing the LAN address disconnects any SSH session using the previous address. Reconnect at 192.168.50.1, or use the serial console.

### 5.2 Configure DHCP and DNS for Ethernet clients

```sh
uci set dhcp.lan.interface='lan'
uci set dhcp.lan.start='100'
uci set dhcp.lan.limit='150'
uci set dhcp.lan.leasetime='12h'
uci set dhcp.lan.dhcpv4='server'
uci set dhcp.lan.ignore='0'
uci commit dhcp
/etc/init.d/dnsmasq restart
```

Clients downstream of the 1 GbE port should now receive addresses from 192.168.50.100 through 192.168.50.249, with gateway and DNS server 192.168.50.1.

### 5.3 Use the existing LAN firewall zone

The default OpenWrt firewall already places the lan interface in the lan zone, permits input from LAN clients, and forwards LAN traffic to WAN with NAT. Verify those defaults instead of creating a second test zone:

```sh
uci show firewall | grep -E "name='lan'|network='lan'|src='lan'|dest='wan'|masq='1'"
uci show firewall.@forwarding[0]
```

For a dedicated test router, the existing lan-to-wan policy is appropriate. Do not connect production clients to the 1 GbE port or to a switch downstream of it, because all such clients will be impaired together.

### 5.4 Verify the Ethernet-first topology

```sh
# On OpenWrt
ip -br addr show br-lan
ubus call network.interface.lan status
cat /tmp/dhcp.leases

# On a downstream client
ip addr
ip route
ping 192.168.50.1
ping 1.1.1.1
nslookup openwrt.org
```

Do not proceed until an Ethernet client receives a 192.168.50.x address and reaches the internet without shaping.

### 5.5 Optional: attach a Wi-Fi SSID to the same test network

Wi-Fi is optional. Add it only after Ethernet testing works. Attaching the SSID to lan means wireless and wired clients share the same DHCP scope, firewall policy, and impairment profile. Wi-Fi introduces its own retries, contention, and rate adaptation, so Ethernet remains the preferred baseline.

```sh
uci show wireless

uci set wireless.netlab='wifi-iface'
uci set wireless.netlab.device='radio0'
uci set wireless.netlab.mode='ap'
uci set wireless.netlab.network='lan'
uci set wireless.netlab.ssid='NetLab'
uci set wireless.netlab.encryption='sae-mixed'
uci set wireless.netlab.key='CHANGE-THIS-TEST-PASSWORD'
uci commit wireless
wifi reload
```

LuCI equivalent: Network > Wireless > Add, select Access Point, set SSID NetLab, and assign it to the existing lan network.

## 6. Verify the Unimpaired Ethernet Network First

```sh
# On the router
ubus call network.interface.lan status
ubus call network.interface.wan status
ip addr show br-lan
logread -e dnsmasq

# On a test client
ip addr                 # Linux
ipconfig /all           # Windows
ping 192.168.50.1
ping 1.1.1.1
nslookup openwrt.org
```

Do not proceed until the test client has a 192.168.50.x address, can resolve DNS, and reaches the internet without shaping.

## 7. Apply Impairment Manually

### 7.1 Resolve the live devices

```sh
WAN_DEV="$(ubus call network.interface.wan status | jsonfilter -e '@.l3_device')"
TEST_DEV="$(ubus call network.interface.lan status | jsonfilter -e '@.l3_device')"
echo "WAN_DEV=$WAN_DEV TEST_DEV=$TEST_DEV"
```

Expected output resembles WAN_DEV=eth0 TEST_DEV=br-lan or WAN_DEV=pppoe-wan TEST_DEV=br-lan.

### 7.2 Example: symmetric impaired link

This example creates a nominal 20 Mbit/s connection in each direction, adds 50 ms one-way delay per direction, 10 ms jitter, and 1% random packet loss per direction:

```sh
tc qdisc replace dev "$WAN_DEV" root netem \
  delay 50ms 10ms \
  loss random 1% \
  rate 20mbit limit 1000

tc qdisc replace dev "$TEST_DEV" root netem \
  delay 50ms 10ms \
  loss random 1% \
  rate 20mbit limit 1000
```

> **Note:** Warning: Delay is one-way per shaped interface. With 50 ms on WAN egress and 50 ms on br-lan egress, the added round-trip delay is approximately 100 ms, before normal internet latency and queuing.

### 7.3 Asymmetric example

This models 5 Mbit/s upload, 30 Mbit/s download, 80 ms uplink delay, 20 ms downlink delay, heavier uplink jitter, and different loss rates:

```sh
tc qdisc replace dev "$WAN_DEV" root netem \
  delay 80ms 25ms \
  loss random 2% \
  rate 5mbit limit 1000

tc qdisc replace dev "$TEST_DEV" root netem \
  delay 20ms 5ms \
  loss random 0.2% \
  rate 30mbit limit 1000
```

### 7.4 Remove all impairment

```sh
tc qdisc del dev "$WAN_DEV" root 2>/dev/null || true
tc qdisc del dev "$TEST_DEV" root 2>/dev/null || true
```

## 8. Make the Configuration Persistent and Easy to Change

Create one UCI configuration file and one init script. The init script re-resolves interface device names whenever it runs, which is important for PPPoE, VLANs, and reconnects.

### 8.1 Create /etc/config/netlab

```sh
cat > /etc/config/netlab <<'EOF'
config netlab 'main'
        option enabled '1'
        option wan_interface 'wan'
        option test_interface 'lan'

        # Upload: test clients -> WAN
        option upload_rate '20mbit'
        option upload_delay '50ms'
        option upload_jitter '10ms'
        option upload_loss '1%'

        # Download: WAN -> test clients
        option download_rate '20mbit'
        option download_delay '50ms'
        option download_jitter '10ms'
        option download_loss '1%'

        option queue_limit '1000'
EOF
```

### 8.2 Create /etc/init.d/netlab

```sh
cat > /etc/init.d/netlab <<'EOF'
#!/bin/sh /etc/rc.common

START=99
STOP=10
USE_PROCD=1

resolve_device() {
        local iface="$1"
        ubus call "network.interface.${iface}" status 2>/dev/null                 | jsonfilter -e '@.l3_device'
}

remove_qdisc() {
        local dev="$1"
        [ -n "$dev" ] && tc qdisc del dev "$dev" root 2>/dev/null
        return 0
}

apply_netem() {
        local dev="$1" rate="$2" delay="$3" jitter="$4" loss="$5"
        local qlimit="$6"

        [ -n "$dev" ] || return 1

        # Build the command safely from known UCI values.
        set -- tc qdisc replace dev "$dev" root netem

        if [ -n "$delay" ] && [ "$delay" != "0ms" ]; then
                set -- "$@" delay "$delay"
                if [ -n "$jitter" ] && [ "$jitter" != "0ms" ]; then
                        set -- "$@" "$jitter"
                fi
        fi

        [ -n "$loss" ] && [ "$loss" != "0%" ] &&                 set -- "$@" loss random "$loss"
        [ -n "$rate" ] && [ "$rate" != "0" ] &&                 set -- "$@" rate "$rate"
        [ -n "$qlimit" ] && set -- "$@" limit "$qlimit"

        logger -t netlab "Applying impairment to $dev: $*"
        "$@"
}

start_service() {
        config_load netlab

        local enabled wan_if test_if
        local up_rate up_delay up_jitter up_loss
        local down_rate down_delay down_jitter down_loss
        local qlimit wan_dev test_dev

        config_get_bool enabled main enabled 0
        [ "$enabled" -eq 1 ] || return 0

        config_get wan_if main wan_interface wan
        config_get test_if main test_interface lan
        config_get up_rate main upload_rate 0
        config_get up_delay main upload_delay 0ms
        config_get up_jitter main upload_jitter 0ms
        config_get up_loss main upload_loss 0%
        config_get down_rate main download_rate 0
        config_get down_delay main download_delay 0ms
        config_get down_jitter main download_jitter 0ms
        config_get down_loss main download_loss 0%
        config_get qlimit main queue_limit 1000

        wan_dev="$(resolve_device "$wan_if")"
        test_dev="$(resolve_device "$test_if")"

        [ -n "$wan_dev" ] || {
                logger -t netlab "Could not resolve WAN device for $wan_if"
                return 1
        }
        [ -n "$test_dev" ] || {
                logger -t netlab "Could not resolve test device for $test_if"
                return 1
        }

        remove_qdisc "$wan_dev"
        remove_qdisc "$test_dev"

        apply_netem "$wan_dev" "$up_rate" "$up_delay"                 "$up_jitter" "$up_loss" "$qlimit"
        apply_netem "$test_dev" "$down_rate" "$down_delay"                 "$down_jitter" "$down_loss" "$qlimit"
}

stop_service() {
        config_load netlab
        local wan_if test_if wan_dev test_dev
        config_get wan_if main wan_interface wan
        config_get test_if main test_interface lan
        wan_dev="$(resolve_device "$wan_if")"
        test_dev="$(resolve_device "$test_if")"
        remove_qdisc "$wan_dev"
        remove_qdisc "$test_dev"
}

reload_service() {
        stop_service
        start_service
}
EOF

chmod +x /etc/init.d/netlab
/etc/init.d/netlab enable
/etc/init.d/netlab restart
```

> **Note:** Reconnect behavior: A WAN reconnect can recreate the underlying device and discard its qdisc. The base script applies at boot and whenever manually restarted. Section 8.4 adds a hotplug hook so it automatically reapplies after interface-up events.

### 8.3 Change profiles with UCI

```sh
/etc/init.d/netlab stop
/etc/init.d/netlab disable
rm -f /etc/init.d/netlab /etc/hotplug.d/iface/95-netlab /etc/config/netlab

# Remove only the optional SSID created by this guide.
uci -q delete wireless.netlab

# Restore the conventional OpenWrt LAN address if desired.
uci set network.lan.proto='static'
uci set network.lan.ipaddr='192.168.1.1'
uci set network.lan.netmask='255.255.255.0'
uci set dhcp.lan.ignore='0'

uci commit wireless
uci commit network
uci commit dhcp

wifi reload
/etc/init.d/network restart
/etc/init.d/dnsmasq restart
```

### 8.4 Reapply after network reconnects

```sh
cat > /etc/hotplug.d/iface/95-netlab <<'EOF'
#!/bin/sh

case "$ACTION" in
        ifup|ifupdate)
                # Avoid blocking netifd while an interface settles.
                ( sleep 2; /etc/init.d/netlab restart ) &
                ;;
esac
EOF
chmod +x /etc/hotplug.d/iface/95-netlab
```

## 9. Useful Test Profiles

| Profile | Up | Down | Delay each way | Jitter | Loss each way | Use |
| --- | --- | --- | --- | --- | --- | --- |
| Clean constrained | 10 Mbit/s | 50 Mbit/s | 10 ms | 2 ms | 0% | Bandwidth-only behavior |
| Good LTE | 10 Mbit/s | 40 Mbit/s | 35 ms | 8 ms | 0.2% | Typical mobile path |
| Poor LTE | 2 Mbit/s | 8 Mbit/s | 100 ms | 30 ms | 2% | Unstable field connection |
| Satellite-like | 5 Mbit/s | 25 Mbit/s | 300 ms | 20 ms | 0.5% | High-latency application testing |
| Severe failure | 256 Kbit/s | 512 Kbit/s | 250 ms | 100 ms | 10% | Timeout and recovery logic |

These are engineering starting points, not claims about a specific carrier or technology. Record the exact profile used with every test result.

## 10. Inspect and Validate the Active Shaping

### 10.1 Inspect qdiscs and counters

```sh
WAN_DEV="$(ubus call network.interface.wan status | jsonfilter -e '@.l3_device')"
TEST_DEV="$(ubus call network.interface.lan status | jsonfilter -e '@.l3_device')"

tc -s qdisc show dev "$WAN_DEV"
tc -s qdisc show dev "$TEST_DEV"
logread -e netlab
```

The tc counters should increase while a test device sends traffic. Dropped packets should increase when loss is enabled or when queues overflow.

### 10.2 Measure latency and jitter

```sh
# From a test client
ping -c 50 1.1.1.1          # Linux/macOS
ping -n 50 1.1.1.1          # Windows
```

Compare the mean and standard deviation before and after shaping. The measured RTT includes both configured one-way delays plus the real upstream path.

### 10.3 Measure bandwidth with iperf3

The cleanest test uses an iperf3 server outside the OpenWrt test subnet. Public servers are inconsistent, so a VPS, another site, or a host on the WAN side is better.

```sh
# Download toward the test client (server sends to client)
iperf3 -c SERVER_ADDRESS -R -t 30

# Upload from the test client
iperf3 -c SERVER_ADDRESS -t 30

# UDP loss and jitter visibility
iperf3 -c SERVER_ADDRESS -u -b 5M -t 30
```

### 10.4 Observe application behavior

- DNS lookup time and failures
- TCP connect and TLS handshake time
- WebSocket reconnect behavior
- Video/audio buffering
- API timeout and retry logic
- Robot command/telemetry staleness and fail-safe behavior
## 11. Critical Pitfalls

Hardware/software flow offloading: Disable flow offloading during testing. Accelerated forwarding can bypass or distort software qdisc behavior on some hardware. In LuCI: Network > Firewall > General Settings, clear Software flow offloading and Hardware flow offloading.

SQM/QoS conflicts: Do not run SQM, qosify, or another root qdisc on the same WAN/test devices at the same time. Only one root qdisc can own an interface. Stop or disable the competing service.

Wi-Fi variability: Wi-Fi adds its own rate adaptation, retries, contention, and latency. For repeatable impairment measurements, use Ethernet. Use Wi-Fi only when radio behavior is intentionally part of the test.

Router CPU ceiling: At high rates or heavy loss/jitter, the router may saturate CPU. Check top and /proc/softirqs. A CPU-bound router is not a controlled network model.

Queue limit: A large queue can create extra queuing delay under load. A tiny queue can create additional drops. The example limit of 1000 packets is a starting point; verify tc -s counters and application behavior.

Loss is per direction: 1% upload loss plus 1% download loss is not simply a single 1% end-to-end condition. Request/response protocols encounter loss opportunities in both directions.

Control-plane traffic: A root qdisc on WAN also shapes traffic generated by the router itself. On a dedicated lab router this is usually acceptable; on a shared router use classification and filters instead.

IPv6: The qdiscs are interface-based and affect IPv4 and IPv6. Confirm the firewall and DHCPv6/RA design matches the intended test. Disable IPv6 on the test interface if the application must be tested strictly over IPv4.

## 12. When the Router Is Not Dedicated

The simple WAN root qdisc shapes every packet leaving WAN. On the dedicated Ethernet-first test router described here, that is intentional because every client downstream of the 1 GbE port is a test client. If the router must remain shared, do not use the simple WAN root netem design.

- Place the test subnet behind a second dedicated OpenWrt router. This is the cleanest and most reproducible option.
- Use an IFB device plus tc filters to redirect only packets belonging to 192.168.50.0/24, then apply netem to the IFB. This is more complex and sensitive to NAT/filter hook placement.
- Use network namespaces or a Linux bridge appliance with two physical interfaces inserted transparently between the device-under-test and the rest of the network.
> **Note:** Recommendation: Keep this router dedicated to testing. Every client connected downstream of the 1 GbE port is intentionally subject to the same impairment profile; do not attach ordinary production devices.

## 13. Rollback

```sh
/etc/init.d/netlab stop
/etc/init.d/netlab disable
rm -f /etc/init.d/netlab /etc/hotplug.d/iface/95-netlab /etc/config/netlab

# Remove only the optional SSID created by this guide.
uci -q delete wireless.netlab

# Restore the conventional OpenWrt LAN address if desired.
uci set network.lan.proto='static'
uci set network.lan.ipaddr='192.168.1.1'
uci set network.lan.netmask='255.255.255.0'
uci set dhcp.lan.ignore='0'

uci commit wireless
uci commit network
uci commit dhcp

wifi reload
/etc/init.d/network restart
/etc/init.d/dnsmasq restart
```

> **Note:** Rollback note: This Ethernet-first design does not move eth1 out of br-lan. Rollback mainly removes the qdiscs, optional SSID, automation files, and restores the preferred LAN address.

## 14. Commissioning Checklist

- ☐ Configuration backup completed.
- ☐ Serial console or another recovery path remains available before impairment is enabled.
- ☐ tc-full and scheduler/netem support installed and verified.
- ☐ br-lan and the LAN/test interface is up at 192.168.50.1/24.
- ☐ Test client receives DHCP and reaches DNS/internet without shaping.
- ☐ Flow offloading and conflicting SQM/QoS services are disabled.
- ☐ WAN_DEV and TEST_DEV resolve to the expected Linux devices.
- ☐ tc -s qdisc counters increase during test traffic.
- ☐ Ping confirms expected added RTT and variability.
- ☐ iperf3 confirms independent upload and download limits.
- ☐ Reboot and WAN reconnect both reapply the selected profile.
- ☐ Rollback procedure has been tested or documented for the specific router.
## 15. Technical References

- OpenWrt: Netem (Network Emulator): https://openwrt.org/docs/guide-user/network/traffic-shaping/sch_netem
- OpenWrt: Traffic shaping overview: https://openwrt.org/docs/guide-user/network/traffic-shaping/start
- OpenWrt: Network configuration /etc/config/network: https://openwrt.org/docs/guide-user/network/network_configuration
- OpenWrt: tc-full package information: https://openwrt.org/packages/pkgdata/tc-full
- Linux tc-netem manual: https://man7.org/linux/man-pages/man8/tc-netem.8.html
- Linux tc manual: https://man7.org/linux/man-pages/man8/tc.8.html
- Linux tc-tbf manual: https://man7.org/linux/man-pages/man8/tc-tbf.8.html
- OpenWrt: Initial root password and first login: https://openwrt.org/faq/initial_root_password
- OpenWrt: Login walkthrough: https://openwrt.org/docs/guide-quick-start/walkthrough_login
Document notes: OpenWrt package names and UI labels can vary by release and target. Commands were written to use standard UCI, ubus, jsonfilter, procd/init, and iproute2 tc behavior. Confirm package availability against the repositories matching the router firmware.
