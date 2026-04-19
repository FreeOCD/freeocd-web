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
   - Include all required fields: `id`, `name`, `platform`, `cpu`, `ctrlAp`, `flashController`, `flash`, `sram`, `capabilities`, `description`.
   - `id` must be `"<platform>/<family>/<mcu>"` matching the file path (e.g. `"nordic/nrf54/nrf54l15"`).
   - `capabilities` is a string array. Recognized values are `"flash"`, `"verify"`, `"recover"`, `"rtt"`. UI elements (Flasher section, Verify checkbox, Recover button, RTT panel) are shown only when the matching capability is present. The `capabilities` array is required and is enforced by `scripts/validate-json.js`; unknown values, duplicate entries, and the deprecated `usbFilters` field cause the validator (and CI) to fail.
   - **Do not** include a `usbFilters` field. CMSIS-DAP probe USB filtering is managed centrally in `public/targets/probe-filters.json` (see [Adding a New CMSIS-DAP Probe Vendor ID](#adding-a-new-cmsis-dap-probe-vendor-id)).

2. **Register in index**: Append the new target's ID to the `targets` array in `public/targets/index.json`.

    ```json
    {
      "targets": [
        "nordic/nrf54/nrf54l15",
        "<platform>/<family>/<mcu>"
      ]
    }
    ```

    The individual target JSON is the single source of truth for display metadata; `index.json` only lists IDs so each target's JSON is fetched on startup to populate the selector.

3. **Add a REFERENCES.md** in the target's directory if register values were cross-referenced from external sources (datasheets, other open-source projects).

## Adding a New CMSIS-DAP Probe Vendor ID

FreeOCD WebDebugger uses `navigator.usb.requestDevice({ filters })` to show only known CMSIS-DAP probes in the browser's device chooser. The filter list is maintained centrally in `public/targets/probe-filters.json` so that probe support is decoupled from target MCU definitions and the whole `public/targets/` tree can be shared verbatim with sister projects such as [`freeocd-vscode-extension`](https://github.com/FreeOCD/freeocd-vscode-extension).

### When to add a new vendor ID

Add a vendor ID when you have verified that a CMSIS-DAP-compatible probe does not appear in the WebUSB chooser because its USB vendor ID is not yet listed. Check the probe's VID with `lsusb` (Linux), `system_profiler SPUSBDataType` (macOS), or Device Manager (Windows).

### How to add

1. **Edit `public/targets/probe-filters.json`** and append the vendor ID to the `vendorIds` array:

    ```json
    {
      "description": "Known CMSIS-DAP probe vendor IDs for filtering",
      "vendorIds": [
        { "vid": "0x0D28", "$comment": "ARM / mbed — DAPLink / MBED CMSIS-DAP" },
        { "vid": "0x2886", "$comment": "SeeedStudio — XIAO MG24 / nRF54L15 XIAO / Seeeduino XIAO (DAPv2)" },
        { "vid": "0x2E8A", "$comment": "Raspberry Pi — Debug Probe" },
        { "vid": "0xXXXX", "$comment": "<Vendor Name> — <Product / Probe Name>" }
      ]
    }
    ```

    - Use the uppercase 4-digit hex form (`0xXXXX`) for the `vid` field.
    - Prefer the USB-IF-assigned vendor ID rather than OEM sub-IDs.
    - Keep the list sorted in ascending numeric order by `vid`.
    - Populate `$comment` with the vendor name and known product / probe names so future contributors can match a VID to real hardware without leaving the file.
    - The legacy bare-string form (`"0x0D28"`) is still accepted by the loader for backwards compatibility, but new entries should use the object form.

2. **Validate** the JSON file:

    ```console
    $ node scripts/validate-json.js
    ```

3. **Open a Pull Request** that includes:
    - The vendor and product name of the probe you verified with.
    - Evidence of CMSIS-DAP compliance (e.g. a link to the probe firmware's README or the manufacturer's documentation).
    - A note if the vendor ID is shared across non-CMSIS-DAP products. Because WebUSB cannot post-filter by product name, broad vendor IDs inflate the chooser list.

### Cross-repository sync

The [`freeocd-vscode-extension`](https://github.com/FreeOCD/freeocd-vscode-extension) project maintains its own copy of this list at `resources/probe-filters.json`. When practical, please submit an equivalent PR there so both front-ends stay in sync.

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
