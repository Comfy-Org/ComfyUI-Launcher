import { expect, test } from '@playwright/test'
import { launchLauncherApp } from './support/electronHarness'

test.describe('Main window visibility (#283)', () => {
  test('main window becomes visible after launch @macos @windows @linux', async () => {
    const { application, cleanup } = await launchLauncherApp()
    try {
      const mainWindow = await application.firstWindow()

      // The window must eventually become visible (not stuck hidden).
      // Poll because the window starts with show:false and transitions via ready-to-show.
      await expect
        .poll(
          async () => {
            return application.evaluate(({ BrowserWindow }) => {
              const wins = BrowserWindow.getAllWindows()
              return wins.length > 0 && wins[0]!.isVisible()
            })
          },
          {
            message: 'Main window never became visible — reproduces issue #283',
            timeout: 15_000,
            intervals: [500],
          },
        )
        .toBe(true)

      // Sanity: the window should have non-zero size
      const bounds = await application.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        return win?.getBounds()
      })
      expect(bounds).toBeDefined()
      expect(bounds!.width).toBeGreaterThan(0)
      expect(bounds!.height).toBeGreaterThan(0)

      // Sanity: the renderer loaded (the #app mount point exists)
      const appDiv = mainWindow.locator('#app')
      await expect(appDiv).toBeAttached({ timeout: 10_000 })
    } finally {
      await cleanup()
    }
  })
})
