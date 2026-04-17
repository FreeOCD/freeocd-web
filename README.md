# FreeOCD WebDebugger

A browser-based open-source debugger for ARM microcontrollers. Flash firmware, recover locked devices, and verify flash contents — all from your browser using WebUSB and CMSIS-DAP.

## Features

- **Flash** — Upload an Intel HEX file and write it to your target MCU
- **Recover** — Mass erase locked devices via platform-specific access ports (e.g., Nordic CTRL-AP)
- **Verify** — Read back and compare flashed firmware byte-by-byte (optional)
- **Extensible** — Add new target MCUs via JSON definition files; add new platforms via handler modules

## Supported Targets

| MCU | Platform | Flash Controller | Status |
|-----|----------|-----------------|--------|
| nRF54L15 | Nordic | RRAMC | ✅ Supported |

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) (v20+ recommended) — for building DAP.js
- A Chromium-based browser (Chrome, Edge) — WebUSB is required
- A CMSIS-DAP compatible debug probe

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

1. Accept the disclaimer
2. Select your target MCU from the dropdown
3. Choose a firmware `.hex` file
4. Click **Flash** to erase and program the device
5. (Optional) Click **Recover** to mass erase a locked device without flashing

## Supported Browsers

WebUSB is required. The following browsers are supported:

- Google Chrome (desktop)
- Microsoft Edge (desktop)
- Other Chromium-based browsers

Safari and Firefox do not support WebUSB.

## Adding a New Target

1. Create a JSON definition file in `public/targets/<platform>/<family>/<mcu>.json`
2. Add an entry to `public/targets/index.json`
3. If the platform is new, create a handler class in `public/js/platform/` and register it in `target-manager.js`

See `public/targets/nordic/nrf54/nrf54l15.json` for an example target definition.

## Project Structure

```
public/                         # Deployable static site
├── index.html                  # Main UI
├── css/style.css               # Styles
├── js/
│   ├── main.js                 # Application entry point
│   ├── core/                   # HEX parser, low-level DAP operations
│   ├── transport/              # Transport abstraction (WebUSB, future: WebSerial)
│   └── platform/               # Platform handlers (Nordic, future: STM32, RP2040)
├── targets/                    # JSON target definitions
│   └── nordic/nrf54/           # Nordic nRF54 series
└── lib/                        # Built dependencies (gitignored)
vendor/dapjs/                   # DAP.js source (git submodule)
```

## License

This project is licensed under the **BSD 3-Clause License**. See [LICENSE](LICENSE) for details.

### Third-Party Licenses

- **[DAP.js](https://github.com/ARMmbed/dapjs)** — MIT License (Copyright (c) Arm Limited 2018, Microsoft Corporation)