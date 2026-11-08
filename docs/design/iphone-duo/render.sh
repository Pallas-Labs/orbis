#!/bin/sh
# Renders each board in wireframes.html to a PNG beside it, with agent-browser (headless
# Chromium). Run from any directory: sh docs/design/iphone-duo/render.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
session=orbis-duo-wireframes
agent-browser --session "$session" set viewport 2400 1300 1
for board in library home set playlists people search now-playing fold sheets; do
  agent-browser --session "$session" open "file://$here/wireframes.html#$board"
  agent-browser --session "$session" reload
  agent-browser --session "$session" screenshot "#$board" "$here/$board.png"
done
agent-browser --session "$session" close
