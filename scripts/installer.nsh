!include 'MUI2.nsh'
!include 'FileFunc.nsh'
!include 'LogicLib.nsh'

; Optional installer command-line overrides:
;   /ALLUSERS    force a per-machine install
;   /CURRENTUSER force a per-user install
;
; This keeps us on a single ToDesktop Windows build while still allowing
; OEM / IT provisioning flows to request machine installs explicitly.
!macro customInstallMode
  ${GetParameters} $R0

  ClearErrors
  ${GetOptions} $R0 "/ALLUSERS" $R1
  ${IfNot} ${Errors}
    StrCpy $isForceMachineInstall 1
  ${Else}
    ClearErrors
    ${GetOptions} $R0 "/CURRENTUSER" $R1
    ${IfNot} ${Errors}
      StrCpy $isForceCurrentInstall 1
    ${EndIf}
  ${EndIf}
!macroend

!macro installVcRedist
  File /oname=$PLUGINSDIR\vc_redist.x64.exe "${BUILD_RESOURCES_DIR}\vc_redist.x64.exe"
  ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /passive /norestart' $0

  ${If} $0 <> 0
  ${AndIf} $0 <> 1638
  ${AndIf} $0 <> 3010
    MessageBox MB_ICONSTOP|MB_OK "Microsoft Visual C++ Redistributable installation failed (exit code $0). ComfyUI Desktop requires it to run."
    Abort
  ${EndIf}
!macroend

!macro customInstall
  ${IfNot} ${isUpdated}
    !insertmacro installVcRedist
  ${EndIf}
!macroend

# Custom finish page: launch the app as the current user (not elevated)
!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !endif

  !define MUI_PAGE_CUSTOMFUNCTION_PRE FinishPagePreCheck
  !insertmacro MUI_PAGE_FINISH

  # Skip finish page during updates — auto-launch instead
  Function FinishPagePreCheck
    ${if} ${isUpdated}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated"
      Abort
    ${endif}
  FunctionEnd
!macroend
