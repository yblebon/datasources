#!/bin/bash

# Define your remote names here (the names you see in 'git remote')
REMOTES=("github" "codeberg")

# Get the current branch name
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

echo "🚀 Starting multi-repo force push for branch: $CURRENT_BRANCH"

for REMOTE in "${REMOTES[@]}"; do
    echo "-----------------------------------"
    echo "Force pushing to: $REMOTE..."

    # Force push to the remote
    if git push --force "$REMOTE" "$CURRENT_BRANCH"; then
        echo "✅ Successfully force pushed to $REMOTE"
    else
        echo "❌ Failed to force push to $REMOTE"
    fi
done

echo "-----------------------------------"
echo "🎉 All done!"
