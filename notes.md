# Open WRT Setup Notes

## Test interface:

- name: enx9c69d3007be9
- goal: Isolate test interface behind network namespace

### Steps:

1. Find test interface

```ip -br link```

2. Set the interface as an environment variable

```export TEST_IF={interface}```

3. Stop NetworkManager from configuring/interfering with the test interface

```
sudo nmcli device disconnect "$TEST_IF" 2>/dev/null || true
sudo nmcli device set "$TEST_IF" managed no
```

The interface should show 'unmanaged' or 'disconnected':

```nmcli device status```

4. Create the test namespace

```sudo ip netns add openwrt-test```

Verify: ```ip netns list```

5. Move the test interface to the namespace

```
sudo ip link set "$TEST_IF" down
sudo ip link set "$TEST_IF" netns openwrt-test
```

Verify that the interface has moved from the normal interface list to the namespace list:

```
ip -br link #interface should not appear
sudo ip netns exec openwrt-test ip -br link #interface should appear
```

6. Bring up the test interface in the namespace

```
sudo ip netns exec openwrt-test ip link set "$TEST_IF" up
```

Note: To execute a command for an interface within a namespace, use `ip netns exec {iface-name} {command}`

6. Request an IP Address from the OpenWRT DHCP server

```
sudo ip netns exec openwrt-test dhclient -v "$TEST_IF"
```

Test:

```
sudo ip netns exec openwrt-test ip -br address
```

7. SSH into OpenWRT router 

```
sudo ip netns exec openwrt-test ssh root@192.168.1.1
```