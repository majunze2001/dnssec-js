#!/bin/bash

# The number of times to execute the command
n=$1

# Check if an argument was provided
if [ -z "$n" ]; then
  echo "Please provide the number of times to run the command as an argument."
  exit 1
fi

# Loop to execute the command n times
for (( i=0; i<n; i++ )); do
  node test.js _443._tcp.dove-tools.me TLSA 2>/dev/null >> log.txt
done
