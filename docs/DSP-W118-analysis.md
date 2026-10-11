# DSP-W118 — Analysis: why it cannot be controlled by this library

Status: **not supportable** (as of 2026-10-10). Kept here so the question does not get re-opened from scratch.

## Short version

The DSP-W118 relay cannot be switched over the local WebSocket (port 8080) in **any**
device state. The local server only ever accepts a fixed set of 7 setup commands, and its
`set_setting` handler only knows WiFi and time — never the relay. Relay control exists
*exclusively* in the device's **outbound** connection to the mydlink cloud. Impersonating
that cloud locally is blocked by TLS certificate pinning to a GlobalSign root under which
new certificates can no longer be issued.

This is a deliberate firmware design difference from the DSP-W115 / DSP-W245, which *do*
accept full control on their local 8080 server and are therefore supported.

## How the W118 differs from W115 / W245

| | W115 / W245 | W118 |
|---|---|---|
| CPU / OS | MIPS Linux (`da_adaptor`) | Realtek Ameba RTOS (ARM Cortex-M, Thumb) |
| Firmware obfuscation | — | XOR 0xAB (reversible, **not** encrypted) |
| Local 8080 server | accepts full control incl. relay | setup commands only |
| Relay control | local `set_setting` type 16 | cloud path only |
| Support by this library | yes (connects in with PIN) | no |

## Local 8080 WebSocket — what the firmware actually does

Decompiled firmware (Ghidra, de-obfuscated `w118_xor_ab.bin`):

- `ws_server_rx_process` (`FUN_0806bd12`) always dispatches through one fixed 7-command
  table (`FUN_0806bc54`, hardcoded loop of 7). **No branch on registration state.**
- Command table (`0x1000668c`): `sign_in, register, wlan_survey, keep_alive, set_setting,
  test_token, fw_upgrade`. No `get_status` / `set_status`.
- `set_setting` handler (`FUN_0806b918`) only handles type `0x120` (WiFi) and `0x110`
  (time). Type 16 (relay) is not handled.

Verified empirically with a raw TLS WebSocket client against the freshly-reset, open
device (8080 open, `reg_st=0`, PIN login works):

- `set_setting` type 272 (`0x110`, time) → answered `code 0`.
- `set_setting` type 16 (relay) → silently dropped.
- `get_setting` → silently dropped.

There is no second local control server: in the open/setup state only 8080 is open
(80 / 8081 / 443 closed). Port 80 carries an HTTP factory server (device-info `GET /` and a
factory endpoint `GET /entry/<secret>`), but only while in setup/factory state, and it does
not expose relay control either.

## Cloud path — the only place the relay lives

- `register` (`FUN_0806b752`) reads `owner_id`, `dcd_url`, `owner_token` and sets the bound
  flag. We *can* point `dcd_url` at our own server with it.
- `ws_client_connect` (`FUN_0805e9ae`) then connects **out** to that `dcd_url` over `wss`.
- TLS setup (`FUN_08070d6e` → `FUN_08064ffa(p, 2)` = verify REQUIRED, `FUN_08065006`): the
  server certificate is verified against a single CA baked into the firmware at `0x0806c088`,
  and the device presents its own mydlink Device CA client certificate (mutual TLS).

Pinned CA (extracted):

```
subject = C=BE, O=GlobalSign nv-sa, OU=Root CA, CN=GlobalSign Root CA
issuer  = (self-signed, = subject)
valid   = 1998-09-01 .. 2028-01-28
sha1    = B1:BC:96:8B:D4:F4:9D:62:2A:A8:9A:81:F2:15:01:52:A4:1D:82:9C
```

This is **GlobalSign Root CA R1** (the original 1998 SHA1 root).

Empirically: after `register`, the device made ~957 outbound TLS connection attempts to our
local fake cloud server and every handshake failed — our self-signed / Let's Encrypt
certificate does not chain to this root. Let's Encrypt (ISRG Root X1) is not trusted by the
device.

## Why a "real" GlobalSign certificate does not rescue this

The root is still valid until 2028-01-28, so the device would still trust it. But GlobalSign
removed Root R1 from browser trust on 2025-04-15 and **disabled issuance under R1**. Any
certificate bought today (incl. cheap AlphaSSL resold ~12–40 USD/yr) chains to R3 / R6 /
newer roots, not to the R1 root the device pins. So no purchasable certificate can satisfy
the device's chain check. The cost/process of buying a cert is irrelevant — the chain target
is no longer obtainable.

Even if the TLS handshake could be solved, the mydlink cloud (`da_dcd`) application protocol
would still have to be reverse-engineered and reimplemented for the device to accept us and
expose the relay. The certificate is necessary but not sufficient.

## State / recovery notes

- `register` puts the device into the bound state and **closes 8080**. Without a reachable,
  cert-valid cloud it does not recover on its own — only a button reset returns it to the
  open setup state. Do **not** run `register` unless a working cloud is in place.
- The device does **not** self-unbind when the cloud is unreachable. The "unbind" path only
  triggers on a *successful* connection whose `sign_in` is then rejected.
- Button reset → open setup state (8080 open, `reg_st=0`, PIN login works).
- Brute-force lock: 10 invalid device tokens within 10 min → code 34 "invalid access right",
  10-minute lock (seen on W115/W245 as `0x22` in `da_svr_recv_pkt`). Clients should back
  off before hitting this (see "Errors" in the README of this library).

## Remaining options

1. **Open firmware via UART** (OpenBeken / LibreTiny on the Realtek Ameba): fully local,
   no certificate problem. Requires soldering. Only robust path.
2. **Buy a GlobalSign-chained cert**: dead — issuance under R1 disabled (see above).

With option 2 being dead and option 1 requiring hardware work, the plug is effectively unsupportable
without opening it.
