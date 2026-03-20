return {
  "saghen/blink.cmp",
  opts = {
    keymap = {
      -- 'fallback' for <CR> allows Enter to behave normally (insert newline)
      -- instead of picking a completion item
      ["<CR>"] = { "fallback" },

      -- <C-space> will now show the completion menu if closed,
      --H or accept the current selection if open
      ["<C-Space>"] = { "show", "accept", "fallback" },
    },
  },
}
