// KV cache: none
// rlmh's one top-level entry (cordis.patch.yml `rlmh-settings`, named by the package): the user's settings
// service (lib/settings.js). Because package.json declares a browser half under `dsh.client` (lib/client.js, the
// settings page), dsh allows only one active deployment entry from this package, so the settings service is it.
export { default, name, SETTING_DEFAULTS, effective } from './settings.js'
