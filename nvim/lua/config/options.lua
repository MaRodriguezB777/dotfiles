-- Options are automatically loaded before lazy.nvim startup
-- Default options that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/options.lua
-- Add any additional options here
if vim.fn.hostname() == "hu-manurodr-lv" then
  vim.o.shell = "/usr/bin/zsh"
else
  vim.o.shell = "/usr/bin/bash"
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
