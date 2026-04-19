// Probe filter loader: loads known CMSIS-DAP probe vendor IDs from
// `probe-filters.json` and returns filter objects usable by
// `navigator.usb.requestDevice({filters})`.
//
// In freeocd-web, the canonical location is `public/targets/probe-filters.json`
// so that the entire `public/targets/` tree (target MCU JSONs + probe filter
// list) can be shared verbatim with sister projects such as
// `freeocd-vscode-extension` (`resources/probe-filters.json`). Target JSONs
// must not carry their own `usbFilters` field; probes are orthogonal to the
// target MCU.

/**
 * Load the central CMSIS-DAP probe filter list.
 *
 * The JSON's `vendorIds` array may contain either of the following forms per
 * entry:
 *   - a bare hex string (legacy form): `"0x03EB"`
 *   - an object with a `vid` hex string and an optional `$comment` describing
 *     the vendor/products: `{ "vid": "0x03EB", "$comment": "Vendor — Product A / Product B" }`
 *
 * @param {string} basePath - Base path under which `probe-filters.json` lives.
 *                            Defaults to `'./targets'` which matches the
 *                            canonical location in freeocd-web; pass a
 *                            different value if embedding this loader in a
 *                            project that stores the file elsewhere.
 * @returns {Promise<Array<{vendorId: number}>>} Filter objects. Empty array on
 *   fetch/parse failure (= "no vendor filter", matching the VS Code extension's
 *   fallback when the JSON cannot be loaded).
 */
export async function loadProbeFilters(basePath = './targets') {
    const url = `${basePath}/probe-filters.json`;
    let response;
    try {
        response = await fetch(url);
    } catch (err) {
        console.warn(
            `probe-filters.json fetch failed (${url}): ${err.message}. ` +
                'Falling back to no vendor filter.'
        );
        return [];
    }

    if (!response.ok) {
        console.warn(
            `probe-filters.json fetch returned HTTP ${response.status} (${url}). ` +
                'Falling back to no vendor filter.'
        );
        return [];
    }

    let data;
    try {
        data = await response.json();
    } catch (err) {
        console.warn(
            `probe-filters.json is not valid JSON: ${err.message}. ` +
                'Falling back to no vendor filter.'
        );
        return [];
    }

    const vendorIds = data && data.vendorIds;
    if (!Array.isArray(vendorIds)) {
        console.warn(
            'probe-filters.json is missing a `vendorIds` array. ' +
                'Falling back to no vendor filter.'
        );
        return [];
    }

    const filters = [];
    for (const raw of vendorIds) {
        // Each entry may be a bare hex string (legacy form) or an object with
        // a `vid` hex string plus optional `$comment` describing the vendor.
        const vidStr =
            typeof raw === 'string'
                ? raw
                : raw && typeof raw === 'object'
                    ? raw.vid
                    : null;
        if (typeof vidStr !== 'string') {
            console.warn(
                `Skipping invalid vendor entry in probe-filters.json: ${JSON.stringify(raw)}`
            );
            continue;
        }
        const vid = parseInt(vidStr, 16);
        if (Number.isNaN(vid)) {
            console.warn(`Skipping invalid vendor ID in probe-filters.json: ${vidStr}`);
            continue;
        }
        filters.push({ vendorId: vid });
    }

    return filters;
}
