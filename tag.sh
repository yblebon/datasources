#!/bin/bash

# Define the date format (Year-Month-Day_Hour-Minute)
# Example: 2026-02-17_11-45
TAG_NAME=$(date +"%Y-%m-%d_%H-%M")

# Create the tag
git tag "$TAG_NAME"

# Feedback for the user
if [ $? -eq 0 ]; then
  echo "Successfully created tag: $TAG_NAME"
  echo "To push it to remote, run: git push origin $TAG_NAME"
else
  echo "Failed to create tag."
  exit 1
fi
