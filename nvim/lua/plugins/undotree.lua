return {
  "mbbill/undotree",
  init = function()
    -- This function runs once on startup
    local icons = LazyVim.config.icons.kinds
    require("which-key").add({
      {
        "<leader>U",
        "<cmd>UndotreeToggle<cr>",
        desc = "Undotree",
        icon = icons.Namespace, -- which-key v3 supports this field
      },
    })
  end,
}
