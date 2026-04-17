# FreeOCD WebDebugger

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

## Documentation

- **[AI_REVIEW.md](AI_REVIEW.md)** — Production-level code review checklist with architecture diagrams (Mermaid), 95 checklist items across 15 categories, and a CMSIS-DAP glossary. Primarily intended as a reference for AI code reviewers (Cascade, Copilot, Cursor, etc.) — human reviewers can use it as a lookup or let AI handle the systematic checks.

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
scripts/                        # Development scripts
└── validate-json.js            # Target JSON validator
vendor/dapjs/                   # DAP.js source (git submodule)
AI_REVIEW.md                    # Code review checklist for AI/human reviewers
```

## License

This project is licensed under the **BSD 3-Clause License**. See [LICENSE](LICENSE) for details.

### Third-Party Licenses

- **[DAP.js](https://github.com/ARMmbed/dapjs)** — MIT License (Copyright (c) Arm Limited 2018, Microsoft Corporation)