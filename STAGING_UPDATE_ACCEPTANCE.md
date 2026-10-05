# Staging update acceptance 0.8.5

Branch: `staging/update-acceptance-0.8.5`, based on canonical accepted
`ab05d0d220fc57c5c3a5b85f3f5423a1ccf940c2`.

This is a staging-only in-place update acceptance release. The existing
`npm run build:zui:staging` overlay now emits
`com.zui.webos.youtube.staging`, version `0.8.5`, title `ZUI YouTube STAGING`.
No YouTube feature code is changed. Production assets and package version remain
`youtube.leanback.v4` / `0.8.4`. Do not merge this acceptance branch into main.

Reproduce from a clean checkout of the release-bound source commit:

```powershell
node --test bench/staging-version-test.mjs
npm run test:zui
npm run type-check
npm run build:zui:staging
npm run package
```

Inspect the generated IPK and bind its measured SHA-256/size to the platform's
existing operational signed staging release pipeline. Do not patch the IPK,
uninstall first, clear app data or deploy production artifacts. The purpose is
to prove the Store's UPGRADE lifecycle from installed staging `0.8.4` to `0.8.5`.
