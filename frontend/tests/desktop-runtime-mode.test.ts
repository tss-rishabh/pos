import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface RuntimeMode {
  development: boolean;
  nativeSmoke: boolean;
  devTools: boolean;
  allowLoopbackHttp: boolean;
  profileDirectory: string | null;
}
const require = createRequire(import.meta.url);
const { runtimeMode } = require('../electron/runtime-mode.cjs') as {
  runtimeMode: (input: {
    isPackaged: boolean;
    env?: Record<string, string | undefined>;
    packageMetadata?: unknown;
  }) => RuntimeMode;
};
const release = { name: '@pos/frontend', version: '0.1.0', main: 'electron/main.cjs' };
const smokeFlavour = { ...release, posDesktopNativeSmoke: true };
const devEnv = { NODE_ENV: 'development', POS_DESKTOP_PROFILE_DIR: 'profile dir' };
const closed = {
  development: false,
  nativeSmoke: false,
  devTools: false,
  allowLoopbackHttp: false,
  profileDirectory: null,
};

describe('desktop runtime mode (main.cjs)', () => {
  it('gives an unpackaged NODE_ENV=development run DevTools, loopback http and the profile override', () => {
    expect(runtimeMode({ isPackaged: false, env: devEnv, packageMetadata: release })).toEqual({
      development: true,
      nativeSmoke: false,
      devTools: true,
      allowLoopbackHttp: true,
      profileDirectory: resolve('profile dir'),
    });
  });

  it('ignores NODE_ENV in a packaged release build: no DevTools, no loopback http, no profile override', () => {
    expect(runtimeMode({ isPackaged: true, env: devEnv, packageMetadata: release })).toEqual(
      closed,
    );
    expect(
      runtimeMode({
        isPackaged: true,
        env: { ...devEnv, POS_DESKTOP_NATIVE_SMOKE: '1' },
        packageMetadata: release,
      }),
    ).toEqual(closed);
  });

  it('needs both the baked smoke flavour and the launch variable, and never enables DevTools', () => {
    expect(runtimeMode({ isPackaged: true, env: devEnv, packageMetadata: smokeFlavour })).toEqual(
      closed,
    );
    expect(
      runtimeMode({
        isPackaged: true,
        env: { ...devEnv, POS_DESKTOP_NATIVE_SMOKE: '1' },
        packageMetadata: smokeFlavour,
      }),
    ).toEqual({
      development: false,
      nativeSmoke: true,
      devTools: false,
      allowLoopbackHttp: true,
      profileDirectory: resolve('profile dir'),
    });
  });

  it('accepts only a boolean flavour key and only the exact launch value', () => {
    for (const flavour of ['true', 1, {}, null])
      expect(
        runtimeMode({
          isPackaged: true,
          env: { POS_DESKTOP_NATIVE_SMOKE: '1' },
          packageMetadata: { ...release, posDesktopNativeSmoke: flavour },
        }).nativeSmoke,
      ).toBe(false);
    for (const value of ['true', 'yes', '01', ''])
      expect(
        runtimeMode({
          isPackaged: true,
          env: { POS_DESKTOP_NATIVE_SMOKE: value },
          packageMetadata: smokeFlavour,
        }).nativeSmoke,
      ).toBe(false);
  });

  it('does not treat a smoke flavour key as development in an unpackaged run', () => {
    expect(
      runtimeMode({
        isPackaged: false,
        env: { POS_DESKTOP_NATIVE_SMOKE: '1', POS_DESKTOP_PROFILE_DIR: 'x' },
        packageMetadata: smokeFlavour,
      }),
    ).toEqual(closed);
  });
});
