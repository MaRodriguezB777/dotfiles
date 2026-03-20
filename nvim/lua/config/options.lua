-- Options are automatically loaded before lazy.nvim startup
-- Default options that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/options.lua
-- Add any additional options here
vim.o.shell = "/usr/bin/bash"
vim.g.lazyvim_python_lsp = "ty"
vim.g.lazyvim_python_ruff = "ruff"
vim.g.autoformat = false
-- vim.opt.clipboard = "unnamedplus"
vim.opt.timeout = false

vim.env.NVIM_LISTEN_ADDRESS = vim.v.servername
