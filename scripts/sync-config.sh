#!/bin/sh
cd ~/.config || exit 1
git fetch origin 2>/dev/null
LOCAL=$(git rev-parse @)
REMOTE=$(git rev-parse @{u})
if [ "$LOCAL" != "$REMOTE" ]; then
    if git pull --ff-only; then
        tmux display-message -t "$(tmux list-sessions -F '#S' | head -1)" \
            ".config pulled from upstream" 2>/dev/null || true
    else
        tmux display-message -t "$(tmux list-sessions -F '#S' | head -1)" \
            ".config pull FAILED" 2>/dev/null || true
    fi
fi
