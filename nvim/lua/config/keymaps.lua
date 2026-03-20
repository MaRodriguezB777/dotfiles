-- Keymaps are automatically loaded on the VeryLazy event
-- Default keymaps that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/keymaps.lua
-- Add any additional keymaps here
local map = vim.keymap.set

-- map("n", "<leader>gs", "<cmd>Git<cr>", { desc = "Fugitive status (:Git)" })

-- map("n", "<leader>ga", "<cmd>Git add -p<cr>", { desc = "Patch stage (add -p)" })
-- map("n", "<leader>gr", "<cmd>Git reset -p<cr>", { desc = "Patch unstage (reset -p)" })
-- map("n", "<leader>gb", "<cmd>Git blame<cr>", { desc = "Blame" })

map("n", "<leader>gd", "<cmd>DiffviewOpen HEAD -- %<cr>", { desc = "Diffview: open (current file)" })
map("n", "<leader>gD", "<cmd>DiffviewClose<cr>", { desc = "Diffview: close" })
-- map("n", "<leader>gh", "<cmd>DiffviewFileHistory<cr>", { desc = "Diffview: file history" })
-- map("n", "<leader>gH", "<cmd>DiffviewFileHistory %<cr>", { desc = "Diffview: current file history" })
