-- Options are automatically loaded before lazy.nvim startup
-- Default options that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/options.lua
-- Add any additional options here
if vim.fn.hostname() == "hu-manurodr-lv" then
  vim.o.shell = "/usr/bin/zsh"
else
  vim.o.shell = "/usr/bin/bash"
end
-- Keep Neovim's Python provider isolated from project virtual environments.
-- `uv tool install pynvim` creates this interpreter; it must contain pynvim.
local uv_tools_dir = vim.env.UV_TOOL_DIR
  or ((vim.env.XDG_DATA_HOME or vim.fn.expand("~/.local/share")) .. "/uv/tools")
local pynvim_python = uv_tools_dir .. "/pynvim/bin/python"
if (vim.uv or vim.loop).fs_stat(pynvim_python) then
  vim.g.python3_host_prog = pynvim_python
end

vim.g.lazyvim_python_lsp = "ty"
vim.g.lazyvim_python_ruff = "ruff"
vim.g.autoformat = false
vim.g.clipboard = {
  name = 'OSC 52',
  copy = {
    ['+'] = require('vim.ui.clipboard.osc52').copy("+"),
    ['*'] = require('vim.ui.clipboard.osc52').copy("*"),
  },
  paste = {
    ['+'] = require('vim.ui.clipboard.osc52').paste("+"),
    ['*'] = require('vim.ui.clipboard.osc52').paste("*"),
  },
}

vim.opt.clipboard = "unnamedplus" -- 'y' and 'p' use the system clipboard
vim.opt.timeout = false -- no timeout for command input

vim.env.NVIM_LISTEN_ADDRESS = vim.v.servername

vim.opt.linebreak = True -- Wrap lines at a character in 'breakat' (spaces, punctuation)
vim.opt.breakindent = True -- Maintain indentation levels for wrapped lines

vim.opt.showcmd = true -- Show token counts
