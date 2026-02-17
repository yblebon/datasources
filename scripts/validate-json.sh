#!/bin/bash

# Exit immediately if a command fails
set -e

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    echo "Error: 'jq' is not installed. Please install it to validate JSON."
    exit 1
fi

ERROR_FOUND=0

# Iterate through files passed by pre-commit
for FILE in "$@"; do
    if ! jq . "$FILE" > /dev/null 2>&1; then
        echo "❌ Invalid JSON: $FILE"
        # Run again without silencing to show the user the exact line/error
        jq . "$FILE" 1>/dev/null
        ERROR_FOUND=1
    fi
done

if [ $ERROR_FOUND -ne 0 ]; then
    exit 1
fi

exit 0
