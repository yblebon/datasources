#!/bin/bash

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    echo "Error: 'jq' is not installed. Please install it to validate JSON files."
    exit 1
fi

# Get list of staged JSON files (excluding deleted ones)
STAGED_JSON=$(git diff --cached --name-only --diff-filter=ACMR | grep '\.json$')

# If no JSON files are staged, exit quietly
[ -z "$STAGED_JSON" ] && exit 0

ERROR_FOUND=0

for FILE in $STAGED_JSON; do
    # Validate the JSON content
    if ! jq . "$FILE" > /dev/null 2>&1; then
        echo "❌ Invalid JSON in file: $FILE"
        # Optional: show the specific error message
        jq . "$FILE" 1>/dev/null
        ERROR_FOUND=1
    fi
done

if [ $ERROR_FOUND -ne 0 ]; then
    echo "---"
    echo "Abort: Fix the JSON errors above before committing."
    exit 1
fi

echo "✅ All staged JSON files are valid."
exit 0
