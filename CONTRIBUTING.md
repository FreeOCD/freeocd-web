# Contributing to FreeOCD WebDebugger

Thank you for your interest in contributing! This document provides guidelines for contributing to the project.

## Development Setup

### Prerequisites

- Node.js v20+ (for building DAP.js)
- A Chromium-based browser (Chrome or Edge) with WebUSB support
- A CMSIS-DAP compatible debug probe and target MCU for testing

### Getting Started

```console
$ git clone --recurse-submodules https://github.com/FreeOCD/freeocd-web.git
$ cd freeocd-web
$ cd vendor/dapjs && npm install && npm run build && cd ../..
$ mkdir -p public/lib
$ cp vendor/dapjs/dist/dap.umd.js public/lib/dap.umd.js
$ cp vendor/dapjs/LICENSE public/lib/dapjs-LICENSE.txt
$ python3 -m http.server 8000 -d public
```

Open `http://localhost:8000` in your browser to test.

## Code Style

- This is a **vanilla HTML + JavaScript** project with no build tools or frameworks.
- All source files use ES Modules (`import`/`export`).
- Use `const` and `let` (never `var`).
- Follow existing code style and indentation (4 spaces).
- Keep source code comments in English.

## Branch Strategy

- `main` — Stable branch. All PRs should target `main`.
- Feature branches — Use descriptive names: `feature/add-stm32-support`, `fix/flash-verify-bug`.

## Pull Requests

1. Fork the repository and create a feature branch from `main`.
2. Keep PRs focused and small. One PR per feature or fix.
3. Write clear commit messages in English.
4. Ensure the CI workflow passes before requesting review.
5. Update documentation if your change affects user-facing behavior.

## Adding a New Target MCU

1. **Create a JSON definition file**: `public/targets/<platform>/<family>/<mcu>.json`
   - See `public/targets/nordic/nrf54/nrf54l15.json` for the schema.
   - Include all required fields: `name`, `platform`, `cpu`, `ctrlAp`, `flashController`, `flash`, `sram`, `usbFilters`, `capabilities`.

2. **Register in index**: Add an entry to `public/targets/index.json`.

3. **Add a REFERENCES.md** in the target's directory if register values were cross-referenced from external sources (datasheets, other open-source projects).

## Adding a New Platform

1. **Create a handler class**: `public/js/platform/<platform>-handler.js`
   - Extend `PlatformHandler` from `platform-handler.js`.
   - Implement `recover()`, `flash()`, `verify()`, and `reset()`.

2. **Register the handler**: Add an import and entry in `PLATFORM_HANDLERS` within `public/js/platform/target-manager.js`.

3. **Create target definitions**: Add JSON files for the supported MCUs under `public/targets/<platform>/`.

## Adding a New Transport

1. **Create a transport class**: `public/js/transport/<transport>-transport.js`
   - Extend `TransportInterface` from `transport-interface.js`.
   - Implement `selectDevice()`, `getTransport()`, `getDeviceName()`.

2. **Integrate with the UI**: Update `public/js/main.js` to allow transport selection.

## License Compliance

- **FreeOCD WebDebugger** is licensed under the BSD 3-Clause License.
- **DAP.js** (in `vendor/dapjs`) is licensed under the MIT License. Its license file must be distributed with the built artifact (`public/lib/dapjs-LICENSE.txt`).
- When adding code derived from external sources, include appropriate license headers and attribution.

## Issues

- Use GitHub Issues to report bugs or request features.
- Provide detailed reproduction steps for bug reports.
- For feature requests, describe the use case and expected behavior.
