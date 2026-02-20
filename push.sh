#!/bin/bash

# Define your remote names here (the names you see in 'git remote')
REMOTES=("github" "codeberg")

# Get the current branch name
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

echo "🚀 Starting multi-repo push for branch: $CURRENT_BRANCH"

for REMOTE in "${REMOTES[@]}"; do
    echo "-----------------------------------"
    echo "Pushing to: $REMOTE..."

    # Push to the remote
    if git push "$REMOTE" "$CURRENT_BRANCH"; then
        echo "✅ Successfully pushed to $REMOTE"
    else
        echo "❌ Failed to push to $REMOTE"
    fi
done

echo "-----------------------------------"
echo "🎉 All done!"
