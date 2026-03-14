#!/bin/bash

# Install AppArmor profile for Ubuntu 24.04+ where
# kernel.apparmor_restrict_unprivileged_userns=1 blocks Electron's sandbox.
#
# First check if the version of AppArmor running on the device supports our profile.
# This keeps backwards compatibility with Ubuntu 22.04 which does not support abi/4.0.
# In that case, we skip installing the profile since the app runs fine without it on 22.04.
#
# Those apparmor_parser flags are akin to performing a dry run of loading a profile.
# https://wiki.debian.org/AppArmor/HowToUse#Dumping_profiles
if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE='/opt/ComfyUI Desktop 2.0/resources/apparmor-profile'
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/comfyui-desktop-2'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"

    # Skip live profile reload inside chroot environments (e.g. image builders).
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      # Extra flags taken from dh_apparmor:
      # > By using '-W -T' we ensure that any abstraction updates are also pulled in.
      # https://wiki.debian.org/AppArmor/Contribute/FirstTimeProfileImport
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "Skipping AppArmor profile installation: this version of AppArmor does not support the bundled profile"
  fi
fi
