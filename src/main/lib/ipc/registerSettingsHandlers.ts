import {
  ipcMain, nativeTheme,
  sources, settings, i18n,
  getAppVersion, resolveTheme,
  _onLocaleChanged, _broadcastToRenderer,
} from './shared'

export function registerSettingsHandlers(): void {
  ipcMain.handle('get-settings-sections', () => {
    const s = settings.getAll()
    const chineseMirrorsField = {
      id: 'useChineseMirrors', label: i18n.t('settings.useChineseMirrors'), type: 'boolean' as const, value: s.useChineseMirrors === true,
      ...(s.useChineseMirrors === true ? { description: i18n.t('settings.chineseMirrorsDescription') } : {}),
    }
    const isChinese = i18n.getLocale().startsWith('zh')
    const appSections = [
      {
        title: i18n.t('settings.general'),
        fields: [
          { id: 'language', label: i18n.t('settings.language'), type: 'select', value: s.language || i18n.getLocale(),
            options: i18n.getAvailableLocales() },
          { id: 'theme', label: i18n.t('settings.theme'), type: 'select', value: s.theme || 'system',
            options: [
              { value: 'system', label: i18n.t('settings.themeSystem') },
              { value: 'dark', label: i18n.t('settings.themeDark') },
              { value: 'light', label: i18n.t('settings.themeLight') },
              { value: 'solarized', label: i18n.t('settings.themeSolarized') },
              { value: 'nord', label: i18n.t('settings.themeNord') },
              { value: 'arc', label: i18n.t('settings.themeArc') },
              { value: 'github', label: i18n.t('settings.themeGithub') },
            ] },
          { id: 'autoUpdate', label: i18n.t('settings.autoUpdate'), type: 'boolean', value: s.autoUpdate !== false },
          { id: 'onAppClose', label: i18n.t('settings.onAppClose'), type: 'select', value: s.onAppClose || settings.defaults.onAppClose,
            options: [
              { value: 'quit', label: i18n.t('settings.closeQuit') },
              { value: 'tray', label: i18n.t('settings.closeTray') },
            ] },
          ...(isChinese ? [chineseMirrorsField] : []),
        ],
        actions: [
          { label: i18n.t('settings.checkForUpdates'), action: 'check-for-update' },
        ],
      },
      {
        title: i18n.t('settings.telemetry'),
        fields: [
          { id: 'telemetryEnabled', label: i18n.t('settings.telemetryEnabled'), type: 'boolean', value: s.telemetryEnabled !== false },
        ],
      },
      {
        title: i18n.t('settings.downloads'),
        fields: [
          { id: 'cacheDir', label: i18n.t('settings.cacheDir'), type: 'path', value: s.cacheDir, openable: true },
          { id: 'maxCachedFiles', label: i18n.t('settings.maxCachedFiles'), type: 'number', value: s.maxCachedFiles, min: 1, max: 50 },
        ],
      },
      {
        title: i18n.t('settings.advanced'),
        fields: [
          { id: 'pypiMirror', label: i18n.t('settings.pypiMirror'), type: 'text' as const, value: s.pypiMirror || '',
            placeholder: i18n.t('settings.pypiMirrorPlaceholder') },
          ...(!isChinese ? [chineseMirrorsField] : []),
        ],
      },
    ]
    const sourceSections = sources.flatMap((src) => {
      const plugin = src as unknown as Record<string, unknown>
      if (typeof plugin.getSettingsSections === 'function') {
        return (plugin.getSettingsSections as (s: Record<string, unknown>) => Record<string, unknown>[])(s as Record<string, unknown>)
      }
      return []
    })
    const version = getAppVersion()
    const aboutSection = {
      title: i18n.t('settings.about'),
      fields: [
        { label: i18n.t('settings.version'), value: version, readonly: true },
        { label: i18n.t('settings.platform'), value: `${process.platform} (${process.arch})`, readonly: true },
      ],
      actions: [
        { id: 'github', label: 'GitHub', url: 'https://github.com/Comfy-Org/ComfyUI-Desktop-2.0-Beta' },
      ],
    }
    return [...appSections, ...sourceSections, aboutSection]
  })

  ipcMain.handle('get-models-sections', () => {
    const s = settings.getAll()
    return {
      systemDefault: settings.defaults.modelsDirs[0],
      sections: [
        {
          title: i18n.t('models.directories'),
          fields: [
            { id: 'modelsDirs', label: i18n.t('models.directoriesDesc'), type: 'pathList', value: s.modelsDirs || [] },
          ],
        },
      ],

    }
  })

  ipcMain.handle('get-media-sections', () => {
    const s = settings.getAll()
    return [
      {
        title: i18n.t('media.sharedDirs'),
        fields: [
          { id: 'inputDir', label: i18n.t('media.inputDir'), type: 'path' as const, value: s.inputDir || settings.defaults.inputDir, openable: true, tooltip: i18n.t('tooltips.inputDir') },
          { id: 'outputDir', label: i18n.t('media.outputDir'), type: 'path' as const, value: s.outputDir || settings.defaults.outputDir, openable: true, tooltip: i18n.t('tooltips.outputDir') },
        ],
      },
    ]
  })

  ipcMain.handle('set-setting', (_event, key: string, value: unknown) => {
    settings.set(key, value)
    if (key === 'theme') {
      _broadcastToRenderer('theme-changed', resolveTheme())
    }
    if (key === 'language') {
      i18n.init(value as string)
      _broadcastToRenderer('locale-changed', i18n.getMessages())
      if (_onLocaleChanged) _onLocaleChanged()
    }
    if (key === 'telemetryEnabled') {
      _broadcastToRenderer('telemetry-setting-changed', value)
    }
  })

  ipcMain.handle('get-setting', (_event, key: string) => {
    return settings.get(key)
  })

  ipcMain.handle('get-locale-messages', () => i18n.getMessages())
  ipcMain.handle('get-available-locales', () => i18n.getAvailableLocales())

  ipcMain.handle('get-resolved-theme', () => resolveTheme())

  nativeTheme.on('updated', () => {
    if (((settings.get('theme') as string | undefined) || 'system') !== 'system') return
    _broadcastToRenderer('theme-changed', resolveTheme())
  })
}
