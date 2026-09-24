#!/usr/bin/env sh
# Версия десктопной сборки для $GITHUB_ENV: из тега (v0.9.0 → 0.9.0), а для
# ручного прогона без тега — 0.0.0-dev.<коммит>: .deb и .rpm не принимают
# версию, которая начинается не с цифры.
tag="$1"
if [ -n "$tag" ]; then
  echo "VERSION=${tag#v}"
else
  echo "VERSION=0.0.0-dev.$(git rev-parse --short HEAD)"
fi
