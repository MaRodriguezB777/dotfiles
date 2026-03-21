#!/usr/bin/env bash
# Outputs machine label based on hostname

HOSTNAME=$(hostname)

if [[ "$HOSTNAME" == "hu-manurodr-lv" ]]; then
    # Dev server - get Ubuntu version dynamically
    if [[ -f /etc/os-release ]]; then
        VERSION=$(grep "^VERSION_ID" /etc/os-release | cut -d'"' -f2)
        echo "Dev Server | Ubuntu ${VERSION}"
    else
        echo "Dev Server | Linux"
    fi
else
    # Laptop / WSL2
    echo "Laptop | WSL2"
fi
