# FreeOCD WebDebugger

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/FreeOCD/freeocd-web)
[![CI](https://github.com/FreeOCD/freeocd-web/actions/workflows/ci.yml/badge.svg)](https://github.com/FreeOCD/freeocd-web/actions/workflows/ci.yml)

A browser-based open-source debugger for ARM microcontrollers. Flash firmware, recover locked devices, and verify flash contents — all from your browser using WebUSB and CMSIS-DAP.

## Design Philosophy

A debugger is a tool that developers place their trust in during the most critical moments of development. We hold ourselves to that standard:

- **Reliability** — Every flash and recover operation must complete correctly, or fail explicitly with clear guidance
- **Stability** — Robust error recovery, bounded timeouts, and concurrency guards ensure the tool never hangs or leaves a device in an unknown state
- **Security** — All user inputs are validated; no external network requests; least-privilege CI/CD
- **Compatibility** — Clean browser feature detection, graceful degradation, and a modular architecture that welcomes new targets and platforms
- **Performance** — Lightweight vanilla JS with zero build overhead; responsive UI that never blocks during long operations

## Features

- **Flash** — Upload an Intel HEX file and write it to your target MCU
- **Recover** — Mass erase locked devices via platform-specific access ports (e.g., Nordic CTRL-AP)
- **Verify** — Read back and compare flashed firmware byte-by-byte (optional)
- **RTT (Real-Time Transfer)** — Bidirectional terminal communication using SEGGER RTT protocol with configurable scan range and polling interval
- **Extensible** — Add new target MCUs via JSON definition files; add new platforms via handler modules

## Supported Targets

| MCU | Platform | Flash Controller | Status |
|-----|----------|-----------------|--------|
| nRF54L15 | Nordic | RRAMC | ✅ Supported |

## Quick Start

### Try Online

Visit [freeocd.org](https://freeocd.org) to use the WebDebugger directly in your browser — no build or server setup required.

### Prerequisites

**For Online Use:**
- A Chromium-based browser (Chrome, Edge) — WebUSB is required
- A CMSIS-DAP compatible debug probe

**For Local Development:**
- [Node.js](https://nodejs.org/) (v20+ recommended) — for building DAP.js
- Python 3 — for running local HTTP server

### Clone & Build

```console
$ git clone --recurse-submodules https://github.com/FreeOCD/freeocd-web.git
$ cd freeocd-web
$ cd vendor/dapjs && npm install && npm run build && cd ../..
$ mkdir -p public/lib
$ cp vendor/dapjs/dist/dap.umd.js public/lib/dap.umd.js
$ cp vendor/dapjs/LICENSE public/lib/dapjs-LICENSE.txt
```

### Run Locally

```console
$ python3 -m http.server 8000 -d public
```

Open `http://localhost:8000` in Chrome or Edge.

### Usage

#### Flashing Firmware

1. Accept the disclaimer
2. Select your target MCU from the dropdown
3. Choose a firmware `.hex` file
4. Click **Flash** to erase and program the device
5. (Optional) Click **Recover** to mass erase a locked device without flashing

#### RTT Terminal

1. Configure RTT scan settings (start address, range, polling interval)
2. Click **Connect RTT** to establish RTT connection
3. Use the terminal to send commands and view output
4. Click **Disconnect RTT** to close the connection
5. Note: RTT connection is automatically disconnected during Flash/Recover operations; reconnect it manually after completion

## Supported Browsers

WebUSB is required. The following browsers are supported:

- Google Chrome (desktop)
- Microsoft Edge (desktop)
- Other Chromium-based browsers

Safari and Firefox do not support WebUSB.

## Adding a New Target

1. Create a JSON definition file in `public/targets/<platform>/<family>/<mcu>.json` (include `id`, `name`, `platform`, `capabilities`, `description`, etc. — see [CONTRIBUTING.md](CONTRIBUTING.md#adding-a-new-target-mcu) for the full schema).
2. Append the new target's ID string to the `targets` array in `public/targets/index.json`.
3. If the platform is new, create a handler class in `public/js/platform/` and register it in `target-manager.js`.

See `public/targets/nordic/nrf54/nrf54l15.json` for an example target definition.

CMSIS-DAP probe USB filters are managed centrally in `public/targets/probe-filters.json` rather than per-target. See [CONTRIBUTING.md](CONTRIBUTING.md#adding-a-new-cmsis-dap-probe-vendor-id) for the probe vendor ID workflow.

## Documentation

- **[AI_REVIEW.md](AI_REVIEW.md)** — Code review checklist with architecture diagrams, systematic checks, and CMSIS-DAP glossary. Useful for both AI and human reviewers.

## Architecture

The application follows a layered architecture with clear separation of concerns:

### Layer Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        UI Layer                              │
│  (index.html + css/style.css)                               │
│  - Modal dialogs, step progress, terminal UI                 │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                    Application Layer                         │
│  (main.js)                                                   │
│  - Event handling, operation orchestration, state management│
│  - Operation locking to prevent conflicts                   │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                    Platform Layer                             │
│  (platform/)                                                 │
│  - TargetManager: Loads target definitions                  │
│  - PlatformHandler: Abstract base for platform operations    │
│  - NordicHandler: Nordic-specific implementation             │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                      Core Layer                              │
│  (core/)                                                     │
│  - hex-parser.js: Intel HEX parsing                         │
│  - dap-operations.js: Low-level DAP transfer operations      │
│  - probe-filters.js: CMSIS-DAP probe VID list loader        │
│  - rtt-handler.js: SEGGER RTT protocol implementation        │
│  - terminal.js: Terminal UI component                       │
│  - state-manager.js: Connection state monitoring            │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                   Transport Layer                            │
│  (transport/)                                                │
│  - TransportInterface: Abstract transport contract           │
│  - WebUSBTransport: WebUSB implementation                   │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                   Hardware Layer                             │
│  - CMSIS-DAP debug probe (via WebUSB)                       │
│  - Target MCU (e.g., nRF54L15)                              │
└─────────────────────────────────────────────────────────────┘
```

### Key Components

**Transport Layer**
- Abstracts device communication (currently WebUSB only)
- Allows future support for WebSerial or other transports
- `TransportInterface` defines the contract for all transports

**Core Layer**
- `hex-parser.js`: Parses Intel HEX files into binary data
- `dap-operations.js`: Raw DAP_TRANSFER operations bypassing DAP.js bugs
- `probe-filters.js`: Loads the central CMSIS-DAP probe vendor ID list
- `rtt-handler.js`: Implements SEGGER RTT for bidirectional communication
- `terminal.js`: Simple terminal UI without external dependencies
- `state-manager.js`: Monitors device/RTT connection state with polling

**Platform Layer**
- `TargetManager`: Loads target JSON definitions and instantiates handlers
- `PlatformHandler`: Abstract base defining recover/flash/verify/reset contract
- `NordicHandler`: Nordic-specific implementation (CTRL-AP, RRAMC/NVMC)

**Application Layer**
- `main.js`: Orchestrates operations with step-by-step progress
- Operation locking prevents Flash/Recover/RTT conflicts
- State management for UI updates and error recovery

### Target Definition Format

Target definitions are JSON files in `public/targets/<platform>/<family>/<mcu>.json`:

```json
{
  "id": "nordic/nrf54/nrf54l15",
  "name": "nRF54L15",
  "platform": "nordic",
  "cpu": "cortex-m33",
  "cputapid": "0x6ba02477",
  "ctrlAp": {
    "num": 2,
    "idr": "0x32880000"
  },
  "eraseAllStatus": {
    "ready": 0,
    "readyToReset": 1,
    "busy": 2,
    "error": 3
  },
  "flashController": {
    "type": "rramc",
    "base": "0x5004B000",
    "registers": {
      "config": { "offset": "0x500", "enableValue": "0x101" },
      "ready": { "offset": "0x400" },
      "readyNext": { "offset": "0x404" }
    }
  },
  "flash": {
    "address": "0x00000000",
    "size": "0x0017D000"
  },
  "sram": {
    "address": "0x20000000",
    "workAreaSize": "0x4000"
  },
  "capabilities": ["recover", "flash", "verify", "rtt"],
  "description": "Nordic nRF54L15 (Cortex-M33, RRAMC)"
}
```

> Probe USB vendor IDs are maintained in `public/targets/probe-filters.json`, not in per-target JSON files.


### Operation Flow

**Flash Operation**
1. User selects target MCU and HEX file
2. `runFlash()` acquires operation lock
3. Disconnect RTT if connected
4. Connect via WebUSB and DAP
5. Call `handler.recover()` for mass erase
6. Create fresh DAP connection
7. Call `handler.flash()` to write firmware
8. If verify enabled, call `handler.verify()`
9. Call `handler.reset()` to restart device
10. Release lock and cleanup

**RTT Connection**
1. User clicks "Connect RTT"
2. `connectRtt()` acquires RTT lock
3. Connect via WebUSB and DAP
4. Halt and reset target
5. Scan memory for RTT control block signature
6. Initialize RTT handler with buffer info
7. Resume target
8. Start StateManager polling (1s interval)
9. Start RTT data polling (configurable interval)
10. Enable terminal for bidirectional communication

## Project Structure

```
public/                         # Deployable static site
├── index.html                  # Main UI
├── css/style.css               # Styles
├── js/
│   ├── main.js                 # Application entry point
│   ├── core/                   # HEX parser, DAP ops, probe filter loader,
│   │                           #   RTT handler, state manager, terminal UI
│   ├── transport/              # Transport abstraction (WebUSB, future: WebSerial)
│   └── platform/               # Platform handlers (Nordic, future: STM32, RP2040)
├── targets/                    # JSON target definitions
│   ├── index.json              # List of available target IDs
│   ├── probe-filters.json      # Central CMSIS-DAP probe vendor ID list
│   └── nordic/nrf54/           # Nordic nRF54 series
└── lib/                        # Built dependencies (gitignored)
scripts/                        # Development scripts
└── validate-json.js            # JSON validator for public/targets/
vendor/dapjs/                   # DAP.js source (git submodule)
AI_REVIEW.md                    # Code review checklist for AI/human reviewers
```

## License

This project is licensed under the **BSD 3-Clause License**. See [LICENSE](LICENSE) for details.

### Third-Party Licenses

- **[DAP.js](https://github.com/ARMmbed/dapjs)** — MIT License (Copyright (c) Arm Limited 2018, Microsoft Corporation)