vim.api.nvim_set_hl(0, 'DiffAdd', { bg = '#44563F' })
vim.api.nvim_set_hl(0, 'DiffChange', { bg = '#2F4146' })
vim.api.nvim_set_hl(0, 'DiffText', { bg = '#463C2F' })
vim.api.nvim_set_hl(0, "DiffDelete", {bg = "#1a1b26"})

-- Lighter dashed lines for deleted regions
vim.api.nvim_set_hl(0, "DiffviewDiffDeleteDim", {fg = "#3b4261"})
vim.api.nvim_set_hl(0, "DiffviewDiffDelete", {fg = "#3b4261"})

-- vim.api.nvim_set_hl(0, 'DiffAdded', { fg = colors[3], bold = true })
-- vim.api.nvim_set_hl(0, 'DiffRemoved', { fg = colors[2], bold = true })
-- vim.api.nvim_set_hl(0, 'DiffChanged', { fg = colors[4], bold = true })
--
-- vim.api.nvim_set_hl(0, 'DiffviewWinSeparator', { fg = colors[9] })
-- vim.api.nvim_set_hl(0, 'DiffviewDiffDelete', { fg = colors[9] })
-- vim.api.nvim_set_hl(0, 'DiffviewFilePanelSelected', { fg = colors[6] })
--
-- vim.api.nvim_set_hl(0, 'DiffviewStatusAdded', { fg = colors[3], bold = true })
-- vim.api.nvim_set_hl(0, 'DiffviewStatusUntracked', { fg = colors[8], bold = true })
-- vim.api.nvim_set_hl(0, 'DiffviewStatusModified', { fg = colors[4], bold = true })
-- vim.api.nvim_set_hl(0, 'DiffviewStatusRenamed', { fg = colors[3], bold = true })
-- vim.api.nvim_set_hl(0, 'DiffviewStatusDeleted', { fg = colors[2], bold = true })
-- vim.api.nvim_set_hl(0, 'DiffviewStatusIgnored', { fg = colors[9], bold = true })
