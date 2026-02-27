import { expect, test } from '@playwright/test'
import { launchLauncherApp, waitForAppExit } from './support/electronHarness'

test.describe('Launcher Quit Flow', () => {
  test.skip(process.platform !== 'darwin', 'Regression is specific to macOS quit lifecycle')

  test('app.quit exits cleanly while tray-close mode is active @macos', async () => {
    const { application, cleanup } = await launchLauncherApp()
    try {
      const launcherWindow = await application.firstWindow()
      await expect(launcherWindow).toBeTruthy()

      const exitPromise = waitForAppExit(application)
      await application.evaluate(({ app }) => {
        app.quit()
      })

      await exitPromise
    } finally {
      await cleanup()
    }
  })
})
