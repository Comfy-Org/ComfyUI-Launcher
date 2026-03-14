#!/bin/bash

APPARMOR_PROFILE='/etc/apparmor.d/comfyui-desktop-2'

if [ -f "$APPARMOR_PROFILE" ]; then
  rm -f "$APPARMOR_PROFILE"

  # Unload the profile from the running kernel if possible.
  if hash apparmor_parser 2>/dev/null; then
    apparmor_parser --remove "comfyui-desktop-2" 2>/dev/null || true
  fi
fi
