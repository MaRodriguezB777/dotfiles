#!/usr/bin/env bash
# machine-label tmux plugin
# Displays machine type (Dev Server or Laptop) in status bar

CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Get the label text from the script
get_label() {
    "$CURRENT_DIR/scripts/label.sh"
}

# Get icon based on hostname
get_icon() {
    local hostname=$(hostname)
    if [[ "$hostname" == "hu-manurodr-lv" ]]; then
        echo "󰒋 "  # server icon
    else
        echo "󱩊 "  # laptop icon
    fi
}

main() {
    local label=$(get_label)
    local icon=$(get_icon)
    
    # Set the module variables for catppuccin integration
    tmux set -gq "@catppuccin_machine_label_icon" "$icon"
    tmux set -gq "@catppuccin_machine_label_color" "#{E:@thm_blue}"
    tmux set -gq "@catppuccin_machine_label_text" " $label"
    
    # Source the catppuccin status module helper
    tmux source -F "#{d:#{@catppuccin_config_file}}/../status/../utils/status_module.conf"
}

main
