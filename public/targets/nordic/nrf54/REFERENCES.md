# References

The register addresses, CTRL-AP constants, and flash controller parameters
in this directory's target definition files were determined from the following
sources:

- **Nordic Semiconductor nRF54L15 Product Specification** — Hardware register
  definitions (RRAMC, CTRL-AP, flash memory map)
- **[platform-seeedboards](https://github.com/Seeed-Studio/platform-seeedboards/)**
  (Apache License 2.0) — OpenOCD configuration for nRF54L (`nrf54l.cfg`) was
  used as a cross-reference for CTRL-AP register offsets, IDR values, and
  RRAMC programming procedures
- **[OpenOCD](https://openocd.org/)** (GPL-2.0) — `nrf52.cfg` target
  configuration was used as a cross-reference for Nordic CTRL-AP recovery
  procedure patterns
