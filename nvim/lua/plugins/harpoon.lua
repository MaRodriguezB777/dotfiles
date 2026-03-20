return {
  "ThePrimeagen/harpoon",
  branch = "harpoon2",
  dependencies = { "nvim-lua/plenary.nvim" },
  config = function (_, opts)
    local harpoon = require("harpoon")
    harpoon:setup(opts)
    local harpoon_extensions = require("harpoon.extensions")
    harpoon:extend(harpoon_extensions.builtins.navigate_with_number())

    harpoon:extend({
      UI_CREATE = function(cx)
        vim.keymap.set("n", "<C-v>", function()
          harpoon.ui:select_menu_item({ vsplit = true })
        end, { buffer = cx.bufnr })

        vim.keymap.set("n", "<C-x>", function()
          harpoon.ui:select_menu_item({ split = true })
        end, { buffer = cx.bufnr })
      end,
    })

    vim.keymap.set("n", "<leader>a", function() harpoon:list():add() end, { desc = "Harpoon add"})
    vim.keymap.set("n", "<leader>A", function() harpoon:list():clear() end, { desc = "Harpoon clear"})
    vim.keymap.set("n", "<C-e>", function() harpoon.ui:toggle_quick_menu(harpoon:list()) end, { desc = "Harpoon: toggle menu" })
    require("which-key").add({
      { "<leader>a", icon = "󱡀"},
      { "<leader>A", icon = "󱡀"},
    })
  end
}
