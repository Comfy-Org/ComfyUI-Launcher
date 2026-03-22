import { expect, test } from '@playwright/test'
import { launchLauncherAppDev } from './support/electronHarness'

test.describe('Main window visibility in dev mode (#283)', () => {
  test('main window becomes visible even when dev server is not ready @macos @windows @linux', async () => {
    const { application, cleanup } = await launchLauncherAppDev()
    try {
      // The window must become visible even when ELECTRON_RENDERER_URL
      // points at a port with nothing listening (simulates the Vite dev
      // server not being ready yet — the exact scenario from issue #283).
      await expect
        .poll(
          async () => {
            return application.evaluate(({ BrowserWindow }) => {
              const wins = BrowserWindow.getAllWindows()
              return wins.length > 0 && wins[0]!.isVisible()
            })
          },
          {
            message:
              'Main window never became visible in dev mode — reproduces issue #283',
            timeout: 15_000,
            intervals: [500],
          },
        )
        .toBe(true)
    } finally {
      await cleanup()
    }
  })
})
