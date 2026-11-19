const path = require('node:path');

/** Environment variable that, together with the baked smoke flavour, enables the native smoke. */
const NATIVE_SMOKE_ENV = 'POS_DESKTOP_NATIVE_SMOKE';
/** Packaged package.json key that only CI's native-smoke packaging sets (electron-builder
 * `-c.extraMetadata.posDesktopNativeSmoke=true`). It lives inside app.asar, whose header hash is
 * embedded in the executable and enforced by the ASAR-integrity fuse (and covered by the code
 * signature in signed builds), so it cannot be switched on by an environment variable or by
 * editing files next to an installed release build. */
const NATIVE_SMOKE_FLAVOUR = 'posDesktopNativeSmoke';

/**
 * Decide which development and test behaviour this desktop process may use.
 *
 * - An unpackaged run (`electron .`) with NODE_ENV=development is development: DevTools, a
 *   loopback http workspace origin and a POS_DESKTOP_PROFILE_DIR profile override.
 * - A packaged build ignores NODE_ENV entirely: no DevTools, https workspace origins only and the
 *   operating system's default profile location.
 * - The only packaged seam is the CI native-smoke flavour: the baked flavour key AND
 *   POS_DESKTOP_NATIVE_SMOKE=1 at launch allow a loopback http origin and an isolated profile, so
 *   the packaged smokes never touch a real profile. It never enables DevTools. Release packages
 *   are verified to carry no flavour key (tools/verify-desktop-package.mjs).
 */
function runtimeMode({ isPackaged, env = {}, packageMetadata = null }) {
  const development = isPackaged === false && env.NODE_ENV === 'development';
  const smokeFlavour =
    isPackaged === true &&
    packageMetadata !== null &&
    typeof packageMetadata === 'object' &&
    packageMetadata[NATIVE_SMOKE_FLAVOUR] === true;
  const nativeSmoke = smokeFlavour && env[NATIVE_SMOKE_ENV] === '1';
  const isolated = development || nativeSmoke;
  const profile = env.POS_DESKTOP_PROFILE_DIR;
  return Object.freeze({
    development,
    nativeSmoke,
    devTools: development,
    allowLoopbackHttp: isolated,
    profileDirectory:
      isolated && typeof profile === 'string' && profile.length > 0 ? path.resolve(profile) : null,
  });
}

module.exports = { runtimeMode, NATIVE_SMOKE_ENV, NATIVE_SMOKE_FLAVOUR };
